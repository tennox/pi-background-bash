/**
 * The model-facing output layer (PLAN §7): a second extension entry point that
 * registers only the `context` hook.
 *
 * What it does, per provider request:
 *  - every `bash` tool result and every `custom` message carrying
 *    `details.fullOutputPath` gets the presentation pass (ANSI/control
 *    sequences stripped, `\r` progress frames collapsed to their last frame);
 *  - a result pi already truncated (`details.truncation`/`details.fullOutputPath`)
 *    is reshaped to head + `… N lines / X omitted …` + tail + the full-output
 *    path, so the model reads the beginning *and* the end instead of pi's tail
 *    window alone;
 *  - a historical result that carries no full-output path is trimmed by the
 *    size guard (the fallback carried over from the background-bash extension);
 *  - each body is computed once and frozen for the rest of the session, keyed
 *    by the message's own identity (`toolCallId`, or custom-type + timestamp).
 *    Re-deriving on every request would let a still-growing log move the text
 *    under an already-sent prefix and break the provider's prompt cache.
 *
 * What this hook CANNOT control — model text is not human text, and not script
 * text (PLAN §15 finding 9):
 *  - the TUI keeps rendering the stored transcript entries; pi's `bash`
 *    renderer shows the text that was stored, not this rewritten copy;
 *  - codemode reads `structuredContent` verbatim, which the tool produced;
 *  - compaction summarises the raw message text, not this body.
 * Each surface is fixed where it is produced; claiming "one owner formats
 * everything" would be false.
 *
 * Note: `extensions/background-bash.ts` still registers its own trim-only
 * `context` hook for the same size guard, because that hook's test lives outside
 * this change. Formatting and trimming here are idempotent, so the duplicate is
 * harmless; the old call site is one deletion away from a single owner.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	formatForModel,
	loadOutputFormatConfig,
	type OutputFormatConfig,
	type TruncationFacts,
} from "../lib/output-format.ts";
import { formatTruncationNotice, truncateContextText } from "./pi-context-utils.ts";

/** Bounded so a long session with thousands of results cannot grow the map forever. */
const MAX_CACHED_BODIES = 2000;

const GUARD_HINT = "result trimmed by pi-background-bash context guard";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * Freeze-once store: `get(key, produce)` runs `produce` the first time a body is
 * requested and returns the identical string afterwards, so a log that keeps
 * growing can never change text the model has already been sent.
 */
export class FrozenBodyCache {
	private readonly bodies = new Map<string, string>();

	constructor(private readonly limit = MAX_CACHED_BODIES) {}

	get(key: string, produce: () => string): string {
		const cached = this.bodies.get(key);
		if (cached !== undefined) return cached;
		const body = produce();
		this.bodies.set(key, body);
		if (this.bodies.size > this.limit) {
			// Map iteration is insertion-ordered: drop the oldest body.
			const oldest = this.bodies.keys().next();
			if (!oldest.done) this.bodies.delete(oldest.value);
		}
		return body;
	}

	get size(): number {
		return this.bodies.size;
	}

	clear(): void {
		this.bodies.clear();
	}
}

export type HookState = {
	cache: FrozenBodyCache;
	config: OutputFormatConfig;
};

function truncationFacts(value: unknown): TruncationFacts | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const facts: TruncationFacts = {
		truncated: record.truncated === true,
		truncatedBy: record.truncatedBy === "lines" || record.truncatedBy === "bytes" ? record.truncatedBy : null,
	};
	for (const key of ["totalLines", "totalBytes", "outputLines", "outputBytes", "maxBytes"] as const) {
		if (typeof record[key] === "number") facts[key] = record[key] as number;
	}
	if (record.lastLinePartial === true) facts.lastLinePartial = true;
	return facts;
}

function escapeClosingTags(text: string): string {
	return text.replace(/<\/pi_context>/gi, "<\\/pi_context>");
}

/** The size guard, carried over unchanged from the background-bash extension. */
function trimOversized(text: string, toolName: string, config: OutputFormatConfig): string {
	if (text.includes(GUARD_HINT)) return text;
	const { content, truncation } = truncateContextText(text, {
		mode: "tail",
		maxLines: config.maxLines,
		maxBytes: config.maxBytes,
		appendNotice: false,
	});
	if (!truncation?.truncated) return text;
	const notice = formatTruncationNotice(truncation, "tail");
	const hint = `${toolName} ${GUARD_HINT}`;
	const withHint = notice.endsWith("]") ? `${notice.slice(0, -1)}. Full output: ${hint}]` : `${notice} Full output: ${hint}`;
	return `${escapeClosingTags(content)}\n\n${withHint}`;
}

