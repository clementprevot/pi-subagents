import { spawn } from "node:child_process";
import * as path from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SshProjectBootstrap } from "./ssh-project-bootstrap.ts";

export const sshQuote = (value: string): string => `'${value.replace(/'/gu, `'\\''`)}'`;
const MAX_BYTES = 512 * 1024;
const UNCERTAIN = "Local SSH transport stopped; remote descendants/completion may be uncertain.";

export async function runSshProject(profile: SshProjectBootstrap, script: string, signal?: AbortSignal, timeoutMs = 30_000, includeFailureOutput = false): Promise<string> {
	if (signal?.aborted) throw new Error(UNCERTAIN);
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", "-o", "SendEnv=-*", "-o", "ConnectTimeout=10", "--", profile.target,
			`cd ${sshQuote(profile.projectDir)} && exec bash --noprofile --norc -o pipefail -s`], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let bytes = 0;
		let stderr = "";
		let failure: Error | undefined;
		const stop = (message: string) => { failure ??= new Error(`${message} ${UNCERTAIN}`); child.kill("SIGKILL"); };
		const abort = () => stop("Aborted.");
		const timer = setTimeout(() => stop("SSH deadline exceeded."), timeoutMs);
		const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
		child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > MAX_BYTES) stop("SSH output limit exceeded."); else chunks.push(chunk); });
		child.stderr.on("data", (chunk: Buffer) => { if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096 - stderr.length); });
		child.once("error", () => { cleanup(); reject(new Error("SSH could not start; no local fallback.")); });
		child.once("close", code => { cleanup(); if (failure) reject(failure); else if (code !== 0) reject(new Error(`SSH failed (${code ?? "signal"}); no local fallback.${includeFailureOutput ? ` ${stderr}\n${Buffer.concat(chunks).toString("utf8").slice(-4096)}` : ""}`)); else resolve(Buffer.concat(chunks).toString("utf8")); });
		child.stdin.on("error", () => {});
		child.stdin.end(script);
	});
}

export async function prepareSshContext(profile: SshProjectBootstrap, signal?: AbortSignal): Promise<string> {
	const directories: string[] = [];
	let dir = path.posix.resolve(profile.projectDir);
	for (;;) { directories.unshift(dir); if (dir === "/") break; if (directories.length >= 32) throw new Error("SSH project ancestor limit exceeded."); dir = path.posix.dirname(dir); }
	const names = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	const paths: string[] = [];
	const script = ["set -eu", `test "$(pwd -P)" = ${sshQuote(path.posix.resolve(profile.projectDir))}`, "command -v bash >/dev/null", "command -v base64 >/dev/null", "command -v dd >/dev/null", "command -v tr >/dev/null"];
	for (const directory of directories) {
		script.push(`for p in ${names.map(name => sshQuote(path.posix.join(directory, name))).join(" ")}; do`);
		for (const name of names) paths.push(path.posix.join(directory, name));
		script.push(`if [ -f "$p" ]; then test -r "$p"; printf '%s\\n' "$p"; dd if="$p" bs=1 count=65537 2>/dev/null | base64 | tr -d '\\n'; printf '\\n'; break; fi`, "done");
	}
	const output = await runSshProject(profile, script.join("\n"), signal);
	const lines = (output.endsWith("\n") ? output.slice(0, -1) : output).split("\n");
	if (!output) return "";
	const documents: string[] = [];
	for (let i = 0; i < lines.length; i += 2) {
		const file = lines[i]!, encoded = lines[i + 1];
		if (!paths.includes(file) || encoded === undefined || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new Error("Invalid SSH context response.");
		const bytes = Buffer.from(encoded, "base64");
		if (bytes.length > 65536) throw new Error("SSH context document limit exceeded.");
		const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/u, "");
		documents.push(`## ssh://${profile.target}${file}\n${content}`);
	}
	return documents.join("\n\n");
}

function resolveBoundRemoteFile(projectDir: string, raw: string): string {
	if (!raw || /[\u0000-\u001f\u007f]/u.test(raw)) throw new Error("Invalid remote path.");
	const root = path.posix.resolve(projectDir);
	const file = path.posix.resolve(root, raw);
	if (file === root || !file.startsWith(`${root}/`)) throw new Error("Remote path is outside the bound project.");
	return file;
}

async function readRemoteUtf8(profile: SshProjectBootstrap, file: string, signal?: AbortSignal): Promise<string> {
	const encoded = await runSshProject(profile, `set -eu\ntest -f ${sshQuote(file)}\ntest -r ${sshQuote(file)}\ndd if=${sshQuote(file)} bs=1 count=262145 2>/dev/null | base64 | tr -d '\\n'`, signal);
	if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new Error("Invalid SSH read response.");
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length > 262144) throw new Error("Remote text read exceeds 256 KiB; use bounded remote bash instead.");
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (text.includes("\0")) throw new Error("Remote binary/image reads are unsupported.");
	return text;
}

