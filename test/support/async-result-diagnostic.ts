/** Failure-only, read-only projections. Never use these observations as cleanup authority. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { encodeIndexSegment } from "../../src/runs/background/index-segment.ts";

const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const known = (value: unknown, values: string[]) => typeof value === "string" && values.includes(value) ? value : undefined;
const state = (value: unknown) => known(value, ["pending", "running", "complete", "failed", "cancelled", "stopped", "paused", "partial", "observed", "unknown", "not-started"]);
const errorCode = (error: unknown) => known(record(error).code, ["ENOENT", "EACCES", "EPERM", "EBUSY", "EIO", "EMFILE", "ENFILE", "ENOSPC", "ENOTDIR"]) ?? "other";

export function captureAsyncResultTimeout(options: {
	id: string; asyncDir: string; resultsDir: string; waitStartedAt: number; deadline: number;
	phase?: "timeout" | "teardown";
	observer?: { pid?: number; marks: Record<string, number>; events: unknown[]; phases: unknown[] };
}) {
	const { id, asyncDir, resultsDir } = options;
	let runnerInstance: unknown;
	const project = (value: unknown) => {
		const raw = record(value);
		const instance = raw.runnerProcessInstanceId ?? record(raw.processTerminal).runnerProcessInstanceId;
		return {
			runMatches: (raw.runId ?? raw.id) === id,
			runnerMatches: runnerInstance === undefined || typeof instance !== "string" ? undefined : instance === runnerInstance,
			state: state(raw.state ?? raw.status), startedAt: number(raw.startedAt), endedAt: number(raw.endedAt),
			reason: known(raw.reason, ["runner-candidate-missing", "runner-instance-mismatch", "writer-close-unverified", "process-tree-unverified", "canonical-session-unavailable", "canonical-session-lease-active", "canonical-session-release-unverified", "proof-write-failed"]),
			lastUpdate: number(raw.lastUpdate), observedAt: number(raw.observedAt), pid: number(raw.pid),
			steps: Array.isArray(raw.steps) ? raw.steps.slice(0, 16).map((step) => state(record(step).status)) : undefined,
		};
	};
	const read = (file: string, kind: "json" | "events" | "metadata" = "json") => {
		const summary: Record<string, unknown> = { readAt: Date.now() };
		let data: Record<string, unknown> = {};
		try {
			// Opening a directory differs across Windows/POSIX; do not attempt a content read.
			const initial = fs.statSync(file);
			if (!initial.isFile()) return { summary: { ...summary, io: "not-file", size: initial.size, mtimeMs: initial.mtimeMs }, data };
			const fd = fs.openSync(file, "r");
			try {
				const stat = fs.fstatSync(fd);
				Object.assign(summary, { size: stat.size, mtimeMs: stat.mtimeMs });
				if (!stat.isFile()) summary.io = "not-file";
				else if (kind === "metadata") summary.io = "present";
				else if (kind === "json" && stat.size > 65_536) summary.io = "oversized";
				else {
					const limit = kind === "events" ? 8192 : 65_536;
					const offset = Math.max(0, stat.size - limit);
					const buffer = Buffer.alloc(Math.min(stat.size, limit));
					const bytes = fs.readSync(fd, buffer, 0, buffer.length, offset);
					const text = buffer.toString("utf8", 0, bytes);
					Object.assign(summary, { io: "readable", bytes, truncated: offset > 0 });
					if (kind === "json") {
						data = record(JSON.parse(text));
						Object.assign(summary, project(data));
					} else {
						const entries: unknown[] = [];
						for (const line of text.split("\n").slice(offset > 0 ? 1 : 0)) {
							try {
								const event = record(JSON.parse(line));
								const type = known(event.type, ["subagent.run.started", "subagent.run.completed", "subagent.run.process_terminal"]);
								if (type) entries.push({ type, ts: number(event.ts), ...project(event) });
							} catch { /* Partial or non-JSON lines carry no diagnostic authority. */ }
						}
						summary.entries = entries.slice(-16);
					}
				}
			} finally { fs.closeSync(fd); }
		} catch (error) {
			summary.io = error instanceof SyntaxError ? "invalid-json" : errorCode(error) === "ENOENT" ? "absent" : errorCode(error);
		}
		return { summary, data };
	};
	const status = read(path.join(asyncDir, "status.json"));
	if (status.data.runId === id && typeof record(status.data.processTerminal).runnerProcessInstanceId === "string") {
		runnerInstance = record(status.data.processTerminal).runnerProcessInstanceId;
	}
	const sessionId = status.data.runId === id && typeof status.data.sessionId === "string" ? status.data.sessionId : undefined;
	const key = `${encodeIndexSegment(id, 250)}.json`;
	const files: Record<string, Record<string, unknown>> = {
		status: status.summary,
		public: read(path.join(resultsDir, `${id}.json`)).summary,
		pending: sessionId ? read(path.join(resultsDir, "result-pending", encodeIndexSegment(sessionId), key)).summary : { io: "session-unavailable" },
		sessionIndex: sessionId ? read(path.join(resultsDir, "result-index", "sessions", encodeIndexSegment(sessionId), key)).summary : { io: "session-unavailable" },
		runIndex: read(path.join(resultsDir, "result-index", "runs", key)).summary,
		proceed: read(path.join(asyncDir, "runner-startup-proceed.json"), "metadata").summary,
		candidate: read(path.join(asyncDir, "process-terminal-candidate.json")).summary,
		proof: read(path.join(asyncDir, "process-terminal.json")).summary,
		events: read(path.join(asyncDir, "events.jsonl"), "events").summary,
		stdout: read(path.join(asyncDir, "runner.stdout.log"), "metadata").summary,
		stderr: read(path.join(asyncDir, "runner.stderr.log"), "metadata").summary,
	};
	const observer = options.observer;
	const snapshot = {
		version: 1, phase: options.phase ?? "timeout", runKey: createHash("sha256").update(id).digest("hex"),
		snapshotAt: Date.now(), waitStartedAt: number(options.waitStartedAt), deadline: number(options.deadline),
		files,
		observer: observer ? {
			pid: number(observer.pid),
			marks: Object.fromEntries(["bodyStartedAt", "launchStartedAt", "launchFinishedAt", "resultWaitStartedAt", "resultDeadline", "resultTimeoutAt", "resultReadAt", "teardownStartedAt"].map((key) => [key, number(observer.marks[key])])),
			events: observer.events.slice(-8).map((value) => {
				const raw = record(value);
				return { type: known(raw.type, ["spawn", "error", "exit", "close"]), at: number(raw.at), code: number(raw.code), signal: known(raw.signal, ["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV"]) };
			}),
			phases: observer.phases.slice(-16).map((value) => {
				const raw = record(value);
				return { phase: known(raw.phase, ["dispose-entry", "dispose-return", "dispose-rejection", "exit", "exit-request", "exit-dispatch-return", "exit-dispatch-throw", "native-trace-exit"]), ts: number(raw.ts), pidMatches: raw.pid === observer.pid, invocation: number(raw.invocation), code: number(raw.code) };
			}),
		} : undefined,
	};
	// Artifact destination is outside isolated cleanup roots in CI. No unprojected fields leave this helper.
	try {
		const dir = process.env.PI_SUBAGENTS_TERMINAL_EVIDENCE_DIR;
		const text = JSON.stringify(snapshot);
		if (dir && Buffer.byteLength(text) <= 32_768) {
			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(path.join(dir, `async-result-${snapshot.runKey}-${snapshot.phase}.json`), text, { mode: 0o600 });
		}
	} catch { /* Diagnostic I/O must not replace the existing assertion or teardown result. */ }
	return snapshot;
}
