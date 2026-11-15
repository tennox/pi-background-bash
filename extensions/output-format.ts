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
 *    window alone. A *failed* command is truncated by pi too but comes back
 *    without `details`, so the reshape also recognises pi's own notice line and
 *    reuses the real path it names;
 *  - a historical result that carries no full-output path is trimmed by the
 *    size guard, which says that no full-output file exists instead of naming a
 *    fake one;
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
 * Note: this is the single owner of model-facing truncation and reshape (PLAN
 * §7). `extensions/background-bash.ts` no longer registers a trim-only `context`
 * hook of its own; it only produces the completion bodies, through the same
 * `lib/output-format.ts` helpers.
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

/**
 * Marks a body this hook already trimmed: a historical result that is oversized
 * and has no full-output file anywhere. Deliberately says nothing about a path —
 * there is no path, and a fabricated one used to read as a second footer.
 */
const TRIMMED_NOTICE = "this result was trimmed to keep the request small; no full-output file exists";

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

/**
 * The size guard for a *historical* result that carries no full-output path and
 * for any non-bash tool result pi left oversized. It never invents a path: the
 * body says that no full-output file exists instead of pointing at a string that
 * reads like one (PLAN §7 — the reshape/notice wording is pi's).
 */
function trimOversized(text: string, config: OutputFormatConfig): string {
	if (text.includes(TRIMMED_NOTICE)) return text;
	const { content, truncation } = truncateContextText(text, {
		mode: "tail",
		maxLines: config.maxLines,
		maxBytes: config.maxBytes,
		appendNotice: false,
	});
	if (!truncation?.truncated) return text;
	const notice = formatTruncationNotice(truncation, "tail");
	const withHint = notice.endsWith("]") ? `${notice.slice(0, -1)} — ${TRIMMED_NOTICE}]` : `${notice} ${TRIMMED_NOTICE}`;
	// No envelope escaping: message content is plain text now, so command output
	// passes through exactly as it was written.
	return `${content}\n\n${withHint}`;
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
			return trimOversized(formatted, state.config);
		};
	}

	if (role === "custom" && fullOutputPath !== undefined) {
		return (text) => formatForModel({ text, fullOutputPath, truncation, headLines: state.config.headLines, tailLines: state.config.tailLines });
	}

	if (role === "toolResult") {
		return (text) => trimOversized(text, state.config);
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

