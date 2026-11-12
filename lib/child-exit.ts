/**
 * Waiting for a spawned command to be really gone — a mirror of pi's own
 * `waitForChildProcess` (`packages/coding-agent/src/utils/child-process.ts`,
 * earendil-works/pi#5303), which pi does not export from its package root.
 *
 * Two additions over pi's helper, both needed by the exec seam:
 *
 *  - it reports the terminating *signal* next to the exit code, so the caller
 *    can apply pi's own convention (`exitCode ?? (signalCode ? 128 + signum : 1)`);
 *  - `detach()` stops waiting *without* destroying the pipes, which is what a
 *    promoted background job needs: the same child keeps running and its
 *    stdout/stderr must stay readable for the log write-through.
 */

import type { ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";

/**
 * pi's foreground window: after `exit`, keep reading until the pipes have been
 * idle this long, so a detached descendant that inherited them can neither hold
 * the turn open nor lose its last writes.
 */
export const EXIT_STDIO_GRACE_MS = 100;
/**
 * The same wait for a promoted job. Longer than pi's: nothing is blocked on it
 * and a background command's descendant is likelier to still be writing.
 */
export const JOB_EXIT_STDIO_GRACE_MS = 750;

export interface ChildExit {
	code: number | null;
	signalCode: NodeJS.Signals | null;
}

export interface ChildWaiter {
	/** Settles once the child is gone; never settles after `detach()`. */
	done: Promise<ChildExit>;
	/** Stop waiting, keep the child (and its pipes) alive. */
	detach(): void;
}

export interface WaitOptions {
	/** Idle window after `exit`, re-armed on every chunk. */
	idleGraceMs?: number;
	/**
	 * Destroy stdout/stderr when the wait settles. pi does; a caller that keeps
	 * reading the pipes after settling must not.
	 */
	destroyStreams?: boolean;
}

/**
 * Wait for the child to terminate without hanging on inherited stdio handles.
 * `close` wins; after `exit` the idle timer decides, so an actively writing
 * descendant keeps us reading while a quiet inherited handle releases us.
 */
export function waitForChildExit(child: ChildProcess, options: WaitOptions = {}): ChildWaiter {
	const idleGraceMs = options.idleGraceMs ?? EXIT_STDIO_GRACE_MS;
	const destroyStreams = options.destroyStreams ?? true;

	let settled = false;
	let exited = false;
	let exitCode: number | null = null;
	let signalCode: NodeJS.Signals | null = null;
	let postExitTimer: NodeJS.Timeout | undefined;
	let stdoutEnded = child.stdout === null || child.stdout === undefined;
	let stderrEnded = child.stderr === null || child.stderr === undefined;
	let resolveDone: (exit: ChildExit) => void = () => {};
	let rejectDone: (error: unknown) => void = () => {};

	const cleanup = () => {
		if (postExitTimer) {
			clearTimeout(postExitTimer);
			postExitTimer = undefined;
		}
		child.removeListener("error", onError);
		child.removeListener("exit", onExit);
		child.removeListener("close", onClose);
		child.stdout?.removeListener("end", onStdoutEnd);
		child.stderr?.removeListener("end", onStderrEnd);
		child.stdout?.removeListener("data", onData);
		child.stderr?.removeListener("data", onData);
	};

	const finalize = () => {
		if (settled) return;
		settled = true;
		cleanup();
		if (destroyStreams) {
			child.stdout?.destroy();
			child.stderr?.destroy();
		}
		resolveDone({ code: exitCode, signalCode });
	};

	const maybeFinalizeAfterExit = () => {
		if (!exited || settled) return;
		if (stdoutEnded && stderrEnded) finalize();
	};

	const armIdleTimer = () => {
		if (postExitTimer) clearTimeout(postExitTimer);
		postExitTimer = setTimeout(finalize, idleGraceMs);
	};

	const onData = () => {
		// Output is still arriving after exit; defer finalizing so we do not cut
		// the tail off mid-write.
		if (exited && !settled) armIdleTimer();
	};

	const onStdoutEnd = () => {
		stdoutEnded = true;
		maybeFinalizeAfterExit();
	};

	const onStderrEnd = () => {
		stderrEnded = true;
		maybeFinalizeAfterExit();
	};

	const onError = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		rejectDone(error);
	};

	const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
		exited = true;
		exitCode = code;
		signalCode = signal;
		maybeFinalizeAfterExit();
		if (!settled) armIdleTimer();
	};

	const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
		exited = true;
		if (exitCode === null && signalCode === null) {
			exitCode = code;
			signalCode = signal;
		}
		finalize();
	};

	child.stdout?.once("end", onStdoutEnd);
	child.stderr?.once("end", onStderrEnd);
	child.stdout?.on("data", onData);
	child.stderr?.on("data", onData);
	child.once("error", onError);
	child.once("exit", onExit);
	child.once("close", onClose);

	const done = new Promise<ChildExit>((resolve, reject) => {
		resolveDone = resolve;
		rejectDone = reject;
	});

	return {
		done,
		detach() {
			if (settled) return;
			settled = true;
			cleanup();
		},
	};
}

/**
 * pi's exit convention (`bash.ts:157-158` in the coding-agent): a signal-killed
 * child has no exit code, so report the standard shell value instead. Never
 * `null` — pi turns that into "Command terminated without an exit code".
 */
export function exitCodeFrom(code: number | null, signalCode: NodeJS.Signals | null): number {
	return code ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1);
}
