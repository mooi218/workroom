import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { setImmediate as nextTick } from "node:timers/promises";
import { mkdtemp, mkdir, writeFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  CodexControl,
  StdioAppServerClient,
  normalizeAccountUsage,
  resolveCodexLaunch,
  MAX_INSTRUCTION_BYTES,
  MAX_REPLY_BYTES,
  MAX_CACHED_REPLIES,
} from "../lib/codex-control.mjs";

const TASK = "01950000-1111-7111-8111-111111111111";
const PROJECT = "01950000-2222-7222-8222-222222222222";
const TURN = "01950000-3333-7333-8333-333333333333";
const ROOT = await realpath(process.cwd());

function fakeTransport(handler = () => {}) {
  const child = new EventEmitter();
  const frames = [];
  let buffer = "";
  let killed = false;
  const io = {
    frames,
    child,
    reply: (request, result) =>
      child.stdout.write(JSON.stringify({ id: request.id, result }) + "\n"),
    error: (request, error) =>
      child.stdout.write(JSON.stringify({ id: request.id, error }) + "\n"),
    notify: (method, params) =>
      child.stdout.write(JSON.stringify({ method, params }) + "\n"),
    serverRequest: (method, params, id = 900) =>
      child.stdout.write(JSON.stringify({ id, method, params }) + "\n"),
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const frame = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        frames.push(frame);
        queueMicrotask(() => {
          if (frame.method === "initialize")
            io.reply(frame, { userAgent: "fake" });
          else if (frame.method && frame.id !== undefined) handler(frame, io);
        });
      }
      callback();
    },
    final(callback) {
      callback();
      queueMicrotask(() => child.emit("exit", 0));
    },
  });
  child.kill = () => {
    if (killed) return;
    killed = true;
    child.emit("exit", 1);
  };
  io.factory = async () => child;
  return io;
}

function makeClient(t, handler, options = {}) {
  const fake = fakeTransport(handler);
  const client = new StdioAppServerClient({
    transportFactory: fake.factory,
    requestTimeoutMs: 100,
    ...options,
  });
  t.after(() => client.close());
  return { fake, client };
}

function standardHandler(request, io) {
  switch (request.method) {
    case "account/read":
      io.reply(request, {
        account: {
          type: "chatgpt",
          planType: "plus",
          email: "private@example.invalid",
        },
      });
      break;
    case "account/rateLimits/read":
      io.reply(request, rateData());
      break;
    case "windowsSandbox/readiness":
      io.reply(request, { status: "ready" });
      break;
    case "thread/read":
      io.reply(request, {
        thread: {
          id: request.params.threadId,
          cwd: ROOT,
          status: { type: "notLoaded" },
          preview: "private body",
          turns: [],
        },
      });
      break;
    case "thread/start":
    case "thread/resume":
      io.reply(request, readyThread(request.params.threadId || TASK));
      break;
    case "turn/start":
      io.reply(request, {
        turn: { id: TURN, status: "inProgress", items: [] },
      });
      break;
    case "turn/interrupt":
      io.reply(request, {});
      break;
    default:
      io.error(request, { code: -32601, message: "unknown test method" });
  }
}

function readyThread(id = TASK) {
  return {
    thread: { id, cwd: ROOT, status: { type: "idle" }, turns: [] },
    cwd: ROOT,
    approvalPolicy: "never",
    sandbox: {
      type: "workspaceWrite",
      networkAccess: false,
      writableRoots: [],
    },
  };
}

function rateData() {
  return {
    ordinaryUsageAllowed: true,
    accountId: "private-account-id",
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        planType: "plus",
        primary: {
          usedPercent: 35,
          windowDurationMins: 300,
          resetsAt: 2_000_000_000,
        },
        secondary: {
          usedPercent: 60,
          windowDurationMins: 10_080,
          resetsAt: 2_000_010_000,
        },
      },
    },
  };
}

function makeControl(t, handler = standardHandler, options = {}) {
  const fake = fakeTransport(handler);
  const client = new StdioAppServerClient({
    transportFactory: fake.factory,
    requestTimeoutMs: 100,
  });
  const control = new CodexControl({ client, platform: "linux", ...options });
  t.after(() => control.close());
  return { fake, client, control };
}

