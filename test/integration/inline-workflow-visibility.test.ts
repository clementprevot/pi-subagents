import assert from "node:assert/strict";
import { it } from "node:test";
import { Editor } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AsyncJobState, SubagentState } from "../../src/shared/types.ts";
import { WIDGET_KEY } from "../../src/shared/types.ts";
import { FLEET_STATUS_WIDGET_KEY, SubagentFleetStatus } from "../../src/tui/fleet-status.ts";
import { renderWidget, setInlineWorkflowCoverage } from "../../src/tui/render.ts";

const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text, bold: (text: string) => text };
type Mounted = { render(width: number): string[]; dispose?(): void };
function harness(maxAgentRows = 6, inspector: () => Promise<void> = async () => {}) {
	const job: AsyncJobState = { asyncId: "workflow", asyncDir: "/tmp/workflow", mode: "workflow", status: "running", startedAt: 1_000,
		steps: [{ workflowKey: "lane-a", agent: "unique-worker", status: "running" }] };
	const state = { asyncJobs: new Map([[job.asyncId, job]]), foregroundControls: new Map() } as unknown as SubagentState;
	const mounted = new Map<string, Mounted>();
	let requests = 0;
	let expanded = false;
	const tui = { requestRender() { requests++; }, focusedComponent: Object.create(Editor.prototype) };
	const ctx = { hasUI: true, ui: { theme, getToolsExpanded: () => expanded, getEditorText: () => "", onTerminalInput: () => () => {}, notify() {},
		setWidget(key: string, factory: ((tui: unknown, theme: unknown) => Mounted) | undefined) {
			mounted.get(key)?.dispose?.(); mounted.delete(key);
			if (factory) mounted.set(key, factory(tui, theme));
		} } } as unknown as ExtensionContext;
	const fleet = new SubagentFleetStatus(state, inspector, { refreshMs: 60_000, maxAgentRows, onWorkflowCoverageChange: setInlineWorkflowCoverage });
	fleet.setContext(ctx);
	renderWidget(ctx, [job]);
	return { job, state, ctx, fleet, mounted, get requests() { return requests; }, setExpanded(value: boolean) { expanded = value; },
		asyncText: () => mounted.get(WIDGET_KEY)!.render(240).join("\n"),
		roster: (width = 240) => mounted.get(FLEET_STATUS_WIDGET_KEY)!.render(width).join("\n"),
		activate() { fleet.handleKey("\x1b[B"); },
		close() { fleet.dispose(); mounted.get(WIDGET_KEY)?.dispose?.(); renderWidget(ctx, []); },
	};
}

it("collapses only after the actual same-UI roster renders, and restores on deactivation/disposal", () => {
	const h = harness();
	try {
		assert.match(h.asyncText(), /unique-worker/);
		h.activate();
		assert.match(h.asyncText(), /unique-worker/, "activation alone is not rendered coverage");
		assert.match(h.roster(), /unique-worker/);
		const before = h.requests;
		assert.match(h.asyncText(), /Workflow children shown in Fleet roster/);
		assert.doesNotMatch(h.asyncText(), /unique-worker/);
		h.setExpanded(true);
		assert.doesNotMatch(h.asyncText(), /unique-worker/);
		h.fleet.handleKey("\x1b");
		assert.ok(h.requests > before, "coverage changes invalidate the existing widget");
		assert.match(h.asyncText(), /unique-worker/);
		h.activate(); h.roster();
		h.mounted.get(FLEET_STATUS_WIDGET_KEY)!.dispose?.();
		assert.match(h.asyncText(), /unique-worker/);
	} finally { h.close(); }
});

it("retains detail for row overflow, horizontal truncation, nested and attached children", () => {
	for (const kind of ["budget", "width", "nested", "attached", "overflow"] as const) {
		const h = harness(kind === "budget" ? 1 : 20);
		try {
			if (kind === "nested") h.job.steps![0]!.children = [{ id: "nested", state: "running", agent: "nested-worker" }];
			if (kind === "attached") h.state.asyncJobs.set("child", { asyncId: "child", asyncDir: "/tmp/child", mode: "single", status: "running", parentWorkflowRunId: h.job.asyncId, agents: ["attached-worker"] });
			if (kind === "overflow") for (let i = 0; i < 6; i++) h.job.steps!.push({ agent: `worker-${i}`, status: "running" });
			renderWidget(h.ctx, [...h.state.asyncJobs.values()]);
			h.activate(); h.roster(kind === "width" ? 20 : 240);
			assert.doesNotMatch(h.asyncText(), /Workflow children shown in Fleet roster/, kind);
			assert.match(h.asyncText(), /unique-worker/, kind);
		} finally { h.close(); }
	}
});

