/**
 * The output-format layer (PLAN §7): helpers shared by the model-facing
 * `context` hook (`extensions/output-format.ts`) and the completion body in
 * `extensions/background-bash.ts`.
 *
 * Two different jobs live here, and only one of them is truncation policy:
 *
 *  (a) presentation — applied to every bash result and every completion body:
 *      collapse `\r` progress frames to their last frame and strip ANSI/control
 *      sequences. No size budget, no path rewriting, no exceptions.
 *  (b) head+tail reshape — applied to what pi already decided was truncated
 *      (`details.truncation` / `details.fullOutputPath`), to a multi-entry digest
 *      longer than pi's window, and to a single job's completion body: a
 *      completion body goes through `formatLogFile`, the same head+tail path as a
 *      tool result, so a 3000-line background job reads exactly like a 3000-line
 *      foreground result (PLAN §6/§7b). Both ends are read from the full-output
 *      file when it is readable — the head of pi's tail window is line 1001, not
 *      line 1 — so the model sees the command's own first lines. Everything else
 *      passes through byte-for-byte, so this layer can never make a result tighter
 *      than builtin bash (COMPARISON.md decision 6).
 *
 * Deliberately dependency-free (only `node:*`): no import from pi, so the tests
 * need no pi runtime and this module cannot quietly grow into owning pi's
 * truncation policy. The one place pi's wording is mirrored is `formatSize`
 * (`truncate.ts`), so the model keeps reading sizes in the units it knows.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/* ------------------------------------------------------------------------- *
 * Config (`~/.pi/bash-output.json`, project `.pi/bash-output.json`)
 * ------------------------------------------------------------------------- */

export interface OutputFormatConfig {
	/** Lines shown before the omitted marker. */
	headLines: number;
	/** Lines shown after the omitted marker. */
	tailLines: number;
	/** Line budget of a completion body; pi's own truncation window, not ours. */
	maxLines: number;
	/** Byte budget of a completion body; pi's own truncation window, not ours. */
	maxBytes: number;
}

/**
 * PENDING manu's sign-off (PLAN §10, question Q5): 3 head + 10 tail lines,
 * i.e. decision 5's example. One named constant pair; if the numbers change,
 * this literal and nothing else changes.
 *
 * `maxLines`/`maxBytes` are NOT new numbers: they are pi's own truncation
 * window (`DEFAULT_MAX_LINES`/`DEFAULT_MAX_BYTES`, `truncate.ts`), replicated
 * here only because this module must stay free of pi imports.
 */
export const DEFAULT_OUTPUT_FORMAT: OutputFormatConfig = {
	headLines: 3,
	tailLines: 10,
	maxLines: 2000,
	maxBytes: 50 * 1024,
};

/** `~/.pi/bash-output.json` — the global config file. */
export function globalOutputFormatConfigPath(): string {
	return join(homedir(), ".pi", "bash-output.json");
}

/** `<cwd>/.pi/bash-output.json` — the project override, like `.pi/background-bash.json`. */
export function projectOutputFormatConfigPath(cwd: string): string {
	return join(cwd, ".pi", "bash-output.json");
}

function readConfigFile(path: string): Partial<OutputFormatConfig> {
	let parsed: unknown;
	try {
		if (!existsSync(path)) return {};
		parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return {};
	}
	if (!parsed || typeof parsed !== "object") return {};
	const raw = parsed as Record<string, unknown>;
	const config: Partial<OutputFormatConfig> = {};
	for (const key of ["headLines", "tailLines", "maxLines", "maxBytes"] as const) {
		const value = raw[key];
		// Only a positive, finite number is a budget; anything else keeps the default.
		if (typeof value === "number" && Number.isFinite(value) && value > 0) config[key] = Math.floor(value);
	}
	if (config.headLines !== undefined) config.headLines = Math.max(0, config.headLines);
	return config;
}

/** Global config, then the project override for `cwd` on top of it. */
export function loadOutputFormatConfig(cwd?: string): OutputFormatConfig {
	const globalConfig = readConfigFile(globalOutputFormatConfigPath());
	const projectConfig = cwd ? readConfigFile(projectOutputFormatConfigPath(cwd)) : {};
	return { ...DEFAULT_OUTPUT_FORMAT, ...globalConfig, ...projectConfig };
}

/* ------------------------------------------------------------------------- *
 * (a) Presentation
 * ------------------------------------------------------------------------- */

