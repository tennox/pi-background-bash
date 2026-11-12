# PBB runner

PBB is the baseline bash runner for pi-background-bash v1.

## Contract

- Every command runs through `bash -lc`.
- Background jobs are owned by PBB from process start, and owned *per session*: one pi process serves several sessions (`/new`, `/resume`, subagents) and each owns only its own jobs.
- Job IDs use fixed-width local IDs: `bg001`, `bg002`, ..., `bg999`, then `bg1000`. IDs are unique per instance directory; the allocator is process-wide so two sessions sharing an instance directory cannot collide.
- Jobs record `pid` and `pgid` for process-group control.
- `pbb list`, `pbb status`, and `pbb tail` inspect the recorded job state/logs.
- `pbb kill` requests live owner shutdown through the instance mailbox.
- `pbb kill --stale --instance <id> <job>` explicitly signals a stale recorded process group.
- Verbose completion messages are truncated in-session and point to `pbb tail <job> --full` for complete output.
- `pbb` is put on `PATH` for spawned commands (`<root>/bin/pbb` shim); per-spawn `PBB_*`/`PI_LANE_SESSION_*` identity is never written into `process.env`.

## Job file lifecycle

`jobs/<id>.json` moves through `running` → a terminal status (`exited`, `timeout`, `abort`, `error`, `lost`).
Delivery bookkeeping is recorded on the file:

| field | meaning |
| --- | --- |
| `delivered` | `true` once the completion reached the agent (written *before* the send, so a crash cannot double-deliver) |
| `deliveredReason` | `live`, `reconcile`, `reconcile_lost`, `already_in_session_history`, `reconcile_expired` |
| `droppedReason` | `session_shutdown`, `send_failed: …` — the completion was recorded but could not be delivered; the reconcile sweep re-delivers it |
| `deferredReason` | `reconcile_capped` — deferred to the next session start |
| `lostReason` | set when the owner process died before recording a completion; the outcome is `lost` and is **never** fabricated as `exit` |
| `logBytes` | bytes the log holds; stops growing at `maxLogBytes` |
| `logTruncated` | `true` once the log hit `maxLogBytes` and appending stopped |

## Log hygiene

A job's log stops growing at `maxLogBytes` (default 100 MB, see the README's
configuration section). The cap is recorded **only** in the job file as
`logTruncated: true` plus `logBytes` — never as a marker line inside the log, because the
log is the command's own bytes and nothing else. The fact is surfaced in the job's
completion message, in `pbb status`, and in `pbb tail`.

At `session_start` the extension deletes this session's job logs older than 7 days, except
logs whose job is still running or whose completion was never delivered (that record is the
only copy of output the agent has not seen yet).

A job file must never stay at `status: "running"` after its command ended. `delivered: false` with a
`droppedReason` is the honest record of a notification that could not be delivered in-process.

## Output formatting

The extension ships two entry points: the runner in `extensions/background-bash.ts` and the
model-facing output layer in `extensions/output-format.ts` (helpers in
`lib/output-format.ts`). The output layer is a presentation-only filter — it never changes what a
command does, what the log holds, or what the TUI shows.

**What the model reads.** Every `bash` tool result and every completion body:

- ANSI/CSI/OSC sequences and control characters are stripped (`\n` and `\t` stay), and each line
  keeps only its last `\r` frame, so a progress bar reads as its final state instead of 2000 frames;
- a result pi itself truncated (`details.truncation` / `details.fullOutputPath`) is reshaped to the
  **first 3 lines + `… N lines / <size> omitted …` + the last 10 lines + `Full output: <path>`**, with the
  counts taken from pi's own truncation numbers. Results pi did not truncate pass through
  byte-for-byte: this layer has no size budget of its own and can never make a result tighter than
  builtin bash;
- an oversized *historical* result that carries no full-output path is trimmed by the context guard
  (pi's 2000-line/50 KB window, tail kept), as before;
- each body is computed **once** and frozen for the session, keyed by its `toolCallId` — re-deriving
  from a log that is still growing would move text under an already-sent prompt prefix.

A completion body is capped like a pi tool result and names `pbb tail <job> --full`. A job whose log
hit `maxLogBytes` is instead reshaped from the log's first and last bytes and says explicitly that
its tail is not the true end of the output.

**What the log holds.** The log stays raw: exactly the command's bytes, nothing added. Neither the
cap nor any formatting marker is ever written into it, so `pbb tail`, `rg`, and every other reader
see unfiltered output. `logTruncated`/`logBytes` live in the job file only.

**What is deliberately not affected.** The layer rewrites the model-facing message list only, so:

- the TUI keeps rendering the stored transcript entries (pi's bash renderer) — human text ≠ model text;
- codemode reads `structuredContent`, which the tool produced;
- compaction summarises the raw message text, not the formatted body.

Each surface is fixed where it is produced; “one owner formats everything” is not claimed.

Counts are configurable in `~/.pi/bash-output.json` (project override: `.pi/bash-output.json`):
`headLines` (3), `tailLines` (10), `maxLines` (2000) and `maxBytes` (51200). The first two are
presentation counts pending sign-off; the last two are pi's own truncation window, not numbers of
this layer's own.

## Reconcile sweep

At `session_start` the extension scans its own `sessionKey`'s job files (never another session's —
filtered on the stored `sessionKey`, not on the directory) and:

- re-delivers terminal jobs with `delivered: false` as **one** coalesced `background_bash_digest` message (max 20 entries per start; the rest are deferred);
- finalizes `running`/`kill_requested` jobs whose recorded `pid` **and** `pgid` are both gone as `lost`, with the log tail in the digest;
- marks completions older than 24h as not re-delivered (`deliveredReason: "reconcile_expired"`) instead of replaying ancient history.

## v1 migration stance

v1 is a hard migration to PBB-owned execution. There is no alternate native-runner mode and no compatibility shim.

If a caller depended on exact pre-v1 bash formatting, update the caller to use the v1 PBB contract above.
