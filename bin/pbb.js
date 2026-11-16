#!/usr/bin/env node
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const DEFAULT_TAIL_LINES = 80;
/**
 * How many `pil` probes may be in flight during a whole-root sweep.
 *
 * `pil instances` is session-scoped (it reads one session's instance records and
 * takes the session from the environment), so a sweep needs one call per session.
 * Sequentially that was 514 process spawns in a row: `pbb list --all` took 65-147 s
 * on a root with 500+ sessions. Probing is therefore off by default for `--all`
 * (see `attachOwnerLiveness`) and, when asked for with `--owner`, bounded.
 */
const OWNER_PROBE_CONCURRENCY = 8;
const HERE = dirname(fileURLToPath(import.meta.url));
// The non-hoisted copy of pi-lane. Kept last: it only exists when this package
// was installed into its own directory, not in the npm install layout pi uses.
const NESTED_PIL_BIN = join(HERE, "..", "node_modules", "pi-lane", "bin", "pil.js");

function attr(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;");
}

function escapeBody(value) {
  return String(value ?? "").replace(/<\/pi_context>/gi, "<\\/pi_context>");
}

function context(kind, attrs, body) {
  const renderedAttrs = Object.entries({ source: "pbb", kind, schema_version: SCHEMA_VERSION, ...attrs })
    .filter(([, value]) => value !== undefined && value !== null && value !== false)
    .map(([key, value]) => `${key}="${attr(value)}"`)
    .join(" ");
  return `<pi_context ${renderedAttrs}>\n${escapeBody(body)}\n</pi_context>`;
}

function stripInternal(value) {
  if (Array.isArray(value)) return value.map(stripInternal);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith("_")) continue;
      out[key] = stripInternal(item);
    }
    return out;
  }
  return value;
}

function json(value) {
  return JSON.stringify(stripInternal(value), null, 2);
}

function identity() {
  const sessionKey = process.env.PI_LANE_SESSION_KEY || process.env.PBB_SESSION_KEY;
  const instanceId = process.env.PI_LANE_INSTANCE_ID || process.env.PBB_INSTANCE_ID;
  const root = process.env.PBB_ROOT || join(homedir(), ".pi", "pbb");
  return {
    sessionId: process.env.PI_LANE_SESSION_ID || process.env.PBB_SESSION_ID || "",
    sessionKey: sessionKey || "",
    sessionFile: process.env.PI_LANE_SESSION_FILE || process.env.PBB_SESSION_FILE || "",
    instanceId: instanceId || "",
    lane: process.env.PI_LANE_CURRENT_LANE || process.env.PBB_LANE || "",
    laneRoot: process.env.PI_LANE_ROOT || "",
    root,
    scopeDefault: "current-instance",
    hasLaneEnv: Boolean(process.env.PI_LANE_SESSION_KEY && process.env.PI_LANE_INSTANCE_ID),
  };
}

function requireIdentity(id) {
  if (!id.sessionKey || !id.instanceId) {
    console.error(context("pbb.error", { scope: "none", error: "missing_identity" }, "pbb cannot determine current Pi lane identity.\nRun inside Pi with pi-lane installed, or set PI_LANE_SESSION_KEY and PI_LANE_INSTANCE_ID."));
    process.exit(3);
  }
}

function sessionDir(id) {
  return join(id.root, "sessions", id.sessionKey);
}

function instanceDir(id, instanceId = id.instanceId) {
  return join(sessionDir(id), "instances", instanceId);
}

function requestsDir(id, instanceId = id.instanceId) {
  return join(instanceDir(id, instanceId), "requests");
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

let pilInstancesCache;

/**
 * Where pi-lane's `pil` CLI lives.
 *
 * `<pkg>/node_modules/pi-lane/bin/pil.js` is only true of a non-hoisted install.
 * pi's npm install (`pi install npm:pi-background-bash`) puts this package and
 * its dependencies side by side under `~/.config/pi/npm/node_modules`, so the
 * nested path does not exist there and every command used to exit 4
 * `pi_lane_unavailable` — in the README's own recommended install path. Use
 * Node's module resolution instead, which walks up to the hoisted location.
 */
function pilBinCandidates() {
  const candidates = [];
  try {
    const require = createRequire(import.meta.url);
    try {
      candidates.push(require.resolve("pi-lane/bin/pil.js"));
    } catch {
      // pi-lane's `exports` map does not expose `bin/pil.js` (only "." and
      // "./runtime"), so resolve the package entry and walk up to its root.
      let dir = dirname(require.resolve("pi-lane"));
      for (let depth = 0; depth < 4 && dir !== dirname(dir); depth += 1) {
        const manifest = join(dir, "package.json");
        if (existsSync(manifest)) {
          try {
            if (JSON.parse(readFileSync(manifest, "utf8")).name === "pi-lane") {
              candidates.push(join(dir, "bin", "pil.js"));
              break;
            }
          } catch {
            // Unreadable manifest: keep walking up.
          }
        }
        dir = dirname(dir);
      }
    }
  } catch {
    // pi-lane is not resolvable at all (pruned install): the nested path is next.
  }
  candidates.push(NESTED_PIL_BIN);
  return [...new Set(candidates)];
}

function failPil(id, message, error) {
  const detail = error instanceof Error ? error.message : String(error || "");
  console.error(context("pbb.error", {
    session_key: id.sessionKey,
    instance_id: id.instanceId,
    error: "pi_lane_unavailable",
  }, `${message}${detail ? `\n${detail}` : ""}`));
  process.exit(4);
}

function pilCommand(id) {
  if (process.env.PBB_PIL_BIN) return { file: process.env.PBB_PIL_BIN, args: [] };
  const candidates = pilBinCandidates();
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    failPil(
      id,
      `cannot find pi-lane's pil CLI (looked in: ${candidates.join(", ")}).\npi-lane is a dependency of pi-background-bash, so this is a broken install: reinstall the package (\`npm install\` inside it, or \`pi install npm:pi-background-bash\`), or set PBB_PIL_BIN to the path of pi-lane's bin/pil.js.`,
    );
  }
  return { file: process.execPath, args: [found] };
}

