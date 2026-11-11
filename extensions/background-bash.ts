import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { AgentToolUpdateCallback, BashToolDetails, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { createPiPending, type PiPendingRegistry } from "pi-pending";
import { formatTruncationNotice, piContext, truncateContextText } from "./pi-context-utils.ts";
import { Type } from "typebox";

const MAX_ACTIVE_JOBS = 10;
const MAX_RESULT_LINES = 2000;
const MAX_RESULT_BYTES = 50 * 1024;
const DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS = 30;
const CUSTOM_TYPE = "background_bash_result";
// A detached descendant that inherits stdout/stderr keeps Node's `close` from
// firing even though the command exited. pi core fixed the same bug
// (utils/child-process.ts, earendil-works/pi#5303) by resolving on `exit` plus an
// idle grace re-armed on every chunk; pbb uses a slightly longer window than
// core's 100ms because `pbb tail --full` recovers anything the grace truncates.
const EXIT_STDIO_GRACE_MS = 750;
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

type BashParams = {
	command: string;
	timeout?: number;
	background?: boolean;
};

type CompletedBashRun =
	| {
			status: "success";
			result: AgentToolResult<BashToolDetails>;
			body: string;
			details: BashToolDetails | undefined;
			outcome: "exit";
			exitCode: 0;
	  }
	| {
			status: "error";
			error: unknown;
			body: string;
			details: BashToolDetails | undefined;
			outcome: Outcome;
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
	abortController: AbortController;
	startedAt: number;
	cwd?: string;
	pbb?: PbbIdentity;
	lastLoggedBody?: string;
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
};

const schema = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
	background: Type.Optional(Type.Boolean({ description: "Run immediately in the background and return a job id" })),
});

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

function getText(result: AgentToolResult<unknown>): string {
	return result.content
		.map((part) => {
			if (part?.type === "text" && typeof part.text === "string") return part.text;
			try {
				return JSON.stringify(part);
			} catch {
				return String(part);
			}
		})
		.join("\n");
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function readConfigFile(path: string): BackgroundBashConfig {
	try {
		if (!existsSync(path)) return {};
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		const raw = (parsed as { autoBackgroundAfterSeconds?: unknown }).autoBackgroundAfterSeconds;
		return typeof raw === "number" && Number.isFinite(raw) ? { autoBackgroundAfterSeconds: raw } : {};
	} catch {
		return {};
	}
}

function getAutoBackgroundAfterSeconds(cwd?: string): number {
	const globalConfig = readConfigFile(join(homedir(), ".pi-background-bash", "config.json"));
	const projectConfig = cwd ? readConfigFile(join(cwd, ".pi", "background-bash.json")) : {};
	return projectConfig.autoBackgroundAfterSeconds ?? globalConfig.autoBackgroundAfterSeconds ?? DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS;
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
 */
function pbbSpawnEnv(id: PbbIdentity | undefined): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
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
		logPath: join(pbbLogsDir(job.pbb), `${job.id}.log`),
		lastEventId: job.lastEventId,
		...patch,
	});
}

function recordPbbJobStarted(job: ActiveJob, cwd: string): void {
	if (!job.pbb) return;
	job.cwd = cwd;
	mkdirSync(pbbLogsDir(job.pbb), { recursive: true });
	writeFileSync(join(pbbLogsDir(job.pbb), `${job.id}.log`), "");
	job.lastLoggedBody = undefined;
	appendPbbEvent(job, "job.started", { command: job.command, cwd });
	writePbbJob(job, { cwd, status: "running", outcome: "running" });
}

function appendPbbLogDelta(job: ActiveJob, body: string): void {
	if (!job.pbb || !body || body === job.lastLoggedBody) return;
	if (job.lastLoggedBody && body.trimEnd() === job.lastLoggedBody.trimEnd()) {
		job.lastLoggedBody = body;
		return;
	}
	let delta = body;
	if (job.lastLoggedBody && body.startsWith(job.lastLoggedBody)) {
		delta = body.slice(job.lastLoggedBody.length);
	} else if (job.lastLoggedBody) {
		delta = `\n[pbb: output snapshot replaced]\n${body}`;
	}
	job.lastLoggedBody = body;
	if (!delta) return;
	mkdirSync(pbbLogsDir(job.pbb), { recursive: true });
	appendFileSync(join(pbbLogsDir(job.pbb), `${job.id}.log`), delta);
	appendPbbEvent(job, "job.output", { bytes: Buffer.byteLength(delta) });
	writePbbJob(job, { status: "running", outcome: "running", updatedAt: new Date().toISOString() });
}

