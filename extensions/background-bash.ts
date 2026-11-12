import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, appendFileSync, chmodSync, closeSync, constants as fsConstants, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentToolUpdateCallback, BashOperations, BashToolDetails, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { createPiPending, type PiPendingRegistry } from "pi-pending";
import { type TObject, Type } from "typebox";
import { type ChildExit, exitCodeFrom, JOB_EXIT_STDIO_GRACE_MS, waitForChildExit } from "../lib/child-exit.ts";
import { capBodyToPiWindow, formatLogFile, loadOutputFormatConfig, presentText } from "../lib/output-format.ts";
import { piContext } from "./pi-context-utils.ts";

const MAX_ACTIVE_JOBS = 10;
// pi's own truncation window (`truncate.ts`): completion bodies are capped the
// same way pi caps a tool result, so the extension keeps no numbers of its own.
const MAX_RESULT_LINES = DEFAULT_MAX_LINES;
const MAX_RESULT_BYTES = DEFAULT_MAX_BYTES;
const DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS = 30;
// A job's log stops growing at this many bytes (PLAN §6/§10): a runaway command
// must not be able to fill the disk. The cap is recorded in the job file, never
// written into the log itself (Decision 9: logs stay raw).
const DEFAULT_MAX_LOG_BYTES = 100 * 1024 * 1024;
// Job logs older than this are deleted at `session_start` (PLAN §6).
const JOB_LOG_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const CUSTOM_TYPE = "background_bash_result";
// How long a process group gets to honour SIGTERM before SIGKILL, on abort and
// on timeout.
const KILL_GRACE_MS = 500;
// pi's `MAX_TIMEOUT_MS` (`tools/bash.ts`), which bounds the `timeout` param.
const MAX_TIMEOUT_MS = 2_147_483_647;
// How much of a log's tail is read to rebuild a completion body. Four times
// pi's byte window, so tail truncation still has complete lines to keep.
const LOG_TAIL_MAX_BYTES = MAX_RESULT_BYTES * 4;
// Reconcile sweep: only completions this recent are re-delivered. Older ones are
// marked delivered with a reason so the sweep converges instead of re-messaging.
const RECONCILE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECONCILE_MAX_JOBS = 20;
const RECONCILE_LOG_TAIL_LINES = 8;

type Outcome = "running" | "exit" | "timeout" | "abort" | "error" | "lost";

type DigestJobSummary = {
	jobId: string;
	instanceId?: string;
	outcome: string;
	exitCode?: number | null;
	command: string;
	durationMs?: number;
	lost?: boolean;
};

type BackgroundBashDetails = BashToolDetails & {
	jobId: string;
	command: string;
	outcome: Outcome;
	exitCode: number | null;
	toolCallId?: string;
	startedAt?: string;
	durationMs?: number;
	body?: string;
	cwd?: string;
	sessionId?: string;
	sessionKey?: string;
	instanceId?: string;
	lane?: string;
	globalJobId?: string;
	pbbCursor?: number;
	/** Set on coalesced re-delivery messages produced by the reconcile sweep. */
	digest?: boolean;
	digestJobs?: DigestJobSummary[];
	digestSkipped?: number;
};

/** How a job ended, as the job layer records it (never a fabricated exit). */
type JobResult = {
	outcome: Exclude<Outcome, "running" | "lost">;
	exitCode: number | null;
};

type PbbIdentity = {
	sessionId?: string;
	sessionKey: string;
	sessionFile?: string;
	instanceId: string;
	lane?: string;
	laneRoot?: string;
	root: string;
};

type RepairableSessionManager = {
	getEntries?: () => unknown[];
	getSessionFile?: () => string | undefined;
	getSessionId?: () => string | undefined;
};

type RepairableSessionContext = {
	sessionManager?: RepairableSessionManager;
	isIdle?: () => boolean;
};

type ActiveJob = {
	id: string;
	session: SessionState;
	command: string;
	toolCallId: string;
	startedAt: number;
	cwd?: string;
	pbb?: PbbIdentity;
	/** Canonical full-output file; every chunk of the command is written here. */
	logPath?: string;
	/** Bytes the log holds (at most the configured `maxLogBytes`). */
	logBytes?: number;
	/** The log stopped at `maxLogBytes`; recorded here, never written into the log. */
	logTruncated?: boolean;
	/** The call crossed the threshold (or asked for `background: true`). */
	promoted?: boolean;
	/** Something asked this job to stop: `pbb kill` or session shutdown. */
	abortRequested?: boolean;
	timeoutSeconds?: number;
	/** Spawn error text, when the command never started. */
	errorMessage?: string;
	lastEventId?: number;
	child?: ChildProcess;
	pid?: number;
	pgid?: number;
	runner?: "pbb";
	killSignal?: NodeJS.Signals;
	repairContext?: RepairableSessionContext;
};

/**
 * Everything a single session owns. Pi caches the extension factory per cwd
 * (`loadExtensionsCached`), so one module instance serves every session in a pi
 * process — module-level job state would be shared across sessions, and any
 * sibling session's `session_shutdown` would then abort and silently drop another
 * session's completions. Keep per-session state here, created per factory call.
 */
type SessionState = {
	id: string;
	pi: ExtensionAPI;
	pending: PiPendingRegistry;
	identity?: PbbIdentity;
	activeJobs: Map<string, ActiveJob>;
	shuttingDown: boolean;
	jobNumberFloor: number;
	/**
	 * Weak handle on this session's session manager. pi-subagents runs child sessions
	 * in-process but tears them down with `AgentSession.dispose()`, which only
	 * invalidates the extension runner — no `session_shutdown` ever fires for them. A
	 * child's state therefore has to be pruned by liveness, or the registry grows with
	 * every subagent run.
	 */
	sessionRef?: WeakRef<object>;
};

type BackgroundBashConfig = {
	autoBackgroundAfterSeconds?: number;
	maxLogBytes?: number;
};

const JOB_ID_PREFIX = "bg";
const JOB_ID_WIDTH = 3;

// Process-global by design and deliberately minimal: the live session registry,
// the job-id allocator (ids must stay unique within one instance directory even
// when two sessions share it), and the single kill-request poller.
const liveSessions = new Set<SessionState>();
const jobNumberByDir = new Map<string, number>();
let fallbackJobNumber = 0;
let processHooksInstalled = false;
let killRequestTimer: ReturnType<typeof setInterval> | undefined;

function normalizeCommandForStatus(command: string): string {
	return command.replace(/\s+/g, " ").trim();
}

function formatJobId(n: number): string {
	return `${JOB_ID_PREFIX}${String(n).padStart(JOB_ID_WIDTH, "0")}`;
}

function parseJobNumber(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const match = value.match(/^bg(\d{3,})$/);
	return match ? Number(match[1]) : undefined;
}

function normalizeSignal(value: unknown): NodeJS.Signals {
	const raw = String(value || "TERM").toUpperCase().replace(/^SIG/, "");
	if (["TERM", "INT", "KILL", "HUP", "QUIT"].includes(raw)) return `SIG${raw}` as NodeJS.Signals;
	return "SIGTERM";
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function readConfigFile(path: string): BackgroundBashConfig {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		const raw = parsed as { autoBackgroundAfterSeconds?: unknown; maxLogBytes?: unknown };
		const config: BackgroundBashConfig = {};
		if (typeof raw.autoBackgroundAfterSeconds === "number" && Number.isFinite(raw.autoBackgroundAfterSeconds)) {
			config.autoBackgroundAfterSeconds = raw.autoBackgroundAfterSeconds;
		}
		// Only a positive, finite budget is a cap; anything else keeps the default.
		if (typeof raw.maxLogBytes === "number" && Number.isFinite(raw.maxLogBytes) && raw.maxLogBytes > 0) {
			config.maxLogBytes = raw.maxLogBytes;
		}
		return config;
	} catch {
		return {};
	}
}

function mergedConfig(cwd?: string): BackgroundBashConfig {
	const globalConfig = readConfigFile(join(homedir(), ".pi-background-bash", "config.json"));
	const projectConfig = cwd ? readConfigFile(join(cwd, ".pi", "background-bash.json")) : {};
	return { ...globalConfig, ...projectConfig };
}

function getAutoBackgroundAfterSeconds(cwd?: string): number {
	return mergedConfig(cwd).autoBackgroundAfterSeconds ?? DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS;
}

function getMaxLogBytes(cwd?: string): number {
	return mergedConfig(cwd).maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
}

function formatThreshold(seconds: number): string {
	return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
	if (!pid) return;
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Best effort: process may have already exited.
		}
	}
}

function stableSessionKey(sessionFile: string, sessionId?: string): string {
	return createHash("sha256").update(`${sessionId ?? "no-session-id"}\n${sessionFile}`).digest("hex").slice(0, 24);
}

function pbbRoot(): string {
	return process.env.PBB_ROOT || join(homedir(), ".pi", "pbb");
}