function lastFrame(line: string): string {
	if (!line.includes("\r")) return line;
	const frames = line.split("\r");
	// A progress line ends with the cursor return of the frame still being
	// written; the last *non-empty* frame is the one the reader would have seen.
	for (let i = frames.length - 1; i >= 0; i--) {
		if (frames[i] !== "") return frames[i];
	}
	return "";
}

/**
 * Keep only the last `\r`-overwritten frame of each line: a progress bar that
 * rewrites its own line must read as its final state, not as 2000 frames.
 * `\r\n` line endings keep the whole line — only a lone `\r` overwrites.
 */
export function collapseCarriageReturns(text: string): string {
	if (typeof text !== "string" || !text.includes("\r")) return text;
	return text.replace(/\r+\n/g, "\n").split("\n").map(lastFrame).join("\n");
}

// CSI: ESC/CSI + parameter bytes + intermediates + final byte.
const CSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
// OSC: ESC ] … terminated by BEL, ESC \ or ST. Stops at a newline so an
// unterminated OSC cannot swallow the rest of the output.
const OSC_PATTERN = /\u001B\][^\u0007\u001B\n]*(?:\u0007|\u001B\\|\u009C|\n|$)/g;
// Remaining two-character escapes (ESC ( B, ESC 7, ESC = …) and a stray ESC.
const SHORT_ESCAPE_PATTERN = /\u001B[@-Z\\-_]|\u001B/g;
// Control characters except \n (0x0a) and \t (0x09), plus U+FFFE/U+FFFF-ish
// non-characters pi's own sanitizer drops.
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u009B\u009C\uFFF9-\uFFFB]/g;

/**
 * Strip ANSI CSI/OSC sequences and control characters (keeping `\n` and `\t`).
 *
 * Own, deliberately small implementation. pi's own `utils/ansi.ts` is a port of
 * ansi-regex/strip-ansi (MIT) but is not exported from the package root, and
 * pi-bg-bash's `sanitize.ts` (MIT) is where this idea comes from — logs stay
 * raw, only the model-facing text is cleaned (COMPARISON.md decisions 4/9).
 */
export function stripEscapes(text: string): string {
	if (typeof text !== "string" || text === "") return text;
	// Fast path: without an escape or a C0 control there is nothing to remove.
	if (!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u001B\u009B]/.test(text)) return text;
	return text.replace(OSC_PATTERN, "").replace(CSI_PATTERN, "").replace(SHORT_ESCAPE_PATTERN, "").replace(CONTROL_PATTERN, "");
}

/** Presentation for every body: strip escapes, then collapse `\r` frames. */
export function presentText(text: string): string {
	return collapseCarriageReturns(stripEscapes(text));
}

/* ------------------------------------------------------------------------- *
 * Shared marker/footer wording
 * ------------------------------------------------------------------------- */

/** An omitted marker line, as produced by this module (idempotence check). */
const OMITTED_MARKER_PATTERN = /^… [^\n]*\bomitted\b[^\n]*…$/m;

export function hasOmittedMarker(text: string): boolean {
	return typeof text === "string" && OMITTED_MARKER_PATTERN.test(text);
}

/** pi's `formatSize` (`truncate.ts`), so sizes read the same everywhere. */
export function formatSize(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "an unknown size";
	if (bytes < 1024) return `${Math.round(bytes)}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Rounded human bytes for notices ("4 KB", "100 MB"). */
export function humanBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "an unknown size";
	if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} bytes`;
}

function omittedMarker(omittedLines: number | undefined, omittedBytes: number | undefined): string {
	const parts: string[] = [];
	if (omittedLines !== undefined && omittedLines > 0) parts.push(`${omittedLines} line${omittedLines === 1 ? "" : "s"}`);
	if (omittedBytes !== undefined && omittedBytes > 0) parts.push(formatSize(omittedBytes));
	if (parts.length === 0) return "";
	return `… ${parts.join(" / ")} omitted …`;
}

interface AssembleInput {
	head?: string;
	tail?: string;
	omittedLines?: number;
	omittedBytes?: number;
	/** pi-style notice line, e.g. `[Showing lines 91-100 of 100. Full output: /tmp/x]`. */
	footer?: string;
	/** Extra lines after the footer (outcome wording, a log-cap notice). */
	notices?: string[];
}