/**
 * Persist the real outcome. `delivered` starts false so the reconcile sweep can
 * tell "recorded but never reached the agent" apart from "delivered".
 */
function recordPbbJobCompleted(job: ActiveJob, completed: CompletedBashRun, cwd: string, durationMs: number): void {
	if (!job.pbb) return;
	appendPbbLogDelta(job, completed.body);
	appendPbbEvent(job, "job.completed", { outcome: completed.outcome, exitCode: completed.exitCode, durationMs });
	writePbbJob(job, {
		cwd,
		status: completed.outcome === "exit" ? "exited" : completed.outcome,
		outcome: completed.outcome,
		exitCode: completed.exitCode,
		completedAt: new Date().toISOString(),
		durationMs,
		delivered: false,
		lastEventId: job.lastEventId,
	});
}

function handlePbbKillRequestsForSession(session: SessionState): void {
	for (const job of session.activeJobs.values()) {
		if (!job.pbb) continue;
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
			job.abortController.abort();
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

function rethrowBashError(completed: Extract<CompletedBashRun, { status: "error" }>, job?: ActiveJob): never {
	const body = truncateForegroundBody(job, completed.body);
	throw new Error(body || (completed.error instanceof Error ? completed.error.message : String(completed.error)));
}

function completionBody(output: string, suffix: string): string {
	return output ? `${output.replace(/\s*$/, "")}\n\n${suffix}` : suffix;
}

async function runPbbBash(
	job: ActiveJob,
	cwd: string,
	params: BashParams,
	onUpdate?: AgentToolUpdateCallback<BashToolDetails>,
): Promise<CompletedBashRun> {
	job.runner = "pbb";
	return new Promise((resolve) => {
		let output = "";
		let settled = false;
		let timedOut = false;
		let aborted = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let graceHandle: ReturnType<typeof setTimeout> | undefined;
		let exited = false;
		let exitCode: number | null = null;
		let exitSignal: NodeJS.Signals | null = null;
		let stdoutEnded = false;
		let stderrEnded = false;

		const child = spawn("bash", ["-lc", params.command], {
			cwd,
			env: pbbSpawnEnv(job.pbb),
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		job.child = child;
		job.pid = child.pid;
		job.pgid = child.pid;
		writePbbJob(job, { pid: child.pid, pgid: child.pid, runner: "pbb" });

		const clearGrace = () => {
			if (graceHandle) clearTimeout(graceHandle);
			graceHandle = undefined;
		};

		const finish = (completed: CompletedBashRun) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			timeoutHandle = undefined;
			clearGrace();
			// A descendant may still hold the pipes; we already have the output we are
			// going to report, so release the handles instead of waiting for `close`.
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(completed);
		};

		const complete = () => {
			if (settled || !exited) return;
			if (timedOut) {
				const body = completionBody(output, `Command timed out after ${params.timeout} seconds`);
				finish({ status: "error", error: new Error(body), body, details: undefined, outcome: "timeout", exitCode: null });
				return;
			}
			if (aborted || exitSignal) {
				const body = completionBody(output, "Command aborted");
				finish({ status: "error", error: new Error(body), body, details: undefined, outcome: "abort", exitCode: null });
				return;
			}
			if (exitCode === 0) {
				const result: AgentToolResult<BashToolDetails> = { content: output ? [{ type: "text", text: output.replace(/\s*$/, "") }] : [], details: {} as BashToolDetails };
				finish({ status: "success", result, body: getText(result), details: result.details, outcome: "exit", exitCode: 0 });
				return;
			}
			const code = exitCode ?? 1;
			const body = completionBody(output, `Command exited with code ${code}`);
			finish({ status: "error", error: new Error(body), body, details: undefined, outcome: "exit", exitCode: code });
		};

		const maybeComplete = () => {
			if (exited && !settled && stdoutEnded && stderrEnded) complete();
		};

		// Re-armed on every chunk: a descendant still writing keeps us reading, while
		// a quiet inherited handle releases us once the grace elapses.
		const armGrace = () => {
			clearGrace();
			graceHandle = setTimeout(() => complete(), EXIT_STDIO_GRACE_MS);
			graceHandle.unref?.();
		};

		const append = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			const text = truncateLiveBody(output.replace(/\s*$/, ""));
			onUpdate?.({ content: text ? [{ type: "text", text }] : [], details: {} as BashToolDetails });
			appendPbbLogDelta(job, output);
			if (exited && !settled) armGrace();
		};
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.stdout?.on("end", () => {
			stdoutEnded = true;
			maybeComplete();
		});
		child.stderr?.on("end", () => {
			stderrEnded = true;
			maybeComplete();
		});

		const abort = () => {
			aborted = true;
			killProcessGroup(child.pid, job.killSignal ?? "SIGTERM");
			setTimeout(() => {
				if (!settled && job.killSignal !== "SIGKILL") killProcessGroup(child.pid, "SIGKILL");
			}, 500).unref?.();
		};
		if (job.abortController.signal.aborted) abort();
		else job.abortController.signal.addEventListener("abort", abort, { once: true });

		if (params.timeout && params.timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				killProcessGroup(child.pid, "SIGTERM");
				setTimeout(() => {
					if (!settled) killProcessGroup(child.pid, "SIGKILL");
				}, 500).unref?.();
			}, params.timeout * 1000);
			timeoutHandle.unref?.();
		}

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			clearGrace();
			resolve({ status: "error", error, body: error.message, details: undefined, outcome: "error", exitCode: null });
		});

		child.on("exit", (code, signalName) => {
			exited = true;
			exitCode = code;
			exitSignal = signalName;
			maybeComplete();
			if (!settled) armGrace();
		});

		child.on("close", (code, signalName) => {
			if (!exited) {
				exited = true;
				exitCode = code;
				exitSignal = signalName;
			}
			complete();
		});
	});
}

