# Plan: builtin-bash-tool parity for pi-background-bash

> Reviewed 2026-11-06 by a deep41f review agent against both codebases.
> Amendments applied: Option B mandated (not A); `-lc→-c` demoted out of P0
> (documented contract, README:88 + docs/pbb-runner.md:7); priorities
> reordered; line refs corrected; missed items added (§ Missed-below).

Comparison of pi 1.4.0 builtin bash (`~/dev/ext/pi/packages/coding-agent/src/core/tools/bash.ts`,
= `/nix/store/j1anwypb76hf15m07jfc122a92gkjvyh-pi-coding-agent-1.4.0/.../dist/core/tools/bash.js`)
vs this extension (`extensions/background-bash.ts` @ 5ffeb97 / npm 1.1.0).

Goal: keep background/auto-background machinery, converge everything else.
Verified empirically 2026-11-06 (live session: PBB_* present, all PI_* absent,
foreground AND backgrounded; pi's own process env never contains PI_SESSION_* —
pi only builds it per-spawn in resolveSpawnContext, which the shadowed builtin
never reaches).

## Comparison

| # | Aspect | Builtin pi bash | pbb replacement | Verdict |
|---|--------|-----------------|-----------------|---------|
| 1 | Session env vars (`PI_SESSION_ID/FILE/PROVIDER/MODEL/REASONING_LEVEL`) | Injected per-spawn, `resolveSpawnContext` (bash.ts:186–214, `exposeSessionEnvironment` default true :250); deletes then re-sets | **Missing entirely.** Spawn uses `env: process.env` (background-bash.ts:576); extension's own `pbbIdentity()` (:203–207) computes sessionId/sessionFile but only republishes them as `PBB_SESSION_*` (:359–365) | **P0 breakage** |
| 2 | Shell invocation | `getShellConfig()` → `bash -c <cmd>` (WSL-legacy bash → stdin transport); configurable `shellPath` option (bash.ts:220/:175, shell.ts:86) | Hardcoded `spawn("bash", ["-lc", cmd])` (background-bash.ts:574) — login shell: diverges from builtin, BUT it is the documented pbb contract (README:88, docs/pbb-runner.md:7) and login-shell PATH matters in sandboxed/nix launches — make configurable, don't silently flip | P2 (demoted from P0) |
| 3 | `commandPrefix` option (prelude prepended to every command) | Supported (bash.ts:249, :268); pi already reads `shellCommandPrefix`/`shellPath` from settings (agent-session.ts:3712–3715) | Ignored (extension never plumbs options) | P1 |
| 4 | Abort signal | Kills process tree (`killProcessTree`), throws `Error("aborted")` → pi renders "Command aborted" | Kills process **group** (better for detached children) then throws Error(body + "Command aborted") — functionally OK | keep |
| 5 | Timeout | Validates finite + max `MAX_TIMEOUT_MS` (~24.8d, bash.ts:22–36); kills tree on expiry, error "Command timed out after N seconds" | No validation (negative/NaN timeout silently ignored — `params.timeout > 0` check only); TERM→KILL escalation after 500ms (good, builtin lacks it); message shape identical | P2 validate |
| 6 | cwd validation | Errors loudly: "Working directory does not exist: <cwd>" (bash.ts:106–108) | `spawn` fails with opaque ENOENT-ish error | P2 |
| 7 | Output capture | `OutputAccumulator`: bounded memory, streaming UTF-8 decode, **persists full output to temp file when truncated**, `fullOutputPath` in details + `full_output_path` in structured output | In-memory `output` string (unbounded) + `chunk.toString("utf8")` concat (:585 — splits multibyte chars → mojibake) + pbb log delta; non-pbb foreground runs DO spill full output to a temp file (:689) and mention it in prose (:694), but not in `details.fullOutputPath` | P1 |
| 8 | Truncation limits | tail 2000 lines / 50KB (same numbers) | Same (MAX_RESULT_LINES/BYTES :15–16) | parity ✓ |
| 9 | Streaming updates | Throttled 100ms (`BASH_UPDATE_THROTTLE_MS`) | Unthrottled per-chunk onUpdate (:588), and sends `details: {}` — no truncation/fullOutputPath per update | P2 |
| 10 | Structured output | `structuredContent: {output, truncated, full_output_path?, exit_code, wall_time_seconds}` + `outputSchema` (bash.ts:56–64; structuredContent :391–408) + `constrainedSampling` json_schema strict-prefer (:260); non-zero exit → `isError: true` | No structuredContent, no outputSchema, no constrainedSampling | P1 |
| 11 | Exit-code convention | Signal-kill → `128 + signum` (bash.ts:158) | Any signal death (incl. OOM/SIGKILL) becomes "Command aborted" (:625–629) — misreports crashes | P2 fix |
| 12 | Env plumbing hooks (`spawnHook`, `exposeSessionEnvironment` options) | Official extension API (docs/environment-variables.md) | N/A — replacement builds env itself | tie to #1 |
| 13 | Detached-child hygiene | Tracks pids (`trackDetachedChildPid`) for shutdown kill | Better: process groups + session_shutdown abortAllJobs + repair logic | keep |
| 14 | Renderers | builtin createShellRenderers | Reuses builtin renderers for final + running via pi-pending | parity ✓ |
| 15 | Prompt guidance | `guidelines: ["You can inspect PI_* environment variables..."]` (bash.ts:46–48), only when exposeSessionEnvironment | Own pbb-specific guidelines; no PI_* hint | tie to #1 |
| 16 | `timeout` description/schema | same shape | adds `background` param (the feature) | keep |
| 17 | Concurrency cap | none (one foreground call at a time by design) | `MAX_ACTIVE_JOBS = 10` (:14) — new failure mode the builtin never has; document or raise | P2 |
| 18 | PATH hygiene | `getShellEnv()` prepends pi's bin dir to PATH (shell.ts:171–183) | raw `process.env` — drops pi's bin dir from spawned PATH | P1 |
| 19 | Env leakage scope | PI_* only in tool spawns; docs promise NOT in user `!` commands | Option-A-style process.env mutation would leak PI_* to MCP servers/extensions/`!` commands — use per-call env (Option B) | design rule |