function assertRemoteEditReplacement(oldText: string, newText: string): void {
	if (typeof oldText !== "string" || typeof newText !== "string" || oldText.includes("\0") || newText.includes("\0")) throw new Error("Remote binary/image writes are unsupported.");
	if (!oldText) throw new Error("Remote edit requires one unique exact oldText match.");
}

function applyUniqueExactReplacement(text: string, oldText: string, newText: string): string {
	assertRemoteEditReplacement(oldText, newText);
	const parts = text.split(oldText);
	if (parts.length === 2) return `${parts[0]}${newText}${parts[1]}`;
	throw new Error(parts.length < 2 ? "Remote edit oldText was not found." : "Remote edit oldText is not unique.");
}

function remoteWriteScript(file: string, encoded: string): string {
	return [
		"set -eu",
		"root=$(pwd -P)",
		"inside() { case \"$1\" in \"$root\"|\"$root\"/*) ;; *) echo \"Remote path is outside the bound project.\" >&2; exit 1 ;; esac; }",
		`file=${sshQuote(file)}`,
		"base=$(basename -- \"$file\")",
		"case \"$base\" in \"\"|\".\"|\"..\") echo \"Invalid remote path.\" >&2; exit 1 ;; esac",
		"orig=$(dirname -- \"$file\")",
		"exist=$orig",
		"while [ ! -e \"$exist\" ] && [ ! -L \"$exist\" ]; do nxt=$(dirname -- \"$exist\"); test \"$nxt\" != \"$exist\"; exist=$nxt; done",
		"cd -- \"$exist\"",
		"phys=$(pwd -P)",
		"inside \"$phys\"",
		"if [ \"$exist\" != \"$orig\" ]; then",
		"rest=${orig#\"$exist\"/}",
		"while [ -n \"$rest\" ]; do",
		"case \"$rest\" in */*) comp=${rest%%/*}; rest=${rest#*/} ;; *) comp=$rest; rest= ;; esac",
		"case \"$comp\" in \"\"|\".\"|\"..\") echo \"Invalid remote path.\" >&2; exit 1 ;; esac",
		"if [ -L \"./$comp\" ]; then echo \"Remote path is outside the bound project.\" >&2; exit 1; fi",
		"if [ ! -e \"./$comp\" ]; then mkdir -- \"./$comp\"; elif [ ! -d \"./$comp\" ]; then echo \"Remote path is outside the bound project.\" >&2; exit 1; fi",
		"cd -- \"./$comp\"",
		"phys=$(pwd -P)",
		"inside \"$phys\"",
		"done",
		"fi",
		"dest=$(pwd -P)",
		"inside \"$dest\"",
		"if [ -L \"./$base\" ] || [ -d \"./$base\" ]; then echo \"Remote path is outside the bound project.\" >&2; exit 1; fi",
		"if dd if=/dev/null of=/dev/null bs=1 count=0 oflag=nofollow 2>/dev/null; then nofollow=1; else nofollow=; fi",
		`if [ -n "$nofollow" ]; then printf '%s' ${sshQuote(encoded)} | base64 -d | dd of="./$base" oflag=nofollow 2>/dev/null; else`,
		"n=0; box=",
		"while [ \"$n\" -lt 32 ]; do n=$((n+1)); cand=./.pi-ssh-w-$$-$n; if mkdir -- \"$cand\" 2>/dev/null; then box=$cand; break; fi; done",
		"test -n \"$box\"",
		"cd -- \"$box\"",
		"inside \"$(pwd -P)\"",
		"set -C",
		`printf '%s' ${sshQuote(encoded)} | base64 -d > ./p`,
		"set +C",
		"test -f \"./p\" && test ! -L \"./p\"",
		"ok=",
		"if mv -T -- \"./p\" \"../$base\" 2>/dev/null; then ok=1; elif ln -fh -- \"./p\" \"../$base\" 2>/dev/null; then ok=1; elif ln -fn -- \"./p\" \"../$base\" 2>/dev/null; then ok=1; fi",
		"cd -- ..",
		"rm -rf -- \"$box\"",
		"test -n \"$ok\"",
		"fi",
		"test -f \"./$base\" && test ! -L \"./$base\"",
	].join("\n");
}