function shouldTruncateBody(body: string): boolean {
	return Boolean(truncateContextText(body, { mode: "tail", maxLines: MAX_RESULT_LINES, maxBytes: MAX_RESULT_BYTES, appendNotice: false }).truncation?.truncated);
}

function escapePiContextClosingTags(text: string): string {
	return text.replace(/<\/pi_context>/gi, "<\\/pi_context>");
}

function addFullOutputHintToNotice(notice: string, fullOutputHint: string): string {
	return notice.endsWith("]") ? `${notice.slice(0, -1)}. Full output: ${fullOutputHint}]` : `${notice} Full output: ${fullOutputHint}`;
}

function truncateBodyWithHint(body: string, fullOutputHint: string): string {
	const { content, truncation } = truncateContextText(body, { mode: "tail", maxLines: MAX_RESULT_LINES, maxBytes: MAX_RESULT_BYTES, appendNotice: false });
	if (!truncation?.truncated) return body;
	return `${escapePiContextClosingTags(content)}\n\n${addFullOutputHintToNotice(formatTruncationNotice(truncation, "tail"), fullOutputHint)}`;
}

function trimOversizedToolResultsForContext(messages: AgentMessage[]): AgentMessage[] | undefined {
	let changed = false;
	const next = messages.map((message) => {
		const record = asRecord(message);
		if (record?.role !== "toolResult") return message;
		const content = Array.isArray(record.content) ? record.content : [];
		let contentChanged = false;
		const nextContent = content.map((part) => {
			const item = asRecord(part);
			if (item?.type !== "text" || typeof item.text !== "string" || !shouldTruncateBody(item.text)) return part;
			contentChanged = true;
			const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
			return {
				...part,
				text: truncateBodyWithHint(item.text, `${toolName} result trimmed by pi-background-bash context guard`),
			};
		});
		if (!contentChanged) return message;
		changed = true;
		return { ...message, content: nextContent } as AgentMessage;
	});
	return changed ? next : undefined;
}

