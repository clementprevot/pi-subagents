import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { createSshProjectTools, prepareSshContext, runSshProject, sshQuote } from "../../src/runs/shared/ssh-project-tools.ts";
import { snapshotSshProjectBootstrap } from "../../src/runs/shared/ssh-project-bootstrap.ts";

const profile = snapshotSshProjectBootstrap({ target: "user@host", projectDir: "/project ' $(touch BAD)`literal`", childProfile: "fresh-native-read-bash", localRuntime: { cwd: process.cwd(), agentDir: process.cwd(), projectTrusted: false, noContextFiles: true, projectDiscovery: "disabled" }, selectedDocuments: { agent: { path: `${process.cwd()}/agent.md`, content: "SELECTED" }, skills: [] } });

test("SSH public tool operations: quoting, selected documents, errors, cancellation and byte bounds", async () => {
	const original = cp.spawn;
	let output = "", code: number | null = 0, hang = false, killed = false;
	const invocations: Array<{ command: string; args: readonly string[]; options: unknown; script: string }> = [];
	cp.spawn = ((command: string, args: readonly string[], options: unknown) => {
		const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(): boolean };
		child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
		const invocation = { command, args, options, script: "" }; invocations.push(invocation);
		child.kill = () => { killed = true; queueMicrotask(() => child.emit("close", null)); return true; };
		child.stdin.on("data", chunk => { invocation.script += chunk; });
		child.stdin.on("finish", () => { if (!hang) queueMicrotask(() => { child.stdout.emit("data", Buffer.from(output)); child.emit("close", code); }); });
		return child;
	}) as typeof cp.spawn;
	syncBuiltinESMExports();
	try {
		const read = createSshProjectTools(profile).find(tool => tool.name === "read")!;
		const local = await read.execute("local", { path: profile.selectedDocuments!.agent.path, scope: "local-resource" }, undefined, undefined, {} as never);
		assert.equal(local.content[0]?.type, "text"); assert.equal(invocations.length, 0);
		await assert.rejects(() => read.execute("escape", { path: "../auth.json", scope: "local-resource" }, undefined, undefined, {} as never), /not explicitly selected/);
		output = Buffer.from("REMOTE\nSECOND").toString("base64");
		await read.execute("remote", { path: "file ' $(touch BAD)`literal`", offset: 2, limit: 1 }, undefined, undefined, {} as never);
		assert.equal(invocations[0]!.command, "ssh"); assert.equal((invocations[0]!.options as { shell: boolean }).shell, false);
		assert(invocations[0]!.args.at(-1)!.includes(sshQuote(profile.projectDir)));
		assert(invocations[0]!.script.includes("'\\''")); assert(invocations[0]!.args.includes("ForwardAgent=no")); assert(invocations[0]!.args.includes("SendEnv=-*"));
		code = 255; await assert.rejects(() => runSshProject(profile, "exit 1"), /no local fallback/);
		code = 0; output = "x".repeat(512 * 1024 + 1); await assert.rejects(() => runSshProject(profile, "large"), /limit.*uncertain/su); assert(killed);
		output = "/AGENTS.md\n\n"; await prepareSshContext(profile); // empty context document is present, not malformed
		hang = true; const controller = new AbortController(); const pending = runSshProject(profile, "hang", controller.signal); controller.abort();
		await assert.rejects(() => pending, /remote descendants\/completion may be uncertain/);
		await assert.rejects(() => runSshProject(profile, "timeout", undefined, 5), /deadline.*uncertain/su);
	} finally { cp.spawn = original; syncBuiltinESMExports(); }
});

test("POSIX operand quoting preserves literal shell metacharacters", { skip: process.platform === "win32" }, () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-quote-"));
	try {
		const operand = "space ' quote $(touch BAD) `touch BAD` $HOME ; end";
		const result = cp.spawnSync("/bin/sh", ["-c", `printf '%s' ${sshQuote(operand)}`], { cwd, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
		assert.equal(result.status, 0); assert.equal(result.stdout, operand); assert.deepEqual(fs.readdirSync(cwd), []);
	} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
