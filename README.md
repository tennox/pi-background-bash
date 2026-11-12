# pi-background-bash

Async/background `bash` for [Pi](https://github.com/earendil-works/pi): keep using the normal `bash` tool, but long-running commands stop blocking the agent.

`pi-background-bash` replaces Pi's bash execution with the PBB runner and adds two quality-of-life features:

- `background: true` starts a command in the background immediately.
- normal foreground commands automatically move to the background after 30 seconds.

As of v1, PBB-owned execution is the baseline: background jobs are recorded with logs plus `pid`/`pgid`, and a background job's full output is available through `pbb tail` (a small foreground call that was neither truncated nor promoted leaves no log behind).

When a background command finishes, the extension injects a follow-up result into the session and wakes the agent.

## Reliability

A completion is never dropped silently. Four mechanisms keep that true:

- **Per-session ownership.** pi caches the extension factory per cwd, so one loaded module serves every session in a pi process. Job tracking, shutdown state, and the pending-jobs widget are per session; a sibling session's `/new`, `/resume`, `/reload` or quit kills only *its own* jobs. A finishing subagent kills nothing: pi-subagents tears child sessions down with `AgentSession.dispose()`, which never emits `session_shutdown`, so no shutdown hook runs for them — their leftover state is pruned by liveness (a `WeakRef` on the session manager), never by a shutdown kill.
- **Never-drop finalization.** The job file is finalized with the real outcome *before* any delivery attempt. If the session is shutting down (or `sendMessage` throws), the file records `delivered: false` plus a `droppedReason` instead of staying at `status: "running"`.
- **`exit` + idle grace.** A detached descendant that inherits stdout/stderr keeps Node's `close` from ever firing, so completion waits for the child's `exit` plus an idle grace that is re-armed on every output chunk (same approach as pi core's `waitForChildProcess`, earendil-works/pi#5303). A verbose descendant cannot truncate the tail; a silent one releases completion after the grace.
- **Reconcile digest.** On every `session_start`, undelivered completions recorded for *this* session are re-delivered as a single coalesced message (`kind="background_bash_digest"`), and stuck `status: "running"` jobs whose owner process is gone are finalized as `outcome: "lost"` — never fabricated as an exit. Jobs older than 24h are not re-delivered (they are marked with a reason), and at most 20 entries go into one digest; the rest are deferred to the next session start.

## Fork notice

This is a **maintained fork** of [`sshkeda/pi-background-bash`](https://github.com/sshkeda/pi-background-bash) with two fixes:

1. **Installable out of the box.** The upstream package depends on the private repository `github:sshkeda/pi-context` (returns 404), so `pi install` fails for everyone. The three functions it uses (`piContext`, `truncateContextText`, `formatTruncationNotice`) are now inlined in [`extensions/pi-context-utils.ts`](extensions/pi-context-utils.ts) and the dependency is removed.
2. **No stale-ctx crashes.** The background-completion callbacks evaluated `ctx.cwd` lazily, after session teardown in headless one-shot mode, throwing `This extension ctx is stale after session replacement or reload`. `cwd` is now captured eagerly at job start.

Verified end-to-end (interactive + headless): `background: true`, automatic backgrounding after the configured threshold, detached pbb runner with full logs, follow-up injection into the session (`custom_message` entry with `kind="background_bash_result"`), and agent wake-up via `triggerTurn`.

## Why

AI coding agents often need to run slow commands: test suites, builds, dev servers, downloads, deploys, benchmark loops, and watchers. Without background execution, the agent gets stuck waiting. With this extension, the agent can continue useful work and handle the command output when it arrives.

## Install

Install from npm (recommended):

```bash
pi install npm:pi-background-bash
```

Or from this GitHub fork:

```bash
pi install git:github.com/mowenroot/pi-background-bash
```

Try without installing:

```bash
pi -e npm:pi-background-bash
```

> Upstream install (may fail due to the private `pi-context` dependency):
> `pi install git:github.com/sshkeda/pi-background-bash`

Local development:

```bash
git clone https://github.com/mowenroot/pi-background-bash.git
cd pi-background-bash
npm install
npm test
pi -e .
```

## Usage

Run a command normally. If it is still running after 30 seconds, it automatically moves to the background:

```ts
bash({ command: "npm test" })
```

Start a command in the background immediately:

```ts
bash({ command: "npm test", background: true })
```

Add a timeout if you want Pi to kill the command after a fixed number of seconds:

```ts
bash({ command: "npm test", background: true, timeout: 120 })
```

Completion results arrive as Pi context messages:

```xml
<pi_context source="pi-background-bash" kind="background_bash_result" id="bg001" outcome="exit" exit_code="0">
...
</pi_context>
```

Commands run through the PBB-owned bash runner (`bash -lc`) so background jobs have recorded `pid`/`pgid` and can be killed as process groups. Verbose completion messages are truncated in-session with a `pbb tail <job> --full` hint; the full output is kept in the PBB log. See [`docs/pbb-runner.md`](docs/pbb-runner.md) for the v1 runner contract.

## v1 migration

v1 is a hard migration to PBB-owned execution. The old native-runner compatibility path and `PI_BACKGROUND_BASH_RUNNER` switch are gone. If you depended on exact pre-v1 bash formatting, update callers to use `pbb tail <job> --full` for complete output and the recorded PBB job metadata for process control.

## `pbb` CLI

This package also installs `pbb`, a small inspector for background bash jobs.

```bash
pbb self
pbb list
pbb list --scope session   # widen: every instance of this session
pbb list --all             # widen: every session under the root
pbb status bg001
pbb tail bg001 -n 80
pbb kill bg001
```

`pbb` is designed for agents: output is wrapped in compact `pi_context` envelopes and always includes session/instance identity. Local job IDs are fixed-width strings such as `bg001`, `bg002`, and `bg010` so listings sort chronologically. `pbb` uses [`pi-lane`](https://github.com/sshkeda/pi-lane) runtime identity env vars (`PI_LANE_SESSION_KEY`, `PI_LANE_INSTANCE_ID`, etc.) and defaults to the current live Pi instance, not every terminal attached to the same session.

### Scope: this session + this instance by default

**Migration note: `pbb list` defaults to *this session + this instance*.** Jobs started by
sibling instances, subagent sessions and other sessions are hidden — widen with
`--scope session` (every instance of this session) or `--all` (every session under the root,
for forensics; `--scope all` is the same thing). Every list starts with the scope it applied and
a `Widen with …` line, so a short list cannot be mistaken for “nothing is running”. The same
flags apply to `pbb status`/`pbb tail`/`pbb kill` job lookup, and `--instance <id>` targets one
named instance of this session. The reasoning is recorded in
[`todo/2026-11-11_bash-extension-choice/COMPARISON.md`](todo/2026-11-11_bash-extension-choice/COMPARISON.md)
decision 3; the flag/field details are in [`docs/pbb-runner.md`](docs/pbb-runner.md#scope-session--instance).

`pbb` does not need to be on your login-shell PATH. Every command the extension spawns gets
`~/.pi/pbb/bin` prepended to `PATH`, where the extension maintains a small `pbb` shim pointing at
its own `bin/pbb.js`; per-session `PBB_*`/`PI_LANE_SESSION_*` identity is passed to that command
only, so `pbb` inside a bash call reports the session that started the job even when several
sessions share one pi process. (`PBB_ROOT` overrides the state root — including that `bin` dir.)

Background job state is stored under:

```text
~/.pi/pbb/sessions/{sessionKey}/instances/{instanceId}/
  identity.json
  jobs/{jobId}.json
  events.jsonl
  logs/{jobId}.log
```

`pbb list` and `pbb status` show owner liveness as `owner=live|stale|dead|unknown`. The first source is pi-lane's per-session instance records, read through the `pil` CLI that ships as this package's `pi-lane` dependency: `pbb` resolves it with Node's module resolution (`PBB_PIL_BIN` overrides) and keeps the package-local `node_modules/pi-lane` path as the fallback, so it works both in a plain `npm install` of this repo and in pi's npm install, where dependencies are hoisted to `~/.config/pi/npm/node_modules`. When pi-lane has no record for the instance — the normal case when pi-lane is not driving the session, where the instance id is pbb's `pbb_<pid>_<hash>` fallback — pbb probes the pid in the instance's own `identity.json` (written by this extension; the `pbb_<pid>_…` id is the second fallback source), so a live owner is reported live (`owner=dead (pid N is gone)` only when that process is really gone). `owner=unknown` means neither source can answer; it is never reported as `stale`. A `pil` CLI that cannot be resolved or that fails is a hard failure — `pbb` exits 4 with `pi_lane_unavailable` and says how to fix the install, instead of silently degrading liveness to `unknown`.

`pbb kill` writes a kill request into the owning instance mailbox. A live `pi-background-bash` runtime polls that mailbox and aborts the matching in-process job. Jobs record `pid`/`pgid`, so the runtime kills the full process group. The “may not be honored” warning only appears for a non-live owner; for `stale`/`dead`/`unknown` owners, `pbb kill --stale --instance <id> <job>` can signal the recorded process group explicitly.

## Output formatting

The `bash` tool result the model reads is not the TUI's text, and it is not the log. Three
surfaces, three owners:

- **the model** reads a presentation pass over every bash result and completion: ANSI/control
  sequences stripped, `\r` progress frames collapsed to their last frame. If pi truncated the result,
  it is reshaped to the **first 3 lines + `… N lines / <size> omitted …` + the last 10 lines + `Full
  output: <path>`**. Both ends are read from that full-output file, so the head really is the
  command's first lines (pi's own text starts at the first line of its *tail* window); the omitted
  count comes from pi's own totals and counts the lines *absent from the body*, not the lines between
  the shown head and tail. Without a readable full-output file the reshape falls back to the head of
  pi's window. A result pi did not truncate is passed through byte-for-byte, because this layer keeps
  no truncation budget of its own. Each body is frozen per `toolCallId`, so a still-growing log can
  never move text the model already saw.
- **the log** (`logs/<jobId>.log`) holds the command's raw bytes — nothing added, no cap marker, no
  formatting. `pbb tail <job> --full` and `rg` read exactly that.
- **the TUI** renders the stored transcript entries, and **codemode** reads `structuredContent`:
  neither is affected by the output layer (`extensions/output-format.ts`), which only rewrites the
  model-facing message list. Compaction likewise summarises the raw text.

A job log that hit `maxLogBytes` is reshaped from the file's first and last bytes and says plainly
that its tail is not the true end; only the first and last `maxBytes` of a log are ever read.

Counts are configured in `~/.pi/bash-output.json` (project override: `.pi/bash-output.json`):
`headLines` (3), `tailLines` (10), `maxLines` (2000), `maxBytes` (51200).

## Configuration

Default auto-background threshold: `30` seconds.

Configure the global threshold in `~/.pi-background-bash/config.json`:

```json
{
  "autoBackgroundAfterSeconds": 10
}
```

Disable automatic backgrounding while keeping `background: true` available:

```json
{
  "autoBackgroundAfterSeconds": 0
}
```

You can also override the threshold for a single project with `.pi/background-bash.json` in that project. Project config wins over global config, for every key below.

| key | default | meaning |
| --- | --- | --- |
| `autoBackgroundAfterSeconds` | `30` | move a still-running call to the background; `0` disables automatic backgrounding (`background: true` still works) |
| `maxActiveJobs` | `20` | how many jobs one session may run at once. A call past the cap is refused with a message naming `pbb kill <jobid>`, so a slot can be freed without waiting for the job to end |
| `maxLogBytes` | `104857600` (100 MB) | size cap per job log. Appending stops at the cap; the job file records `logTruncated: true` + `logBytes`, and the completion message, `pbb status` and `pbb tail` say the log is capped. Nothing is written into the log itself. |

Output formatting has its own config file, `~/.pi/bash-output.json`, with a per-project override in
`.pi/bash-output.json`:

| key | default | meaning |
| --- | --- | --- |
| `headLines` | `3` | lines shown from the start of a result pi truncated (and of a capped job log) |
| `tailLines` | `10` | lines shown from the end of such a result |
| `maxLines` | `2000` | pi's own truncation window — a completion body is capped like a tool result, with no extra budget of this layer's own |
| `maxBytes` | `51200` | byte budget of the same window, and how much of a log is read from each end |

Job logs older than 7 days are deleted at `session_start`, except for jobs that are still
running or whose completion was never delivered.

## Agent prompt behavior

The extension updates the `bash` tool metadata exposed to models:

- the `background` boolean is part of the tool schema
- the tool description documents automatic backgrounding
- prompt snippets/guidelines teach the agent not to retry just to wait
- prompt guidelines teach the agent to use `pbb list/status/tail` for inspection
- background completion messages are described as final bash results

No global Pi prompt patch is required.

## Security

This is a Pi extension. Like any Pi package, it runs with your local user permissions and can execute shell commands requested by the agent. Review the source before installing third-party extensions.

## Development

```bash
npm install
npm run hooks:install
npm run typecheck
npm test
```

The test suite runs with `--test-concurrency=4` so a test run never saturates the machine. It uses
[`pi-mock`](https://github.com/sshkeda/pi-mock) to exercise the extension against a real Pi process,
plus in-process tests that invoke the extension factory twice to model two sessions sharing one
module instance (that shared state is what used to drop completions).

This repo uses Lefthook for local pre-commit checks (`npm run hooks:install`).

## License

MIT