/**
 * pi-lane's per-session instance records. Cached per session key, because
 * `--scope all` asks for the liveness of instances in sessions other than this one.
 */
function readPilInstances(id, sessionKey = id.sessionKey) {
  if (pilInstancesCache === undefined) pilInstancesCache = new Map();
  const cached = pilInstancesCache.get(sessionKey);
  if (cached !== undefined) return cached;
  const pil = pilCommand(id);
  let instances;
  try {
    const raw = execFileSync(pil.file, [...pil.args, "instances", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: pilEnv(id, sessionKey),
    });
    instances = JSON.parse(raw).instances || [];
  } catch (error) {
    failPil(id, "tracked pi-lane pil command failed", error);
  }
  pilInstancesCache.set(sessionKey, instances);
  return instances;
}

function pilEnv(id, sessionKey) {
  return {
    ...process.env,
    PI_LANE_ROOT: id.laneRoot || process.env.PI_LANE_ROOT || "",
    PI_LANE_SESSION_KEY: sessionKey,
    PI_LANE_SESSION_ID: id.sessionId,
    PI_LANE_SESSION_FILE: id.sessionFile,
    PI_LANE_INSTANCE_ID: id.instanceId,
    PI_LANE_CURRENT_LANE: id.lane,
  };
}

/** Where pi-lane keeps its per-session instance records (same default as pil). */
function laneRootDir(id) {
  return id.laneRoot || process.env.PI_LANE_ROOT || join(homedir(), ".pi", "lane");
}

/**
 * Does pi-lane have instance records for this session at all?
 *
 * A sweep over hundreds of sessions must not spawn `pil` for a session pi-lane
 * never recorded: the process would only report an empty list. Checking the
 * directory is the same read pil would do, without the process. Deliberately NOT
 * used for the current session, where a broken `pil` install has to stay visible
 * (`pi_lane_unavailable`, exit 4).
 */
function laneSessionRecorded(id, sessionKey) {
  return existsSync(join(laneRootDir(id), "sessions", sessionKey, "instances"));
}

/**
 * The same probe, without blocking the whole sweep: a `--all --owner` pass runs
 * hundreds of these through a bounded pool (`mapWithConcurrency`).
 */
function readPilInstancesAsync(id, sessionKey = id.sessionKey) {
  // The current session keeps the synchronous path: a broken `pil` install must
  // stay visible (`pi_lane_unavailable`, exit 4) in the everyday narrow view, not
  // be skipped by the sweep's cheap "pi-lane never recorded this session" check.
  if (sessionKey === id.sessionKey) return Promise.resolve(readPilInstances(id, sessionKey));
  if (pilInstancesCache === undefined) pilInstancesCache = new Map();
  const cached = pilInstancesCache.get(sessionKey);
  if (cached !== undefined) return Promise.resolve(cached);
  if (!laneSessionRecorded(id, sessionKey)) {
    pilInstancesCache.set(sessionKey, []);
    return Promise.resolve([]);
  }
  const pil = pilCommand(id);
  return new Promise((resolve) => {
    execFile(pil.file, [...pil.args, "instances", "--json"], {
      encoding: "utf8",
      env: pilEnv(id, sessionKey),
    }, (error, stdout) => {
      if (error) {
        // Same hard failure as the sync path: a broken install must not quietly
        // degrade liveness to `unknown`.
        failPil(id, "tracked pi-lane pil command failed", error);
      }
      const instances = JSON.parse(stdout).instances || [];
      pilInstancesCache.set(sessionKey, instances);
      resolve(instances);
    });
  });
}

/** `map`, with at most `limit` promises in flight. */
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return out;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the pid exists but belongs to another user — still alive.
    return error?.code === "EPERM";
  }
}

/**
 * When a pid was reused by an unrelated process, `kill(pid, 0)` would report a
 * dead owner as live. /proc/<pid>/stat's start time settles it (Linux only).
 */
function processStartMs(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = Number(fields[19]);
    const uptimeSeconds = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    if (!Number.isFinite(startTicks) || !Number.isFinite(uptimeSeconds)) return undefined;
    return Date.now() - (uptimeSeconds - startTicks / 100) * 1000;
  } catch {
    return undefined;
  }
}

function ownerPidOf(job, record) {
  const recorded = Number(record?.pid);
  if (Number.isInteger(recorded) && recorded > 0) return recorded;
  // Older/foreign instance dirs carry no identity.json: the fallback instance id
  // itself is `pbb_<pid>_<hash>` and still names the owning pi process.
  const match = /^pbb_(\d+)_/.exec(String(job.instanceId ?? ""));
  return match ? Number(match[1]) : undefined;
}

