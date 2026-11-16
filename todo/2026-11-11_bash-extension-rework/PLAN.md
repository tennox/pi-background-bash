# PLAN — rework the background-bash extension onto pi's own bash tool

Status: second draft (2026-11-11), revised after an adversarial review — §15 lists what the
review changed. Decisions it implements are recorded in
`todo/2026-11-11_bash-extension-choice/COMPARISON.md` § "Decisions" (binding, esp. 6: the
extension keeps no truncation numbers of its own; 9: presentation-only deviations, logs stay
raw). The lost-notification fix that shipped today (`5e6aea6`, `7ad3bf5`) is the baseline this
plan builds on.

## 1. Goal

Keep what this extension is uniquely good at — backgrounding, durable job records, delivery
+ reconcile, the `pbb` CLI — and stop owning anything pi already owns: process execution,
environment, output accumulation/truncation, error texts, structured results.

Non-goals: no upstream patches/PRs (pi's maintainers' defaults are presumed deliberate); no
PTY / fake interactivity; no truncation or ANSI policy inside the background layer; no
behaviour change to builtin bash when this extension is absent.

## 2. Target architecture

```
pi core bash tool  (createBashToolDefinition)
   ├─ env: getShellEnv() + PI_SESSION_*/PI_PROVIDER/PI_MODEL/PI_REASONING_LEVEL
   ├─ OutputAccumulator (bounded RAM, streaming UTF-8, temp spill)
   ├─ truncation (2000 lines / 50 KB) + details.truncation/fullOutputPath,
   │    structuredContent, outputSchema
   └─ error texts, 128+signum, timeout/cwd validation, 100 ms update throttle
        ▲                                     ▲
        │ operations.exec                     │ context hook
        │                                     │
┌───────┴─────────────────┐        ┌──────────┴──────────────────────┐
│ background-bash (this)  │        │ bash-output-format (new)        │
│ - detached spawn, pgid  │        │ - CR collapse + ANSI strip      │
│ - log file write-through│        │   (every result; presentation)  │
│ - job records + events  │        │ - head+tail reshape of results  │
│ - 30 s auto-promotion   │        │   pi already truncated          │
│ - completion + reconcile│        │ - historical-result size guard  │
│ - pbb CLI               │        │                                 │
└─────────────────────────┘        └─────────────────────────────────┘
```

Two extension entry points, one package (one nix build, one settings entry; splittable
later). They share `lib/output-format.ts`, so the completion body and the model-facing tool
result are formatted by the same helpers — but not by the same formatter: the hook rewrites
the model-facing message list only, and the TUI keeps rendering stored entries (§7).

## 3. Repo layout

```
extensions/background-bash.ts     # registers `bash` (spread of pi's definition + wrapper)
extensions/output-format.ts       # registers the `context` hook
lib/output-format.ts              # pure helpers: collapse, strip, head+tail, marker text
lib/child-exit.ts                 # foreground exit detection with a detach() (§4.1)
lib/job-store.ts                  # job files + events + delivery bookkeeping (moved out)
bin/pbb.js                        # CLI (scope semantics updated)
test/background-bash.test.mjs     # existing suite, adapted
test/output-format.test.mjs       # new
test/exec-contract.test.mjs       # new: operations.exec vs pi's expectations
```

Packaging: `package.json`'s `files` is an explicit allowlist (today it lists
`index.ts`, `extensions/background-bash.ts`, `bin/pbb.js`, `docs`, `skills`, … — no `lib/`),
so it must gain `lib/` and `extensions/output-format.ts`, or the nix build ships a package
whose entry points import missing files. The single `pi.extensions` entry (`./index.ts`)
registers both extensions; no second entry point is needed.

## 4. `operations.exec` — the contract we must honour

pi validates nothing before calling `exec`; everything below currently lives in
`createLocalShellOperations` (`pi/src/core/tools/bash.ts:97-172`) and must be reproduced:

