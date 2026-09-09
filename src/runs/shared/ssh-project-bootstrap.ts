import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** The owned startup host must establish these controls
 * before SDK resource loading; an extension cannot undo prior project discovery.
 * Selection is not admission: the executor validates effective child requests.
 */
export interface SshProjectBootstrap {
	readonly target: string;
	readonly projectDir: string;
	readonly localRuntime: {
		readonly cwd: string;
		readonly agentDir: string;
		readonly projectTrusted: false;
		readonly noContextFiles: true;
		readonly projectDiscovery: "disabled";
	};
	readonly childProfile: "fresh-native-read-bash";
	readonly extensions?: readonly string[];
	readonly globalContext?: string;
	readonly selectedDocuments?: {
		readonly agent: Readonly<{ path: string; content: string }>;
		readonly skills: readonly Readonly<{ path: string; content: string }>[];
	};
}

/** Validate and snapshot before parent registration (including watchdog construction). */
export function snapshotSshProjectBootstrap(input: SshProjectBootstrap): SshProjectBootstrap {
	const fail = (): never => { throw new Error("Unsupported SSH project bootstrap; isolated explicit local runtime and fresh-native-read-bash profile required."); };
	if (!input || typeof input !== "object") return fail();
	if (Object.keys(input).some(key => !["target", "projectDir", "localRuntime", "childProfile", "selectedDocuments", "extensions", "globalContext"].includes(key))) return fail();
	const { target, projectDir, localRuntime, childProfile } = input;
	if (typeof target !== "string" || target.length > 256 || !/^(?:[A-Za-z0-9_][A-Za-z0-9_.-]*@)?[A-Za-z0-9_][A-Za-z0-9_.-]*$/u.test(target)) return fail();
	if (typeof projectDir !== "string" || !projectDir.startsWith("/") || projectDir.length > 4096 || /[\u0000-\u001f\u007f]/u.test(projectDir)) return fail();
	if (!localRuntime || localRuntime.projectTrusted !== false || localRuntime.noContextFiles !== true || localRuntime.projectDiscovery !== "disabled" || childProfile !== "fresh-native-read-bash") return fail();
	if (Object.keys(localRuntime).some(key => !["cwd", "agentDir", "projectTrusted", "noContextFiles", "projectDiscovery"].includes(key))) return fail();
	for (const value of [localRuntime.cwd, localRuntime.agentDir]) {
		if (typeof value !== "string" || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) return fail();
	}
	const document = (value: Readonly<{ path: string; content: string }>) => {
		if (!value || typeof value.path !== "string" || !path.isAbsolute(value.path) || typeof value.content !== "string" || Buffer.byteLength(value.content) > 64 * 1024) return fail();
		return Object.freeze({ path: value.path, content: value.content });
	};
	const selectedDocuments = input.selectedDocuments === undefined ? undefined : Object.freeze({
		agent: document(input.selectedDocuments.agent), skills: Object.freeze(input.selectedDocuments.skills.map(document)),
	});
	if (input.extensions?.some(file => typeof file !== "string" || !path.isAbsolute(file)) || (input.globalContext !== undefined && (typeof input.globalContext !== "string" || Buffer.byteLength(input.globalContext) > 65536))) return fail();
	return Object.freeze({ target, projectDir, childProfile, ...(input.extensions ? { extensions: Object.freeze([...input.extensions]) } : {}), ...(input.globalContext !== undefined ? { globalContext: input.globalContext } : {}), ...(selectedDocuments ? { selectedDocuments } : {}), localRuntime: Object.freeze({
		cwd: path.resolve(localRuntime.cwd), agentDir: path.resolve(localRuntime.agentDir),
		projectTrusted: false as const, noContextFiles: true as const, projectDiscovery: "disabled" as const,
	}) });
}

/** One registration owns one actual session; no ambient/process-global target. */
export function createSshProjectSessionBinding(profile: SshProjectBootstrap) {
	let sessionId: string | undefined;
	let closed = false;
	return {
		bind(ctx: ExtensionContext): void {
			const id = ctx.sessionManager.getSessionId();
			if (closed || !id || (sessionId !== undefined && sessionId !== id) || path.resolve(ctx.cwd) !== profile.localRuntime.cwd) {
				throw new Error("SSH project bootstrap cannot bind a different local runtime or replacement session.");
			}
			sessionId = id;
		},
		assertLocalExecution(ctx: ExtensionContext): void {
			if (closed || !sessionId || sessionId !== ctx.sessionManager.getSessionId()) {
				throw new Error("SSH project session binding is unavailable; local delegation refused.");
			}
			if (!profile.selectedDocuments) throw new Error("SSH project child profile unavailable; local delegation refused.");
		},
		dispose(): void { closed = true; },
	};
}