## Fixes (priority order)

### P0 — session env injection (the reported bug)
In `execute` (background-bash.ts:~951), before any `runPbbBash`, build the session
env exactly like builtin `resolveSpawnContext` and merge into the spawned env:

- ~~Option A~~ REJECTED by review: a session_start snapshot makes
  PI_MODEL/PROVIDER/REASONING stale after `/model`/thinking changes (docs
  promise "resolved when each command starts"), mutating process.env leaks
  PI_* into MCP servers/other extensions/`!` commands (docs: "not injected
  into user-entered `!` commands"), and `pbbIdentity` prefers
  `PI_LANE_SESSION_*` (:204–205) so it can publish a lane value instead of
  ctx.sessionManager's.
- **Option B (chosen):** per-call env built from ctx at execute time, passed
  explicitly into `runPbbBash` → spawn. Even better: reuse pi's exported
  `createBashToolDefinition` (index.ts:343) whose `resolveSpawnContext`
  already hands the env dict to `operations.exec` instead of hand-copying.
- Stale-strip rule: like builtin (:194–198), DELETE all five vars first —
  `exportPbbEnv`'s only-set-when-truthy pattern would carry a stale
  `PI_SESSION_FILE` into ephemeral sessions.
- `/resume` staleness is a non-issue: session_start re-fires on
  resume/new/fork/reload (agent-session-runtime.ts:218–397, agent-session.ts:3787).
- Respect opt-out via pi's existing settings (`shellCommandPrefix`-style);
  no `exposeSessionEnvironment` setting exists pi-side — read sessionManager
  directly, gate on config key in BackgroundBashConfig if wanted.
- Add builtin guideline "You can inspect PI_* environment variables…" when
  enabled. Tests: PI_MODEL changes between two consecutive calls; disabled
  mode strips stale vars.

### P1 — env/PATH parity
Merge pi's `getShellEnv()` result (bin-dir PATH prepend) as the base for the
spawn env, keeping PBB_* additions.

### P2 — shell args configurable (`-lc` stays default)
`-lc` is the documented pbb contract (README:88, docs/pbb-runner.md:7) and
login-shell PATH matters in sandboxed/nix launches; no test depends on `-lc`
(it spawns explicitly). Make shell + args configurable; update docs if the
default ever flips.

### P1 — plumb BashToolOptions
Forward `commandPrefix`, optional `shellPath` handling; prepend prefix like
builtin (bash.ts:265). Low effort, restores option parity for hosts that set it.

### P1 — structured result parity
Return `structuredContent: {output, truncated, exit_code, wall_time_seconds,
full_output_path?}` and declare the builtin-shaped `outputSchema`; add
`isError` semantics for non-zero exits if switching from throw to result (keep
current throw if simpler — but then still add structuredContent on success).

### P1 — bounded output capture + UTF-8 + structured details
Replace `output += chunk.toString("utf8")` with a streaming decoder (builtin
pattern); keep string but write full output to a temp file on truncation and
put its path into details (`fullOutputPath`) + per-update details. pbb log
stays as the background-job canonical log.

### P2 — small parity nits
- Validate `timeout` like builtin (finite, ≤ MAX_TIMEOUT_SECONDS) with the
  same error strings.
- Validate cwd exists up front with builtin's message.
- Throttle onUpdate to ~100ms.

## Test plan

- `npm test` (node --test, existing suites) after each change.
- New test: spawn asserts `PI_SESSION_ID` present in child env when
  sessionManager stub provides an id; absent when disabled.
- Manual smoke in a real pi session: `env | grep PI_` shows PI_SESSION_ID on
  both a quick foreground call and a >30s backgrounded call; `ntfy.nu` /
  `agent-msg.nu` identity probe no longer errors.

## Out of scope

- Windows/PowerShell paths, RPC-mode specifics, changing pbb job/repair logic.