/**
 * Owner liveness from two sources, in order:
 *
 *  1. pi-lane's instance record (heartbeat/status) — authoritative when pi-lane is
 *     installed; `stale` keeps its pi-lane meaning (record exists, heartbeat old).
 *  2. the instance's own `identity.json` pid, written by the extension whenever it
 *     records a job event. `kill(pid, 0)` answers "is that pi process still there".
 *     This is the common case on installs without pi-lane, where the instance id is
 *     the `pbb_<pid>_<hash>` fallback and there is no lane record to read.
 *
 * When neither source can answer, the owner is `unknown` — never `stale`: pbb not
 * being able to see liveness is not evidence that the owner is gone.
 */
function ownerInfo(id, job, sessionKey = id.sessionKey, laneInstances) {
  const instances = laneInstances ?? readPilInstances(id, sessionKey);
  const lane = instances.find((item) => item.instanceId === job.instanceId);
  const seen = { ownerLastSeenAt: lane?.lastSeenAt || "", ownerLastSeenAgeMs: lane?.lastSeenAgeMs };
  if (lane) {
    return {
      ...seen,
      ownerStatus: lane.status || "unknown",
      ownerLiveness: lane.live ? "live" : "stale",
      ownerLive: Boolean(lane.live),
      ownerStale: !lane.live,
      ownerSource: "pi-lane",
    };
  }
  const record = job.instanceId ? readJson(join(id.root, "sessions", sessionKey, "instances", job.instanceId, "identity.json")) : undefined;
  const pid = ownerPidOf(job, record);
  if (!pid) {
    return {
      ...seen,
      ownerStatus: "unknown",
      ownerLiveness: "unknown",
      ownerLive: false,
      ownerStale: true,
      ownerSource: "none",
      ownerNote: "no pi-lane instance record and no recorded owner pid",
    };
  }
  let alive = processAlive(pid);
  let note = alive ? undefined : `pid ${pid} is gone`;
  if (alive && record?.updatedAt) {
    const started = processStartMs(pid);
    const recordedAt = Date.parse(record.updatedAt);
    if (Number.isFinite(started) && Number.isFinite(recordedAt) && started > recordedAt + 2000) {
      alive = false;
      note = `pid ${pid} was reused by a newer process`;
    }
  }
  return {
    ...seen,
    ownerStatus: alive ? "alive" : "gone",
    ownerLiveness: alive ? "live" : "dead",
    ownerLive: alive,
    ownerStale: !alive,
    ownerSource: "instance-pid",
    ownerPid: pid,
    ...(note ? { ownerNote: note } : {}),
  };
}

/**
 * The owner fields of a job whose liveness was **not** probed (a whole-root
 * `--all` sweep, where probing every session costs one `pil` process each).
 *
 * Honesty rule: not probing is `unknown`, never `stale` — pbb not asking is not
 * evidence that the owner is gone. `ownerNote` says how to get the real answer.
 */
function unprobedOwnerInfo() {
  return {
    ownerStatus: "unknown",
    ownerLiveness: "unknown",
    ownerLive: false,
    ownerStale: false,
    ownerSource: "not-probed",
    ownerNote: "owner liveness not probed in a whole-root sweep; add --owner",
  };
}

/**
 * Attach owner liveness to a list of jobs.
 *
 * `probe: false` marks every job `unknown` without a single subprocess (the
 * `--all` default). `probe: true` probes once per *session* (never once per job),
 * bounded by `OWNER_PROBE_CONCURRENCY`, so `--all --owner` over 500 sessions stays
 * a few seconds instead of the minutes a sequential per-job pass took.
 */
async function attachOwnerLiveness(id, jobs, { probe }) {
  if (jobs.length === 0) return jobs;
  if (!probe) return jobs.map((job) => ({ ...job, ...unprobedOwnerInfo() }));
  const sessionKeys = [...new Set(jobs.map((job) => job.sessionKey ?? id.sessionKey))];
  const laneBySession = new Map();
  const probed = await mapWithConcurrency(sessionKeys, OWNER_PROBE_CONCURRENCY, (sessionKey) => readPilInstancesAsync(id, sessionKey));
  sessionKeys.forEach((sessionKey, index) => laneBySession.set(sessionKey, probed[index]));
  return jobs.map((job) => {
    const sessionKey = job.sessionKey ?? id.sessionKey;
    return { ...job, ...ownerInfo(id, job, sessionKey, laneBySession.get(sessionKey)) };
  });
}

/** Owner liveness for one already-selected job (status/kill need it, tail does not). */
function withOwnerInfo(id, job) {
  if (job.ownerLiveness !== undefined) return job;
  return { ...job, ...ownerInfo(id, job, job.sessionKey ?? id.sessionKey) };
}

const SCOPE_CURRENT = "current-instance";
const SCOPE_INSTANCE = "instance";
const SCOPE_SESSION = "session";
const SCOPE_ALL = "all";

function usageError(message) {
  console.error(context("pbb.error", { scope: "none", error: "usage" }, message));
  process.exit(2);
}

function normalizeScope(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "") return undefined;
  if (["current-instance", "current", "default", "this"].includes(value)) return SCOPE_CURRENT;
  if (["session", "this-session"].includes(value)) return SCOPE_SESSION;
  if (["all", "root"].includes(value)) return SCOPE_ALL;
  return null;
}

