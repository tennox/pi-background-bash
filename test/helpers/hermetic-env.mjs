/**
 * The suite's hermeticity against the extension's own environment.
 *
 * pi-background-bash injects its identity into **every** bash command it spawns
 * (`PBB_ROOT`, `PBB_SESSION_KEY`/`PBB_SESSION_ID`/`PBB_SESSION_FILE`,
 * `PBB_INSTANCE_ID`, `PBB_LANE`, and the `PI_LANE_*` copy `pbb`/`pil` prefer), so
 * a `npm test` started *from inside a pi session* inherits that identity. The
 * test children then impersonate the developer's live session: their job records
 * and logs land in the real `~/.pi/pbb`, and the session-start reconcile picks up
 * the developer's own undelivered completions and steers them into the mock —
 * which is what made "completion arrives when a descendant inherits the command's
 * stdout" fail with "Agent is already processing".
 *
 * Two levers, both here:
 *  - `scrubInheritedIdentity()` — delete the inherited identity from this process,
 *    so anything that spawns its children with `{ ...process.env }` (pi-mock does
 *    exactly that) cannot leak it. Call it once at the top of a test file.
 *  - `hermeticEnv(overrides)` — the env a spawned child gets: the same scrub, a
 *    scratch `PBB_ROOT` instead of the developer's, plus whatever the test needs.
 *
 * `PBB_ROOT` is *overridden*, not merely deleted: unset, the extension falls back
 * to `~/.pi/pbb` — the real root again, just by a different route.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Env vars that carry a pbb/pi-lane session identity. The extension reads these
 * (`pbbIdentity`, `pbbRoot`) and writes them into spawned commands; `bin/pbb.js`
 * and pi-lane read the `PI_LANE_*` half.
 */
export const PBB_IDENTITY_VARS = Object.freeze([
	"PBB_ROOT",
	"PBB_SESSION_KEY",
	"PBB_SESSION_ID",
	"PBB_SESSION_FILE",
	"PBB_INSTANCE_ID",
	"PBB_LANE",
	"PI_LANE_SESSION_KEY",
	"PI_LANE_SESSION_ID",
	"PI_LANE_SESSION_FILE",
	"PI_LANE_INSTANCE_ID",
	"PI_LANE_CURRENT_LANE",
	"PI_LANE_ROOT",
]);

let scratchRoot;

/**
 * The scratch pbb root every spawned child of this test process writes under —
 * one per test process (node's test runner gives each file its own process), so a
 * run can never touch the developer's `~/.pi/pbb`.
 */
export function scratchPbbRoot() {
	if (!scratchRoot) {
		scratchRoot = mkdtempSync(join(tmpdir(), `pbb-hermetic-${process.pid}-`));
		process.on("exit", () => {
			try {
				rmSync(scratchRoot, { recursive: true, force: true });
			} catch {
				// Best effort: a scratch dir left in tmp is not a failure.
			}
		});
	}
	return scratchRoot;
}

/**
 * Env vars a *child* must not inherit from the harness's own session: pi resolves
 * its config dir (models.json, auth) from `PI_CODING_AGENT_DIR`, so forwarding
 * the developer's would point the mock pi at the developer's models instead of
 * the gateway config pi-mock just wrote for it (it loads as
 * `Unknown provider "pi-mock"`). pi-mock sets its own, later in its own spawn env;
 * this list just keeps `hermeticEnv` from shadowing it.
 */
export const HARNESS_OWNED_VARS = Object.freeze(["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"]);

/** A copy of `env` with every pbb/pi-lane identity var removed. */
export function stripIdentityEnv(env = process.env) {
	const clean = { ...env };
	for (const key of PBB_IDENTITY_VARS) delete clean[key];
	for (const key of HARNESS_OWNED_VARS) delete clean[key];
	return clean;
}

/**
 * The environment a test's child process gets: no inherited pbb/pi-lane identity,
 * a scratch `PBB_ROOT`, then `overrides` on top (a test that wants its own root
 * or identity sets it there).
 */
export function hermeticEnv(overrides = {}) {
	const env = stripIdentityEnv(process.env);
	env.PBB_ROOT = scratchPbbRoot();
	for (const [key, value] of Object.entries(overrides)) {
		if (value === undefined) delete env[key];
		else env[key] = value;
	}
	return env;
}

/**
 * Strip the inherited identity from this process itself (in place) and point
 * `PBB_ROOT` at the scratch root. Spawns that merge `process.env` — pi-mock's pi
 * child, `execFileSync(process.execPath, …)` CLI calls — are then hermetic without
 * every call site remembering to scrub. Returns the keys that were removed, so a
 * test can assert on the scrub.
 */
export function scrubInheritedIdentity(env = process.env) {
	const removed = PBB_IDENTITY_VARS.filter((key) => env[key] !== undefined);
	for (const key of removed) delete env[key];
	env.PBB_ROOT = scratchPbbRoot();
	return removed;
}