it("revokes coverage when navigation scrolls a workflow out of the roster, or its context becomes stale", () => {
	const h = harness(3);
	try {
		h.state.asyncJobs.set("later", { asyncId: "later", asyncDir: "/tmp/later", mode: "single", status: "running", startedAt: 2_000, agents: ["later-worker"] });
		h.activate(); h.roster();
		assert.match(h.asyncText(), /Workflow children shown in Fleet roster/);
		h.fleet.handleKey("\x1b[B"); h.fleet.handleKey("\x1b[B"); h.roster();
		assert.match(h.asyncText(), /unique-worker/);
		h.fleet.handleKey("\x1b[A"); h.roster();
		assert.match(h.asyncText(), /Workflow children shown in Fleet roster/);
		Object.defineProperty(h.ctx, "hasUI", { get() { throw new Error("This extension ctx is stale after session replacement or reload."); }, configurable: true });
		h.fleet.refresh();
		assert.match(h.asyncText(), /unique-worker/);
	} finally {
		Object.defineProperty(h.ctx, "hasUI", { value: true, configurable: true });
		h.close();
	}
});

it("new step identities and materialized children revoke stale coverage within the same frame", () => {
	const h = harness();
	try {
		h.activate(); h.roster();
		assert.doesNotMatch(h.asyncText(), /unique-worker/);
		h.job.steps!.push({ workflowKey: "lane-b", agent: "new-worker", status: "running" });
		assert.match(h.asyncText(), /new-worker/, "in-place arrival cannot use cached covered lines");
		h.fleet.refresh(); h.roster();
		assert.match(h.asyncText(), /Workflow children shown in Fleet roster/);
		const child: AsyncJobState = { asyncId: "child", asyncDir: "/tmp/child", mode: "single", status: "running", parentWorkflowRunId: h.job.asyncId, agents: ["attached-worker"] };
		renderWidget(h.ctx, [h.job, child]);
		assert.match(h.asyncText(), /attached-worker/);
		assert.doesNotMatch(h.asyncText(), /Workflow children shown in Fleet roster/);
	} finally { h.close(); }
});

it("restores detail for suspension, inspector transitions, UI replacement, and headless replacement", async () => {
	let finish!: () => void;
	const h = harness(6, () => new Promise<void>((resolve) => { finish = resolve; }));
	try {
		h.activate(); h.roster();
		h.state.widgetsSuspended = true; h.fleet.refresh();
		assert.match(h.asyncText(), /unique-worker/);
		h.state.widgetsSuspended = false; h.fleet.refresh(); h.roster();
		assert.doesNotMatch(h.asyncText(), /unique-worker/);
		h.fleet.handleKey("\x1b[B"); h.fleet.handleKey("\r");
		assert.match(h.asyncText(), /unique-worker/);
		await Promise.resolve(); finish();
		await new Promise((resolve) => setImmediate(resolve));
		h.roster();
		assert.doesNotMatch(h.asyncText(), /unique-worker/);
		h.state.fleetInspectorOpen = true; h.fleet.refresh();
		assert.match(h.asyncText(), /unique-worker/);
		h.state.fleetInspectorOpen = false; h.fleet.refresh(); h.roster();
		const oldText = h.asyncText;
		const other = harness();
		try {
			assert.match(other.asyncText(), /unique-worker/, "coverage cannot leak to a second UI");
			h.fleet.setContext(other.ctx);
			assert.match(oldText(), /unique-worker/, "old UI regains detail immediately");
			h.fleet.setContext({ hasUI: false } as ExtensionContext);
			assert.match(other.asyncText(), /unique-worker/);
		} finally { other.close(); }
	} finally { h.close(); }
});
