import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LIB_PATH = new URL("../lib/output-format.ts", import.meta.url).pathname;
const EXT_PATH = new URL("../extensions/output-format.ts", import.meta.url).pathname;

async function loadModule(path, { defaultExport = false } = {}) {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: !defaultExport });
  return defaultExport ? jiti.import(path, { default: true }) : jiti.import(path);
}

const loadLib = () => loadModule(LIB_PATH);
const loadExtension = () => loadModule(EXT_PATH, { defaultExport: true });

function tempDir(tag) {
  return mkdtempSync(join(tmpdir(), `pi-output-format-${tag}-${process.pid}-${Date.now()}-`));
}

/** A fake pi API that records the handlers an extension registers. */
function fakePi() {
  const handlers = new Map();
  return {
    api: {
      on(event, handler) {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
        return () => {};
      },
      registerTool() {},
      registerMessageRenderer() {},
      sendMessage() {},
    },
    has: (event) => (handlers.get(event) ?? []).length > 0,
    async emit(event, payload = {}, ctx = { cwd: process.cwd(), hasUI: false, isIdle: () => true }) {
      let result;
      for (const handler of handlers.get(event) ?? []) {
        result = await handler({ type: event, ...payload }, ctx);
      }
      return result;
    },
  };
}

function bashResult(text, details, toolCallId = "call-1") {
  return { role: "toolResult", toolName: "bash", toolCallId, content: [{ type: "text", text }], details, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// (a) presentation: carriage returns and escape sequences
// ---------------------------------------------------------------------------

test("collapseCarriageReturns keeps only the last progress frame of a line", async () => {
  const { collapseCarriageReturns } = await loadLib();
  assert.equal(collapseCarriageReturns("10%\r50%\r100% done\nnext line"), "100% done\nnext line");
  // CRLF line endings lose the CR but keep the whole line.
  assert.equal(collapseCarriageReturns("alpha\r\nbeta\r\n"), "alpha\nbeta\n");
  // A trailing frame without its newline yet (a log tail mid-progress) keeps its text.
  assert.equal(collapseCarriageReturns("working 50%\r"), "working 50%");
  assert.equal(collapseCarriageReturns("no carriage returns here"), "no carriage returns here");
});

test("stripEscapes removes ANSI CSI/OSC sequences and control chars but keeps \\n and \\t", async () => {
  const { stripEscapes } = await loadLib();
  assert.equal(stripEscapes("\u001b[31mred\u001b[0m and \u001b[1;32mbold green\u001b[0m"), "red and bold green");
  assert.equal(stripEscapes("\u001b]0;window title\u0007after osc"), "after osc");
  assert.equal(stripEscapes("bell\u0007 nul\u0000 backspace\u0008done"), "bell nul backspacedone");
  assert.equal(stripEscapes("col1\tcol2\nrow2\tcol3"), "col1\tcol2\nrow2\tcol3");
});

// ---------------------------------------------------------------------------
// (b) head+tail reshape, only for output pi already truncated
// ---------------------------------------------------------------------------

function syntheticTruncatedResult() {
  const windowLines = Array.from({ length: 100 }, (_, i) => `line ${String(i).padStart(3, "0")}`);
  // pi keeps the tail and appends its own notice to the text it hands back.
  const text = `${windowLines.join("\n")}\n\n[Showing lines 9951-10050 of 10050. Full output: /tmp/pi-bash-abc.log]`;
  const details = {
    fullOutputPath: "/tmp/pi-bash-abc.log",
    truncation: {
      truncated: true,
      truncatedBy: "lines",
      totalLines: 10050,
      totalBytes: 502_500,
      outputLines: 100,
      outputBytes: 1000,
      lastLinePartial: false,
    },
  };
  return { text, details, windowLines };
}

test("formatForModel reshapes a pi-truncated result to head + omitted marker + tail + path", async () => {
  const { formatForModel } = await loadLib();
  const { text, details, windowLines } = syntheticTruncatedResult();
  const formatted = formatForModel({
    text,
    fullOutputPath: details.fullOutputPath,
    truncation: details.truncation,
    headLines: 3,
    tailLines: 10,
  });

  const lines = formatted.split("\n");
  // No readable full-output file (that path does not exist), so the reshape falls
  // back to the head of pi's window — the pre-file behaviour.
  assert.deepEqual(lines.slice(0, 3), windowLines.slice(0, 3), "without a file the head falls back to pi's window head");
  const marker = lines.find((line) => line.includes("omitted"));
  assert.ok(marker, "an omitted marker line must be present");
  // Counts come from pi's own numbers (10050 total), never from the text we were given.
  const keptBytes =
    Buffer.byteLength(windowLines.slice(0, 3).join("\n")) + Buffer.byteLength(windowLines.slice(-10).join("\n"));
  const omittedKb = ((502_500 - keptBytes) / 1024).toFixed(1);
  assert.equal(marker, `… ${10050 - 3 - 10} lines / ${omittedKb}KB omitted …`);
  const blocks = formatted.split("\n\n");
  assert.equal(blocks.at(-2), windowLines.slice(-10).join("\n"), "tail keeps the last 10 lines");
  assert.match(lines.at(-1), /^\[Showing lines 10041-10050 of 10050\. Full output: \/tmp\/pi-bash-abc\.log\]$/);
  // pi's own, now-stale notice line must not survive inside the tail.
  assert.equal(formatted.match(/\[Showing lines/g).length, 1);
});

test("formatForModel takes the head from the full-output file, not from pi's tail window", async () => {
  // Live acceptance finding: `seq 1 3000` showed "first 3 lines" = 1001-1003,
  // because pi's text starts at the first line of its *tail* window. The full
  // output is on disk, so both ends are read from there (COMPARISON decision 5).
  const { formatForModel } = await loadLib();
  const dir = tempDir("file-head");
  const logPath = join(dir, "bg001.log");
  const all = Array.from({ length: 3000 }, (_, i) => `line-${i + 1}`);
  writeFileSync(logPath, `${all.join("\n")}\n`);
  const window = all.slice(1000);
  const text = `${window.join("\n")}\n\n[Showing lines 1001-3000 of 3000. Full output: ${logPath}]`;
  try {
    const body = formatForModel({
      text,
      fullOutputPath: logPath,
      truncation: { truncated: true, truncatedBy: "lines", totalLines: 3000, outputLines: 2000 },
      headLines: 3,
      tailLines: 10,
    });
    const lines = body.split("\n");
    assert.deepEqual(lines.slice(0, 3), ["line-1", "line-2", "line-3"], "the head must be the command's first lines");
    const marker = lines.find((line) => line.includes("omitted"));
    assert.ok(marker?.startsWith("… 2987 lines"), `the marker counts the lines absent from the body: ${marker}`);
    const blocks = body.split("\n\n");
    assert.equal(blocks.at(-2), all.slice(-10).join("\n"), "the tail still comes from the end of the output");
    assert.match(blocks.at(-1), /^\[Showing lines 2991-3000 of 3000\. Full output: .*bg001\.log\]$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatForModel only strips and collapses when pi did not truncate the result", async () => {
  const { formatForModel } = await loadLib();
  const text = "\u001b[32mok\u001b[0m\ndone";
  const untouched = formatForModel({ text });
  assert.equal(untouched, "ok\ndone");
  // No full-output path, no truncation numbers: no marker, no footer.
  assert.doesNotMatch(untouched, /omitted/);
  assert.doesNotMatch(untouched, /Full output:/);
});

test("formatForModel reads pi's notice back when pi threw the truncated result away", async () => {
  // pi's error path (timeout/abort) drops `details`, so the only record that the
  // full output exists is the notice line pi itself put in the text. Trimming the
  // text a second time used to append a second footer whose "Full output:" was a
  // sentence ("bash result trimmed by … context guard") — not a path.
  const { formatForModel } = await loadLib();
  const dir = tempDir("thrown");
  const logPath = join(dir, "pi-bash-real.log");
  writeFileSync(logPath, "full output lives here\n");
  const windowLines = Array.from({ length: 2000 }, (_, i) => String(i + 1001));
  const text = `${windowLines.join("\n")}\n\n[Showing lines 1001-3000 of 3000. Full output: ${logPath}]\n\nCommand timed out after 2 seconds`;
  try {
    const formatted = formatForModel({ text, headLines: 3, tailLines: 10 });
    assert.equal((formatted.match(/\[Showing lines/g) ?? []).length, 1, "exactly one truncation footer");
    assert.ok(
      formatted.includes(`[Showing lines 2991-3000 of 3000. Full output: ${logPath}]`),
      "the footer names pi's real file",
    );
    assert.doesNotMatch(formatted, /context guard/);
    assert.match(formatted, /Command timed out after 2 seconds/, "pi's status line survives and follows the footer");
    assert.ok(formatted.endsWith("Command timed out after 2 seconds"));
    assert.equal(formatted.split("\n").slice(0, 3).join("\n"), windowLines.slice(0, 3).join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatForModel leaves a second notice out when pi appended a status after its own", async () => {
  const { formatForModel } = await loadLib();
  const windowLines = Array.from({ length: 2000 }, (_, i) => String(i + 1001));
  const text = `${windowLines.join("\n")}\n\n[Showing lines 1001-3000 of 3000. Full output: /tmp/pi-bash-abc.log]\n\nCommand exited with code 3`;
  const formatted = formatForModel({
    text,
    fullOutputPath: "/home/manu/.pi/pbb/logs/bg001.log",
    truncation: { truncated: true, truncatedBy: "lines", totalLines: 3000, totalBytes: 40_000, outputLines: 2000 },
    headLines: 3,
    tailLines: 10,
  });
  assert.equal((formatted.match(/\[Showing lines/g) ?? []).length, 1, "pi's in-body notice must not read as a second footer");
  assert.match(formatted, /Full output: \/home\/manu\/\.pi\/pbb\/logs\/bg001\.log\]/);
  assert.ok(formatted.endsWith("Command exited with code 3"), "the status line stays after the footer");
});

test("formatForModel is idempotent: an already-shaped body passes through unchanged", async () => {
  const { formatForModel } = await loadLib();
  const { text, details } = syntheticTruncatedResult();
  const once = formatForModel({ text, fullOutputPath: details.fullOutputPath, truncation: details.truncation });
  const twice = formatForModel({ text: once, fullOutputPath: details.fullOutputPath, truncation: details.truncation });
  assert.equal(twice, once);
});

test("formatForModel keeps a small truncated window whole instead of inventing an omission", async () => {
  const { formatForModel } = await loadLib();
  const formatted = formatForModel({
    text: "a\nb\nc\n\n[Showing last 3B of line 3 (line is 3B). Full output: /tmp/x.log]",
    fullOutputPath: "/tmp/x.log",
    truncation: { truncated: true, truncatedBy: "bytes", totalLines: 3, totalBytes: 3 },
    headLines: 3,
    tailLines: 10,
  });
  assert.doesNotMatch(formatted, /omitted/);
  assert.match(formatted, /a\nb\nc/);
});

// ---------------------------------------------------------------------------
// The log-file variant: first and last bytes only
// ---------------------------------------------------------------------------

test("formatLogFile returns an empty body for a missing log", async () => {
  const { formatLogFile } = await loadLib();
  assert.equal(formatLogFile(join(tempDir("missing"), "nope.log")), "");
  assert.equal(formatLogFile(undefined), "");
});

test("formatLogFile keeps the first complete line when the tail window starts on a newline", async () => {
  const { formatLogFile } = await loadLib();
  const dir = tempDir("boundary");
  const path = join(dir, "bg001.log");
  const content = "line-0\nline-1\nline-2\nline-3\n";
  writeFileSync(path, content);
  try {
    // 21 bytes is exactly "line-1\nline-2\nline-3\n": the window begins on a line
    // boundary, so no line may be dropped (the old reader lost one here).
    const body = formatLogFile(path, { headLines: 0, tailLines: 10, maxLines: 10, maxBytes: 21 });
    assert.match(body, /line-1/);
    assert.match(body, /line-3/);
    assert.doesNotMatch(body, /line-0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatLogFile never emits a replacement char where a window splits a multi-byte character", async () => {
  const { formatLogFile } = await loadLib();
  const dir = tempDir("multibyte");
  const path = join(dir, "bg002.log");
  // "ä" is 2 bytes, "𝄞" is 4: chosen so both the head and the tail window cut one apart.
  const lines = Array.from({ length: 200 }, (_, i) => `zeile ${i} äöü 𝄞𝄞`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  try {
    for (const maxBytes of [99, 100, 101, 150, 301]) {
      const body = formatLogFile(path, { headLines: 2, tailLines: 2, maxLines: 10, maxBytes });
      assert.doesNotMatch(body, /\uFFFD/, `maxBytes=${maxBytes} produced a lone replacement char`);
      assert.match(body, /^zeile 0 äöü 𝄞𝄞$/m);
      assert.match(body, /zeile 199 äöü 𝄞𝄞$/m);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatLogFile reshapes a log bigger than the window and names the full output", async () => {
  const { formatLogFile } = await loadLib();
  const dir = tempDir("reshape");
  const path = join(dir, "bg003.log");
  const lines = Array.from({ length: 400 }, (_, i) => `row-${String(i).padStart(3, "0")}`);
  writeFileSync(path, `${lines.join("\n")}\n`);
  try {
    const body = formatLogFile(path, { headLines: 2, tailLines: 3, maxLines: 10, maxBytes: 200 });
    assert.match(body, /^row-000\nrow-001$/m);
    assert.match(body, /… [\d.]+[KMG]?B omitted …/);
    assert.match(body, /row-397\nrow-398\nrow-399$/m);
    assert.match(body, /Full output: .*bg003\.log/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("formatLogFile says a capped job log is not the true end of the output", async () => {
  const { formatLogFile } = await loadLib();
  const dir = tempDir("capped");
  const path = join(dir, "bg004.log");
  writeFileSync(path, Array.from({ length: 50 }, (_, i) => `capped-line-${i}`).join("\n"));
  try {
    const body = formatLogFile(path, { headLines: 2, tailLines: 2, maxLines: 10, maxBytes: 120, logTruncated: true, logBytes: 4096 });
    assert.match(body, /Log capped at 4 KB: output written after that point was not recorded\./);
    assert.match(body, /capped-line-49/, "the tail still shows the last recorded line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Freeze once per message: a growing file must not move the text the model saw
// ---------------------------------------------------------------------------

test("a frozen body survives the log growing underneath it", async () => {
  const { formatLogFile } = await loadLib();
  const { FrozenBodyCache } = await loadModule(EXT_PATH);
  const dir = tempDir("freeze");
  const path = join(dir, "bg005.log");
  writeFileSync(path, Array.from({ length: 20 }, (_, i) => `frozen-${i}`).join("\n"));
  try {
    const cache = new FrozenBodyCache(8);
    const produce = () => formatLogFile(path, { headLines: 2, tailLines: 2, maxLines: 6, maxBytes: 4000 });
    const first = cache.get("call-freeze#0", produce);
    appendFileSync(path, "\nlater-1\nlater-2");
    const second = cache.get("call-freeze#0", produce);
    assert.equal(second, first, "the second request must reuse the frozen body");
    // The file really grew: an unfrozen re-derivation would have moved the tail.
    const rederived = formatLogFile(path, { headLines: 2, tailLines: 2, maxLines: 6, maxBytes: 4000 });
    assert.notEqual(rederived, first);
    assert.equal(cache.size, 1);
    cache.clear();
    assert.equal(cache.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The extension entry point: the `context` hook
// ---------------------------------------------------------------------------

async function loadHook() {
  const factory = await loadExtension();
  const pi = fakePi();
  factory(pi.api);
  await pi.emit("session_start", {});
  return pi;
}

test("the context hook reshapes a truncated bash tool result for the model", async () => {
  const pi = await loadHook();
  assert.ok(pi.has("context"), "the extension registers a context hook");
  const { text, details } = syntheticTruncatedResult();
  const result = await pi.emit("context", { messages: [bashResult(text, details)] });
  assert.ok(result?.messages, "a rewritten message list is returned");
  const body = result.messages[0].content[0].text;
  assert.match(body, /omitted/);
  assert.match(body, /^line 000\nline 001\nline 002$/m);
  assert.match(body, /Full output: \/tmp\/pi-bash-abc\.log/);
});

test("the context hook stays out of the way when nothing needs rewriting", async () => {
  const pi = await loadHook();
  const small = await pi.emit("context", { messages: [bashResult("hello\nworld", undefined)] });
  assert.equal(small, undefined, "a clean result must not produce a new message list");
  const other = await pi.emit("context", {
    messages: [{ role: "toolResult", toolName: "read", toolCallId: "r1", content: [{ type: "text", text: "file body" }] }],
  });
  assert.equal(other, undefined);
});

test("the context hook freezes a formatted result across requests", async () => {
  const pi = await loadHook();
  const { text, details } = syntheticTruncatedResult();
  const first = await pi.emit("context", { messages: [bashResult(text, details)] });
  const second = await pi.emit("context", { messages: [bashResult(text, details)] });
  assert.equal(second.messages[0].content[0].text, first.messages[0].content[0].text);
});

test("the context hook reshapes a result pi truncated and then threw, and invents no footer", async () => {
  const pi = await loadHook();
  const windowLines = Array.from({ length: 2000 }, (_, i) => String(i + 1001));
  const text = `${windowLines.join("\n")}\n\n[Showing lines 1001-3000 of 3000. Full output: /tmp/pi-bash-thrown.log]\n\nCommand timed out after 2 seconds`;
  // pi's error path: content carries the truncated output, `details` is empty.
  const result = await pi.emit("context", { messages: [bashResult(text, {})] });
  const body = result.messages[0].content[0].text;
  assert.equal((body.match(/\[Showing lines/g) ?? []).length, 1, "exactly one footer in model-facing text");
  assert.doesNotMatch(body, /context guard/);
  assert.match(body, /Full output: \/tmp\/pi-bash-thrown\.log\]/);
  assert.ok(body.endsWith("Command timed out after 2 seconds"));
});

test("the context hook trims an oversized historical result that carries no full-output path", async () => {
  const pi = await loadHook();
  const huge = [
    "HUGE_START should be trimmed away",
    ...Array.from({ length: 700 }, (_, i) => `HUGE_LINE_${i} ${"x".repeat(200)}`),
    "HUGE_END should remain",
  ].join("\n");
  const result = await pi.emit("context", { messages: [bashResult(huge, {})] });
  const body = result.messages[0].content[0].text;
  // One owner formats, and it invents no path: there is no full-output file for
  // this result, so the body says that instead of naming a string that reads
  // like a path.
  assert.match(body, /this result was trimmed to keep the request small; no full-output file exists/);
  assert.doesNotMatch(body, /context guard/);
  assert.doesNotMatch(body, /Full output:/);
  assert.equal((body.match(/\[(Showing|output truncated)/g) ?? []).length, 1, "exactly one notice");
  assert.match(body, /HUGE_END should remain/);
  assert.doesNotMatch(body, /HUGE_START should be trimmed away/);
});
