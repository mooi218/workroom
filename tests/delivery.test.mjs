import test from "node:test";
import assert from "node:assert/strict";
import { createDeliveryTracker } from "../public/delivery.js";

const task = (status, extra = {}) => ({
  id: "task-a",
  source: "codex",
  title: "A response",
  status,
  ...extra,
});

test("initial and newly discovered historical completions do not notify", () => {
  const tracker = createDeliveryTracker();
  assert.deepEqual(tracker.observe([task("done")]), []);
  assert.deepEqual(
    tracker.observe([task("done"), task("done", { id: "older" })]),
    [],
  );
  assert.deepEqual(tracker.entries(), []);
  const demo = Array.from({ length: 15 }, (_, i) =>
    task("done", { id: `demo-${i}` }),
  );
  assert.deepEqual(tracker.observe(demo, { scope: "demo" }), []);
  assert.deepEqual(tracker.entries("demo"), []);
});

test("an observed response finishing is retained once, even when metadata refreshes", () => {
  const at = Date.parse("2026-09-13T10:15:00Z"),
    tracker = createDeliveryTracker({ now: () => at });
  assert.deepEqual(tracker.observe([task("working")]), []);
  const created = tracker.observe([task("done")]);
  assert.equal(created.length, 1);
  assert.equal(created[0].title, "A response");
  assert.equal(created[0].taskId, "task-a");
  assert.equal(created[0].at, at);
  assert.deepEqual(
    tracker.observe([task("done", { updatedAt: "2026-09-13T10:20:00Z" })]),
    [],
  );
  assert.equal(tracker.entries().length, 1);
  assert.equal(tracker.acknowledge(created[0].id), true);
  assert.equal(tracker.entries()[0].acknowledged, true);
  assert.deepEqual(tracker.observe([task("done")]), []);
});

test("the same task can deliver a later response after another active cycle", () => {
  const tracker = createDeliveryTracker();
  tracker.observe([task("working")]);
  const first = tracker.observe([task("done")])[0];
  tracker.acknowledge(first.id);
  tracker.observe([task("waiting")]);
  const second = tracker.observe([task("done")])[0];
  assert.notEqual(first.id, second.id);
  assert.equal(second.acknowledged, false);
  assert.equal(tracker.entries().length, 2);
});

test("known active responses survive unknown or error connection states", () => {
  for (const intermediate of ["unknown", "error"]) {
    const tracker = createDeliveryTracker();
    tracker.observe([task("working")]);
    tracker.observe([task(intermediate)]);
    assert.equal(tracker.observe([task("done")]).length, 1);
    tracker.observe([task(intermediate)]);
    assert.deepEqual(tracker.observe([task("done")]), []);
  }
  const tracker = createDeliveryTracker();
  tracker.observe([task("waiting")]);
  tracker.observe([task("unknown")]);
  tracker.observe([task("error")]);
  assert.equal(tracker.observe([task("done")]).length, 1);
});

test("unknown, error, and idle states alone are not evidence of a newly finished response", () => {
  for (const status of ["unknown", "error", "idle"]) {
    const tracker = createDeliveryTracker();
    tracker.observe([task(status)]);
    assert.deepEqual(tracker.observe([task("done")]), []);
  }
  const tracker = createDeliveryTracker();
  tracker.observe([task("working")]);
  tracker.observe([task("idle")]);
  tracker.observe([task("unknown")]);
  assert.deepEqual(tracker.observe([task("done")]), []);
});

test("explicit turn identities reject replayed completions and allow a new turn", () => {
  const tracker = createDeliveryTracker();
  tracker.observe([task("working", { turnId: "one" })]);
  assert.equal(tracker.observe([task("done", { turnId: "one" })]).length, 1);
  tracker.observe([task("working", { turnId: "one" })]);
  assert.deepEqual(tracker.observe([task("done", { turnId: "one" })]), []);
  tracker.observe([task("working", { turnId: "two" })]);
  assert.equal(tracker.observe([task("done", { turnId: "two" })]).length, 1);
  assert.equal(tracker.entries().length, 2);
  const historical = createDeliveryTracker();
  historical.observe([task("done", { turnId: "old" })]);
  historical.observe([task("working", { turnId: "old" })]);
  assert.deepEqual(historical.observe([task("done", { turnId: "old" })]), []);
});