/**
 * Decision 3: the default view is THIS session + THIS instance. Widening is always
 * explicit — `--scope session` for every instance of this session, `--all` (or
 * `--scope all`) for every session under the root, for forensics.
 */
function resolveScope(opts) {
  if (opts.instance && opts.all) usageError("--instance cannot be combined with --all");
  const requested = normalizeScope(opts.scope);
  if (requested === null) usageError(`unknown scope: ${opts.scope} (use --scope current-instance|session|all, or --all)`);
  if (requested && opts.all && requested !== SCOPE_ALL) usageError(`--all conflicts with --scope ${opts.scope}`);
  if (opts.instance) return { scope: SCOPE_INSTANCE, instance: opts.instance };
  return { scope: requested === SCOPE_ALL || opts.all ? SCOPE_ALL : (requested ?? SCOPE_CURRENT) };
}

function readSessionKeys(id) {
  const dir = join(id.root, "sessions");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function readInstanceIds(id, sessionKey) {
  const dir = join(id.root, "sessions", sessionKey, "instances");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

function instanceTargets(id, scope, explicitInstance) {
  if (explicitInstance) return [{ sessionKey: id.sessionKey, instanceId: explicitInstance }];
  if (scope === SCOPE_CURRENT) return [{ sessionKey: id.sessionKey, instanceId: id.instanceId }];
  const sessionKeys = scope === SCOPE_ALL ? readSessionKeys(id) : [id.sessionKey];
  const targets = [];
  for (const sessionKey of sessionKeys) {
    for (const instanceId of readInstanceIds(id, sessionKey)) targets.push({ sessionKey, instanceId });
  }
  return targets;
}

function readJobs(id, { scope = SCOPE_CURRENT, instance } = {}) {
  const jobs = [];
  for (const target of instanceTargets(id, scope, instance)) {
    const dir = join(id.root, "sessions", target.sessionKey, "instances", target.instanceId, "jobs");
    if (!existsSync(dir)) continue;
    for (const item of readdirSync(dir)) {
      if (!item.endsWith(".json")) continue;
      const path = join(dir, item);
      const job = readJson(path);
      if (!job) continue;
      // Owner liveness is attached by the caller (`attachOwnerLiveness` /
      // `withOwnerInfo`): it costs one `pil` process per session, and a whole-root
      // sweep must not pay that per job.
      jobs.push({ ...job, sessionKey: job.sessionKey ?? target.sessionKey, _path: path });
    }
  }
  return jobs.sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? "")) || String(a.jobId).localeCompare(String(b.jobId)));
}

/** Human-readable line naming the scope that was actually applied. */
function describeScope(id, scope, instance) {
  if (scope === SCOPE_CURRENT) return `scope=current-instance — this session (${id.sessionKey}) + this instance (${id.instanceId})`;
  if (scope === SCOPE_INSTANCE) return `scope=instance — this session (${id.sessionKey}), instance ${instance} (picked with --instance)`;
  if (scope === SCOPE_SESSION) return `scope=session — all ${readInstanceIds(id, id.sessionKey).length} instance(s) of this session (${id.sessionKey})`;
  return `scope=all — every session under ${id.root} (${readSessionKeys(id).length} session(s))`;
}

/** How to see more than the current view — the narrow default must never read as "nothing running". */
function widenHint(id, scope) {
  if (scope === SCOPE_ALL) return "";
  const parts = [];
  if (scope === SCOPE_CURRENT || scope === SCOPE_INSTANCE) {
    parts.push(`--scope session (${readInstanceIds(id, id.sessionKey).length} instance(s) in this session)`);
  }
  parts.push(`--all (${readSessionKeys(id).length} session(s) under ${id.root})`);
  const hidden =
    scope === SCOPE_SESSION
      ? "jobs from other sessions are hidden from this view."
      : "jobs from sibling instances, sibling/subagent sessions and other sessions are hidden from this view.";
  return `Widen with ${parts.join(" or ")}: ${hidden}`;
}

function findJob(id, jobId, opts) {
  const jobs = readJobs(id, opts).filter((job) => job.jobId === jobId || job.globalJobId === jobId);
  if (jobs.length === 0) return { error: "missing", jobs };
  if (jobs.length > 1) return { error: "ambiguous", jobs };
  return { job: jobs[0], jobs };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--full") out.full = true;
    else if (arg === "--all") out.all = true;
    else if (arg === "--scope") out.scope = argv[++i];
    else if (arg === "--instance") out.instance = argv[++i];
    else if (arg === "--since" || arg === "--cursor") out.since = argv[++i];
    else if (arg === "--lines" || arg === "-n") out.lines = Number(argv[++i]);
    else if (arg === "--signal") out.signal = argv[++i];
    else if (arg === "--stale") out.stale = true;
    else if (arg === "--owner") out.owner = true;
    else out._.push(arg);
  }
  return out;
}

function printSelf(id, opts) {
  const payload = {
    kind: "pbb.self",
    schemaVersion: SCHEMA_VERSION,
    sessionId: id.sessionId,
    sessionKey: id.sessionKey,
    sessionFile: id.sessionFile,
    instanceId: id.instanceId,
    lane: id.lane,
    root: id.root,
    laneRoot: id.laneRoot,
    defaultScope: id.scopeDefault,
    hasLaneEnv: id.hasLaneEnv,
  };
  if (opts.json) return console.log(json(payload));
  console.log(context("pbb.self", {
    session_id: id.sessionId,
    session_key: id.sessionKey,
    session_file: id.sessionFile,
    instance_id: id.instanceId,
    lane: id.lane,
    scope: "current-instance",
  }, json(payload)));
}

