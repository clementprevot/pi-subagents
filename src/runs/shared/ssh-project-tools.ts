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
				const file = path.posix.resolve(profile.projectDir, args.path);
				const encoded = await runSshProject(profile, `set -eu\ntest -f ${sshQuote(file)}\ntest -r ${sshQuote(file)}\ndd if=${sshQuote(file)} bs=1 count=262145 2>/dev/null | base64 | tr -d '\\n'`, signal);
				if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new Error("Invalid SSH read response.");
				const bytes = Buffer.from(encoded, "base64");
				if (bytes.length > 262144) throw new Error("Remote text read exceeds 256 KiB; use bounded remote bash instead.");
				text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				if (text.includes("\0")) throw new Error("Remote binary/image reads are unsupported.");
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
			await runSshProject(profile, `set -eu\nmkdir -p ${sshQuote(path.posix.dirname(file))}\nprintf '%s' ${sshQuote(bytes.toString("base64"))} | base64 -d | dd of=${sshQuote(file)} 2>/dev/null`, signal);
			return { content: [{ type: "text", text: `Wrote ${bytes.length} bytes to ${file}` }], details: { path: file, bytes: bytes.length } };
		},
	};
	return selectedTools?.includes("write") ? [read, bash, write] : [read, bash];
}
