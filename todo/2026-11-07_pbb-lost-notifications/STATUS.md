# Implementation status — pbb lost notifications

Started 2026-11-11 (session: pbb fix). Diagnosis in `TASK.md` is authoritative and
unchanged. This file is the progress log + outcome.

## STATUS: implemented, verified locally, NOT yet reachable for manu's running sessions

Code is complete and committed locally. Nothing was pushed, published or deployed.
`pbb` is still not on manu's login-shell PATH nor on the PATH inside already-running
sessions — that needs his decision (see `DELIVERY.md`).

## What changed (`extensions/background-bash.ts`)

### Step 1 — per-session job ownership + never-drop finalization

- Per-session state object (`SessionState`: `activeJobs`, `shuttingDown`, `pending`,
  `identity`, `jobNumberFloor`) is created **per extension-factory call**. pi caches the
  factory per cwd (`loadExtensionsCached`), so one module instance serves every session in
  a process — module-level state was the sharing bug. A module-level `liveSessions` set now
  exists only for the process-`exit` hook and the kill-request poller.
- `session_shutdown` aborts/detaches **only that session's** jobs and clears only its own
  pending widget. No shared `shuttingDown` flag exists anymore.
- `finishBackgroundJob()` records the real outcome **first** (`recordPbbJobCompleted`) and
  only then delivers. Shutting down / send failure now writes
  `delivered: false` + `droppedReason` — the file can no longer stay at `status: "running"`.
- Delivery is marked in the job file **before** `sendMessage` (double delivery impossible by
  construction); a throw reverts the marker so the sweep retries.
- Job ids stay `bg001…` and remain unique per instance directory: the allocator is
  process-wide (per-dir map + on-disk scan + per-session history floor). The fallback
  instance id (`pbb_<pid>_<uuid>`) is now **per session** instead of per process.

### Step 2 — `exit` + idle grace instead of `close`

