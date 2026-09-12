import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import "../extension/observer-core.js";

const core = globalThis.WorkroomObserverCore;
const NOW = "2026-09-13T00:00:00.000Z";
const URL_A = "https://chatgpt.com/c/01234567-89ab-cdef-0123-456789abcdef";
const URL_B = "https://chatgpt.com/c/abcdefgh-1234-5678-9012-abcdefghijkl";
const candidate = (value = {}) => ({
  visible: true,
  inConversation: false,
  scope: "main",
  ...value,
});
const snapshot = (signals = {}, extras = {}) => ({
  url: URL_A,
  title: "企画書を仕上げる - ChatGPT",
  signals,
  ...extras,
});
const MANUAL = { manual: true, autoDetect: true };

test("an ordinary conversation is not automatically a Work task, even while generating", () => {
  assert.equal(
    core.taskFromSnapshot(
      snapshot({ working: true }),
      { autoDetect: true },
      NOW,
    ),
    null,
  );
  assert.equal(
    core.taskFromSnapshot(
      snapshot({ work: true, working: true }),
      { autoDetect: false },
      NOW,
    ),
    null,
  );
});

test("manual selection or explicit Work evidence permits observation", () => {
  assert.equal(
    core.taskFromSnapshot(snapshot({ working: true }), MANUAL, NOW).status,
    "working",
  );
  assert.equal(
    core.taskFromSnapshot(
      snapshot({ work: true, waiting: true }),
      { autoDetect: true },
      NOW,
    ).status,
    "waiting",
  );
  assert.equal(
    core.taskFromSnapshot(
      snapshot({ work: true }),
      { manual: true, excluded: true, autoDetect: true },
      NOW,
    ),
    null,
  );
});

test("a Work option in a menu, sidebar, transcript, or unselected switch is not Work evidence", () => {
  const signals = core.deriveSignals({
    workMarkers: [
      candidate({ label: "Work", selected: false }),
      candidate({ label: "Work", selected: true, scope: "other" }),
      candidate({ label: "Work", selected: true, inConversation: true }),
      candidate({ label: "Work", selected: true, visible: false }),
    ],
  });
  assert.equal(signals.work, false);
  assert.equal(
    core.deriveSignals({
      workMarkers: [candidate({ label: "Work", selected: true })],
    }).work,
    true,
  );
});

test("message content and hidden or sidebar controls cannot change task state", () => {
  const ui = {
    controls: [
      candidate({ label: "Stop generating", inConversation: true }),
      candidate({ label: "Stop generating", scope: "other" }),
    ],
    statuses: [
      candidate({ label: "Completed", inConversation: true }),
      candidate({ label: "Waiting for approval", visible: false }),
    ],
    busy: [candidate({ busy: true, scope: "other" })],
  };
  assert.equal(core.resolveStatus(core.deriveSignals(ui)), "unknown");
});

test("visible stop controls and busy task surfaces indicate working", () => {
  assert.equal(
    core.resolveStatus(
      core.deriveSignals({
        controls: [candidate({ label: "Stop generating" })],
      }),
    ),
    "working",
  );
  assert.equal(
    core.resolveStatus(
      core.deriveSignals({ controls: [candidate({ label: "生成を停止" })] }),
    ),
    "working",
  );
  assert.equal(
    core.resolveStatus(
      core.deriveSignals({ busy: [candidate({ busy: true })] }),
    ),
    "working",
  );
  assert.equal(
    core.resolveStatus(
      core.deriveSignals({
        controls: [candidate({ label: "Stop generating", disabled: true })],
      }),
    ),
    "unknown",
  );
});

test("absence of a stop control never turns into completion", () => {
  assert.equal(core.resolveStatus({}), "unknown");
  assert.equal(core.resolveStatus({ working: false }), "unknown");
  assert.equal(
    core.taskFromSnapshot(snapshot({}), MANUAL, NOW).status,
    "unknown",
  );
});

test("only exact explicit status labels are accepted", () => {
  for (const label of ["Completed", "Task completed", "作業完了"])
    assert.equal(core.statusFromLabel(label), "done");
  for (const label of ["Waiting for approval", "Needs your input", "確認待ち"])
    assert.equal(core.statusFromLabel(label), "waiting");
  for (const label of [
    "I have completed the document.",
    "Not completed",
    "Approve",
    "Loading",
    "Worked for 2m",
    "Done — here is the file",
  ])
    assert.equal(core.statusFromLabel(label), "unknown");
  assert.equal(core.statusFromLabel("Task status: Completed"), "done");
  assert.equal(core.statusFromLabel("Error"), "error");
  assert.equal(core.statusFromLabel("未開始"), "idle");
});

test("contradictory active labels stay unknown; a new generation supersedes old completion", () => {
  assert.equal(core.resolveStatus({ working: true, done: true }), "working");
  assert.equal(core.resolveStatus({ working: true, waiting: true }), "unknown");
  assert.equal(core.resolveStatus({ working: true, error: true }), "unknown");
  assert.equal(core.resolveStatus({ done: true, waiting: true }), "unknown");
  assert.equal(
    core.resolveStatus({ working: "true", done: "true" }),
    "unknown",
  );
});

