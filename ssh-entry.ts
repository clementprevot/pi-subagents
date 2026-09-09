import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePiPackageRoot, resolveInstalledPiPackageRoot } from "./src/runs/shared/pi-spawn.ts";
import { consumeSshStockCliArgs, readSelectedMarkdown } from "./src/runs/shared/ssh-cli-entry.ts";
import { createSshProjectTools, prepareSshContext, runSshProject } from "./src/runs/shared/ssh-project-tools.ts";
import { loadSelectedAgentDocument } from "./src/agents/agents.ts";
import { readConfigForUpdate } from "./src/extension/config.ts";
import { validateSshConfig } from "./src/runs/foreground/ssh-execution.ts";

/** Owned stock-CLI factory: all initialization failures are fatal CLI diagnostics. */
export default async function sshEntry(pi: ExtensionAPI): Promise<void> {
	if (process.env.PI_SUBAGENT_CHILD === "1") throw new Error("Nested SSH entry is unsupported.");
	pi.registerFlag("ssh-bootstrap", { type: "string", description: "Internal owned SSH startup bootstrap" });
	const { selection, profile } = consumeSshStockCliArgs(process.argv.slice(2));
	validateSshConfig(readConfigForUpdate());
	const settingsPath = path.join(profile.localRuntime.agentDir, "settings.json");
	if (fs.existsSync(settingsPath) && JSON.parse(fs.readFileSync(settingsPath, "utf8"))?.subagents?.watchdog?.enabled === true) throw new Error("SSH cannot honor an enabled local watchdog; its policy must not be silently disabled.");
	const sdkRoot = resolvePiPackageRoot() ?? resolveInstalledPiPackageRoot();
	if (!sdkRoot) throw new Error("Installed Pi system prompt builder unavailable.");
	const { buildSystemPrompt } = await import(pathToFileURL(path.join(sdkRoot, "dist/core/system-prompt.js")).href);
	if (typeof buildSystemPrompt !== "function") throw new Error("Installed Pi system prompt builder unavailable.");
	// The stock CLI owns one invocation. Reject resource reload before another
	// transport/init effect; this marker stores no target or execution state.
	const once = Symbol.for("pi-subagents.ssh-entry-initialized");
	const host = globalThis as Record<symbol, unknown>;
	if (host[once]) throw new Error("SSH resource reload/session replacement is unsupported.");
	host[once] = true;
	const selectedDocuments = Object.freeze({ agent: readSelectedMarkdown(selection.agent), skills: Object.freeze(selection.skills.map(readSelectedMarkdown)) });
	const selectedAgent = loadSelectedAgentDocument(selectedDocuments.agent);
	let globalContext = "";
	for (const name of ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
		const file = path.join(profile.localRuntime.agentDir, name);
		if (fs.existsSync(file)) { globalContext = readSelectedMarkdown(file).content; break; }
	}
	const bound = { ...profile, selectedDocuments, extensions: selection.extensions, globalContext };
	const remoteContext = await prepareSshContext(bound);
	const tools = createSshProjectTools(bound);
	for (const tool of tools) pi.registerTool(tool);
	pi.on("session_shutdown", event => {
		if (event.reason === "reload") {
			fs.writeSync(2, "SSH mode cannot safely reload; restart through pi-subagents-ssh. Persisted sessions remain local; remote completion/cleanup may be uncertain.\n");
			process.exit(1);
		}
	});
	pi.on("session_before_switch", () => ({ cancel: true }));
	pi.on("session_before_fork", () => ({ cancel: true }));
	pi.on("session_before_tree", () => ({ cancel: true }));
	pi.on("user_bash", () => ({ operations: { async exec(command, _cwd, options) {
		const output = await runSshProject(bound, `exec 2>&1\n${command}`, options.signal, options.timeout ? options.timeout * 1000 : 30_000, true);
		options.onData(Buffer.from(output)); return { exitCode: 0 };
	} } }));
	pi.on("before_agent_start", event => ({ systemPrompt: buildSystemPrompt({
		...event.systemPromptOptions, skills: [], cwd: `${bound.projectDir} (SSH ${bound.target}; local runtime ${bound.localRuntime.cwd})`,
		contextFiles: [{ path: `ssh://${bound.target}${bound.projectDir}`, content: [`Selected subagent: ${selectedAgent.name} — ${selectedAgent.description}. Delegate with async:false, context:fresh. Local Markdown is available only through read scope=local-resource with its exact selected path; local helpers/assets are unsupported.`, globalContext, remoteContext, ...selectedDocuments.skills.map(doc => `Selected local Markdown (${doc.path}):\n${doc.content}`)].filter(Boolean).join("\n\n") }],
	}) }));
	pi.on("tool_call", event => {
		if (["read", "bash"].includes(event.toolName) && !pi.getAllTools().some(info => info.name === event.toolName && info.sourceInfo?.path === fileURLToPath(import.meta.url))) {
			return { block: true, reason: "SSH owned tool provenance changed; local fallback refused." };
		}
	});
	const register = (await import("./src/extension/index.ts")).default;
	register(pi, bound);
}