function assemble({ head, tail, omittedLines, omittedBytes, footer, notices = [] }: AssembleInput): string {
	const blocks: string[] = [];
	if (head) blocks.push(head);
	const marker = omittedMarker(omittedLines, omittedBytes);
	if (marker) blocks.push(marker);
	if (tail) blocks.push(tail);
	if (footer) blocks.push(footer);
	for (const notice of notices) if (notice) blocks.push(notice);
	return blocks.join("\n\n");
}

/**
 * One shown window: where it starts (1-based, counted in the command's own lines)
 * and how many lines it holds.
 */
export interface ShownWindow {
	first: number;
	lines: number;
}

function windowLabel(window: ShownWindow): string {
	if (window.lines <= 1) return `${window.first}`;
	return `${window.first}-${window.first + window.lines - 1}`;
}

/**
 * The footer for a reshaped body.
 *
 * It names **every** window the body actually shows. A head+tail body that
 * carried only `[Showing lines 4991-5000 of 5000 …]` told the model the head was
 * not there while three head lines sat above the marker — the footer has to
 * describe the body it belongs to, not just pi's tail window.
 *
 * Counts are line numbers in the command's output, so a 5000-line result with
 * three head and ten tail lines reads `[Showing lines 1-3 and 4991-5000 of 5000.
 * Full output: <path>]`. With no head (`headLines: 0`) the footer is exactly pi's
 * own wording.
 */
function shownFooter(
	totalLines: number,
	windows: { head?: ShownWindow; tail?: ShownWindow },
	options: FullOutputPointer & { byteLimit?: number },
): string {
	const parts: string[] = [];
	if (windows.head && windows.head.lines > 0) parts.push(windowLabel(windows.head));
	if (windows.tail && windows.tail.lines > 0) parts.push(windowLabel(windows.tail));
	const limit = options.byteLimit !== undefined ? ` (${formatSize(options.byteLimit)} limit)` : "";
	const pointer = fullOutputPointer(options);
	// With no window at all (a big file whose line count is unknown) still say so.
	const shown = parts.length > 0 ? `lines ${parts.join(" and ")}` : "no lines";
	return `[Showing ${shown} of ${totalLines}${limit}${pointer}]`;
}

/**
 * Footer for a body reshaped from a file whose line count is unknown (only the
 * first/last byte windows were read): the counts are ours, so they are the only
 * honest numbers available.
 */
function windowCountFooter(windows: { head?: ShownWindow; tail?: ShownWindow }, options: FullOutputPointer): string {
	const parts: string[] = [];
	if (windows.head && windows.head.lines > 0) parts.push(`the first ${windows.head.lines} line${windows.head.lines === 1 ? "" : "s"}`);
	if (windows.tail && windows.tail.lines > 0) parts.push(`the last ${windows.tail.lines} line${windows.tail.lines === 1 ? "" : "s"}`);
	const shown = parts.length > 0 ? parts.join(" and ") : "no lines";
	return `[Showing ${shown}${fullOutputPointer(options)}]`;
}

/** How a footer points at the full output. */
export interface FullOutputPointer {
	/**
	 * The full output **as a file path** (COMPARISON.md decision 2): every result's
	 * bytes exist on disk, so the model can `rg`/`tail` them without running
	 * anything. This is what the footer names.
	 */
	fullOutputPath?: string;
	/**
	 * An optional convenience command for the same bytes (e.g.
	 * `pbb tail bg001 --full`), appended after the path — never a substitute for
	 * it: a job id is a pbb-internal handle, a path is the file itself.
	 */
	fullOutputHint?: string;
}

/**
 * The `. Full output: …` pointer of a footer, on the footer's own single line.
 *
 * Path first, always; the hint (if any) in parentheses after it, so a reader
 * that only has the command still finds the bytes and one that has neither
 * learns nothing false. With no path the hint stands alone (the reconcile digest
 * names several jobs, so it has no single file to point at).
 */
function fullOutputPointer({ fullOutputPath, fullOutputHint }: FullOutputPointer): string {
	const target =
		fullOutputPath && fullOutputHint ? `${fullOutputPath} (or: ${fullOutputHint})` : (fullOutputPath ?? fullOutputHint);
	return target ? `. Full output: ${target}` : "";
}

/* ------------------------------------------------------------------------- *
 * (b) Head+tail reshape
 * ------------------------------------------------------------------------- */

/** Lines as pi counts them: a trailing newline does not start a new line. */
function splitLines(text: string): string[] {
	if (text === "") return [];
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	return lines;
}

/** pi appends its own truncation notice to the text it returns; take it back off. */
const PI_NOTICE_PATTERN = /^\[Showing [^\n]*\]$/;

