# How a fixed pbb build reaches manu's sessions — DECISION NEEDED

Everything below is manu's call. Nothing was published, pushed or deployed.

## Current install shape (checked 2026-11-11)

- `~/.config/pi/settings.json` → `"packages": ["npm:pi-background-bash", …]`
- `~/.config/pi/npm/package.json` → `pi-background-bash: ^1.1.0`, installed copy is
  **1.1.0 = the pre-fix code** (`~/.config/pi/npm/node_modules/pi-background-bash`).
- The repo's `bin/pbb.js` is not on the login-shell PATH nor on the ai-sandcastle PATH.

So *no* running session can see the fix yet, no matter what this repo contains.

## Options

**A. `npm publish` (1.2.0), keep the npm wiring** *(smallest change, but outward)*
Bump `version` to `1.2.0`, `npm publish` the fork, then `npm install` in
`~/.config/pi/npm` (or let the `^1.1.0` range pick it up on the next pi start).
- Needs: npm auth for the `pi-background-bash` name (manu's).
- Effect: outward-facing release of the fork; other users get the fix too.
- Does not help `pbb` on the login shell — but the extension now puts `pbb` on PATH
  inside every bash command it spawns, which is where agents need it.

**B. nix package from this repo (recommended, matches the pi-subagents convention)**
`buildNpmPackage` in nix-config `pkgs/pi-background-bash` pinned to a git rev of this repo,
`settings.json` package entry switched from `npm:pi-background-bash` to the nix-built path
(or a stable `home.file` symlink), like `pi-subagents`.
- Needs: pushing this repo, a nix-config edit + his sign-off, one rebuild.
- Effect: reproducible pin, no registry publish, no dependency on npm availability.
- Same trade-off as today's npm path: the installed copy is a *snapshot*, so fixes need a
  new rev + rebuild.

**C. Local path / git install (canary, not durable)**
`pi install git:github.com/mowenroot/pi-background-bash` or a stable symlink to
`~/dev/ext/pi-background-bash`.
- Needs: push (for the git form) or nothing (symlink); a settings.json change.
- Risk: a live working tree as the package source — any agent editing this repo changes
  behaviour for his sessions on the next `/reload`. Fine for a 1-day canary, not as the
  resting state.

**Recommendation:** B for the resting state (his stated preference for nix-installed pi
packages, and it keeps `pbb` versions reproducible); a temporary C canary if he wants the
fix in his own sessions *today* before the nix work.

## Reaching *running* sessions

pi caches the extension factory/module per cwd for the life of a pi process, so running
sessions keep the old code until the extension is reloaded:

- `/reload` in a session re-imports extensions (pi bumps its extension cache generation),
  which is enough — **no pi restart needed**; still, it is manu's action. The fix explicitly
  does *not* touch, restart or reload his sessions.
- A fresh pi start (new session, new pane) picks up whatever the install path resolves to.

## What is still missing for `pbb` outside agent bash calls

`pbb` on manu's interactive login shell PATH would need a nix-config change (e.g. adding the
npm/pi bin dir to home.packages PATH). Not needed for the complaint (agents call it from bash
tool spawns, which now get it), so it is left undone deliberately.
