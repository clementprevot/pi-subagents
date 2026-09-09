import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { loadSelectedAgentDocument } from "../../src/agents/agents.ts";
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
		output = "/AGENTS.md\n\n"; await prepareSshContext(profile);
		hang = true; const controller = new AbortController(); const pending = runSshProject(profile, "hang", controller.signal); controller.abort();
		await assert.rejects(() => pending, /remote descendants\/completion may be uncertain/);
		await assert.rejects(() => runSshProject(profile, "timeout", undefined, 5), /deadline.*uncertain/su);
	} finally { cp.spawn = original; syncBuiltinESMExports(); }
});

test("SSH write is omitted unless the bound agent selects it", () => {
	assert.deepEqual(createSshProjectTools(profile).map(tool => tool.name), ["read", "bash"]);
	assert.deepEqual(createSshProjectTools(profile, ["read", "bash"]).map(tool => tool.name), ["read", "bash"]);
	assert.deepEqual(createSshProjectTools(profile, ["read", "write"]).map(tool => tool.name), ["read", "bash", "write"]);
});

test("SSH selected agent may list write and still refuses edit", () => {
	const agent = (tools: string) => `---\nname: ssh-worker\ndescription: SSH worker\ntools: ${tools}\nasync: false\ndefaultContext: fresh\nsystemPromptMode: append\n---\nBody`;
	assert.deepEqual(loadSelectedAgentDocument({ path: `${process.cwd()}/agent.md`, content: agent("read,bash") }).tools, ["read", "bash"]);
	assert.deepEqual(loadSelectedAgentDocument({ path: `${process.cwd()}/agent.md`, content: agent("read,write") }).tools, ["read", "write"]);
	assert.throws(() => loadSelectedAgentDocument({ path: `${process.cwd()}/agent.md`, content: agent("read,edit") }), /unsupported execution capabilities/);
});

test("SSH write rejects unsafe scope and path before transport and never touches the local project", async () => {
	const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-write-local-"));
	const original = cp.spawn;
	const invocations: unknown[] = [];
	cp.spawn = ((command: string, args: readonly string[], options: unknown) => {
		invocations.push({ command, args, options });
		throw new Error("transport must not start");
	}) as typeof cp.spawn;
	syncBuiltinESMExports();
	try {
		fs.writeFileSync(path.join(localRoot, "canary.txt"), "LOCAL");
		const write = createSshProjectTools(profile, ["write"]).find(tool => tool.name === "write")!;
		await assert.rejects(() => write.execute("scope", { path: "ok.txt", content: "x", scope: "local-resource" }, undefined, undefined, {} as never), /Unsupported write scope/);
		await assert.rejects(() => write.execute("abs", { path: "/etc/passwd", content: "x" }, undefined, undefined, {} as never), /outside the bound project/);
		await assert.rejects(() => write.execute("escape", { path: "../secret", content: "x" }, undefined, undefined, {} as never), /outside the bound project/);
		await assert.rejects(() => write.execute("root", { path: ".", content: "x" }, undefined, undefined, {} as never), /outside the bound project/);
		await assert.rejects(() => write.execute("empty", { path: "", content: "x" }, undefined, undefined, {} as never), /Invalid remote path/);
		await assert.rejects(() => write.execute("ctrl", { path: "a\nb", content: "x" }, undefined, undefined, {} as never), /Invalid remote path/);
		await assert.rejects(() => write.execute("bin", { path: "ok.txt", content: "a\0b" }, undefined, undefined, {} as never), /binary/);
		assert.deepEqual(invocations, []);
		assert.deepEqual(fs.readdirSync(localRoot), ["canary.txt"]);
		assert.equal(fs.readFileSync(path.join(localRoot, "canary.txt"), "utf8"), "LOCAL");
	} finally { cp.spawn = original; syncBuiltinESMExports(); fs.rmSync(localRoot, { recursive: true, force: true }); }
});