/**
 * Identity of a message inside one request. Messages are `structuredClone`d per
 * request, so object identity is useless; `toolCallId` is stable and unique per
 * call, and a custom message is pinned by type + timestamp + position. A part's
 * key also carries the text length: repaired duplicate tool results can share a
 * `toolCallId`, and the length tells two different bodies apart.
 */
function messageKey(record: Record<string, unknown>, role: unknown, index: number): string {
	if (typeof record.toolCallId === "string" && record.toolCallId.length > 0) return record.toolCallId;
	const customType = typeof record.customType === "string" ? record.customType : String(role);
	const timestamp = typeof record.timestamp === "number" ? record.timestamp : "?";
	return `${customType}:${timestamp}:${index}`;
}

type TextTransform = (text: string) => string;

function transformFor(record: Record<string, unknown>, state: HookState): TextTransform | undefined {
	const role = record.role;
	const details = asRecord(record.details);
	const fullOutputPath = typeof details?.fullOutputPath === "string" ? details.fullOutputPath : undefined;
	const truncation = truncationFacts(details?.truncation);

	if (role === "toolResult" && record.toolName === "bash") {
		return (text) => {
			const formatted = formatForModel({
				text,
				fullOutputPath,
				truncation,
				headLines: state.config.headLines,
				tailLines: state.config.tailLines,
			});
			// A result pi did not truncate has no full-output path: the size guard
			// is the fallback for historical results, exactly as before.
			if (fullOutputPath || truncation) return formatted;
			return trimOversized(formatted, "bash", state.config);
		};
	}

	if (role === "custom" && fullOutputPath !== undefined) {
		return (text) => formatForModel({ text, fullOutputPath, truncation, headLines: state.config.headLines, tailLines: state.config.tailLines });
	}

	if (role === "toolResult") {
		const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
		return (text) => trimOversized(text, toolName, state.config);
	}

	return undefined;
}

function rewriteMessage(message: AgentMessage, index: number, state: HookState): AgentMessage | undefined {
	const record = asRecord(message);
	if (!record) return undefined;
	const transform = transformFor(record, state);
	if (!transform) return undefined;
	const key = messageKey(record, record.role, index);

	const content = record.content;
	if (typeof content === "string") {
		const text = state.cache.get(`${key}#body:${content.length}`, () => transform(content));
		return text === content ? undefined : ({ ...message, content: text } as AgentMessage);
	}
	if (!Array.isArray(content)) return undefined;

	let changed = false;
	const nextContent = content.map((part, partIndex) => {
		const item = asRecord(part);
		if (item?.type !== "text" || typeof item.text !== "string") return part;
		const original = item.text;
		const text = state.cache.get(`${key}#${partIndex}:${original.length}`, () => transform(original));
		if (text === original) return part;
		changed = true;
		return { ...part, text };
	});
	return changed ? ({ ...message, content: nextContent } as AgentMessage) : undefined;
}

/**
 * The hook body, exported for tests: rewrite every message that needs it, and
 * return `undefined` (no new list) when none does.
 */
export function rewriteContextMessages(messages: AgentMessage[], state: HookState): AgentMessage[] | undefined {
	let changed = false;
	const next = messages.map((message, index) => {
		const rewritten = rewriteMessage(message, index, state);
		if (!rewritten) return message;
		changed = true;
		return rewritten;
	});
	return changed ? next : undefined;
}

export default function bashOutputFormat(pi: ExtensionAPI): void {
	const cache = new FrozenBodyCache();
	const configs = new Map<string, OutputFormatConfig>();

	const configFor = (cwd: string | undefined): OutputFormatConfig => {
		const key = cwd ?? "";
		const cached = configs.get(key);
		if (cached) return cached;
		const config = loadOutputFormatConfig(cwd);
		configs.set(key, config);
		return config;
	};

	pi.on("session_start", () => {
		cache.clear();
		configs.clear();
	});

	pi.on("context", (event, ctx) => {
		const messages = rewriteContextMessages(event.messages, { cache, config: configFor(ctx?.cwd) });
		return messages ? { messages } : undefined;
	});
}