export function createSshProjectTools(profile: SshProjectBootstrap, selectedTools?: readonly string[]): ToolDefinition[] {
	const read: ToolDefinition = {
		name: "read", label: "read", description: "Read bounded remote UTF-8 text, or an explicitly selected local Markdown snapshot with scope=local-resource.",
		promptSnippet: "Read remote project text; selected local Markdown requires scope=local-resource and its exact selected path.",
		parameters: Type.Object({ path: Type.String(), scope: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) }),
		async execute(_id, raw, signal) {
			const args = raw as { path: string; scope?: string; offset?: number; limit?: number };
			let text: string;
			if (args.scope === "local-resource") {
				const selected = [profile.selectedDocuments?.agent, ...(profile.selectedDocuments?.skills ?? [])].find(doc => doc?.path === args.path);
				if (!selected) throw new Error("Local resource was not explicitly selected; no local filesystem fallback.");
				text = selected.content;
			} else {
				if (args.scope !== undefined && args.scope !== "project") throw new Error("Unsupported read scope.");
				if (!args.path || /[\u0000-\u001f\u007f]/u.test(args.path)) throw new Error("Invalid remote path.");
				text = await readRemoteUtf8(profile, path.posix.resolve(profile.projectDir, args.path), signal);
			}
			const start = (args.offset ?? 1) - 1;
			const lines = text.split("\n"), limit = args.limit ?? 2000;
			const page = lines.slice(start, start + limit).join("\n");
			const truncated = page.length > 50_000 || start + limit < lines.length;
			return { content: [{ type: "text", text: page.slice(0, 50_000) + (truncated ? "\n[Output truncated; use offset/limit or bounded remote bash for another range.]" : "") }], details: { truncated } };
		},
	};
	const bash: ToolDefinition = {
		name: "bash", label: "bash", description: "Run a command in the remote SSH project. Cancellation stops local transport only; remote descendants may survive.",
		promptSnippet: "Execute commands only in the remote SSH project; remote descendants may survive cancellation.",
		parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })) }),
		async execute(_id, raw, signal) {
			const args = raw as { command: string; timeout?: number };
			const text = await runSshProject(profile, `exec 2>&1\n${args.command}`, signal, (args.timeout ?? 30) * 1000, true);
			const truncated = text.length > 50_000;
			return {
				content: [{ type: "text", text: text.slice(0, 50_000) + (truncated ? "\n[Output truncated; rerun with bounded output to inspect another range.]" : "") }],
				details: { truncated },
			};
		},
	};
	const write: ToolDefinition = {
		name: "write", label: "write", description: "Write bounded remote UTF-8 text in the bound SSH project. Creates the file if needed and overwrites if it exists.",
		promptSnippet: "Write remote project text only; no local filesystem fallback.",
		parameters: Type.Object({ path: Type.String(), content: Type.String(), scope: Type.Optional(Type.String()) }),
		async execute(_id, raw, signal) {
			const args = raw as { path: string; content: string; scope?: string };
			if (args.scope !== undefined && args.scope !== "project") throw new Error("Unsupported write scope.");
			if (typeof args.content !== "string" || args.content.includes("\0")) throw new Error("Remote binary/image writes are unsupported.");
			const bytes = Buffer.from(args.content, "utf8");
			if (bytes.length > 262144) throw new Error("Remote text write exceeds 256 KiB.");
			const file = resolveBoundRemoteFile(profile.projectDir, args.path);
			await runSshProject(profile, remoteWriteScript(file, bytes.toString("base64")), signal);
			return { content: [{ type: "text", text: `Wrote ${bytes.length} bytes to ${file}` }], details: { path: file, bytes: bytes.length } };
		},
	};
	const edit: ToolDefinition = {
		name: "edit", label: "edit", description: "Replace one unique exact UTF-8 occurrence in a bound remote SSH project file.",
		promptSnippet: "Edit remote project text with one exact unique replacement; no local filesystem fallback.",
		parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String(), scope: Type.Optional(Type.String()) }),
		async execute(_id, raw, signal) {
			const args = raw as { path: string; oldText: string; newText: string; scope?: string };
			if (args.scope !== undefined && args.scope !== "project") throw new Error("Unsupported edit scope.");
			assertRemoteEditReplacement(args.oldText, args.newText);
			const file = resolveBoundRemoteFile(profile.projectDir, args.path);
			const next = applyUniqueExactReplacement(await readRemoteUtf8(profile, file, signal), args.oldText, args.newText);
			const bytes = Buffer.from(next, "utf8");
			if (bytes.length > 262144) throw new Error("Remote text write exceeds 256 KiB.");
			await runSshProject(profile, remoteWriteScript(file, bytes.toString("base64")), signal);
			return { content: [{ type: "text", text: `Edited ${file}` }], details: { path: file, bytes: bytes.length } };
		},
	};
	const tools: ToolDefinition[] = [read, bash];
	if (selectedTools?.includes("write")) tools.push(write);
	if (selectedTools?.includes("edit")) tools.push(edit);
	return tools;
}
