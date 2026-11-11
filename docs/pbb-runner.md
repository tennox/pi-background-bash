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

A job file must never stay at `status: "running"` after its command ended. `delivered: false` with a
`droppedReason` is the honest record of a notification that could not be delivered in-process.

## Reconcile sweep

At `session_start` the extension scans its own `sessionKey`'s job files (never another session's —
filtered on the stored `sessionKey`, not on the directory) and:

- re-delivers terminal jobs with `delivered: false` as **one** coalesced `background_bash_digest` message (max 20 entries per start; the rest are deferred);
- finalizes `running`/`kill_requested` jobs whose recorded `pid` **and** `pgid` are both gone as `lost`, with the log tail in the digest;
- marks completions older than 24h as not re-delivered (`deliveredReason: "reconcile_expired"`) instead of replaying ancient history.

## v1 migration stance

v1 is a hard migration to PBB-owned execution. There is no alternate native-runner mode and no compatibility shim.

If a caller depended on exact pre-v1 bash formatting, update the caller to use the v1 PBB contract above.