test("RPC initializes once and correlates concurrent responses by ID", async (t) => {
  const waiting = [];
  const { client, fake } = makeClient(t, (request, io) => {
    waiting.push(request);
    if (waiting.length === 2) {
      io.reply(waiting[1], { value: "second" });
      io.reply(waiting[0], { value: "first" });
    }
  });
  const results = await Promise.all([
    client.request("account/read", {}),
    client.request("account/rateLimits/read"),
  ]);
  assert.deepEqual(results, [{ value: "first" }, { value: "second" }]);
  assert.equal(
    fake.frames.filter((frame) => frame.method === "initialize").length,
    1,
  );
  assert.deepEqual(fake.frames[0].params.capabilities, {
    experimentalApi: false,
    requestAttestation: false,
  });
  assert.equal(fake.frames[1].method, "initialized");
});

test("RPC handles split UTF-8 frames and multiple lines", async (t) => {
  const { client } = makeClient(t, (request, io) => {
    const bytes = Buffer.from(
      JSON.stringify({ id: request.id, result: { label: "日本語" } }) + "\n",
    );
    const at = bytes.indexOf(Buffer.from("日本語")) + 1;
    io.child.stdout.write(bytes.subarray(0, at));
    io.child.stdout.write(bytes.subarray(at));
  });
  assert.deepEqual(await client.request("account/read", {}), {
    label: "日本語",
  });
});

test("RPC error text and data are not exposed", async (t) => {
  const { client } = makeClient(t, (request, io) =>
    io.error(request, {
      code: -32000,
      message: "SECRET_ACCESS_TOKEN private@example.invalid",
      data: { token: "SECRET" },
    }),
  );
  await assert.rejects(client.request("account/read", {}), (error) => {
    assert.equal(error.code, "CODEX_REQUEST_FAILED");
    assert.equal(error.rpcCode, -32000);
    assert.doesNotMatch(JSON.stringify(error), /SECRET|private@example/);
    return true;
  });
});

test("timeouts distinguish reads from uncertain mutations and never retry them", async (t) => {
  const { client, fake } = makeClient(t, () => {}, { requestTimeoutMs: 15 });
  await assert.rejects(
    client.request("account/read", {}),
    (error) => error.code === "CODEX_TIMEOUT" && !error.outcomeUnknown,
  );
  await assert.rejects(
    client.request("turn/start", { threadId: TASK }),
    (error) => error.code === "CODEX_TIMEOUT" && error.outcomeUnknown,
  );
  assert.equal(
    fake.frames.filter((frame) => frame.method === "turn/start").length,
    1,
  );
});

test("closing rejects in-flight requests, while unsupported methods never reach transport", async (t) => {
  const { client, fake } = makeClient(t, () => {});
  await assert.rejects(client.request("account/logout"), {
    code: "METHOD_NOT_ALLOWED",
  });
  const pending = client.request("account/read", {});
  const assertion = assert.rejects(pending, (error) =>
    ["CODEX_EXITED", "CODEX_CLOSED"].includes(error.code),
  );
  await nextTick();
  await client.close();
  await assertion;
  assert.equal(
    fake.frames.some((frame) => frame.method === "account/logout"),
    false,
  );
});

test("malformed protocol output fails closed without echoing its contents", async (t) => {
  const { client } = makeClient(t, (_request, io) =>
    io.child.stdout.write("secret-not-json\n"),
  );
  await assert.rejects(
    client.request("account/read", {}),
    (error) =>
      error.code === "CODEX_PROTOCOL_ERROR" &&
      !error.message.includes("secret"),
  );
});