test("SSH write sends exact remote path and bytes, overwrites, and fails closed", async () => {
	const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-write-cwd-"));
	const original = cp.spawn;
	const invocations: Array<{ command: string; args: readonly string[]; options: unknown; script: string }> = [];
	let code: number | null = 0, hang = false, killed = false;
	cp.spawn = ((command: string, args: readonly string[], options: unknown) => {
		const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill(): boolean };
		child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
		const invocation = { command, args, options, script: "" }; invocations.push(invocation);
		child.kill = () => { killed = true; queueMicrotask(() => child.emit("close", null)); return true; };
		child.stdin.on("data", chunk => { invocation.script += chunk; });
		child.stdin.on("finish", () => { if (!hang) queueMicrotask(() => child.emit("close", code)); });
		return child;
	}) as typeof cp.spawn;
	syncBuiltinESMExports();
	try {
		fs.writeFileSync(path.join(localRoot, "canary.txt"), "LOCAL");
		const write = createSshProjectTools(profile, ["write"]).find(tool => tool.name === "write")!;
		const relative = "dir ' $(touch BAD)`x`/file ' $(touch BAD)`.txt";
		const first = "hello $HOME && `touch LOCAL` ; end\nsecond line";
		const second = "overwritten bytes";
		const file = path.posix.resolve(profile.projectDir, relative);
		const result = await write.execute("first", { path: relative, content: first }, undefined, undefined, {} as never);
		assert.equal((result.details as { path: string; bytes: number }).path, file);
		assert.equal((result.details as { bytes: number }).bytes, Buffer.byteLength(first));
		await write.execute("second", { path: relative, content: second, scope: "project" }, undefined, undefined, {} as never);
		code = 255;
		await assert.rejects(() => write.execute("fail", { path: "ok.txt", content: "nope" }, undefined, undefined, {} as never), /no local fallback/);
		hang = true; const controller = new AbortController();
		const pending = write.execute("abort", { path: "ok.txt", content: "nope" }, controller.signal, undefined, {} as never);
		controller.abort();
		await assert.rejects(() => pending, /remote descendants\/completion may be uncertain/);
		assert.equal(invocations.length, 4);
		assert.equal(invocations[0]!.command, "ssh");
		assert.equal((invocations[0]!.options as { shell: boolean }).shell, false);
		assert(invocations[0]!.args.includes("ForwardAgent=no"));
		assert(invocations[0]!.script.includes(sshQuote(file)));
		assert(invocations[0]!.script.includes(sshQuote(Buffer.from(first, "utf8").toString("base64"))));
		assert(invocations[0]!.script.includes("pwd -P"));
		assert(invocations[0]!.script.includes('mkdir -- "./$comp"'));
		assert(!invocations[0]!.script.includes("mkdir -p"));
		assert(invocations[0]!.script.includes('dd of="./$base" oflag=nofollow'));
		assert(invocations[0]!.script.includes('cd -- "$box"'));
		assert(invocations[0]!.script.includes('dd of="./p"'));
		assert(!invocations[0]!.script.includes('dd of="$box/p"'));
		assert(!invocations[0]!.script.includes(first));
		assert(invocations[1]!.script.includes(sshQuote(Buffer.from(second, "utf8").toString("base64"))));
		assert(!invocations[1]!.script.includes(sshQuote(Buffer.from(first, "utf8").toString("base64"))));
		assert(killed);
		assert.deepEqual(fs.readdirSync(localRoot), ["canary.txt"]);
		assert.equal(fs.readFileSync(path.join(localRoot, "canary.txt"), "utf8"), "LOCAL");
		assert(!fs.existsSync(path.join(localRoot, "ok.txt")));
	} finally { cp.spawn = original; syncBuiltinESMExports(); fs.rmSync(localRoot, { recursive: true, force: true }); }
});

function installLocalSsh(projectDir: string): () => void {
	const original = cp.spawn;
	cp.spawn = ((command: string, args: readonly string[]) => {
		assert.equal(command, "ssh");
		return original("bash", ["--noprofile", "--norc", "-o", "pipefail", "-c", String(args.at(-1))], { cwd: projectDir, env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "pipe"] });
	}) as typeof cp.spawn;
	syncBuiltinESMExports();
	return () => { cp.spawn = original; syncBuiltinESMExports(); };
}