/** pi's `details.truncation` (`tools/bash.ts:343`), as far as we read it. */
export interface TruncationFacts {
	truncated?: boolean;
	truncatedBy?: "lines" | "bytes" | null;
	totalLines?: number;
	totalBytes?: number;
	outputLines?: number;
	outputBytes?: number;
	lastLinePartial?: boolean;
	maxBytes?: number;
}

export interface FormatForModelOptions extends FullOutputPointer {
	text: string;
	/** pi's `details.fullOutputPath`: the full output exists as a file. */
	fullOutputPath?: string;
	/** pi's `details.truncation`: present only when pi itself truncated the result. */
	truncation?: TruncationFacts;
	headLines?: number;
	tailLines?: number;
}

function wasTruncated(truncation: TruncationFacts | undefined): boolean {
	if (!truncation) return false;
	return truncation.truncated === true || truncation.truncatedBy === "lines" || truncation.truncatedBy === "bytes";
}

/** Text pi would itself have truncated (its tail window). */
function exceedsPiWindow(text: string): boolean {
	if (Buffer.byteLength(text, "utf8") > DEFAULT_OUTPUT_FORMAT.maxBytes) return true;
	return splitLines(text).length > DEFAULT_OUTPUT_FORMAT.maxLines;
}

const SIZE_UNITS: Record<string, number> = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024 };

function parseSize(value: string): number | undefined {
	const match = /^([\d.]+)\s*([KMG]?B)$/.exec(value.trim());
	if (!match) return undefined;
	const size = Number(match[1]) * (SIZE_UNITS[match[2]] ?? 1);
	return Number.isFinite(size) ? Math.round(size) : undefined;
}

export interface PiNoticeFacts {
	/** The numbers pi wrote in its notice. */
	truncation: TruncationFacts;
	/** `. Full output: <path>` — pi's own route to the file, when the notice has one. */
	fullOutputPath?: string;
}

/**
 * Read pi's own truncation notice (`tools/bash.ts`, `formatOutput`) back.
 *
 * This matters for a **failed** command: pi throws on timeout/abort, the agent
 * loop wraps the throw in a result with `details: {}`, and the truncation facts
 * are gone — but pi's notice line is still in the text, and it is the only
 * record that a fuller file exists. Re-reading it lets the reshape name pi's
 * real path instead of inventing one.
 */
