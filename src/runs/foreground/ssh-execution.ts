import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { loadSelectedAgentDocument } from "../../agents/agents.ts";
import { checkSubagentDepth, type Details, type ExtensionConfig, type SubagentState } from "../../shared/types.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import { reserveSpawnBudget } from "../shared/spawn-budget.ts";
import type { SshProjectBootstrap } from "../shared/ssh-project-bootstrap.ts";
import type { SubagentParamsLike } from "./subagent-executor.ts";
import { intersectSubagentCapabilityCeilings, resolveCurrentSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import { runSync } from "./execution.ts";

export function validateSshConfig(config: ExtensionConfig): void {
	for (const key of ["worktree", "worktreeSetupHook", "permissions", "toolBudget", "usageBudget", "forceTopLevelAsync", "intercomBridge", "control", "proactiveSkillSubagents", "orcaProgressTabs", "scheduledRuns", "missions", "defaultSessionDir"] as const) {
		const value = config[key];
		if (value !== undefined && value !== false) throw new Error(`SSH does not support configured ${key}.`);
	}
	if (config.artifactDir === "project") throw new Error("SSH does not support project-local artifact placement.");
}

/** Admission precedes the ordinary executor's workflows, discovery, and Git paths. */
export async function executeSshForeground(profile: SshProjectBootstrap, config: ExtensionConfig, state: SubagentState, params: SubagentParamsLike, ctx: ExtensionContext, signal: AbortSignal, onUpdate?: (result: AgentToolResult<Details>) => void): Promise<AgentToolResult<Details>> {
	const allowed = new Set(["agent", "task", "async", "context", "model", "thinking", "timeoutMs", "toolTimeoutMs", "capabilityCeiling"]);
	const neutral: Record<string, unknown> = { cwd: profile.localRuntime.cwd, acceptance: false, artifacts: false, foregroundOnly: true, clarify: false, skill: false };
	if (Object.entries(params).some(([key, value]) => value !== undefined && !allowed.has(key) && (!Object.hasOwn(neutral, key) || neutral[key] !== value))) throw new Error("SSH supports only fresh single foreground delegation; requested operation is unsupported.");
	if (!profile.selectedDocuments) throw new Error("SSH selected agent is unavailable.");
	const agent = loadSelectedAgentDocument(profile.selectedDocuments.agent);
	if (params.agent !== agent.name || !params.task?.trim()) throw new Error("SSH delegation requires the explicitly selected agent and a task.");
	if ((params.async ?? agent.defaultAsync ?? config.asyncByDefault ?? false) !== false || (params.context ?? agent.defaultContext ?? config.defaultSubagentContext ?? "fresh") !== "fresh") throw new Error("SSH requires effective async:false and context:fresh.");
	// These global contracts would activate unsupported host work. Never silently discard them.
	validateSshConfig(config);
	const sessionId = resolveCurrentSessionId(ctx.sessionManager);
	const ceiling = intersectSubagentCapabilityCeilings(params.capabilityCeiling, resolveCurrentSubagentCapabilityCeiling(sessionId), resolveCurrentSubagentCapabilityCeiling(ctx.sessionManager.getSessionId()));
	if (ceiling?.denyExtensions
		|| (ceiling?.allowedAgents && !ceiling.allowedAgents.includes(agent.name))
		|| (ceiling?.allowedTools && agent.tools?.some(tool => !ceiling.allowedTools!.includes(tool)))) {
		throw new Error("SSH profile conflicts with the current capability ceiling.");
	}
	if (checkSubagentDepth(config.maxSubagentDepth).blocked) throw new Error("SSH delegation exceeds the current depth ceiling.");
	const budget = reserveSpawnBudget(state, config, sessionId, 1);
	if (budget.error) throw new Error(budget.error);
	const timeoutMs = params.timeoutMs ?? agent.defaultTimeoutMs ?? config.timeoutMs ?? 300_000;
	const result = await runSync(profile.localRuntime.cwd, [agent], agent.name, params.task, {
		runId: randomUUID(), context: "fresh", cwd: profile.localRuntime.cwd, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), onUpdate,
		sshProject: profile, capabilityCeiling: ceiling, modelOverride: params.model ?? agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined),
		extensionBindings: { "pi-subagents.ssh-project/1": { target: profile.target, projectDir: profile.projectDir } },
		timeoutMs,
		toolTimeoutMs: params.toolTimeoutMs ?? agent.defaultToolTimeoutMs,
		configToolTimeoutMs: config.toolTimeoutMs,
		parentSessionId: ctx.sessionManager.getSessionId(),
		sessionDir: path.join(profile.localRuntime.agentDir, "sessions", "ssh-foreground"),
		acceptance: false,
		thinkingOverride: params.thinking as typeof agent.thinking,
	});
	return { content: [{ type: "text", text: result.finalOutput || result.error || "SSH child completed." }], details: { mode: "single", results: [result] }, ...(result.exitCode !== 0 || result.error ? { isError: true } : {}) };
}
