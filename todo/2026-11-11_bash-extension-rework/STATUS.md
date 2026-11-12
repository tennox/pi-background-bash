# Bash-extension rework — status (2026-11-11/12)

## Shipped

The extension no longer reimplements pi's bash tool. It now registers pi's own
bash tool (`createBashToolDefinition`) and supplies only `operations.exec`,
keeping the background job layer intact: auto-promotion to background, job
records, delivery/reconcile on completion, abort/shutdown handling, and the
`pbb` CLI.

Model-facing head+tail output lives in a **second extension entry**
(`extensions/output-format.ts` + `lib/output-format.ts`), so the truncation
policy is decoupled from the job layer.

## Commit series on `main` (ce1d2a4 → 3c4e3fd)

- `ce1d2a4` plan revision after adversarial review
- `e9e3ff0` exec seam: drive pi's own bash tool from `operations.exec`
- `8e96a14` tests: exec contract, promotion, foreground full-output path
- `f47df11` tests: exec does not hang on an inherited stdout handle
- `48be06a` verifier fixes: log cap + retention, promotion ordering, job-id floor
- `86289fa` output-format layer: model-facing head+tail, frozen bodies
- `5e89f6f` output-format fixes: one truncation owner, honest footer, real log size
- `660e5ca` CLI: session+instance scope by default, honest owner liveness
- `3c4e3fd` acceptance fixes: honest head+tail from the log file, kept promotion
  metadata, configurable job cap, npm `pbb` resolution

## Verification done

- 87 tests green (typecheck + `node --test`).
- Two independent live end-to-end runs at HEAD: foreground, truncation,
  promotion, kill, exit code, abort, shutdown-reconcile.
- One adversarial plan review, one implementation verification, one acceptance
  gate.

## Not done — waiting on manu

- **Build not published or installed.** Delivery route is undecided: nix
  package vs npm publish vs local path. Last published version is npm `1.1.0`.
- Pending knobs (exact places to change):

| Knob | Where |
| --- | --- |
| head/tail line counts | `lib/output-format.ts` → `DEFAULT_OUTPUT_FORMAT` |
| `maxLogBytes` / `maxActiveJobs` defaults | `extensions/background-bash.ts` config defaults |
| completion body shape | still the `pi_context` XML envelope (`buildXmlResult`) |
| `bash -lc` | kept hardcoded, no config knob |

## Pointers

- `PLAN.md` — the spec.
- `../2026-11-11_bash-extension-choice/COMPARISON.md` — binding design decisions.
- `../../docs/pbb-runner.md` — how the background runner works.
