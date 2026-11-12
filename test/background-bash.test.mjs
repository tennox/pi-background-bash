import { test } from "node:test";
import assert from "node:assert/strict";
import { createMock, createControllableBrain, script, text, toolCall } from "pi-mock";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EXT = new URL("../extensions/background-bash.ts", import.meta.url).pathname;
const OUTPUT_FORMAT_EXT = new URL("../extensions/output-format.ts", import.meta.url).pathname;
const PBB_CLI = new URL("../bin/pbb.js", import.meta.url).pathname;
const PIL_CLI = new URL("../node_modules/pi-lane/bin/pil.js", import.meta.url).pathname;
const TIMEOUT = 45_000;

const bg = (command, timeout) =>
  toolCall("bash", timeout == null ? { command, background: true } : { command, timeout, background: true });

const sh = (command, timeout) =>
  toolCall("bash", timeout == null ? { command } : { command, timeout });

const shBg = (command, timeout) =>
  toolCall("bash", timeout == null ? { command, background: true } : { command, timeout, background: true });

function requestText(req) {
  return JSON.stringify(req);
}

function messageTexts(req) {
  const out = [];
  for (const message of req.messages ?? []) {
    for (const part of message.content ?? []) {
      if (typeof part.text === "string") out.push(part.text);
      if (typeof part.content === "string") out.push(part.content);
    }
  }
  return out;
}

function backgroundResultTexts(req) {
  return messageTexts(req).filter((text) => text.includes('<pi_context source="pi-background-bash" kind="background_bash_result"'));
}

function backgroundResultText(req) {
  return backgroundResultTexts(req).at(-1) ?? "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readSessionEntries(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function createBgMock(brain, options = {}) {
  const { extensions = [], ...rest } = options;
  return createMock({
    brain,
    extensions: [EXT, ...extensions],
    startupTimeoutMs: 20_000,
    runTimeoutMs: TIMEOUT,
    ...rest,
  });
}

function makeConfiguredCwd(config) {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-cwd-${process.pid}-${Date.now()}-`));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "background-bash.json"), JSON.stringify(config));
  return dir;
}

async function waitForCondition(predicate, timeoutMs = TIMEOUT) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for condition");
}

function eventDump(events) {
	// pi >= 1.4 includes the system prompt (with this extension's own guideline
	// text) in the event stream — both as message events and inside agent_end's
	// messages array; drop system messages so negative assertions only inspect
	// conversation events.
	const strip = (event) => {
		if (event?.message?.role === "system") return { ...event, message: undefined };
		if (Array.isArray(event?.messages) && event.messages.some((m) => m?.role === "system")) {
			return { ...event, messages: event.messages.filter((m) => m?.role !== "system") };
		}
		return event;
	};
	return JSON.stringify(events.map(strip));
}

test("bash override returns normal results before the auto-background threshold", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 5 });
  const mock = await createBgMock(script(
    sh("echo foreground"),
    text("saw foreground result"),
  ), { cwd });

  try {
    const events = await mock.run("run a quick bash command", TIMEOUT);
    const all = eventDump(events);
    assert.match(all, /foreground/);
    assert.doesNotMatch(all, /moved to background/);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bash override truncates verbose foreground results before they enter model context", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 5 });
  const command = "python3 - <<'PY'\nfor i in range(10000):\n    print(f'VERBOSE_LINE_{i:05d} ' + 'x' * 80)\nPY";
  const mock = await createBgMock(script(
    sh(command),
    text("saw truncated foreground result"),
  ), { cwd });

  try {
    await mock.run("run a verbose quick bash command", TIMEOUT);
    const request = requestText(mock.requests.at(-1));
    assert.match(request, /Full output: \/.*\.log/);
    assert.match(request, /VERBOSE_LINE_09999/);
    assert.doesNotMatch(request, /VERBOSE_LINE_00000/);
    assert.ok(request.length < 180_000, `foreground result sent to the model was not capped enough (${request.length} chars)`);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a result pi truncated and then threw carries exactly one footer, naming pi's real path", async () => {
  // pi throws on a timeout/abort and the agent loop wraps the throw with
  // `details: {}` — the truncation facts are gone, only pi's notice line in the
  // text survives. The reshape must read it back instead of trimming the already
  // truncated text a second time (which used to append a second footer whose
  // "Full output:" was a sentence, not a path).
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 20 });
  const mock = await createBgMock(script(
    sh("seq 1 3000; sleep 5", 2),
    text("saw the timed-out verbose result"),
  ), { cwd, extensions: [OUTPUT_FORMAT_EXT] });

  try {
    await mock.run("run a verbose command that times out", TIMEOUT);
    // Only the conversation: the request envelope repeats the messages verbatim.
    const request = JSON.stringify(mock.requests.at(-1)?.messages ?? []);
    const footers = request.match(/\[Showing lines/g) ?? [];
    assert.equal(footers.length, 1, `expected exactly one truncation footer, got ${footers.length}`);
    assert.doesNotMatch(request, /context guard/);
    const footer = /\[Showing lines \d+-\d+ of \d+\. Full output: ([^"\\]+)\]/.exec(request);
    assert.ok(footer, "the footer must name the full-output path");
    assert.ok(existsSync(footer[1]), `the footer names a file that must exist: ${footer[1]}`);
    assert.match(request, /Command timed out after 2 seconds/, "pi's status line must survive the reshape");
    assert.match(request, /omitted/);

    // The head must be the command's own first lines (1, 2, 3), not the first
    // lines of pi's tail window (1001-1003) — the head is read from the
    // full-output file the footer names.
    const shaped = messageTexts(mock.requests.at(-1)).find((body) => body.includes("Full output:"));
    assert.ok(shaped, "the reshaped bash result must be in the request");
    assert.deepEqual(
      shaped.split("\n").slice(0, 3),
      ["1", "2", "3"],
      "the head must be the command's first lines, not the head of pi's window",
    );
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("output-format hook trims an oversized historical result that carries no full-output path", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-context-guard-${process.pid}-${Date.now()}-`));
  const sessionFile = join(dir, "session.jsonl");
  const now = new Date().toISOString();
  const toolCallId = "call_contextGuard123|fc_contextGuard456";
  const hugeResult = [
    "HUGE_CONTEXT_START should be trimmed away",
    ...Array.from({ length: 700 }, (_, i) => `HUGE_CONTEXT_LINE_${String(i).padStart(5, "0")} ${"x".repeat(80)}`),
    "HUGE_CONTEXT_END should remain",
  ].join("\n");
  const entries = [
    { type: "session", version: 3, id: "context-guard-session", timestamp: now, cwd: dir },
    {
      type: "message",
      id: "user-root",
      parentId: null,
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "run huge historical command" }], timestamp: Date.now() },
    },
    {
      type: "message",
      id: "assistant-call",
      parentId: "user-root",
      timestamp: now,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "python huge.py" } }],
        stopReason: "toolUse",
        provider: "faux",
        api: "faux",
        model: "faux",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "huge-result",
      parentId: "assistant-call",
      timestamp: now,
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "bash",
        content: [{ type: "text", text: hugeResult }],
        details: {},
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "followup-user",
      parentId: "huge-result",
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "continue after huge output" }], timestamp: Date.now() },
    },
  ];
  writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const mock = await createBgMock(script(
    text("historical tool result kept the request small"),
  ), { sessionFile, cwd: dir, extensions: [OUTPUT_FORMAT_EXT] });

  try {
    await mock.run("continue after huge historical output", TIMEOUT);
    const request = requestText(mock.requests.at(-1));
    // One owner formats: the trim comes from the output-format hook, and it never
    // invents a path — a result with no full-output file says exactly that.
    assert.match(request, /this result was trimmed to keep the request small; no full-output file exists/);
    assert.doesNotMatch(request, /context guard/);
    assert.match(request, /HUGE_CONTEXT_END should remain/);
    assert.doesNotMatch(request, /HUGE_CONTEXT_START should be trimmed away/);
    assert.ok(request.length < 180_000, `historical tool result was not capped enough (${request.length} chars)`);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash override preserves shell semantics, cwd, environment, redirects, pipes, and subshells", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 5 });
  const mock = await createBgMock(script(
    sh("printf 'env=%s cwd=%s pipe=' \"$PBB_TEST_VAR\" \"$(pwd)\"; printf hi | tr a-z A-Z; printf ' redirect='; echo redirected > out.txt; cat out.txt; printf ' subshell='; (printf sub); set -e; true"),
    text("saw shell semantics"),
  ), { cwd, env: { PBB_TEST_VAR: "env-ok" } });

  try {
    const events = await mock.run("run shell semantics characterization", TIMEOUT);
    const all = eventDump(events);
    assert.match(all, /env=env-ok/);
    assert.match(all, new RegExp(`cwd=${escapeRegExp(realpathSync(cwd))}`));
    assert.match(all, /pipe=HI/);
    assert.match(all, /redirect=redirected/);
    assert.match(all, /subshell=sub/);
    assert.equal(readFileSync(join(cwd, "out.txt"), "utf8").trim(), "redirected");
    assert.doesNotMatch(all, /moved to background/);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bash override automatically moves slow commands to background and injects final result", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 0.1 });
  const mock = await createBgMock(script(
    sh("sleep 0.3; echo auto-done"),
    text("initial turn complete"),
    text("saw auto background result"),
  ), { cwd });

  try {
    const events = await mock.run("run a slow bash command", TIMEOUT);
    const all = JSON.stringify(events);
    assert.match(all, /Bash job bg001 moved to background after 0\.1s\./);

    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /<pi_context source="pi-background-bash" kind="background_bash_result" id="bg001"/);
    assert.match(textReq, /tool_call_id="[^"]+"/);
    assert.match(textReq, /command="sleep 0\.3; echo auto-done"/);
    assert.match(textReq, /outcome="exit"/);
    assert.match(textReq, /exit_code="0"/);
    assert.match(textReq, /auto-done/);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bash background true starts immediately in background and injects final result", async () => {
  const mock = await createBgMock(script(
    shBg("sleep 0.2; echo explicit-bg-done"),
    text("initial turn complete"),
    text("saw explicit background result"),
  ));

  try {
    const events = await mock.run("run a bash command explicitly in the background", TIMEOUT);
    const all = JSON.stringify(events);
    assert.match(all, /Bash job bg001 started in background\./);
    assert.doesNotMatch(all, /moved to background after/);

    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /id="bg001"/);
    assert.match(textReq, /command="sleep 0\.2; echo explicit-bg-done"/);
    assert.match(textReq, /explicit-bg-done/);
  } finally {
    await mock.close();
  }
});

test("bash background true returns immediately, then injects completion and triggers a turn", async () => {
  const mock = await createBgMock(script(
    bg("sleep 0.1; echo done"),
    text("initial turn complete"),
    text("saw background result"),
  ));

  try {
    const events = await mock.run("start a background command", TIMEOUT);
    const all = JSON.stringify(events);
    assert.match(all, /Bash job bg001 started in background\./);

    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /<pi_context source="pi-background-bash" kind="background_bash_result" id="bg001"/);
    assert.match(textReq, /outcome="exit"/);
    assert.match(textReq, /exit_code="0"/);
    assert.match(textReq, /command="sleep 0\.1; echo done"/);
    assert.match(textReq, /done/);
    assert.match(textReq, /<\/pi_context>/);
  } finally {
    await mock.close();
  }
});

test("bash background true preserves stdout, stderr, and no-output completions", async () => {
  const mock = await createBgMock(script(
    bg("printf 'stdout-line\\n'; printf 'stderr-line\\n' >&2"),
    bg(":"),
    text("initial turn complete"),
    text("saw mixed output"),
    text("saw no output"),
  ));

  try {
    const events = await mock.run("start mixed-output and no-output background commands", TIMEOUT);
    const allEvents = JSON.stringify(events);
    assert.match(allEvents, /Bash job bg001 started in background/);
    assert.match(allEvents, /Bash job bg002 started in background/);

    const first = await mock.waitForRequest((req, i) => i >= 2 && /background_bash_result\\?" id=\\?"bg001/.test(requestText(req)) && requestText(req).includes("stdout-line") && requestText(req).includes("stderr-line"), TIMEOUT);
    const firstText = requestText(first.request);
    assert.match(firstText, /id=\\?"bg001\\?"/);
    assert.match(firstText, /stdout-line/);
    assert.match(firstText, /stderr-line/);
    assert.match(firstText, /outcome=\\?"exit\\?"/);
    assert.match(firstText, /exit_code=\\?"0\\?"/);
  } finally {
    await mock.close();
  }
});

