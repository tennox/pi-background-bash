// The `operations.exec` contract (PLAN §4): pi's bash tool calls `exec` and
// expects exactly what `createLocalShellOperations` does — the same validation
// order, the same error texts, and pi's exit-code convention. These tests hit
// the seam directly, without pi's bash tool in between, so a drift shows up as
// an exact string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

async function waitUntil(predicate, timeoutMs = 5000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return false;
}

// A runaway command must not be able to fill the disk: the log write-through
// stops at `maxLogBytes` and the cap is reported to the caller instead of being
// written into the file (PLAN §6, Decision 9: the log stays raw command output).
test("exec stops appending at maxLogBytes and keeps only command bytes in the log", async () => {
	const { extension } = await loadModules();
	const harness = createSeam(extension, { maxLogBytes: 64 });
	try {
		// A reused log path always starts empty (the seam truncates at spawn); the
		// cap then owns the file.
		mkdirSync(dirname(harness.logPath), { recursive: true });
		writeFileSync(harness.logPath, "stale-from-a-previous-job\n");
		const result = await harness.seam.exec("head -c 4096 /dev/zero | tr '\\0' 'a'", process.cwd(), {
			onData: harness.onData,
		});
		assert.equal(result.exitCode, 0);
		const log = readFileSync(harness.logPath);
		assert.equal(log.length, 64, "the log must stop growing at maxLogBytes");
		assert.equal(log.toString("utf8"), "a".repeat(64), "the log holds command output only — no cap marker");
		assert.equal(harness.seam.logBytes, 64);
		assert.equal(harness.seam.logTruncated, true);
		// pi's own copy of the output is not capped: the budget is about disk, not
		// about what the command emitted.
		assert.equal(Buffer.concat(harness.chunks).length, 4096);
	} finally {
		harness.cleanup();
	}
});

test("exec reports the cap to the caller once, not per chunk", async () => {
	const { extension } = await loadModules();
	const capped = [];
	const harness = createSeam(extension, { maxLogBytes: 32, onLogCapped: (log) => capped.push(log) });
	try {
		await harness.seam.exec("printf '0123456789\\n0123456789\\n0123456789\\n0123456789\\n'", process.cwd(), {
			onData: harness.onData,
		});
		assert.equal(capped.length, 1);
		assert.deepEqual(capped[0], { bytes: 32, truncated: true });
	} finally {
		harness.cleanup();
	}
});

// Promotion order: the exit watcher is installed before the job record is
// written, so a failing record write (ENOSPC/EACCES) cannot orphan the child —
// it must still finalize and let the job layer deliver the completion.
test("a throwing job-record write at promotion still detects the exit", async () => {
	const { extension } = await loadModules();
	const exits = [];
	const harness = createSeam(extension, {
		onPromote: () => {
			throw new Error("ENOSPC: no space left on device, write");
		},
		onExit: (exit) => exits.push(exit),
	});
	try {
		const pending = harness.seam.exec("sleep 0.2; exit 0", process.cwd(), { onData: harness.onData });
		await waitUntil(() => harness.seam.child !== undefined);
		assert.doesNotThrow(() => harness.seam.promote());
		const result = await pending;
		assert.equal(result.exitCode, 0);
		assert.equal(harness.seam.promoted, true);
		assert.ok(await waitUntil(() => exits.length > 0), "the promoted job's exit must still be observed");
		assert.equal(exits[0].code, 0);
		assert.equal(exits[0].signalCode, null);
	} finally {
		harness.cleanup();
	}
});
