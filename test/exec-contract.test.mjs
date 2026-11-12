// The `operations.exec` contract (PLAN §4): pi's bash tool calls `exec` and
// expects exactly what `createLocalShellOperations` does — the same validation
// order, the same error texts, and pi's exit-code convention. These tests hit
// the seam directly, without pi's bash tool in between, so a drift shows up as
// an exact string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EXT = new URL("../extensions/background-bash.ts", import.meta.url).pathname;
const CHILD_EXIT = new URL("../lib/child-exit.ts", import.meta.url).pathname;

async function loadModules() {
	const { createJiti } = await import("jiti");
	const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: false });
	const extension = await jiti.import(EXT);
	const childExit = await jiti.import(CHILD_EXIT);
	assert.equal(typeof extension.createBashExec, "function", "the extension must export the exec seam");
	return { extension, childExit };
}

/** One exec seam with its own log file in a temp dir. */
function createSeam(extension, options = {}) {
	const dir = mkdtempSync(join(tmpdir(), `pbb-exec-${process.pid}-${Date.now()}-`));
	const logPath = join(dir, "logs", "bg001.log");
	const chunks = [];
	const seam = extension.createBashExec({
		logPath,
		spawnEnv: (base) => ({ ...(base ?? process.env) }),
		...options,
	});
	return {
		seam,
		logPath,
		dir,
		chunks,
		onData: (chunk) => chunks.push(chunk),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

test("exec throws pi's exact 'aborted' when the signal fires", async () => {
	const { extension } = await loadModules();
	const harness = createSeam(extension);
	const controller = new AbortController();
	try {
		const pending = harness.seam.exec("sleep 30", process.cwd(), {
			onData: harness.onData,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 150);
		// pi's bash compares `err.message === "aborted"` and nothing else, so the
		// message has to be exactly that string.
		await assert.rejects(pending, (error) => {
			assert.equal(error.message, "aborted");
			return true;
		});
		assert.equal(harness.seam.promoted, false);
	} finally {
		harness.cleanup();
	}
});

test("exec throws 'timeout:<seconds>' with the raw parameter, after killing the group", async () => {
	const { extension } = await loadModules();
	const harness = createSeam(extension);
	try {
		await assert.rejects(
			harness.seam.exec("sleep 30", process.cwd(), { onData: harness.onData, timeout: 0.2 }),
			(error) => {
				// pi parses this as `err.message.split(":")[1]` and prints
				// "Command timed out after <n> seconds" — no rounding, no "s".
				assert.equal(error.message, "timeout:0.2");
				return true;
			},
		);
	} finally {
		harness.cleanup();
	}
});

test("exec validates the timeout with pi's two exact messages, before spawning", async () => {
	const { extension } = await loadModules();
	const harness = createSeam(extension);
	try {
		await assert.rejects(
			harness.seam.exec("echo never-runs", process.cwd(), { onData: harness.onData, timeout: 0 }),
			/^Error: Invalid timeout: must be a finite number of seconds$/,
		);
		await assert.rejects(
			harness.seam.exec("echo never-runs", process.cwd(), { onData: harness.onData, timeout: -1 }),
			/^Error: Invalid timeout: must be a finite number of seconds$/,
		);
		await assert.rejects(
			harness.seam.exec("echo never-runs", process.cwd(), { onData: harness.onData, timeout: Number.POSITIVE_INFINITY }),
			/^Error: Invalid timeout: must be a finite number of seconds$/,
		);
		await assert.rejects(
			harness.seam.exec("echo never-runs", process.cwd(), { onData: harness.onData, timeout: 2_147_483.648 }),
			/^Error: Invalid timeout: maximum is 2147483\.647 seconds$/,
		);
		// Nothing spawned, so nothing was logged.
		assert.throws(() => readFileSync(harness.logPath, "utf8"), /ENOENT/);
	} finally {
		harness.cleanup();
	}
});

test("exec reports a SIGKILLed shell as 128 + 9, never null", async () => {
	const { extension } = await loadModules();
	const harness = createSeam(extension);
	try {
		const result = await harness.seam.exec("kill -KILL $$", process.cwd(), { onData: harness.onData });
		assert.equal(result.exitCode, 137);
	} finally {
		harness.cleanup();
	}
});

test("exec keeps a normal exit code and never returns null", async () => {
	const { extension, childExit } = await loadModules();
	// The code-less, signal-less branch of pi's expression is not reachable with a
	// real process, so its mapping is pinned directly — that `?? 1` fallback is
	// what keeps a `null` out of "Command terminated without an exit code".
	assert.equal(childExit.exitCodeFrom(null, null), 1);
	assert.equal(childExit.exitCodeFrom(null, "SIGKILL"), 137);
	assert.equal(childExit.exitCodeFrom(null, "SIGTERM"), 143);
	assert.equal(childExit.exitCodeFrom(7, null), 7);

	const harness = createSeam(extension);
	try {
		const ok = await harness.seam.exec("exit 0", process.cwd(), { onData: harness.onData });
		assert.equal(ok.exitCode, 0);
		const seven = await harness.seam.exec("exit 7", process.cwd(), { onData: harness.onData });
		assert.equal(seven.exitCode, 7);
		for (const value of [ok.exitCode, seven.exitCode]) {
			assert.equal(typeof value, "number");
			assert.notEqual(value, null);
		}
	} finally {
		harness.cleanup();
	}
});

test("exec fails a missing working directory with pi's message", async () => {
	const { extension } = await loadModules();
	const harness = createSeam(extension);
	const missing = join(harness.dir, "does-not-exist");
	try {
		await assert.rejects(harness.seam.exec("pwd", missing, { onData: harness.onData }), (error) => {
			assert.equal(
				error.message,
				`Working directory does not exist: ${missing}\nCannot execute bash commands.`,
			);
			return true;
		});
	} finally {
		harness.cleanup();
	}
});

test("exec feeds raw Buffers to onData and writes the same bytes to the log", async () => {
	const { extension } = await loadModules();
	const harness = createSeam(extension);
	// Two multi-byte sequences, each split across two writes with a pause, so the
	// seam sees chunk boundaries in the middle of a UTF-8 sequence. A decoder in
	// this layer would corrupt them (or emit replacement characters).
	const command = "printf '\\303'; sleep 0.08; printf '\\244'; printf '\\360\\237'; sleep 0.08; printf '\\230\\200'";
	const expected = Buffer.from("ä😀", "utf8");
	try {
		const result = await harness.seam.exec(command, process.cwd(), { onData: harness.onData });
		assert.equal(result.exitCode, 0);
		assert.ok(harness.chunks.length >= 2, "expected several chunks");
		for (const chunk of harness.chunks) assert.ok(Buffer.isBuffer(chunk), "onData must receive Buffers");
		assert.deepEqual(Buffer.concat(harness.chunks), expected);
		// The split really happened: the first chunk ends inside a UTF-8 sequence.
		assert.deepEqual(harness.chunks[0], Buffer.from([0xc3]));
		// Write-through is byte-identical.
		assert.deepEqual(readFileSync(harness.logPath), expected);
	} finally {
		harness.cleanup();
	}
});

test("exec does not hang on a descendant that inherited stdout", async () => {
	// pi's `waitForChildProcess` resolves on `exit` plus an idle grace re-armed on
	// every chunk (earendil-works/pi#5303); a backgrounded grandchild that keeps
	// the pipes open must not hold the turn.
	const { extension } = await loadModules();
	const harness = createSeam(extension);
	try {
		const started = Date.now();
		const result = await harness.seam.exec("sleep 3 & echo inherited-pipe", process.cwd(), {
			onData: harness.onData,
		});
		const elapsed = Date.now() - started;
		assert.equal(result.exitCode, 0);
		assert.ok(elapsed < 2500, `exec waited ${elapsed} ms for a descendant holding the pipes`);
		assert.match(readFileSync(harness.logPath, "utf8"), /inherited-pipe/);
	} finally {
		harness.cleanup();
	}
});