function formatLogCap(job) {
  if (job?.logTruncated !== true) return "";
  const bytes = typeof job.logBytes === "number" ? job.logBytes : undefined;
  const size = bytes === undefined ? "" : ` at ${bytes >= 1048576 ? Math.round(bytes / 1048576) + " MB" : bytes + " bytes"}`;
  return `log capped${size}; output after the cap was not recorded`;
}

/**
 * The log's size right now. The job record's `logBytes` is a snapshot (refreshed
 * when the job finalizes); a running job's record is stale by definition, so
 * `pbb status` reads the file instead of repeating a frozen number.
 */
function liveLogBytes(job) {
  const path = job?.logPath;
  if (typeof path !== "string" || path === "") return undefined;
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

function formatJob(job) {
  const age = job.startedAt ? `${Math.max(0, Math.round((Date.now() - Date.parse(job.startedAt)) / 1000))}s` : "?";
  const exit = job.exitCode === undefined || job.exitCode === null ? "" : ` exit=${job.exitCode}`;
  const owner = job.ownerLive
    ? "owner=live"
    : `owner=${job.ownerLiveness || "stale"}${job.ownerLiveness === "stale" ? ` status=${job.ownerStatus || "unknown"}` : ` (${job.ownerNote || job.ownerSource || "unknown"})`}`;
  const pgid = job.pgid ? ` pgid=${job.pgid}` : "";
  const instance = job.instanceId === undefined ? "" : ` instance=${job.instanceId}`;
  return `- job=${job.jobId} global=${job.globalJobId} status=${job.status}${exit} age=${age}${instance} ${owner}${pgid} cmd=${JSON.stringify(job.command ?? "")}`;
}

/**
 * `pbb instances` lists instances, so its natural floor is this session (a listing
 * restricted to the current instance would be pointless); `--all` widens it to every
 * session under the root, and the output always says which of the two it is.
 */
function printInstances(id, opts) {
  const requested = normalizeScope(opts.scope);
  if (requested === null) usageError(`unknown scope: ${opts.scope} (use --scope session|all, or --all)`);
  if (opts.all && requested && requested !== SCOPE_ALL) usageError(`--all conflicts with --scope ${opts.scope}`);
  if (opts.instance) usageError("pbb instances takes --scope/--all, not --instance");
  const scope = opts.all || requested === SCOPE_ALL ? SCOPE_ALL : SCOPE_SESSION;
  const sessionKeys = scope === SCOPE_ALL ? readSessionKeys(id) : [id.sessionKey];
  // One `pil` call per session — bounded, never sequentially over every session.
  return mapWithConcurrency(sessionKeys, OWNER_PROBE_CONCURRENCY, (sessionKey) => readPilInstancesAsync(id, sessionKey)).then((recordsBySession) => {
    const instances = [];
    sessionKeys.forEach((sessionKey, index) => {
      for (const record of recordsBySession[index]) {
        instances.push({
          sessionKey,
          instanceId: record.instanceId,
          ownerLive: Boolean(record.live),
          ownerLiveness: record.live ? "live" : "stale",
          ownerStatus: record.status || "unknown",
          ownerLastSeenAt: record.lastSeenAt || "",
          lane: record.lane || "",
        });
      }
    });
    const payload = { kind: "pbb.instances", schemaVersion: SCHEMA_VERSION, sessionId: id.sessionId, sessionKey: id.sessionKey, instanceId: id.instanceId, lane: id.lane, scope, source: "pil", instances };
    if (opts.json) return console.log(json(payload));
    const line = scope === SCOPE_ALL ? `scope=all — pi-lane instances of every session under ${id.root} (${new Set(instances.map((item) => item.sessionKey)).size} session(s) with instances)` : `scope=session — pi-lane instances of this session (${id.sessionKey})`;
    const body = instances.map((item) => `- instance=${item.instanceId} live=${item.ownerLive} status=${item.ownerStatus} lane=${item.lane || ""} last_seen=${item.ownerLastSeenAt || "unknown"}${scope === SCOPE_ALL ? ` session=${item.sessionKey}` : ""}`).join("\n");
    console.log(context("pbb.instances", { session_id: id.sessionId, session_key: id.sessionKey, instance_id: id.instanceId, lane: id.lane, scope, source: "pil", instances: instances.length }, `${line}\n${body || "No instances in scope."}`));
  });
}

function scopeAttrs(id, scope, instance) {
  return {
    session_id: id.sessionId,
    session_key: id.sessionKey,
    instance_id: id.instanceId,
    lane: id.lane,
    scope,
    ...(scope === SCOPE_INSTANCE && instance ? { instance } : {}),
  };
}

function printList(id, opts) {
  const { scope, instance } = resolveScope(opts);
  const jobs = attachOwnerLiveness(id, readJobs(id, { scope, instance }), { probe: scope !== SCOPE_ALL || opts.owner === true });
  return jobs.then((probed) => printListWithJobs(id, opts, scope, instance, probed));
}

function printListWithJobs(id, opts, scope, instance, jobs) {
  const payload = { kind: "pbb.list", schemaVersion: SCHEMA_VERSION, sessionId: id.sessionId, sessionKey: id.sessionKey, instanceId: id.instanceId, lane: id.lane, scope, ...(scope === SCOPE_INSTANCE ? { instance } : {}), jobs };
  if (opts.json) return console.log(json(payload));
  const counts = jobs.reduce((acc, job) => { acc[job.status] = (acc[job.status] || 0) + 1; return acc; }, {});
  const hint = widenHint(id, scope);
  const skipped = jobs.some((job) => job.ownerSource === "not-probed")
    ? "Owner liveness was not probed for this whole-root sweep (add --owner to probe it; unprobed reads as unknown, never stale)."
    : "";
  console.log(context("pbb.list", {
    ...scopeAttrs(id, scope, instance),
    jobs: jobs.length,
    ...(skipped ? { owners_probed: false } : {}),
    ...Object.fromEntries(Object.entries(counts).map(([status, count]) => [`jobs_${status}`, count])),
  }, [describeScope(id, scope, instance), jobs.map(formatJob).join("\n") || "No background bash jobs in scope.", skipped, hint].filter(Boolean).join("\n")));
}

/** A job id that is not in the current (narrow) scope must say so, not read as "no such job". */
function unknownJobMessage(id, jobId, scope, instance) {
  const hint = widenHint(id, scope);
  return `unknown job ${jobId}\n${describeScope(id, scope, instance)}${hint ? `\n${hint}` : ""}`;
}

function printStatus(id, jobId, opts) {
  if (!jobId) return printList(id, opts);
  const { scope, instance } = resolveScope(opts);
  const result = findJob(id, jobId, { scope, instance });
  if (result.error === "missing") {
    console.error(context("pbb.error", { session_key: id.sessionKey, instance_id: id.instanceId, scope, job_id: jobId, error: "unknown_job" }, unknownJobMessage(id, jobId, scope, instance)));
    process.exit(2);
  }
  if (result.error === "ambiguous") {
    console.error(context("pbb.error", { session_key: id.sessionKey, instance_id: id.instanceId, scope, job_id: jobId, error: "ambiguous_job", matches: result.jobs.length }, `ambiguous job ${jobId}\n${result.jobs.map((job) => `${job.instanceId}:${job.jobId}`).join("\n")}\nPick one with: pbb status ${jobId} --instance <instanceId>`));
    process.exit(3);
  }
  const found = result.job;
  // A *running* job's recorded size is a promotion-time snapshot; read the file.
  // A finished job's record already carries the final size, and for a capped log
  // the recorded number is the cap itself — neither may be replaced by a stat.
  const live = ["running", "kill_requested"].includes(found.status) ? liveLogBytes(found) : undefined;
  const job = withOwnerInfo(id, live === undefined ? found : { ...found, logBytes: live });
  // `--json`: `jobs` (an array, like `pbb list`) is the canonical shape; `job`
  // stays as a deprecated alias for the single-object shape older callers read.
  if (opts.json) return console.log(json({ kind: "pbb.status", schemaVersion: SCHEMA_VERSION, sessionId: id.sessionId, sessionKey: id.sessionKey, instanceId: id.instanceId, lane: id.lane, scope, jobs: [job], job }));
  const cap = formatLogCap(job);
  console.log(context("pbb.status", { session_id: id.sessionId, session_key: id.sessionKey, instance_id: id.instanceId, ...(cap ? { log_truncated: true, log_bytes: job.logBytes } : {}), lane: id.lane, scope, job_id: job.jobId, owner_instance_id: job.instanceId, status: job.status, exit_code: job.exitCode, cursor: job.lastEventId }, `${cap ? `${cap}\n` : ""}${json(job)}`));
}

function tailText(path, lines, full) {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  if (full) return text;
  const split = text.split(/\r?\n/);
  const wanted = split.slice(-Math.max(1, lines ?? DEFAULT_TAIL_LINES));
  return wanted.join("\n");
}

/** A job id is also a file name; never let one reach outside the logs directory. */
function looksLikeJobId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) && !value.includes("..");
}

