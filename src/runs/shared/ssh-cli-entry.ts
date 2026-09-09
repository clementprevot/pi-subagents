import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { snapshotSshProjectBootstrap, type SshProjectBootstrap } from "./ssh-project-bootstrap.ts";

// Internal stock-CLI checkpoint. No general Pi argument forwarding.
export const SSH_BOOTSTRAP_FLAG = "--ssh-bootstrap=";
export const SSH_ENTRY = fileURLToPath(new URL("../../../ssh-entry.ts", import.meta.url));
export const SSH_ROOT = fileURLToPath(new URL("../../../index.ts", import.meta.url));
export const SSH_ISOLATION_ARGS = ["--no-approve", "--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-builtin-tools", "--tools", "read,bash,subagent"];
const fail = (): never => { throw new Error("Unsupported SSH entry arguments or local resources."); };

export interface SshEntrySelection {
	target: string;
	project: string;
	agent: string;
	extensions: string[];
	skills: string[];
	provider?: string;
	model?: string;
	mode?: string;
	prompt?: string;
	offline?: boolean;
}

export function parseSshEntrySelection(args: string[]): SshEntrySelection {
	const selection: Record<string, unknown> = { extensions: [], skills: [] };
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag === "--offline" && selection.offline === undefined) { selection.offline = true; continue; }
		if (!["--target", "--project", "--agent", "--extension", "--skill", "--provider", "--model", "--mode", "--prompt"].includes(flag!)) return fail();
		const value = args[++i];
		if (!value || value.startsWith("-") || value.startsWith("@") || /[\u0000-\u001f\u007f]/u.test(value)) return fail();
		const key = flag!.slice(2);
		if (key === "extension" || key === "skill") (selection[key === "extension" ? "extensions" : "skills"] as string[]).push(value);
		else { if (selection[key] !== undefined) return fail(); selection[key] = value; }
	}
	if (!selection.target || !selection.project || !selection.agent || (selection.mode !== undefined && !["text", "json", "rpc"].includes(selection.mode as string))) return fail();
	return selection as unknown as SshEntrySelection;
}

export function localAgentDir(): string {
	const value = process.env.PI_CODING_AGENT_DIR;
	return path.resolve(value === "~" ? os.homedir() : value && /^~[/\\]/u.test(value) ? path.join(os.homedir(), value.slice(2)) : value || path.join(os.homedir(), ".pi", "agent"));
}

function selectedFile(value: string, markdown: boolean): string {
	if (!path.isAbsolute(value) || (markdown && !/\.md$/iu.test(value))) return fail();
	const real = fs.realpathSync(value);
	if (markdown && !/\.md$/iu.test(real)) return fail();
	if (!fs.statSync(real).isFile()) return fail();
	return real;
}

export function validateSshEntrySelection(selection: SshEntrySelection, cwd: string, agentDir: string): { selection: SshEntrySelection; profile: SshProjectBootstrap } {
	const profile = snapshotSshProjectBootstrap({ target: selection.target, projectDir: selection.project, childProfile: "fresh-native-read-bash", localRuntime: { cwd, agentDir, projectTrusted: false, noContextFiles: true, projectDiscovery: "disabled" } });
	const agent = selectedFile(selection.agent, true);
	const skills = selection.skills.map(file => selectedFile(file, true));
	const extensions = selection.extensions.map(file => selectedFile(file, false));
	if (extensions.some(file => file === fs.realpathSync(SSH_ENTRY) || file === fs.realpathSync(SSH_ROOT)) || new Set(extensions).size !== extensions.length || new Set(skills).size !== skills.length) return fail();
	return { selection: { target: selection.target, project: selection.project, agent, skills, extensions, ...(selection.provider ? { provider: selection.provider } : {}), ...(selection.model ? { model: selection.model } : {}), ...(selection.mode ? { mode: selection.mode } : {}), ...(selection.prompt ? { prompt: selection.prompt } : {}), ...(selection.offline ? { offline: true } : {}) }, profile };
}

export function assertCleanSshControl(cwd: string): void {
	const stat = fs.lstatSync(cwd);
	if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== "win32" && (stat.mode & 0o077) !== 0) || (process.getuid && stat.uid !== process.getuid()) || fs.readdirSync(cwd).length !== 0) return fail();
}

export function sshStockCliArgs(selection: SshEntrySelection, profile: SshProjectBootstrap): string[] {
	const bootstrap = Buffer.from(JSON.stringify({ selection, profile })).toString("base64url");
	if (bootstrap.length > 16384) return fail();
	return [...SSH_ISOLATION_ARGS, ...selection.extensions.flatMap(file => ["-e", file]), "-e", SSH_ENTRY, `${SSH_BOOTSTRAP_FLAG}${bootstrap}`,
		...(selection.provider ? ["--provider", selection.provider] : []), ...(selection.model ? ["--model", selection.model] : []), ...(selection.mode ? ["--mode", selection.mode] : []), ...(selection.offline ? ["--offline"] : []), ...(selection.prompt ? ["--", selection.prompt] : [])];
}

export function consumeSshStockCliArgs(args: string[]): { selection: SshEntrySelection; profile: SshProjectBootstrap } {
	const values = args.filter(arg => arg.startsWith(SSH_BOOTSTRAP_FLAG));
	if (values.length !== 1) return fail();
	const value = values[0]!.slice(SSH_BOOTSTRAP_FLAG.length);
	if (!value || value.length > 16384 || !/^[A-Za-z0-9_-]+$/u.test(value)) return fail();
	try {
		const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
		// Re-run the small launcher grammar rather than trusting decoded JSON fields.
		const selection = decoded.selection as SshEntrySelection;
		const parsed = parseSshEntrySelection(["--target", selection.target, "--project", selection.project, "--agent", selection.agent,
			...selection.extensions.flatMap(file => ["--extension", file]), ...selection.skills.flatMap(file => ["--skill", file]),
			...(selection.provider ? ["--provider", selection.provider] : []), ...(selection.model ? ["--model", selection.model] : []), ...(selection.mode ? ["--mode", selection.mode] : []), ...(selection.offline ? ["--offline"] : []), ...(selection.prompt ? ["--prompt", selection.prompt] : [])]);
		const validated = validateSshEntrySelection(parsed, process.cwd(), localAgentDir());
		if (JSON.stringify(args) !== JSON.stringify(sshStockCliArgs(validated.selection, validated.profile))) return fail();
		assertCleanSshControl(validated.profile.localRuntime.cwd);
		return validated;
	} catch { return fail(); }
}

export function readSelectedMarkdown(file: string): Readonly<{ path: string; content: string }> {
	const fd = fs.openSync(file, "r");
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > 64 * 1024) return fail();
		const bytes = Buffer.alloc(64 * 1024 + 1);
		let count = 0;
		while (count < bytes.length) {
			const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
			if (read === 0) break;
			count += read;
		}
		if (count > 64 * 1024) return fail();
		return Object.freeze({ path: file, content: new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count)).replace(/^\uFEFF/u, "") });
	} finally { fs.closeSync(fd); }
}