test("conversation URL parsing rejects other origins, credentials, and unsupported paths", () => {
  assert.equal(
    core.conversationFromUrl(`${URL_A}?secret=excluded#fragment`).url,
    URL_A,
  );
  for (const value of [
    "http://chatgpt.com/c/abcdef",
    "https://chatgpt.com.evil.test/c/abcdef",
    "https://evil.test/c/abcdef",
    "https://user:password@chatgpt.com/c/abcdef",
    "https://chatgpt.com:8443/c/abcdef",
    "https://chatgpt.com/",
    "https://chatgpt.com/scheduled",
    "https://chatgpt.com/c/abc/extra",
    "https://chatgpt.com/c/%2fsecret",
    "not a URL",
  ])
    assert.equal(core.conversationFromUrl(value), null, value);
  assert.equal(
    core.conversationFromUrl("https://chatgpt.com/g/g-example-name/c/abcdef12")
      .conversationId,
    "abcdef12",
  );
});

test("outbound tasks contain exactly the agreed metadata, with no page body or extra fields", () => {
  const task = core.taskFromSnapshot(
    snapshot(
      { work: true, done: true },
      {
        body: "DO NOT SEND",
        token: "DO NOT SEND",
        url: `${URL_A}?private=DO-NOT-SEND`,
      },
    ),
    { autoDetect: true },
    NOW,
  );
  assert.deepEqual(Object.keys(task).sort(), [
    "id",
    "project",
    "status",
    "title",
    "updatedAt",
    "url",
  ]);
  assert.equal(task.title, "企画書を仕上げる");
  assert.equal(task.project, "ChatGPT Work");
  assert.equal(task.url, URL_A);
  assert.equal(task.updatedAt, NOW);
  assert.doesNotMatch(JSON.stringify(task), /DO.NOT.SEND/u);
  assert.deepEqual(
    core.sanitizeTask({ ...task, body: "extra", project: "untrusted" }),
    task,
  );
  assert.equal(core.sanitizeTask({ ...task, id: "work:different" }), null);
  assert.equal(core.taskFromSnapshot(snapshot(), MANUAL, "invalid"), null);
});

test("heartbeat fingerprint ignores observation time and remains sensitive to state", () => {
  const task = core.taskFromSnapshot(snapshot({ working: true }), MANUAL, NOW);
  assert.equal(
    core.taskFingerprint(task),
    core.taskFingerprint({ ...task, updatedAt: "2026-09-13T00:01:00.000Z" }),
  );
  assert.notEqual(
    core.taskFingerprint(task),
    core.taskFingerprint({ ...task, status: "waiting" }),
  );
});

test("the manifest grants no cookie, identity, history, or broad web permission", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../extension/manifest.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage", "activeTab", "scripting"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://chatgpt.com/*",
    "http://127.0.0.1:4318/*",
  ]);
  assert.equal(manifest.content_scripts[0].all_frames, false);
});

// A small browser-worker harness verifies the transport boundary without a
// browser login or real ChatGPT DOM. These are synthetic tests, not selector QA.
async function workerHarness(initial = {}) {
  const [workerSource, coreSource] = await Promise.all([
    readFile(new URL("../extension/background.js", import.meta.url), "utf8"),
    readFile(new URL("../extension/observer-core.js", import.meta.url), "utf8"),
  ]);
  const requests = [];
  const events = {};
  const accessLevels = [];
  let activeUrl = URL_A;
  let currentSnapshot = snapshot({ work: true, working: true });
  const makeStorage = (data) => ({
    async get(key) {
      if (key === null) return { ...data };
      return { [key]: data[key] };
    },
    async set(update) {
      Object.assign(data, structuredClone(update));
    },
    async remove(key) {
      delete data[key];
    },
    async setAccessLevel(value) {
      accessLevels.push(value);
    },
  });
  const chrome = {
    storage: {
      local: makeStorage({
        workroomSettings: {
          pairCode: "test-pairing-code",
          autoDetect: true,
          manualIds: [],
          excludedIds: [],
          ...initial,
        },
      }),
      session: makeStorage({}),
    },
    runtime: {
      id: "extension-test",
      getURL: (path) => `chrome-extension://extension-test/${path}`,
      onMessage: {
        addListener: (callback) => {
          events.message = callback;
        },
      },
    },
    tabs: {
      async query() {
        return [{ id: 42, url: activeUrl, title: "企画書 - ChatGPT" }];
      },
      async sendMessage(_id, message) {
        return message.type === "workroom:inspect"
          ? { ok: true, snapshot: currentSnapshot }
          : { ok: true };
      },
      onRemoved: {
        addListener: (callback) => {
          events.removed = callback;
        },
      },
      onUpdated: {
        addListener: (callback) => {
          events.updated = callback;
        },
      },
    },
    scripting: {
      async executeScript() {
        return [];
      },
    },
  };
  let responseStatus = 200;
  const context = vm.createContext({
    chrome,
    URL,
    AbortSignal,
    console,
    setTimeout,
    clearTimeout,
    fetch: async (url, options) => {
      requests.push({ url, ...options, payload: JSON.parse(options.body) });
      return { ok: responseStatus === 200, status: responseStatus };
    },
  });
  context.importScripts = () => vm.runInContext(coreSource, context);
  vm.runInContext(workerSource, context);
  const popupSender = {
    id: "extension-test",
    url: "chrome-extension://extension-test/popup.html",
  };
  const tabSender = () => ({
    id: "extension-test",
    tab: { id: 42, url: activeUrl },
    url: activeUrl,
    frameId: 0,
  });
  function send(message, sender) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("worker did not respond")),
        2000,
      );
      const accepted = events.message(message, sender, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });
      if (!accepted) {
        clearTimeout(timeout);
        resolve(null);
      }
    });
  }
  return {
    requests,
    accessLevels,
    observe: (data) =>
      send({ type: "workroom:observe", snapshot: data }, tabSender()),
    popup: (message) => send(message, popupSender),
    send,
    setUrl: (url) => {
      activeUrl = url;
      currentSnapshot = snapshot({}, { url });
    },
    setSnapshot: (value) => {
      currentSnapshot = value;
    },
    setResponse: (value) => {
      responseStatus = value;
    },
  };
}