export function parsePiTruncationNotice(line: string): PiNoticeFacts | undefined {
	const text = line.trim();
	if (!PI_NOTICE_PATTERN.test(text)) return undefined;
	const path = /\.\s*Full output:\s*(.+)\]$/.exec(text);
	const facts: TruncationFacts = { truncated: true, truncatedBy: "lines" };
	const partial = /^\[Showing last [^ ]+ of line (\d+)/.exec(text);
	if (partial) {
		facts.truncatedBy = "bytes";
		facts.lastLinePartial = true;
		facts.totalLines = Number(partial[1]);
	} else {
		const lines = /^\[Showing lines (\d+)-(\d+) of (\d+)/.exec(text);
		if (!lines) return undefined;
		facts.totalLines = Number(lines[3]);
		facts.outputLines = Math.max(0, Number(lines[2]) - Number(lines[1]) + 1);
		const limit = /\(([\d.]+\s*[KMG]?B) limit\)/.exec(text);
		if (limit) {
			facts.truncatedBy = "bytes";
			const maxBytes = parseSize(limit[1]);
			if (maxBytes !== undefined) facts.maxBytes = maxBytes;
		}
	}
	return { truncation: facts, ...(path ? { fullOutputPath: path[1].trim() } : {}) };
}

interface SplitNotices {
	/** The body with pi's notice line(s) taken out. */
	body: string;
	/** pi's own notice line, when one was found (outermost first). */
	notice?: string;
	/** Non-notice lines that sat after the notice, e.g. pi's exit/timeout status. */
	trailing: string[];
}

/**
 * Split a body into its text, pi's notice, and whatever pi appended after that
 * notice. Two shapes occur: the notice is the last line (a successful run), or
 * pi appended a status after it (`Command exited with code 3`, a timeout text) —
 * left in place, that notice would read as a second footer in the middle of the
 * reshaped body.
 */
function splitNotices(text: string, tailLines: number): SplitNotices {
	const lines = text.split("\n");
	const trimEnd = () => {
		while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	};
	trimEnd();
	let notice: string | undefined;
	for (;;) {
		if (lines.length === 0) break;
		const candidate = lines[lines.length - 1].trim();
		if (!parsePiTruncationNotice(candidate)) break;
		notice ??= candidate;
		lines.pop();
		trimEnd();
	}
	// Only the near-the-end window is inspected, so command output that merely
	// looks like a notice further up is left alone.
	const from = Math.max(0, lines.length - (Math.max(0, tailLines) + 3));
	let index = -1;
	for (let i = lines.length - 1; i >= from; i--) {
		if (parsePiTruncationNotice(lines[i].trim())) {
			index = i;
			break;
		}
	}
	const trailing: string[] = [];
	if (index >= 0) {
		notice ??= lines[index].trim();
		for (const line of lines.slice(index + 1)) {
			const trimmed = line.trim();
			if (trimmed !== "") trailing.push(trimmed);
		}
		lines.length = index;
		trimEnd();
	}
	return { body: lines.join("\n"), ...(notice === undefined ? {} : { notice }), trailing };
}

interface FileHeadTailOptions {
	headLines: number;
	tailLines: number;
	/**
	 * Byte length of the truncated body we were handed. A file that really holds
	 * the full output cannot be smaller than the truncated window of it, so a
	 * smaller file is not that file (e.g. pi's stale temp path in a replayed
	 * transcript) and must not supply the head.
	 */
	minBytes: number;
	maxBytes?: number;
}

/**
 * Read both ends of the full-output file — the head of the *command*, not the
 * head of pi's tail window (COMPARISON.md decision 5).
 *
 * pi's own text carries only its tail window, so the first line of an
 * unreshaped `seq 1 3000` result is line 1001. The full output is on disk
 * (`details.fullOutputPath`, or the path in pi's notice), so the head is read
 * from there; only the first and last `maxBytes` of the file are read, never the
 * whole file.
 *
 * Returns `undefined` when there is nothing better than the text window: no
 * path, an unreadable/unreasonably small file, a first line longer than the
 * whole window, or a file that holds no more lines than the body would show
 * anyway. Callers then keep the old behaviour (shape the text they were given).
 */
function headTailFromFile(path: string | undefined, options: FileHeadTailOptions): { head: string; tail: string } | undefined {
	if (!path) return undefined;
	const { headLines, tailLines, minBytes } = options;
	const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_OUTPUT_FORMAT.maxBytes);
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return undefined;
	}
	if (size <= 0) return undefined;
	if (minBytes > 0 && size < minBytes) return undefined;
	if (size <= maxBytes) {
		let text: string;
		try {
			text = readBytes(path, 0, size).toString("utf8");
		} catch {
			return undefined;
		}
		const lines = splitLines(presentText(text));
		if (lines.length <= headLines + tailLines) return undefined;
		return {
			head: lines.slice(0, headLines).join("\n"),
			tail: lines.slice(Math.max(0, lines.length - tailLines)).join("\n"),
		};
	}
	let headWindow: string;
	let tailText: string;
	try {
		headWindow = decodeHeadWindow(readBytes(path, 0, maxBytes));
		tailText = readTailWindow(path, size, maxBytes);
	} catch {
		return undefined;
	}
	const headPresented = presentText(headWindow);
	const lastNewline = headPresented.lastIndexOf("\n");
	// Only complete lines count: the end of the head window is cut mid-line.
	const headLinesAll = splitLines(lastNewline > 0 ? headPresented.slice(0, lastNewline) : "");
	if (headLinesAll.length < headLines) return undefined;
	const tailLinesAll = splitLines(presentText(tailText));
	return {
		head: headLinesAll.slice(0, headLines).join("\n"),
		tail: tailLinesAll.slice(Math.max(0, tailLinesAll.length - tailLines)).join("\n"),
	};
}

/**
 * The model-facing body for one bash result.
 *
 * Always: strip escapes, collapse `\r`. Then reshape to `headLines` + omitted
 * marker + `tailLines` + the full-output path — only for a result pi already
 * truncated, i.e. one carrying `details.truncation`/`details.fullOutputPath`, or
 * one whose text is larger than pi's window *and* carries pi's own notice (pi's
 * error path drops the details but keeps the notice). Everything else passes
 * through with presentation only. An already-shaped body (one carrying our
 * marker) is returned unchanged.
 *
 * The head and the tail come from the full-output file when it is readable, so
 * the model sees the command's own first and last lines; without a usable file
 * they come from the text pi handed over, whose head is the head of pi's tail
 * window rather than of the command.
 *
 * The omitted counts come from pi's own numbers (`totalLines`/`totalBytes`),
 * never from the text handed in: they count the lines (and bytes) *absent from
 * the body*, not the lines between the shown head and the shown tail.
 */
