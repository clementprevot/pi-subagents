import assert from "node:assert/strict";
import childProcess from "node:child_process";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV, PI_PACKAGE_DIR_ENV } from "../../src/shared/utils.ts";

const NPM_THEME_RELATIVE = path.join("dist", "modes", "interactive", "theme", "dark.json");

test("detached runner uses the detected npm Pi package root for PI_PACKAGE_DIR instead of an inherited bundled layout", async (t) => {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "async-spawn-package-dir-")));
	const host = path.join(root, "npm-pi");
	const bundled = path.join(root, "nix-store", "pi-0.85.1", "libexec", "pi");
	const hostExports: Record<string, string[]> = {
		"@earendil-works/pi-coding-agent": ["."],
		"@earendil-works/pi-agent-core": [".", "./node"],
		"@earendil-works/chord": [".", "./context"],
		"@earendil-works/pi-tui": ["."],
		"@earendil-works/pi-ai": ["./compat", "./oauth", "./providers/all"],
		"typebox": [".", "./compile", "./value"],
	};

	function writeHostPackage(pkg: string) {
		const dir = pkg === "@earendil-works/pi-coding-agent" ? host : path.join(host, "node_modules", pkg);
		fs.mkdirSync(dir, { recursive: true });
		const exports = Object.fromEntries(hostExports[pkg]!.map((subpath) => {
			const target = `./${subpath === "." ? "index" : subpath.slice(2).replaceAll("/", "-")}.mjs`;
			fs.writeFileSync(path.join(dir, target), "export {};\n");
			return [subpath, target];
		}));
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkg, version: "0.85.1", exports }));
	}

	for (const pkg of Object.keys(hostExports)) writeHostPackage(pkg);
	const npmThemePath = path.join(host, NPM_THEME_RELATIVE);
	fs.mkdirSync(path.dirname(npmThemePath), { recursive: true });
	fs.writeFileSync(npmThemePath, "{}\n");

	fs.mkdirSync(path.join(bundled, "theme"), { recursive: true });
	fs.writeFileSync(path.join(bundled, "theme", "dark.json"), "{}\n");
	assert.ok(!fs.existsSync(path.join(bundled, NPM_THEME_RELATIVE)));

	const originalArgv1 = process.argv[1];
	const previousPackageDir = process.env[PI_PACKAGE_DIR_ENV];
	process.env[PI_PACKAGE_DIR_ENV] = bundled;
	process.argv[1] = path.join(host, "index.mjs");
	try {
		const { makeAgent } = await import("../support/helpers.ts");
		const { executeAsyncSingle } = await import("../../src/runs/background/async-execution.ts");
		const spawn = t.mock.method(childProcess, "spawn", () => {
			throw new Error("spawn boundary captured");
		});
		syncBuiltinESMExports();
		const result = executeAsyncSingle("spawn-package-dir", {
			agent: "worker",
			task: "Inspect package dir wiring",
			agentConfig: makeAgent("worker"),
			ctx: { pi: { events: { emit() {} } }, cwd: root, currentSessionId: "spawn-package-dir-session" },
			artifactConfig: { enabled: false, includeInput: false, includeOutput: false, includeJsonl: false, includeMetadata: false, cleanupDays: 7 },
			shareEnabled: false,
			sessionRoot: path.join(root, "sessions"),
			maxSubagentDepth: 1,
			acceptance: false,
		});
		assert.equal(result.isError, true);
		assert.match(result.content[0]!.text, /spawn boundary captured/);
		assert.equal(spawn.mock.callCount(), 1);
		const options = spawn.mock.calls[0]!.arguments[2] as { env: NodeJS.ProcessEnv };
		assert.equal(options.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV], host);
		assert.equal(options.env[PI_PACKAGE_DIR_ENV], host);
		assert.notEqual(options.env[PI_PACKAGE_DIR_ENV], bundled);
		assert.ok(fs.existsSync(path.join(options.env[PI_PACKAGE_DIR_ENV]!, NPM_THEME_RELATIVE)));
		assert.ok(!fs.existsSync(path.join(bundled, NPM_THEME_RELATIVE)));
	} finally {
		t.mock.restoreAll();
		syncBuiltinESMExports();
		if (originalArgv1 === undefined) delete process.argv[1];
		else process.argv[1] = originalArgv1;
		if (previousPackageDir === undefined) delete process.env[PI_PACKAGE_DIR_ENV];
		else process.env[PI_PACKAGE_DIR_ENV] = previousPackageDir;
		fs.rmSync(root, { recursive: true, force: true });
	}
});