/**
 * Log files named after `jobId`, when there is no job record for it.
 *
 * A **foreground** call records no job (by design — pi's own result is the
 * record), but it does leave `<instance>/logs/<jobId>.log`, and every truncated
 * result and completion advertises `pbb tail <jobId> --full`. So an advertised
 * pointer has to work: the log is the fallback. Scoped instances are searched
 * first, then every session under the root, most recently modified first.
 */
function findLogOnlyTargets(id, jobId, scope, instance) {
  if (!looksLikeJobId(jobId)) return [];
  const candidates = [];
  const consider = (sessionKey, instanceId) => {
    const logPath = join(id.root, "sessions", sessionKey, "instances", instanceId, "logs", `${jobId}.log`);
    if (!existsSync(logPath)) return;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(logPath).mtimeMs;
    } catch {
      // Unreadable stat: still a candidate, just without a recency order.
    }
    candidates.push({ sessionKey, instanceId, logPath, mtimeMs });
  };
  for (const target of instanceTargets(id, scope, instance)) consider(target.sessionKey, target.instanceId);
  if (candidates.length === 0 && scope !== SCOPE_ALL) {
    for (const sessionKey of readSessionKeys(id)) {
      for (const instanceId of readInstanceIds(id, sessionKey)) consider(sessionKey, instanceId);
    }
  }
  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * `pbb tail` for an id that only exists as a log file: report `kind=log-only` and
 * say where the log came from. No job fields are invented — there is no record.
 */
