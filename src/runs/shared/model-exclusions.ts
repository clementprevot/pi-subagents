import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { splitKnownThinkingSuffix } from "../../shared/model-info.ts";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";
import { getAgentDir } from "../../shared/utils.ts";

export const EXCLUSIONS_PATH_ENV = "PI_MODEL_EXCLUSIONS_PATH";

type ModelExclusionTarget = { modelId: string; provider?: string } | { provider: string; modelId?: never };

export type ModelExclusion = ModelExclusionTarget & {
	reason?: string;
	recordedAt: number;
	expiresAt: number;
};

export interface ModelRecoveryProbe {
	candidate: string;
	exclusion: Readonly<ModelExclusion>;
}

export interface ClaimedModelRecoveryProbe extends ModelRecoveryProbe {
	owner: string;
}

export type ModelRecoveryProbeClaim =
	| { status: "claimed"; probe: ClaimedModelRecoveryProbe }
	| { status: "in-flight" }
	| { status: "not-eligible" };

type RecordModelFailureOptions = ModelExclusionTarget & {
	reason?: string;
	ttlMs?: number;
};

let exclusions: ModelExclusion[] = [];
let loaded = false;
/** Default duration for a new model exclusion when no per-record TTL is supplied. */
export const DEFAULT_MODEL_EXCLUSION_TTL_MS = 24 * 60 * 60_000;
/** Keeps a new expiry safely below JavaScript's maximum Date timestamp. */
export const MAX_MODEL_EXCLUSION_TTL_MS = 8_000_000_000_000_000;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
let defaultTTLMs = DEFAULT_MODEL_EXCLUSION_TTL_MS;
let loadedTTLCeilingMs: number | undefined;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistSeq = 0;

const AUTH_FAILURE_PATTERNS = [
	/auth(?:entication)?/i,
	/unauthori[sz]ed/i,
	/forbidden/i,
	/api key/i,
	/token expired/i,
	/invalid key/i,
];

function isAuthModelExclusion(entry: ModelExclusion): boolean {
	const reason = entry.reason;
	return typeof reason === "string" && AUTH_FAILURE_PATTERNS.some((pattern) => pattern.test(reason));
}

function getAuthStoreMtimeMs(): number | undefined {
	const authStorePath = path.join(getAgentDir(), "auth.json");
	try {
		const stats = fs.statSync(authStorePath);
		return stats.isFile() && Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`[model-exclusions] Failed to stat Pi auth store at ${authStorePath}; preserving auth-related exclusions:`, error);
		}
		return undefined;
	}
}

function invalidateAuthExclusions(): void {
	if (!exclusions.some(isAuthModelExclusion)) return;
	const authStoreMtimeMs = getAuthStoreMtimeMs();
	if (authStoreMtimeMs === undefined) return;
	const retained = exclusions.filter((entry) => !isAuthModelExclusion(entry) || authStoreMtimeMs <= entry.recordedAt);
	if (retained.length === exclusions.length) return;
	exclusions = retained;
	schedulePersist();
}

/**
 * Override the default TTL applied to newly recorded model exclusions.
 *
 * @param ms Duration in milliseconds. Must be finite and positive.
 * @returns Nothing.
 */
// TEST:test/unit/model-exclusions.test.ts[model exclusions — TTL expiry]
export function setDefaultTTL(ms: number, options?: { shortenExisting?: boolean }): void {
	if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_MODEL_EXCLUSION_TTL_MS) {
		throw new Error(`Default model exclusion TTL must be a finite positive number no greater than ${MAX_MODEL_EXCLUSION_TTL_MS}.`);
	}
	defaultTTLMs = ms;
	loadedTTLCeilingMs = options?.shortenExisting ? ms : undefined;
	if (loaded && loadedTTLCeilingMs !== undefined && shortenExclusionsToTTL(exclusions, loadedTTLCeilingMs, Date.now())) schedulePersist();
}

/**
 * Resolve the persistence path. Honors PI_MODEL_EXCLUSIONS_PATH; defaults to
 * <TEMP_ROOT_DIR>/model-exclusions.json. Resolved lazily so tests can point the
 * store at an isolated location after module load.
 */
export function getExclusionsFilePath(): string {
	const envPath = process.env[EXCLUSIONS_PATH_ENV];
	if (typeof envPath === "string" && envPath.trim()) return envPath.trim();
	return path.join(TEMP_ROOT_DIR, "model-exclusions.json");
}

