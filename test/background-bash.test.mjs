import { test } from "node:test";
import assert from "node:assert/strict";
import { createMock, createControllableBrain, script, text, toolCall } from "pi-mock";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const EXT = new URL("../extensions/background-bash.ts", import.meta.url).pathname;
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

test("context guard trims oversized historical tool results before replay", async () => {
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
    text("context guard kept request small"),
  ), { sessionFile, cwd: dir });

  try {
    await mock.run("continue after huge historical output", TIMEOUT);
    const request = requestText(mock.requests.at(-1));
    assert.match(request, /bash result trimmed by pi-background-bash context guard/);
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

test("background log is reset when a job id is reused in a later runtime", async () => {
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
    bg("sleep 0.1; echo fresh-reused-log-output"),
    text("initial turn complete"),
    text("saw fresh reused log result"),
  ), { cwd, env });

  try {
    await mock.run("start a background command after a stale log exists", TIMEOUT);
    const logPath = join(logDir, "bg001.log");
    await waitForCondition(() => readFileSync(logPath, "utf8").includes("fresh-reused-log-output"));
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /fresh-reused-log-output/);
    assert.doesNotMatch(log, /stale-previous-job-output/);
    assert.doesNotMatch(log, /\[pbb: output snapshot replaced\]/);
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
  writeFileSync(join(logsDir, "bg007.log"), "SWEEP_LOG_TAIL all tests passed\n");

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

function configuredCwd(seconds) {
  const dir = mkdtempSync(join(tmpdir(), `pi-background-bash-seam-${process.pid}-${Date.now()}-`));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "background-bash.json"), JSON.stringify({ autoBackgroundAfterSeconds: seconds }));
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