| pi expects | our implementation |
| --- | --- |
| `exec(command, cwd, {onData, signal, timeout, env}) → Promise<{exitCode}>` | spawn `bash -lc <command>` (login shell kept — see Q1), `detached: true`, `stdio: ["ignore","pipe","pipe"]` |
| raw bytes to `onData` | `child.stdout/stderr.on("data", chunk => { onData(chunk); appendToLog(chunk) })` — never a decoded string |
| `throw new Error("aborted")` on abort | `signal` listener → group SIGTERM, then SIGKILL after 500 ms → throw `"aborted"` |
| timeout handled inside exec | validate first: `Invalid timeout: must be a finite number of seconds` / `Invalid timeout: maximum is 2147483.647 seconds`; then `throw new Error("timeout:" + secs)` after killing the group |
| cwd check before spawn | `Working directory does not exist: ${cwd}\nCannot execute bash commands.` |
| exit-code convention: `exitCode ?? (signalCode ? 128 + (signals[signalCode] ?? 0) : 1)` (`bash.ts:157-158`) | copy that expression verbatim (`child.signalCode` + `os.constants.signals`) — local ops never return `null`; with no code and no signal the fallback is `1`. A `null` return is what pi turns into "Command terminated without an exit code" |
| must not hang on inherited pipes | §4.1 |

Deliberate additions to that contract: write-through of every chunk to
`logs/<jobId>.log` (the canonical full-output file) and a per-job process-group record.

### 4.1 Waiting for the child (`waitForChildProcess`)