/**
 * Persist exclusions to disk immediately (atomic write via tmp + rename).
 * The store otherwise debounces writes; call this when durability matters
 * (and in tests).
 */
export function flushPersist(): void {
	const file = getExclusionsFilePath();
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmpPath = `${file}.${process.pid}.${persistSeq++}.tmp`;
		fs.writeFileSync(tmpPath, JSON.stringify({
			version: 1,
			exclusions: deduplicate(exclusions),
		}, null, 2), "utf-8");
		fs.renameSync(tmpPath, file);
	} catch (error) {
		console.error(`[model-exclusions] Failed to persist exclusions to ${file}:`, error);
	}
}

function schedulePersist(): void {
	if (persistTimer) clearTimeout(persistTimer);
	persistTimer = setTimeout(() => {
		persistTimer = null;
		flushPersist();
	}, 5000);
	// Never hold the process open just to flush exclusions.
	persistTimer.unref?.();
}

function ensureLoaded(): void {
	if (loaded) return;
	loaded = true;
	try {
		const raw = fs.readFileSync(getExclusionsFilePath(), "utf-8");
		const data = JSON.parse(raw);
		if (data.version === 1) {
			if (!Array.isArray(data.exclusions)) throw new Error("Model exclusion store version 1 must contain an exclusions array.");
			const now = Date.now();
			let droppedInvalid = false;
			exclusions = data.exclusions.flatMap((entry: unknown, index: number) => {
				const result = readPersistedExclusion(entry, index);
				if (!result.ok) {
					droppedInvalid = true;
					console.warn(`[model-exclusions] Ignoring invalid exclusion: ${result.message}`);
					return [];
				}
				return [result.exclusion];
			}).filter((e: ModelExclusion) => e.expiresAt > now);
			const shortened = loadedTTLCeilingMs !== undefined && shortenExclusionsToTTL(exclusions, loadedTTLCeilingMs, now);
			exclusions = deduplicate(exclusions);
			if (droppedInvalid) flushPersist();
			else if (shortened) schedulePersist();
		}
		invalidateAuthExclusions();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`[model-exclusions] Failed to load exclusions from ${getExclusionsFilePath()}:`, error);
		}
	}
}

type PersistedExclusionRead =
	| { ok: true; exclusion: ModelExclusion }
	| { ok: false; message: string };

function invalidPersistedExclusion(index: number, message: string): PersistedExclusionRead {
	return { ok: false, message: `Model exclusion store entry ${index} ${message}.` };
}

function readPersistedExclusion(entry: unknown, index: number): PersistedExclusionRead {
	if (!entry || typeof entry !== "object" || Array.isArray(entry)) return invalidPersistedExclusion(index, "must be an object");
	const candidate = entry as { modelId?: unknown; provider?: unknown; reason?: unknown; recordedAt?: unknown; expiresAt?: unknown };
	const { modelId, provider, reason } = candidate;
	if (modelId !== undefined && (typeof modelId !== "string" || modelId.length === 0)) return invalidPersistedExclusion(index, "has an invalid modelId");
	if (provider !== undefined && (typeof provider !== "string" || provider.length === 0)) return invalidPersistedExclusion(index, "has an invalid provider");
	if (reason !== undefined && typeof reason !== "string") return invalidPersistedExclusion(index, "has an invalid reason");
	const { recordedAt, expiresAt } = candidate;
	if (typeof recordedAt !== "number" || !Number.isFinite(recordedAt) || recordedAt <= 0 || recordedAt > MAX_DATE_TIMESTAMP_MS) return invalidPersistedExclusion(index, "has an invalid recordedAt");
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= 0 || expiresAt > MAX_DATE_TIMESTAMP_MS) return invalidPersistedExclusion(index, "has an invalid expiresAt");
	const metadata = { ...(reason === undefined ? {} : { reason }), recordedAt, expiresAt };
	if (modelId === undefined) {
		if (provider === undefined) return invalidPersistedExclusion(index, "must include modelId or provider");
		return { ok: true, exclusion: { provider, ...metadata } };
	}
	return { ok: true, exclusion: { modelId, ...(provider === undefined ? {} : { provider }), ...metadata } };
}

function dedupKey(entry: ModelExclusion): string {
	return `${entry.provider ?? ""}|${entry.modelId ?? ""}`;
}

function deduplicate(items: ModelExclusion[]): ModelExclusion[] {
	const map = new Map<string, ModelExclusion>();
	for (const entry of items) {
		const key = dedupKey(entry);
		const existing = map.get(key);
		if (!existing || entry.recordedAt > existing.recordedAt) {
			map.set(key, entry);
		}
	}
	return Array.from(map.values());
}