function pbbIdentity(ctx: RepairableSessionContext, sessionInstanceId: string): PbbIdentity | undefined {
	const ctxFile = ctx.sessionManager?.getSessionFile?.();
	const ctxId = ctx.sessionManager?.getSessionId?.();
	// PI_LANE_* are process-global: whichever session started last wrote them, so
	// they only describe THIS session when they name its session file. Otherwise
	// derive the key from the session manager — same hash pi-lane uses, so the
	// derived key stays consistent with what `pbb`/`pil` see.
	//
	// PBB_* are deliberately NOT read here: this extension writes them into the env
	// of every spawned command, so inheriting them would let a pi started from a pbb
	// job (or an old build's export) impersonate the session that spawned it.
	const envKey = process.env.PI_LANE_SESSION_KEY;
	const envFile = process.env.PI_LANE_SESSION_FILE;
	const envId = process.env.PI_LANE_SESSION_ID;
	const envNamesOtherSession = Boolean(ctxFile && envFile && ctxFile !== envFile);
	const envApplies = Boolean(envKey) && !envNamesOtherSession;
	const sessionFile = envNamesOtherSession ? ctxFile : (envFile ?? ctxFile);
	const sessionId = envNamesOtherSession ? ctxId : (envId ?? ctxId);
	const sessionKey = envApplies ? envKey : sessionFile ? stableSessionKey(sessionFile, sessionId) : envKey;
	if (!sessionKey) return undefined;
	return {
		sessionId,
		sessionKey,
		sessionFile,
		instanceId: process.env.PI_LANE_INSTANCE_ID || `pbb_${process.pid}_${sessionInstanceId}`,
		lane: process.env.PI_LANE_CURRENT_LANE,
		laneRoot: process.env.PI_LANE_ROOT,
		root: pbbRoot(),
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function entryParentId(entry: unknown): string | null | undefined {
	const record = asRecord(entry);
	const parentId = record?.parentId;
	return typeof parentId === "string" || parentId === null ? parentId : undefined;
}

function entryId(entry: unknown): string | undefined {
	const id = asRecord(entry)?.id;
	return typeof id === "string" ? id : undefined;
}

function entryHasToolCall(entry: unknown, toolCallId: string): boolean {
	const record = asRecord(entry);
	if (record?.type !== "message") return false;
	const message = asRecord(record.message);
	if (message?.role !== "assistant") return false;
	const content = Array.isArray(message.content) ? message.content : [];
	return content.some((part) => {
		const item = asRecord(part);
		return item?.type === "toolCall" && item.name === "bash" && item.id === toolCallId;
	});
}

function backgroundToolResultCallId(entry: unknown): string | undefined {
	const record = asRecord(entry);
	if (record?.type !== "message") return undefined;
	const message = asRecord(record.message);
	if (message?.role !== "toolResult" || message.toolName !== "bash") return undefined;
	const details = asRecord(message.details);
	if (typeof details?.jobId !== "string") return undefined;
	const detailToolCallId = details.toolCallId;
	if (typeof detailToolCallId === "string") return detailToolCallId;
	return typeof message.toolCallId === "string" ? message.toolCallId : undefined;
}

function parentChainHasToolCall(entry: unknown, byId: Map<string, unknown>, toolCallId: string): boolean {
	const seen = new Set<string>();
	let parentId = entryParentId(entry);
	while (parentId) {
		if (seen.has(parentId)) return false;
		seen.add(parentId);
		const parent = byId.get(parentId);
		if (!parent) return false;
		if (entryHasToolCall(parent, toolCallId)) return true;
		parentId = entryParentId(parent);
	}
	return false;
}

function findAssistantToolCallParent(entries: unknown[], beforeIndex: number, toolCallId: string): string | undefined {
	for (let i = beforeIndex - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entryHasToolCall(entry, toolCallId)) return entryId(entry);
	}
	return undefined;
}

function collectDetachedBackgroundToolResultRepairs(entries: unknown[], onlyToolCallId?: string): Map<string, string> {
	const byId = new Map<string, unknown>();
	for (const entry of entries) {
		const id = entryId(entry);
		if (id) byId.set(id, entry);
	}

	const repairs = new Map<string, string>();
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const id = entryId(entry);
		const toolCallId = backgroundToolResultCallId(entry);
		if (!id || !toolCallId || (onlyToolCallId && toolCallId !== onlyToolCallId)) continue;
		if (parentChainHasToolCall(entry, byId, toolCallId)) continue;
		const parentId = findAssistantToolCallParent(entries, i, toolCallId);
		if (parentId) repairs.set(id, parentId);
	}
	return repairs;
}

function rewriteSessionParentIds(sessionFile: string | undefined, repairs: Map<string, string>): void {
	if (!sessionFile || repairs.size === 0 || !existsSync(sessionFile)) return;
	try {
		const lines = readFileSync(sessionFile, "utf8").split("\n");
		let changed = false;
		const next = lines.map((line) => {
			if (!line.trim()) return line;
			try {
				const entry = JSON.parse(line) as Record<string, unknown>;
				const id = typeof entry.id === "string" ? entry.id : undefined;
				const parentId = id ? repairs.get(id) : undefined;
				if (!parentId || entry.parentId === parentId) return line;
				entry.parentId = parentId;
				changed = true;
				return JSON.stringify(entry);
			} catch {
				return line;
			}
		});
		if (!changed) return;
		const tmp = `${sessionFile}.${process.pid}.${Date.now()}.repair.tmp`;
		writeFileSync(tmp, next.join("\n"));
		renameSync(tmp, sessionFile);
	} catch {
		// Best effort. The in-memory repair still protects the active request.
	}
}

function repairDetachedBackgroundToolResults(ctx: RepairableSessionContext | undefined, onlyToolCallId?: string, options: { rewriteFile?: boolean } = {}): number {
	const sessionManager = ctx?.sessionManager;
	const entries = sessionManager?.getEntries?.();
	if (!entries?.length) return 0;
	const repairs = collectDetachedBackgroundToolResultRepairs(entries, onlyToolCallId);
	for (const entry of entries) {
		const id = entryId(entry);
		const parentId = id ? repairs.get(id) : undefined;
		if (parentId) (entry as { parentId?: string }).parentId = parentId;
	}
	if (options.rewriteFile !== false) rewriteSessionParentIds(sessionManager?.getSessionFile?.(), repairs);
	return repairs.size;
}

function scheduleDetachedBackgroundToolResultRepair(ctx: RepairableSessionContext, toolCallId: string): void {
	for (const delayMs of [25, 250, 1000]) {
		const handle = setTimeout(() => {
			repairDetachedBackgroundToolResults(ctx, toolCallId, { rewriteFile: ctx.isIdle?.() === true });
		}, delayMs);
		handle.unref?.();
	}
}

function pbbSessionDir(id: PbbIdentity): string {
	return join(id.root, "sessions", id.sessionKey);
}

function pbbInstanceDir(id: PbbIdentity): string {
	return join(pbbSessionDir(id), "instances", id.instanceId);
}

function pbbJobsDir(id: PbbIdentity): string {
	return join(pbbInstanceDir(id), "jobs");
}

function pbbLogsDir(id: PbbIdentity): string {
	return join(pbbInstanceDir(id), "logs");
}

function pbbRequestsDir(id: PbbIdentity): string {
	return join(pbbInstanceDir(id), "requests");
}

const SHIM_MARKER = "generated by pi-background-bash";

function shellQuotePath(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function pbbCliScript(): string | undefined {
	try {
		const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "pbb.js");
		return existsSync(cli) ? cli : undefined;
	} catch {
		// Bundled/transformed runtimes may not expose import.meta.url.
		return undefined;
	}
}

/**
 * Write `<pbb root>/bin/pbb` and return that directory. npm puts the `pbb` bin in
 * a node_modules/.bin directory that is on neither a login-shell PATH nor the
 * PATH inside sandboxed pi sessions; spawned bash commands get this directory
 * prepended instead, so `pbb list/status/tail/kill` work where the job lives.
 */
function ensurePbbBinDir(root: string): string | undefined {
	const cli = pbbCliScript();
	if (!cli) return undefined;
	const dir = join(root, "bin");
	const shim = join(dir, "pbb");
	const content = `#!/bin/sh\n# ${SHIM_MARKER} — do not edit\nPBB_CLI=${shellQuotePath(cli)}\nexec ${shellQuotePath(process.execPath)} "$PBB_CLI" "$@"\n`;
	try {
		mkdirSync(dir, { recursive: true });
		if (!existsSync(shim) || readFileSync(shim, "utf8") !== content) {
			writeFileSync(shim, content);
			chmodSync(shim, 0o755);
		} else if ((statSync(shim).mode & 0o111) === 0) {
			chmodSync(shim, 0o755);
		}
		return dir;
	} catch {
		return undefined;
	}
}

function assignOrDelete(env: NodeJS.ProcessEnv, key: string, value: string | undefined): void {
	if (value === undefined) delete env[key];
	else env[key] = value;
}

/**
 * Per-spawn environment. Identity is passed explicitly instead of being written
 * into `process.env` at session_start: that was process-wide, so the session that
 * started last made every later spawn (and every `pbb` run inside it) report the
 * wrong session.
 *
 * `base` is the environment pi resolved for this call (`getShellEnv()` plus the
 * `PI_*` session variables) — pbb only adds its own identity on top.
 */
function pbbSpawnEnv(id: PbbIdentity | undefined, base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...(base ?? process.env) };
	if (id) {
		env.PBB_ROOT = id.root;
		env.PBB_SESSION_KEY = id.sessionKey;
		env.PBB_INSTANCE_ID = id.instanceId;
		assignOrDelete(env, "PBB_SESSION_ID", id.sessionId);
		assignOrDelete(env, "PBB_SESSION_FILE", id.sessionFile);
		assignOrDelete(env, "PBB_LANE", id.lane);
		// pbb (and pil) prefer PI_LANE_*; point them at THIS session.
		env.PI_LANE_SESSION_KEY = id.sessionKey;
		assignOrDelete(env, "PI_LANE_SESSION_ID", id.sessionId);
		assignOrDelete(env, "PI_LANE_SESSION_FILE", id.sessionFile);
	}
	const binDir = ensurePbbBinDir(id?.root ?? pbbRoot());
	if (binDir) env.PATH = env.PATH ? `${binDir}:${env.PATH}` : binDir;
	return env;
}

function writeJsonFile(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmp, path);
}

function readJobFile(path: string): Record<string, unknown> | undefined {
	try {
		return asRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
	} catch {
		return undefined;
	}
}

function patchJobFileAt(path: string, patch: Record<string, unknown>): boolean {
	const current = readJobFile(path);
	if (!current) return false;
	try {
		writeJsonFile(path, { ...current, ...patch, updatedAt: new Date().toISOString() });
		return true;
	} catch {
		return false;
	}
}

function patchPbbJobFile(job: ActiveJob, patch: Record<string, unknown>): void {
	if (!job.pbb) return;
	patchJobFileAt(join(pbbJobsDir(job.pbb), `${job.id}.json`), patch);
}

