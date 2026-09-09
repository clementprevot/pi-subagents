import { spawnSync } from "node:child_process";
import type { ProcessTreeTerminal } from "../../shared/types.ts";

const DEFAULT_TERM_GRACE_MS = 3000;
const DEFAULT_KILL_VERIFY_MS = 1000;
const VERIFY_INTERVAL_MS = 25;

type SignalResult = "sent" | "absent" | { diagnostic: string };
type ProcessRow = { pid: number; ppid: number; pgid: number; stat: string };

function diagnostic(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function signalProcess(id: number, signal: NodeJS.Signals): SignalResult {
	try {
		process.kill(id, signal);
		return "sent";
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return "absent";
		return { diagnostic: diagnostic(error) };
	}
}

function readProcessTable(): ProcessRow[] | { diagnostic: string } {
	const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat="], { encoding: "utf-8" });
	if (result.error || result.status !== 0) {
		return { diagnostic: result.error ? diagnostic(result.error) : (result.stderr.trim() || `ps exited with ${result.status}`) };
	}
	const rows: ProcessRow[] = [];
	for (const line of result.stdout.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
		if (!match) continue;
		rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), stat: match[4]! });
	}
	return rows;
}

function childrenByParent(rows: ProcessRow[]): Map<number, ProcessRow[]> {
	const children = new Map<number, ProcessRow[]>();
	for (const row of rows) {
		if (row.stat.startsWith("Z")) continue;
		const siblings = children.get(row.ppid);
		if (siblings) siblings.push(row);
		else children.set(row.ppid, [row]);
	}
	return children;
}

function walkDescendants(rootPid: number, children: Map<number, ProcessRow[]>): ProcessRow[] {
	const descendants: ProcessRow[] = [];
	const seen = new Set<number>([rootPid]);
	const queue = [rootPid];
	for (let index = 0; index < queue.length; index++) {
		for (const child of children.get(queue[index]!) ?? []) {
			if (seen.has(child.pid)) continue;
			seen.add(child.pid);
			descendants.push(child);
			queue.push(child.pid);
		}
	}
	return descendants;
}

function activeProcessGroupMembers(rows: ProcessRow[], processGroupId: number): number[] {
	const members: number[] = [];
	for (const row of rows) {
		if (row.pgid !== processGroupId || row.stat.startsWith("Z")) continue;
		members.push(row.pid);
	}
	return members;
}

function recordDetachedDescendants(rows: ProcessRow[], rootPid: number, processGroupId: number, detached: Set<number>): void {
	const children = childrenByParent(rows);
	for (const origin of [rootPid, ...detached]) {
		for (const descendant of walkDescendants(origin, children)) {
			if (descendant.pgid !== processGroupId) detached.add(descendant.pid);
		}
	}
	const active = new Set(rows.filter((row) => !row.stat.startsWith("Z")).map((row) => row.pid));
	for (const pid of [...detached]) {
		if (!active.has(pid)) detached.delete(pid);
	}
}

async function waitUntilGroupTerminal(
	processGroupId: number,
	timeoutMs: number,
	observe: (rows: ProcessRow[]) => void,
): Promise<false | { state: "enumeration-failed" | "still-active"; diagnostic: string }> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const rows = readProcessTable();
		if (Array.isArray(rows)) {
			observe(rows);
			const members = activeProcessGroupMembers(rows, processGroupId);
			if (members.length === 0) return false;
			const remaining = deadline - Date.now();
			if (remaining <= 0) {
				return { state: "still-active", diagnostic: `Process group ${processGroupId} still has active members: ${members.join(", ")}.` };
			}
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(VERIFY_INTERVAL_MS, remaining)));
			continue;
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) return { state: "enumeration-failed", diagnostic: rows.diagnostic };
		await new Promise<void>((resolve) => setTimeout(resolve, Math.min(VERIFY_INTERVAL_MS, remaining)));
	}
}

function observed(processGroupId: number): ProcessTreeTerminal {
	return { state: "observed", mechanism: "posix-process-group", processGroupId, verifiedAt: Date.now() };
}

function proveObserved(processGroupId: number, rootPid: number, detached: Set<number>): ProcessTreeTerminal {
	const rows = readProcessTable();
	if (Array.isArray(rows)) recordDetachedDescendants(rows, rootPid, processGroupId, detached);
	const live = [...detached];
	if (live.length > 0) {
		return { state: "unknown", reason: "verification-failed", diagnostic: `Owned detached descendant(s) still active: ${live.join(", ")}.` };
	}
	return observed(processGroupId);
}

/** Owns one writer process group and arbitrates its cleanup exactly once. */
export interface OwnedProcessTreeController {
	terminate(): Promise<ProcessTreeTerminal>;
	finishAfterWriterClose(): Promise<ProcessTreeTerminal>;
}

export function createOwnedProcessTreeController(
	pid: number,
	options: { termGraceMs?: number; killVerifyMs?: number } = {},
): OwnedProcessTreeController {
	let termination: Promise<ProcessTreeTerminal> | undefined;
	const posixGroupOwned = process.platform !== "win32";
	const target = posixGroupOwned ? -pid : pid;

	const terminate = (): Promise<ProcessTreeTerminal> => {
		if (termination) return termination;
		termination = (async () => {
			if (!posixGroupOwned) {
				signalProcess(target, "SIGTERM");
				return { state: "unknown", reason: "unsupported-platform" };
			}
			const detached = new Set<number>();
			const observe = (rows: ProcessRow[]) => recordDetachedDescendants(rows, pid, pid, detached);
			const snapshot = readProcessTable();
			if (Array.isArray(snapshot)) observe(snapshot);
			const term = signalProcess(target, "SIGTERM");
			if (term !== "sent" && term !== "absent") {
				return { state: "unknown", reason: "signal-failed", diagnostic: term.diagnostic };
			}
			const termExit = await waitUntilGroupTerminal(pid, options.termGraceMs ?? DEFAULT_TERM_GRACE_MS, observe);
			if (termExit === false) return proveObserved(pid, pid, detached);

			const kill = signalProcess(target, "SIGKILL");
			if (kill !== "sent" && kill !== "absent") {
				const rows = readProcessTable();
				if (!Array.isArray(rows) || activeProcessGroupMembers(rows, pid).length > 0) {
					return { state: "unknown", reason: "signal-failed", diagnostic: kill.diagnostic };
				}
				observe(rows);
			}
			const killExit = await waitUntilGroupTerminal(pid, options.killVerifyMs ?? DEFAULT_KILL_VERIFY_MS, observe);
			if (killExit !== false) {
				return { state: "unknown", reason: "verification-failed", diagnostic: killExit.diagnostic };
			}
			return proveObserved(pid, pid, detached);
		})();
		return termination;
	};

	return { terminate, finishAfterWriterClose: terminate };
}