/**
 * Record a model failure as a temporary exclusion. While the exclusion is
 * active, {@link isExcluded} returns true for the model (or for every model of
 * the provider when modelId is omitted), and {@link filterFallbackCandidates}
 * removes matching candidates from fallback lists.
 */
export function recordModelFailure(options: RecordModelFailureOptions): void {
	ensureLoaded();
	const ttl = options.ttlMs ?? defaultTTLMs;
	const now = Date.now();
	const target: ModelExclusionTarget = options.modelId !== undefined
		? { modelId: options.modelId, ...(options.provider ? { provider: options.provider } : {}) }
		: { provider: options.provider };
	const exclusion: ModelExclusion = {
		...target,
		reason: options.reason ?? "runtime-failure",
		recordedAt: now,
		expiresAt: now + ttl,
	};
	if (!applyExclusionStoreUpdate((current) => {
		if (loadedTTLCeilingMs !== undefined) shortenExclusionsToTTL(current, loadedTTLCeilingMs, now);
		const next = deduplicate([exclusion, ...current]);
		if (next.length > 200) next.length = 200;
		return next;
	})) {
		console.error(`[model-exclusions] Failed to persist a recorded exclusion for ${options.modelId ?? options.provider}.`);
	}
}

/**
 * Drop all expired exclusions from memory and schedule a persist.
 */
export function clearExpiredExclusions(): void {
	ensureLoaded();
	invalidateAuthExclusions();
	prune(exclusions, Date.now());
	schedulePersist();
}

/**
 * Remove every exclusion (e.g. after the operator fixes credentials).
 */
export function clearExclusions(): void {
	ensureLoaded();
	exclusions.length = 0;
	schedulePersist();
}

/**
 * Whether an exclusion entry matches a candidate.
 *
 * Semantics:
 * - Entry with modelId: model-specific exclusion. Matches only that modelId;
 *   when both the entry and the candidate carry a provider, the providers must
 *   also agree so `openai/gpt-4` does not exclude `github-copilot/gpt-4`.
 * - Entry without modelId: provider-wide exclusion (e.g. quota or auth failure).
 *   Matches every model of that provider.
 */
function entryMatches(entry: ModelExclusion, candidateModelId: string, candidateProvider: string | undefined, now: number): boolean {
	if (entry.expiresAt <= now) return false;
	if (entry.modelId !== undefined) {
		if (entry.modelId !== candidateModelId) return false;
		return !entry.provider || !candidateProvider || entry.provider === candidateProvider;
	}
	return Boolean(entry.provider) && entry.provider === candidateProvider;
}

/**
 * Whether a model (or its provider) is currently excluded.
 */
export function isExcluded(modelId: string, provider: string): boolean {
	ensureLoaded();
	invalidateAuthExclusions();
	return exclusions.some((entry) => entryMatches(entry, modelId, provider, Date.now()));
}

/**
 * Return the active exclusion matching a full model id, if any.
 *
 * The caller uses this for hard-fail diagnostics; fallback filtering should
 * continue to use {@link filterFallbackCandidates}.
 */
export function findModelExclusion(fullId: string, now = Date.now()): Readonly<ModelExclusion> | undefined {
	ensureLoaded();
	invalidateAuthExclusions();
	const { provider, modelId } = parseModelKey(fullId);
	return exclusions.find((entry) => entryMatches(entry, modelId, provider, now));
}

const NON_RECOVERABLE_PROBE_REASON_PATTERNS = [
	...AUTH_FAILURE_PATTERNS,
	/\b(?:401|402|403|429)\b/,
	/rate\s*limit/i,
	/request[_\s-]*limit/i,
	/quota/i,
	/billing/i,
	/credit/i,
	/model.*not found/i,
	/unknown model/i,
	/model.*disabled/i,
	/\b(?:bad[ _]request|invalid[ _]argument|invalid_request_error|invalid request|request validation|malformed payload|invalid config(?:uration)?)\b/i,
	/\b(?:permission denied|access denied)\b/i,
];
const RECOVERABLE_PROBE_REASON_PATTERNS = [
	/fetch failed/i,
	/\b(?:connection|network|socket)\b.*\b(?:error|reset|closed|refused|abort(?:ed)?)\b/i,
	/socket hang up/i,
	/stream.*(?:abort|ended|closed|reset)/i,
	/\b(?:timed?\s*out|timeout)\b/i,
	/overload(?:ed)?/i,
	/service\s+(?:temporarily\s+)?unavailable/i,
	/temporar(?:ily)? unavailable/i,
	/provider\s+(?:temporarily\s+)?unavailable/i,
	/\bupstream\s+(?:error|timeout|unavailable|overload(?:ed)?|5\d\d)\b/i,
	/\b(?:500|502|503|504|5xx)\b/i,
	/internal server error/i,
	/cold.?start/i,
	/empty response/i,
	/produced no output/i,
];