test("POSIX write recipe stores exact UTF-8 bytes and overwrites", { skip: process.platform === "win32" }, async () => {
	const remote = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-write-remote-"));
	const local = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-write-local-"));
	fs.writeFileSync(path.join(local, "canary.txt"), "LOCAL");
	const bound = snapshotSshProjectBootstrap({ target: "user@host", projectDir: remote, childProfile: "fresh-native-read-bash", localRuntime: { cwd: local, agentDir: local, projectTrusted: false, noContextFiles: true, projectDiscovery: "disabled" } });
	const restore = installLocalSsh(remote);
	try {
		const write = createSshProjectTools(bound, ["write"]).find(tool => tool.name === "write")!;
		const relative = "dir ' $(touch BAD)`x`/file ' $(touch BAD)`.txt";
		const first = "hello $HOME && `touch LOCAL` ; end\nsecond line";
		const second = "overwritten bytes";
		await write.execute("first", { path: relative, content: first }, undefined, undefined, {} as never);
		assert.deepEqual(fs.readFileSync(path.join(remote, relative)), Buffer.from(first, "utf8"));
		await write.execute("second", { path: relative, content: second }, undefined, undefined, {} as never);
		assert.deepEqual(fs.readFileSync(path.join(remote, relative)), Buffer.from(second, "utf8"));
		assert.deepEqual(fs.readdirSync(local), ["canary.txt"]);
		assert.equal(fs.readFileSync(path.join(local, "canary.txt"), "utf8"), "LOCAL");
	} finally {
		restore();
		fs.rmSync(remote, { recursive: true, force: true });
		fs.rmSync(local, { recursive: true, force: true });
	}
});

