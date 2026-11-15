/**
 * Local replacements for sshkeda/pi-context (private repository, no longer
 * accessible). The two functions this extension still uses from that trio:
 *
 *  - truncateContextText()   tail/head truncation by lines and bytes (UTF-8 aware)
 *  - formatTruncationNotice() display notice for a truncation
 *
 * The third, the XML result-envelope builder, was retired along with the
 * envelope itself: background completions arrive as plain text carrying the
 * job id, outcome and log pointer in the text, with structured `details`
 * beside it (pi's own convention for tool results).
 *
 * See https://github.com/mowenroot/pi-background-bash (fork of sshkeda's) for
 * the rationale: the original dependency could not be installed from GitHub.
 */

export interface TruncationInfo {
	truncated: boolean;
	mode: "head" | "tail";
	maxLines: number;
	maxBytes: number;
	removedLines: number;
	removedBytes: number;
	originalLength: number;
	appendNotice: boolean;
	totalLines?: number;
	keptLines?: number;
}

export interface TruncateContextTextOptions {
	mode?: "head" | "tail";
	maxLines: number;
	maxBytes: number;
	appendNotice?: boolean;
}

/**
 * Truncate text by maxLines and maxBytes (UTF-8 aware, no mid-codepoint cuts).
 * mode "head" keeps the beginning, "tail" keeps the end.
 * Returns { content, truncation } where truncation is undefined when untouched.
 */
export function truncateContextText(
	text: string,
	{ mode = "tail", maxLines, maxBytes, appendNotice = false }: TruncateContextTextOptions,
): { content: string; truncation?: TruncationInfo } {
	if (typeof text !== "string") return { content: String(text ?? ""), truncation: undefined };
	if (text === "") return { content: "", truncation: undefined };

	let truncated = false;
	let removedLines = 0;
	let removedBytes = 0;

	let lines = text.split("\n");
	if (lines.length > maxLines) {
		truncated = true;
		removedLines = lines.length - maxLines;
		lines = mode === "head" ? lines.slice(0, maxLines) : lines.slice(-maxLines);
	}

	let content = lines.join("\n");
	const buf = Buffer.from(content, "utf8");
	if (buf.length > maxBytes) {
		truncated = true;
		removedBytes = buf.length - maxBytes;
		let cut: Buffer;
		if (mode === "head") {
			cut = buf.subarray(0, maxBytes);
			while (cut.length > 0 && (cut[cut.length - 1] & 0xc0) === 0x80) cut = cut.subarray(0, cut.length - 1);
		} else {
			cut = buf.subarray(removedBytes);
			while (cut.length > 0 && (cut[0] & 0xc0) === 0x80) cut = cut.subarray(1);
		}
		content = cut.toString("utf8");
	}

	const totalLines = text.split("\n").length;
	const keptLines = content.split("\n").length;
	const truncation: TruncationInfo | undefined = truncated
		? { truncated, mode, maxLines, maxBytes, removedLines, removedBytes, originalLength: text.length, appendNotice, totalLines, keptLines }
		: undefined;

	if (truncated && appendNotice && truncation) {
		content = `${content}\n${formatTruncationNotice(truncation, mode)}`;
	}

	return { content, truncation };
}

/** Build a notice like "[Showing lines 2006-2105 of 2105]", or "[output truncated: tail kept (13 KB)]" when only bytes were cut. */
export function formatTruncationNotice(truncation: TruncationInfo, mode: "head" | "tail" = "tail"): string {
	if (truncation?.removedLines > 0 && truncation.totalLines && truncation.keptLines) {
		const first = mode === "head" ? 1 : truncation.totalLines - truncation.keptLines + 1;
		const last = mode === "head" ? truncation.keptLines : truncation.totalLines;
		return `[Showing lines ${first}-${last} of ${truncation.totalLines}]`;
	}
	const parts: string[] = [];
	if (truncation?.removedLines > 0) parts.push(`${truncation.removedLines} line${truncation.removedLines > 1 ? "s" : ""}`);
	if (truncation?.removedBytes > 0) parts.push(`${Math.max(1, Math.round(truncation.removedBytes / 1024))} KB`);
	const detail = parts.length ? ` (${parts.join(", ")})` : "";
	return `[output truncated: ${mode} kept${detail}]`;
}