`runPbbBash` now resolves on the child's `exit` event plus an idle grace
(`EXIT_STDIO_GRACE_MS = 750`, re-armed on every output chunk, mirroring pi core's
`utils/child-process.ts` / earendil-works/pi#5303), with stream `end` fast-path and
`stdout`/`stderr` destroy on finalize. A descendant holding the pipes no longer blocks
completion and a still-writing descendant cannot truncate the tail. The extension's own
`data` listeners stay attached until finalize.

### Step 3 — reconcile sweep

At `session_start` (deferred one tick):

- scans only this session's `sessionKey` (filter on the stored `sessionKey`, not the dir);
- re-delivers `delivered: false` terminal jobs as **one** `background_bash_digest` message;
- finalizes `running`/`kill_requested` jobs whose recorded `pid` **and** `pgid` are both gone
  as `outcome: "lost"` (honest — never fabricated as `exit`), with the log tail in the digest;
- skips jobs whose id already appears in the session transcript (upgrade path: pre-fix files
  have no `delivered` field);
- does not replay completions older than 24h (`deliveredReason: "reconcile_expired"`);
- caps a digest at 20 entries and defers the rest to the next session start (reported in the
  message, never silent).

### Also fixed while in there (root cause of Bug 3)

- `exportPbbEnv()` (process-wide `PBB_SESSION_KEY` / `PBB_SESSION_ID` / `PBB_INSTANCE_ID`
  writes at `session_start`) is **gone**. Identity is passed per spawn (`pbbSpawnEnv`), which
  also overrides `PI_LANE_SESSION_KEY` / `PI_LANE_SESSION_ID` / `PI_LANE_SESSION_FILE` for that
  command so `pbb`/`pil` inside bash report the owning session.
- Session identity is derived from `ctx.sessionManager` when the process-global `PI_LANE_*`
  env names a *different* session file (same hash pi-lane uses, so keys stay consistent).
- `PBB_*` env is no longer read as an identity input (it is only written per spawn) — a pi
  started from a pbb job cannot inherit and impersonate the spawning session.

## `pbb` on PATH — recommendation (implemented, see `DELIVERY.md` for the rest)

`/home/manu/.config/pi/npm/node_modules/.bin/pbb` is on neither the login-shell PATH nor the
ai-sandcastle session PATH. Chosen fix (smallest honest, no nix-config edit):

- the extension writes `<PBB_ROOT>/bin/pbb` (a 3-line `sh` shim that execs the package's own
  `bin/pbb.js` with the same node binary) and prepends `<PBB_ROOT>/bin` to `PATH` **for
  spawned commands only** — no `process.env` mutation, survives sandboxes because the pbb
  state root is already writable there.

`~/.pi/pbb/bin` is inside the state root the extension already owns, so it needs no manu
sign-off and works for every install shape (npm package, sandbox mount, local `pi -e .`).
A nix-config PATH entry is **not required**; making `pbb` globally available on the login
shell would be a separate, optional decision for manu.

## Verification

- `npm test` (typecheck + `node --test --test-concurrency=4`, the concurrency cap is now in
  package.json): 38/38 pass with the fix. Baseline on this checkout before touching anything
  was 26/32 failing — purely because the `patches/pi-mock+1.2.0.patch` had not been applied
  (`npx patch-package`); after applying it the remaining 2 failures were only `python3`
  missing from this sandbox's PATH (30/32), not code failures.
- New regression tests in `test/background-bash.test.mjs`, each verified to **fail on the
  pre-fix code and pass after**:
  1. `a sibling session shutdown does not drop another session's completion` — two factory
     invocations in one process (exactly what pi does for a sibling session).
  2. `completion arrives when a descendant inherits the command's stdout` — `sleep 30 &`
     holds the pipes; completion must arrive on exit+grace (old code: never within 10s).
  3. `startup sweep re-delivers an undelivered completion exactly once and records lost jobs
     honestly` — coalesced digest, second start delivers nothing, dead-owner job → `lost`
     with `job.lost` event and no fabricated `job.completed`.
  4. `reconcile does not re-deliver a completion the transcript already carries` — pre-fix job
     files have no `delivered` field; a completion whose message is already in the transcript
     must not be replayed (upgrade path).
  5. `reconcile ignores jobs recorded for another session key`.
  6. `pbb is on PATH inside bash commands and reports the owning session`.
- Full suite after the fix: `npm test` → 38/38 pass (typecheck included).
- Real-data drill (read-only copy of `~/.pi/pbb/sessions/8a159ec642348e7630b3fc0b`, the
  agent-bridge session from the diagnosis; only aggregates printed, never command lines):
  55 job files → 20 old completions marked `reconcile_expired` (no replay), 35 stuck
  `running` jobs all finalized `lost` (`job.lost` events), 20 delivered in one digest, 15
  deferred; 20 `job.lost_delivered` events. No exception, digest rendered inside limits.
- Public contract untouched: `pbb list/status/tail/kill` and the `bg001…` scheme are
  unchanged; job files only gained fields.

## Not done / needs manu

- Publish/reach decision: see `DELIVERY.md` (npm publish vs nix package vs local path).
- No `git push`, no `npm publish`, no deploy; commit is local only.
- `pbb` on the login-shell PATH (outside agent bash calls) was deliberately not changed —
  that would be a nix-config edit needing his sign-off.

## Addendum 2026-11-11 (after verifying pi-subagents + pi 1.5 in source)

- **Correction to TASK.md's attribution:** subagent teardown does *not* emit
  `session_shutdown` (pi-subagents calls `AgentSession.dispose()` → runner invalidate
  only; pi emits the event only from `AgentSessionRuntime.dispose()`). The 2026-11-07
  drops therefore came from another shutdown source (`/reload`, session replacement, or
  a harness using `AgentSessionRuntime`). The fix stands — never-drop finalization,
  per-session state and the reconcile sweep cover all of those causes — but "subagent
  finishes kills the parent's jobs" is not the mechanism.
- **New, from the same check:** child subagent sessions emit `session_start` but never
  `session_shutdown`, so this extension's per-session state (and the `liveSessions`
  registry) grew with every subagent run. Fixed with a `WeakRef` on
  `ctx.sessionManager`, pruned at `session_start` (`pruneDeadSessions`); a session with
  running jobs or a live manager is never pruned.
