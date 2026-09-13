import test from "node:test";
import assert from "node:assert/strict";
import { createDeliveryTray } from "../public/delivery.js";

// Small DOM contract fixture. HTML assignment is rejected so unsafe rendering
// fails the test instead of being silently accepted by an incomplete fake DOM.
class Element {
  constructor(tag, doc) {
    this.tagName = tag.toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.attributes = new Map();
    this.className = "";
    this.dataset = {};
    this.hidden = false;
    this.style = { setProperty() {} };
    this.classList = {
      toggle: (name, force) => {
        const classes = new Set(this.className.split(/\s+/).filter(Boolean));
        const enabled = force ?? !classes.has(name);
        if (enabled) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(" ");
        return enabled;
      },
    };
  }
  set innerHTML(_) {
    throw new Error("Untrusted HTML must never be assigned");
  }
  set textContent(value) {
    this.children = [];
    this.value = String(value ?? "");
  }
  get textContent() {
    return (
      (this.value || "") +
      this.children.map((child) => child.textContent).join("")
    );
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    this.value = "";
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (child) => child !== this,
      );
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name);
  }
  addEventListener() {}
  removeEventListener() {}
  contains(target) {
    return (
      this === target || this.children.some((child) => child.contains(target))
    );
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
}
function find(root, className) {
  if (root.className.split(/\s+/).includes(className)) return root;
  for (const child of root.children) {
    const result = find(child, className);
    if (result) return result;
  }
  return null;
}
function fixture(t, getReply) {
  const doc = {
    documentElement: { lang: "en" },
    hidden: false,
    activeElement: null,
    createElement(tag) {
      return new Element(tag, doc);
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const panel = new Element("section", doc),
    opened = [];
  const tray = createDeliveryTray({
    panel,
    getMotion: () => false,
    getReply,
    onOpenTask: (id) => opened.push(id),
  });
  t.after(() => tray.destroy());
  return { panel, tray, opened };
}
function complete(tray, scope = "live", turnId = "turn-one", source = "codex") {
  const task = { id: "task-a", title: `${scope} title`, source, turnId };
  tray.observe([{ ...task, status: "working" }], { scope });
  return tray.observe([{ ...task, status: "done" }], { scope })[0];
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function result(entry, text, extra = {}) {
  return {
    status: "available",
    taskId: entry.taskId,
    turnId: entry.turnId,
    text,
    truncated: false,
    ...extra,
  };
}

test("completion replies load only on expansion, preserve code as text, and cache without opening the task", async (t) => {
  const wait = deferred(),
    calls = [];
  const { tray, panel, opened } = fixture(t, (entry, options) => {
    calls.push({ entry, options });
    return wait.promise;
  });
  complete(tray);
  assert.equal(calls.length, 0);
  find(panel, "delivery-task-title").onclick();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].entry.scope, "live");
  assert.equal(calls[0].entry.source, "codex");
  assert.equal(calls[0].entry.turnId, "turn-one");
  assert.equal(find(panel, "delivery-history").hidden, false);
  assert.match(panel.textContent, /Loading this reply/);
  assert.deepEqual(opened, []);
  const text =
    "A reply\n\n```html\n<img src=x onerror=alert(1)>\n```\n  indentation";
  wait.resolve(result(calls[0].entry, text));
  await flush();
  const body = find(panel, "delivery-reply-text");
  assert.equal(body.textContent, text);
  assert.equal(body.tagName, "PRE");
  assert.equal(body.children.length, 0);
  find(panel, "delivery-reply-toggle").onclick();
  assert.equal(find(panel, "delivery-reply-text"), null);
  find(panel, "delivery-reply-toggle").onclick();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(find(panel, "delivery-reply-text").textContent, text);
  find(panel, "delivery-view-task").onclick();
  assert.deepEqual(opened, ["task-a"]);
});

test("failed requests and mismatched turns show fixed feedback and can be retried", async (t) => {
  let attempts = 0;
  const { tray, panel } = fixture(t, async (entry) => {
    attempts++;
    if (attempts === 1) throw new Error("PRIVATE SERVER DETAILS");
    if (attempts === 2)
      return result(entry, "WRONG REPLY", { turnId: "wrong-turn" });
    return result(entry, "Safe truncated reply", { truncated: true });
  });
  complete(tray);
  find(panel, "delivery-task-title").onclick();
  await flush();
  assert.match(panel.textContent, /could not be loaded/);
  assert.equal(panel.textContent.includes("PRIVATE SERVER"), false);
  find(panel, "delivery-reply-retry").onclick();
  await flush();
  assert.equal(find(panel, "delivery-reply-text"), null);
  assert.equal(panel.textContent.includes("WRONG REPLY"), false);
  find(panel, "delivery-reply-retry").onclick();
  await flush();
  assert.equal(
    find(panel, "delivery-reply-text").textContent,
    "Safe truncated reply",
  );
  assert.match(panel.textContent, /reply is shortened/);
});

test("scope switches cancel reads and late private replies cannot leak into demo or populate its cache", async (t) => {
  const late = deferred(),
    calls = [];
  const { tray, panel } = fixture(t, (entry, options) => {
    calls.push({ entry, options });
    if (entry.scope === "demo")
      return Promise.resolve({ status: "unsupported" });
    return calls.filter((call) => call.entry.scope === "live").length === 1
      ? late.promise
      : Promise.resolve(result(entry, "Fresh live read"));
  });
  complete(tray);
  find(panel, "delivery-task-title").onclick();
  await flush();
  complete(tray, "demo");
  assert.equal(calls[0].options.signal.aborted, true);
  find(panel, "delivery-task-title").onclick();
  await flush();
  assert.match(panel.textContent, /local Codex tasks/);
  late.resolve(result(calls[0].entry, "PRIVATE LATE LIVE REPLY"));
  await flush();
  assert.equal(panel.textContent.includes("PRIVATE LATE"), false);
  tray.observe(
    [
      {
        id: "task-a",
        title: "live title",
        source: "codex",
        turnId: "turn-one",
        status: "done",
      },
    ],
    { scope: "live" },
  );
  assert.equal(find(panel, "delivery-reply-text"), null);
  find(panel, "delivery-reply-toggle").onclick();
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(
    find(panel, "delivery-reply-text").textContent,
    "Fresh live read",
  );
});

test("collapsing and destroying cancel pending reads without applying stale results", async (t) => {
  const first = deferred(),
    last = deferred(),
    calls = [];
  const { tray, panel } = fixture(t, (entry, options) => {
    calls.push({ entry, options });
    return calls.length === 1 ? first.promise : last.promise;
  });
  complete(tray);
  find(panel, "delivery-task-title").onclick();
  await flush();
  find(panel, "delivery-reply-toggle").onclick();
  assert.equal(calls[0].options.signal.aborted, true);
  first.resolve(result(calls[0].entry, "STALE REPLY"));
  await flush();
  assert.equal(find(panel, "delivery-reply-text"), null);
  find(panel, "delivery-reply-toggle").onclick();
  await flush();
  assert.equal(calls.length, 2);
  tray.destroy();
  assert.equal(calls[1].options.signal.aborted, true);
  last.resolve(result(calls[1].entry, "AFTER DESTROY"));
  await flush();
  assert.equal(panel.children.length, 0);
});

test("unsupported and unavailable replies retain a separate task-open action", async (t) => {
  const { tray, panel, opened } = fixture(t, async () => ({
    status: "unavailable",
  }));
  complete(tray, "live", "missing-old-turn", "work");
  find(panel, "delivery-task-title").onclick();
  await flush();
  assert.match(panel.textContent, /completed reply is not available/);
  assert.equal(find(panel, "delivery-reply-text"), null);
  find(panel, "delivery-view-task").onclick();
  assert.deepEqual(opened, ["task-a"]);
});

test("fictional demo replies are labeled and cannot be displayed as live replies", async (t) => {
  const { tray, panel } = fixture(t, async (entry) =>
    result(entry, "A fictional example", { fictional: true }),
  );
  complete(tray, "demo", null);
  find(panel, "delivery-task-title").onclick();
  await flush();
  assert.equal(
    find(panel, "delivery-reply-text").textContent,
    "A fictional example",
  );
  assert.match(panel.textContent, /Sample reply/);
  complete(tray, "live", "real-turn");
  find(panel, "delivery-task-title").onclick();
  await flush();
  assert.equal(find(panel, "delivery-reply-text"), null);
  assert.equal(panel.textContent.includes("fictional example"), false);
});