function printLogOnlyTail(id, jobId, opts, scope, instance) {
  const targets = findLogOnlyTargets(id, jobId, scope, instance);
  if (targets.length === 0) return false;
  const found = targets[0];
  const body = tailText(found.logPath, opts.lines, opts.full);
  const others = targets.length - 1;
  const linesAttr = opts.full ? "full" : (opts.lines || DEFAULT_TAIL_LINES);
  const where = `session=${found.sessionKey} instance=${found.instanceId} log=${found.logPath}`;
  const note = `no job record for ${jobId} — kind=log-only (a foreground call leaves only its log)\n${where}${others > 0 ? `\n${others} other log(s) named ${jobId}.log exist under ${id.root}; this is the most recently written — use --instance to pick another` : ""}`;
  if (opts.json) {
    console.log(json({ kind: "pbb.tail", schemaVersion: SCHEMA_VERSION, sessionId: id.sessionId, sessionKey: id.sessionKey, instanceId: id.instanceId, lane: id.lane, scope, jobId, jobKind: "log-only", logPath: found.logPath, logSessionKey: found.sessionKey, logInstanceId: found.instanceId, logModifiedAt: found.mtimeMs ? new Date(found.mtimeMs).toISOString() : undefined, otherLogCount: others, log: body }));
    return true;
  }
  console.log(context("pbb.tail", { session_id: id.sessionId, session_key: id.sessionKey, instance_id: id.instanceId, lane: id.lane, scope, job_id: jobId, job_kind: "log-only", log_session_key: found.sessionKey, log_instance_id: found.instanceId, lines: linesAttr }, `${note}\n${body || "No log output recorded yet."}`));
  return true;
}

function printTail(id, jobId, opts) {
  const { scope, instance } = resolveScope(opts);
  const result = findJob(id, jobId, { scope, instance });
  if (!result.job) {
    if (result.error === "ambiguous") {
      console.error(context("pbb.error", { session_key: id.sessionKey, instance_id: id.instanceId, scope, job_id: jobId, error: "ambiguous_job" }, `ambiguous job ${jobId}\n${result.jobs.map((job) => `${job.instanceId}:${job.jobId}`).join("\n")}\nPick one with: pbb tail ${jobId} --instance <instanceId>`));
      process.exit(3);
    }
    // No job record: a foreground call's log is still a real, advertised pointer.
    if (printLogOnlyTail(id, jobId, opts, scope, instance)) return;
    console.error(context("pbb.error", { session_key: id.sessionKey, instance_id: id.instanceId, scope, job_id: jobId, error: "unknown_job" }, unknownJobMessage(id, jobId, scope, instance)));
    process.exit(2);
  }
  const job = result.job;
  const logPath = job.logPath || join(id.root, "sessions", job.sessionKey ?? id.sessionKey, "instances", job.instanceId, "logs", `${job.jobId}.log`);
  const body = tailText(logPath, opts.lines, opts.full);
  if (opts.json) return console.log(json({ kind: "pbb.tail", schemaVersion: SCHEMA_VERSION, sessionId: id.sessionId, sessionKey: id.sessionKey, instanceId: id.instanceId, lane: id.lane, scope, jobKind: "job", job, log: body }));
  const cap = formatLogCap(job);
  const note = cap ? `${cap} — the file does not contain the full output\n` : "";
  console.log(context("pbb.tail", { session_id: id.sessionId, session_key: id.sessionKey, instance_id: id.instanceId, lane: id.lane, scope, job_id: job.jobId, owner_instance_id: job.instanceId, status: job.status, cursor: job.lastEventId, ...(cap ? { log_truncated: true, log_bytes: job.logBytes } : {}), lines: opts.full ? "full" : (opts.lines || DEFAULT_TAIL_LINES) }, `${note}${body || "No log output recorded yet."}`));
}

function normalizeSignal(signal) {
  const value = String(signal || "TERM").toUpperCase();
  return value.startsWith("SIG") ? value : `SIG${value}`;
}

function signalProcessGroup(pgid, signal) {
  const normalized = normalizeSignal(signal);
  try {
    process.kill(-pgid, normalized);
    return { ok: true };
  } catch (error) {
    try {
      process.kill(pgid, normalized);
      return { ok: true };
    } catch (fallbackError) {
      return { ok: false, error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError) };
    }
  }
}