test("POSIX write refuses leaf and parent-dir symlink escape", { skip: process.platform === "win32" }, async () => {
	const remote = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-write-bound-"));
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-write-out-"));
	const local = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-write-cwd-"));
	fs.writeFileSync(path.join(outside, "escape.txt"), "SAFE");
	fs.symlinkSync(path.join(outside, "escape.txt"), path.join(remote, "leaf"));
	fs.symlinkSync(outside, path.join(remote, "parent"));
	fs.symlinkSync(path.join(outside, "missing"), path.join(remote, "dangling"));
	fs.symlinkSync(path.relative(remote, path.join(outside, "escape.txt")), path.join(remote, "rel-leaf"));
	fs.symlinkSync(path.relative(remote, outside), path.join(remote, "rel-parent"));
	fs.symlinkSync(path.relative(remote, path.join(outside, "missing")), path.join(remote, "rel-dangle"));
	fs.mkdirSync(path.join(remote, "realdir"));
	fs.symlinkSync(path.join(outside, "escape.txt"), path.join(remote, "realdir", "swap.txt"));
	const bound = snapshotSshProjectBootstrap({ target: "user@host", projectDir: remote, childProfile: "fresh-native-read-bash", localRuntime: { cwd: local, agentDir: local, projectTrusted: false, noContextFiles: true, projectDiscovery: "disabled" } });
	const restore = installLocalSsh(remote);
	try {
		const write = createSshProjectTools(bound, ["write"]).find(tool => tool.name === "write")!;
		await assert.rejects(() => write.execute("leaf", { path: "leaf", content: "ESCAPED" }, undefined, undefined, {} as never), /no local fallback/);
		assert.equal(fs.readFileSync(path.join(outside, "escape.txt"), "utf8"), "SAFE");
		await assert.rejects(() => write.execute("parent", { path: "parent/nested.txt", content: "ESCAPED" }, undefined, undefined, {} as never), /no local fallback/);
		assert.equal(fs.readFileSync(path.join(outside, "escape.txt"), "utf8"), "SAFE");
		assert(!fs.existsSync(path.join(outside, "nested.txt")));
		await assert.rejects(() => write.execute("dangling", { path: "dangling/sub/file.txt", content: "ESCAPED" }, undefined, undefined, {} as never), /no local fallback/);
		assert(!fs.existsSync(path.join(outside, "missing")));
		await assert.rejects(() => write.execute("rel-leaf", { path: "rel-leaf", content: "ESCAPED" }, undefined, undefined, {} as never), /no local fallback/);
		await assert.rejects(() => write.execute("rel-parent", { path: "rel-parent/nested.txt", content: "ESCAPED" }, undefined, undefined, {} as never), /no local fallback/);
		await assert.rejects(() => write.execute("rel-dangle", { path: "rel-dangle/sub/file.txt", content: "ESCAPED" }, undefined, undefined, {} as never), /no local fallback/);
		assert.equal(fs.readFileSync(path.join(outside, "escape.txt"), "utf8"), "SAFE");
		assert(!fs.existsSync(path.join(outside, "nested.txt")));
		assert(!fs.existsSync(path.join(outside, "missing")));
		await assert.rejects(() => write.execute("swap", { path: "realdir/swap.txt", content: "ESCAPED" }, undefined, undefined, {} as never), /no local fallback/);
		assert.equal(fs.readFileSync(path.join(outside, "escape.txt"), "utf8"), "SAFE");
		await assert.rejects(() => write.execute("comp", { path: "parent/deep/file.txt", content: "ESCAPED" }, undefined, undefined, {} as never), /no local fallback/);
		assert(!fs.existsSync(path.join(outside, "deep")));
		const planted = path.join(remote, "freshlink");
		fs.symlinkSync(outside, planted);
		const mkdirFollow = cp.spawnSync("/bin/mkdir", ["-p", "--", path.join(planted, "deep")], { encoding: "utf8" });
		assert.equal(mkdirFollow.status, 0);
		assert(fs.existsSync(path.join(outside, "deep")));
		fs.rmSync(path.join(outside, "deep"), { recursive: true, force: true });
		const mkdirLeaf = cp.spawnSync("/bin/mkdir", ["--", planted], { encoding: "utf8" });
		assert.notEqual(mkdirLeaf.status, 0);
		assert(!fs.existsSync(path.join(outside, "deep")));
		const box = path.join(remote, ".pi-ssh-w-swap");
		fs.mkdirSync(box);
		fs.rmdirSync(box);
		fs.symlinkSync(outside, box);
		const boxFollow = cp.spawnSync("/bin/dd", ["of=" + path.join(box, "p")], { input: "ESCAPED", encoding: "utf8" });
		assert.equal(boxFollow.status, 0);
		assert.equal(fs.readFileSync(path.join(outside, "p"), "utf8"), "ESCAPED");
		fs.rmSync(path.join(outside, "p"), { force: true });
		const open = cp.spawnSync("/bin/dd", ["of=" + path.join(remote, "realdir", "swap.txt"), "oflag=nofollow"], { input: "ESCAPED", encoding: "utf8" });
		assert.notEqual(open.status, 0);
		assert.equal(fs.readFileSync(path.join(outside, "escape.txt"), "utf8"), "SAFE");
		assert.deepEqual(fs.readdirSync(local), []);
	} finally {
		restore();
		fs.rmSync(remote, { recursive: true, force: true });
		fs.rmSync(outside, { recursive: true, force: true });
		fs.rmSync(local, { recursive: true, force: true });
	}
});

test("POSIX operand quoting preserves literal shell metacharacters", { skip: process.platform === "win32" }, () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-quote-"));
	try {
		const operand = "space ' quote $(touch BAD) `touch BAD` $HOME ; end";
		const result = cp.spawnSync("/bin/sh", ["-c", `printf '%s' ${sshQuote(operand)}`], { cwd, env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
		assert.equal(result.status, 0); assert.equal(result.stdout, operand); assert.deepEqual(fs.readdirSync(cwd), []);
	} finally { fs.rmSync(cwd, { recursive: true, force: true }); }
});
