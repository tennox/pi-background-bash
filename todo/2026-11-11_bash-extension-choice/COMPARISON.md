# Bash extension choice: pi-bg-bash vs pi-background-bash (pbb fork)

Written 2026-11-11. Decision doc — no code changed by this file.

## Context correction

`pi-background-bash` is **not ours**: an agent picked sshkeda's extension a while
back, and this repo is a fork made only because upstream's install was broken
(private `pi-context` dep) plus the completion bugs found on 2026-11-07. Upstream
is effectively dead (GitHub main HEAD 2026-05-12, tags end at v1.0.1; npm
`pi-background-bash@1.1.0` is this fork's publish). So "keep maintaining it" is a
choice to own a bash reimplementation, not a given.

## The two approaches

| | **pbb (this fork)** | **pi-bg-bash** (gvanderclay, v0.6.0, pi ≥ 1.5) |
|---|---|---|
| Bash execution | **shadow tool**: registers its own `bash`, spawns `bash -lc`, own output buffer, own truncation, own error text | **delegates**: `createBashToolDefinition(cwd, {operations})` — pi's own execute does env, PATH, output accumulator, truncation, `structuredContent`, error texts, `128+signum` |
| Env / PI_* | missing (the P0 gap) | pi's, from ctx |
| Exit detection | `exit` event + 750 ms idle grace (pi core's own approach) | **log marker** (`__PI_BG_EXIT__:<nonce>`) + 2 s poller; `exit unknown` when neither marker nor pid is left |
| Crash safety | job file can end `lost` (sweep, added 2026-11-11) | detached `sh` watcher SIGKILLs the group when pi dies |
| Background trigger | `background: true` **or 30 s timer** (config) | `background: true` **only** (timed promotion deliberately removed; `waitFor` match or `ctrl+shift+b` also promote) |
| Agent-facing inspection | **CLI only**: `pbb list/status/tail/kill/self`, `--scope session/instance`, `--json`; needs `pbb` on PATH | **native tools**: `bash_tasks`, `bash_output` (cursor-paged, `latest`, regex `filter`), `bash_kill`, `bash_watch` (streaming, `contains`) |
| Completion message | pi_context XML, up to 2000 lines/50 KB body + `pbb tail --full` hint, steer+triggerTurn | state + last 20 lines, **4 KiB cap** + "read with `bash_output <id>`", steer+triggerTurn, retry if send fails |
| Delivery bookkeeping | `delivered` / `droppedReason` in job file + boot reconcile digest (2026-11-11); honest `lost` | one-at-a-time unsent-message queue, retries; no boot reconcile |
| Durability of state | on disk, per session+instance: `jobs/*.json`, `events.jsonl`, logs — survived the forensics that found this bug | per-session logs under `~/.local/state/pi-bg/<session>/`, gz after completion, 7-day retention; ids `bg-1` per process |
| Log hygiene | unbounded (`144 MB` laptop-wide; 4594 `job.output` events in one instance) | 100 MiB cap, gzip after completion, retention, ANSI-stripped views |
| Reload / session lifetime | per-session state, `/reload` re-loads; shutdown kills own jobs | `globalThis` registry: `/reload` **keeps** tasks; new/resume/fork kill them |
| Human ergonomics | CLI in terminal | `/bg` picker, `ctrl+shift+b` promote, footer `bg: N`, 2 s hint |
| Extra features | context guard (trims oversized historical tool results), pending widget, stale-pgid kill | `waitFor`, `hold` (delegated-session completion holds), codemode structured results + `task_id`, debug log |
| Maintenance | dead upstream, we own the fork | active, documented, tested |

## What each approach does better for agents

**pi-bg-bash (native tools) wins the ergonomics axis:**
- discoverable in the tool list — no PATH luck (we lost `pbb` twice today: missing
  from login PATH and from the sandbox PATH), no shell quoting, no envelope parsing;
- paged/cursor reads (`bash_output`) = context control on long builds, `filter` =
  no `grep` gymnastics, `latest` = cheap progress peeks;
- small completion message (4 KiB + pointer) instead of dumping 50 KB into context;
- structured results for codemode.

**pbb (CLI + job files) wins the forensics axis:**
- cross-session/instance inspection and `--json` composability (`jq`), `--scope session`;
- durable, self-describing job records — the 2026-11-11 forensic sweep (515
  notification-less jobs) was only possible because of them;
- shell-side `grep`/`tail` in one call without extra tool surface.

## Behaviours we want (the wish list)

Explicit (from this thread):
1. Delegation to pi's bash execution — no reimplementation of env/output/errors.
2. `PI_*` session env + extension-added vars (`PI_MODEL_CANONICAL`, `PI_LANE_*`) present in every spawned command.
3. PATH adds `~/.config/pi/bin` **and** the pbb bin dir; never replaces.
4. Non-throwing `isError` + `structuredContent`; `128+signum` for spontaneous signal deaths, "Command aborted" only for our own kills.
5. Native agent-facing inspection tools rather than a CLI only.
6. No RAM-bounded-by-output: bounded capture + full output on disk.
7. No arbitrary job cap by default (`MAX_ACTIVE_JOBS = 10` removed; config if wanted).

Inferred from how the agents actually behave (mark these as needing his blessing):
8. **Time-based auto-background stays.** His prompt guidance ("commands running longer
   than the threshold move to the background") and his agents' habits depend on it;
   pi-bg-bash removed it on purpose. If we adopt pi-bg-bash, restore it as a config
   option with a hint, and say so in the result text.
9. Cross-session/forensic reader stays (CLI or `--json` tool) — we lose the audit
   trail otherwise.
10. Completion delivery: small message + pointer, retried, plus a boot reconcile for
    anything that could not be delivered (today's fix).
11. Log hygiene: size cap + retention + gzip (pi-bg-bash's model).

## Options

**A. Adopt pi-bg-bash, patch minimally (recommended to *try* first)**
Bump pi to ≥1.5 in nix-config, install it, dogfood for a few days. Then a small
fork/patch for what we actually need on top: timed auto-promotion (upstream removed
`PI_BG_BASH_PROMOTE_MS`; a config-gated timer calling its existing `promote()` is
small), and — if the audit trail proves necessary — a thin `pbb`-style CLI reading its
state dir.
- Cheapest path to the right architecture; drops ~1000 lines of our bash code.
- Risk: pi 1.5 bump must re-verify his nix-config host extensions that patch TUI
  internals (`footer.ts`, `thinking-snippet.ts`, `model-resolved.ts`), plus
  pi-subagents/websearch compatibility.
- Cost of ownership: small patch on someone else's code; upstream may absorb it.

**B. Keep pbb, refactor onto the seam**
Registers `{...createBashToolDefinition(cwd, {operations: pbbExec})}`, keeps job
records/CLI/timer/digest, deletes the reimplementation.
- Keeps every pbb behaviour and the forensic trail; we own the code.
- ~1–2 days incl. tests; we still own a bash-adjacent extension forever.

**C. New thin extension built from pbb's job layer, modelled on pi-bg-bash**
Essentially B with a clean file layout and no dead-upstream baggage (native
`bash_tasks/bash_output/bash_kill` + CLI + timer + digest).
- Best feature fit, no inherited warts, most design work.

## Recommendation

Try **A** first: with pi bumped it is a day's work to know whether the better
architecture also fits his workflow, and its native tools are the biggest single
ergonomics win. Keep the pbb fork untouched meanwhile (the 2026-11-11 fixes are
committed locally and would remain the fallback). Decide B/C only if A's gaps
(timer, audit trail) turn out to be unfixable small patches.

## Open questions

1. Accept the pi 1.5 bump (re-verifying footer / thinking-snippet / model-resolved / pi-subagents)? **Rec: yes, on a branch.**
2. Timed auto-promotion: keep at 30 s, keep configurable, and should the promoted result still say "moved to background after Ns"? **Rec: yes to all three.**
3. Forensics/CLI: do you want a `pbb`-style reader over pi-bg-bash's logs, or are on-disk logs + `bash_output` enough? **Rec: start without it, add only if a sweep is needed again.**
4. If A works, does the pbb fork get archived (README pointing at pi-bg-bash + the fork's fixes offered upstream)?

---

# Deep dive (2026-11-11, second pass)

## 1. Subagents integration — the decisive finding

pi-subagents runs child **AgentSessions in-process**: `createAgentSession(...)` at
`~/.local/share/pi/packages/pi-subagents/src/agent-runner.ts:1030`, with the comment
"Child AgentSessions load normal extensions" (`src/index.ts:302`). So on this machine
the parent pi process hosts concurrent sessions, each loading the same cached
extension module — the condition behind the bug fixed in pbb on 2026-11-11.

pi-bg-bash assumes **one session per process**:

| where | what | consequence with in-process siblings |
|---|---|---|
| `src/registry.ts:19` | one `globalThis[Symbol.for("pi-bg-bash.registry")]`: one `tasks` map, one `nextId`, one `pi` | process-wide state, exactly pbb's pre-fix shape |
| `src/registry.ts:154-181` `endSession()` | kills **every** task's group, `ownerSessionId` only used for logs/holds | **a finishing subagent kills the parent's background tasks** |
| `src/registry.ts:477-481` + `attach()` (`:186`) | completion sent through `registry.pi`, the *last loaded* session | parent's completion injected into the wrong session (or stale ctx) |
| `src/index.ts:228-240` `bash_tasks` | lists the whole process registry while the description says "this session's" | leaks other sessions' tasks into the model's view |
| `src/index.ts:168,222,272` | `bash_output`/`bash_kill` **do** filter by `ownerSessionId` | inconsistent with `bash_tasks` |

pbb after `5e6aea6`: per-session job map, per-session `pi` for delivery, sessionKey-filtered
reconcile, real-outcome finalization. **Our hardest-won fix is precisely what pi-bg-bash
lacks**, so a straight switch re-introduces today's failure on his setup (day one:
"subagent finished → my build task vanished").
Patch size to carry it over: ~150–250 lines (session-keyed registry, filtered `endSession`,
per-session delivery api, filtered `bash_tasks`) plus our reconcile digest, which is harder
on their design (no job records; logs gzip'd after completion).

## 2. CLI vs native tools — revised verdict

Neither is strictly better; the asset is **plain files at a documented path**:

- agents are excellent at `rg`/`tail`/`head`/`sed`/pipes over a log file — one bash call,
  exact lines, no extra tool surface, and composable with `jq` for records;
- pbb's CLI adds little beyond *path discovery* (`pbb tail <id> --full` ≈ `cat`);
- native tools win on **discoverability** (tool list vs prompt text), on **no PATH/quoting**
  (we lost `pbb` twice on 2026-11-11), and on **context-efficient paging** of huge logs;
- pbb's `pi_context` XML envelopes cost tokens without helping the model; plain tool
  results are cleaner.

Direction: keep logs + job records as files with documented paths, keep a *thin* reader
(`pbb tail/list --json`), and add native `tasks/output/kill` tools — additive, not instead.

## 3. Output truncation, side by side

| | pbb | pi-bg-bash / pi core |
|---|---|---|
| foreground result | tail, 2000 lines / 50 KB + notice + "Full output: …" | pi's `OutputAccumulator`: same 2000 / 50 KB, `details.truncation` + `fullOutputPath` (temp file) |
| background completion body | up to 2000 lines / 50 KB (`pi_context` XML) | last 20 lines, **4 KiB** cap, plain text + `bash_output <id>` |
| reading full job output | `pbb tail <id> --full`, or plain `cat` of the log | `bash_output` (cursor, paging, regex `filter`, `latest`); log on disk, gzip after completion |
| ANSI / control chars | **raw** everywhere | stripped in results and views; raw on disk |
| historical context | **context guard** trims oversized old tool results on replay | none (pi core has none) |
| per-chunk cost | event + job-JSON rewrite per chunk (1.3 MB events.jsonl in one instance) | 50 ms `onData` poll in foreground, no per-chunk state writes |
| full output in RAM | **yes** (whole stdout/stderr string) | no (bounded accumulator → temp file) |

Worth transferring **from ours**: the context guard, and the "Full output: …" hint wording
(core already does the equivalent, so mostly just the context guard).
Worth taking **from theirs**: ANSI stripping, 4 KiB completion bodies, cursor reads,
log cap + gzip + retention, no per-chunk state writes.

## 4. Options, revisited after the deep dive

**A′. Switch to pi-bg-bash and carry our fixes onto it** — pi 1.5 bump + three patches
(session-keyed registry & delivery, filtered `endSession`/`bash_tasks`, timed
auto-promotion) + optionally a reconcile digest rebuilt on their log model. 2–3 days, and
we still own patches in someone else's codebase; upstream may or may not take them.

**B′. Keep pbb, refactor onto the seam (recommended now)** — supply only
`operations.exec` to `createBashToolDefinition` (env, PATH, PI_*, output accumulator,
truncation, `structuredContent`, error texts, `128+signum` become pi's), keep our job
records/CLI/auto-timer/digest/context guard, then add ANSI stripping, a 4 KiB completion
body, log cap + retention and native `tasks/output/kill` tools. 1–2 days; every fix and
forensic capability stays; no re-implementation of bash left.

**The calculus flipped** vs the first pass: pi-bg-bash's architecture is better, but it
lacks the one thing that took the 2026-11-11 forensic sweep to find and fix — and that
thing is exactly what B′ already has.
