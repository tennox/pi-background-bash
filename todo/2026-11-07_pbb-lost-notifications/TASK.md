# Fix pbb lost background-completion notifications

## Status: Diagnosis complete (2026-11-07), awaiting manu's scope decision

Question sent to manu (ntfy ask root `3d296d3`, 2026-11-07 ~17:22):
**1) full bundle (recommended) 2) minimal hotfix 3) docs only.**

## Problem

Background bash jobs sometimes complete but the completion notification never
reaches the agent, and the job file stays `status:"running"` forever. The agent
waits as instructed — worst failure mode: silent hang. ~130 stuck jobs found
machine-wide across ~15 pi instances (2026-11-07 sweep).

## Root causes (all verified in code + live forensics)

### Bug 1 — shared module state across sessions in one pi process (primary)

`extensions/background-bash.ts` keeps `activeJobs`, `shuttingDown`,
`nextJobNumber` as module-level globals. pi caches extension factories per cwd
(`loadExtensionsCached`, jiti factory cache) → **every session in one pi
process shares them**.

- Any session's `session_shutdown` (subagent finishes, /new, /resume, /reload,
  quit) runs the shared `abortAllJobs()`: kills every session's running jobs
  (SIGTERM to process group) + `activeJobs.clear()` + sets shared
  `shuttingDown = true`.
- `deliverBackgroundResult()` early-returns `if (shuttingDown) return;`
  **before** `recordPbbJobCompleted()` → no `jobs/<id>.json` update, no
  `job.completed` event, no notification — until the next `session_start`
  anywhere in the process resets the flag.

Evidence (pi pid 797493, session 8a159ec6 = agent-bridge live-listening):
jobs bg001–bg018 delivered normally (13:34–13:45:40); at ~13:45:45 a sibling
session in the same process ended → bg019–bg071 (30 min, ~50 jobs incl.
`sleep 8; echo ok`) all dropped; new session_start at 14:15:55.696 → bg072
completed and delivered **0.6 s later**. Sibling session 01a1b63f last wrote
14:20:17 → other session's 14:30+ completions dropped again.

### Bug 2 — `close` never fires when a descendant inherits stdout/stderr

`runPbbBash()` spawns `bash -lc <cmd>` (detached, piped stdio) and resolves on
`child.on("close")`. Node's `close` waits for stdio EOF = ALL writers closed —
a detached descendant holding the pipes (Gradle/Kotlin daemons, webpack, dev
servers) stalls `close` forever although the process exits. Reproduced
(`tmp/repro-close.mjs`: exit at 1.0s, close never). pi core fixed this exact
bug in `~/dev/ext/pi/packages/coding-agent/src/utils/child-process.ts`
(`waitForChildProcess`, refs earendil-works/pi#5303): resolve on `exit` +
stdio-end, re-arming idle-grace timer after exit, then destroy streams.
Evidence: bg290/bg298 gradle jobs show `BUILD SUCCESSFUL` in their pbb logs,
no completion ever recorded.

### Bug 3 — process-global env identity pollution (found by second-opinion review)

`session_start` → `exportPbbEnv()` writes `PBB_SESSION_KEY`/`PBB_SESSION_ID`/
`PBB_INSTANCE_ID` into `process.env` — process-wide. Last session to start
wins; every later `spawn(env: process.env)` inherits *that* session's identity,
so `pbb` run inside bash from session A reports against session B's instance.

Related: module-level `fallbackInstanceId` (`pbb_<pid>_<uuid>`) is shared by
all sessions of a process without pi-lane env → job files from different
sessions land in ONE instance dir (shared `nextJobNumber` currently masks the
id collisions that per-session counters would create).

### Chained failure mode

Bug 2 hang keeps a job alive → next session teardown SIGTERMs the hung process
group (without finalizing the job file) → the resulting `close` fires into the
`shuttingDown=true` window → dropped by Bug 1 → file stuck `running` forever.

### "Not visible in pbb list" (secondary)

- `pbb list` defaults to `current-instance` scope = calling session's key;
  sibling-session jobs invisible.
- Auto-backgrounded jobs have NO file during the first 30s foreground phase.
- `pbb` not on PATH in some runtimes (`bash: pbb: command not found`).

## Second opinion (fresh subagent, code-verified, 2026-11-07)

Verdict: **agree-with-changes**. Key additions:
- Bug 3 above (env pollution + fallback instanceId).
- Keep a process-global registry for `process.once("exit")`; keep
  `handlePbbKillRequests` global.
- On shutdown-finalization record the REAL outcome, plus `delivered:false` /
  `droppedReason` so the sweep can distinguish; write file BEFORE sendMessage
  (existing order) so double-delivery is impossible by construction.
- Reconcile sweep dangers: filter by sessionKey (not instance dir!) so results
  never inject into the wrong session; coalesce re-delivery into ONE message
  (50 jobs × triggerTurn = 50 forced turns); use proc starttime / pgid
  liveness to avoid pid-reuse false negatives; finalize lost jobs as
  `lost`/`orphaned` with log tail, never fabricate `exit`.
- Grace timer: core's 100ms is aggressive; use 500ms–1s (pbb tail --full
  recovers truncation either way).
- Also hint `--scope session` in the result text; consider writing the job
  file at spawn for auto-bg jobs (`status:"foreground"`) to close the 30s
  blind window.

## Plan (sequenced per reviewer)

1. Stop the bleeding: per-session job ownership (2) + never-drop finalization
   (3) as one change.
2. Close-hang fix: exit + idle-grace + stream destroy, keeping the extension's
   own `data` listeners (onUpdate + appendPbbLogDelta) alive until finalize;
   keep abort-signal detection via the `exit` event's signal.
3. Boot-time reconcile sweep (sessionKey-filtered, coalesced single
   re-delivery, `lost` outcome for unfinalizable jobs).
4. Wait-cap hint in toolResult + `--scope session` hint + optional
   `status:"foreground"` job file at spawn.

## Cross-agent correspondence

- live-listen agent (call-agent, rpc-respawn harness class): independent repro
  bg083–85; its "runner died" suspicion corrected (pi 797493 was verifiably
  alive) — but its fix directions (immediate completion record, boot-time
  reconcile sweep, wait-cap hint, true detachment for the rpc-respawn class)
  folded into this plan. Reply thread: +agent/messages notes 356eee1 → 3c68728 → afa5238.
- Its bg089 (~/dev/wovin/agentic-live-chat) = ready-made test case for the
  reconcile sweep.