test("worker only sends sanitized metadata to the fixed authenticated loopback endpoint", async () => {
  const worker = await workerHarness();
  const result = await worker.observe(
    snapshot(
      { work: true, working: true },
      { body: "private", title: "<script>title</script>" },
    ),
  );
  assert.equal(result.ok, true);
  const request = worker.requests[0];
  assert.equal(request.url, "http://127.0.0.1:4318/api/cloud");
  assert.equal(request.headers.Authorization, "Bearer test-pairing-code");
  assert.equal(request.credentials, "omit");
  assert.equal(request.redirect, "error");
  assert.equal(request.payload.observerId, "42");
  assert.deepEqual(Object.keys(request.payload).sort(), [
    "observerId",
    "tasks",
  ]);
  assert.deepEqual(Object.keys(request.payload.tasks[0]).sort(), [
    "id",
    "project",
    "status",
    "title",
    "updatedAt",
    "url",
  ]);
  assert.equal(request.payload.tasks[0].status, "working");
  assert.equal(worker.accessLevels[0].accessLevel, "TRUSTED_CONTEXTS");
});

test("worker emits no traffic for unselected ordinary chats, then respects explicit selection and stop", async () => {
  const worker = await workerHarness();
  worker.setSnapshot(snapshot({ working: true }));
  await worker.observe(snapshot({ working: true }));
  assert.equal(worker.requests.length, 0);
  await worker.popup({ type: "workroom:track-current", enabled: true });
  assert.equal(worker.requests[0].payload.tasks[0].status, "working");
  await worker.popup({ type: "workroom:track-current", enabled: false });
  assert.deepEqual(worker.requests[1].payload.tasks, []);
  await worker.observe(snapshot({ work: true, working: true }));
  assert.equal(
    worker.requests.length,
    2,
    "explicit stop also excludes automatic tracking",
  );
});

test("worker retains state-change time across heartbeats and retires a navigating observer", async () => {
  const worker = await workerHarness();
  await worker.observe(snapshot({ work: true, working: true }));
  await worker.observe(snapshot({ work: true, working: true }));
  assert.equal(
    worker.requests[0].payload.tasks[0].updatedAt,
    worker.requests[1].payload.tasks[0].updatedAt,
  );
  worker.setUrl(URL_B);
  await worker.observe(snapshot({}, { url: URL_B }));
  assert.deepEqual(worker.requests[2].payload, { observerId: "42", tasks: [] });
});

test("worker rejects untrusted senders, subframes, and a different conversation URL", async () => {
  const worker = await workerHarness();
  const message = {
    type: "workroom:observe",
    snapshot: snapshot({ work: true }),
  };
  assert.equal(
    await worker.send(message, {
      id: "other",
      tab: { id: 42 },
      url: URL_A,
      frameId: 0,
    }),
    null,
  );
  assert.equal(
    await worker.send(message, {
      id: "extension-test",
      tab: { id: 42, url: URL_A },
      url: URL_A,
      frameId: 1,
    }),
    null,
  );
  assert.equal(
    await worker.send(message, {
      id: "extension-test",
      tab: { id: 42, url: URL_B },
      url: URL_B,
      frameId: 0,
    }),
    null,
  );
  assert.equal(
    await worker.send(
      { type: "workroom:save-settings", pairCode: "injected-code" },
      {
        id: "extension-test",
        tab: { id: 42, url: URL_A },
        url: URL_A,
        frameId: 0,
      },
    ),
    null,
  );
  assert.equal(worker.requests.length, 0);
});

test("worker reports a rejected pair code as failure and never returns the saved code to popup", async () => {
  const worker = await workerHarness();
  worker.setResponse(401);
  const result = await worker.observe(snapshot({ work: true, working: true }));
  assert.equal(result.ok, false);
  assert.equal(result.connection, "unauthorized");
  const state = await worker.popup({ type: "workroom:popup-state" });
  assert.equal(state.connection, "unauthorized");
  assert.doesNotMatch(JSON.stringify(state), /test-pairing-code/u);
});
