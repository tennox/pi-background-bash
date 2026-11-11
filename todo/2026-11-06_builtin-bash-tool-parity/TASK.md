# Make pbb's registered `bash` tool behave like pi's builtin bash tool

## Status: Planned (comparison done, plan written — see PLAN.md)

## Problem

The extension registers a tool named `bash` (`extensions/background-bash.ts:934`)
that **shadows** pi's builtin bash tool. pi's builtin injects the documented
session environment (`PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`,
`PI_MODEL`, `PI_REASONING_LEVEL`) into every spawned command and provides a few
other behaviors the extension's replacement silently drops. Because the
replacement shadows the builtin, these are missing on EVERY bash call —
foreground and backgrounded alike (verified empirically 2026-11-06 in a live pi
1.4.0 session on manu's laptop).

Concrete breakage it caused: session-scoped skills (`ntfy.nu`, `agent-msg.nu`)
probe `PI_SESSION_ID` for per-session state and hard-error when it's missing;
manu had to work around with `export NTFY_SESSION_KEY=<uuid>`.

## Objectives

Keep the extension's value-add (background: true, auto-backgrounding,
pi_context follow-ups, pbb job ids/tail) while matching the builtin bash tool
in "most ways" — priority order and full comparison in [PLAN.md](PLAN.md).

## Key references

- pi source: `~/dev/ext/pi/packages/coding-agent/src/core/tools/bash.ts`
  (resolveSpawnContext at :185–211, exposeSessionEnvironment default-on :250)
- pi docs: `docs/environment-variables.md` (PI_* contract)
- extension: `extensions/background-bash.ts` (runPbbBash :553, spawn env
  `process.env` :576, execute :948)
- Divergence inventory + fix plan: [PLAN.md](PLAN.md)

## Progress Notes

- 2026-11-06: root-cause debug (session env never injected — builtin's
  resolveSpawnContext never runs because the builtin tool is shadowed);
  full comparison table + adaptation plan written in PLAN.md; repo cloned to
  `~/dev/ext/pi-background-bash` (matches installed 1.1.0 bit-for-bit).
- 2026-11-06: independent deep41f review of the plan vs both codebases — all
  core claims confirmed; amendments applied to PLAN.md: Option B (per-call
  env from ctx, not process.env mutation) chosen; `-lc→-c` demoted to P2
  (documented contract, sandbox PATH rationale); added missed divergences
  (UTF-8 chunk split mojibake, getShellEnv PATH prepend, signal-death
  misreported as abort, constrainedSampling, MAX_ACTIVE_JOBS); stale line
  refs corrected.