test("normalization preserves plan, duration, nulls and the authoritative Codex bucket", () => {
  const data = rateData();
  data.rateLimits = {
    limitId: "codex",
    primary: { usedPercent: 99, windowDurationMins: 300 },
  };
  data.rateLimitsByLimitId.other = {
    limitId: "other",
    primary: { usedPercent: 7, windowDurationMins: 15 },
  };
  const plus = normalizeAccountUsage(
    { account: { type: "chatgpt", planType: "plus", email: "PRIVATE" } },
    data,
    "2026-09-14T00:00:00.000Z",
  );
  assert.deepEqual(
    plus.windows.map((window) => window.durationMinutes),
    [300, 10_080],
  );
  assert.deepEqual(
    plus.windows.map((window) => window.remainingPercent),
    [65, 40],
  );
  assert.equal(plus.buckets.length, 2);
  assert.doesNotMatch(JSON.stringify(plus), /PRIVATE|private-account-id/);
  const pro = normalizeAccountUsage(
    { account: { type: "chatgpt", planType: "pro" } },
    data,
  );
  assert.equal(pro.planType, "pro");
  assert.equal(pro.buckets[0].planType, "plus");
  assert.deepEqual(
    pro.windows.map((window) => window.durationMinutes),
    [10_080],
  );
  const missing = normalizeAccountUsage(
    { account: { type: "chatgpt", planType: "plus" } },
    {
      rateLimits: {
        primary: {
          usedPercent: null,
          windowDurationMins: null,
          resetsAt: null,
        },
      },
    },
  );
  assert.deepEqual(missing.windows, []);
  assert.deepEqual(missing.missingDurations, [300, 10_080]);
  assert.equal(missing.buckets[0].windows[0].remainingPercent, null);
  const unusual = normalizeAccountUsage(
    { account: { type: "chatgpt", planType: "futurePlan" } },
    {
      rateLimits: {
        primary: { usedPercent: 110, windowDurationMins: 17, resetsAt: null },
      },
    },
  );
  assert.equal(unusual.planType, "futurePlan");
  assert.equal(unusual.windows[0].durationMinutes, 17);
  assert.equal(unusual.windows[0].usedPercent, 110);
  assert.equal(unusual.windows[0].remainingPercent, 0);
  assert.equal(unusual.windows[0].resetsAt, null);
});