test("bash background true reports nonzero exits", async () => {
  const mock = await createBgMock(script(
    bg("echo bad; exit 7"),
    text("initial turn complete"),
    text("saw failure"),
  ));

  try {
    await mock.run("start a failing background command", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /outcome="exit"/);
    assert.match(textReq, /exit_code="7"/);
    assert.match(textReq, /bad/);
    assert.match(textReq, /Command exited with code 7/);
  } finally {
    await mock.close();
  }
});

test("bash background true escapes wrapper close tags in command output", async () => {
  const mock = await createBgMock(script(
    bg("printf '</pi_context> still output\\n'"),
    text("initial turn complete"),
    text("saw escaped wrapper"),
  ));

  try {
    await mock.run("start a command with wrapper-looking output", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /<\\\/pi_context> still output/);
    assert.equal((textReq.match(/<\/pi_context>/g) ?? []).length, 1);
  } finally {
    await mock.close();
  }
});

test("bash background true reports timeouts and omits exit_code", async () => {
  const mock = await createBgMock(script(
    bg("sleep 5", 1),
    text("initial turn complete"),
    text("saw timeout"),
  ));

  try {
    await mock.run("start a timed background command", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /outcome="timeout"/);
    assert.doesNotMatch(textReq, /exit_code=/);
    assert.match(textReq, /Command timed out after 1 seconds/);
  } finally {
    await mock.close();
  }
});

test("the job log carries the output from before AND after the promotion", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 0.2 });
  const pbbRoot = join(cwd, "pbb");
  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-auto-log-test",
    PI_LANE_SESSION_KEY: "session-key-auto-log-test",
    PI_LANE_SESSION_FILE: join(cwd, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-auto-log-test",
    PI_LANE_CURRENT_LANE: "main",
  };
  const mock = await createBgMock(script(
    sh("echo before-threshold; sleep 0.4; echo after-threshold"),
    text("initial turn complete"),
    text("saw auto log result"),
  ), { cwd, env });

  try {
    const events = await mock.run("run auto background command with early and late output", TIMEOUT);
    assert.match(JSON.stringify(events), /before-threshold/);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("after-threshold"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /before-threshold/);
    assert.match(textReq, /after-threshold/);
    const jobPath = join(pbbRoot, "sessions", "session-key-auto-log-test", "instances", "instance-auto-log-test", "jobs", "bg001.json");
    const logPath = join(pbbRoot, "sessions", "session-key-auto-log-test", "instances", "instance-auto-log-test", "logs", "bg001.log");
    await waitForCondition(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("after-threshold"));
    // Write-through starts at spawn, so the log is the whole command output — not
    // only what arrived after the threshold (Decision 2: a real file from t0).
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /before-threshold/);
    assert.match(log, /after-threshold/);
    // ... and it stays raw: no status line, no job-id marker.
    assert.doesNotMatch(log, /Command exited/);
    assert.doesNotMatch(log, /\[pbb:/);
    const job = JSON.parse(readFileSync(jobPath, "utf8"));
    assert.equal(job.jobId, "bg001");
    assert.equal(job.runner, "pbb");
    assert.equal(typeof job.pid, "number");
    assert.equal(typeof job.pgid, "number");
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("an existing log consumes its job id, so a restarted runtime never overwrites it", async () => {
  // A foreground call leaves no job record but does leave a log, and a truncated
  // result in a transcript points at it. The allocator therefore has to count logs
  // too: reusing bg001 here would truncate that log at spawn.
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 5 });
  const pbbRoot = join(cwd, "pbb");
  const sessionKey = "session-key-reused-log-test";
  const instanceId = "instance-reused-log-test";
  const logDir = join(pbbRoot, "sessions", sessionKey, "instances", instanceId, "logs");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "bg001.log"), "stale-previous-job-output\n");

  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-reused-log-test",
    PI_LANE_SESSION_KEY: sessionKey,
    PI_LANE_SESSION_FILE: join(cwd, "session.jsonl"),
    PI_LANE_INSTANCE_ID: instanceId,
    PI_LANE_CURRENT_LANE: "main",
  };
  const mock = await createBgMock(script(
    bg("sleep 0.1; echo fresh-next-id-output"),
    text("initial turn complete"),
    text("saw fresh log result"),
  ), { cwd, env });

  try {
    const events = await mock.run("start a background command after a stale log exists", TIMEOUT);
    assert.match(JSON.stringify(events), /Bash job bg002 started in background\./);
    const nextLog = join(logDir, "bg002.log");
    await waitForCondition(() => existsSync(nextLog) && readFileSync(nextLog, "utf8").includes("fresh-next-id-output"));
    const log = readFileSync(nextLog, "utf8");
    assert.match(log, /fresh-next-id-output/);
    assert.doesNotMatch(log, /stale-previous-job-output/);
    assert.doesNotMatch(log, /\[pbb: output snapshot replaced\]/);
    // The log the transcript still references is untouched.
    assert.equal(readFileSync(join(logDir, "bg001.log"), "utf8"), "stale-previous-job-output\n");
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a restart with only foreground-call logs on disk allocates an id that collides with none of them", async () => {
  // Foreground calls consume ids but write no job record; only their logs (and the
  // transcript that points at them) remember. Deriving the floor from transcripts
  // alone re-allocated bg001 after a restart and truncated `bg001.log`.
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 5 });
  const pbbRoot = join(cwd, "pbb");
  const sessionKey = "session-key-foreground-floor-test";
  const instanceId = "instance-foreground-floor-test";
  const instanceDir = join(pbbRoot, "sessions", sessionKey, "instances", instanceId);
  const logDir = join(instanceDir, "logs");
  mkdirSync(logDir, { recursive: true });
  // Two foreground-call logs, no jobs/ directory at all.
  writeFileSync(join(logDir, "bg001.log"), "foreground-output-one\n");
  writeFileSync(join(logDir, "bg002.log"), "foreground-output-two\n");

  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-foreground-floor-test",
    PI_LANE_SESSION_KEY: sessionKey,
    PI_LANE_SESSION_FILE: join(cwd, "session.jsonl"),
    PI_LANE_INSTANCE_ID: instanceId,
    PI_LANE_CURRENT_LANE: "main",
  };
  const mock = await createBgMock(script(
    bg("echo fresh-background-output"),
    text("initial turn complete"),
    text("saw fresh background result"),
  ), { cwd, env });

  try {
    const events = await mock.run("start a background job after a restart with only foreground logs", TIMEOUT);
    assert.match(JSON.stringify(events), /Bash job bg003 started in background\./);
    const freshLog = join(logDir, "bg003.log");
    await waitForCondition(() => existsSync(freshLog) && readFileSync(freshLog, "utf8").includes("fresh-background-output"));
    // The foreground logs a transcript may still point at are untouched.
    assert.equal(readFileSync(join(logDir, "bg001.log"), "utf8"), "foreground-output-one\n");
    assert.equal(readFileSync(join(logDir, "bg002.log"), "utf8"), "foreground-output-two\n");
    const job = JSON.parse(readFileSync(join(instanceDir, "jobs", "bg003.json"), "utf8"));
    assert.equal(job.jobId, "bg003");
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});


test("bash background true uses sequential per-session job ids", async () => {
  const mock = await createBgMock(script(
    [bg("sleep 0.2; echo first"), bg("sleep 0.1; echo second")],
    text("initial turn complete"),
    text("saw one result"),
    text("saw another result"),
  ));

  try {
    const events = await mock.run("start two background commands", TIMEOUT);
    const all = JSON.stringify(events);
    assert.match(all, /Bash job bg001 started in background\./);
    assert.match(all, /Bash job bg002 started in background\./);

    const first = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const second = await mock.waitForRequest((req, i) => i > first.index && requestText(req).includes("<pi_context"), TIMEOUT);
    const both = [...backgroundResultTexts(first.request), ...backgroundResultTexts(second.request)].join("\n");
    assert.match(both, /id="bg001"/);
    assert.match(both, /id="bg002"/);
  } finally {
    await mock.close();
  }
});

