import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import {
	clearExclusions,
	DEFAULT_MODEL_EXCLUSION_TTL_MS,
	findModelExclusion,
	filterFallbackCandidates,
	flushPersist,
	getExcludedCount,
	getExclusionsFilePath,
	isExcluded,
	parseModelKey,
	planTransientModelRecoveryProbe,
	claimLaunchTransientRecoveryProbe,
	claimTransientModelRecoveryProbe,
	releaseTransientModelRecoveryProbe,
	isReprobeEligibleTransientReason,
	recordModelFailure,
	reloadFromDisk,
	MAX_MODEL_EXCLUSION_TTL_MS,
	setDefaultTTL,
	type ModelExclusion,
} from "../../src/runs/shared/model-exclusions.ts";

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-model-exclusions-auth-"));

function captureConsole(method: "error" | "warn", run: () => void): unknown[][] {
	const original = console[method];
	const messages: unknown[][] = [];
	console[method] = (...args: unknown[]) => messages.push(args);
	try {
		run();
	} finally {
		console[method] = original;
	}
	return messages;
}
process.env.PI_CODING_AGENT_DIR = testAgentDir;
const authPath = path.join(testAgentDir, "auth.json");

function runIsolatedModule(script: string, environment: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
			cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let error = "";
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { error += chunk; });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(error || `child exited ${code}`)));
	});
}