test("an active old turn does not imply an unobserved new turn finished", () => {
  const tracker = createDeliveryTracker();
  tracker.observe([task("working", { turnId: "one" })]);
  tracker.observe([task("unknown", { turnId: "two" })]);
  assert.deepEqual(tracker.observe([task("done", { turnId: "two" })]), []);
});

test("live and demo histories and acknowledgements stay separate", () => {
  const tracker = createDeliveryTracker(),
    live = task("working", { title: "Private live title" }),
    demo = task("working", { title: "Public example" });
  tracker.observe([live]);
  tracker.observe([demo], { scope: "demo" });
  const example = tracker.observe([{ ...demo, status: "done" }], {
    scope: "demo",
  })[0];
  assert.equal(tracker.entries("demo")[0].title, "Public example");
  assert.deepEqual(tracker.entries("live"), []);
  const real = tracker.observe([{ ...live, status: "done" }], {
    scope: "live",
  })[0];
  assert.equal(tracker.acknowledge(real.id, { scope: "demo" }), false);
  assert.equal(tracker.acknowledge(example.id, { scope: "demo" }), true);
  assert.equal(tracker.entries("live")[0].acknowledged, false);
  assert.ok(
    tracker.entries("demo").every((entry) => !entry.title.includes("Private")),
  );
  tracker.reset("demo");
  assert.deepEqual(tracker.entries("demo"), []);
  assert.equal(tracker.entries("live").length, 1);
});

test("history is bounded to thirty entries in memory across both scopes", () => {
  const tracker = createDeliveryTracker();
  for (let i = 0; i < 45; i++) {
    const scope = i < 25 ? "live" : "demo";
    tracker.observe([task("working", { title: `Response ${i}` })], { scope });
    tracker.observe([task("done", { title: `Response ${i}` })], { scope });
  }
  const live = tracker.entries("live"),
    demo = tracker.entries("demo");
  assert.equal(live.length + demo.length, 30);
  assert.equal(live.length, 10);
  assert.equal(demo.length, 20);
  assert.equal(demo[0].title, "Response 44");
  assert.equal(live.at(-1).title, "Response 15");
});

test("a missing task and an explicit reset start a fresh observation baseline", () => {
  const tracker = createDeliveryTracker();
  tracker.observe([task("working")]);
  tracker.observe([]);
  assert.deepEqual(tracker.observe([task("done")]), []);
  tracker.observe([task("working")]);
  assert.equal(tracker.observe([task("done")]).length, 1);
  tracker.reset();
  assert.deepEqual(tracker.entries(), []);
  assert.deepEqual(tracker.observe([task("done")]), []);
});

test("multiple seats for one task create one delivery, and source identities remain distinct", () => {
  const tracker = createDeliveryTracker();
  const seats = (status) => [
    task(status, { id: "seat-engineer", taskId: "shared" }),
    task(status, { id: "seat-designer", taskId: "shared" }),
    task(status, { id: "shared", source: "work" }),
  ];
  tracker.observe(seats("working"));
  const created = tracker.observe(seats("done"));
  assert.equal(created.length, 2);
  assert.ok(created.every((entry) => entry.taskId === "shared"));
  assert.notEqual(created[0].key, created[1].key);
});

test("input metadata and returned history cannot be used to mutate tracker state", () => {
  const tracker = createDeliveryTracker(),
    title = '<img src=x onerror="unsafe">';
  const active = Object.freeze(task("working", { title })),
    done = Object.freeze(task("done", { title }));
  tracker.observe(Object.freeze([active]));
  const result = tracker.observe(Object.freeze([done]));
  assert.equal(result[0].title, title);
  result[0].title = "Changed externally";
  tracker.entries()[0].acknowledged = true;
  assert.equal(tracker.entries()[0].title, title);
  assert.equal(tracker.entries()[0].acknowledged, false);
  assert.equal(active.status, "working");
  assert.equal(done.status, "done");
});
