import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodexSource } from "../lib/codex-source.mjs";

const tempRoot = path.resolve(process.env.WORKROOM_TEST_TMP || tmpdir());
async function fixture(t) {
  const root = await mkdtemp(path.join(tempRoot, "workroom-reply-"));
  const state = new DatabaseSync(path.join(root, "state_5.sqlite"));
  state.exec(
    "CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, archived INTEGER DEFAULT 0, source TEXT, thread_source TEXT)",
  );
  state
    .prepare("INSERT INTO threads(id,title) VALUES(?,?)")
    .run("task", "Synthetic task");
  const history = new DatabaseSync(path.join(root, "thread_history_1.sqlite"));
  history.exec(`CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,rollout_ordinal INTEGER,status TEXT,started_at INTEGER,completed_at INTEGER,final_agent_item_id TEXT);
    CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,item_type TEXT,item_json TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,PRIMARY KEY(thread_id,turn_id,item_id));`);
  const source = createCodexSource({ codexHome: root });
  t.after(async () => {
    await source.close();
    state.close();
    history.close();
    assert.equal(path.dirname(path.resolve(root)), tempRoot);
    assert.ok(path.basename(root).startsWith("workroom-reply-"));
    await rm(root, { recursive: true, force: true });
  });
  const turn = (id, ordinal, status = "completed", finalId = "final") =>
    history
      .prepare("INSERT INTO thread_turns VALUES(?,?,?,?,?,?,?)")
      .run(
        "task",
        id,
        ordinal,
        status,
        1789300000,
        status === "completed" ? 1789300010 : null,
        finalId,
      );
  const item = (turnId, id, type, value, ordinal = 1) =>
    history
      .prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?)")
      .run(
        "task",
        turnId,
        id,
        type,
        JSON.stringify(value),
        ordinal,
        1789300010000,
      );
  return { root, state, history, source, turn, item };
}

test("reply lookup returns only the exact completed turn's final assistant text and leaves snapshots metadata-only", async (t) => {
  const { root, source, turn, item } = await fixture(t);
  turn("older", 1);
  turn("latest", 20);
  const expected = "First answer\n\n```html\n<img src=x onerror=alert(1)>\n```";
  item("older", "prompt", "userMessage", {
    type: "userMessage",
    text: "PRIVATE PROMPT",
  });
  item("older", "thinking", "reasoning", {
    type: "reasoning",
    text: "PRIVATE REASONING",
  });
  item("older", "final", "agentMessage", {
    type: "agentMessage",
    phase: "final_answer",
    text: expected,
    questions: { secret: "PRIVATE METADATA" },
  });
  item(
    "older",
    "comment",
    "agentMessage",
    { type: "agentMessage", phase: "commentary", text: "PRIVATE COMMENTARY" },
    99,
  );
  item(
    "latest",
    "final",
    "agentMessage",
    { type: "agentMessage", phase: "final_answer", text: "A NEWER ANSWER" },
    20,
  );
  const before = await readFile(path.join(root, "thread_history_1.sqlite"));
  const result = await source.getReply("task", { turnId: "older" });
  assert.equal(result.status, "available");
  assert.equal(result.text, expected);
  assert.equal(result.turnId, "older");
  assert.equal(result.taskId, "task");
  assert.equal(result.truncated, false);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.deepEqual(
    await readFile(path.join(root, "thread_history_1.sqlite")),
    before,
  );
  const snapshot = await source.snapshot();
  assert.equal(snapshot.tasks[0].turnId, "latest");
  assert.equal("text" in snapshot.tasks[0], false);
  assert.equal(JSON.stringify(snapshot).includes("A NEWER ANSWER"), false);
});

test("missing and unfinished historical turns never substitute a latest reply", async (t) => {
  const { source, turn, item } = await fixture(t);
  turn("latest", 10);
  item("latest", "final", "agentMessage", {
    type: "agentMessage",
    phase: "final_answer",
    text: "LATEST SECRET",
  });
  turn("running", 20, "inProgress");
  turn("failed", 30, "failed");
  turn("missing-item", 40);
  turn("missing-pointer", 50, "completed", null);
  for (const id of [
    "absent",
    "running",
    "failed",
    "missing-item",
    "missing-pointer",
  ]) {
    const result = await source.getReply("task", { turnId: id });
    assert.equal(result.status, "unavailable");
    assert.equal(result.turnId, id);
    assert.equal("text" in result, false);
  }
  for (const options of [undefined, null, {}, { turnId: "" }])
    assert.equal(
      (await source.getReply("task", options)).reason,
      "exact_turn_required",
    );
});

test("final pointers cannot reveal user, tool, reasoning, commentary, or another turn's content", async (t) => {
  const { source, turn, item } = await fixture(t);
  for (const [index, type] of [
    "userMessage",
    "reasoning",
    "mcpToolCall",
    "agentMessage",
  ].entries()) {
    const id = `wrong-${index}`;
    turn(id, index);
    item(id, "final", type, {
      type,
      phase: type === "agentMessage" ? "commentary" : "final_answer",
      text: "PRIVATE",
    });
    assert.equal(
      (await source.getReply("task", { turnId: id })).status,
      "unavailable",
    );
  }
  turn("first", 10);
  turn("second", 20);
  item("second", "final", "agentMessage", {
    type: "agentMessage",
    phase: "final_answer",
    text: "OTHER TURN",
  });
  assert.equal(
    (await source.getReply("task", { turnId: "first" })).status,
    "unavailable",
  );
});

test("reply bytes are capped with valid UTF-8 and explicit truncation metadata", async (t) => {
  const { source, turn, item } = await fixture(t);
  const text = "a" + "🙂".repeat(20000);
  turn("large", 1);
  item("large", "final", "agentMessage", {
    type: "agentMessage",
    phase: "final_answer",
    text,
  });
  const result = await source.getReply("task", { turnId: "large" });
  assert.equal(result.status, "available");
  assert.equal(result.truncated, true);
  assert.equal(result.totalBytes, Buffer.byteLength(text));
  assert.ok(Buffer.byteLength(result.text) <= 65536);
  assert.equal(result.text.includes("�"), false);
  assert.ok(text.startsWith(result.text));
});

test("unsupported history, internal tasks and closing reads fail without exposing content", async (t) => {
  const { source, state, history, turn, item } = await fixture(t);
  turn("a", 1);
  item("a", "final", "agentMessage", {
    type: "agentMessage",
    phase: "final_answer",
    text: "PRIVATE",
  });
  state.exec("UPDATE threads SET thread_source='guardian_review'");
  assert.equal(
    (await source.getReply("task", { turnId: "a" })).status,
    "unavailable",
  );
  state.exec("UPDATE threads SET thread_source=NULL");
  history.exec("ALTER TABLE thread_turns DROP COLUMN final_agent_item_id");
  assert.equal(
    (await source.getReply("task", { turnId: "a" })).reason,
    "unsupported_history",
  );
  const pending = source.getReply("task", { turnId: "a" });
  await source.close();
  assert.equal((await pending).status, "unavailable");
  assert.equal(
    (await source.getReply("task", { turnId: "a" })).reason,
    "closed",
  );
});