test("bash background job ids continue from padded session history after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-id-restore-${process.pid}-${Date.now()}-`));
  const sessionFile = join(dir, "session.jsonl");

  const first = await createBgMock(script(
    bg("echo first-id"),
    text("first id started"),
    text("first id done"),
  ), { sessionFile });
  try {
    const events = await first.run("start first padded id job", TIMEOUT);
    assert.match(JSON.stringify(events), /Bash job bg001 started in background/);
    await first.waitForRequest((req, i) => i >= 2 && requestText(req).includes("first-id"), TIMEOUT);
  } finally {
    await first.close();
  }

  const second = await createBgMock(script(
    bg("echo second-id"),
    text("second id started"),
    text("second id done"),
  ), { sessionFile });
  try {
    const events = await second.run("start second padded id job", TIMEOUT);
    assert.match(JSON.stringify(events), /Bash job bg002 started in background/);
  } finally {
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pbb CLI defaults to current instance and requires explicit scope for other instances", () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-scope-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const base = join(pbbRoot, "sessions", "scope-key", "instances");
  mkdirSync(join(base, "current", "jobs"), { recursive: true });
  mkdirSync(join(base, "other", "jobs"), { recursive: true });
  writeFileSync(join(base, "current", "jobs", "bg001.json"), JSON.stringify({ jobId: "bg001", globalJobId: "current:bg001", status: "running", command: "current job", startedAt: new Date().toISOString(), instanceId: "current" }));
  writeFileSync(join(base, "other", "jobs", "bg001.json"), JSON.stringify({ jobId: "bg001", globalJobId: "other:bg001", status: "running", command: "other job", startedAt: new Date().toISOString(), instanceId: "other" }));

  try {
    const env = { ...process.env, PBB_ROOT: pbbRoot, PI_LANE_SESSION_KEY: "scope-key", PI_LANE_SESSION_ID: "scope-session", PI_LANE_INSTANCE_ID: "current", PI_LANE_CURRENT_LANE: "main" };
    const current = execFileSync(process.execPath, [PBB_CLI, "list"], { env, encoding: "utf8" });
    assert.match(current, /current job/);
    assert.doesNotMatch(current, /other job/);
    assert.doesNotMatch(current, /<summary>/);

    const session = execFileSync(process.execPath, [PBB_CLI, "list", "--scope", "session"], { env, encoding: "utf8" });
    assert.match(session, /current job/);
    assert.match(session, /other job/);

    assert.throws(() => execFileSync(process.execPath, [PBB_CLI, "status", "bg001", "--scope", "session"], { env, encoding: "utf8", stdio: "pipe" }), /Command failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pbb hard-fails when tracked pi-lane liveness command is unavailable", () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-pil-missing-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const base = join(pbbRoot, "sessions", "missing-pil-key", "instances", "current", "jobs");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "bg001.json"), JSON.stringify({ jobId: "bg001", globalJobId: "current:bg001", status: "running", command: "job", startedAt: new Date().toISOString(), instanceId: "current" }));

  try {
    const env = { ...process.env, PBB_PIL_BIN: join(dir, "missing-pil"), PBB_ROOT: pbbRoot, PI_LANE_SESSION_KEY: "missing-pil-key", PI_LANE_SESSION_ID: "missing-pil-session", PI_LANE_INSTANCE_ID: "current", PI_LANE_CURRENT_LANE: "main" };
    assert.throws(
      () => execFileSync(process.execPath, [PBB_CLI, "list"], { env, encoding: "utf8", stdio: "pipe" }),
      /pi_lane_unavailable/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pbb shows pi-lane owner liveness and stale status", () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-live-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const laneRoot = join(dir, "lane");
  const key = "live-key";
  const pbbBase = join(pbbRoot, "sessions", key, "instances");
  const laneBase = join(laneRoot, "sessions", key, "instances");
  mkdirSync(join(pbbBase, "current", "jobs"), { recursive: true });
  mkdirSync(join(pbbBase, "stale", "jobs"), { recursive: true });
  mkdirSync(laneBase, { recursive: true });
  writeFileSync(join(pbbBase, "current", "jobs", "bg001.json"), JSON.stringify({ jobId: "bg001", globalJobId: "current:bg001", status: "running", command: "live", startedAt: new Date().toISOString(), instanceId: "current", laneRoot }));
  writeFileSync(join(pbbBase, "stale", "jobs", "bg001.json"), JSON.stringify({ jobId: "bg001", globalJobId: "stale:bg001", status: "running", command: "stale", startedAt: new Date().toISOString(), instanceId: "stale", laneRoot }));
  writeFileSync(join(laneBase, "current.json"), JSON.stringify({ instanceId: "current", status: "idle", lastSeenAt: new Date().toISOString() }));
  writeFileSync(join(laneBase, "stale.json"), JSON.stringify({ instanceId: "stale", status: "disconnected", lastSeenAt: "2000-01-01T00:00:00.000Z" }));

  try {
    const env = { ...process.env, PBB_PIL_BIN: PIL_CLI, PBB_ROOT: pbbRoot, PI_LANE_ROOT: laneRoot, PI_LANE_SESSION_KEY: key, PI_LANE_SESSION_ID: "live-session", PI_LANE_INSTANCE_ID: "current", PI_LANE_CURRENT_LANE: "main" };
    const current = execFileSync(process.execPath, [PBB_CLI, "list"], { env, encoding: "utf8" });
    assert.match(current, /owner=live/);
    const session = execFileSync(process.execPath, [PBB_CLI, "list", "--scope", "session"], { env, encoding: "utf8" });
    assert.match(session, /owner=live/);
    assert.match(session, /owner=stale/);
    const instances = execFileSync(process.execPath, [PBB_CLI, "instances"], { env, encoding: "utf8" });
    assert.match(instances, /instance=current live=true/);
    assert.match(instances, /instance=stale live=false/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Decision 3 (todo/2026-11-11_bash-extension-choice/COMPARISON.md): the default view
// is THIS session + THIS instance. Widening is explicit, and the output says which
// scope was applied so a narrow view cannot be mistaken for "nothing running".
test("pbb scopes jobs to this session + this instance and widens only on request", () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-scopes-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const now = new Date().toISOString();
  const writeJob = (sessionKey, instanceId, jobId, command) => {
    const jobs = join(pbbRoot, "sessions", sessionKey, "instances", instanceId, "jobs");
    mkdirSync(jobs, { recursive: true });
    writeFileSync(join(jobs, `${jobId}.json`), JSON.stringify({ jobId, globalJobId: `${instanceId}:${jobId}`, status: "running", command, startedAt: now, instanceId }));
  };
  writeJob("scopes-key", "scopes-current", "bg001", "mine-only");
  writeJob("scopes-key", "scopes-sibling", "bg002", "sibling-instance");
  writeJob("other-scopes-key", "scopes-foreign", "bg003", "other-session");

  const env = { ...process.env, PBB_ROOT: pbbRoot, PI_LANE_SESSION_KEY: "scopes-key", PI_LANE_SESSION_ID: "scopes-session", PI_LANE_INSTANCE_ID: "scopes-current", PI_LANE_CURRENT_LANE: "main" };
  const run = (...args) => execFileSync(process.execPath, [PBB_CLI, ...args], { env, encoding: "utf8" });

  try {
    const current = run("list");
    assert.match(current, /mine-only/);
    assert.doesNotMatch(current, /sibling-instance/);
    assert.doesNotMatch(current, /other-session/);
    // the narrow view announces itself and how to widen it
    assert.match(current, /scope=current-instance/);
    assert.match(current, /--scope session/);
    assert.match(current, /--all/);

    const session = run("list", "--scope", "session");
    assert.match(session, /mine-only/);
    assert.match(session, /sibling-instance/);
    assert.doesNotMatch(session, /other-session/);
    assert.match(session, /scope=session/);

    for (const widening of [["list", "--all"], ["list", "--scope", "all"]]) {
      const all = run(...widening);
      assert.match(all, /mine-only/);
      assert.match(all, /sibling-instance/);
      assert.match(all, /other-session/);
      assert.match(all, /scope=all/);
      assert.doesNotMatch(all, /Widen with/);
    }

    // an out-of-scope job says "widen", not "no such job"
    assert.throws(() => execFileSync(process.execPath, [PBB_CLI, "status", "bg003"], { env, encoding: "utf8", stdio: "pipe" }), /Command failed/);
    let outOfScope = "";
    try {
      run("status", "bg003");
    } catch (error) {
      outOfScope = String(error.stderr ?? "");
    }
    assert.match(outOfScope, /unknown job bg003/);
    assert.match(outOfScope, /--all/);
    assert.match(run("status", "bg003", "--scope", "all"), /other-session/);

    // an unknown scope value is rejected instead of silently narrowing
    assert.throws(() => execFileSync(process.execPath, [PBB_CLI, "list", "--scope", "everywhere"], { env, encoding: "utf8", stdio: "pipe" }), /Command failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: a live owner used to be rendered `owner=stale status=unknown` whenever
// pi-lane had no instance record for it (the normal case on installs without pi-lane,
// where the instance id is the `pbb_<pid>_<hash>` fallback). Liveness now also reads
// the instance's own identity.json pid, and "cannot tell" is reported as unknown.
test("pbb reports a live job owner as live without a pi-lane record", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-liveness-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const key = "liveness-key";
  // a real child process stands in for the owning pi runtime; it stays alive for the
  // "live" assertion and is killed for the "dead" one
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const deadChild = spawn("sleep", ["30"], { stdio: "ignore" });
  const instanceDir = (instanceId) => join(pbbRoot, "sessions", key, "instances", instanceId);
  const liveInstance = `pbb_${child.pid}_0000aaaa`;
  const deadInstance = `pbb_${deadChild.pid}_0000bbbb`;

  try {
    for (const [instanceId, pid, jobId, command] of [[liveInstance, child.pid, "bg001", "live-owner-job"], [deadInstance, deadChild.pid, "bg002", "dead-owner-job"]]) {
      mkdirSync(join(instanceDir(instanceId), "jobs"), { recursive: true });
      writeFileSync(join(instanceDir(instanceId), "identity.json"), JSON.stringify({ instanceId, pid, sessionKey: key, updatedAt: new Date().toISOString() }));
      writeFileSync(join(instanceDir(instanceId), "jobs", `${jobId}.json`), JSON.stringify({ jobId, globalJobId: `${instanceId}:${jobId}`, status: "running", command, startedAt: new Date().toISOString(), instanceId, pid: 1, pgid: 1 }));
    }
    const deadExit = new Promise((resolve) => deadChild.once("exit", resolve));
    deadChild.kill("SIGKILL");
    await deadExit;

    const env = { ...process.env, PBB_ROOT: pbbRoot, PI_LANE_SESSION_KEY: key, PI_LANE_SESSION_ID: "liveness-session", PI_LANE_INSTANCE_ID: liveInstance, PI_LANE_CURRENT_LANE: "main" };
    const run = (...args) => execFileSync(process.execPath, [PBB_CLI, ...args], { env, encoding: "utf8" });

    const list = run("list", "--scope", "session");
    const lineFor = (text) => list.split("\n").find((line) => line.includes(text)) ?? "";
    assert.match(lineFor("live-owner-job"), /owner=live/);
    assert.doesNotMatch(lineFor("live-owner-job"), /owner=stale|owner=unknown/);
    assert.match(lineFor("dead-owner-job"), /owner=dead \(pid \d+ is gone\)/);

    const kill = run("kill", "bg001", "--scope", "session");
    assert.doesNotMatch(kill, /may not be honored/);
    assert.doesNotMatch(kill, /liveness unknown/);

    const deadKill = run("kill", "bg002", "--scope", "session");
    assert.match(deadKill, /is dead \(pid \d+ is gone\), so the cooperative kill will not be honored/);
    assert.match(deadKill, /--stale/);
  } finally {
    try { child.kill("SIGKILL"); } catch {}
    try { deadChild.kill("SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pbb status and pbb tail say the log is capped instead of promising the full output", () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-logcap-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const instanceDir = join(pbbRoot, "sessions", "logcap-key", "instances", "logcap-instance");
  const logPath = join(instanceDir, "logs", "bg001.log");
  mkdirSync(join(instanceDir, "jobs"), { recursive: true });
  mkdirSync(join(instanceDir, "logs"), { recursive: true });
  writeFileSync(logPath, "capped-output\n");
  writeFileSync(join(instanceDir, "jobs", "bg001.json"), JSON.stringify({
    jobId: "bg001",
    globalJobId: "logcap-instance:bg001",
    status: "exited",
    outcome: "exit",
    exitCode: 0,
    command: "runaway command",
    startedAt: new Date().toISOString(),
    instanceId: "logcap-instance",
    logPath,
    logTruncated: true,
    logBytes: 104857600,
    delivered: true,
  }));

  try {
    const env = {
      ...process.env,
      PBB_PIL_BIN: PIL_CLI,
      PBB_ROOT: pbbRoot,
      PI_LANE_SESSION_KEY: "logcap-key",
      PI_LANE_SESSION_ID: "logcap-session",
      PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
      PI_LANE_INSTANCE_ID: "logcap-instance",
      PI_LANE_CURRENT_LANE: "main",
    };
    // The cap is recorded in the job file only (Decision 9) — the readers have to
    // say so, otherwise a short tail silently looks like the whole output.
    const status = execFileSync(process.execPath, [PBB_CLI, "status", "bg001"], { env, encoding: "utf8" });
    assert.match(status, /log capped at 100 MB/);
    assert.match(status, /log_truncated="true"/);

    const tail = execFileSync(process.execPath, [PBB_CLI, "tail", "bg001"], { env, encoding: "utf8" });
    assert.match(tail, /log capped at 100 MB/);
    assert.match(tail, /the file does not contain the full output/);
    assert.match(tail, /capped-output/);

    // A job that did not hit the cap says nothing about one.
    const plainLog = join(instanceDir, "logs", "bg002.log");
    writeFileSync(plainLog, "plain-output\n");
    writeFileSync(
      join(instanceDir, "jobs", "bg002.json"),
      JSON.stringify({ jobId: "bg002", globalJobId: "logcap-instance:bg002", status: "exited", outcome: "exit", exitCode: 0, command: "small", startedAt: new Date().toISOString(), instanceId: "logcap-instance", logPath: plainLog, delivered: true }),
    );
    const plain = execFileSync(process.execPath, [PBB_CLI, "tail", "bg002"], { env, encoding: "utf8" });
    assert.doesNotMatch(plain, /log capped/);

    // A running job's record only holds the size it had at promotion; `pbb status`
    // reads the file instead of repeating that frozen number.
    const runningLog = join(instanceDir, "logs", "bg003.log");
    writeFileSync(runningLog, "12345678901234567890\n");
    writeFileSync(
      join(instanceDir, "jobs", "bg003.json"),
      JSON.stringify({ jobId: "bg003", globalJobId: "logcap-instance:bg003", status: "running", outcome: "running", exitCode: null, command: "slow", startedAt: new Date().toISOString(), instanceId: "logcap-instance", logPath: runningLog, logBytes: 0 }),
    );
    const running = JSON.parse(
      execFileSync(process.execPath, [PBB_CLI, "status", "bg003", "--json"], { env, encoding: "utf8" }).trim(),
    );
    assert.equal(running.job.logBytes, 21, "a running job's size comes from the log file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pbb lists and tails current pi-lane instance background jobs", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-pbb-test",
    PI_LANE_SESSION_KEY: "session-key-pbb-test",
    PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-pbb-test",
    PI_LANE_CURRENT_LANE: "main",
    PI_LANE_ROOT: join(dir, "lane"),
  };

  const mock = await createBgMock(script(
    bg("sleep 0.3; echo pbb-done"),
    sh(`node ${JSON.stringify(PBB_CLI)} list`),
    text("listed pbb job"),
    text("saw pbb result"),
  ), { env });

  try {
    const events = await mock.run("start a background command and inspect it with pbb", TIMEOUT);
    const all = JSON.stringify(events);
    assert.match(all, /source=\\?"pbb\\?"/);
    assert.match(all, /job=bg001/);
    assert.match(all, /instance-pbb-test/);

    await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("pbb-done"), TIMEOUT);
    const jobPath = join(pbbRoot, "sessions", "session-key-pbb-test", "instances", "instance-pbb-test", "jobs", "bg001.json");
    const logPath = join(pbbRoot, "sessions", "session-key-pbb-test", "instances", "instance-pbb-test", "logs", "bg001.log");
    await waitForCondition(() => existsSync(logPath) && readFileSync(logPath, "utf8").includes("pbb-done"));
    assert.equal(JSON.parse(readFileSync(jobPath, "utf8")).sessionId, "session-pbb-test");
    assert.match(readFileSync(logPath, "utf8"), /pbb-done/);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pbb kill requests abort a live current-instance background job", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-kill-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const marker = join(dir, "should-not-exist");
  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-pbb-kill-test",
    PI_LANE_SESSION_KEY: "session-key-pbb-kill-test",
    PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-pbb-kill-test",
    PI_LANE_CURRENT_LANE: "main",
  };

  // The completion message is written to the session transcript as soon as it is
  // sent, so the transcript is a stable place to read it from (a provider request
  // only exists while a turn is running).
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, "");
  const mock = await createBgMock(script(
    bg(`sleep 5; echo survived > ${JSON.stringify(marker)}`),
    sh(`node ${JSON.stringify(PBB_CLI)} kill bg001`),
    text("requested kill"),
    text("saw aborted result"),
  ), { env, sessionFile });

  try {
    const events = await mock.run("start and kill a background command", TIMEOUT);
    assert.match(JSON.stringify(events), /kill requested for bg001/);
    const jobPath = join(pbbRoot, "sessions", "session-key-pbb-kill-test", "instances", "instance-pbb-kill-test", "jobs", "bg001.json");
    const logPath = join(pbbRoot, "sessions", "session-key-pbb-kill-test", "instances", "instance-pbb-kill-test", "logs", "bg001.log");
    await waitForCondition(() => existsSync(jobPath) && JSON.parse(readFileSync(jobPath, "utf8")).outcome === "abort");
    // The log stays raw command output (Decision 9): the status line lives in the
    // completion message, never in the file `pbb tail` shows.
    assert.doesNotMatch(readFileSync(logPath, "utf8"), /Command aborted/);
    const completion = await waitForCondition(
      () => readSessionEntries(sessionFile).find((entry) => entry.type === "custom_message" && entry.details?.jobId === "bg001"),
      TIMEOUT,
    );
    assert.match(completion.content, /outcome="abort"/);
    assert.match(completion.content, /Command aborted/);
    assert.equal(existsSync(marker), false);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pbb kill honors --signal for live current-instance jobs", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-kill-signal-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const marker = join(dir, "should-not-exist");
  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-pbb-kill-signal-test",
    PI_LANE_SESSION_KEY: "session-key-pbb-kill-signal-test",
    PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-pbb-kill-signal-test",
    PI_LANE_CURRENT_LANE: "main",
  };

  const mock = await createBgMock(script(
    bg(`bash -c 'trap "" TERM; sleep 5; echo survived > ${JSON.stringify(marker)}'`),
    sh(`node ${JSON.stringify(PBB_CLI)} kill bg001 --signal KILL`),
    text("requested kill signal"),
    text("saw signal abort"),
  ), { env });

  try {
    const events = await mock.run("start and kill a signal-resistant background command", TIMEOUT);
    assert.match(JSON.stringify(events), /kill requested for bg001/);
    const jobPath = join(pbbRoot, "sessions", "session-key-pbb-kill-signal-test", "instances", "instance-pbb-kill-signal-test", "jobs", "bg001.json");
    await waitForCondition(() => existsSync(jobPath) && JSON.parse(readFileSync(jobPath, "utf8")).outcome === "abort");
    const job = JSON.parse(readFileSync(jobPath, "utf8"));
    assert.equal(job.killSignal, "SIGKILL");
    // The kill request is part of the finished record (PLAN §6): the completion
    // write used to wipe it.
    assert.match(String(job.killRequestedAt), /^\d{4}-\d{2}-\d{2}T/, "killRequestedAt must survive the completion write");
    assert.equal(existsSync(marker), false);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default PBB runner preserves shell semantics, cwd, env, stdout, stderr, and nonzero style", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 5 });
  const pbbRoot = join(cwd, "pbb");
  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-pbb-runner-semantics",
    PI_LANE_SESSION_KEY: "session-key-pbb-runner-semantics",
    PI_LANE_SESSION_FILE: join(cwd, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-pbb-runner-semantics",
    PI_LANE_CURRENT_LANE: "main",
    PBB_TEST_VAR: "runner-env-ok",
  };
  const mock = await createBgMock(script(
    bg("printf 'env=%s cwd=%s pipe=' \"$PBB_TEST_VAR\" \"$(pwd)\"; printf hi | tr a-z A-Z; printf ' err-line\\n' >&2; echo redirected > out.txt; cat out.txt; exit 9"),
    text("initial runner semantics turn"),
    text("saw runner semantics result"),
  ), { cwd, env });

  try {
    await mock.run("start pbb runner shell semantics command", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("runner-env-ok"), TIMEOUT);
    const result = requestText(request);
    assert.match(result, /env=runner-env-ok/);
    assert.match(result, new RegExp(`cwd=${escapeRegExp(realpathSync(cwd))}`));
    assert.match(result, /pipe=HI/);
    assert.match(result, /err-line/);
    assert.match(result, /redirected/);
    assert.match(result, /Command exited with code 9/);
    assert.match(result, /exit_code=\\?"9\\?"/);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("auto-background timeout kills process group descendants", async () => {
  const cwd = makeConfiguredCwd({ autoBackgroundAfterSeconds: 0.1 });
  const marker = join(cwd, "should-not-exist");
  const env = {
    PBB_ROOT: join(cwd, "pbb"),
    PI_LANE_SESSION_ID: "session-auto-timeout",
    PI_LANE_SESSION_KEY: "session-key-auto-timeout",
    PI_LANE_SESSION_FILE: join(cwd, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-auto-timeout",
    PI_LANE_CURRENT_LANE: "main",
  };
  const mock = await createBgMock(script(
    sh(`sh -c 'sleep 2; echo survived > ${JSON.stringify(marker)}'`, 1),
    text("initial auto timeout turn"),
    text("saw auto timeout result"),
  ), { cwd, env });

  try {
    const events = await mock.run("auto-background and timeout a descendant command", TIMEOUT);
    assert.match(JSON.stringify(events), /Bash job bg001 moved to background after 0\.1s\./);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("Command timed out after 1 seconds"), TIMEOUT);
    assert.match(requestText(request), /outcome=\\?"timeout\\?"/);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(existsSync(marker), false);
  } finally {
    await mock.close();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("default PBB runner preserves timeout style and kills process group descendants", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-runner-timeout-${process.pid}-${Date.now()}-`));
  const marker = join(dir, "should-not-exist");
  const env = {
    PBB_ROOT: join(dir, "pbb"),
    PI_LANE_SESSION_ID: "session-pbb-runner-timeout",
    PI_LANE_SESSION_KEY: "session-key-pbb-runner-timeout",
    PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-pbb-runner-timeout",
    PI_LANE_CURRENT_LANE: "main",
  };
  const mock = await createBgMock(script(
    bg(`sh -c 'sleep 2; echo survived > ${JSON.stringify(marker)}'`, 1),
    text("initial runner timeout turn"),
    text("saw runner timeout result"),
  ), { env });

  try {
    await mock.run("start pbb runner timed command", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("Command timed out after 1 seconds"), TIMEOUT);
    const result = requestText(request);
    assert.match(result, /outcome=\\?"timeout\\?"/);
    assert.doesNotMatch(result, /exit_code=/);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(existsSync(marker), false);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default PBB runner session shutdown kills process group descendants", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-runner-shutdown-${process.pid}-${Date.now()}-`));
  const marker = join(dir, "should-not-exist");
  const env = {
    PBB_ROOT: join(dir, "pbb"),
    PI_LANE_SESSION_ID: "session-pbb-runner-shutdown",
    PI_LANE_SESSION_KEY: "session-key-pbb-runner-shutdown",
    PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-pbb-runner-shutdown",
    PI_LANE_CURRENT_LANE: "main",
  };
  const mock = await createBgMock(script(
    bg(`sh -c 'sleep 2; echo survived > ${JSON.stringify(marker)}'`),
    text("started runner shutdown job"),
  ), { env });

  try {
    await mock.run("start pbb runner long command", TIMEOUT);
  } finally {
    await mock.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(existsSync(marker), false);
  rmSync(dir, { recursive: true, force: true });
});

test("default PBB runner records pid/pgid and pbb kill terminates the process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-runner-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const marker = join(dir, "should-not-exist");
  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-pbb-runner-test",
    PI_LANE_SESSION_KEY: "session-key-pbb-runner-test",
    PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-pbb-runner-test",
    PI_LANE_CURRENT_LANE: "main",
  };

  const mock = await createBgMock(script(
    bg(`sh -c 'sleep 5; echo survived > ${JSON.stringify(marker)}'`),
    sh(`node ${JSON.stringify(PBB_CLI)} kill bg001`),
    text("requested runner kill"),
    text("saw runner abort"),
  ), { env });

  try {
    const events = await mock.run("start and kill a pbb-runner background command", TIMEOUT);
    assert.match(JSON.stringify(events), /kill requested for bg001/);
    const jobPath = join(pbbRoot, "sessions", "session-key-pbb-runner-test", "instances", "instance-pbb-runner-test", "jobs", "bg001.json");
    await waitForCondition(() => existsSync(jobPath) && JSON.parse(readFileSync(jobPath, "utf8")).outcome === "abort");
    const job = JSON.parse(readFileSync(jobPath, "utf8"));
    assert.equal(job.runner, "pbb");
    assert.equal(typeof job.pid, "number");
    assert.equal(typeof job.pgid, "number");
    assert.equal(existsSync(marker), false);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pbb kill --stale can signal a recorded stale process group", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-stale-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const marker = join(dir, "should-not-exist");
  const key = "stale-kill-key";
  const instance = "stale-owner";
  const jobDir = join(pbbRoot, "sessions", key, "instances", instance, "jobs");
  mkdirSync(jobDir, { recursive: true });
  const child = spawn("bash", ["-lc", `sleep 5; echo survived > ${JSON.stringify(marker)}`], { detached: true, stdio: "ignore" });
  child.unref();

  try {
    writeFileSync(join(jobDir, "bg999.json"), JSON.stringify({ jobId: "bg999", globalJobId: `${instance}:bg999`, status: "running", command: "stale", startedAt: new Date().toISOString(), instanceId: instance, runner: "pbb", pid: child.pid, pgid: child.pid }));
    const env = { ...process.env, PBB_ROOT: pbbRoot, PI_LANE_SESSION_KEY: key, PI_LANE_SESSION_ID: "stale-session", PI_LANE_INSTANCE_ID: "current" };
    const out = execFileSync(process.execPath, [PBB_CLI, "kill", "bg999", "--instance", instance, "--stale"], { env, encoding: "utf8" });
    assert.match(out, /stale process-group kill sent/);
    await waitForCondition(() => {
      try {
        process.kill(child.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5_000);
    assert.equal(existsSync(marker), false);
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session start repairs detached background bash tool results before replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-repair-${process.pid}-${Date.now()}-`));
  const sessionFile = join(dir, "session.jsonl");
  const now = new Date().toISOString();
  const toolCallId = "call_pbbRepair123|fc_pbbRepair456";
  const entries = [
    { type: "session", version: 3, id: "repair-session", timestamp: now, cwd: dir },
    {
      type: "message",
      id: "user-root",
      parentId: null,
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "start background command" }], timestamp: Date.now() },
    },
    {
      type: "message",
      id: "assistant-call",
      parentId: "user-root",
      timestamp: now,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: toolCallId, name: "bash", arguments: { command: "sleep 60" } }],
        stopReason: "toolUse",
        provider: "faux",
        api: "faux",
        model: "faux",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "detached-result",
      parentId: null,
      timestamp: now,
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "bash",
        content: [{ type: "text", text: "Bash job bg001 moved to background after 30s." }],
        details: { jobId: "bg001", command: "sleep 60", outcome: "running", exitCode: null, toolCallId },
        timestamp: Date.now(),
      },
    },
    {
      type: "message",
      id: "followup-user",
      parentId: "detached-result",
      timestamp: now,
      message: { role: "user", content: [{ type: "text", text: "continue after background" }], timestamp: Date.now() },
    },
  ];
  writeFileSync(sessionFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const mock = await createBgMock(script(
    text("repaired detached background result"),
  ), { sessionFile, cwd: dir });

  try {
    await mock.run("continue after repair", TIMEOUT);
    const repaired = readSessionEntries(sessionFile).find((entry) => entry.id === "detached-result");
    assert.equal(repaired.parentId, "assistant-call");
    const request = requestText(mock.requests.at(-1));
    // pi >= 1.4 sanitizes "|" in tool call ids when serializing requests.
    const normalizedToolCallId = toolCallId.replace(/\|/g, "_");
    assert.ok(
      request.includes(toolCallId) || request.includes(normalizedToolCallId),
      "expected repaired tool call id to remain in model context",
    );
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash background completion steers into the next in-run provider request", async () => {
  const cb = createControllableBrain();
  const mock = await createBgMock(cb.brain);

  try {
    await mock.prompt("start a short background command");
    const startCall = await cb.waitForCall(TIMEOUT);
    startCall.respond(bg("sleep 0.2; echo race-done"));

    const startContinuation = await cb.waitForCall(TIMEOUT);
    startContinuation.respond(text("background command started"));
    await mock.waitFor((event) => event.type === "agent_end" && JSON.stringify(event).includes("background command started"), TIMEOUT);

    await mock.prompt("do unrelated multi-step work while the background command finishes");
    const unrelatedCall = await cb.waitForCall(TIMEOUT);

    // The background job finishes while the unrelated provider request above is
    // still pending. Regression guard: steering must not start a second,
    // concurrent provider request from a busy context.
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(cb.pending().length, 0, "background result should not trigger a concurrent provider call while another call is in flight");

    unrelatedCall.respond(sh("echo step-one"));
    // Same run, next turn: the completed background result is already in context.
    const nextTurnCall = await cb.waitForCall((req) => requestText(req).includes("step-one"), TIMEOUT);
    assert.match(backgroundResultText(nextTurnCall.request), /race-done/);

    nextTurnCall.respond(text("unrelated work done"));
    await mock.waitFor((event) => event.type === "agent_end" && JSON.stringify(event).includes("unrelated work done"), TIMEOUT);
  } finally {
    await mock.close();
  }
});

test("bash background true records provenance even when session parentId points at current head", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-session-${process.pid}-${Date.now()}-`));
  const sessionFile = join(dir, "session.jsonl");
  writeFileSync(sessionFile, "");

  const mock = await createBgMock(script(
    bg("sleep 1.5; echo provenance-done", 10),
    text("started background job"),
    text("unrelated turn complete"),
    text("saw provenance result"),
  ), { sessionFile });

  try {
    const initialEvents = await mock.run("start a slow background command", TIMEOUT);
    const startEvent = initialEvents.find((event) => event.type === "tool_execution_start" && event.toolName === "bash");
    assert.ok(startEvent, "expected bash tool_execution_start event");
    const toolCallId = startEvent.toolCallId;

    const startResultEvent = initialEvents.find((event) => event.type === "tool_execution_end" && event.toolName === "bash");
    assert.ok(startResultEvent, "expected bash tool_execution_end event");
    assert.equal(startResultEvent.result.details.toolCallId, toolCallId);
    assert.match(startResultEvent.result.details.startedAt, /^\d{4}-\d{2}-\d{2}T/);

    await mock.prompt("do unrelated work while the background command runs", TIMEOUT);
    await mock.waitFor((event) => event.type === "agent_end" && JSON.stringify(event).includes("saw provenance result"), TIMEOUT);

    const entries = readSessionEntries(sessionFile);
    const toolCallEntry = entries.find((entry) =>
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      entry.message.content?.some((part) => part.type === "toolCall" && part.name === "bash" && part.id === toolCallId)
    );
    assert.ok(toolCallEntry, "expected original bash assistant tool call in session JSONL");

    const toolResultEntry = entries.find((entry) =>
      entry.type === "message" &&
      entry.message?.role === "toolResult" &&
      entry.message.toolName === "bash" &&
      entry.message.details?.toolCallId === toolCallId
    );
    assert.ok(toolResultEntry, "expected start tool result details to include original toolCallId");

    const unrelatedAssistantEntry = entries.find((entry) =>
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      entry.message.content?.some((part) => part.type === "text" && part.text === "unrelated turn complete")
    );
    assert.ok(unrelatedAssistantEntry, "expected unrelated assistant turn in session JSONL");

    const customEntry = entries.find((entry) =>
      entry.type === "custom_message" &&
      entry.customType === "background_bash_result" &&
      entry.details?.jobId === "bg001"
    );
    assert.ok(customEntry, "expected background_bash_result custom message in session JSONL");

    // Pi appends follow-up custom messages to the current session head. The raw
    // parentId can therefore point at unrelated work; provenance must come from
    // stable metadata on the result itself, not from parentId adjacency.
    assert.equal(customEntry.parentId, unrelatedAssistantEntry.id);
    assert.notEqual(customEntry.parentId, toolResultEntry.id);

    assert.equal(customEntry.details.toolCallId, toolCallId);
    assert.equal(customEntry.details.startedAt, toolResultEntry.message.details.startedAt);
    assert.match(customEntry.content, new RegExp(`tool_call_id="${escapeRegExp(toolCallId)}"`));
    assert.match(customEntry.content, /started_at="\d{4}-\d{2}-\d{2}T[^"]+"/);
    assert.match(customEntry.content, /id="bg001"/);

    const sessionText = readFileSync(sessionFile, "utf8");
    const occurrences = sessionText.match(new RegExp(escapeRegExp(toolCallId), "g")) ?? [];
    assert.ok(occurrences.length >= 3, "original toolCallId should grep across initiation, start result, and completion result");
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash background true kills active jobs when the session closes", async () => {
  const marker = join(tmpdir(), `pi-background-bash-survived-${process.pid}-${Date.now()}`);
  rmSync(marker, { force: true });
  const mock = await createBgMock(script(
    bg(`sleep 2; echo survived > ${JSON.stringify(marker)}`),
    text("initial turn complete"),
  ));

  try {
    await mock.run("start a long background command", TIMEOUT);
  } finally {
    await mock.close();
  }

  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(existsSync(marker), false, "background job should be killed on session close");
});

test("bash background true truncates verbose PBB results and pbb tail --full returns complete output", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-truncate-${process.pid}-${Date.now()}-`));
  const pbbRoot = join(dir, "pbb");
  const env = {
    PBB_ROOT: pbbRoot,
    PI_LANE_SESSION_ID: "session-truncate-test",
    PI_LANE_SESSION_KEY: "session-key-truncate-test",
    PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-truncate-test",
    PI_LANE_CURRENT_LANE: "main",
  };
  const mock = await createBgMock(script(
    bg("python3 - <<'PY'\nfor i in range(2105): print(f'line {i}')\nPY"),
    text("initial turn complete"),
    text("saw truncated result"),
  ), { env });

  try {
    await mock.run("start a verbose background command", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /Showing lines \d+-\d+ of \d+\. Full output: pbb tail bg001 --full/);
    assert.match(textReq, /line 2104/);
    assert.doesNotMatch(textReq, /line 0\nline 1\nline 2/);

    const tail = execFileSync(process.execPath, [PBB_CLI, "tail", "bg001", "--full"], { env: { ...process.env, ...env }, encoding: "utf8" });
    assert.match(tail, /line 0/);
    assert.match(tail, /line 2104/);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Multi-session ownership, close-hang, and reconcile-sweep regressions
//
// pi caches the extension factory per cwd (loadExtensionsCached), so ONE loaded
// module serves every session in a pi process. The in-process tests below load
// the extension once and invoke the factory twice — exactly what pi does for a
// sibling session — which is the only way to exercise that sharing without
// spawning two pi processes (each of which would get its own module instance).
// ---------------------------------------------------------------------------

const EXTENSION_PATH = new URL("../extensions/background-bash.ts", import.meta.url).pathname;

async function loadExtensionFactory() {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: true });
  const factory = await jiti.import(EXTENSION_PATH, { default: true });
  assert.equal(typeof factory, "function");
  return factory;
}

function pbbKeyFor(sessionFile, sessionId) {
  return createHash("sha256").update(`${sessionId ?? "no-session-id"}\n${sessionFile}`).digest("hex").slice(0, 24);
}

function createFakeSession({ cwd, sessionId, sessionFile }) {
  const handlers = new Map();
  const messages = [];
  const tools = new Map();
  const entries = [];
  const api = {
    registerMessageRenderer() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    sendMessage(message, options) {
      messages.push({ message, options });
    },
  };
  const ctx = {
    cwd,
    hasUI: false,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => sessionFile,
      getEntries: () => entries,
    },
  };
  return {
    api,
    ctx,
    entries,
    messages,
    tools,
    bash: () => tools.get("bash"),
    async emit(event, payload = {}) {
      for (const handler of handlers.get(event) ?? []) await handler({ type: event, ...payload }, ctx);
    },
  };
}

async function withTemporaryPbbRoot(dir, fn) {
  const previous = process.env.PBB_ROOT;
  process.env.PBB_ROOT = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PBB_ROOT;
    else process.env.PBB_ROOT = previous;
  }
}

async function deadPid() {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", () => resolve(child.pid));
  });
}

test("a sibling session shutdown does not drop another session's completion", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-sibling-${process.pid}-${Date.now()}-`));
  const root = join(dir, "pbb");
  const factory = await loadExtensionFactory();
  const sessionA = createFakeSession({ cwd: dir, sessionId: "session-a", sessionFile: join(dir, "a.jsonl") });
  const sessionB = createFakeSession({ cwd: dir, sessionId: "session-b", sessionFile: join(dir, "b.jsonl") });

  await withTemporaryPbbRoot(root, async () => {
    try {
      factory(sessionA.api);
      factory(sessionB.api);
      await sessionA.emit("session_start");
      await sessionB.emit("session_start");

      const started = await sessionA.bash().execute(
        "call-sibling-a",
        { command: "sleep 0.4; echo sibling-safe", background: true },
        undefined,
        undefined,
        sessionA.ctx,
      );
      assert.match(JSON.stringify(started.content), /Bash job bg001 started in background/);

      // A sibling session ending used to abort every session's jobs and drop their
      // completions (shared module-level `activeJobs` + `shuttingDown`).
      await sessionB.emit("session_shutdown", { reason: "new" });

      await waitForCondition(() => sessionA.messages.length > 0, 15_000);
      assert.equal(sessionB.messages.length, 0, "sibling session must not receive another session's result");

      const delivered = sessionA.messages.at(-1).message;
      assert.match(delivered.content, /id="bg001"/);
      assert.match(delivered.content, /outcome="exit"/);
      assert.match(delivered.content, /sibling-safe/);

      // The job file must carry the real outcome even when the session was busy.
      const details = delivered.details;
      const jobPath = join(root, "sessions", details.sessionKey, "instances", details.instanceId, "jobs", "bg001.json");
      const job = JSON.parse(readFileSync(jobPath, "utf8"));
      assert.equal(job.status, "exited");
      assert.equal(job.outcome, "exit");
      assert.equal(job.delivered, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("completion arrives when a descendant inherits the command's stdout", async () => {
  // `sleep 30 &` keeps the inherited stdout/stderr write ends open long after bash
  // exits, so Node never emits `close`. Completion must fire on `exit` plus the
  // idle grace, not after the descendant finishes.
  const mock = await createBgMock(script(
    bg("sleep 30 & echo descendant-started"),
    text("initial turn complete"),
    text("saw descendant-started result"),
  ));

  try {
    const events = await mock.run("start a command whose descendant holds stdout", TIMEOUT);
    assert.match(JSON.stringify(events), /Bash job bg001 started in background/);

    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("<pi_context"), 10_000);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /id="bg001"/);
    assert.match(textReq, /outcome="exit"/);
    assert.match(textReq, /exit_code="0"/);
    assert.match(textReq, /descendant-started/);
  } finally {
    await mock.close();
  }
});

test("startup sweep re-delivers an undelivered completion exactly once and records lost jobs honestly", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-reconcile-${process.pid}-${Date.now()}-`));
  const root = join(dir, "pbb");
  const sessionId = "sweep-session";
  const sessionFile = join(dir, "sweep.jsonl");
  const sessionKey = pbbKeyFor(sessionFile, sessionId);
  const instanceId = "dead-instance";
  const instanceDir = join(root, "sessions", sessionKey, "instances", instanceId);
  const jobsDir = join(instanceDir, "jobs");
  const logsDir = join(instanceDir, "logs");
  mkdirSync(jobsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  const completedAt = new Date().toISOString();
  const completedJob = {
    schemaVersion: 1,
    jobId: "bg007",
    globalJobId: `${instanceId}:bg007`,
    command: "bun test",
    status: "exited",
    outcome: "exit",
    exitCode: 0,
    startedAt: completedAt,
    completedAt,
    durationMs: 1234,
    sessionId,
    sessionKey,
    instanceId,
    delivered: false,
    logPath: join(logsDir, "bg007.log"),
  };
  writeFileSync(join(jobsDir, "bg007.json"), JSON.stringify(completedJob));
  writeFileSync(join(logsDir, "bg007.log"), "\u001b]0;window title\u0007progress 10%\rprogress 100%\nSWEEP_LOG_TAIL all tests passed\n");

  const gonePid = await deadPid();
  const stuckJob = {
    schemaVersion: 1,
    jobId: "bg008",
    globalJobId: `${instanceId}:bg008`,
    command: "sleep 600",
    status: "running",
    outcome: "running",
    exitCode: null,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    sessionId,
    sessionKey,
    instanceId,
    pid: gonePid,
    pgid: gonePid,
    logPath: join(logsDir, "bg008.log"),
  };
  writeFileSync(join(jobsDir, "bg008.json"), JSON.stringify(stuckJob));
  writeFileSync(join(logsDir, "bg008.log"), "STUCK_JOB_TAIL waiting for input\n");

  const factory = await loadExtensionFactory();
  const session = createFakeSession({ cwd: dir, sessionId, sessionFile });
  // A job's *start* tool result also carries details.jobId (nested under
  // message.details). That must not count as "already delivered", or the sweep
  // would skip every job the session had started before it went down.
  session.entries.push({
    type: "message",
    id: "start-result-bg007",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId: "call-7",
      toolName: "bash",
      content: [{ type: "text", text: "Bash job bg007 started in background." }],
      details: { jobId: "bg007", command: "bun test", outcome: "running", exitCode: null, toolCallId: "call-7" },
    },
  });

  await withTemporaryPbbRoot(root, async () => {
    try {
      factory(session.api);
      await session.emit("session_start");
      await waitForCondition(() => session.messages.length > 0, 10_000);

      // One coalesced message for both jobs, not one message (and one forced turn) each.
      assert.equal(session.messages.length, 1);
      const content = session.messages[0].message.content;
      assert.match(content, /kind="background_bash_digest"/);
      assert.match(content, /\[bg007\] outcome=exit exit_code=0/);
      assert.match(content, /SWEEP_LOG_TAIL/);
      // A digest body is built from raw log tails, so it needs the same
      // presentation pass as a completion body: no `ESC]0;…` title sequence and
      // no `\r` progress frames in the text the model reads.
      assert.doesNotMatch(content, /\u001b/, "no escape sequence may reach the model");
      assert.doesNotMatch(content, /\r/, "no carriage return may reach the model");
      assert.match(content, /progress 100%/, "the last \\r frame survives");
      assert.match(content, /bun test/);
      assert.match(content, /\[bg008\] outcome=lost/);
      assert.match(content, /STUCK_JOB_TAIL/);

      const deliveredJob = JSON.parse(readFileSync(join(jobsDir, "bg007.json"), "utf8"));
      assert.equal(deliveredJob.status, "exited");
      assert.equal(deliveredJob.outcome, "exit");
      assert.equal(deliveredJob.delivered, true);
      assert.equal(deliveredJob.deliveredReason, "reconcile");

      // Never fabricate an exit for a job whose owner died: record the real state.
      const lostJob = JSON.parse(readFileSync(join(jobsDir, "bg008.json"), "utf8"));
      assert.equal(lostJob.status, "lost");
      assert.equal(lostJob.outcome, "lost");
      assert.equal(lostJob.exitCode, null);
      assert.equal(lostJob.delivered, true);

      const events = readFileSync(join(instanceDir, "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(events.some((event) => event.type === "job.lost" && event.jobId === "bg008"));
      assert.ok(events.every((event) => !(event.type === "job.completed" && event.jobId === "bg008")));

      // A later session start (resume) must not re-deliver anything.
      await session.emit("session_start");
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(session.messages.length, 1, "reconcile must re-deliver exactly once");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("reconcile ignores jobs recorded for another session key", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-reconcile-scope-${process.pid}-${Date.now()}-`));
  const root = join(dir, "pbb");
  const sessionId = "own-session";
  const sessionFile = join(dir, "own.jsonl");
  const sessionKey = pbbKeyFor(sessionFile, sessionId);
  // A job physically inside our session directory but stamped with another key.
  const jobsDir = join(root, "sessions", sessionKey, "instances", "foreign", "jobs");
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(join(jobsDir, "bg001.json"), JSON.stringify({
    schemaVersion: 1,
    jobId: "bg001",
    command: "FOREIGN_SESSION_JOB",
    status: "exited",
    outcome: "exit",
    exitCode: 0,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    sessionId: "other-session",
    sessionKey: "other-key",
    instanceId: "foreign",
    delivered: false,
  }));

  const factory = await loadExtensionFactory();
  const session = createFakeSession({ cwd: dir, sessionId, sessionFile });

  await withTemporaryPbbRoot(root, async () => {
    try {
      factory(session.api);
      await session.emit("session_start");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(session.messages.length, 0, "results must never cross session keys");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("pbb is on PATH inside bash commands and reports the owning session", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-path-${process.pid}-${Date.now()}-`));
  const env = {
    PBB_ROOT: join(dir, "pbb"),
    PI_LANE_SESSION_ID: "session-path-test",
    PI_LANE_SESSION_KEY: "session-key-path-test",
    PI_LANE_SESSION_FILE: join(dir, "session.jsonl"),
    PI_LANE_INSTANCE_ID: "instance-path-test",
    PI_LANE_CURRENT_LANE: "main",
  };
  const mock = await createBgMock(script(
    bg("command -v pbb >/dev/null && pbb self"),
    text("initial turn complete"),
    text("saw pbb self"),
  ), { cwd: dir, env });

  try {
    await mock.run("check pbb availability inside bash", TIMEOUT);
    const { request } = await mock.waitForRequest((req, i) => i >= 2 && requestText(req).includes("pbb.self"), TIMEOUT);
    const textReq = backgroundResultText(request);
    assert.match(textReq, /outcome="exit"/);
    assert.match(textReq, /exit_code="0"/);
    assert.match(textReq, /session-key-path-test/);
  } finally {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcile does not re-deliver a completion the transcript already carries", async () => {
  // Upgrade path: files written by the pre-fix build have no `delivered` field, so
  // the sweep must trust the transcript instead of replaying seen results.
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-reconcile-seen-${process.pid}-${Date.now()}-`));
  const root = join(dir, "pbb");
  const sessionId = "seen-session";
  const sessionFile = join(dir, "seen.jsonl");
  const sessionKey = pbbKeyFor(sessionFile, sessionId);
  const jobsDir = join(root, "sessions", sessionKey, "instances", "legacy", "jobs");
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(join(jobsDir, "bg004.json"), JSON.stringify({
    schemaVersion: 1,
    jobId: "bg004",
    command: "make build",
    status: "exited",
    outcome: "exit",
    exitCode: 0,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    sessionId,
    sessionKey,
    instanceId: "legacy",
  }));

  const factory = await loadExtensionFactory();
  const session = createFakeSession({ cwd: dir, sessionId, sessionFile });
  session.entries.push({
    type: "custom_message",
    id: "already-delivered-bg004",
    parentId: null,
    customType: "background_bash_result",
    content: '<pi_context source="pi-background-bash" kind="background_bash_result" id="bg004" outcome="exit" exit_code="0">ok</pi_context>',
    details: { jobId: "bg004", command: "make build", outcome: "exit", exitCode: 0 },
  });

  await withTemporaryPbbRoot(root, async () => {
    try {
      factory(session.api);
      await session.emit("session_start");
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(session.messages.length, 0, "an already-delivered completion must not be re-delivered");
      const job = JSON.parse(readFileSync(join(jobsDir, "bg004.json"), "utf8"));
      assert.equal(job.delivered, true);
      assert.equal(job.deliveredReason, "already_in_session_history");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The exec seam: promotion and the foreground full-output path
//
// These drive the registered tool directly through a fake session, so the tool
// call's own timing and its `details`/`structuredContent` are observable —
// pi-mock only sees the model-facing text.
// ---------------------------------------------------------------------------

function configuredCwd(seconds, extraConfig = {}) {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-seam-${process.pid}-${Date.now()}-`));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "background-bash.json"), JSON.stringify({ autoBackgroundAfterSeconds: seconds, ...extraConfig }));
  return dir;
}

function logFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith(".log"))
    .map((entry) => entry.split("/").pop())
    .sort();
}

function resultText(result) {
  return result.content.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");
}

test("promotion answers just after the threshold and the same job id reaches result, job file and completion", async () => {
  const dir = configuredCwd(0.3);
  const root = join(dir, "pbb");
  const factory = await loadExtensionFactory();
  const session = createFakeSession({ cwd: dir, sessionId: "promote-session", sessionFile: join(dir, "promote.jsonl") });

  await withTemporaryPbbRoot(root, async () => {
    try {
      factory(session.api);
      await session.emit("session_start");

      const startedAt = Date.now();
      const result = await session.bash().execute(
        "call-promote",
        { command: "echo pre-promotion; sleep 1.5; echo post-promotion" },
        undefined,
        undefined,
        session.ctx,
      );
      const elapsed = Date.now() - startedAt;

      // 0.3 s threshold: answering much earlier would mean the call never really
      // ran; answering much later would mean the promotion path stalls the turn.
      assert.ok(elapsed >= 250, `promotion answered before the threshold (${elapsed} ms)`);
      assert.ok(elapsed < 1300, `promotion answered ${elapsed} ms into a 300 ms threshold`);

      const text = resultText(result);
      assert.match(text, /Bash job bg001 moved to background after 0\.3s\./);
      const details = result.details;
      assert.equal(details.jobId, "bg001");
      assert.equal(details.outcome, "running");
      // Honest structured content: the job is running, so there is no exit code,
      // and the full-output path is the job log (not pi's temp file).
      assert.equal(result.structuredContent.job_id, "bg001");
      assert.equal(result.structuredContent.exit_code, undefined);
      assert.match(String(result.structuredContent.full_output_path), /bg001\.log$/);
      // Flush before resolve: what the command wrote before the threshold is in
      // the answer's structured output, not lost at promotion.
      assert.match(String(result.structuredContent.output), /pre-promotion/);

      const jobPath = join(root, "sessions", details.sessionKey, "instances", details.instanceId, "jobs", "bg001.json");
      await waitForCondition(() => existsSync(jobPath), 5_000);
      const runningJob = JSON.parse(readFileSync(jobPath, "utf8"));
      assert.equal(runningJob.jobId, "bg001");
      assert.equal(runningJob.status, "running");
      assert.equal(runningJob.promotionThresholdSeconds, 0.3);
      assert.match(String(runningJob.promotedAt), /^\d{4}-\d{2}-\d{2}T/);

      await waitForCondition(() => session.messages.length > 0, 15_000);
      const completion = session.messages.at(-1).message;
      assert.match(completion.content, /id="bg001"/);
      assert.equal(completion.details.jobId, "bg001");
      assert.match(completion.content, /post-promotion/);

      const finishedJob = JSON.parse(readFileSync(jobPath, "utf8"));
      assert.equal(finishedJob.outcome, "exit");
      assert.equal(finishedJob.exitCode, 0);
      // PLAN §6 keeps the promotion metadata: the completion write rebuilds the
      // record, so these must live on the job rather than in the promotion patch
      // (they used to be null on every finished job).
      assert.equal(finishedJob.promotedAt, runningJob.promotedAt, "promotedAt must survive the completion write");
      assert.equal(finishedJob.promotedAfterSeconds, runningJob.promotedAfterSeconds);
      assert.equal(finishedJob.promotionThresholdSeconds, 0.3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a promoted job is not killed by the run's abort signal", async () => {
  // `signal` is ONE AbortController per run, handed unchanged to every tool call
  // (agent.ts / agent-loop.ts). Leaving our listener attached would SIGTERM a job
  // the model was just told is running, on the next turn's abort.
  const dir = configuredCwd(0.2);
  const root = join(dir, "pbb");
  const marker = join(dir, "promoted-job-survived");
  const factory = await loadExtensionFactory();
  const session = createFakeSession({ cwd: dir, sessionId: "abort-promoted-session", sessionFile: join(dir, "abort.jsonl") });
  const controller = new AbortController();

  await withTemporaryPbbRoot(root, async () => {
    try {
      factory(session.api);
      await session.emit("session_start");

      const result = await session.bash().execute(
        "call-abort-after-promote",
        { command: `sleep 1; echo survived > ${JSON.stringify(marker)}` },
        controller.signal,
        undefined,
        session.ctx,
      );
      const details = result.details;
      assert.equal(details.outcome, "running", "the call must have been promoted");

      controller.abort();

      await waitForCondition(() => session.messages.length > 0, 15_000);
      const completion = session.messages.at(-1).message;
      assert.equal(completion.details.outcome, "exit");
      assert.equal(completion.details.exitCode, 0);
      await waitForCondition(() => existsSync(marker), 5_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a truncated foreground result names its job log, which holds the whole output", async () => {
  const dir = configuredCwd(30);
  const root = join(dir, "pbb");
  const factory = await loadExtensionFactory();
  const session = createFakeSession({ cwd: dir, sessionId: "foreground-full-output", sessionFile: join(dir, "fg.jsonl") });
  // 3000 lines is past pi's 2000-line window, so pi truncates and spills the rest
  // to its own temp file — which this layer replaces with the job log.
  const command =
    "awk 'BEGIN { for (i = 0; i < 3000; i++) printf \"VERBOSE_%05d %s\\n\", i, \"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\" }'";

  await withTemporaryPbbRoot(root, async () => {
    try {
      factory(session.api);
      await session.emit("session_start");

      const result = await session.bash().execute("call-verbose", { command }, undefined, undefined, session.ctx);
      const text = resultText(result);
      assert.match(text, /Showing lines \d+-\d+ of 3000/);
      assert.match(text, /Full output: \/.*bg001\.log\]/);
      assert.doesNotMatch(text, /pi-bash/, "pi's temp file must not be named any more");

      const fullOutputPath = result.details?.fullOutputPath;
      assert.equal(typeof fullOutputPath, "string");
      assert.match(fullOutputPath, /\/logs\/bg001\.log$/);
      assert.equal(result.structuredContent.full_output_path, fullOutputPath);
      // The file the model is pointed at really holds the whole output, head included.
      const full = readFileSync(fullOutputPath, "utf8");
      assert.match(full, /VERBOSE_00000/);
      assert.match(full, /VERBOSE_02999/);

      // A foreground call that was neither truncated nor promoted leaves no log.
      const logsBefore = logFiles(root);
      assert.deepEqual(logsBefore, ["bg001.log"]);
      const small = await session.bash().execute("call-small", { command: "echo tiny" }, undefined, undefined, session.ctx);
      assert.equal(small.details?.fullOutputPath, undefined);
      assert.deepEqual(logFiles(root), ["bg001.log"], "an untruncated foreground call deletes its log");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function loadExtensionModule() {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { moduleCache: false, interopDefault: false });
  return jiti.import(EXTENSION_PATH);
}

test("readLogTail returns exactly N lines when the byte window begins on a line boundary", async () => {
  const extension = await loadExtensionModule();
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-logtail-${process.pid}-${Date.now()}-`));
  const path = join(dir, "bg001.log");
  // Four 7-byte lines ("line-N\n"); the last three are exactly 21 bytes.
  const content = "line-0\nline-1\nline-2\nline-3\n";
  writeFileSync(path, content);
  try {
    // start = 7, i.e. the first byte of "line-1": a complete line, not a fragment.
    assert.equal(extension.readLogTail(path, 21), "line-1\nline-2\nline-3\n");
    // start = 6, i.e. the newline that ended "line-0": only that byte is dropped.
    assert.equal(extension.readLogTail(path, 22), "line-1\nline-2\nline-3\n");
    // A window cut inside a line still drops the cut fragment (start = 8).
    assert.equal(extension.readLogTail(path, 20), "line-2\nline-3\n");
    // A window covering the whole file is returned verbatim.
    assert.equal(extension.readLogTail(path, content.length), content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The tool description is the model's only contract for what it can rely on. It
// may claim that a *truncated* result names its log file and that a
// *backgrounded* job has an id `pbb` understands — nothing more: a small
// foreground result leaves no file behind, and a foreground call has no job id
// for `pbb tail` to resolve.
test("the tool description promises no log for every command and no pbb tail for foreground calls", async () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-description-${process.pid}-${Date.now()}-`));
  const factory = await loadExtensionFactory();
  const session = createFakeSession({ cwd: dir, sessionId: "description", sessionFile: join(dir, "description.jsonl") });
  try {
    factory(session.api);
    const tool = session.bash();
    assert.ok(tool, "the extension must register the bash tool");
    const description = String(tool.description ?? "");

    // The two claims that are true (PLAN §6).
    assert.match(description, /a truncated result names the log file/);
    assert.match(description, /Set background: true[^.]*job id \(usable with pbb status\/tail\)/);

    // COMPARISON.md decision 5: the description must say what the model actually
    // sees — head + omitted marker + tail — instead of promising a tail-only cut.
    assert.doesNotMatch(description, /truncated to the last/i, "the model sees head and tail, not only the tail");
    assert.match(description, /first few and last few lines/);
    assert.match(description, /… N lines omitted …/);
    assert.match(description, /names the log file that holds the command's output/);

    // The old wording: "the full output of every command is written to its job
    // log" — false, a small foreground result's log is discarded.
    assert.doesNotMatch(description, /full output of every command/i);
    // …and "(also readable with pbb tail)" — false, there is no job id to read.
    assert.doesNotMatch(description, /readable (with|via) pbb tail/i);

    // A log that hit maxLogBytes is not the full output either, so the log a
    // truncated result names holds "the command's output", not "the full output".
    assert.doesNotMatch(description, /log file that holds the full output/i);

    const guidelines = (tool.promptGuidelines ?? []).join("\n");
    assert.doesNotMatch(guidelines, /full output of every command/i);
    assert.doesNotMatch(guidelines, /readable (with|via) pbb tail/i);
    // Scoping wording: `--scope session` only widens to sibling *instances* of
    // this session; other sessions (siblings, subagents) need `--scope all`.
    assert.doesNotMatch(guidelines, /--scope session` for sibling sessions/i);
    assert.match(guidelines, /`--scope session`/);
    assert.match(guidelines, /other sessions[^.]*`--scope all`/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a job that exceeds maxLogBytes stops logging, records the cap, and says so in the completion", async () => {
  const dir = configuredCwd(0.2, { maxLogBytes: 4096 });
  const root = join(dir, "pbb");
  const factory = await loadExtensionFactory();
  const session = createFakeSession({ cwd: dir, sessionId: "log-cap", sessionFile: join(dir, "cap.jsonl") });

  await withTemporaryPbbRoot(root, async () => {
    try {
      factory(session.api);
      await session.emit("session_start");
      const result = await session.bash().execute(
        "call-cap",
        { command: "head -c 20000 /dev/zero | tr '\\0' 'L'; sleep 0.6; echo AFTER-THE-CAP" },
        undefined,
        undefined,
        session.ctx,
      );
      const details = result.details;
      assert.equal(details.outcome, "running", "the call must have been promoted");
      const instanceDir = join(root, "sessions", details.sessionKey, "instances", details.instanceId);
      const logPath = join(instanceDir, "logs", "bg001.log");
      const jobPath = join(instanceDir, "jobs", "bg001.json");

      // The record learns about the cap while the job is still running.
      await waitForCondition(() => existsSync(jobPath) && readFileSync(jobPath, "utf8").includes("logTruncated"), 5_000);
      const running = JSON.parse(readFileSync(jobPath, "utf8"));
      assert.equal(running.status, "running");
      assert.equal(running.logTruncated, true);
      assert.equal(running.logBytes, 4096);
      assert.equal(readFileSync(logPath).length, 4096);

      await waitForCondition(() => session.messages.length > 0, 15_000);
      const completion = session.messages.at(-1).message;
      assert.equal(completion.details.outcome, "exit");
      assert.match(completion.content, /Log capped at 4 KB/);
      assert.doesNotMatch(String(completion.details.body), /AFTER-THE-CAP/, "output past the cap was never logged");

      // Nothing about the cap is written into the log: it stays raw command output.
      const log = readFileSync(logPath, "utf8");
      assert.match(log, /^L{4096}$/);
      const finished = JSON.parse(readFileSync(jobPath, "utf8"));
      assert.equal(finished.outcome, "exit");
      assert.equal(finished.logTruncated, true);
      assert.equal(finished.logBytes, 4096);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a finished job records the log's real size, not the promotion-time snapshot", async () => {
  const dir = configuredCwd(0.2);
  const root = join(dir, "pbb");
  const factory = await loadExtensionFactory();
  const session = createFakeSession({ cwd: dir, sessionId: "log-bytes", sessionFile: join(dir, "bytes.jsonl") });

  await withTemporaryPbbRoot(root, async () => {
    try {
      factory(session.api);
      await session.emit("session_start");
      // Nothing is written before promotion, so the promotion-time count is 0 and
      // only the finalize-time stat can report the 11 bytes the job really wrote.
      const result = await session.bash().execute(
        "call-bytes",
        { command: "sleep 0.4; printf 'LATE-BYTES\\n'" },
        undefined,
        undefined,
        session.ctx,
      );
      const details = result.details;
      assert.equal(details.outcome, "running", "the call must have been promoted");
      const instanceDir = join(root, "sessions", details.sessionKey, "instances", details.instanceId);
      const logPath = join(instanceDir, "logs", "bg001.log");
      const jobPath = join(instanceDir, "jobs", "bg001.json");

      await waitForCondition(() => session.messages.length > 0, 15_000);
      const finished = JSON.parse(readFileSync(jobPath, "utf8"));
      assert.equal(finished.status, "exited");
      const size = statSync(logPath).size;
      assert.ok(size > 0, "the log must hold the command's output");
      assert.equal(finished.logBytes, size, "the record must carry the log's final size");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a completion body strips escape sequences and carriage-return frames", async () => {
  const dir = configuredCwd(0.2);
  const root = join(dir, "pbb");
  const factory = await loadExtensionFactory();
  const session = createFakeSession({ cwd: dir, sessionId: "completion-escapes", sessionFile: join(dir, "esc.jsonl") });

  await withTemporaryPbbRoot(root, async () => {
    try {
      factory(session.api);
      await session.emit("session_start");
      const started = await session.bash().execute(
        "call-escapes",
        // After promotion: the escape/CR frames have to travel through the log and
        // the completion body, which is where they used to reach the model raw.
        { command: "sleep 0.4; printf '\\033]0;window title\\007progress 10%%\\rprogress 100%%\\nESCAPE-DONE\\n'" },
        undefined,
        undefined,
        session.ctx,
      );
      assert.equal(started.details.outcome, "running", "the call must have been promoted");
      await waitForCondition(() => session.messages.length > 0, 15_000);
      const body = String(session.messages.at(-1).message.content);
      const inner = body.slice(body.indexOf(">") + 1);
      assert.match(inner, /ESCAPE-DONE/);
      assert.match(inner, /progress 100%/, "the last \\r frame is the one the reader saw");
      assert.doesNotMatch(inner, /\u001b/, "no escape sequence may reach the model");
      assert.doesNotMatch(inner, /\r/, "no carriage return may reach the model");
      assert.doesNotMatch(inner, /progress 10%/, "an overwritten frame is not output");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a failing job-record write at promotion still finalizes and delivers the job", async () => {
  const dir = configuredCwd(0.2);
  const root = join(dir, "pbb");
  const sessionKey = "record-write-fails-key";
  const instanceId = "record-write-fails-instance";
  const factory = await loadExtensionFactory();
  const session = createFakeSession({ cwd: dir, sessionId: "record-write-fails", sessionFile: join(dir, "fails.jsonl") });
  const previous = {
    PBB_ROOT: process.env.PBB_ROOT,
    PI_LANE_SESSION_KEY: process.env.PI_LANE_SESSION_KEY,
    PI_LANE_INSTANCE_ID: process.env.PI_LANE_INSTANCE_ID,
  };
  process.env.PBB_ROOT = root;
  process.env.PI_LANE_SESSION_KEY = sessionKey;
  process.env.PI_LANE_INSTANCE_ID = instanceId;
  // A regular file where the jobs directory belongs: every job-record write fails
  // (ENOTDIR) exactly like ENOSPC/EACCES would, for the promotion write and for the
  // completion write alike.
  const instanceDir = join(root, "sessions", sessionKey, "instances", instanceId);
  mkdirSync(instanceDir, { recursive: true });
  writeFileSync(join(instanceDir, "jobs"), "not a directory\n");

  try {
    factory(session.api);
    await session.emit("session_start");
    const result = await session.bash().execute(
      "call-record-fails",
      { command: "echo early-line; sleep 0.5; echo LATE-LINE" },
      undefined,
      undefined,
      session.ctx,
    );
    // The call still became a job …
    assert.equal(result.details.outcome, "running");
    assert.match(resultText(result), /Bash job bg001 moved to background/);

    // … and the exit is still detected, recorded as far as possible and delivered.
    assert.ok(
      await waitForCondition(() => session.messages.length > 0, 15_000),
      "the completion never arrived after the record write failed",
    );
    const completion = session.messages.at(-1).message;
    assert.equal(completion.details.outcome, "exit");
    assert.equal(completion.details.exitCode, 0);
    assert.equal(completion.details.jobId, "bg001");
    assert.match(completion.content, /LATE-LINE/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session start deletes job logs past the retention window, but never a running or undelivered job's", async () => {
  const dir = configuredCwd(30);
  const root = join(dir, "pbb");
  const factory = await loadExtensionFactory();
  const session = createFakeSession({ cwd: dir, sessionId: "log-retention", sessionFile: join(dir, "retention.jsonl") });
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

  await withTemporaryPbbRoot(root, async () => {
    try {
      factory(session.api);
      await session.emit("session_start");
      const result = await session.bash().execute(
        "call-retention",
        { command: "echo delivered-job-output", background: true },
        undefined,
        undefined,
        session.ctx,
      );
      const details = result.details;
      const instanceDir = join(root, "sessions", details.sessionKey, "instances", details.instanceId);
      const deliveredLog = join(instanceDir, "logs", "bg001.log");
      const jobPath = join(instanceDir, "jobs", "bg001.json");
      await waitForCondition(() => session.messages.length > 0, 15_000);
      assert.equal(JSON.parse(readFileSync(jobPath, "utf8")).delivered, true);

      // An undelivered completion of the same age: its log is the only copy.
      const undeliveredLog = join(instanceDir, "logs", "bg002.log");
      const undeliveredJob = {
        schemaVersion: 1,
        jobId: "bg002",
        globalJobId: `${details.instanceId}:bg002`,
        command: "echo never-delivered",
        status: "exited",
        outcome: "exit",
        exitCode: 0,
        startedAt: eightDaysAgo.toISOString(),
        completedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
        delivered: false,
        sessionKey: details.sessionKey,
        instanceId: details.instanceId,
        logPath: undeliveredLog,
      };
      writeFileSync(undeliveredLog, "never-delivered-output\n");
      writeFileSync(join(instanceDir, "jobs", "bg002.json"), JSON.stringify(undeliveredJob));

      utimesSync(deliveredLog, eightDaysAgo, eightDaysAgo);
      utimesSync(undeliveredLog, eightDaysAgo, eightDaysAgo);

      // A fresh runtime for the same session: its session_start prunes.
      const next = createFakeSession({ cwd: dir, sessionId: "log-retention", sessionFile: join(dir, "retention.jsonl") });
      factory(next.api);
      await next.emit("session_start");

      assert.equal(existsSync(deliveredLog), false, "a delivered job log past the window is deleted");
      assert.equal(existsSync(undeliveredLog), true, "an undelivered job's log is kept");
      assert.equal(readFileSync(undeliveredLog, "utf8"), "never-delivered-output\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// PLAN §10: `maxActiveJobs` replaces the hard-coded 10, and the refusal must tell
// the model how to free a slot instead of only "wait for one to finish".
test("maxActiveJobs is configurable and the refusal points at pbb kill", async () => {
  const dir = configuredCwd(60, { maxActiveJobs: 1 });
  const root = join(dir, "pbb");
  const factory = await loadExtensionFactory();
  const session = createFakeSession({ cwd: dir, sessionId: "max-active", sessionFile: join(dir, "max-active.jsonl") });

  await withTemporaryPbbRoot(root, async () => {
    try {
      factory(session.api);
      await session.emit("session_start");

      const first = await session.bash().execute(
        "call-cap-1",
        { command: "sleep 0.6", background: true },
        undefined,
        undefined,
        session.ctx,
      );
      assert.equal(first.details.outcome, "running", "the first job must have been promoted");

      await assert.rejects(
        () =>
          session.bash().execute(
            "call-cap-2",
            { command: "echo second", background: true },
            undefined,
            undefined,
            session.ctx,
          ),
        (error) => {
          assert.match(error.message, /Too many bash jobs running \(1\/1\)/);
          assert.match(error.message, /pbb kill <jobid>/, "the refusal must say how to free a slot");
          return true;
        },
      );

      await waitForCondition(() => session.messages.length > 0, 15_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * A fake installed package layout: `root/node_modules/pi-lane` with a `pil` CLI
 * that answers `instances --json` the way pi-lane does. Its package.json mirrors
 * pi-lane's `exports` map, which does NOT expose `bin/pil.js` — the exact reason
 * the old fixed `<pkg>/node_modules/pi-lane` path failed.
 */
function writeFakePiLane(packageDir) {
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "pi-lane", version: "0.0.0", type: "module", exports: { ".": "./index.ts" } }),
  );
  writeFileSync(join(packageDir, "index.ts"), "export {};\n");
  writeFileSync(
    join(packageDir, "bin", "pil.js"),
    [
      "console.log(JSON.stringify({ instances: [{",
      "  instanceId: process.env.PI_LANE_INSTANCE_ID,",
      "  status: 'running',",
      "  live: true,",
      "  lastSeenAt: new Date().toISOString(),",
      "}] }));",
    ].join("\n"),
  );
}

function seedPbbJob(pbbRoot, sessionKey, instanceId) {
  const jobsDir = join(pbbRoot, "sessions", sessionKey, "instances", instanceId, "jobs");
  mkdirSync(jobsDir, { recursive: true });
  writeFileSync(
    join(jobsDir, "bg001.json"),
    JSON.stringify({
      jobId: "bg001",
      globalJobId: `${instanceId}:bg001`,
      status: "running",
      command: "job from a hoisted install",
      startedAt: new Date().toISOString(),
      instanceId,
    }),
  );
}

// Fix for the README's own recommended install path: pi's npm install hoists
// `pi-lane` next to `pi-background-bash`, so `<pkg>/node_modules/pi-lane` does not
// exist and every `pbb` command exited 4 `pi_lane_unavailable`. Both layouts must
// resolve: the hoisted one (module resolution) and the nested one (fallback).
test("pbb resolves pil in a hoisted npm layout and in a nested one", () => {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-pbb-layout-${process.pid}-${Date.now()}-`));
  try {
    const cases = [
      // pi install npm:pi-background-bash → both packages side by side
      { name: "hoisted", packageDir: join(dir, "hoisted", "node_modules", "pi-background-bash"), laneDir: join(dir, "hoisted", "node_modules", "pi-lane") },
      // a plain `npm install` inside the package → dependency nested in it
      { name: "nested", packageDir: join(dir, "nested", "node_modules", "pi-background-bash"), laneDir: join(dir, "nested", "node_modules", "pi-background-bash", "node_modules", "pi-lane") },
    ];

    for (const { name, packageDir, laneDir } of cases) {
      mkdirSync(join(packageDir, "bin"), { recursive: true });
      copyFileSync(PBB_CLI, join(packageDir, "bin", "pbb.js"));
      writeFakePiLane(laneDir);

      const sessionKey = `layout-${name}`;
      const instanceId = `instance-${name}`;
      const pbbRoot = join(dir, `pbb-${name}`);
      seedPbbJob(pbbRoot, sessionKey, instanceId);

      const env = {
        ...process.env,
        PBB_ROOT: pbbRoot,
        PI_LANE_SESSION_KEY: sessionKey,
        PI_LANE_SESSION_ID: `session-${name}`,
        PI_LANE_INSTANCE_ID: instanceId,
        PI_LANE_CURRENT_LANE: "main",
      };
      delete env.PBB_PIL_BIN;

      const out = execFileSync(process.execPath, [join(packageDir, "bin", "pbb.js"), "list"], {
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.match(out, /bg001/, `${name} layout: pbb list must find the job`);
      assert.match(out, /owner=live/, `${name} layout: the fake pil instance must be used`);
      assert.doesNotMatch(out, /pi_lane_unavailable/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// PLAN §11 item 9: the `files` allowlist must ship the code the entry points
// import. `npm pack --dry-run` is local: no registry, no tarball written.
test("the published package ships lib/, both extension entries and the pbb CLI", () => {
  const repoRoot = new URL("..", import.meta.url).pathname;
  const [manifest] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    }),
  );
  const files = new Set((manifest.files ?? []).map((entry) => entry.path));
  for (const required of ["index.ts", "extensions/background-bash.ts", "bin/pbb.js"]) {
    assert.ok(files.has(required), `${required} must be in the published package`);
  }
  // Both extension entry points: the runner and the model-facing output layer.
  assert.ok(files.has("extensions/output-format.ts"), "extensions/output-format.ts must be published");
  assert.ok(files.has("lib/output-format.ts"), "lib/ must be published: both extensions import it");
  assert.ok(files.has("lib/child-exit.ts"), "lib/child-exit.ts must be published");
  assert.ok(files.has("extensions/pi-context-utils.ts"), "extensions/pi-context-utils.ts is imported by both entries");

  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  assert.deepEqual(pkg.pi.extensions, ["./index.ts", "./extensions/output-format.ts"]);
});
