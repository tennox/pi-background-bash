# Bash-extension rework — status (delivered 2026-11-15)

## Shipped

Registers pi's own bash tool (`createBashToolDefinition`), supplying only
`operations.exec` — the job layer (auto-promotion, job records,
delivery/reconcile, abort/shutdown, `pbb`) stays. Model-facing head+tail output
is a **second entry** (`extensions/output-format.ts` + `lib/output-format.ts`).

## Commit series on `main` (ce1d2a4 → b9cae88)

`ce1d2a4` plan revision after adversarial review · `e9e3ff0` exec seam ·
`8e96a14` exec-contract + promotion tests · `f47df11` no hang on inherited
stdout · `48be06a` verifier fixes (log cap + retention, ordering, job-id floor) ·
`86289fa` output-format layer · `5e89f6f` one truncation owner, honest footer ·
`660e5ca` CLI scope + owner liveness · `3c4e3fd` acceptance fixes · `b9cae88`
plain-text completions, 10-job default, retention disclosure.

## Delivered — live

- Repo `github.com/tennox/pi-background-bash` (public fork, `upstream` kept);
  `main` at `b9cae88`.
- nix-config `0094f1e3`: `pkgs/pi-background-bash` (`buildNpmPackage`,
  `npmDepsHash` `sha256-WTiaPzyjAId8ggQor29zVXTMbOGFHQ/IYLlshmO0U/8=`,
  `--legacy-peer-deps` — the two deps' peers pull ~124 packages), flake input
  `github:tennox/pi-background-bash/main`, `callPackage`.
- Dev mode: `~/.local/share/pi/packages/pi-background-bash` →
  `~/dev/ext/pi-background-bash` (edits apply on `/reload`); `pi-settings.json`
  no longer has `npm:pi-background-bash`. Activated via `rbs` (generation
  switched 2026-11-15 19:27); `/reload` migrates sessions.

## Knobs — decided

| Knob | Value |
| --- | --- |
| head/tail lines | 3 / 10 (`lib/output-format.ts` → `DEFAULT_OUTPUT_FORMAT`) |
| completion body | plain text, job id in `details.jobId` |
| `maxActiveJobs` / `maxLogBytes` | 10 (configurable) / 100 MB, 7-day retention |
| `bash -lc` | kept, no knob |

The `pi_context` envelope is gone from completions (both job-id readers take
`details`); `pbb` keeps its envelope for scripts. Logs are never deleted while a
job runs or before delivery, and the tool description + prompt guideline now
disclose that 7-day retention to the model.

## Verification done

- 89 tests green (typecheck + `node --test`); one adversarial plan review, one
  implementation verification, one acceptance gate; two independent live runs at
  HEAD (foreground, truncation, promotion, kill, exit code, abort, reconcile).
- Live proof after `/reload`: `pbb list` announces its scope; `seq 1 3000`
  renders `1 2 3` + `… 2987 lines / 13.5KB omitted …` + `2991…3000` with exactly
  one footer naming our log; a completion arrived as `Bash job bg032 finished
  after 3.1s (exit code 0)` — no XML envelope.

## Pointers

- `PLAN.md` — the spec.
- `../2026-11-11_bash-extension-choice/COMPARISON.md` — binding design decisions.
- `../../docs/pbb-runner.md` — how the background runner works.