pi's `waitForChildProcess` (`utils/child-process.ts:49-137`) is the piece that makes a
one-shot bash call safe: after `exit` it keeps reading and re-arms a 100 ms idle timer on
every chunk, so a detached descendant that inherited the pipe cannot hold the turn open
(earendil-works/pi#5303); on settle it `destroy()`s both streams and removes its listeners.

That settle-time `destroy()` is exactly why it is a **foreground-only** tool. `exec` cannot
know whether the wrapper will promote the call (§5), and destroying the streams of a job that
is still writing silently ends the log. So:

- the unpromoted foreground window uses those semantics — 100 ms re-armed idle drain, `close`
  wins, no fixed deadline measured from `exit`;
- promotion retires them: from then on we own exit detection, with our own `exit`/`close`
  listeners plus the idle grace (`EXIT_STDIO_GRACE_MS`, today's 750 ms), and the streams are
  never destroyed while the job lives;
- pi exports only the package root (`packages/coding-agent/package.json:14-22`), so the
  helper is not importable from an extension: `lib/child-exit.ts` mirrors it with
  `detach()` replacing settle-time `destroy()`. If pi ever exports it, drop the mirror.

## 5. Tool registration and promotion

```ts
const inner = createBashToolDefinition(process.cwd(), { operations: { exec: pbbExec } });
pi.registerTool({
  ...inner,                                   // name/label/description/renderers
  parameters: Type.Object({ ...inner.parameters.properties, background: Type.Optional(Type.Boolean()) }),
  outputSchema: Type.Object({                 // pi's fields + ours (§5.1)
    ...(inner.outputSchema as TObject).properties,
    job_id: Type.Optional(Type.String({ description: "Background handle for pbb and the completion follow-up" })),
    exit_code: Type.Optional(Type.Number({ description: "Absent when job_id is set" })),
  }),
  description: `<pbb description: background flag, 30s auto-promotion, head+tail + full-output path>`,
  promptGuidelines: [...],
  execute: (id, params, signal, onUpdate, ctx) => pbbExecute(inner, id, params, signal, onUpdate, ctx),
});
```

- **No `ctx` at registration.** The factory gets only `ExtensionAPI`, so the cwd argument is
  `process.cwd()` (same as the reference implementation, `tmp/pibg/index.ts:77`). It is only a
  fallback: `execute` resolves `ctx?.cwd || cwd` (`bash.ts:269-271`), so the call's real cwd
  always wins over the registration-time guess.
- **Forward `ctx` as the 5th argument** to `inner.execute` — pi strips stale `PI_*` and only
  re-injects them when `ctx` is present. (pi's own `ssh.ts` example drops it; that would
  silently reintroduce the P0 bug.)
- Job id is allocated by `pbb` (`bg001…`, per instance dir, unchanged scheme).
- `background: true` → promote immediately (before the first chunk).
- Otherwise race `exec` against `waitForBackgroundThreshold(seconds)`:
  - command wins → return pi's result untouched, except `details.fullOutputPath` is pointed
    at our log file when the output was truncated; delete the log if it was neither
    truncated nor promoted.
  - threshold wins → **promote**: mark the job promoted, stop forwarding `onData`, resolve
    the inner `exec` with a synthetic `{exitCode: 0}` so pi finishes its call, and replace
    the returned content/details with the "moved to background after Ns" result (job id,
    log path). The child handle, log writes and pgid tracking continue in our layer.
- **Flush before resolving.** Promotion first pumps the pending bytes (write-through queue and
  the buffered `onData` tail) and only then resolves, otherwise the tool answer is short by
  the last chunk (`tmp/pibg/foreground.ts:254-269`: `pump(true)`, then `resolve`).
- **The abort listener is disposed at promotion.** `signal` is the whole run's signal: one
  `AbortController` per run (`packages/agent/src/agent.ts:522-534`), handed unchanged to
  `tool.execute` (`packages/agent/src/agent-loop.ts:999`) — not a per-call signal. A listener
  that survives promotion therefore SIGTERMs a job the model was just told is running, on the
  next turn's abort. So: `removeEventListener` on promotion *and* on normal completion
  (today's code does it on the promotion path at `extensions/background-bash.ts:1702`; the
  reference impl does it inside its `finish()` at `tmp/pibg/foreground.ts:176-186`), and
  re-check `signal.aborted` **after** spawn — a pre-spawn check alone misses an abort that
  arrived while the process was being spawned (`tmp/pibg/foreground.ts:283-285`). After
  promotion the only kill paths are `pbb kill`, the job timeout and session shutdown.
- Promotion is atomic with respect to delivery: the job record is only marked `promoted`
  once the synthetic resolution has been handed to pi.
- The TUI row rendering comes from the spread definition (`createShellRenderers`); the
  completion message keeps this repo's own renderer.

### 5.1 Structured content

The inner execute still returns `{ output, truncated, full_output_path, exit_code,
wall_time_seconds }` (`bash.ts:390-402`), and `full_output_path` points at *pi's* temp file —
which §12 deletes once we have a longer-lived one. codemode hands `structuredContent` to
scripts verbatim (`extensions/codemode/tool.ts:12-15`), so leaving it alone is not an option:

- **foreground**: keep pi's object, but replace `full_output_path` with the job log when the
  result was truncated (keeping pi's temp file only if we have nothing better);
- **promoted**: `{ output: <text so far>, truncated, full_output_path: <log path>, job_id,
  wall_time_seconds: <time to promotion> }` with **no** `exit_code` — honest about a job that
  is still running. This is why the extended `outputSchema` above makes `exit_code` optional
  (pattern: `tmp/pibg/index.ts:97-105`).

## 6. Job records and delivery (ported from today's code, trimmed)

`jobs/<jobId>.json` fields kept: `jobId, globalJobId, command, cwd, status, outcome,
exitCode, startedAt, completedAt, durationMs, pid, pgid, sessionId, sessionKey, sessionFile,
instanceId, lane, logPath, logTruncated, logBytes, delivered, deliveredAt, deliveredReason,
droppedReason, lostReason, killSignal, promotedAt, promotionThresholdSeconds`.

`events.jsonl` events kept: `job.started`, `job.promoted`, `job.kill_requested`,
`job.completed`, `job.lost`, `job.completion_delivered`, `job.completion_deferred`.
**Dropped: `job.output`** (the per-chunk write that produced 4594 events / 1.3 MB per
instance).

Delivery:
- finalize records the REAL outcome first (`delivered: false`);
- shutting down / send failure → `droppedReason`, no send, sweep re-delivers later;
- otherwise mark `delivered: true` *before* `sendMessage` (revert on throw);
- completion message: head+tail from the log file (`lib/output-format.ts` — only when the
  body is longer than pi's own truncation window, §7), the job id, the outcome wording, and
  the log path; `deliverAs: "steer"`, `triggerTurn: true`;
- boot reconcile unchanged in behaviour: sessionKey-filtered, coalesced digest, 24 h expiry,
  cap 20 + defer, dead-owner jobs → `outcome: "lost"` (never a fabricated exit);
- per-session state, per-session `pi`, `WeakRef` pruning: unchanged.

Log hygiene (new): appending to the log **stops** at `maxLogBytes` (default 100 MB, Q2). No
marker line is written into the file: the fact is recorded in the job file as
`logTruncated: true` + `logBytes`, and surfaced in the completion body and in `pbb status` /
`pbb tail`, whose notice then reads "log capped at 100 MB" instead of promising the full
output. A marker written into the log would break Decision 9 (logs stay raw) — `pbb tail` and
`formatLogFile` would render it as command output. Delete logs older than 7 days at
`session_start`; never delete a log whose job is running or undelivered.

## 7. Output formatting (`lib/output-format.ts` + `extensions/output-format.ts`)

Decisions 6 and 9 bound this section: the extension keeps **no truncation numbers of its
own**, and every deviation is presentation-only (collapse `\r` frames, strip ANSI/control
sequences, head+tail with the log path). That splits the layer into two different jobs:

**(a) presentation — every bash result and every pbb completion body**: collapse `\r` to the
last frame, strip escapes. No size budget, no path rewriting, no exceptions.

**(b) head+tail reshape — the same path for tool results and completion bodies**: a tool
result carrying `details.truncation` / `details.fullOutputPath` (built at `bash.ts:343`,
returned at `bash.ts:404-408`), and **every** completion body, built by
`formatLogFile(path, …)` from the job log. A completion body is therefore formatted exactly
like a foreground result: `formatLogFile` reads the log's first `headLines` and last
`tailLines` lines (two seeks, never a whole 100 MB read), emits
`… N lines / X omitted …` between them and closes with `Full output: …` — but only when the
log exceeds pi's window; a log that fits in 2000 lines / 50 KB is sent whole. A log that hit
`maxLogBytes` additionally states that its tail is not the end of the output. Anything else
(tool results pi did not truncate) passes through byte-for-byte, so a foreground call can
never become tighter than builtin bash: the trigger stays pi's 2000 lines / 50 KB
(`truncate.ts:11-12`).

Why completion bodies are not an exception (they were, and it was a bug): §6 promises
"head+tail from the log file", and the live exercise showed the older tail-only body
delivering 12.1 KB of lines 1001-3000 for a promoted `seq 1 3000` — head lost, contradicting
the decision that foreground and background output are formatted identically. `formatLogFile`
is the one function both use.

This is the honest consequence of Decision 6: until head+tail lands in pi core's bash tool,
this layer is a local stand-in that only reshapes what core already truncated — and the "head"
it can show is the head of core's *window* (core keeps the tail), not of the full output. The
log path is the only route to the real head.

Pure functions:
- `collapseCarriageReturns(text)`: per line, keep the text after the last `\r`.
- `stripEscapes(text)`: ANSI CSI/OSC sequences and control chars except `\n`/`\t`
  (small own implementation, credited to pi-bg-bash's `sanitize.ts` — MIT).
- `headTail(text, { headLines, tailLines, totalLines, fullOutputPath })`: slice with pi's own
  helpers rather than new math — `truncateHead(text, { maxLines: headLines })` and
  `truncateTail(text, { maxLines: tailLines })` (`truncate.ts`) — then join them with
  `… N lines omitted …`, `N = totalLines - headLines - tailLines` from
  `details.truncation.totalLines`. Footer reuses pi's wording, `Full output: <path>` (omitted
  only when no path exists) — and it names **every** window the body shows
  (`[Showing lines 1-3 and 4991-5000 of 5000. Full output: <path>]`): a body with three head
  lines above the marker may not claim it shows only the tail window. Idempotent: a body
  already carrying the omitted marker is left alone.
- `formatLogFile(path, { headLines, tailLines })`: the completion-body variant, reading only
  the first/last bytes of the file (no whole-file reads), so a 100 MB log costs two seeks. It
  is what §6's completion body calls.

Hook (`pi.on("context")`):
- for each `toolResult` of `bash` and each `custom_message` carrying `details.fullOutputPath`:
  apply (a) always, then (b) only when the result was truncated;
- **memoized by `toolCallId` and frozen**: the formatted body is computed once and reused for
  the rest of the session. Keying on `(path, size, mtimeMs)` would re-derive a historical
  result from a log that is still growing — the same tool result would read differently on
  later requests and break provider prompt-cache prefixes. The file is read at most once per
  `toolCallId`; pi clones the message list per request, but the string we hand back is the
  same value;
- the historical-result size guard stays here (Decision 6: trimming oversized *historical*
  results on replay is not output formatting) and is applied as a one-time transformation of
  the same frozen body;
- never touch files, logs or the session JSONL.

**What the hook does not reach** ("one owner formats results" is not true and is not claimed):
the `context` hook rewrites the model-facing message list only. The TUI renders the stored
entries (`renderers/bash.ts:55-70` previews the stored text), and codemode reads
`structuredContent` (§5.1). Model text ≠ human text ≠ script text, and each surface is fixed
where it is produced.

**PENDING DECISION (Q5)**: the exact head/tail counts — recommendation 3 head + 10 tail,
matching Decision 5's example. One named constant pair, not a config surface for the model to
discover; if pi core takes the policy over, the counts move there with it.

## 8. CLI and scoping

- `pbb list` / `pbb status` default scope: **this session + this instance** (both must match).
  `--scope session` → all instances of this session; `--scope all` → every session under the
  root (explicit opt-in, for forensics).
- This is a **documented breaking change**, not "unchanged": today the scope resolves as
  `opts.scope || (opts.instance ? "session" : "current-instance")` in four places
  (`bin/pbb.js:260,278,303,337`), `identity()` advertises `scopeDefault: "current-instance"`
  (`bin/pbb.js:65`), and the built-in help already lists `--scope current-instance|session`
  (`bin/pbb.js:381`). Ship it with the new value in the help text plus a migration note in the
  README and the pbb skill: "`pbb list` was per instance and is now per session+instance;
  `--scope all` is how you get the old forensic sweep".
- Subagent sessions have their own sessionKey, so they never appear by default — in the CLI
  or in the TUI pending widget (per-session namespace).
- Unchanged: `pbb self`, `pbb tail`, `pbb kill`, `pbb kill --stale`, `--json`, `--lines`,
  `--signal`, job-id scheme.

## 9. What gets deleted

`runPbbBash`'s spawn/output/accumulate logic, the truncation helpers
(`shouldTruncateBody`, `truncateBodyWithHint`, `truncateLiveBody`, `truncateBackgroundBody`,
`truncateForeground*`, `writeForegroundFullOutput`, `formatTruncationNotice` usage),
`exportPbbEnv`, `buildXmlResult` (completion body becomes plain text + `details`),
`MAX_ACTIVE_JOBS` const (→ config), `EXIT_STDIO_GRACE_MS` for the promoted path (kept only to
drain the foreground tail), the per-chunk `appendPbbEvent`.

Deleting the XML envelope has a second half: two readers currently regex the job id out of
it — `jobIdsSeenInSession` (`extensions/background-bash.ts:1107-1108`) and
`sessionJobNumberFloor` (`:1485-1486`) — and both switch to `details.jobId`, which every
result already carries (`:1101`).

## 10. Config (`~/.pi-background-bash/config.json`, project `.pi/background-bash.json`)

| key | default | note |
| --- | --- | --- |
| `autoBackgroundAfterSeconds` | 30 | existing; `0` disables |
| `maxActiveJobs` | 20 | replaces the hard-coded 10 (Q2) |
| `maxLogBytes` | 100 MB | append stops; recorded as `logTruncated` + `logBytes`, never written into the log (Q2) |
| `loginShell` | true | `-lc` vs `-c` (Q1) |

Output-format config (`~/.pi/bash-output.json`): `headLines` 3, `tailLines` 10 — counts only,
no byte budget of our own (pi's truncation is the only budget); both PENDING (Q5).

## 11. Tests

Port the existing 38 (adapted to the new internals) and add:
1. **exec contract**: aborted → `"aborted"`; timeout → `"timeout:N"` + validation texts;
   SIGKILL → `128+9`; missing cwd → pi's message; and the code-less, signal-less exit → `1`
   (never `null`).
2. **env parity**: a foreground and a backgrounded call both see `PI_SESSION_ID`,
   `PI_SESSION_FILE`, `PI_MODEL`; a `/model` change is visible on the next call; stale
   `PI_*` absent.
3. **promotion**: tool result returns within ~1 s of the threshold; the promoted answer
   contains the last chunk written before promotion (flush-before-resolve); same job id in
   result, job file and completion; log contains both pre- and post-promotion output; output
   after promotion does not reach the (finished) tool call; an abort from the *next* run does
   not kill the promoted job (listener disposed).
4. **full output path / structured content**: a truncated foreground result carries
   `details.fullOutputPath` and `structuredContent.full_output_path` pointing at the log, and
   the file contains the full output; a promoted result carries `job_id` and no `exit_code`.
5. **format**: a small result is byte-identical to pi's output (no budget applied); head+tail
   marker/counts/path appear only for results pi truncated; CR collapse keeps the last frame;
   ANSI stripped; idempotent; frozen — growing the log after the first request does not change
   the body (one file read per `toolCallId`).
6. **scope**: a subagent-style sibling session's jobs are absent from `pbb list` default and
   from the pending widget; `--scope all` shows them.
7. **regressions from today**: sibling-session shutdown does not drop completions; inherited
   stdout does not block completion; sweep re-delivers exactly once; lost jobs are honest;
   already-delivered completions are not replayed.
8. **reload**: a job promoted before `/reload` is finalized by the old module with
   `delivered:false` and re-delivered by the next `session_start`.
9. **packaging**: `npm pack --dry-run` contains `lib/`, both extension entries and
   `bin/pbb.js` (the §3 allowlist).

## 12. Risks / mitigations

| risk | mitigation |
| --- | --- |
| exec-contract drift (silent UX difference vs builtin) | itemized table in §4 + `test/exec-contract.test.mjs` asserting exact strings |
| promotion patching the inner result | assert content, details *and* `structuredContent` in tests (§5.1); retarget `fullOutputPath`/`full_output_path` to our log, delete pi's temp file only when we have our own |
| log write-through misses very late descendant output | promoted jobs never destroy the streams and keep an exit+idle grace (750 ms); a descendant silent past the grace is documented as a bounded gap |
| log marker tempting its way into the file | `logTruncated` lives in the job file only (§6); a test asserts the log's byte tail is untouched command output |
| `/reload` mid-flight | old module finalizes with `delivered:false`; next `session_start` reconcile delivers |
| subagent sessions (start, never shut down) | `WeakRef` prune (already shipped) |
| disk: 100 MB/job × N | cap + 7-day retention + never delete running/undelivered logs |
| packaging: `files` allowlist drift | §3 note + the `npm pack --dry-run` test, so a missing `lib/` fails in CI rather than after a nix build |
| pi version change | pinned by the `1.4.0` API surface we use (`BashOperations`, `createBashToolDefinition`, `outputSchema`, `context`); no upstream dependency added |

## 13. Sequencing

1. `lib/job-store.ts` extraction (pure move, no behaviour change; suite still green).
2. `operations.exec` (+ `lib/child-exit.ts`) + tool registration + promotion + structured
   content; `test/exec-contract.test.mjs` green.
3. Delete the old spawn/truncation code. For this step only, the completion body is pi's own
   plain truncation of the log (core's helpers, core's defaults — no numbers of ours) + job id
   + log path: exactly what builtin bash would produce, so the intermediate state is coherent.
4. `lib/output-format.ts` + `extensions/output-format.ts` + tests. Not independent, which is
   why it moves here: its assertions (path in the marker, head+tail of a real file) need the
   promotion / `fullOutputPath` producer from step 2 to exist, and it is no longer a behaviour
   change for every bash call — only for results pi already truncated.
5. CLI scope semantics (breaking, §8) + `job.output` removal + packaging (§3 allowlist,
   `pi.extensions` entry).
6. Full suite + a manual live check in a scratch pi session (`pi -e .`), then a decision on
   how the build reaches manu's sessions (npm publish vs nix package — still his call).

## 14. Open questions

1. **Q1 login shell**: keep `bash -lc` (documented contract; sandbox/nix PATH) with
   `loginShell` config, or match pi exactly with `-c`? Rec: keep `-lc`, configurable.
   **PENDING.**
2. **Q2 caps**: `maxActiveJobs` 20 and `maxLogBytes` 100 MB (append stops, `logTruncated`
   recorded in the job file, nothing written into the log) acceptable? **PENDING.**
3. **Q3 package split**: one package with two extension entries (rec) vs `bash-output-format`
   as its own package? **PENDING.**
4. **Q4 envelope**: does anything still need the `pi_context` XML envelope for completions, or
   is plain text + `details` fine? Rec: plain text. **PENDING.**
5. **Q5 head/tail counts**: the only truncation numbers in this layer, and they only reshape
   results pi already truncated — 3 head + 10 tail (rec, Decision 5's example) or something
   else? **PENDING.**

## 15. Review findings applied

Adversarial review, 2026-11-11. This plan is the post-review revision; each finding and where
it landed. (`tmp/pibg/*.ts` citations point at a local, gitignored copy of pi-bg-bash's
`src/`, kept as the reference implementation — re-fetch gvanderclay/pi-bg-bash if it is gone.)

1. §7 no longer imposes a head+tail / 8 KiB budget on every result (that would have been ~6×
   tighter than pi's 2000 lines / 50 KB, `truncate.ts:11-12` and a violation of Decision 6):
   the reshape runs only on results pi already truncated and on completion bodies, sliced with
   pi's helpers; the counts are Q5, PENDING.
2. §4's exit-code row copies pi's real expression (`bash.ts:157-158`); local ops never return
   `null`.
3. §4.1 specifies `waitForChildProcess` (`utils/child-process.ts:49-137`): foreground window
   only, retired at promotion so its settle-time `destroy()` cannot cut the log write-through.
4. §5 disposes the abort listener at promotion (today: `extensions/background-bash.ts:1702`)
   and re-checks `signal.aborted` after spawn (`tmp/pibg/foreground.ts:283-285`) — one signal
   per run (`agent.ts:522-534`, `agent-loop.ts:999`).
5. §5.1 returns honest `structuredContent` for both paths and extends `outputSchema`, because
   codemode consumes it (`extensions/codemode/tool.ts:12-15`) and §12 deletes pi's temp file.
6. §5 registers with `process.cwd()` — no `ctx` at registration (`tmp/pibg/index.ts:77`) — and
   notes that `ctx.cwd` wins at call time (`bash.ts:269-271`).
7. §5 flushes pending output before resolving the promoted call
   (`tmp/pibg/foreground.ts:254-269`).
8. §7 freezes the formatted body per `toolCallId` instead of re-deriving it from a
   still-growing log (prompt-cache prefix correctness).
9. §7 states the hook's real reach — model text only; the TUI renders stored entries
   (`renderers/bash.ts:55-70`) and codemode reads `structuredContent`. No "one formatter"
   claim.
10. §6 records `logTruncated`/`logBytes` in the job file instead of writing a marker into the
    log (Decision 9: logs stay raw, `pbb tail` keeps showing command output only).
11. §9 names the two `pi_context`-parsing readers (`extensions/background-bash.ts:1107-1108`,
    `:1485-1486`) and moves them to `details.jobId`.
12. §3/§8/§13: `package.json` `files` allowlist extended for `lib/` + the second extension
    entry; the CLI scope default is described as a documented breaking change with a
    migration note (`bin/pbb.js:65,260,278,303,337,381`).
13. §13 resequenced: exec seam → delete old spawn/truncation code → output-format layer →
    CLI/packaging (the output-format step was not independent).