function printKill(id, jobId, opts) {
  const { scope, instance } = resolveScope(opts);
  const result = findJob(id, jobId, { scope, instance });
  if (!result.job) {
    console.error(context("pbb.error", { session_key: id.sessionKey, instance_id: id.instanceId, scope, job_id: jobId, error: result.error === "ambiguous" ? "ambiguous_job" : "unknown_job" }, result.error === "ambiguous" ? `ambiguous job ${jobId}\n${result.jobs.map((job) => `${job.instanceId}:${job.jobId}`).join("\n")}\nPick one with: pbb kill ${jobId} --instance <instanceId>` : unknownJobMessage(id, jobId, scope, instance)));
    process.exit(result.error === "ambiguous" ? 3 : 2);
  }
  const job = withOwnerInfo(id, result.job);
  if (!["running", "kill_requested"].includes(job.status)) {
    console.log(context("pbb.kill", { session_id: id.sessionId, session_key: id.sessionKey, instance_id: id.instanceId, lane: id.lane, scope, job_id: job.jobId, owner_instance_id: job.instanceId, status: job.status, requested: false }, `${job.jobId} is not running; no kill requested`));
    return;
  }
  const signal = opts.signal || "TERM";
  if (opts.stale && job.ownerStale && job.pgid) {
    const sent = signalProcessGroup(Number(job.pgid), signal);
    const { _path, ...jobWithoutInternal } = job;
    const patch = { ...jobWithoutInternal, status: sent.ok ? "kill_requested" : job.status, staleKillRequestedAt: new Date().toISOString(), staleKillSignal: signal, staleKillError: sent.error };
    if (job._path) writeJsonFile(job._path, patch);
    console.log(context("pbb.kill", { session_id: id.sessionId, session_key: id.sessionKey, instance_id: id.instanceId, lane: id.lane, scope, job_id: job.jobId, owner_instance_id: job.instanceId, signal, stale: true, pgid: job.pgid, ok: sent.ok }, `${sent.ok ? "stale process-group kill sent" : "stale process-group kill failed"} for ${job.jobId}\n${sent.error || ""}`));
    process.exit(sent.ok ? 0 : 4);
  }
  const requestId = `kill_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const request = {
    schemaVersion: SCHEMA_VERSION,
    type: "kill",
    requestId,
    jobId: job.jobId,
    globalJobId: job.globalJobId,
    sessionId: id.sessionId,
    sessionKey: id.sessionKey,
    instanceId: job.instanceId,
    requestedByInstanceId: id.instanceId,
    signal,
    requestedAt: new Date().toISOString(),
  };
  writeJsonFile(join(requestsDir(id, job.instanceId), `${requestId}.json`), request);
  const staleKillHint = job.pgid ? ` If this is a PBB-runner job with pgid, use: pbb kill ${job.jobId} --instance ${job.instanceId} --stale` : "";
  const warning = job.ownerLive
    ? ""
    : job.ownerLiveness === "dead"
      ? `\nOwner instance ${job.instanceId} is dead (${job.ownerNote || "pid gone"}), so the cooperative kill will not be honored.${staleKillHint}`
      : job.ownerLiveness === "unknown"
        ? `\nOwner liveness unknown (${job.ownerNote || "no liveness record"}): the cooperative kill is queued, nothing is confirmed.${staleKillHint}`
        : `\nOwner instance appears stale. Cooperative kill is queued but may not be honored.${staleKillHint}`;
  console.log(context("pbb.kill", { session_id: id.sessionId, session_key: id.sessionKey, instance_id: id.instanceId, lane: id.lane, scope, job_id: job.jobId, owner_instance_id: job.instanceId, request_id: requestId, status: job.status, owner_live: job.ownerLive, owner_liveness: job.ownerLiveness, requested: true }, `kill requested for ${job.jobId}\n${describeScope(id, scope, instance)}\nThe owning pi-background-bash runtime will abort the job if it is still live.${warning}`));
}

const opts = parseArgs(process.argv.slice(2));
const command = opts._[0] || "list";
const id = identity();

if (["help", "--help", "-h"].includes(command)) {
  console.log(`pbb - Pi background bash inspector\n\nCommands:\n  pbb self [--json]\n  pbb list [--scope current-instance|session|all] [--all] [--instance ID] [--owner] [--json]\n  pbb instances [--scope session|all] [--all] [--json]\n  pbb status [JOB] [--scope ...] [--json]\n  pbb tail JOB [-n LINES] [--full] [--json]\n  pbb kill JOB [--stale] [--signal TERM]\n\nScope: the default view is THIS session + THIS instance. --scope session widens to every\ninstance of this session; --all (same as --scope all) widens to every session under the root.\nJobs from sibling instances, subagent sessions and other sessions are hidden by default.\nOwner liveness: --all does NOT probe it (one pil process per session made it take minutes);\nthose owners read \`owner=unknown\` and \`--owner\` probes them (bounded, a few seconds).\n--json: \`list\` and \`status\` both carry \`jobs\` (an array; canonical). \`status\` also keeps\nthe single-object \`job\` key as a deprecated alias. \`tail\` reports \`jobKind: log-only\` for an\nid that only exists as a log file (a foreground call records no job).\nScope comes from PI_LANE_* env vars (pi-lane); pbb self shows the resolved identity.`);
  process.exit(0);
}

if (command === "self" || command === "whoami") {
  printSelf(id, opts);
  process.exit(0);
}

requireIdentity(id);
mkdirSync(instanceDir(id), { recursive: true });

async function run() {
  if (command === "list" || command === "ls") return printList(id, opts);
  if (command === "instances") return printInstances(id, opts);
  if (command === "status") return printStatus(id, opts._[1], opts);
  if (command === "tail") {
    if (!opts._[1]) {
      console.error("Usage: pbb tail <job>");
      process.exit(2);
    }
    return printTail(id, opts._[1], opts);
  }
  if (command === "kill") {
    if (!opts._[1]) {
      console.error("Usage: pbb kill <job>");
      process.exit(2);
    }
    return printKill(id, opts._[1], opts);
  }
  console.error(`Unknown pbb command: ${command}`);
  process.exit(2);
}

try {
  await run();
} catch (error) {
  // A crash in the sweep is still a pbb error, not a stack trace for the agent to parse.
  console.error(context("pbb.error", { session_key: id.sessionKey, instance_id: id.instanceId, error: "pbb_failed" }, error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