export function formatForModel(options: FormatForModelOptions): string {
	const text = options.text;
	if (typeof text !== "string") return "";
	if (text === "") return "";
	if (hasOmittedMarker(text)) return text;
	const presented = presentText(text);

	const headLines = Math.max(0, options.headLines ?? DEFAULT_OUTPUT_FORMAT.headLines);
	const tailLines = Math.max(0, options.tailLines ?? DEFAULT_OUTPUT_FORMAT.tailLines);

	let working = presented;
	let truncation = options.truncation;
	let fullOutputPath = options.fullOutputPath;
	let extractedTrailing: string[] = [];
	if (!wasTruncated(truncation)) {
		if (!exceedsPiWindow(presented)) return presented;
		const split = splitNotices(presented, tailLines);
		const facts = split.notice === undefined ? undefined : parsePiTruncationNotice(split.notice);
		if (!facts) return presented;
		truncation = facts.truncation;
		fullOutputPath = fullOutputPath ?? facts.fullOutputPath;
		working = split.body;
		extractedTrailing = split.trailing;
	}

	const { body, notice, trailing } = splitNotices(working, tailLines);
	const lines = splitLines(body);
	if (lines.length <= headLines + tailLines) {
		// pi's window is already tiny: nothing to omit, keep it whole.
		return presented;
	}

	// The full-output file is the only route to the command's real head: pi's
	// text starts with the first line of its tail window (line 1001 of a
	// 3000-line result). Without a usable file, this keeps the old behaviour and
	// takes the head from the text it was given.
	const fromFile = headTailFromFile(fullOutputPath, {
		headLines,
		tailLines,
		minBytes: Buffer.byteLength(body, "utf8"),
	});
	const head = fromFile ? fromFile.head : headLines > 0 ? lines.slice(0, headLines).join("\n") : "";
	const tail = fromFile ? fromFile.tail : tailLines > 0 ? lines.slice(lines.length - tailLines).join("\n") : "";
	const totalLines = truncation?.totalLines !== undefined && truncation.totalLines >= lines.length ? truncation.totalLines : lines.length;
	const omittedLines = Math.max(0, totalLines - (headLines + tailLines));
	const keptBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
	const totalBytes = truncation?.totalBytes;
	const omittedBytes =
		totalBytes !== undefined && totalBytes > keptBytes
			? totalBytes - keptBytes
			: Math.max(0, Buffer.byteLength(body, "utf8") - keptBytes);

	// The footer names both windows the body shows. The head sits at the command's
	// first line only when it came from the full-output file; the fallback head is
	// the head of pi's tail window and is numbered where that window starts.
	const shownHeadLines = headLines > 0 && head !== "" ? headLines : 0;
	const shownTailLines = tailLines > 0 && tail !== "" ? tailLines : 0;
	const headFirst = fromFile ? 1 : Math.max(1, totalLines - lines.length + 1);
	const tailFirst = Math.max(1, totalLines - shownTailLines + 1);
	const windows = {
		...(shownHeadLines > 0 ? { head: { first: headFirst, lines: shownHeadLines } } : {}),
		...(shownTailLines > 0 ? { tail: { first: tailFirst, lines: shownTailLines } } : {}),
	};
	// A partial last line has no line number to report: keep pi's own wording.
	const footer = truncation?.lastLinePartial
		? (notice ?? shownFooter(totalLines, windows, { fullOutputPath, fullOutputHint: options.fullOutputHint }))
		: shownFooter(totalLines, windows, {
				fullOutputPath,
				fullOutputHint: options.fullOutputHint,
				byteLimit: truncation?.truncatedBy === "bytes" ? (truncation.maxBytes ?? DEFAULT_OUTPUT_FORMAT.maxBytes) : undefined,
			});
	return assemble({ head, tail, omittedLines, omittedBytes, footer, notices: [...trailing, ...extractedTrailing] });
}

/* ------------------------------------------------------------------------- *
 * The completion-body variant: read only the first and last bytes of a log
 * ------------------------------------------------------------------------- */

export interface FormatLogFileOptions extends FullOutputPointer {
	headLines?: number;
	tailLines?: number;
	maxLines?: number;
	maxBytes?: number;
	/** The full output as a path; defaults to the log path this body was read from. */
	fullOutputPath?: string;
	/** Extra lines after the footer: how the command ended. */
	notices?: string[];
	/** The log stopped growing at `maxLogBytes`: its tail is not the true end. */
	logTruncated?: boolean;
	logBytes?: number;
}

