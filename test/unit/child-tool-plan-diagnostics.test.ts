import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolvePiLaunchToolPlan } from "../../src/api/child-tool-plan.ts";

describe("public child tool plan diagnostics", () => {
	it("reports host pruning without a capability ceiling, including an empty effective menu", () => {
		const plan = resolvePiLaunchToolPlan({
			agentName: "scout",
			tools: ["read", "grep", "find", "ls", "bash"],
			hostAvailableBuiltins: [],
		});
		assert.deepEqual(plan.warnings, [
			"Agent 'scout': host runtime tool availability omitted [read, grep, find, ls, bash]. Requested tool names: [read, grep, find, ls, bash]; effective tool allowlist: []. This is a non-fatal tool-plan diagnostic, not verification of the child's runtime tool menu.",
		]);
		assert.deepEqual(plan.effectiveToolAllowlist, []);
		assert.deepEqual(plan.requiredChildTools, []);
		assert.equal(plan.capabilityAudit, undefined);
	});

	it("distinguishes host omissions from the intersected ceiling and explicit exclusions", () => {
		const plan = resolvePiLaunchToolPlan({
			agentName: "reviewer",
			tools: ["read", "grep", "bash", "write"],
			hostAvailableBuiltins: ["bash", "write"],
			excludeTools: ["write"],
			capabilityCeiling: { version: 1, allowedTools: ["read", "bash", "write"], denyExtensions: false, sources: ["plan-mode"] },
			inheritedCapabilityCeiling: { version: 1, allowedTools: ["read", "grep", "write"], denyExtensions: false, sources: ["parent-policy"] },
		});
		assert.deepEqual(plan.warnings, [
			"Agent 'reviewer': host runtime tool availability omitted [read]. Requested tool names: [read, grep, bash, write]; effective tool allowlist: []. Active capability ceiling sources: [parent-policy, plan-mode]. Explicit excludeTools: [write]. This is a non-fatal tool-plan diagnostic, not verification of the child's runtime tool menu.",
		]);
		assert.deepEqual(plan.capabilityAudit?.requestedTools, ["read", "grep", "bash", "write"]);
		assert.deepEqual(plan.capabilityAudit?.effectiveTools, []);
		assert.deepEqual(plan.capabilityAudit?.unavailableHostBuiltins, ["read"]);
	});

	it("does not invent an explicit request, agent name, or ceiling source when absent", () => {
		const plan = resolvePiLaunchToolPlan({
			hostAvailableBuiltins: [],
			capabilityCeiling: { version: 1, allowedTools: ["read"], denyExtensions: false, sources: [] },
		});
		assert.deepEqual(plan.warnings, [
			"Subagent: host runtime tool availability omitted [read]. Requested tool names: not explicitly specified; effective tool allowlist: []. Active capability ceiling sources: [unknown source]. This is a non-fatal tool-plan diagnostic, not verification of the child's runtime tool menu.",
		]);
	});

	it("does not invent host omissions when availability is unknown or a ceiling alone prunes tools", () => {
		for (const input of [
			{},
			{ hostAvailableBuiltins: ["read"] },
			{ hostAvailableBuiltins: [], capabilityCeiling: { version: 1 as const, allowedTools: [], denyExtensions: false, sources: ["plan-mode"] } },
		]) {
			const plan = resolvePiLaunchToolPlan({ tools: ["read"], ...input });
			assert.deepEqual(plan.warnings, []);
		}
	});
});