function readPbbSeq(id: PbbIdentity): number {
	try {
		return Number(readFileSync(join(pbbInstanceDir(id), "seq"), "utf8")) || 0;
	} catch {
		return 0;
	}
}

function nextPbbEventId(id: PbbIdentity): number {
	const next = readPbbSeq(id) + 1;
	writeJsonFile(join(pbbInstanceDir(id), "identity.json"), {
		schemaVersion: 1,
		sessionId: id.sessionId,
		sessionKey: id.sessionKey,
		sessionFile: id.sessionFile,
		instanceId: id.instanceId,
		lane: id.lane,
		laneRoot: id.laneRoot,
		root: id.root,
		pid: process.pid,
		updatedAt: new Date().toISOString(),
	});
	mkdirSync(pbbInstanceDir(id), { recursive: true });
	writeFileSync(join(pbbInstanceDir(id), "seq"), String(next));
	return next;
}

function appendEventLine(id: PbbIdentity, eventId: number, jobId: string, type: string, data: Record<string, unknown> = {}): void {
	mkdirSync(pbbInstanceDir(id), { recursive: true });
	appendFileSync(join(pbbInstanceDir(id), "events.jsonl"), `${JSON.stringify({
		schemaVersion: 1,
		eventId,
		type,
		at: new Date().toISOString(),
		sessionId: id.sessionId,
		sessionKey: id.sessionKey,
		instanceId: id.instanceId,
		lane: id.lane,
		jobId,
		globalJobId: `${id.instanceId}:${jobId}`,
		...data,
	})}\n`);
}

/** Append an event without touching identity.json (used by the reconcile sweep). */
function appendEventRaw(id: PbbIdentity, jobId: string, type: string, data: Record<string, unknown> = {}): void {
	try {
		const eventId = readPbbSeq(id) + 1;
		mkdirSync(pbbInstanceDir(id), { recursive: true });
		writeFileSync(join(pbbInstanceDir(id), "seq"), String(eventId));
		appendEventLine(id, eventId, jobId, type, data);
	} catch {
		// Event history is forensic, never load-bearing.
	}
}

function appendPbbEvent(job: ActiveJob, type: string, data: Record<string, unknown> = {}): number | undefined {
	if (!job.pbb) return undefined;
	const eventId = nextPbbEventId(job.pbb);
	job.lastEventId = eventId;
	appendEventLine(job.pbb, eventId, job.id, type, data);
	return eventId;
}

function writePbbJob(job: ActiveJob, patch: Record<string, unknown> = {}): void {
	if (!job.pbb) return;
	mkdirSync(pbbJobsDir(job.pbb), { recursive: true });
	mkdirSync(pbbLogsDir(job.pbb), { recursive: true });
	writeJsonFile(join(pbbJobsDir(job.pbb), `${job.id}.json`), {
		schemaVersion: 1,
		jobId: job.id,
		globalJobId: `${job.pbb.instanceId}:${job.id}`,
		command: job.command,
		toolCallId: job.toolCallId,
		cwd: patch.cwd ?? job.cwd,
		status: "running",
		outcome: "running",
		exitCode: null,
		startedAt: new Date(job.startedAt).toISOString(),
		updatedAt: new Date().toISOString(),
		sessionId: job.pbb.sessionId,
		sessionKey: job.pbb.sessionKey,
		sessionFile: job.pbb.sessionFile,
		instanceId: job.pbb.instanceId,
		lane: job.pbb.lane,
		laneRoot: job.pbb.laneRoot,
		pid: job.pid ?? process.pid,
		pgid: job.pgid,
		runner: job.runner,
		killSignal: job.killSignal,
		logPath: job.logPath ?? join(pbbLogsDir(job.pbb), `${job.id}.log`),
		...(job.logBytes === undefined ? {} : { logBytes: job.logBytes }),
		// Only ever a real cap on this job's log — never a marker inside the file
		// (Decision 9: the log is the command's own bytes, nothing else).
		...(job.logTruncated ? { logTruncated: true } : {}),
		lastEventId: job.lastEventId,
		...patch,
	});
}

/**
 * The job record, written when a call becomes a job (promoted, or
 * `background: true`). The log file itself already exists — the exec layer
 * writes every chunk into it from the moment the command is spawned.
 */
function recordPbbJobStarted(job: ActiveJob, cwd: string, patch: Record<string, unknown> = {}): void {
	if (!job.pbb) return;
	job.cwd = cwd;
	job.runner = "pbb";
	job.promoted = true;
	appendPbbEvent(job, "job.promoted", { command: job.command, cwd, ...patch });
	writePbbJob(job, { cwd, status: "running", outcome: "running", runner: "pbb", ...patch });
}

/**
 * The log's real size on disk. `job.logBytes` is a promotion-time snapshot (it
 * is what the cap checks against while the command runs), so a finished job's
 * record must be refreshed from the file or it keeps saying `0` forever.
 */
function logBytesOnDisk(job: ActiveJob): number | undefined {
	if (!job.logPath) return undefined;
	try {
		return statSync(job.logPath).size;
	} catch {
		return undefined;
	}
}

/**
 * Persist the real outcome. `delivered` starts false so the reconcile sweep can
 * tell "recorded but never reached the agent" apart from "delivered".
 *
 * The log is left untouched: it holds the command's own bytes (Decision 9).
 * Nothing reconstructs output from events any more — the per-chunk `job.output`
 * events were 1.3 MB per instance and are gone.
 */
function recordPbbJobCompleted(job: ActiveJob, result: JobResult, cwd: string, durationMs: number): void {
	if (!job.pbb) return;
	appendPbbEvent(job, "job.completed", { outcome: result.outcome, exitCode: result.exitCode, durationMs });
	const logBytes = logBytesOnDisk(job);
	if (logBytes !== undefined) job.logBytes = logBytes;
	writePbbJob(job, {
		cwd,
		status: result.outcome === "exit" ? "exited" : result.outcome,
		outcome: result.outcome,
		exitCode: result.exitCode,
		completedAt: new Date().toISOString(),
		durationMs,
		delivered: false,
		lastEventId: job.lastEventId,
	});
}

function handlePbbKillRequestsForSession(session: SessionState): void {
	for (const job of session.activeJobs.values()) {
		if (!job.pbb || !job.promoted) continue;
		const dir = pbbRequestsDir(job.pbb);
		if (!existsSync(dir)) continue;
		for (const item of readdirSync(dir)) {
			if (!item.endsWith(".json")) continue;
			const path = join(dir, item);
			let request: Record<string, unknown> | undefined;
			try {
				request = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
			} catch {
				rmSync(path, { force: true });
				continue;
			}
			if (request.type !== "kill" || request.jobId !== job.id) continue;
			job.killSignal = normalizeSignal(request.signal);
			appendPbbEvent(job, "job.kill_requested", { requestId: request.requestId, signal: job.killSignal });
			writePbbJob(job, { status: "kill_requested", killRequestedAt: new Date().toISOString(), killSignal: job.killSignal, lastEventId: job.lastEventId });
			job.abortRequested = true;
			killProcessGroup(job.pgid ?? job.pid, job.killSignal);
			rmSync(path, { force: true });
		}
	}
}

function waitForBackgroundThreshold(seconds: number): Promise<"background"> {
	return new Promise((resolve) => {
		const handle = setTimeout(() => resolve("background"), seconds * 1000);
		handle.unref?.();
	});
}

function completionBody(output: string, suffix: string): string {
	return output ? `${output.replace(/\s*$/, "")}\n\n${suffix}` : suffix;
}

/**
 * The tail of a log file, at most `maxBytes` from its end, starting on a line
 * boundary. Completion and digest bodies are built from this instead of from
 * the (now removed) per-chunk `job.output` events.
 *
 * A byte window rarely lands on a line start, so the window is read one byte
 * early: if that byte is a newline the window begins exactly on a line boundary
 * and the whole first line is kept. Only a genuinely cut first line is dropped.
 * (Dropping it unconditionally lost one entire line whenever the window happened
 * to begin right after a newline.)
 */