async function waitForFiles(directory: string, count: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (fs.readdirSync(directory).length >= count) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${count} claim readers.`);
}

// The exclusion store is a process-wide singleton persisted under TEMP_ROOT_DIR
// (isolated per test run by test/support/isolated-temp-root.mjs). Clear it
// before/after each test so cases don't leak state into each other.
beforeEach(() => {
	setDefaultTTL(DEFAULT_MODEL_EXCLUSION_TTL_MS);
	fs.rmSync(getExclusionsFilePath(), { force: true });
	fs.rmSync(authPath, { force: true });
	clearExclusions();
});
afterEach(() => {
	clearExclusions();
	fs.rmSync(authPath, { force: true });
});
after(() => {
	if (previousAgentDir === undefined) {
		delete process.env.PI_CODING_AGENT_DIR;
	} else {
		process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	}
	fs.rmSync(testAgentDir, { recursive: true, force: true });
});

describe("model exclusions — record & query", () => {
	it("excludes a recorded model", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "429" });
		assert.equal(isExcluded("gpt-4", "openai"), true);
	});

	it("does not exclude other models of the same provider when modelId is set", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai" });
		assert.equal(isExcluded("gpt-4o", "openai"), false);
	});

	it("does not exclude the same modelId under a different provider", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai" });
		assert.equal(isExcluded("gpt-4", "github-copilot"), false);
	});

	it("matches by provider when modelId is omitted", () => {
		recordModelFailure({ provider: "openai", reason: "quota" });
		assert.equal(isExcluded("any-model", "openai"), true);
	});

	it("deduplicates repeated recordings for the same key", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai" });
		recordModelFailure({ modelId: "gpt-4", provider: "openai" });
		assert.equal(getExcludedCount(), 1);
	});

	it("tracks distinct keys separately", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai" });
		recordModelFailure({ modelId: "claude", provider: "anthropic" });
		assert.equal(getExcludedCount(), 2);
	});
});

describe("model exclusions — transient recovery probes", () => {
	it("classifies only narrow transient transport/provider reasons", () => {
		for (const reason of ["fetch failed", "socket hang up", "request timed out", "503 service unavailable", "upstream 502", "cold-start empty response"]) {
			assert.equal(isReprobeEligibleTransientReason(reason), true, reason);
		}
		for (const reason of ["upstream", "invalid api key", "401 unauthorized", "429 rate limit", "quota exceeded", "model not found", "model disabled", "invalid_request_error", "invalid request: upstream 503", "permission denied: 503", "access denied: upstream 5xx", "invalid configuration"]) {
			assert.equal(isReprobeEligibleTransientReason(reason), false, reason);
		}
	});

	it("plans and atomically owns one probe only when every candidate is transiently excluded", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "503 service unavailable" });
		recordModelFailure({ modelId: "claude", provider: "anthropic", reason: "fetch failed" });
		assert.equal(planTransientModelRecoveryProbe(["openai/gpt-4", "anthropic/claude"])?.candidate, "openai/gpt-4");
		const first = claimTransientModelRecoveryProbe("openai/gpt-4");
		assert.equal(first.status, "claimed");
		assert.equal(claimTransientModelRecoveryProbe("openai/gpt-4").status, "in-flight");
		releaseTransientModelRecoveryProbe(first, true);
		assert.equal(findModelExclusion("openai/gpt-4"), undefined);
		assert.equal(findModelExclusion("anthropic/claude")?.reason, "fetch failed");
	});

	it("does not plan a probe for mixed or permanent exclusions and preserves failed probes", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "503 service unavailable" });
		recordModelFailure({ modelId: "claude", provider: "anthropic", reason: "quota exceeded" });
		assert.equal(planTransientModelRecoveryProbe(["openai/gpt-4", "anthropic/claude"]), undefined);
		assert.equal(planTransientModelRecoveryProbe(["openai/gpt-4"])?.candidate, "openai/gpt-4");
		const claim = claimTransientModelRecoveryProbe("openai/gpt-4");
		releaseTransientModelRecoveryProbe(claim, false);
		assert.equal(findModelExclusion("openai/gpt-4")?.reason, "503 service unavailable");
	});

	it("clears only the exact provider/model target when immutable metadata collides", () => {
		const now = Date.now();
		fs.writeFileSync(getExclusionsFilePath(), JSON.stringify({ version: 1, exclusions: [
			{ provider: "openai", reason: "503", recordedAt: now, expiresAt: now + 60_000 },
			{ provider: "openai", modelId: "gpt-4", reason: "503", recordedAt: now, expiresAt: now + 60_000 },
		] }), "utf-8");
		reloadFromDisk();
		const claim = claimTransientModelRecoveryProbe("openai/gpt-4");
		assert.equal(claim.status, "claimed");
		releaseTransientModelRecoveryProbe(claim, true);
		reloadFromDisk();
		assert.equal(findModelExclusion("openai/gpt-4")?.modelId, "gpt-4");
	});

	it("clears a recovered exclusion after an in-memory TTL shorten", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "503 service unavailable", ttlMs: 60_000 });
		const persisted = JSON.parse(fs.readFileSync(getExclusionsFilePath(), "utf-8")).exclusions[0] as ModelExclusion;
		setDefaultTTL(30_000, { shortenExisting: true });
		assert.equal(JSON.parse(fs.readFileSync(getExclusionsFilePath(), "utf-8")).exclusions[0].expiresAt, persisted.expiresAt);
		assert.ok((findModelExclusion("openai/gpt-4")?.expiresAt ?? 0) < persisted.expiresAt);
		const claim = claimTransientModelRecoveryProbe("openai/gpt-4");
		assert.equal(claim.status, "claimed");
		releaseTransientModelRecoveryProbe(claim, true);
		assert.equal(findModelExclusion("openai/gpt-4"), undefined);
		reloadFromDisk();
		assert.equal(findModelExclusion("openai/gpt-4"), undefined);
	});

	it("treats a recently created empty recovery-probe claim as in-flight", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "503 service unavailable" });
		const candidate = "openai/gpt-4";
		const claimPath = `${getExclusionsFilePath()}.recovery-probe.${Buffer.from(candidate).toString("base64url")}.json`;
		fs.writeFileSync(claimPath, "", { flag: "wx" });
		assert.equal(claimTransientModelRecoveryProbe(candidate).status, "in-flight");
		assert.equal(fs.readFileSync(claimPath, "utf-8"), "");
		fs.rmSync(claimPath, { force: true });
	});

	it("reclaims a stale empty recovery-probe claim", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "503 service unavailable" });
		const candidate = "openai/gpt-4";
		const claimPath = `${getExclusionsFilePath()}.recovery-probe.${Buffer.from(candidate).toString("base64url")}.json`;
		fs.writeFileSync(claimPath, "", { flag: "wx" });
		const ancient = new Date(Date.now() - 60_000);
		fs.utimesSync(claimPath, ancient, ancient);
		const reclaimed = claimTransientModelRecoveryProbe(candidate);
		assert.equal(reclaimed.status, "claimed");
		releaseTransientModelRecoveryProbe(reclaimed, false);
	});

	it("reclaims a dead-pid claim and never steals a live process even after expiry", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "503 service unavailable" });
		const candidate = "openai/gpt-4";
		const claimPath = `${getExclusionsFilePath()}.recovery-probe.${Buffer.from(candidate).toString("base64url")}.json`;
		fs.writeFileSync(claimPath, JSON.stringify({ owner: "dead", pid: 999_999_999, expiresAt: Date.now() - 1 }), "utf-8");
		const reclaimed = claimTransientModelRecoveryProbe(candidate);
		assert.equal(reclaimed.status, "claimed");
		releaseTransientModelRecoveryProbe(reclaimed, false);
		fs.writeFileSync(claimPath, JSON.stringify({ owner: "live", pid: process.pid, expiresAt: Date.now() - 1 }), "utf-8");
		assert.equal(claimTransientModelRecoveryProbe(candidate).status, "in-flight");
		fs.rmSync(claimPath, { force: true });
	});

	it("does not claim an ordinary fallback candidate after a sibling was recorded", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "503 service unavailable" });
		assert.equal(claimLaunchTransientRecoveryProbe(["openai/gpt-4", "anthropic/claude"], "openai/gpt-4").status, "not-eligible");
		assert.equal(claimLaunchTransientRecoveryProbe(["openai/gpt-4"], "openai/gpt-4", { recovering: true }).status, "not-eligible");
	});

	it("elects one owner when two reclaimers observe the same stale claim", async () => {
		const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-probe-reclaim-")), "exclusions.json");
		const candidate = "openai/gpt-4";
		const claimPath = `${store}.recovery-probe.${Buffer.from(candidate).toString("base64url")}.json`;
		const stale = JSON.stringify({ owner: "dead", pid: 999_999_999, expiresAt: Date.now() - 1 });
		const barrier = path.join(path.dirname(store), "barrier");
		const ready = path.join(barrier, "ready");
		const goA = path.join(barrier, "go-a");
		const goB = path.join(barrier, "go-b");
		const aDone = path.join(barrier, "a-done");
		fs.mkdirSync(ready, { recursive: true });
		fs.writeFileSync(claimPath, stale, "utf-8");
		fs.writeFileSync(store, JSON.stringify({
			version: 1,
			exclusions: [{ modelId: "gpt-4", provider: "openai", reason: "503 service unavailable", recordedAt: Date.now(), expiresAt: Date.now() + 60_000 }],
		}), "utf-8");
		const moduleUrl = pathToFileURL(path.resolve("src/runs/shared/model-exclusions.ts")).href;
		const makeScript = (role: "a" | "b") => `
			import { createRequire } from "node:module";
			import { syncBuiltinESMExports } from "node:module";
			const require = createRequire(import.meta.url); const fs = require("node:fs");
			const claimPath = ${JSON.stringify(claimPath)};
			const ready = ${JSON.stringify(ready)};
			const go = ${JSON.stringify(role === "a" ? goA : goB)};
			const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			const read = fs.readFileSync; let paused = false;
			fs.readFileSync = (...args) => {
				const value = read(...args);
				if (!paused && args[0] === claimPath) {
					paused = true;
					fs.writeFileSync(ready + "/${role}", "");
					while (!fs.existsSync(go)) sleep();
				}
				return value;
			};
			syncBuiltinESMExports();
			const { claimTransientModelRecoveryProbe } = await import(${JSON.stringify(moduleUrl)});
			console.log(claimTransientModelRecoveryProbe(${JSON.stringify(candidate)}).status);
			${role === "a" ? `fs.writeFileSync(${JSON.stringify(aDone)}, "");` : ""}
			setTimeout(() => {}, 50);
		`;
		const environment = { ...process.env, PI_MODEL_EXCLUSIONS_PATH: store };
		try {
			const first = runIsolatedModule(makeScript("a"), environment);
			const second = runIsolatedModule(makeScript("b"), environment);
			await waitForFiles(ready, 2);
			fs.writeFileSync(goA, "");
			const aDeadline = Date.now() + 5_000;
			while (!fs.existsSync(aDone) && Date.now() < aDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
			if (!fs.existsSync(aDone)) throw new Error("Timed out waiting for the first reclaimer.");
			fs.writeFileSync(goB, "");
			const results = await Promise.all([first, second]);
			assert.equal(results.filter((result) => result === "claimed").length, 1);
			assert.equal(results.filter((result) => result === "in-flight").length, 1);
			assert.match(fs.readFileSync(claimPath, "utf-8"), /"owner":/);
			assert.notEqual(fs.readFileSync(claimPath, "utf-8"), stale);
		} finally {
			fs.rmSync(path.dirname(store), { recursive: true, force: true });
		}
	});

	it("clears only the matching exclusion from disk and keeps later unrelated records", async () => {
		const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-probe-keep-")), "exclusions.json");
		const previousStore = process.env.PI_MODEL_EXCLUSIONS_PATH;
		process.env.PI_MODEL_EXCLUSIONS_PATH = store;
		try {
			reloadFromDisk();
			recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "503 service unavailable" });
			const claim = claimTransientModelRecoveryProbe("openai/gpt-4");
			assert.equal(claim.status, "claimed");
			const moduleUrl = pathToFileURL(path.resolve("src/runs/shared/model-exclusions.ts")).href;
			await runIsolatedModule(
				`import { recordModelFailure } from ${JSON.stringify(moduleUrl)}; recordModelFailure({ modelId: "claude", provider: "anthropic", reason: "invalid api key" });`,
				{ ...process.env, PI_MODEL_EXCLUSIONS_PATH: store },
			);
			releaseTransientModelRecoveryProbe(claim, true);
			reloadFromDisk();
			assert.equal(findModelExclusion("openai/gpt-4"), undefined);
			assert.equal(findModelExclusion("anthropic/claude")?.reason, "invalid api key");
		} finally {
			if (previousStore === undefined) delete process.env.PI_MODEL_EXCLUSIONS_PATH;
			else process.env.PI_MODEL_EXCLUSIONS_PATH = previousStore;
			reloadFromDisk();
			fs.rmSync(path.dirname(store), { recursive: true, force: true });
		}
	});

	it("keeps a concurrent unrelated exclusion when a successful probe clears its match", async () => {
		const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-probe-clear-")), "exclusions.json");
		const previousStore = process.env.PI_MODEL_EXCLUSIONS_PATH;
		process.env.PI_MODEL_EXCLUSIONS_PATH = store;
		const barrier = path.join(path.dirname(store), "barrier");
		const ready = path.join(barrier, "ready");
		const go = path.join(barrier, "go");
		fs.mkdirSync(ready, { recursive: true });
		try {
			reloadFromDisk();
			recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "503 service unavailable" });
			const claim = claimTransientModelRecoveryProbe("openai/gpt-4");
			assert.equal(claim.status, "claimed");
			const moduleUrl = pathToFileURL(path.resolve("src/runs/shared/model-exclusions.ts")).href;
			const script = `
				import { createRequire } from "node:module";
				import { syncBuiltinESMExports } from "node:module";
				const require = createRequire(import.meta.url); const fs = require("node:fs");
				const store = ${JSON.stringify(store)};
				const ready = ${JSON.stringify(ready)};
				const go = ${JSON.stringify(go)};
				const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
				const read = fs.readFileSync; let paused = false;
				fs.readFileSync = (...args) => {
					const value = read(...args);
					if (!paused && args[0] === store) {
						paused = true;
						fs.writeFileSync(ready + "/writer", "");
						while (!fs.existsSync(go)) sleep();
					}
					return value;
				};
				syncBuiltinESMExports();
				const { recordModelFailure } = await import(${JSON.stringify(moduleUrl)});
				recordModelFailure({ modelId: "claude", provider: "anthropic", reason: "invalid api key" });
				console.log("wrote");
			`;
			const writer = runIsolatedModule(script, { ...process.env, PI_MODEL_EXCLUSIONS_PATH: store });
			await waitForFiles(ready, 1);
			const clearer = Promise.resolve().then(() => {
				releaseTransientModelRecoveryProbe(claim, true);
				return "cleared";
			});
			await new Promise((resolve) => setTimeout(resolve, 20));
			fs.writeFileSync(go, "");
			await Promise.all([writer, clearer]);
			reloadFromDisk();
			assert.equal(findModelExclusion("openai/gpt-4"), undefined);
			assert.equal(findModelExclusion("anthropic/claude")?.reason, "invalid api key");
		} finally {
			if (previousStore === undefined) delete process.env.PI_MODEL_EXCLUSIONS_PATH;
			else process.env.PI_MODEL_EXCLUSIONS_PATH = previousStore;
			reloadFromDisk();
			fs.rmSync(path.dirname(store), { recursive: true, force: true });
		}
	});

	it("keeps both exclusions when two writers observe the same snapshot before either rename", async () => {
		const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-probe-cas-")), "exclusions.json");
		const barrier = path.join(path.dirname(store), "barrier");
		const ready = path.join(barrier, "ready");
		const go = path.join(barrier, "go");
		fs.mkdirSync(ready, { recursive: true });
		fs.writeFileSync(store, JSON.stringify({ version: 1, exclusions: [] }), "utf-8");
		const moduleUrl = pathToFileURL(path.resolve("src/runs/shared/model-exclusions.ts")).href;
		const makeScript = (modelId: string, provider: string, reason: string) => `
			import { createRequire } from "node:module";
			import { syncBuiltinESMExports } from "node:module";
			const require = createRequire(import.meta.url); const fs = require("node:fs");
			const store = ${JSON.stringify(store)};
			const ready = ${JSON.stringify(ready)};
			const go = ${JSON.stringify(go)};
			const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			const read = fs.readFileSync; let paused = false;
			fs.readFileSync = (...args) => {
				const value = read(...args);
				if (!paused && args[0] === store) {
					paused = true;
					fs.writeFileSync(ready + "/${provider}", "");
					while (!fs.existsSync(go)) sleep();
				}
				return value;
			};
			syncBuiltinESMExports();
			const { recordModelFailure } = await import(${JSON.stringify(moduleUrl)});
			recordModelFailure({ modelId: ${JSON.stringify(modelId)}, provider: ${JSON.stringify(provider)}, reason: ${JSON.stringify(reason)} });
			console.log("wrote");
		`;
		const environment = { ...process.env, PI_MODEL_EXCLUSIONS_PATH: store };
		try {
			const first = runIsolatedModule(makeScript("gpt-4", "openai", "invalid api key"), environment);
			const second = runIsolatedModule(makeScript("claude", "anthropic", "invalid api key"), environment);
			await waitForFiles(ready, 2);
			fs.writeFileSync(go, "");
			await Promise.all([first, second]);
			const previousStore = process.env.PI_MODEL_EXCLUSIONS_PATH;
			process.env.PI_MODEL_EXCLUSIONS_PATH = store;
			try {
				reloadFromDisk();
				assert.equal(findModelExclusion("openai/gpt-4")?.reason, "invalid api key");
				assert.equal(findModelExclusion("anthropic/claude")?.reason, "invalid api key");
			} finally {
				if (previousStore === undefined) delete process.env.PI_MODEL_EXCLUSIONS_PATH;
				else process.env.PI_MODEL_EXCLUSIONS_PATH = previousStore;
				reloadFromDisk();
			}
		} finally {
			fs.rmSync(path.dirname(store), { recursive: true, force: true });
		}
	});

	it("does not steal a recently created empty store lock", () => {
		const lockPath = `${getExclusionsFilePath()}.store.lock`;
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(lockPath, "", { flag: "wx" });
		const errors = captureConsole("error", () => {
			recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "timeout" });
		});
		assert.equal(fs.readFileSync(lockPath, "utf-8"), "");
		assert.equal(getExcludedCount(), 0);
		assert.equal(fs.existsSync(getExclusionsFilePath()), false);
		assert.ok(errors.some((args) => String(args[0]).includes("Failed to persist a recorded exclusion")));
		fs.rmSync(lockPath, { force: true });
	});

	it("reclaims a stale empty store lock", () => {
		const lockPath = `${getExclusionsFilePath()}.store.lock`;
		fs.mkdirSync(path.dirname(lockPath), { recursive: true });
		fs.writeFileSync(lockPath, "", { flag: "wx" });
		const ancient = new Date(Date.now() - 60_000);
		fs.utimesSync(lockPath, ancient, ancient);
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "timeout" });
		assert.equal(isExcluded("gpt-4", "openai"), true);
		assert.equal(fs.existsSync(lockPath), false);
	});

	it("does not steal a replacement store lock when two reclaimers see the same stale lock", async () => {
		const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-store-lock-")), "exclusions.json");
		const lockPath = `${store}.store.lock`;
		const barrier = path.join(path.dirname(store), "barrier");
		const ready = path.join(barrier, "ready");
		const go = path.join(barrier, "go");
		fs.mkdirSync(ready, { recursive: true });
		fs.writeFileSync(store, JSON.stringify({ version: 1, exclusions: [] }), "utf-8");
		fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999 }), "utf-8");
		const moduleUrl = pathToFileURL(path.resolve("src/runs/shared/model-exclusions.ts")).href;
		const makeScript = (modelId: string, provider: string) => `
			import { createRequire } from "node:module";
			import { syncBuiltinESMExports } from "node:module";
			const require = createRequire(import.meta.url); const fs = require("node:fs");
			const lockPath = ${JSON.stringify(lockPath)};
			const ready = ${JSON.stringify(ready)};
			const go = ${JSON.stringify(go)};
			const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
			const read = fs.readFileSync; let paused = false;
			fs.readFileSync = (...args) => {
				const value = read(...args);
				if (!paused && args[0] === lockPath) {
					paused = true;
					fs.writeFileSync(ready + "/${provider}", "");
					while (!fs.existsSync(go)) sleep();
				}
				return value;
			};
			syncBuiltinESMExports();
			const { recordModelFailure } = await import(${JSON.stringify(moduleUrl)});
			recordModelFailure({ modelId: ${JSON.stringify(modelId)}, provider: ${JSON.stringify(provider)}, reason: "invalid api key" });
			console.log("wrote");
		`;
		const environment = { ...process.env, PI_MODEL_EXCLUSIONS_PATH: store };
		try {
			const first = runIsolatedModule(makeScript("gpt-4", "openai"), environment);
			const second = runIsolatedModule(makeScript("claude", "anthropic"), environment);
			await waitForFiles(ready, 2);
			fs.writeFileSync(go, "");
			await Promise.all([first, second]);
			const previousStore = process.env.PI_MODEL_EXCLUSIONS_PATH;
			process.env.PI_MODEL_EXCLUSIONS_PATH = store;
			try {
				reloadFromDisk();
				assert.equal(findModelExclusion("openai/gpt-4")?.reason, "invalid api key");
				assert.equal(findModelExclusion("anthropic/claude")?.reason, "invalid api key");
			} finally {
				if (previousStore === undefined) delete process.env.PI_MODEL_EXCLUSIONS_PATH;
				else process.env.PI_MODEL_EXCLUSIONS_PATH = previousStore;
				reloadFromDisk();
			}
		} finally {
			fs.rmSync(path.dirname(store), { recursive: true, force: true });
		}
	});

	it("does not let a stale flushPersist overwrite a newer locked store update", async () => {
		const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-store-flush-")), "exclusions.json");
		const previousStore = process.env.PI_MODEL_EXCLUSIONS_PATH;
		process.env.PI_MODEL_EXCLUSIONS_PATH = store;
		try {
			reloadFromDisk();
			recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "503 service unavailable" });
			const moduleUrl = pathToFileURL(path.resolve("src/runs/shared/model-exclusions.ts")).href;
			await runIsolatedModule(
				`import { recordModelFailure } from ${JSON.stringify(moduleUrl)}; recordModelFailure({ modelId: "claude", provider: "anthropic", reason: "invalid api key" });`,
				{ ...process.env, PI_MODEL_EXCLUSIONS_PATH: store },
			);
			flushPersist();
			reloadFromDisk();
			assert.equal(findModelExclusion("openai/gpt-4")?.reason, "503 service unavailable");
			assert.equal(findModelExclusion("anthropic/claude")?.reason, "invalid api key");
		} finally {
			if (previousStore === undefined) delete process.env.PI_MODEL_EXCLUSIONS_PATH;
			else process.env.PI_MODEL_EXCLUSIONS_PATH = previousStore;
			reloadFromDisk();
			fs.rmSync(path.dirname(store), { recursive: true, force: true });
		}
	});

	it("does not throw when successful-probe cleanup cannot persist", () => {
		const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-probe-cleanup-"));
		const isolated = path.join(isolatedRoot, "nested", "exclusions.json");
		const previous = process.env.PI_MODEL_EXCLUSIONS_PATH;
		process.env.PI_MODEL_EXCLUSIONS_PATH = isolated;
		try {
			reloadFromDisk();
			recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "503 service unavailable" });
			const claim = claimTransientModelRecoveryProbe("openai/gpt-4");
			assert.equal(claim.status, "claimed");
			const parent = path.dirname(isolated);
			fs.rmSync(parent, { recursive: true, force: true });
			fs.writeFileSync(parent, "not-a-directory");
			assert.doesNotThrow(() => releaseTransientModelRecoveryProbe(claim, true));
		} finally {
			if (previous === undefined) delete process.env.PI_MODEL_EXCLUSIONS_PATH;
			else process.env.PI_MODEL_EXCLUSIONS_PATH = previous;
			fs.rmSync(isolatedRoot, { recursive: true, force: true });
			reloadFromDisk();
		}
	});
});

describe("model exclusions — TTL expiry", () => {
	it("rejects invalid default TTLs", () => {
		assert.throws(() => setDefaultTTL(0), /finite positive/);
		assert.throws(() => setDefaultTTL(Number.POSITIVE_INFINITY), /finite positive/);
		assert.throws(() => setDefaultTTL(MAX_MODEL_EXCLUSION_TTL_MS + 1), /no greater than/);
	});

	it("keeps the maximum configured expiry representable", () => {
		setDefaultTTL(MAX_MODEL_EXCLUSION_TTL_MS);
		recordModelFailure({ modelId: "gpt-4", provider: "openai" });
		reloadFromDisk();
		const entry = JSON.parse(fs.readFileSync(getExclusionsFilePath(), "utf-8")).exclusions[0] as ModelExclusion;
		assert.doesNotThrow(() => new Date(entry.expiresAt).toISOString());
		assert.equal(isExcluded("gpt-4", "openai"), true);
	});

	it("drops an exclusion after its TTL elapses", async () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", ttlMs: 100 });
		assert.equal(isExcluded("gpt-4", "openai"), true);
		await new Promise((r) => setTimeout(r, 150));
		assert.equal(isExcluded("gpt-4", "openai"), false);
	});

	it("shortens active exclusions without synchronously persisting or extending expiries", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "503", ttlMs: 60_000 });
		const before = JSON.parse(fs.readFileSync(getExclusionsFilePath(), "utf-8")).exclusions[0] as ModelExclusion;
		setDefaultTTL(30_000, { shortenExisting: true });
		const beforeFlush = JSON.parse(fs.readFileSync(getExclusionsFilePath(), "utf-8")).exclusions[0] as ModelExclusion;
		assert.equal(beforeFlush.expiresAt, before.expiresAt);
		flushPersist();
		const shortened = JSON.parse(fs.readFileSync(getExclusionsFilePath(), "utf-8")).exclusions[0] as ModelExclusion;
		assert.equal(shortened.expiresAt, shortened.recordedAt + 30_000);

		setDefaultTTL(120_000, { shortenExisting: true });
		flushPersist();
		const notExtended = JSON.parse(fs.readFileSync(getExclusionsFilePath(), "utf-8")).exclusions[0] as ModelExclusion;
		assert.equal(notExtended.expiresAt, shortened.expiresAt);
		assert.ok(shortened.expiresAt < before.expiresAt);
	});
});

describe("model exclusions — parseModelKey", () => {
	it("splits provider and modelId", () => {
		assert.deepEqual(parseModelKey("openai/gpt-4"), { provider: "openai", modelId: "gpt-4" });
	});

	it("strips a thinking suffix before parsing", () => {
		assert.deepEqual(parseModelKey("openai/gpt-5:high"), { provider: "openai", modelId: "gpt-5" });
	});

	it("preserves variant tags before stripping a known thinking suffix", () => {
		assert.deepEqual(parseModelKey("ollama-cloud/deepseek-v4-flash:0731:high"), {
			provider: "ollama-cloud",
			modelId: "deepseek-v4-flash:0731",
		});
	});

	it("keeps slashes inside the modelId", () => {
		assert.deepEqual(parseModelKey("openrouter/google/gemini-flash"), {
			provider: "openrouter",
			modelId: "google/gemini-flash",
		});
	});

	it("handles a bare model id without a provider", () => {
		assert.deepEqual(parseModelKey("gpt-4"), { modelId: "gpt-4" });
	});
});

describe("model exclusions — filtering fallback candidates", () => {
	it("removes excluded candidates from a candidate list", () => {
		const candidates = ["anthropic/claude-3", "openai/gpt-4", "openai/gpt-4o"];
		recordModelFailure({ provider: "openai" });
		const filtered = filterFallbackCandidates(candidates);
		assert.deepEqual(filtered, ["anthropic/claude-3"]);
	});

	it("removes a candidate recorded with a thinking suffix", () => {
		const candidates = ["anthropic/claude-3", "openai/gpt-5:high"];
		recordModelFailure({ modelId: "gpt-5", provider: "openai" });
		const filtered = filterFallbackCandidates(candidates);
		assert.deepEqual(filtered, ["anthropic/claude-3"]);
	});

	it("keeps unexcluded candidates and de-duplicates", () => {
		const candidates = ["anthropic/claude-3", "anthropic/claude-3", "openai/gpt-4"];
		const filtered = filterFallbackCandidates(candidates);
		assert.deepEqual(filtered, ["anthropic/claude-3", "openai/gpt-4"]);
	});

	it("reports the cached reason and expiry for skipped candidates", () => {
		const skipped: Array<{ candidate: string; exclusion: Readonly<ModelExclusion> }> = [];
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "503 unavailable" });
		const filtered = filterFallbackCandidates(["openai/gpt-4", "anthropic/claude-3"], {
			onExcluded: (candidate, exclusion) => skipped.push({ candidate, exclusion }),
		});
		assert.deepEqual(filtered, ["anthropic/claude-3"]);
		assert.equal(skipped[0]?.candidate, "openai/gpt-4");
		assert.equal(skipped[0]?.exclusion.reason, "503 unavailable");
		assert.ok((skipped[0]?.exclusion.expiresAt ?? 0) > Date.now());
	});
});

describe("model exclusions — persistence", () => {
	it("keeps an auth exclusion after reload when auth.json is unchanged", () => {
		fs.mkdirSync(path.dirname(authPath), { recursive: true });
		fs.writeFileSync(authPath, JSON.stringify({ openai: { access: "credential-a" } }), "utf-8");
		const authMtime = new Date(Date.now() - 1_000);
		fs.utimesSync(authPath, authMtime, authMtime);
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "invalid oauth token" });
		reloadFromDisk();
		assert.equal(isExcluded("gpt-4", "openai"), true);
	});

	it("invalidates an auth exclusion after auth.json is modified", () => {
		fs.mkdirSync(path.dirname(authPath), { recursive: true });
		fs.writeFileSync(authPath, JSON.stringify({ openai: { access: "credential-a" } }), "utf-8");
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "invalid oauth token" });
		const { recordedAt } = JSON.parse(fs.readFileSync(getExclusionsFilePath(), "utf-8")).exclusions[0] as ModelExclusion;
		const newerAuthMtime = new Date(recordedAt + 1_000);
		fs.utimesSync(authPath, newerAuthMtime, newerAuthMtime);
		reloadFromDisk();
		assert.equal(findModelExclusion("openai/gpt-4"), undefined);
		assert.equal(isExcluded("gpt-4", "openai"), false);
	});

	it("keeps a non-auth exclusion after auth.json is modified", () => {
		fs.mkdirSync(path.dirname(authPath), { recursive: true });
		fs.writeFileSync(authPath, JSON.stringify({ openai: { access: "credential-a" } }), "utf-8");
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "quota exceeded" });
		const { recordedAt } = JSON.parse(fs.readFileSync(getExclusionsFilePath(), "utf-8")).exclusions[0] as ModelExclusion;
		const newerAuthMtime = new Date(recordedAt + 1_000);
		fs.utimesSync(authPath, newerAuthMtime, newerAuthMtime);
		reloadFromDisk();
		assert.equal(isExcluded("gpt-4", "openai"), true);
	});

	it("does not persist credential contents in the exclusion store", () => {
		const accessToken = "access-token-secret";
		const refreshToken = "refresh-token-secret";
		fs.mkdirSync(path.dirname(authPath), { recursive: true });
		fs.writeFileSync(authPath, JSON.stringify({ openai: { access: accessToken, refresh: refreshToken } }), "utf-8");
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "invalid oauth token" });
		const persisted = fs.readFileSync(getExclusionsFilePath(), "utf-8");
		assert.equal(persisted.includes(accessToken), false);
		assert.equal(persisted.includes(refreshToken), false);
	});

	it("survives a reload from disk", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "429" });
		reloadFromDisk();
		assert.equal(isExcluded("gpt-4", "openai"), true);
	});

	it("persists a recorded model failure before process exit", () => {
		const file = getExclusionsFilePath();
		fs.rmSync(file, { force: true });
		reloadFromDisk();
		recordModelFailure({ modelId: "gpt-4", provider: "openai", reason: "429" });
		assert.equal(fs.existsSync(file), true);
		reloadFromDisk();
		assert.equal(isExcluded("gpt-4", "openai"), true);
	});

	it("does not reload expired exclusions", () => {
		recordModelFailure({ modelId: "gpt-4", provider: "openai", ttlMs: 1 });
		flushPersist();
		return new Promise<void>((resolve) => {
			setTimeout(() => {
				reloadFromDisk();
				assert.equal(isExcluded("gpt-4", "openai"), false);
				resolve();
			}, 20);
		});
	});

	it("reports corrupt persisted exclusions and starts empty", () => {
		fs.writeFileSync(getExclusionsFilePath(), "not json", "utf-8");
		const errors = captureConsole("error", reloadFromDisk);
		assert.equal(getExcludedCount(), 0);
		assert.equal(errors.length, 1);
		assert.match(String(errors[0]?.[0]), /Failed to load exclusions/);
	});

	it("drops malformed persisted exclusions", () => {
		for (const [patch, expected] of [
			[{ expiresAt: null }, /invalid expiresAt/],
			[{ expiresAt: 0 }, /invalid expiresAt/],
			[{ expiresAt: 9_000_000_000_000_000 }, /invalid expiresAt/],
			[{ recordedAt: null }, /invalid recordedAt/],
			[{ recordedAt: -1 }, /invalid recordedAt/],
			[{ recordedAt: 9_000_000_000_000_000 }, /invalid recordedAt/],
			[{ reason: null }, /invalid reason/],
			[{ reason: 503 }, /invalid reason/],
			[{ reason: { bad: true } }, /invalid reason/],
			[{ reason: ["503"] }, /invalid reason/],
			[{ modelId: 42 }, /invalid modelId/],
			[{ modelId: "" }, /invalid modelId/],
			[{ provider: 42 }, /invalid provider/],
			[{ modelId: undefined, provider: "" }, /invalid provider/],
			[{ modelId: undefined, provider: undefined }, /must include modelId or provider/],
		] as const) {
			const now = Date.now();
			const entry = { modelId: "gpt-4", provider: "openai", reason: "503", recordedAt: now, expiresAt: now + 60_000, ...patch };
			fs.writeFileSync(getExclusionsFilePath(), JSON.stringify({ version: 1, exclusions: [entry] }), "utf-8");
			const warnings = captureConsole("warn", reloadFromDisk);
			assert.equal(getExcludedCount(), 0);
			assert.equal(warnings.length, 1);
			assert.match(String(warnings[0]?.[0]), expected);
			assert.equal(captureConsole("warn", reloadFromDisk).length, 0);
			assert.equal(getExcludedCount(), 0);
		}
	});
});