test("usage polls coalesce and cache for at least sixty seconds without starting work", async (t) => {
  let now = 1000;
  const { control, fake } = makeControl(t, standardHandler, {
    now: () => now,
    usageRefreshMs: 1,
  });
  const results = await Promise.all([
    control.getAccountUsage(),
    control.getAccountUsage(),
  ]);
  assert.equal(results[0].planType, "plus");
  assert.deepEqual(results[0], results[1]);
  now += 59_999;
  await control.getAccountUsage();
  assert.equal(
    fake.frames.filter((frame) => frame.method === "account/read").length,
    1,
  );
  now += 1;
  await control.getAccountUsage();
  assert.equal(
    fake.frames.filter((frame) => frame.method === "account/read").length,
    2,
  );
  assert.equal(
    fake.frames.some((frame) => /^(thread|turn)\//.test(frame.method || "")),
    false,
  );
  assert.doesNotMatch(JSON.stringify(control.account), /private@example/);
});

test("failed usage refresh keeps old values visibly stale and hides raw diagnostics", async (t) => {
  let now = 1000,
    fail = false;
  const { control } = makeControl(
    t,
    (request, io) => {
      if (fail && request.method === "account/rateLimits/read")
        io.error(request, { code: -32000, message: "SECRET" });
      else standardHandler(request, io);
    },
    { now: () => now },
  );
  const first = await control.getAccountUsage();
  fail = true;
  now += 60_000;
  const second = await control.getAccountUsage();
  assert.equal(second.status, "unavailable");
  assert.equal(second.stale, true);
  assert.deepEqual(second.windows, first.windows);
  assert.equal(second.observedAt, first.observedAt);
  assert.doesNotMatch(JSON.stringify(second), /SECRET/);
});

test("API-key and signed-out accounts do not manufacture subscription windows", async (t) => {
  const { control, fake } = makeControl(t, (request, io) =>
    io.reply(request, { account: { type: "apiKey" } }),
  );
  const usage = await control.getAccountUsage();
  assert.equal(usage.status, "unsupported_account");
  assert.equal(usage.planType, null);
  assert.deepEqual(usage.windows, []);
  assert.equal(
    fake.frames.some((frame) => frame.method === "account/rateLimits/read"),
    false,
  );
  assert.equal(
    normalizeAccountUsage({ account: null }, null).status,
    "signed_out",
  );
});

test("new instructions use official text input and restricted workspace policy", async (t) => {
  const { control, fake } = makeControl(t);
  const text =
    'Update the sample README.\nLiteral "$()" and quotes stay in this instruction.';
  const result = await control.sendInstruction({ cwd: ROOT, text });
  assert.deepEqual(
    { taskId: result.taskId, turnId: result.turnId, status: result.status },
    { taskId: TASK, turnId: TURN, status: "inProgress" },
  );
  const start = fake.frames.find((frame) => frame.method === "thread/start");
  assert.equal(start.params.sandbox, "workspace-write");
  assert.equal(start.params.approvalPolicy, "never");
  assert.equal("model" in start.params, false);
  const turn = fake.frames.find((frame) => frame.method === "turn/start");
  assert.deepEqual(turn.params.input, [
    { type: "text", text, text_elements: [] },
  ]);
  assert.deepEqual(turn.params.sandboxPolicy, {
    type: "workspaceWrite",
    writableRoots: [ROOT],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
  assert.equal(turn.params.approvalPolicy, "never");
  await assert.rejects(
    control.sendInstruction({ taskId: TASK, text: "Again" }),
    { code: "TASK_BUSY" },
  );
});

test("a project task supplies only cwd for a newly started thread", async (t) => {
  const { control, fake } = makeControl(t);
  await control.sendInstruction({
    projectTaskId: PROJECT,
    text: "Write sample notes.",
  });
  const read = fake.frames.find((frame) => frame.method === "thread/read");
  assert.deepEqual(read.params, { threadId: PROJECT, includeTurns: false });
  assert.equal(
    fake.frames.some((frame) => frame.method === "thread/resume"),
    false,
  );
  assert.equal(
    fake.frames.find((frame) => frame.method === "thread/start").params.cwd,
    ROOT,
  );
  const context = await control.readThreadContext(PROJECT);
  assert.deepEqual(Object.keys(context).sort(), [
    "activeFlags",
    "cwd",
    "status",
    "taskId",
  ]);
  assert.doesNotMatch(JSON.stringify(context), /private body/);
});

test("confirmed idle existing tasks resume with no model override or history hydration", async (t) => {
  const { control, fake } = makeControl(t, standardHandler, {
    getTaskState: () => "done",
  });
  await control.sendInstruction({ taskId: TASK, text: "Continue the sample." });
  const resume = fake.frames.find((frame) => frame.method === "thread/resume");
  assert.deepEqual(resume.params, {
    threadId: TASK,
    approvalPolicy: "never",
    sandbox: "workspace-write",
    excludeTurns: true,
  });
  assert.equal(
    fake.frames.some((frame) => frame.method === "thread/start"),
    false,
  );
});

test("unknown, running, and approval-waiting desktop tasks require handoff", async (t) => {
  for (const status of ["working", "waiting", "unknown", undefined]) {
    const { control, fake } = makeControl(t, standardHandler, {
      getTaskState: () => status,
    });
    await assert.rejects(
      control.sendInstruction({ taskId: TASK, text: "Continue." }),
      { code: "TASK_HANDOFF_REQUIRED" },
    );
    assert.equal(
      fake.frames.some((frame) => /^(thread|turn)\//.test(frame.method || "")),
      false,
    );
  }
});

test("runtime-active resumed threads and unsafe responses never start a turn", async (t) => {
  for (const variant of ["active", "network", "full-access"]) {
    const { control, fake } = makeControl(
      t,
      (request, io) => {
        if (request.method === "thread/resume") {
          const response = readyThread();
          if (variant === "active")
            response.thread.status = {
              type: "active",
              activeFlags: ["waitingOnApproval"],
            };
          if (variant === "network") response.sandbox.networkAccess = true;
          if (variant === "full-access")
            response.sandbox.type = "dangerFullAccess";
          io.reply(request, response);
        } else standardHandler(request, io);
      },
      { getTaskState: () => "idle" },
    );
    await assert.rejects(
      control.sendInstruction({ taskId: TASK, text: "Continue." }),
      (error) => ["TASK_BUSY", "UNSAFE_CONFIGURATION"].includes(error.code),
    );
    assert.equal(
      fake.frames.some((frame) => frame.method === "turn/start"),
      false,
    );
  }
});

test("Windows sandbox setup is checked but never installed or elevated automatically", async (t) => {
  const { control, fake } = makeControl(
    t,
    (request, io) => {
      if (request.method === "windowsSandbox/readiness")
        io.reply(request, { status: "notConfigured" });
      else standardHandler(request, io);
    },
    { platform: "win32" },
  );
  await assert.rejects(
    control.sendInstruction({ cwd: ROOT, text: "Update the sample." }),
    { code: "SANDBOX_SETUP_REQUIRED" },
  );
  assert.equal(
    fake.frames.some((frame) =>
      ["windowsSandbox/setupStart", "thread/start", "turn/start"].includes(
        frame.method,
      ),
    ),
    false,
  );
});

test("invalid IDs, directory changes, privileged options and oversized text are rejected", async (t) => {
  const { control, fake } = makeControl(t);
  for (const input of [
    { taskId: "work:unrelated", text: "Test" },
    { taskId: TASK, cwd: ROOT, text: "Test" },
    { cwd: ROOT, text: "" },
    { cwd: ROOT, text: "nul\0text" },
    { cwd: ROOT, text: "x".repeat(MAX_INSTRUCTION_BYTES + 1) },
    { cwd: ROOT, text: "Test", sandbox: "danger-full-access" },
    { cwd: "../relative", text: "Test" },
  ])
    await assert.rejects(control.sendInstruction(input));
  assert.equal(
    fake.frames.some((frame) => frame.method === "turn/start"),
    false,
  );
});

test("completion before turn/start acknowledgement remains visible to the caller and events", async (t) => {
  const events = [];
  const { control } = makeControl(
    t,
    (request, io) => {
      if (request.method === "turn/start") {
        io.notify("turn/started", { threadId: TASK, turn: { id: TURN } });
        io.notify("turn/completed", {
          threadId: TASK,
          turn: { id: TURN, status: "completed", items: [{ text: "PRIVATE" }] },
        });
        io.reply(request, { turn: { id: TURN, status: "inProgress" } });
      } else standardHandler(request, io);
    },
    { onEvent: (event) => events.push(event) },
  );
  const result = await control.sendInstruction({
    cwd: ROOT,
    text: "A sample instruction.",
  });
  assert.equal(result.status, "completed");
  assert.ok(events.some((event) => event.type === "turnStarted"));
  assert.ok(
    events.some(
      (event) => event.type === "turnCompleted" && event.status === "completed",
    ),
  );
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});

test("interactive requests receive an immediate error, a handoff event, and an interrupt", async (t) => {
  const events = [];
  const { control, fake } = makeControl(t, standardHandler, {
    onEvent: (event) => events.push(event),
  });
  await control.sendInstruction({ cwd: ROOT, text: "A sample instruction." });
  fake.serverRequest("item/permissions/requestApproval", {
    threadId: TASK,
    turnId: TURN,
    privatePayload: "SECRET",
    permissions: { network: true },
  });
  await nextTick();
  assert.ok(
    fake.frames.some(
      (frame) => frame.id === 900 && frame.error?.code === -32601,
    ),
  );
  assert.ok(fake.frames.some((frame) => frame.method === "turn/interrupt"));
  assert.ok(
    events.some(
      (event) =>
        event.type === "handoff" && event.reason === "approval_required",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(control.getState()),
    /SECRET|privatePayload/,
  );
});

test("reply cache only serves an explicit final message after its owned turn completes", async (t) => {
  const events = [];
  const { control, fake } = makeControl(t, standardHandler, {
    onEvent: (event) => events.push(event),
  });
  await control.sendInstruction({ cwd: ROOT, text: "Synthetic prompt." });
  for (const item of [
    { type: "agentMessage", phase: "commentary", text: "PRIVATE_COMMENTARY" },
    { type: "agentMessage", phase: null, text: "UNKNOWN_PHASE" },
    { type: "agentMessage", text: "MISSING_PHASE" },
    { type: "reasoning", phase: "final_answer", text: "PRIVATE_REASONING" },
    {
      type: "commandExecution",
      phase: "final_answer",
      text: "PRIVATE_TOOL_OUTPUT",
    },
  ])
    fake.notify("item/completed", { threadId: TASK, turnId: TURN, item });
  fake.notify("item/completed", {
    threadId: PROJECT,
    turnId: TURN,
    item: { type: "agentMessage", phase: "final_answer", text: "FOREIGN_TASK" },
  });
  fake.notify("item/completed", {
    threadId: TASK,
    turnId: PROJECT,
    item: { type: "agentMessage", phase: "final_answer", text: "FOREIGN_TURN" },
  });
  assert.equal(
    control.getReply(TASK, { turnId: TURN }).reason,
    "not_completed",
  );
  fake.notify("item/completed", {
    threadId: TASK,
    turnId: TURN,
    item: {
      type: "agentMessage",
      phase: "final_answer",
      text: "FINAL_REPLY_ONLY",
    },
  });
  assert.equal(control.getReply(TASK, { turnId: TURN }).status, "unavailable");
  fake.notify("turn/completed", {
    threadId: TASK,
    turn: { id: TURN, status: "completed" },
  });
  assert.deepEqual(control.getReply(TASK, { turnId: TURN }), {
    status: "available",
    taskId: TASK,
    turnId: TURN,
    text: "FINAL_REPLY_ONLY",
    truncated: false,
    totalBytes: Buffer.byteLength("FINAL_REPLY_ONLY"),
  });
  assert.doesNotMatch(
    JSON.stringify(control.getState()),
    /FINAL_REPLY_ONLY|PRIVATE_|FOREIGN_|UNKNOWN_PHASE|MISSING_PHASE/,
  );
  assert.doesNotMatch(
    JSON.stringify(events),
    /FINAL_REPLY_ONLY|PRIVATE_|FOREIGN_/,
  );
  assert.equal(
    control.getReply(PROJECT, { turnId: TURN }).status,
    "unavailable",
  );
  assert.equal(
    control.getReply(TASK, { turnId: PROJECT }).status,
    "unavailable",
  );
  assert.equal(control.getReply(TASK, null).reason, "exact_turn_required");
});

test("reply cache preserves exact older turns without letting duplicate old events replace active state", async (t) => {
  const secondTurn = "01950000-4444-7444-8444-444444444444";
  let starts = 0;
  const { control, fake } = makeControl(t, (request, io) => {
    if (request.method === "turn/start")
      io.reply(request, {
        turn: { id: ++starts === 1 ? TURN : secondTurn, status: "inProgress" },
      });
    else standardHandler(request, io);
  });
  await control.sendInstruction({
    cwd: ROOT,
    text: "First synthetic request.",
  });
  fake.notify("item/completed", {
    threadId: TASK,
    turnId: TURN,
    item: { type: "agentMessage", phase: "final", text: "FIRST_FINAL" },
  });
  fake.notify("turn/completed", {
    threadId: TASK,
    turn: { id: TURN, status: "completed" },
  });
  await control.sendInstruction({
    taskId: TASK,
    text: "Second synthetic request.",
  });
  fake.notify("turn/completed", {
    threadId: TASK,
    turn: { id: TURN, status: "completed" },
  });
  assert.equal(control.getReply(TASK, { turnId: TURN }).text, "FIRST_FINAL");
  assert.equal(
    control.getReply(TASK, { turnId: secondTurn }).reason,
    "not_completed",
  );
  assert.equal(
    control.getState().running.find((item) => item.taskId === TASK).turnId,
    secondTurn,
  );
  fake.notify("item/completed", {
    threadId: TASK,
    turnId: secondTurn,
    item: { type: "agentMessage", phase: "final_answer", text: "SECOND_FINAL" },
  });
  fake.notify("turn/completed", {
    threadId: TASK,
    turn: { id: secondTurn, status: "completed" },
  });
  assert.equal(control.getReply(TASK, { turnId: TURN }).text, "FIRST_FINAL");
  assert.equal(
    control.getReply(TASK, { turnId: secondTurn }).text,
    "SECOND_FINAL",
  );
});

test("reply text is capped at 64 KiB without splitting UTF-8 characters", async (t) => {
  const { control, fake } = makeControl(t);
  await control.sendInstruction({ cwd: ROOT, text: "Synthetic request." });
  const original = "あ".repeat(22_000);
  fake.notify("item/completed", {
    threadId: TASK,
    turnId: TURN,
    item: { type: "agentMessage", phase: "final_answer", text: original },
  });
  fake.notify("turn/completed", {
    threadId: TASK,
    turn: { id: TURN, status: "completed" },
  });
  const reply = control.getReply(TASK, { turnId: TURN });
  assert.equal(reply.status, "available");
  assert.equal(reply.totalBytes, 66_000);
  assert.equal(reply.truncated, true);
  assert.ok(Buffer.byteLength(reply.text) <= MAX_REPLY_BYTES);
  assert.equal(reply.text.includes("\uFFFD"), false);
  await control.close();
  assert.equal(control.completedReplies.size, 0);
  assert.equal(control.getReply(TASK, { turnId: TURN }).reason, "closed");
});

test("completed cache retains only thirty exact replies and never falls back to the newest one", async (t) => {
  let index = 0;
  const ids = [];
  const { control, fake } = makeControl(t, (request, io) => {
    if (request.method === "turn/start") {
      const id =
        "01950000-0000-7000-8000-" + (++index).toString(16).padStart(12, "0");
      ids.push(id);
      io.reply(request, { turn: { id, status: "inProgress" } });
    } else standardHandler(request, io);
  });
  for (let i = 0; i <= MAX_CACHED_REPLIES; i++) {
    const response = await control.sendInstruction({
      ...(i ? { taskId: TASK } : { cwd: ROOT }),
      text: "Synthetic request " + i,
    });
    fake.notify("item/completed", {
      threadId: TASK,
      turnId: response.turnId,
      item: { type: "agentMessage", phase: "final_answer", text: "Reply " + i },
    });
    fake.notify("turn/completed", {
      threadId: TASK,
      turn: { id: response.turnId, status: "completed" },
    });
  }
  assert.equal(
    control.getReply(TASK, { turnId: ids[0] }).status,
    "unavailable",
  );
  assert.equal(control.getReply(TASK, { turnId: ids.at(-1) }).text, "Reply 30");
  assert.equal(control.completedReplies.size, MAX_CACHED_REPLIES);
});

test("interrupted or failed turns and phase-unknown messages never become available replies", async (t) => {
  for (const status of ["failed", "interrupted", "completed"]) {
    const { control, fake } = makeControl(t);
    await control.sendInstruction({ cwd: ROOT, text: "Synthetic request." });
    fake.notify("item/completed", {
      threadId: TASK,
      turnId: TURN,
      item: {
        type: "agentMessage",
        phase: status === "completed" ? null : "final_answer",
        text: "NOT_A_COMPLETED_FINAL",
      },
    });
    fake.notify("turn/completed", {
      threadId: TASK,
      turn: { id: TURN, status },
    });
    assert.equal(
      control.getReply(TASK, { turnId: TURN }).status,
      "unavailable",
    );
  }
});

test("resolver unwraps standard npm shims and never invokes cmd or a user-built shell string", async (t) => {
  const tempBase = await realpath(os.tmpdir());
  const temp = await mkdtemp(path.join(tempBase, "workroom-control-test-"));
  t.after(async () => {
    const resolved = await realpath(temp);
    assert.equal(path.dirname(resolved), tempBase);
    assert.ok(path.basename(resolved).startsWith("workroom-control-test-"));
    await rm(resolved, { recursive: true, force: true });
  });
  const shim = path.join(temp, "codex.cmd");
  await writeFile(shim, "@echo off\nTHIS SHIM MUST NEVER EXECUTE\n");
  const entry = path.join(
    temp,
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js",
  );
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, "// synthetic resolver fixture\n");
  const result = await resolveCodexLaunch({
    codexPath: shim,
    platform: "win32",
  });
  assert.equal(result.command, process.execPath);
  assert.equal(result.args[0], await realpath(entry));
  assert.deepEqual(result.args.slice(1, 3), ["app-server", "--stdio"]);
  assert.ok(result.args.includes('approval_policy="never"'));
  assert.ok(
    result.args.includes("sandbox_workspace_write.network_access=false"),
  );
  assert.equal(
    result.args.some((arg) => /danger|bypass|escalated/.test(arg)),
    false,
  );
  await assert.rejects(
    resolveCodexLaunch({
      codexPath: "codex.exe & calculator",
      platform: "win32",
    }),
    { code: "INVALID_EXECUTABLE" },
  );
});