export function readLogTail(path: unknown, maxBytes = LOG_TAIL_MAX_BYTES): string {
	if (typeof path !== "string") return "";
	let fd: number | undefined;
	try {
		const { size } = statSync(path);
		if (size === 0) return "";
		const start = Math.max(0, size - maxBytes);
		// One byte of look-behind tells us whether the window begins on a boundary.
		const from = start > 0 ? start - 1 : 0;
		const buffer = Buffer.alloc(size - from);
		fd = openSync(path, "r");
		readSync(fd, buffer, 0, buffer.length, from);
		const text = buffer.toString("utf8");
		if (from === start) return text;
		if (buffer[0] !== 0x0a) {
			// The window starts inside a line: drop the cut fragment.
			const newline = text.indexOf("\n");
			return newline >= 0 ? text.slice(newline + 1) : "";
		}
		// The window starts on the newline that ended the previous line: drop just
		// that byte, the first visible line is complete.
		return text.slice(1);
	} catch {
		return "";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * How the job ended, as notice lines for the completion body (empty when the
 * command simply exited 0).
 */
function completionNotices(job: ActiveJob, result: JobResult): string[] {
	const suffix =
		result.outcome === "timeout"
			? `Command timed out after ${job.timeoutSeconds} seconds`
			: result.outcome === "abort"
				? "Command aborted"
				: result.outcome === "error"
					? (job.errorMessage ?? "Command could not be run")
					: result.exitCode === null || result.exitCode === 0
						? ""
						: `Command exited with code ${result.exitCode}`;
	return suffix ? [suffix] : [];
}

/**
 * The completion body: the command's own output plus how it ended. Formatting
 * lives in `lib/output-format.ts` (PLAN §7) — this only hands it the log file and
 * the notices:
 *
 *  - a log that hit `maxLogBytes` is reshaped from its first and last bytes and
 *    says that its tail is not the true end of the output (PLAN §7b);
 *  - any other log is capped exactly like a pi tool result — the tail window
 *    pi uses, with `pbb tail <job>` as the route to everything (decision 6: no
 *    truncation numbers of our own, and no head+tail where pi would not truncate).
 */
function completionBodyFromLog(job: ActiveJob, result: JobResult): string {
	const { headLines, tailLines, maxLines, maxBytes } = loadOutputFormatConfig(job.cwd);
	const notices = completionNotices(job, result);
	if (job.logTruncated) {
		return formatLogFile(job.logPath, {
			headLines,
			tailLines,
			maxLines,
			maxBytes,
			fullOutputPath: `pbb tail ${job.id} --full`,
			logTruncated: true,
			logBytes: job.logBytes ?? 0,
			notices,
		});
	}
	const output = readLogTail(job.logPath);
	const body = notices.length > 0 ? completionBody(output, notices.join("\n")) : output;
	return capBodyToPiWindow(body, { maxLines, maxBytes, fullOutputPath: `pbb tail ${job.id} --full` });
}

/* ------------------------------------------------------------------------- *
 * The exec seam
 *
 * `operations.exec` is the only thing this extension supplies to pi's own bash
 * tool: pi keeps the environment, the output accumulator, truncation, the error
 * texts and the structured result (PLAN §4/§5). Everything below reproduces
 * pi's local `createLocalShellOperations` (`tools/bash.ts:97-172`) exactly —
 * same validation order, same messages, same exit convention — and adds the two
 * things a background layer needs: a raw-bytes log write-through from spawn, and
 * promotion, where the call is answered early while the same child keeps
 * running as a job.
 * ------------------------------------------------------------------------- */

export interface PromotedExit extends ChildExit {
	/** This layer killed the group because the `timeout` param elapsed. */
	timedOut: boolean;
	/** The child never started (spawn error); `exit` carries no code. */
	error?: unknown;
}

export interface BashExecOptions {
	/** Canonical full-output log for this call: every chunk is written here. */
	logPath: string;
	/** pi's spawn env (shell env + `PI_*`) with the pbb identity on top. */
	spawnEnv(base: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv;
	/** `background: true`: promote before the first chunk. */
	promoteImmediately?: boolean;
	/** Bytes the log may grow to; appending stops there (default 100 MB). */
	maxLogBytes?: number;
	/** The child exists; record pid/pgid and give our own kill paths a handle. */
	onSpawn?(child: ChildProcess): void;
	/**
	 * Promotion, synchronously after the exec resolved with the synthetic
	 * `{exitCode: 0}`: the job record is written here, so it can never race a
	 * completion that arrives later. Exit detection is installed *before* this
	 * runs, so a throw from the bookkeeping cannot orphan the child.
	 */
	onPromote?(elapsedMs: number, log: LogStats): void;
	/** The log reached `maxLogBytes`; appending stopped. */
	onLogCapped?(log: LogStats): void;
	/** A promoted call's process is gone; the job layer finalizes the record. */
	onExit?(exit: PromotedExit): void;
}

/** How much of the command's output reached the log file. */
export interface LogStats {
	bytes: number;
	truncated: boolean;
}

export interface BashExec {
	exec: BashOperations["exec"];
	/** Resolve the exec as if the command had finished; the child keeps running. */
	promote(): void;
	readonly promoted: boolean;
	readonly child: ChildProcess | undefined;
	/** Bytes written to the log file (at most `maxLogBytes`). */
	readonly logBytes: number;
	/** The log hit `maxLogBytes` and appending stopped. */
	readonly logTruncated: boolean;
}

/** pi's `resolveTimeoutMs`: same bounds, same error texts. */
function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}
	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
	}
	return timeoutMs;
}