function readBytes(path: string, from: number, length: number): Buffer {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(length);
		const read = readSync(fd, buffer, 0, length, from);
		return read === length ? buffer : buffer.subarray(0, read);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * Decode a window whose END may fall inside a multi-byte character (the head of
 * a big file): back off to the last complete UTF-8 character, so no lone U+D800-
 * style replacement char reaches the model. (Same idea as pi-bg-bash's
 * `wholeCharacters`, MIT.)
 */
function decodeHeadWindow(buffer: Buffer): string {
	let end = buffer.length;
	let i = end;
	while (i > 0 && end - i < 3 && (buffer[i - 1] & 0xc0) === 0x80) i--;
	if (i > 0 && buffer[i - 1] >= 0xc0) {
		const need = buffer[i - 1] >= 0xf0 ? 4 : buffer[i - 1] >= 0xe0 ? 3 : 2;
		if (end - (i - 1) < need) end = i - 1;
	}
	return buffer.subarray(0, end).toString("utf8");
}

/** The last `maxBytes` of a file, starting on a line boundary when one exists. */
function readTailWindow(path: string, size: number, maxBytes: number): string {
	const start = Math.max(0, size - maxBytes);
	// One byte of look-behind tells us whether the window begins on a boundary:
	// if it is a newline, dropping just that byte keeps the first visible line.
	const from = start > 0 ? start - 1 : 0;
	let window = readBytes(path, from, size - from);
	if (from !== start) {
		if (window[0] === 0x0a) {
			window = window.subarray(1);
		} else {
			// The window starts inside a line: drop that cut fragment.
			const newline = window.indexOf(0x0a);
			if (newline < 0) return "";
			window = window.subarray(newline + 1);
		}
	}
	// The start may still land inside a multi-byte character.
	let offset = 0;
	while (offset < window.length && (window[offset] & 0xc0) === 0x80) offset++;
	return window.subarray(offset).toString("utf8");
}

/**
 * The completion-body variant: `headLines` from the start of the log and
 * `tailLines` from its end, with only the first and last `maxBytes` read (a
 * 100 MB log costs two seeks, never a whole-file read).
 *
 * Handles: a missing file (empty body), a window that starts exactly on a
 * newline (no line lost), a window that splits a multi-byte character (no lone
 * replacement char), and a log capped at `maxLogBytes` (the tail is not the end
 * of the command's output — say so instead of implying completeness).
 */
export function formatLogFile(path: unknown, options: FormatLogFileOptions = {}): string {
	if (typeof path !== "string" || path === "") return "";
	let size: number;
	try {
		size = statSync(path).size;
	} catch {
		return "";
	}

	const headLines = Math.max(0, options.headLines ?? DEFAULT_OUTPUT_FORMAT.headLines);
	const tailLines = Math.max(0, options.tailLines ?? DEFAULT_OUTPUT_FORMAT.tailLines);
	const maxLines = Math.max(1, options.maxLines ?? DEFAULT_OUTPUT_FORMAT.maxLines);
	const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_OUTPUT_FORMAT.maxBytes);
	const fullOutputPath = options.fullOutputPath ?? path;
	const pointer: FullOutputPointer = { fullOutputPath, fullOutputHint: options.fullOutputHint };
	const notices = (options.notices ?? []).filter((notice) => notice);
	if (options.logTruncated) {
		notices.push(`Log capped at ${humanBytes(options.logBytes ?? 0)}: output written after that point was not recorded.`);
	}
	if (size <= 0) return notices.join("\n\n");

	let head = "";
	let tail = "";
	let totalLines: number | undefined;
	let omittedBytes: number | undefined;

	if (size <= maxBytes) {
		// The whole log fits in one window: read it and count exactly.
		let text: string;
		try {
			text = readBytes(path, 0, size).toString("utf8");
		} catch {
			return "";
		}
		const presented = presentText(text);
		const lines = splitLines(presented);
		totalLines = lines.length;
		if (lines.length <= maxLines) {
			// Nothing is omitted: the whole log is the body.
			return assemble({ head: lines.join("\n"), notices });
		}
		head = headLines > 0 ? lines.slice(0, headLines).join("\n") : "";
		tail = tailLines > 0 ? lines.slice(lines.length - tailLines).join("\n") : "";
		const keptBytes = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
		omittedBytes = Math.max(0, Buffer.byteLength(presented, "utf8") - keptBytes);
	} else {
		let headWindow: Buffer;
		let tailText: string;
		try {
			headWindow = readBytes(path, 0, maxBytes);
			tailText = readTailWindow(path, size, maxBytes);
		} catch {
			return "";
		}
		const headText = decodeHeadWindow(headWindow);
		const headWindowPresented = presentText(headText);
		// Only complete lines are usable: the end of the head window is cut mid-line
		// (unless the whole file ended inside it, which is the branch above).
		const lastNewline = headWindowPresented.lastIndexOf("\n");
		const headComplete = lastNewline > 0 ? headWindowPresented.slice(0, lastNewline) : "";
		head = headLines > 0 ? splitLines(headComplete).slice(0, headLines).join("\n") : "";
		const tailLinesAll = splitLines(presentText(tailText));
		tail = tailLines > 0 ? tailLinesAll.slice(Math.max(0, tailLinesAll.length - tailLines)).join("\n") : "";
		omittedBytes = Math.max(0, size - (Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8")));
	}

	const shownHeadLines = headLines > 0 && head !== "" ? headLines : 0;
	const shownTailLines = tailLines > 0 && tail !== "" ? tailLines : 0;
	const windows = {
		...(shownHeadLines > 0 ? { head: { first: 1, lines: shownHeadLines } } : {}),
		// `first: 0` when the total is unknown (only the byte windows were read):
		// `windowCountFooter` counts lines, it does not number them.
		...(shownTailLines > 0 ? { tail: { first: totalLines !== undefined ? Math.max(1, totalLines - shownTailLines + 1) : 0, lines: shownTailLines } } : {}),
	};
	const footer = totalLines !== undefined ? shownFooter(totalLines, windows, pointer) : windowCountFooter(windows, pointer);
	return assemble({ head, tail, omittedLines: totalLines !== undefined ? Math.max(0, totalLines - headLines - tailLines) : undefined, omittedBytes, footer, notices });
}

/* ------------------------------------------------------------------------- *
 * The pi-window cap (completion bodies that are longer than pi's own window)
 * ------------------------------------------------------------------------- */

export interface CapBodyOptions extends FullOutputPointer {
	maxLines?: number;
	maxBytes?: number;
}

/** Truncate a string to the last `maxBytes`, never mid-character (pi's helper, mirrored). */
function tailByBytes(text: string, maxBytes: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.length <= maxBytes) return text;
	let start = buffer.length - maxBytes;
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
	return buffer.subarray(start).toString("utf8");
}

/**
 * pi's own result cap (tail window, `truncate.ts`) applied to a multi-entry
 * aggregate (the reconcile digest), with pi's wording so the model reads it like
 * any other truncated bash result.
 *
 * Note what it is NOT: a single job's completion body never uses this — it goes
 * through `formatLogFile`, i.e. the same head+tail path as a tool result (PLAN
 * §7b / §6) — see the call site in `extensions/background-bash.ts`.
 */
export function capBodyToPiWindow(text: string, options: CapBodyOptions = {}): string {
	if (typeof text !== "string" || text === "") return "";
	if (hasOmittedMarker(text)) return text;
	const maxLines = Math.max(1, options.maxLines ?? DEFAULT_OUTPUT_FORMAT.maxLines);
	const maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_OUTPUT_FORMAT.maxBytes);
	const presented = presentText(text);
	const lines = splitLines(presented);
	let keptLines = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
	let truncatedBy: "lines" | "bytes" | null = lines.length > maxLines ? "lines" : null;
	let kept = keptLines.join("\n");
	if (Buffer.byteLength(kept, "utf8") > maxBytes) {
		kept = tailByBytes(kept, maxBytes);
		keptLines = splitLines(kept);
		truncatedBy = "bytes";
	}
	if (truncatedBy === null) return presented;
	const totalLines = lines.length;
	const footer = shownFooter(
		totalLines,
		{ tail: { first: Math.max(1, totalLines - keptLines.length + 1), lines: keptLines.length } },
		{
			...(options.fullOutputPath ? { fullOutputPath: options.fullOutputPath } : {}),
			...(options.fullOutputHint ? { fullOutputHint: options.fullOutputHint } : {}),
			byteLimit: truncatedBy === "bytes" ? maxBytes : undefined,
		},
	);
	return `${kept}\n\n${footer}`;
}
