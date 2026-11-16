---
name: pbb
description: Inspect Pi background bash jobs with the pbb CLI. Use when checking status, tailing output, or debugging long-running bash commands started by pi-background-bash.
---

# pbb — Pi Background Bash inspector

Use `pbb` to inspect background bash jobs instead of rerunning long commands just to check progress.

## Identity model

`pbb` uses the session/instance identity of the Pi runtime it runs in:

- `session_id`: persisted Pi conversation
- `session_key`: stable lane session key
- `instance_id`: this live Pi runtime
- `lane`: current pi-lane lane (when pi-lane is installed)

Default scope is **this session + this instance**. Jobs from sibling instances, subagent
sessions and other sessions are hidden; the `pbb list` output says which scope it applied and
how to widen it. Do not assume a short list means nothing is running — widen and look before
concluding that.

## Commands

```bash
pbb self
pbb list
pbb status <job_id>
pbb tail <job_id> [-n 80]
pbb kill <job_id>
```

Widening is always explicit:

```bash
pbb list --scope session     # every instance of this session
pbb list --all               # every session under the root (== --scope all), for forensics
pbb list --all --owner       # … and probe owner liveness (one pil call per session)
pbb instances                # instances of this session; --all for every session
pbb status --instance <instance_id> <job_id>
pbb tail --instance <instance_id> <job_id>
```

`--all` returns in about a second, even with 500+ sessions, because it does **not** probe
owner liveness (that used to be one `pil instances` process per session, i.e. minutes).
Unprobed owners read `owner=unknown` with a note; `--owner` probes them. Never read an
unprobed `unknown` as evidence that an owner is gone.

`pbb status <id> --json` carries the job as `jobs: [job]` (an array, the same shape `pbb list`
uses; canonical). The single-object `job` key is a deprecated alias of the same record.

## Tailing

`pbb tail <job_id>` prints the last 80 lines, `--full` the whole log, `-n N` another count.

A **foreground** call records no job (pi's own result is the record), but it does leave
`<instance>/logs/<job_id>.log` — and every truncated result and completion advertises
`pbb tail <job_id> --full`. For such an id `pbb tail` falls back to the log file and reports
`kind=log-only` (`jobKind: "log-only"` in `--json`), with the session/instance the log came
from; no job fields are invented. If several instances have a log under that id, the most
recently written one is shown and the count of others is named — use `--instance` to pick.

## Owner liveness

`pbb list` / `pbb status` report the owning runtime as `owner=live`, `owner=stale`,
`owner=dead` or `owner=unknown`:

- `live` / `stale` come from pi-lane's instance record (heartbeat) when pi-lane has seen that
  instance;
- with no pi-lane record, pbb checks the pid recorded in the instance's own `identity.json`
  (and in the `pbb_<pid>_<hash>` instance id) — `owner=live` when that process exists,
  `owner=dead` when it is gone;
- `unknown` means pbb has no liveness source at all — it is **not** evidence the owner is gone.

Cooperative `pbb kill` needs a live owner polling its mailbox. `owner=dead` and `owner=unknown`
say so explicitly; jobs record `pgid`, and a process-group kill requires explicit intent:

```bash
pbb kill --instance <instance_id> --stale <job_id>
```

## Agent guidelines

- After starting a long background bash, normally wait for the completion follow-up and continue independent work.
- Use `pbb list` or `pbb status <job>` only when you need progress before completion, need to manage/kill a job, or suspect the follow-up was missed.
- Use `pbb tail <job>` for bounded output instead of rerunning the command.
- If a monitoring command is already running or sleeping in the background, do **not** schedule another delayed check such as `sleep 120; ...`, `sleep 300; ...`, or another polling loop. Use `pbb tail <job>` / `pbb status <job>` instead.
- For CI/deploy monitoring, prefer one polling job. If it auto-backgrounds, keep reusing that job with `pbb tail <job>` instead of launching new `gh run list` commands after sleeps.
- Treat late background result follow-ups as potentially stale: compare the command/commit/run ID in the result against the current target before reporting status.
- Treat `pbb` output as authoritative for session/instance/job identity.
- If a job is ambiguous or belongs to another instance/session, ask before operating on it.
- `pbb kill` is intentionally conservative; same-instance live-runtime control is safest.
- `owner=stale`/`owner=dead`/`owner=unknown` mean the mailbox request may never be picked up — do not claim a kill happened.
