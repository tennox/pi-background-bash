// The suite must answer the same inside and outside a pi session.
//
// pi-background-bash injects its identity into every command it spawns, so an
// `npm test` started from a pi session inherits `PBB_ROOT`, `PBB_SESSION_KEY`… and
// `PI_LANE_*`. Without the scrub in `helpers/hermetic-env.mjs` the test children
// impersonate the developer's live session: their jobs land in the real
// `~/.pi/pbb`, and a session-start reconcile steers the developer's own
// undelivered completions into the mock ("Agent is already processing").
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import {
	hermeticEnv,
	PBB_IDENTITY_VARS,
	scratchPbbRoot,
	scrubInheritedIdentity,
	stripIdentityEnv,
} from "./helpers/hermetic-env.mjs";

const ENV_DUMP = ["-e", "console.log(JSON.stringify(process.env))"];

/** A child's env, as the child itself sees it. */
function childEnv(env) {
	return JSON.parse(execFileSync(process.execPath, ENV_DUMP, { env, encoding: "utf8" }));
}

test("the harness spawns children without the extension's own identity env", () => {
	const foreignRoot = mkdtempSync(join(tmpdir(), `pbb-foreign-${process.pid}-`));
	// What a pi bash call looks like from the inside: a foreign root and a foreign
	// session/instance identity, all of it inherited.
	const foreign = {
		PBB_ROOT: foreignRoot,
		PBB_SESSION_KEY: "foreign-session-key",
		PBB_SESSION_FILE: join(foreignRoot, "foreign.jsonl"),
		PBB_SESSION_ID: "foreign-session-id",
		PBB_INSTANCE_ID: "foreign-instance",
		PBB_LANE: "main",
		PI_LANE_SESSION_KEY: "foreign-session-key",
		PI_LANE_SESSION_ID: "foreign-session-id",
		PI_LANE_SESSION_FILE: join(foreignRoot, "foreign.jsonl"),
		PI_LANE_INSTANCE_ID: "foreign-instance",
		PI_LANE_CURRENT_LANE: "main",
		PI_LANE_ROOT: foreignRoot,
	};
	const saved = Object.fromEntries(Object.keys(foreign).map((key) => [key, process.env[key]]));
	Object.assign(process.env, foreign);
	try {
		assert.deepEqual(stripIdentityEnv(process.env).PBB_ROOT, undefined, "the scrub removes the inherited root");

		const removed = scrubInheritedIdentity();
		assert.deepEqual([...removed].sort(), [...PBB_IDENTITY_VARS].sort(), "every identity var was inherited and stripped");

		// The parent itself no longer names the foreign root …
		assert.notEqual(process.env.PBB_ROOT, foreignRoot);
		assert.equal(process.env.PI_LANE_SESSION_KEY, undefined);

		// … and a child spawned the way pi-mock spawns pi (`{ ...process.env }`) is
		// clean on its own, without every call site remembering to scrub.
		const inherited = childEnv({ ...process.env });
		assert.notEqual(inherited.PBB_ROOT, foreignRoot, "a child must never write into the parent session's root");
		assert.equal(inherited.PBB_ROOT, scratchPbbRoot());
		assert.ok(isAbsolute(inherited.PBB_ROOT));
		assert.ok(statSync(inherited.PBB_ROOT).isDirectory());
		for (const key of PBB_IDENTITY_VARS.filter((key) => key !== "PBB_ROOT")) {
			assert.equal(inherited[key], undefined, `${key} must not reach a test child`);
		}

		// `hermeticEnv` is the same guarantee for an explicit spawn, with overrides
		// (a test's own root/identity) still winning.
		const own = childEnv(hermeticEnv({ PBB_ROOT: join(foreignRoot, "scratch"), PI_LANE_INSTANCE_ID: "test-instance" }));
		assert.equal(own.PBB_ROOT, join(foreignRoot, "scratch"));
		assert.equal(own.PI_LANE_INSTANCE_ID, "test-instance");
		assert.equal(own.PI_LANE_SESSION_KEY, undefined);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		scrubInheritedIdentity();
		rmSync(foreignRoot, { recursive: true, force: true });
		assert.equal(existsSync(foreignRoot), false);
	}
});