export function createBashExec(options: BashExecOptions): BashExec {
	let child: ChildProcess | undefined;
	/** The exec promise settled (promoted, finished or failed). */
	let settled = false;
	/** The process is gone: only then is the SIGKILL escalation pointless. */
	let gone = false;
	let promoted = false;
	let timedOut = false;
	/** Bytes actually written to the log file; stops at `maxLogBytes`. */
	let logBytes = 0;
	/** The log reached `maxLogBytes`; appending stopped there. */
	let logTruncated = false;
	let promote = () => {};
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	let killHandle: ReturnType<typeof setTimeout> | undefined;

	const clearTimers = () => {
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (killHandle) clearTimeout(killHandle);
		timeoutHandle = undefined;
		killHandle = undefined;
	};

	const terminate = () => {
		killProcessGroup(child?.pid, "SIGTERM");
		if (killHandle) clearTimeout(killHandle);
		killHandle = setTimeout(() => {
			if (!gone) killProcessGroup(child?.pid, "SIGKILL");
		}, KILL_GRACE_MS);
		killHandle.unref?.();
	};

	const exec: BashOperations["exec"] = async (command, cwd, { onData, signal, timeout, env }) => {
		// pi's order, pi's messages: validate the timeout, honour an aborted
		// signal, check the cwd, then spawn.
		const timeoutMs = resolveTimeoutMs(timeout);
		if (signal?.aborted) throw new Error("aborted");
		try {
			accessSync(cwd, fsConstants.F_OK);
		} catch {
			throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
		}

		mkdirSync(dirname(options.logPath), { recursive: true });
		// A reused job id starts with an empty log.
		writeFileSync(options.logPath, "");

		child = spawn("bash", ["-lc", command], {
			cwd,
			detached: true,
			env: options.spawnEnv(env),
			stdio: ["ignore", "pipe", "pipe"],
		});
		const spawnedAt = Date.now();
		options.onSpawn?.(child);

		// Raw bytes: the Buffer pi's accumulator receives is the Buffer the log
		// gets — until the log reaches `maxLogBytes`, where appending stops for the
		// rest of the run (PLAN §6). pi's own copy of the output keeps flowing, so
		// the cap is a disk budget, never a change in what the command sees.
		let forwarding = true;
		const maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES;
		const write = (chunk: Buffer) => {
			if (logBytes < maxLogBytes) {
				const room = maxLogBytes - logBytes;
				const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
				try {
					appendFileSync(options.logPath, slice);
					logBytes += slice.length;
				} catch {
					// Log I/O must never swallow the command's output.
				}
				if (logBytes >= maxLogBytes && !logTruncated) {
					logTruncated = true;
					try {
						options.onLogCapped?.({ bytes: logBytes, truncated: true });
					} catch {
						// Bookkeeping must not stop the command.
					}
				}
			}
			if (forwarding) onData(chunk);
		};
		child.stdout?.on("data", write);
		child.stderr?.on("data", write);

		const foreground = waitForChildExit(child);
		const onAbort = () => terminate();
		let resolveExec: ((value: { exitCode: number }) => void) | undefined;
		let rejectExec: ((error: unknown) => void) | undefined;

		const detachSignal = () => {
			signal?.removeEventListener("abort", onAbort);
		};

		const finishJob = (exit: ChildExit, error?: unknown) => {
			if (gone) return;
			gone = true;
			clearTimers();
			options.onExit?.({ ...exit, timedOut, ...(error === undefined ? {} : { error }) });
		};

		promote = () => {
			// A command that already ended ends normally; promoting it would leave a
			// job with no exit event left to wait for.
			if (promoted || settled) return;
			if (child && (child.exitCode !== null || child.signalCode !== null)) return;
			promoted = true;
			settled = true;
			// Nothing is buffered: every delivered chunk was written to the log and
			// forwarded to `onData` in the same `data` handler, so the call's answer
			// is complete up to this instant.
			foreground.detach();
			forwarding = false;
			// The signal belongs to the whole run (one AbortController per run), not
			// to this call: a listener that survived promotion would kill a job the
			// model was just told is running.
			detachSignal();
			resolveExec?.({ exitCode: 0 });
			// Own exit detection is installed BEFORE the job record is written: pi's
			// destroy-on-settle would cut the log write-through of a job that is still
			// writing, and a failing record write (ENOSPC/EACCES) must never leave the
			// child orphaned, unfinalized and undelivered.
			const jobWaiter = waitForChildExit(child!, { idleGraceMs: JOB_EXIT_STDIO_GRACE_MS });
			jobWaiter.done.then(
				(exit) => finishJob(exit),
				(error) => finishJob({ code: null, signalCode: null }, error),
			);
			try {
				options.onPromote?.(Date.now() - spawnedAt, { bytes: logBytes, truncated: logTruncated });
			} catch (error) {
				// The job record is bookkeeping; the completion still has to be delivered.
				console.error(
					`[pi-background-bash] job bookkeeping failed after promotion: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		};

		const promise = new Promise<{ exitCode: number }>((resolve, reject) => {
			resolveExec = resolve;
			rejectExec = reject;
		});

		foreground.done.then(
			(exit) => {
				if (promoted) return; // the job watcher owns this exit
				settled = true;
				gone = true;
				clearTimers();
				detachSignal();
				if (signal?.aborted) return rejectExec?.(new Error("aborted"));
				if (timedOut) return rejectExec?.(new Error(`timeout:${timeout}`));
				// pi's convention, verbatim: a signal-killed shell has no exit code.
				resolveExec?.({ exitCode: exitCodeFrom(exit.code, exit.signalCode) });
			},
			(error) => {
				if (promoted) return;
				settled = true;
				gone = true;
				clearTimers();
				detachSignal();
				rejectExec?.(error);
			},
		);

		if (timeoutMs !== undefined) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				terminate();
			}, timeoutMs);
			timeoutHandle.unref?.();
		}
		// An abort that arrived while the process was being spawned is still an abort.
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });

		if (options.promoteImmediately) promote();

		return promise;
	};

	return {
		exec,
		promote: () => promote(),
		get promoted() {
			return promoted;
		},
		get child() {
			return child;
		},
		get logBytes() {
			return logBytes;
		},
		get logTruncated() {
			return logTruncated;
		},
	};
}


function escapePiContextClosingTags(text: string): string {
	return text.replace(/<\/pi_context>/gi, "<\\/pi_context>");
}

/** Where a call's full output lives. Job calls: the instance log dir. */
function logPathFor(job: ActiveJob): string {
	return job.pbb ? join(pbbLogsDir(job.pbb), `${job.id}.log`) : join(pbbRoot(), "logs", `${job.id}.log`);
}

/** A foreground call that was neither truncated nor promoted leaves no output file. */
function discardJobLog(job: ActiveJob): void {
	if (!job.logPath || job.promoted) return;
	rmSync(job.logPath, { force: true });
}

/**
 * The foreground answer: pi's own result, with the full-output path retargeted
 * from pi's temp file (which stops growing and is deleted here) to this call's
 * log, which outlives the call and is what `structuredContent`/codemode reads.
 */
function foregroundToolResult(
	job: ActiveJob,
	result: AgentToolResult<BashToolDetails | undefined>,
): AgentToolResult<BashToolDetails | undefined> {
	const piFullOutputPath = result.details?.fullOutputPath;
	if (!piFullOutputPath || !job.logPath) {
		discardJobLog(job);
		return result;
	}
	const logPath = job.logPath;
	const retarget = (text: string) => text.split(`Full output: ${piFullOutputPath}`).join(`Full output: ${logPath}`);
	const content: typeof result.content = result.content.map((part) =>
		part.type === "text" ? { ...part, text: retarget(part.text) } : part,
	);
	rmSync(piFullOutputPath, { force: true });
	const structured = (result as { structuredContent?: Record<string, unknown> }).structuredContent;
	return {
		...result,
		content,
		details: { ...result.details, fullOutputPath: logPath },
		...(structured ? { structuredContent: { ...structured, full_output_path: logPath } } : {}),
	};
}

/**
 * The promoted answer: job id, threshold and the log path. `structuredContent`
 * carries no exit code — the command is still running — and points at the log
 * instead of pi's temp file, which is frozen at promotion and deleted here.
 */
function promotedToolResult(
	job: ActiveJob,
	result: AgentToolResult<BashToolDetails | undefined> | undefined,
	thresholdSeconds: number | undefined,
): AgentToolResult<BackgroundBashDetails> {
	const piFullOutputPath = result?.details?.fullOutputPath;
	if (piFullOutputPath) rmSync(piFullOutputPath, { force: true });
	const lead =
		thresholdSeconds === undefined
			? `Bash job ${job.id} started in background.`
			: `Bash job ${job.id} moved to background after ${formatThreshold(thresholdSeconds)}.`;
	const text = `${lead} Full output: ${job.logPath}. A follow-up result will arrive when it finishes; continue independent work. Use pbb only if you need progress before completion.`;
	const structured = (
		result as { structuredContent?: { output?: unknown; truncated?: unknown; wall_time_seconds?: unknown } } | undefined
	)?.structuredContent;
	return {
		content: [{ type: "text", text }],
		details: runningJobDetails(job, job.cwd ?? process.cwd()),
		structuredContent: {
			output: typeof structured?.output === "string" ? structured.output : "",
			truncated: structured?.truncated === true,
			full_output_path: job.logPath,
			job_id: job.id,
			wall_time_seconds: typeof structured?.wall_time_seconds === "number" ? structured.wall_time_seconds : 0,
		},
	} as unknown as AgentToolResult<BackgroundBashDetails>;
}

function buildXmlResult(job: ActiveJob, outcome: Outcome, exitCode: number | null, durationMs: number, body: string): string {
	// pi-context emits payload text as-is; escape the outer wrapper close tag so
	// command output cannot prematurely close the XML-ish context envelope.
	return piContext({
		source: "pi-background-bash",
		kind: "background_bash_result",
		id: job.id,
		attrs: {
			tool_call_id: job.toolCallId,
			session_id: job.pbb?.sessionId,
			session_key: job.pbb?.sessionKey,
			instance_id: job.pbb?.instanceId,
			lane: job.pbb?.lane,
			global_job_id: job.pbb ? `${job.pbb.instanceId}:${job.id}` : undefined,
			pbb_cursor: job.lastEventId,
			started_at: new Date(job.startedAt).toISOString(),
			command: job.command,
			outcome,
			exit_code: exitCode,
			duration_ms: durationMs,
		},
		body: escapePiContextClosingTags(body),
	});
}

function sendBackgroundResultFollowUp(session: SessionState, job: ActiveJob, content: string, details: BackgroundBashDetails): void {
	if (session.shuttingDown) return;
	try {
		repairDetachedBackgroundToolResults(job.repairContext, job.toolCallId, { rewriteFile: job.repairContext?.isIdle?.() === true });
	} catch {
		// The session context can already be torn down; provenance repair is best effort.
	}
	// Steer the result in: while the agent is mid-run, pi drains the steering
	// queue at the next turn boundary and injects the message into the next
	// provider request in the same run (no second concurrent provider request,
	// so the historical OpenAI Responses race cannot occur). While idle,
	// triggerTurn starts a run immediately.
	session.pi.sendMessage(
		{
			customType: CUSTOM_TYPE,
			content,
			display: true,
			details,
		},
		{ deliverAs: "steer", triggerTurn: true },
	);
}

/**
 * Terminal path for a background job: always persist the outcome, then deliver
 * when this session can still receive it. Never early-return before recording —
 * that is what left job files stuck at `status: "running"` forever.
 */
function finishBackgroundJob(session: SessionState, job: ActiveJob, result: JobResult, cwd: string): void {
	const durationMs = Date.now() - job.startedAt;
	session.activeJobs.delete(job.id);
	session.pending.finish(job.id);

	try {
		recordPbbJobCompleted(job, result, cwd, durationMs);
	} catch (error) {
		// A failed record write must not swallow the completion: the agent still
		// gets the result, the reconcile sweep just cannot re-deliver it.
		console.error(
			`[pi-background-bash] could not record the completion of ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (session.shuttingDown) {
		patchPbbJobFile(job, { delivered: false, droppedReason: "session_shutdown", droppedAt: new Date().toISOString() });
		appendPbbEvent(job, "job.completion_deferred", { reason: "session_shutdown" });
		return;
	}

	// The completion body comes from the log file, not from a buffered copy: the
	// log is the canonical output and is still the only thing that survives a
	// `/reload` (PLAN §6).
	const body = completionBodyFromLog(job, result);
	const content = buildXmlResult(job, result.outcome, result.exitCode, durationMs, body);
	const details: BackgroundBashDetails = {
		jobId: job.id,
		command: job.command,
		outcome: result.outcome,
		exitCode: result.exitCode,
		toolCallId: job.toolCallId,
		startedAt: new Date(job.startedAt).toISOString(),
		durationMs,
		body,
		cwd,
		...(job.pbb
			? {
					sessionId: job.pbb.sessionId,
					sessionKey: job.pbb.sessionKey,
					instanceId: job.pbb.instanceId,
					lane: job.pbb.lane,
					globalJobId: `${job.pbb.instanceId}:${job.id}`,
					pbbCursor: job.lastEventId,
				}
			: {}),
	};

	// Mark delivered BEFORE sending: a crash between the two must not re-deliver a
	// result the agent already saw.
	patchPbbJobFile(job, { delivered: true, deliveredAt: new Date().toISOString(), deliveredReason: "live" });
	try {
		sendBackgroundResultFollowUp(session, job, content, details);
	} catch (error) {
		patchPbbJobFile(job, { delivered: false, droppedReason: `send_failed: ${error instanceof Error ? error.message : String(error)}` });
	}
}

const TERMINAL_STATUSES = new Set(["exited", "exit", "timeout", "abort", "error", "lost"]);

type ReconcileEntry = {
	path: string;
	job: Record<string, unknown>;
	identity?: PbbIdentity;
	lost: boolean;
};

function processAlive(pid: unknown): boolean {
	const value = typeof pid === "number" ? pid : Number(pid);
	if (!Number.isInteger(value) || value <= 0) return false;
	try {
		process.kill(value, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

function jobProcessAlive(job: Record<string, unknown>): boolean {
	return processAlive(job.pid) || processAlive(job.pgid);
}

function jobIdentityFromFile(job: Record<string, unknown>, root: string): PbbIdentity | undefined {
	const sessionKey = typeof job.sessionKey === "string" ? job.sessionKey : undefined;
	const instanceId = typeof job.instanceId === "string" ? job.instanceId : undefined;
	if (!sessionKey || !instanceId) return undefined;
	return {
		sessionId: typeof job.sessionId === "string" ? job.sessionId : undefined,
		sessionKey,
		sessionFile: typeof job.sessionFile === "string" ? job.sessionFile : undefined,
		instanceId,
		lane: typeof job.lane === "string" ? job.lane : undefined,
		laneRoot: typeof job.laneRoot === "string" ? job.laneRoot : undefined,
		root,
	};
}

/** Job ids whose *completion* this session's transcript already carries. */
function jobIdsSeenInSession(ctx: RepairableSessionContext): Set<string> {
	const ids = new Set<string>();
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	for (const entry of entries) {
		const record = asRecord(entry);
		// Only completion messages count. A job's *start* tool result also carries
		// `details.jobId`, so including those would mark every started job as already
		// delivered and defeat the whole sweep.
		if (record?.type !== "custom_message" || record.customType !== CUSTOM_TYPE) continue;
		const details = asRecord(record.details);
		if (!details?.digest && typeof details?.jobId === "string") ids.add(details.jobId);
		const digestJobs = Array.isArray(details?.digestJobs) ? details.digestJobs : [];
		for (const item of digestJobs) {
			const jobId = asRecord(item)?.jobId;
			if (typeof jobId === "string") ids.add(jobId);
		}
		const content = typeof record?.content === "string" ? record.content : undefined;
		for (const match of content?.matchAll(/<pi_context\b[^>]*\bid="(bg\d{3,})"/g) ?? []) ids.add(match[1]);
	}
	return ids;
}

function collectSessionJobFiles(session: SessionState): ReconcileEntry[] {
	const id = session.identity;
	if (!id) return [];
	const instancesDir = join(pbbSessionDir(id), "instances");
	if (!existsSync(instancesDir)) return [];
	const entries: ReconcileEntry[] = [];
	for (const instance of readdirSync(instancesDir, { withFileTypes: true })) {
		if (!instance.isDirectory()) continue;
		const jobsDir = join(instancesDir, instance.name, "jobs");
		if (!existsSync(jobsDir)) continue;
		for (const file of readdirSync(jobsDir)) {
			if (!file.endsWith(".json")) continue;
			const path = join(jobsDir, file);
			const job = readJobFile(path);
			if (!job || typeof job.jobId !== "string") continue;
			// Guard rail: never act on a job recorded for another session, even when it
			// physically sits under a directory of ours.
			if (typeof job.sessionKey === "string" && job.sessionKey !== id.sessionKey) continue;
			entries.push({ path, job, identity: jobIdentityFromFile(job, id.root), lost: false });
		}
	}
	return entries;
}

/**
 * Delete this session's job logs past the retention window (PLAN §6).
 *
 * Never a log whose job is still running or whose completion was never delivered:
 * that undelivered record is the only copy of the output the agent has not seen.
 * Logs of foreground calls have no job record at all — they are deleted by age.
 */
function pruneOldJobLogs(session: SessionState): void {
	const id = session.identity;
	if (!id) return;
	const instancesDir = join(pbbSessionDir(id), "instances");
	let instances: string[];
	try {
		if (!existsSync(instancesDir)) return;
		instances = readdirSync(instancesDir);
	} catch {
		return;
	}
	const cutoff = Date.now() - JOB_LOG_RETENTION_MS;
	for (const instanceId of instances) {
		const instanceDir = join(instancesDir, instanceId);
		const logsDir = join(instanceDir, "logs");
		let files: string[];
		try {
			files = readdirSync(logsDir);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".log")) continue;
			const logPath = join(logsDir, file);
			try {
				if (statSync(logPath).mtimeMs > cutoff) continue;
				const record = readJobFile(join(instanceDir, "jobs", `${file.slice(0, -4)}.json`));
				if (record) {
					const status = typeof record.status === "string" ? record.status : "unknown";
					if (!TERMINAL_STATUSES.has(status) || record.delivered !== true) continue;
				}
				rmSync(logPath, { force: true });
			} catch {
				// A log we cannot inspect stays put: retention is hygiene, not correctness.
			}
		}
	}
}

function jobTimestamp(job: Record<string, unknown>): number {
	const raw = typeof job.completedAt === "string" ? job.completedAt : typeof job.startedAt === "string" ? job.startedAt : undefined;
	const parsed = raw ? Date.parse(raw) : NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

function tailOfLog(path: unknown, lines = RECONCILE_LOG_TAIL_LINES): string {
	const text = readLogTail(path);
	if (!text) return "";
	const wanted = text.split(/\r?\n/).filter((line, index, all) => line.length > 0 || index < all.length - 1).slice(-lines);
	return wanted.join("\n").slice(-1600);
}

function formatDigestEntry(entry: ReconcileEntry): string {
	const job = entry.job;
	const jobId = String(job.jobId);
	const exitCode = typeof job.exitCode === "number" ? job.exitCode : null;
	const header = entry.lost
		? `- [${jobId}] outcome=lost (unknown — the owning process exited without recording a completion)`
		: `- [${jobId}] outcome=${String(job.outcome ?? job.status ?? "unknown")}${exitCode === null ? "" : ` exit_code=${exitCode}`}`;
	const facts: string[] = [header];
	if (typeof job.durationMs === "number") facts.push(`duration=${formatDuration(job.durationMs)}`);
	if (typeof job.instanceId === "string") facts.push(`instance=${job.instanceId}`);
	if (typeof job.startedAt === "string") facts.push(`started=${job.startedAt}`);
	const lines = [facts.join(" ")];
	const command = typeof job.command === "string" ? normalizeCommandForStatus(job.command) : "";
	if (command) lines.push(`  $ ${command.length > 240 ? `${command.slice(0, 240)}…` : command}`);
	const instanceArg = typeof job.instanceId === "string" ? ` --instance ${job.instanceId}` : "";
	lines.push(`  log: pbb tail ${jobId} --scope session${instanceArg} --full`);
	const tail = tailOfLog(job.logPath);
	if (tail) lines.push(...tail.split("\n").map((line) => `  | ${line}`));
	return lines.join("\n");
}

function markJobLost(entry: ReconcileEntry): void {
	const jobId = String(entry.job.jobId);
	const now = Date.now();
	const startedAt = typeof entry.job.startedAt === "string" ? Date.parse(entry.job.startedAt) : NaN;
	const patch: Record<string, unknown> = {
		status: "lost",
		outcome: "lost",
		exitCode: null,
		completedAt: new Date(now).toISOString(),
		lostAt: new Date(now).toISOString(),
		lostReason: "owning pi process exited before the completion was recorded",
		...(Number.isFinite(startedAt) ? { durationMs: Math.max(0, now - startedAt) } : {}),
		delivered: false,
	};
	patchJobFileAt(entry.path, patch);
	entry.job = { ...entry.job, ...patch };
	if (entry.identity) appendEventRaw(entry.identity, jobId, "job.lost", { reason: patch.lostReason });
}

function sendCompletionDigest(session: SessionState, entries: ReconcileEntry[], deferred: number): void {
	if (entries.length === 0) return;
	const listed = entries.map(formatDigestEntry).join("\n\n");
	const body = deferred > 0 ? `${listed}\n\n+${deferred} more recorded completion${deferred === 1 ? "" : "s"} deferred to the next session start (pbb list --scope session shows them).` : listed;
	const content = piContext({
		source: "pi-background-bash",
		kind: "background_bash_digest",
		attrs: {
			session_id: session.identity?.sessionId,
			session_key: session.identity?.sessionKey,
			instance_id: session.identity?.instanceId,
			jobs: entries.length,
			deferred: deferred > 0 ? deferred : undefined,
		},
		body: escapePiContextClosingTags(
			// Presentation is part of the formatting layer (PLAN §7a): a digest body
			// carries raw log tails, so it gets the same escape/CR pass and pi's window
			// as a completion body — never a raw `ESC]0;…` title sequence.
			capBodyToPiWindow(presentText(body), {
				maxLines: MAX_RESULT_LINES,
				maxBytes: MAX_RESULT_BYTES,
				fullOutputPath: "pbb tail <job> --scope session --full",
			}),
		),
	});
	const summaries: DigestJobSummary[] = entries.map((entry) => ({
		jobId: String(entry.job.jobId),
		instanceId: typeof entry.job.instanceId === "string" ? entry.job.instanceId : undefined,
		outcome: entry.lost ? "lost" : String(entry.job.outcome ?? entry.job.status ?? "unknown"),
		exitCode: typeof entry.job.exitCode === "number" ? entry.job.exitCode : null,
		command: typeof entry.job.command === "string" ? entry.job.command : "",
		durationMs: typeof entry.job.durationMs === "number" ? entry.job.durationMs : undefined,
		...(entry.lost ? { lost: true } : {}),
	}));
	const primary = summaries[summaries.length - 1];
	const details: BackgroundBashDetails = {
		jobId: primary.jobId,
		command: primary.command,
		outcome: primary.outcome as Outcome,
		exitCode: primary.exitCode ?? null,
		digest: true,
		digestJobs: summaries,
		digestSkipped: deferred,
		body,
	};
	session.pi.sendMessage({ customType: CUSTOM_TYPE, content, display: true, details }, { deliverAs: "steer", triggerTurn: true });
}

/**
 * Boot-time reconcile: re-deliver completions recorded while no session could
 * receive them (sibling-session shutdown, process exit) and finalize jobs whose
 * owner died before recording anything. Coalesced into ONE message so a backlog
 * cannot force a burst of turns, and filtered by sessionKey so a result can never
 * land in the wrong session.
 */
function reconcileBackgroundJobs(session: SessionState, ctx: RepairableSessionContext): void {
	if (session.shuttingDown || !session.identity) return;
	let files: ReconcileEntry[];
	try {
		files = collectSessionJobFiles(session);
	} catch {
		return;
	}
	if (files.length === 0) return;

	const alreadySeen = jobIdsSeenInSession(ctx);
	const now = Date.now();
	const pending: ReconcileEntry[] = [];

	for (const entry of files) {
		const { job, path } = entry;
		const jobId = String(job.jobId);
		// Our own in-process job for this instance: the completion path owns it.
		if (job.instanceId === session.identity.instanceId && session.activeJobs.has(jobId)) continue;
		const status = typeof job.status === "string" ? job.status : "unknown";
		if (TERMINAL_STATUSES.has(status)) {
			if (job.delivered === true) continue;
			if (alreadySeen.has(jobId)) {
				patchJobFileAt(path, { delivered: true, deliveredAt: new Date().toISOString(), deliveredReason: "already_in_session_history" });
				continue;
			}
			const completedAt = typeof job.completedAt === "string" ? Date.parse(job.completedAt) : NaN;
			if (Number.isFinite(completedAt) && now - completedAt > RECONCILE_MAX_AGE_MS) {
				patchJobFileAt(path, { delivered: true, deliveredAt: new Date().toISOString(), deliveredReason: "reconcile_expired" });
				continue;
			}
			pending.push(entry);
			continue;
		}
		// "running" / "kill_requested": finalize only when nothing of the recorded
		// process (or its group) is left. A live sibling — even one sharing this
		// instance directory — must never be declared lost.
		if (jobProcessAlive(job)) continue;
		pending.push({ ...entry, lost: true });
	}

	if (pending.length === 0) return;
	pending.sort((left, right) => jobTimestamp(left.job) - jobTimestamp(right.job));
	// Finalize every dead-owner job first: recording the audit state must not be
	// limited by how many entries one digest message can carry.
	for (const entry of pending) {
		if (entry.lost) markJobLost(entry);
	}

	const deliver = pending.slice(0, RECONCILE_MAX_JOBS);
	const deferredEntries = pending.slice(RECONCILE_MAX_JOBS);
	const deliveredAt = new Date().toISOString();

	for (const entry of deliver) {
		// Write the delivery marker BEFORE sending, so a re-run cannot double-deliver.
		patchJobFileAt(entry.path, { delivered: true, deliveredAt, deliveredReason: entry.lost ? "reconcile_lost" : "reconcile" });
	}
	for (const entry of deferredEntries) {
		// Stays undelivered on purpose: the next session start picks it up.
		patchJobFileAt(entry.path, { deferredReason: "reconcile_capped", deferredAt: deliveredAt });
	}

	try {
		sendCompletionDigest(session, deliver, deferredEntries.length);
	} catch (error) {
		for (const entry of deliver) {
			patchJobFileAt(entry.path, { delivered: false, droppedReason: `digest_send_failed: ${error instanceof Error ? error.message : String(error)}` });
		}
		return;
	}
	for (const entry of deliver) {
		const identity = entry.identity;
		if (identity) appendEventRaw(identity, String(entry.job.jobId), entry.lost ? "job.lost_delivered" : "job.completion_delivered", { reason: "reconcile" });
	}
}

function renderNativeBashResult(command: string, body: string, details: BackgroundBashDetails | undefined, expanded: boolean, theme: any) {
	const cwd = details?.cwd ?? process.cwd();
	const bash = createBashToolDefinition(cwd);
	const state: any = {
		startedAt: details?.durationMs === undefined ? undefined : Date.now() - details.durationMs,
		endedAt: Date.now(),
		interval: undefined,
	};
	const isError = details?.outcome !== "exit" || (details.exitCode !== null && details.exitCode !== 0);
	const renderContext = (lastComponent: any) => ({
		args: { command },
		toolCallId: details?.jobId ?? "background_bash_result",
		invalidate: () => {},
		lastComponent,
		state,
		cwd,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: true,
		isError,
		durationMs: details?.durationMs,
		outputPad: 0,
	});

	const box = new Box(1, 1, (text) => (isError ? theme.bg("toolErrorBg", text) : theme.bg("toolSuccessBg", text)));
	if (details?.jobId) {
		const status =
			details.outcome === "exit" && (details.exitCode === null || details.exitCode === 0)
				? "done"
				: details.outcome === "timeout"
					? "timed out"
					: details.outcome === "abort"
						? "aborted"
						: details.outcome === "lost"
							? "lost (unknown outcome)"
							: "failed";
		box.addChild(new Text(theme.fg("muted", `↳ ${details.jobId} ${status}.`), 0, 0));
	}
	const call = bash.renderCall?.({ command }, theme, renderContext(undefined));
	if (call) box.addChild(call);
	const result = bash.renderResult?.(
		{ content: [{ type: "text", text: body }], details },
		{ expanded, isPartial: false },
		theme,
		renderContext(undefined),
	);
	if (result) box.addChild(result);

	const container = new Container();
	container.addChild(box);
	return container;
}

function renderBackgroundDigest(details: BackgroundBashDetails, expanded: boolean, theme: any) {
	const jobs = details.digestJobs ?? [];
	const skipped = details.digestSkipped ?? 0;
	const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
	const label = `↳ ${jobs.length} background completion${jobs.length === 1 ? "" : "s"} re-delivered${skipped > 0 ? ` (+${skipped} deferred)` : ""}.`;
	box.addChild(new Text(theme.fg("muted", label), 0, 0));
	for (const job of jobs) {
		const state = job.lost ? "lost (unknown outcome)" : `outcome=${job.outcome}${job.exitCode === null || job.exitCode === undefined ? "" : ` exit=${job.exitCode}`}`;
		const command = normalizeCommandForStatus(job.command).slice(0, 80);
		box.addChild(new Text(`  ${job.jobId} ${state}  ${command}`, 0, 0));
	}
	if (expanded && details.body) box.addChild(new Text(details.body, 0, 0));
	const container = new Container();
	container.addChild(box);
	return container;
}

function runningJobDetails(job: ActiveJob, cwd: string): BackgroundBashDetails {
	return {
		jobId: job.id,
		command: job.command,
		outcome: "running",
		exitCode: null,
		toolCallId: job.toolCallId,
		startedAt: new Date(job.startedAt).toISOString(),
		cwd,
		...(job.pbb
			? {
					sessionId: job.pbb.sessionId,
					sessionKey: job.pbb.sessionKey,
					instanceId: job.pbb.instanceId,
					lane: job.pbb.lane,
					globalJobId: `${job.pbb.instanceId}:${job.id}`,
					pbbCursor: job.lastEventId,
				}
			: {}),
	};
}

function abortSessionJobs(session: SessionState): void {
	session.shuttingDown = true;
	for (const job of session.activeJobs.values()) {
		job.abortRequested = true;
		killProcessGroup(job.pgid ?? job.pid, job.killSignal ?? "SIGTERM");
	}
	session.activeJobs.clear();
	session.pending.clear();
}

function installProcessHooks() {
	if (processHooksInstalled) return;
	processHooksInstalled = true;
	// Best-effort last resort. Normal cleanup happens on Pi's session_shutdown event;
	// do not install SIGINT/SIGTERM handlers here because that would interfere with
	// Pi's own process-level signal handling.
	process.once("exit", () => {
		for (const session of liveSessions) abortSessionJobs(session);
	});
}

function ensureKillRequestPolling(): void {
	if (killRequestTimer) return;
	killRequestTimer = setInterval(() => {
		for (const session of liveSessions) {
			if (session.shuttingDown) continue;
			handlePbbKillRequestsForSession(session);
		}
	}, 250);
	killRequestTimer.unref?.();
}

function stopKillRequestPollingIfIdle(): void {
	if (liveSessions.size > 0 || !killRequestTimer) return;
	clearInterval(killRequestTimer);
	killRequestTimer = undefined;
}

/**
 * Drop state for sessions that were torn down without a `session_shutdown` —
 * in-process subagent sessions (`AgentSession.dispose()`) among them. Only
 * sessions whose session manager has been collected and which own no jobs are
 * removed, so a live session can never be pruned.
 */
function pruneDeadSessions(current: SessionState): void {
	for (const session of [...liveSessions]) {
		if (session === current || session.activeJobs.size > 0 || !session.sessionRef) continue;
		if (session.sessionRef.deref() !== undefined) continue;
		session.shuttingDown = true;
		session.pending.clear();
		liveSessions.delete(session);
	}
	stopKillRequestPollingIfIdle();
}

/** Highest job number among the `bg<N><suffix>` entries of one directory. */
function maxJobNumberOnDisk(dir: string, suffix = ".json"): number {
	let max = 0;
	try {
		if (!existsSync(dir)) return 0;
		for (const item of readdirSync(dir)) {
			if (!item.endsWith(suffix)) continue;
			const n = parseJobNumber(item.slice(0, -suffix.length));
			if (n !== undefined) max = Math.max(max, n);
		}
	} catch {
		// Unreadable directory: fall back to the in-memory counter.
	}
	return max;
}

/**
 * The highest job id this instance has ever used.
 *
 * Job records alone are not enough: a foreground call leaves no record but does
 * leave a log (truncated results name it), and an id is only ever *consumed* — so
 * the logs count too. Deriving the floor from transcripts instead would miss any
 * id whose call left no completion message, and re-allocating it would truncate a
 * log a transcript still points at.
 */
function maxJobNumberSeen(id: PbbIdentity): number {
	return Math.max(maxJobNumberOnDisk(pbbJobsDir(id)), maxJobNumberOnDisk(pbbLogsDir(id), ".log"));
}

function sessionJobNumberFloor(ctx: RepairableSessionContext): number {
	let max = 0;
	const entries = ctx.sessionManager?.getEntries?.() ?? [];
	for (const entry of entries as Array<Record<string, unknown>>) {
		const details = asRecord(entry.details);
		const content = typeof entry.content === "string" ? entry.content : undefined;
		const candidates = [details?.jobId, content?.match(/<pi_context\b[^>]*\bid="(bg\d{3,})"/)?.[1]];
		for (const candidate of candidates) {
			const n = parseJobNumber(candidate);
			if (n !== undefined) max = Math.max(max, n);
		}
	}
	return max;
}

/**
 * Job IDs stay per instance directory (`bg001`, `bg002`, …). The allocator is
 * process-wide on purpose: pi-lane gives one instance per pi process, so two
 * sessions can share one instance directory and must not hand out the same id.
 */
function allocateJobId(session: SessionState, pbb: PbbIdentity | undefined): string {
	if (!pbb) {
		fallbackJobNumber = Math.max(fallbackJobNumber, session.jobNumberFloor) + 1;
		session.jobNumberFloor = fallbackJobNumber;
		return formatJobId(fallbackJobNumber);
	}
	const dir = pbbJobsDir(pbb);
	const next = Math.max(jobNumberByDir.get(dir) ?? 0, maxJobNumberSeen(pbb), session.jobNumberFloor) + 1;
	jobNumberByDir.set(dir, next);
	session.jobNumberFloor = next;
	return formatJobId(next);
}

function createSessionState(pi: ExtensionAPI): SessionState {
	const id = randomUUID().slice(0, 8);
	return {
		id,
		pi,
		pending: createPiPending({
			namespace: `background-bash-${id}`,
			format: (job) => `$ ${normalizeCommandForStatus(job.text)}`,
		}),
		activeJobs: new Map<string, ActiveJob>(),
		shuttingDown: false,
		jobNumberFloor: 0,
	};
}

export default function backgroundBashExtension(pi: ExtensionAPI) {
	installProcessHooks();
	const session = createSessionState(pi);
	liveSessions.add(session);
	ensureKillRequestPolling();

	pi.registerMessageRenderer<BackgroundBashDetails>(CUSTOM_TYPE, (message, options, theme) => {
		const details = message.details;
		if (details?.digest) return renderBackgroundDigest(details, options.expanded, theme);
		const command = details?.command ?? "";
		const body = details?.body ?? (typeof message.content === "string" ? message.content : "");
		return renderNativeBashResult(command, body, details, options.expanded, theme);
	});

	pi.on("session_start", async (_event, ctx) => {
		session.shuttingDown = false;
		session.sessionRef = new WeakRef(ctx.sessionManager as object);
		session.identity = pbbIdentity(ctx, session.id);
		session.jobNumberFloor = Math.max(
			session.jobNumberFloor,
			sessionJobNumberFloor(ctx),
			session.identity ? maxJobNumberSeen(session.identity) : 0,
		);
		pruneDeadSessions(session);
		try {
			pruneOldJobLogs(session);
		} catch {
			// Log retention is hygiene; never let it break session start.
		}
		if (ctx.hasUI) session.pending.attach(ctx.ui);
		repairDetachedBackgroundToolResults(ctx, undefined, { rewriteFile: true });
		// Re-deliver completions that never reached this session (sibling shutdown,
		// process exit). Deferred one tick so the session is fully wired up before
		// we steer a message into it.
		const handle = setTimeout(() => {
			try {
				reconcileBackgroundJobs(session, ctx);
			} catch {
				// Reconcile is best effort; a failure must not break session start.
			}
		}, 0);
		handle.unref?.();
	});

	pi.on("session_shutdown", async () => {
		abortSessionJobs(session);
		session.pending.detach();
		liveSessions.delete(session);
		stopKillRequestPollingIfIdle();
	});

	// pi's own bash tool, driven by our `operations.exec` (PLAN §5). The factory
	// gets no session context, so `process.cwd()` is only the registration-time
	// fallback — `execute` resolves the call's real cwd (`ctx.cwd`) and builds the
	// delegate per call, which is also where the per-call exec state lives.
	const inner = createBashToolDefinition(process.cwd());

	pi.registerTool({
		...inner,
		// Only the two claims that are true: a *truncated* result names its log, and a
		// *backgrounded* job has an id `pbb` can read (PLAN §6). A small foreground
		// result leaves no file, and a log that hit `maxLogBytes` is not the whole
		// output — so neither "every command's output is on disk" nor "foreground
		// calls are readable with pbb tail" belongs here.
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); a truncated result names the log file that holds the command's output. Set background: true to run immediately in the background and get a job id (usable with pbb status/tail). Otherwise, if the command is still running after the configured auto-background threshold (${formatThreshold(DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS)} by default), it is automatically moved to the background and gets such a job id; a <pi_context source="pi-background-bash" kind="background_bash_result"> message is injected when it finishes. Optionally provide a timeout in seconds.`,
		promptSnippet: `Execute bash commands (ls, grep, find, etc.); timeout is in seconds. Set background: true for long-running non-interactive commands. Commands still running after the configured auto-background threshold (${formatThreshold(DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS)} by default) automatically move to background and wake you with a pi-background-bash result when finished.`,
		promptGuidelines: [
			"Use bash with background: true for long-running non-interactive commands such as builds, full test suites, dev servers, watchers, deploys, downloads, or commands you do not need before the next step.",
			`Use bash normally for shell commands; Pi automatically moves bash commands that run longer than the configured auto-background threshold (${formatThreshold(DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS)} by default) to the background.`,
			"When bash reports that a command started or moved to background, do not retry it just to wait; continue independent work or tell the user the job is running.",
			"Use the pbb CLI (`pbb list`, `pbb status <job>`, `pbb tail <job>`) only when you need progress before the completion follow-up arrives, need full truncated logs, or need to manage a job; pbb is on PATH inside bash commands and defaults to the current instance (use `--scope session` for sibling sessions' jobs).",
			"When a <pi_context source=\"pi-background-bash\" kind=\"background_bash_result\"> message appears, treat it like the final result of the original bash command.",
			"A <pi_context source=\"pi-background-bash\" kind=\"background_bash_digest\"> message lists background completions that were recorded while no live session could receive them; treat every entry as a final result (an entry with outcome=lost has an unknown outcome — inspect its log instead of assuming success).",
			"Do not use bash for interactive commands that require stdin unless the user explicitly asks for that behavior.",
		],
		parameters: Type.Object({
			...inner.parameters.properties,
			background: Type.Optional(Type.Boolean({ description: "Run immediately in the background and return a job id" })),
		}),
		// pi's fields plus ours: a promoted call has no exit code yet, and every
		// result carries a job id, so programmatic callers (codemode reads
		// `structuredContent` verbatim) get an honest object instead of pi's
		// `{exit_code: 0, full_output_path: <pi temp file>}`.
		outputSchema: Type.Object({
			...(inner.outputSchema as TObject).properties,
			exit_code: Type.Optional(Type.Number({ description: "Absent when job_id is set: the command is still running" })),
			job_id: Type.Optional(
				Type.String({ description: "Background handle for pbb list/status/tail/kill and the completion follow-up" }),
			),
		}),
		async execute(
			toolCallId,
			params: { command: string; timeout?: number; background?: boolean },
			signal,
			onUpdate,
			ctx,
		): Promise<AgentToolResult<BashToolDetails | BackgroundBashDetails>> {
			const cwd = ctx?.cwd ?? process.cwd();
			const autoAfterSeconds = getAutoBackgroundAfterSeconds(cwd);
			const maxLogBytes = getMaxLogBytes(cwd);
			const immediate = params.background === true;

			if (signal?.aborted) throw new Error("Command aborted");
			if (session.activeJobs.size >= MAX_ACTIVE_JOBS) {
				throw new Error(
					`Too many bash jobs running (${session.activeJobs.size}/${MAX_ACTIVE_JOBS}). Wait for one to finish before starting another.`,
				);
			}

			// Every call gets a job id up front: it names the log file, which is
			// written from the moment the command is spawned (Decision 2: the full
			// output always exists as a file). A call that finishes in the foreground
			// leaves no job record behind, so `pbb list` only ever shows jobs.
			const pbb = pbbIdentity(ctx, session.id);
			const job: ActiveJob = {
				id: "",
				session,
				command: params.command,
				toolCallId,
				startedAt: Date.now(),
				cwd,
				pbb,
				repairContext: ctx,
				timeoutSeconds: params.timeout,
			};
			job.id = allocateJobId(session, pbb);
			job.logPath = logPathFor(job);
			session.activeJobs.set(job.id, job);

			// Promotion ran: the tool call has its answer, so the job record can no
			// longer race a completion that arrives later.
			const onPromote = (elapsedMs: number, log: LogStats) => {
				job.logBytes = log.bytes;
				job.logTruncated = log.truncated;
				recordPbbJobStarted(job, cwd, {
					promotedAt: new Date().toISOString(),
					promotedAfterSeconds: Math.round(elapsedMs / 100) / 10,
					promotionThresholdSeconds: immediate ? 0 : autoAfterSeconds,
				});
				session.pending.start({
					id: job.id,
					text: job.command,
					startedAt: job.startedAt,
					details: { toolCallId: job.toolCallId },
				});
				scheduleDetachedBackgroundToolResultRepair(ctx, toolCallId);
			};

			// Exit detection for a promoted job. `signalCode` means one of our kills
			// (`pbb kill`, timeout, session shutdown) — never a fabricated exit.
			const onExit = (exit: PromotedExit) => {
				if (exit.error !== undefined) {
					job.errorMessage = exit.error instanceof Error ? exit.error.message : String(exit.error);
					finishBackgroundJob(session, job, { outcome: "error", exitCode: null }, cwd);
					return;
				}
				const outcome = exit.timedOut ? "timeout" : exit.signalCode || job.abortRequested ? "abort" : "exit";
				finishBackgroundJob(session, job, { outcome, exitCode: exit.code }, cwd);
			};

			const bashExec = createBashExec({
				logPath: job.logPath,
				maxLogBytes,
				spawnEnv: (base) => pbbSpawnEnv(pbb, base),
				promoteImmediately: immediate,
				// The cap is a disk budget, not a silence: a running job's record learns
				// about it as soon as it happens, so `pbb status` can say so.
				onLogCapped(log: LogStats) {
					job.logBytes = log.bytes;
					job.logTruncated = true;
					if (job.promoted) patchPbbJobFile(job, { logBytes: log.bytes, logTruncated: true });
				},
				onSpawn(child) {
					job.child = child;
					job.pid = child.pid ?? undefined;
					job.pgid = child.pid ?? undefined;
				},
				onPromote,
				onExit,
			});

			const delegate = createBashToolDefinition(cwd, { operations: { exec: bashExec.exec } });
			const resultPromise = delegate.execute(
				toolCallId,
				{ command: params.command, ...(params.timeout === undefined ? {} : { timeout: params.timeout }) },
				signal,
				onUpdate as AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
				ctx,
			);
			// Settle-shaped, so a promotion win can never leave an unhandled rejection.
			const settledResult = resultPromise.then(
				(result) => ({ result }) as const,
				(error: unknown) => ({ error }) as const,
			);

			let finished: Awaited<typeof settledResult>;
			if (immediate || autoAfterSeconds <= 0) {
				finished = await settledResult;
			} else {
				const raced = await Promise.race([
					settledResult,
					waitForBackgroundThreshold(autoAfterSeconds).then(() => "promote" as const),
				]);
				if (raced === "promote") {
					// The threshold won: promote (a command that just ended finishes
					// normally instead) and take whatever pi's call returns.
					bashExec.promote();
					finished = await settledResult;
				} else {
					finished = raced;
				}
			}

			if (bashExec.promoted) {
				// The job is ours now; its completion arrives on `onExit`.
				return promotedToolResult(job, "result" in finished ? finished.result : undefined, immediate ? undefined : autoAfterSeconds);
			}

			session.activeJobs.delete(job.id);
			if ("error" in finished) {
				// Foreground failure: nothing can read the log any more, and pi's
				// message already carries the output plus the status.
				discardJobLog(job);
				throw finished.error;
			}
			return foregroundToolResult(job, finished.result) as AgentToolResult<BashToolDetails | BackgroundBashDetails>;
		},
	});
}