function writeForegroundFullOutput(body: string): string {
	const dir = join(homedir(), ".pi", "pbb", "truncated");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.log`);
	writeFileSync(path, body);
	return path;
}

function truncateForegroundBody(job: ActiveJob | undefined, body: string): string {
	if (!shouldTruncateBody(body)) return body;
	const fullOutputHint = job?.pbb ? `pbb tail ${job.id} --full` : writeForegroundFullOutput(body);
	return truncateBodyWithHint(body, fullOutputHint);
}

function truncateLiveBody(body: string): string {
	if (!shouldTruncateBody(body)) return body;
	return truncateBodyWithHint(body, "final tool result/full-output snapshot");
}

function truncateBackgroundBody(job: ActiveJob, body: string): string {
	const fullOutputHint = job.pbb ? `pbb tail ${job.id} --full` : writeForegroundFullOutput(body);
	return truncateBodyWithHint(body, fullOutputHint);
}

function truncateForegroundResult(job: ActiveJob, completed: Extract<CompletedBashRun, { status: "success" }>): AgentToolResult<BashToolDetails> {
	const body = truncateForegroundBody(job, completed.body);
	return { content: body ? [{ type: "text", text: body }] : [], details: completed.result.details };
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
function finishBackgroundJob(session: SessionState, job: ActiveJob, completed: CompletedBashRun, cwd: string): void {
	const durationMs = Date.now() - job.startedAt;
	session.activeJobs.delete(job.id);
	session.pending.finish(job.id);

	recordPbbJobCompleted(job, completed, cwd, durationMs);

	if (session.shuttingDown) {
		patchPbbJobFile(job, { delivered: false, droppedReason: "session_shutdown", droppedAt: new Date().toISOString() });
		appendPbbEvent(job, "job.completion_deferred", { reason: "session_shutdown" });
		return;
	}

	const body = truncateBackgroundBody(job, completed.body);
	const content = buildXmlResult(job, completed.outcome, completed.exitCode, durationMs, body);
	const details: BackgroundBashDetails = {
		...(completed.details ?? {}),
		jobId: job.id,
		command: job.command,
		outcome: completed.outcome,
		exitCode: completed.exitCode,
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

function jobTimestamp(job: Record<string, unknown>): number {
	const raw = typeof job.completedAt === "string" ? job.completedAt : typeof job.startedAt === "string" ? job.startedAt : undefined;
	const parsed = raw ? Date.parse(raw) : NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

function tailOfLog(path: unknown, lines = RECONCILE_LOG_TAIL_LINES): string {
	if (typeof path !== "string") return "";
	try {
		if (!existsSync(path)) return "";
		const text = readFileSync(path, "utf8");
		const wanted = text.split(/\r?\n/).filter((line, index, all) => line.length > 0 || index < all.length - 1).slice(-lines);
		return wanted.join("\n").slice(-1600);
	} catch {
		return "";
	}
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
		body: escapePiContextClosingTags(truncateBodyWithHint(body, "pbb tail <job> --scope session --full")),
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
		job.abortController.abort();
		if (job.runner === "pbb") killProcessGroup(job.pgid ?? job.pid, "SIGTERM");
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

function maxJobNumberOnDisk(dir: string): number {
	let max = 0;
	try {
		if (!existsSync(dir)) return 0;
		for (const item of readdirSync(dir)) {
			const n = parseJobNumber(item.replace(/\.json$/, ""));
			if (n !== undefined) max = Math.max(max, n);
		}
	} catch {
		// Unreadable directory: fall back to the in-memory counter.
	}
	return max;
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
	const next = Math.max(jobNumberByDir.get(dir) ?? 0, maxJobNumberOnDisk(dir), session.jobNumberFloor) + 1;
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
		session.jobNumberFloor = Math.max(session.jobNumberFloor, sessionJobNumberFloor(ctx));
		pruneDeadSessions(session);
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

	pi.on("context", (event) => {
		const messages = trimOversizedToolResultsForContext(event.messages);
		if (messages) return { messages };
	});

	pi.registerTool({
		name: "bash",
		label: "bash",
		description: `Execute a bash command in the current working directory. Returns stdout and stderr. Verbose background results are truncated with the full output available through pbb tail. Set background: true to run immediately in the background and get a job id. Otherwise, if the command is still running after the configured auto-background threshold (${formatThreshold(DEFAULT_AUTO_BACKGROUND_AFTER_SECONDS)} by default), it is automatically moved to the background; a <pi_context source="pi-background-bash" kind="background_bash_result"> message is injected when it finishes. Optionally provide a timeout in seconds.`,
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
		parameters: schema,
		async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<BashToolDetails | BackgroundBashDetails>> {
			const autoAfterSeconds = getAutoBackgroundAfterSeconds(ctx.cwd);

			if (signal?.aborted) {
				throw new Error("Command aborted");
			}

			if (params.background) {
				if (session.activeJobs.size >= MAX_ACTIVE_JOBS) {
					throw new Error(`Too many bash jobs running (${session.activeJobs.size}/${MAX_ACTIVE_JOBS}). Wait for one to finish before starting another.`);
				}

				const job: ActiveJob = {
					id: "",
					session,
					command: params.command,
					toolCallId,
					abortController: new AbortController(),
					startedAt: Date.now(),
					cwd: ctx.cwd,
					pbb: pbbIdentity(ctx, session.id),
					runner: "pbb",
					repairContext: ctx,
				};
				job.id = allocateJobId(session, job.pbb);
				session.activeJobs.set(job.id, job);
				recordPbbJobStarted(job, ctx.cwd);
				session.pending.start({
					id: job.id,
					text: job.command,
					startedAt: job.startedAt,
					details: { toolCallId: job.toolCallId },
				});

				const completedPromise = runPbbBash(job, ctx.cwd, params);
				// Capture cwd eagerly: the completion callback may fire after session
				// teardown (headless one-shot exit), when ctx.cwd access throws.
				const jobCwd = ctx.cwd;
				void completedPromise.then((completed) => {
					finishBackgroundJob(session, job, completed, jobCwd);
				});
				scheduleDetachedBackgroundToolResultRepair(ctx, toolCallId);

				return {
					content: [{ type: "text", text: `Bash job ${job.id} started in background. A follow-up result will arrive when it finishes; continue independent work. Use pbb only if you need progress before completion.` }],
					details: runningJobDetails(job, ctx.cwd),
				};
			}

			if (autoAfterSeconds <= 0) {
				const job: ActiveJob = {
					id: `fg_${toolCallId}`,
					session,
					command: params.command,
					toolCallId,
					abortController: new AbortController(),
					startedAt: Date.now(),
					runner: "pbb",
				};
				session.activeJobs.set(job.id, job);
				const forwardAbort = () => job.abortController.abort();
				if (signal?.aborted) forwardAbort();
				else signal?.addEventListener("abort", forwardAbort, { once: true });
				try {
					const completed = await runPbbBash(job, ctx.cwd, params, onUpdate);
					if (completed.status === "success") return truncateForegroundResult(job, completed);
					rethrowBashError(completed, job);
				} finally {
					signal?.removeEventListener("abort", forwardAbort);
					session.activeJobs.delete(job.id);
				}
			}

			if (session.activeJobs.size >= MAX_ACTIVE_JOBS) {
				throw new Error(`Too many bash jobs running (${session.activeJobs.size}/${MAX_ACTIVE_JOBS}). Wait for one to finish before starting another.`);
			}

			const job: ActiveJob = {
				// Foreground bash calls should not consume visible bg001 IDs unless they
				// actually cross the threshold and become background jobs.
				id: `auto_${toolCallId}`,
				session,
				command: params.command,
				toolCallId,
				abortController: new AbortController(),
				startedAt: Date.now(),
				repairContext: ctx,
			};
			session.activeJobs.set(job.id, job);

			let backgrounded = false;
			const forwardAbort = () => {
				if (!backgrounded) job.abortController.abort();
			};
			if (signal?.aborted) forwardAbort();
			else signal?.addEventListener("abort", forwardAbort, { once: true });

			let latestBody = "";
			const completedPromise = runPbbBash(job, ctx.cwd, params, (update) => {
				latestBody = getText(update);
				if (!backgrounded) onUpdate?.(update);
			});

			const winner = await Promise.race([completedPromise, waitForBackgroundThreshold(autoAfterSeconds)]);
			if (winner !== "background") {
				signal?.removeEventListener("abort", forwardAbort);
				session.activeJobs.delete(job.id);
				if (winner.status === "success") return truncateForegroundResult(job, winner);
				rethrowBashError(winner, job);
			}

			backgrounded = true;
			signal?.removeEventListener("abort", forwardAbort);
			session.activeJobs.delete(job.id);
			job.cwd = ctx.cwd;
			job.pbb = pbbIdentity(ctx, session.id);
			job.id = allocateJobId(session, job.pbb);
			session.activeJobs.set(job.id, job);
			recordPbbJobStarted(job, ctx.cwd);
			appendPbbLogDelta(job, latestBody);
			session.pending.start({
				id: job.id,
				text: job.command,
				startedAt: job.startedAt,
				details: { toolCallId: job.toolCallId },
			});

			// Capture cwd eagerly: the completion callback may fire after session
			// teardown (headless one-shot exit), when ctx.cwd access throws.
			const jobCwd = ctx.cwd;
			void completedPromise.then((completed) => {
				finishBackgroundJob(session, job, completed, jobCwd);
			});
			scheduleDetachedBackgroundToolResultRepair(ctx, toolCallId);

			return {
				content: [{ type: "text", text: `Bash job ${job.id} moved to background after ${formatThreshold(autoAfterSeconds)}. A follow-up result will arrive when it finishes; continue independent work. Use pbb only if you need progress before completion.` }],
				details: runningJobDetails(job, ctx.cwd),
			};
		},
	});
}