/** True only for transport/provider-availability exclusions safe to re-probe. */
export function isReprobeEligibleTransientReason(reason: string | undefined): boolean {
	if (!reason) return false;
	return !NON_RECOVERABLE_PROBE_REASON_PATTERNS.some((pattern) => pattern.test(reason))
		&& RECOVERABLE_PROBE_REASON_PATTERNS.some((pattern) => pattern.test(reason));
}

/**
 * Plan one probe only when every supplied candidate is cache-excluded solely
 * for a re-probe-eligible transient reason. Side-effect free.
 */
export function planTransientModelRecoveryProbe(candidates: readonly string[]): ModelRecoveryProbe | undefined {
	if (candidates.length === 0) return undefined;
	const matches = candidates.map((candidate) => ({ candidate, exclusion: findModelExclusion(candidate) }));
	if (!matches.every((match) => match.exclusion && isReprobeEligibleTransientReason(match.exclusion.reason))) return undefined;
	const first = matches[0]!;
	return { candidate: first.candidate, exclusion: first.exclusion! };
}

const PROBE_CLAIM_TTL_MS = 30 * 60_000;

type StoredProbeClaim = { owner: string; pid: number; expiresAt: number };

function recoveryClaimPath(candidate: string): string {
	return `${getExclusionsFilePath()}.recovery-probe.${Buffer.from(candidate).toString("base64url")}.json`;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

type ProbeClaimSnapshot = {
	raw: string;
	ino: number;
	size: number;
	mtimeMs: number;
	claim: StoredProbeClaim | undefined;
};

function parseStoredProbeClaim(raw: string): StoredProbeClaim | undefined {
	try {
		const value = JSON.parse(raw) as Partial<StoredProbeClaim>;
		if (typeof value.owner !== "string" || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid) || value.pid <= 0) return undefined;
		if (typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return undefined;
		return { owner: value.owner, pid: value.pid, expiresAt: value.expiresAt };
	} catch {
		return undefined;
	}
}

function readProbeClaimSnapshot(claimPath: string): ProbeClaimSnapshot | "unreadable" | undefined {
	let raw: string;
	let stat: fs.Stats;
	try {
		stat = fs.statSync(claimPath);
		raw = fs.readFileSync(claimPath, "utf-8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unreadable";
	}
	return { raw, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, claim: parseStoredProbeClaim(raw) };
}

function unlinkObservedProbeClaim(claimPath: string, observed: ProbeClaimSnapshot): boolean {
	try {
		const current = fs.statSync(claimPath);
		if (observed.ino !== 0 && current.ino !== observed.ino) return false;
		if (current.size !== observed.size) return false;
		if (fs.readFileSync(claimPath, "utf-8") !== observed.raw) return false;
		fs.rmSync(claimPath);
		return true;
	} catch {
		return false;
	}
}

function tryCreateProbeClaim(claimPath: string, owner: string): boolean {
	let fd: number;
	try {
		fd = fs.openSync(claimPath, "wx", 0o600);
	} catch {
		return false;
	}
	try {
		fs.writeFileSync(fd, JSON.stringify({
			version: 1,
			owner,
			pid: process.pid,
			expiresAt: Date.now() + PROBE_CLAIM_TTL_MS,
		}), "utf-8");
		fs.fsyncSync(fd);
		return true;
	} catch {
		try { fs.rmSync(claimPath, { force: true }); } catch { /* leave a broken file for the next reclaim */ }
		return false;
	} finally {
		try { fs.closeSync(fd); } catch { /* already closed or never writable */ }
	}
}

/**
 * Exclusive recovery election for one candidate.
 *
 * A claim file is required because the exclusion store is a shared cache, not a
 * lock. Foreground and detached runners can both observe "every candidate is
 * transiently excluded" and would each send a real provider request. One
 * O_EXCL/`wx` file next to the store is the existing exclusive-create primitive
 * (steering and schedule claims). Live PIDs block; dead or malformed files are
 * reclaimed. No successor chain or /proc identity.
 */
export function claimTransientModelRecoveryProbe(candidate: string | undefined): ModelRecoveryProbeClaim {
	if (!candidate) return { status: "not-eligible" };
	const planned = planTransientModelRecoveryProbe([candidate]);
	if (!planned) return { status: "not-eligible" };
	const claimPath = recoveryClaimPath(candidate);
	const owner = `${process.pid}-${randomUUID()}`;
	try {
		fs.mkdirSync(path.dirname(claimPath), { recursive: true, mode: 0o700 });
	} catch {
		return { status: "in-flight" };
	}
	if (tryCreateProbeClaim(claimPath, owner)) return { status: "claimed", probe: { ...planned, owner } };
	const existing = readProbeClaimSnapshot(claimPath);
	if (existing === "unreadable") return { status: "in-flight" };
	if (existing?.claim && processIsAlive(existing.claim.pid)) return { status: "in-flight" };
	if (existing && !unlinkObservedProbeClaim(claimPath, existing)) {
		const replacement = readProbeClaimSnapshot(claimPath);
		if (replacement === "unreadable" || (replacement?.claim && processIsAlive(replacement.claim.pid))) return { status: "in-flight" };
		if (replacement) return { status: "in-flight" };
	}
	if (tryCreateProbeClaim(claimPath, owner)) return { status: "claimed", probe: { ...planned, owner } };
	return { status: "in-flight" };
}

/** Claim only the launch-planned recovery candidate, never a later fallback or abort-resume. */
export function claimLaunchTransientRecoveryProbe(
	candidates: readonly (string | undefined)[],
	candidate: string | undefined,
	options?: { recovering?: boolean },
): ModelRecoveryProbeClaim {
	if (options?.recovering || !candidate) return { status: "not-eligible" };
	const planned = planTransientModelRecoveryProbe(candidates.filter((entry): entry is string => Boolean(entry)));
	if (!planned || planned.candidate !== candidate) return { status: "not-eligible" };
	return claimTransientModelRecoveryProbe(candidate);
}

function sameRecordedExclusion(left: Readonly<ModelExclusion>, right: Readonly<ModelExclusion>): boolean {
	return left.provider === right.provider
		&& left.modelId === right.modelId
		&& left.recordedAt === right.recordedAt
		&& left.expiresAt === right.expiresAt
		&& left.reason === right.reason;
}

function readPersistedExclusionsSnapshot(): { raw: string | undefined; entries: ModelExclusion[] } {
	try {
		const raw = fs.readFileSync(getExclusionsFilePath(), "utf-8");
		const data = JSON.parse(raw) as { version?: unknown; exclusions?: unknown };
		if (data.version !== 1 || !Array.isArray(data.exclusions)) return { raw, entries: [] };
		const now = Date.now();
		return {
			raw,
			entries: deduplicate(data.exclusions.flatMap((entry, index) => {
				const parsed = readPersistedExclusion(entry, index);
				return parsed.ok && parsed.exclusion.expiresAt > now ? [parsed.exclusion] : [];
			})),
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { raw: undefined, entries: [] };
		return { raw: undefined, entries: [] };
	}
}

function writeExclusionsIfUnchanged(expectedRaw: string | undefined, next: ModelExclusion[]): boolean {
	const file = getExclusionsFilePath();
	fs.mkdirSync(path.dirname(file), { recursive: true });
	let current: string | undefined;
	try {
		current = fs.readFileSync(file, "utf-8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
		current = undefined;
	}
	if (current !== expectedRaw) return false;
	const tmpPath = `${file}.${process.pid}.${persistSeq++}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, exclusions: deduplicate(next) }, null, 2), "utf-8");
	fs.renameSync(tmpPath, file);
	return true;
}

function applyExclusionStoreUpdate(mutator: (current: ModelExclusion[]) => ModelExclusion[]): boolean {
	for (let attempt = 0; attempt < 8; attempt++) {
		try {
			const snapshot = readPersistedExclusionsSnapshot();
			const next = mutator(snapshot.entries);
			if (writeExclusionsIfUnchanged(snapshot.raw, next)) {
				exclusions = next;
				loaded = true;
				return true;
			}
		} catch {
			// Retry a raced or transient filesystem write; callers decide whether to surface failure.
		}
	}
	return false;
}

function clearRecoveredTransientExclusion(probe: ClaimedModelRecoveryProbe): void {
	const { provider, modelId } = parseModelKey(probe.candidate);
	if (!applyExclusionStoreUpdate((current) => current.filter((entry) => !(
		sameRecordedExclusion(entry, probe.exclusion)
		&& entryMatches(entry, modelId, provider, Date.now())
		&& isReprobeEligibleTransientReason(entry.reason)
	)))) {
		throw new Error("Unable to clear the recovered exclusion without clobbering a concurrent store update.");
	}
}

function releaseProbeClaim(probe: ClaimedModelRecoveryProbe): void {
	const claimPath = recoveryClaimPath(probe.candidate);
	const existing = readProbeClaimSnapshot(claimPath);
	if (!existing || existing === "unreadable" || existing.claim?.owner !== probe.owner) return;
	try { fs.rmSync(claimPath); } catch { /* a leftover file is reclaimed when its PID dies */ }
}

/** Release ownership. Cleanup errors are swallowed so they cannot discard a finished child. */
export function releaseTransientModelRecoveryProbe(claim: ModelRecoveryProbeClaim, succeeded: boolean): void {
	if (claim.status !== "claimed") return;
	try {
		if (succeeded) clearRecoveredTransientExclusion(claim.probe);
	} catch (error) {
		console.error(`[model-exclusions] Failed to clear recovered exclusion for ${claim.probe.candidate}:`, error);
	} finally {
		try {
			releaseProbeClaim(claim.probe);
		} catch (error) {
			console.error(`[model-exclusions] Failed to release recovery probe claim for ${claim.probe.candidate}:`, error);
		}
	}
}

/**
 * Number of live (non-expired) exclusions.
 */
export function getExcludedCount(): number {
	ensureLoaded();
	clearExpiredExclusions();
	return exclusions.length;
}

/**
 * Split a candidate fullId into its provider + modelId components.
 *
 * A fullId may carry a thinking suffix (`provider/model:thinking`) which is
 * stripped before parsing, and the modelId itself may contain slashes
 * (e.g. `openrouter/google/gemini-flash`). The first `/`-segment is the
 * provider; everything after is the modelId. This MUST stay in lock-step with
 * the matching inside {@link isExcluded} so that a failure recorded via
 * {@link recordModelFailure} is later recognised by the candidate filter.
 */
export function parseModelKey(fullId: string): { provider?: string; modelId: string } {
	const base = splitKnownThinkingSuffix(fullId).baseModel;
	if (!base.includes("/")) return { modelId: base };
	const slash = base.indexOf("/");
	return { provider: base.slice(0, slash), modelId: base.slice(slash + 1) };
}

/**
 * Filter a list of candidate fullIds, removing excluded models/providers and
 * duplicates while preserving order.
 */
export function filterFallbackCandidates(candidates: string[], opts?: {
	now?: number;
	onExcluded?: (candidate: string, exclusion: Readonly<ModelExclusion>) => void;
	ignoreExclusion?: (candidate: string, exclusion: Readonly<ModelExclusion>) => boolean;
}): string[] {
	ensureLoaded();
	invalidateAuthExclusions();
	const timestamp = opts?.now ?? Date.now();
	const seen = new Set<string>();
	const filtered: string[] = [];
	for (const raw of candidates) {
		if (!raw || seen.has(raw)) continue;
		const { provider: candidateProvider, modelId: candidateModelId } = parseModelKey(raw);
		const exclusion = exclusions.find((entry) => entryMatches(entry, candidateModelId, candidateProvider, timestamp) && opts?.ignoreExclusion?.(raw, entry) !== true);
		if (exclusion) {
			opts?.onExcluded?.(raw, exclusion);
			continue;
		}
		seen.add(raw);
		filtered.push(raw);
	}
	return filtered;
}

/**
 * Reload exclusions from disk (for tests and config hot-reload).
 * Discards any in-memory-only exclusions that were not yet persisted.
 */
export function reloadFromDisk(): void {
	loaded = false;
	exclusions = [];
	ensureLoaded();
}

function prune(items: ModelExclusion[], now: number): void {
	let write = 0;
	for (let i = 0; i < items.length; i++) {
		const entry = items[i]!;
		if (entry.expiresAt > now) {
			items[write++] = entry;
		}
	}
	items.length = write;
}

function shortenExclusionsToTTL(items: ModelExclusion[], ttlMs: number, now: number): boolean {
	let changed = false;
	for (const entry of items) {
		const configuredExpiry = entry.recordedAt + ttlMs;
		if (entry.expiresAt > configuredExpiry) {
			entry.expiresAt = configuredExpiry;
			changed = true;
		}
	}
	const previousLength = items.length;
	prune(items, now);
	return changed || items.length !== previousLength;
}
