import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtemp,
  mkdir,
  writeFile,
  appendFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createCodexSource } from "../lib/codex-source.mjs";

const TEST_TMP = path.resolve(process.env.WORKROOM_TEST_TMP || tmpdir());

async function removeFixture(root) {
  const resolved = path.resolve(root);
  assert.equal(path.dirname(resolved), TEST_TMP);
  assert.equal(path.basename(resolved).startsWith("workroom-"), true);
  await rm(resolved, { recursive: true, force: true });
}

async function fixture(t, { history = true, legacy = false } = {}) {
  const root = await mkdtemp(path.join(TEST_TMP, "workroom-source-"));
  await mkdir(path.join(root, "sessions"));
  const db = new DatabaseSync(path.join(root, "state_5.sqlite"));
  if (legacy)
    db.exec(
      "CREATE TABLE threads(id TEXT PRIMARY KEY, title TEXT, archived INTEGER, rollout_path TEXT, updated_at INTEGER, cwd TEXT)",
    );
  else
    db.exec(`
    CREATE TABLE threads(id TEXT PRIMARY KEY, name TEXT, title TEXT, archived INTEGER DEFAULT 0,
      rollout_path TEXT, updated_at_ms INTEGER, created_at_ms INTEGER, cwd TEXT, project_id TEXT,
      source TEXT, thread_source TEXT, agent_role TEXT, agent_nickname TEXT, agent_path TEXT, first_user_message TEXT);
    CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT);
  `);
  let hd;
  if (history) {
    hd = new DatabaseSync(path.join(root, "thread_history_1.sqlite"));
    hd.exec(`
      CREATE TABLE thread_turns(thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER,
        status TEXT, started_at INTEGER, completed_at INTEGER, error_json TEXT, rollout_byte_offset INTEGER);
      CREATE INDEX idx_thread_turns_page ON thread_turns(thread_id, rollout_ordinal);
      CREATE TABLE thread_items(thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, created_at_ms INTEGER, item_type TEXT, item_json TEXT);
      CREATE INDEX idx_thread_items_page ON thread_items(thread_id, turn_id, rollout_ordinal);
    `);
  }
  const source = createCodexSource({ codexHome: root, staleMs: 60_000 });
  t.after(async () => {
    await source.close();
    db.close();
    hd?.close();
    await removeFixture(root);
  });
  return { root, db, hd, source };
}

function insert(db, table, values) {
  const keys = Object.keys(values);
  db.prepare(
    `INSERT INTO ${table}(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`,
  ).run(...Object.values(values));
}

function event(type, at, extra = {}) {
  return (
    JSON.stringify({
      type: "event_msg",
      timestamp: new Date(at).toISOString(),
      payload: { type, ...extra },
    }) + "\n"
  );
}

function toolEvent(name, args, at, type = "custom_tool_call") {
  return (
    JSON.stringify({
      type: "response_item",
      timestamp: new Date(at).toISOString(),
      payload: { type, name, input: args },
    }) + "\n"
  );
}

function item(hd, threadId, turnId, ordinal, value, at = Date.now() - 1000) {
  insert(hd, "thread_items", {
    thread_id: threadId,
    turn_id: turnId,
    rollout_ordinal: ordinal,
    created_at_ms: at,
    item_type: value.type,
    item_json: JSON.stringify(value),
  });
}

test("task groups use the latest root title, count root work, and keep same-basename folders separate", async (t) => {
  const { db, source } = await fixture(t);
  const now = Date.now();
  const location = "/PRIVATE_MACHINE/one/c";
  insert(db, "threads", {
    id: "older",
    name: "Prepare launch artwork",
    cwd: location,
    updated_at_ms: now - 5000,
  });
  insert(db, "threads", {
    id: "newer",
    name: "Contact prospective customers",
    cwd: location,
    updated_at_ms: now - 1000,
  });
  insert(db, "threads", {
    id: "child",
    title: "Produce a cover",
    cwd: location,
    updated_at_ms: now,
    source: JSON.stringify({
      subagent: {
        thread_spawn: { parent_thread_id: "older", agent_nickname: "Ada" },
      },
    }),
  });
  insert(db, "threads", {
    id: "different",
    name: "Review a separate launch",
    cwd: "/PRIVATE_MACHINE/two/c",
    updated_at_ms: now,
  });
  const first = await source.snapshot();
  const byId = new Map(first.tasks.map((task) => [task.id, task]));
  for (const id of ["older", "newer", "child"]) {
    const task = byId.get(id);
    assert.equal(task.projectName, "Contact prospective customers");
    assert.equal(task.project, task.projectName);
    assert.equal(task.projectKind, "task-group");
    assert.equal(task.projectTaskCount, 2);
    assert.equal(task.projectMemberCount, 3);
    assert.equal(task.projectKey, byId.get("older").projectKey);
    assert.match(task.projectKey, /^task-group:[a-f0-9]{24}$/);
  }
  assert.notEqual(
    byId.get("different").projectKey,
    byId.get("older").projectKey,
  );
  assert.equal(byId.get("different").projectName, "Review a separate launch");
  assert.equal(JSON.stringify(first).includes("PRIVATE_MACHINE"), false);
  db.prepare("UPDATE threads SET name=? WHERE id='newer'").run(
    "Follow up with prospective customers",
  );
  const renamed = (await source.snapshot()).tasks.find(
    (task) => task.id === "newer",
  );
  assert.equal(renamed.projectKey, byId.get("newer").projectKey);
  assert.equal(renamed.projectName, "Follow up with prospective customers");
});

test("saved project identity takes precedence and exact registered roots support older task metadata", async (t) => {
  const { db, source } = await fixture(t);
  db.exec("CREATE TABLE project_roots(project_id TEXT, path TEXT)");
  insert(db, "projects", { id: "saved", name: "Customer launch" });
  insert(db, "project_roots", {
    project_id: "saved",
    path: "C:\\PRIVATE_MACHINE\\Launch",
  });
  insert(db, "threads", {
    id: "explicit",
    name: "An individual task",
    project_id: "saved",
    cwd: "C:\\PRIVATE_MACHINE\\Launch",
  });
  insert(db, "threads", {
    id: "registered-root",
    name: "Another individual task",
    cwd: "c:/private_machine/launch/",
  });
  insert(db, "threads", {
    id: "child",
    title: "A child task",
    source: JSON.stringify({
      subagent: { thread_spawn: { parent_thread_id: "explicit" } },
    }),
  });
  const first = await source.snapshot();
  assert.equal(first.tasks.length, 3);
  for (const task of first.tasks) {
    assert.equal(task.project, "Customer launch");
    assert.equal(task.projectName, "Customer launch");
    assert.equal(task.projectKind, "project");
    assert.equal(task.projectKey, first.tasks[0].projectKey);
    assert.equal(task.projectTaskCount, 2);
    assert.equal(task.projectMemberCount, 3);
    assert.match(task.projectKey, /^project:[a-f0-9]{24}$/);
  }
  assert.equal(JSON.stringify(first).includes("PRIVATE_MACHINE"), false);
  db.prepare("UPDATE projects SET name=? WHERE id='saved'").run(
    "Renamed customer launch",
  );
  const renamed = await source.snapshot();
  assert.equal(renamed.tasks[0].projectKey, first.tasks[0].projectKey);
  assert.equal(renamed.tasks[0].projectName, "Renamed customer launch");
});

test("unknown or ambiguous saved project links remain task groups, and absent locations do not merge unrelated work", async (t) => {
  const { db, source } = await fixture(t);
  db.exec("CREATE TABLE project_roots(project_id TEXT, path TEXT)");
  insert(db, "projects", { id: "first", name: "First saved project" });
  insert(db, "projects", { id: "second", name: "Second saved project" });
  insert(db, "projects", { id: null, name: "Unlinked saved metadata" });
  insert(db, "project_roots", { project_id: "first", path: "/ambiguous/c" });
  insert(db, "project_roots", { project_id: "second", path: "/ambiguous/c" });
  insert(db, "threads", {
    id: "ambiguous",
    name: "Check the proposal",
    cwd: "/ambiguous/c",
  });
  insert(db, "threads", {
    id: "missing-link",
    name: "Prepare the demonstration",
    cwd: "/unregistered/ag",
    project_id: "unknown",
  });
  insert(db, "threads", { id: "no-location-a", name: "Review the draft" });
  insert(db, "threads", { id: "no-location-b", name: "Plan a meeting" });
  insert(db, "threads", {
    id: "no-location-child",
    title: "Child review",
    source: JSON.stringify({
      subagent: { thread_spawn: { parent_thread_id: "no-location-a" } },
    }),
  });
  const { tasks } = await source.snapshot();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  assert.equal(
    tasks.every((task) => task.projectKind === "task-group"),
    true,
  );
  assert.equal(byId.get("ambiguous").projectName, "Check the proposal");
  assert.equal(
    byId.get("missing-link").projectName,
    "Prepare the demonstration",
  );
  assert.notEqual(
    byId.get("no-location-a").projectKey,
    byId.get("no-location-b").projectKey,
  );
  assert.equal(
    byId.get("no-location-a").projectKey,
    byId.get("no-location-child").projectKey,
  );
  assert.equal(byId.get("no-location-child").projectName, "Review the draft");
});

test("reads current turns across projects, excludes archived/internal reviewers, exposes metadata only", async (t) => {
  const { root, db, hd, source } = await fixture(t);
  const now = Date.now();
  insert(db, "projects", { id: "p1", name: "Launch" });
  for (const [id, state] of [
    ["design", "inProgress"],
    ["sales", "completed"],
    ["review", "failed"],
    ["paused", "interrupted"],
  ]) {
    insert(db, "threads", {
      id,
      name: `Task ${id}`,
      title: "PRIVATE FIRST MESSAGE",
      updated_at_ms: now,
      created_at_ms: now - 10_000,
      cwd: "C:\\private-user\\Projects\\SecondProject",
      project_id: id === "design" ? "p1" : null,
      source: "vscode",
      agent_role: id === "design" ? "designer" : null,
      first_user_message: "NEVER EXPOSE THIS",
    });
    insert(hd, "thread_turns", {
      thread_id: id,
      turn_id: `${id}-old`,
      rollout_ordinal: 1,
      status: "failed",
      started_at: Math.floor((now - 20_000) / 1000),
      completed_at: Math.floor((now - 15_000) / 1000),
    });
    insert(hd, "thread_turns", {
      thread_id: id,
      turn_id: `${id}-new`,
      rollout_ordinal: 10,
      status: state,
      started_at: Math.floor((now - 5000) / 1000),
      completed_at:
        state === "inProgress" ? null : Math.floor((now - 1000) / 1000),
      error_json: '{"private":"ERROR BODY"}',
    });
  }
  insert(db, "threads", { id: "archived", title: "Archived", archived: 1 });
  insert(db, "threads", {
    id: "guardian",
    title: "Internal",
    thread_source: "guardian_review",
  });
  insert(db, "threads", {
    id: "guardian-old",
    title: "Internal old",
    source: '{"subagent":{"other":"guardian"}}',
  });
  insert(db, "threads", {
    id: "subagent",
    title: "Writing task",
    thread_source: "subagent",
    source: '{"subagent":{"thread_spawn":{"depth":1}}}',
  });
  await writeFile(
    path.join(root, "auth.json"),
    "SECRET TOKEN MUST NEVER BE READ",
  );
  const statePath = path.join(root, "state_5.sqlite");
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const beforeHash = digest(await readFile(statePath));
  const beforeModified = (await stat(statePath)).mtimeMs;
  const { tasks, health } = await source.snapshot();
  assert.equal(health.status, "connected");
  assert.equal(tasks.length, 5);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  assert.equal(byId.get("design").status, "working");
  assert.equal(byId.get("design").project, "Launch");
  assert.equal(byId.get("design").roleHint, "designer");
  assert.equal(byId.get("sales").status, "done");
  assert.equal(byId.get("sales").project, byId.get("sales").projectName);
  assert.equal(byId.get("sales").projectKind, "task-group");
  assert.equal(byId.get("sales").projectTaskCount, 3);
  assert.equal(byId.get("review").status, "error");
  assert.equal(byId.get("paused").status, "idle");
  assert.equal(byId.get("subagent").status, "unknown");
  assert.equal(
    tasks.every((task) => task.source === "codex"),
    true,
  );
  const output = JSON.stringify({ tasks, health });
  for (const secret of [
    "PRIVATE FIRST MESSAGE",
    "NEVER EXPOSE",
    "ERROR BODY",
    "SECRET TOKEN",
    "private-user",
  ])
    assert.equal(output.includes(secret), false);
  assert.equal(digest(await readFile(statePath)), beforeHash);
  assert.equal((await stat(statePath)).mtimeMs, beforeModified);
});

test("old inProgress is unknown, recent item activity preserves working, neither is made done by elapsed time", async (t) => {
  const { db, hd, source } = await fixture(t);
  const now = Date.now();
  for (const id of ["quiet", "long-tool"]) {
    insert(db, "threads", { id, title: id, updated_at_ms: now });
    insert(hd, "thread_turns", {
      thread_id: id,
      turn_id: "turn",
      rollout_ordinal: 1,
      status: "inProgress",
      started_at: Math.floor((now - 3_600_000) / 1000),
    });
  }
  insert(hd, "thread_items", {
    thread_id: "long-tool",
    turn_id: "turn",
    rollout_ordinal: 30,
    created_at_ms: now - 1000,
    item_json: "PRIVATE TOOL OUTPUT",
  });
  const { tasks, health } = await source.snapshot();
  const quiet = tasks.find((task) => task.id === "quiet");
  assert.equal(quiet.status, "unknown");
  assert.match(quiet.summary, /長い処理/);
  assert.equal(tasks.find((task) => task.id === "long-tool").status, "working");
  assert.equal(health.staleTaskCount, 1);
});

test("unnamed subagents use verified parent and agent metadata without deleting unnamed work", async (t) => {
  const { db, source } = await fixture(t);
  db.exec(
    "CREATE TABLE thread_spawn_edges(parent_thread_id TEXT, child_thread_id TEXT, status TEXT)",
  );
  const spawn = (values) =>
    JSON.stringify({ subagent: { thread_spawn: values } });
  insert(db, "threads", {
    id: "root",
    name: "Launch website",
    title: "Private initial prompt",
  });
  insert(db, "threads", {
    id: "child",
    name: "",
    title: "",
    thread_source: "subagent",
    agent_nickname: "Ada",
    agent_path: "/root/design_assets",
    source: spawn({ parent_thread_id: "root", agent_role: "design" }),
  });
  insert(db, "threads", {
    id: "grandchild",
    title: "",
    thread_source: "subagent",
    source: spawn({
      parent_thread_id: "child",
      agent_nickname: "Grace",
      agent_path: "/root/design_assets/accessibility_audit",
    }),
  });
  insert(db, "threads", {
    id: "edge-child",
    title: "",
    thread_source: "subagent",
    source: spawn({ agent_nickname: "Lin" }),
  });
  insert(db, "thread_spawn_edges", {
    parent_thread_id: "root",
    child_thread_id: "edge-child",
    status: "open",
  });
  insert(db, "threads", { id: "unnamed-root", title: "" });
  insert(db, "threads", {
    id: "archived-parent",
    title: "Archived parent",
    archived: 1,
  });
  insert(db, "threads", {
    id: "active-child",
    title: "",
    source: spawn({
      parent_thread_id: "archived-parent",
      agent_nickname: "Turing",
    }),
  });
  insert(db, "threads", {
    id: "named-child",
    name: "Keep this chosen title",
    source: spawn({ parent_thread_id: "root", agent_nickname: "Marie" }),
  });
  insert(db, "threads", {
    id: "internal",
    title: "",
    thread_source: "guardian_review",
  });
  const { tasks } = await source.snapshot();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  assert.equal(tasks.length, 7);
  assert.equal(byId.has("archived-parent"), false);
  assert.equal(byId.has("internal"), false);
  assert.equal(byId.get("child").title, "Launch website / design assets · Ada");
  assert.equal(byId.get("child").parentId, "root");
  assert.equal(byId.get("child").agentName, "Ada");
  assert.equal(byId.get("child").agentTask, "design assets");
  assert.equal(byId.get("child").roleHint, "design");
  assert.equal(byId.get("child").isSubagent, true);
  assert.equal(byId.get("grandchild").parentId, "child");
  assert.match(byId.get("grandchild").title, /Launch website.*Grace/);
  assert.equal(byId.get("edge-child").parentId, "root");
  assert.equal(byId.get("edge-child").agentName, "Lin");
  assert.equal(byId.get("active-child").title, "Archived parent / Turing");
  assert.equal(byId.get("named-child").title, "Keep this chosen title");
  assert.equal(byId.get("unnamed-root").title, "無題のタスク");
  assert.equal(byId.get("unnamed-root").isSubagent, false);
  assert.equal(byId.get("root").isSubagent, false);
});

test("legacy JSONL tail observes explicit transitions and ignores partial writes and large private outputs", async (t) => {
  const { root, db, source } = await fixture(t, {
    history: false,
    legacy: true,
  });
  const now = Date.now();
  const rollout = path.join(root, "sessions", "rollout-test.jsonl");
  insert(db, "threads", {
    id: "legacy",
    title: "Legacy task",
    archived: 0,
    rollout_path: rollout,
    updated_at: Math.floor(now / 1000),
    cwd: "/projects/Example",
  });
  await writeFile(rollout, event("task_started", now - 9000, { turn_id: "a" }));
  assert.equal((await source.snapshot()).tasks[0].status, "working");
  await appendFile(
    rollout,
    JSON.stringify({
      type: "response_item",
      timestamp: new Date(now - 8000).toISOString(),
      payload: {
        type: "function_call_output",
        call_id: "large",
        output: "PRIVATE".repeat(20_000),
      },
    }) +
      "\n" +
      event("task_complete", now - 7000, {
        turn_id: "a",
        last_agent_message: "PRIVATE FINAL ANSWER",
      }),
  );
  const done = await source.snapshot();
  assert.equal(done.tasks[0].status, "done");
  assert.equal(JSON.stringify(done).includes("PRIVATE"), false);
  await appendFile(
    rollout,
    event("task_started", now - 6000, { turn_id: "b" }),
  );
  assert.equal((await source.snapshot()).tasks[0].status, "working");
  const partial = event("task_complete", now - 5000, {
    turn_id: "b",
  }).trimEnd();
  await appendFile(rollout, partial);
  assert.equal((await source.snapshot()).tasks[0].status, "working");
  await appendFile(rollout, "\n");
  assert.equal((await source.snapshot()).tasks[0].status, "done");
  await appendFile(
    rollout,
    event("task_started", now - 4000, { turn_id: "c" }) +
      event("turn_aborted", now - 3000, { turn_id: "c" }),
  );
  assert.equal((await source.snapshot()).tasks[0].status, "idle");
});

test("waiting uses explicit calls and matching resolution; generic recoverable errors do not mark failure", async (t) => {
  const { root, db, source } = await fixture(t, { history: false });
  const now = Date.now();
  const rollout = path.join(root, "sessions", "rollout-wait.jsonl");
  insert(db, "threads", {
    id: "waiting",
    title: "Waiting task",
    rollout_path: rollout,
  });
  await writeFile(
    rollout,
    event("task_started", now - 10_000, { turn_id: "a" }) +
      JSON.stringify({
        type: "response_item",
        timestamp: new Date(now - 9000).toISOString(),
        payload: {
          type: "function_call",
          name: "functions.request_user_input",
          call_id: "question",
          arguments: '{"private":"QUESTION BODY"}',
        },
      }) +
      "\n",
  );
  assert.equal((await source.snapshot()).tasks[0].status, "waiting");
  await appendFile(
    rollout,
    JSON.stringify({
      type: "response_item",
      timestamp: new Date(now - 8000).toISOString(),
      payload: {
        type: "function_call_output",
        call_id: "different",
        output: "PRIVATE",
      },
    }) + "\n",
  );
  assert.equal((await source.snapshot()).tasks[0].status, "waiting");
  await appendFile(
    rollout,
    JSON.stringify({
      type: "response_item",
      timestamp: new Date(now - 7000).toISOString(),
      payload: {
        type: "function_call_output",
        call_id: "question",
        output: "PRIVATE ANSWER",
      },
    }) +
      "\n" +
      event("error", now - 6000, { message: "RETRYABLE PRIVATE ERROR" }),
  );
  assert.equal((await source.snapshot()).tasks[0].status, "working");
  await appendFile(rollout, event("task_failed", now - 5000));
  const failed = await source.snapshot();
  assert.equal(failed.tasks[0].status, "error");
  assert.equal(JSON.stringify(failed).includes("PRIVATE"), false);
});

test("new rollout events override an older projection without resuming tasks", async (t) => {
  const { root, db, hd, source } = await fixture(t);
  const now = Date.now();
  const rollout = path.join(root, "sessions", "rollout-projection.jsonl");
  insert(db, "threads", {
    id: "projection",
    title: "Projection",
    rollout_path: rollout,
  });
  insert(hd, "thread_turns", {
    thread_id: "projection",
    turn_id: "old",
    rollout_ordinal: 1,
    status: "completed",
    started_at: Math.floor((now - 20_000) / 1000),
    completed_at: Math.floor((now - 15_000) / 1000),
  });
  await writeFile(
    rollout,
    event("task_started", now - 10_000, { turn_id: "new" }),
  );
  assert.equal((await source.snapshot()).tasks[0].status, "working");
  await appendFile(
    rollout,
    event("task_complete", now - 1000, { turn_id: "new" }),
  );
  assert.equal((await source.snapshot()).tasks[0].status, "done");
});

test("terminal projection without a completion timestamp is not reset by its own start event", async (t) => {
  const { root, db, hd, source } = await fixture(t);
  const now = Date.now();
  const rollout = path.join(root, "sessions", "rollout-terminal.jsonl");
  insert(db, "threads", {
    id: "terminal",
    title: "Terminal",
    rollout_path: rollout,
    updated_at_ms: 1e99,
  });
  insert(hd, "thread_turns", {
    thread_id: "terminal",
    turn_id: "same",
    rollout_ordinal: 1,
    status: "completed",
    started_at: Math.floor((now - 10_000) / 1000),
    completed_at: null,
  });
  await writeFile(
    rollout,
    event("task_started", now - 10_000, { turn_id: "same" }),
  );
  const result = await source.snapshot();
  assert.equal(result.tasks[0].status, "done");
  assert.ok(Number.isFinite(Date.parse(result.tasks[0].updatedAt)));
});

test("missing installation and unsupported schemas degrade safely; out-of-scope rollouts are ignored", async (t) => {
  const root = await mkdtemp(path.join(TEST_TMP, "workroom-empty-"));
  const source = createCodexSource({ codexHome: root });
  t.after(async () => {
    await source.close();
    await removeFixture(root);
  });
  assert.equal((await source.snapshot()).health.status, "unavailable");
  const db = new DatabaseSync(path.join(root, "state_5.sqlite"));
  db.exec("CREATE TABLE threads(id TEXT, title TEXT)");
  assert.equal((await source.snapshot()).health.status, "unavailable");
  db.exec(
    "ALTER TABLE threads ADD COLUMN archived INTEGER DEFAULT 0; ALTER TABLE threads ADD COLUMN rollout_path TEXT",
  );
  const disallowed = path.join(root, "private.jsonl");
  await writeFile(disallowed, event("task_complete", Date.now()));
  insert(db, "threads", {
    id: "outside",
    title: "Metadata only",
    rollout_path: disallowed,
  });
  const snapshot = await source.snapshot();
  assert.equal(snapshot.tasks[0].status, "unknown");
  db.close();
});

test("active roles come from current work records, support all eight roles, and never expose arguments", async (t) => {
  const { db, hd, source } = await fixture(t);
  const now = Date.now();
  insert(db, "threads", { id: "work", title: "Unrelated parent task title" });
  insert(hd, "thread_turns", {
    thread_id: "work",
    turn_id: "current",
    rollout_ordinal: 1,
    status: "inProgress",
    started_at: Math.floor((now - 5000) / 1000),
  });
  const secret = "PRIVATE ARGUMENT BODY AND TOKEN";
  const items = [
    {
      type: "commandExecution",
      command: "npm run build",
      aggregatedOutput: secret,
    },
    {
      type: "mcpToolCall",
      server: "image_gen",
      tool: "imagegen",
      arguments: { prompt: secret, model: "sales engineer planner" },
      result: secret,
    },
    {
      type: "mcpToolCall",
      server: "youtube",
      tool: "videos_insert",
      arguments: { body: secret },
    },
    {
      type: "mcpToolCall",
      server: "hubspot",
      tool: "create_contact",
      arguments: { body: secret },
    },
    {
      type: "mcpToolCall",
      server: "documents",
      tool: "create_document",
      arguments: { body: secret },
    },
    { type: "webSearch", query: secret },
    {
      type: "mcpToolCall",
      server: "turn_plan",
      tool: "update_turn_plan",
      arguments: { body: secret },
    },
    {
      type: "mcpToolCall",
      server: "codex_app",
      tool: "automation_update",
      arguments: { prompt: secret },
    },
  ];
  items.forEach((value, index) =>
    item(hd, "work", "current", index + 1, value),
  );
  insert(db, "threads", {
    id: "title-only",
    title:
      "engineering design sales research writing planning operations PR BGM",
    agent_nickname: "Designer model",
    agent_path: "/root/model_information",
  });
  insert(hd, "thread_turns", {
    thread_id: "title-only",
    turn_id: "current",
    rollout_ordinal: 1,
    status: "inProgress",
    started_at: Math.floor((now - 5000) / 1000),
  });
  const snapshot = await source.snapshot();
  assert.equal(snapshot.health.status, "connected");
  assert.deepEqual(
    snapshot.tasks
      .find((task) => task.id === "work")
      .activeRoles.map((role) => role.roleId),
    [
      "engineering",
      "design",
      "pr",
      "sales",
      "writing",
      "research",
      "planning",
      "operations",
    ],
  );
  assert.deepEqual(
    snapshot.tasks.find((task) => task.id === "title-only").activeRoles,
    [],
  );
  for (const role of snapshot.tasks.find((task) => task.id === "work")
    .activeRoles) {
    assert.deepEqual(Object.keys(role), ["roleId", "evidence"]);
    assert.ok(role.evidence.length > 0 && role.evidence.length < 40);
  }
  assert.equal(JSON.stringify(snapshot).includes(secret), false);
});

test("role observations accumulate within one turn and reset on completion and the next turn", async (t) => {
  const { db, hd, source } = await fixture(t);
  const now = Date.now();
  insert(db, "threads", { id: "work", title: "Work" });
  insert(hd, "thread_turns", {
    thread_id: "work",
    turn_id: "a",
    rollout_ordinal: 1,
    status: "inProgress",
    started_at: Math.floor((now - 10_000) / 1000),
  });
  item(hd, "work", "a", 1, {
    type: "mcpToolCall",
    server: "image_gen",
    tool: "imagegen",
    arguments: { prompt: "PRIVATE" },
  });
  assert.deepEqual(
    (await source.snapshot()).tasks[0].activeRoles.map((role) => role.roleId),
    ["design"],
  );
  item(hd, "work", "a", 2, { type: "commandExecution", command: "npm test" });
  assert.deepEqual(
    (await source.snapshot()).tasks[0].activeRoles.map((role) => role.roleId),
    ["engineering", "design"],
  );
  hd.prepare(
    "UPDATE thread_turns SET status='completed',completed_at=? WHERE turn_id='a'",
  ).run(Math.floor((now - 5000) / 1000));
  assert.deepEqual((await source.snapshot()).tasks[0].activeRoles, []);
  insert(hd, "thread_turns", {
    thread_id: "work",
    turn_id: "b",
    rollout_ordinal: 100,
    status: "inProgress",
    started_at: Math.floor((now - 3000) / 1000),
  });
  assert.deepEqual((await source.snapshot()).tasks[0].activeRoles, []);
  item(hd, "work", "b", 101, {
    type: "mcpToolCall",
    server: "salesforce",
    tool: "list_leads",
    arguments: { query: "PRIVATE" },
  });
  assert.deepEqual(
    (await source.snapshot()).tasks[0].activeRoles.map((role) => role.roleId),
    ["sales"],
  );
});

test("functions.exec is scanned statically, ignoring quoted examples, comments, and model descriptions", async (t) => {
  const { root, db, source } = await fixture(t, { history: false });
  const now = Date.now();
  const rollout = path.join(root, "sessions", "rollout-roles.jsonl");
  insert(db, "threads", {
    id: "work",
    title: "PR planning research",
    rollout_path: rollout,
  });
  const code = [
    "// await tools.mcp__youtube__videos_insert({});",
    '/* await tools.web__run({search_query: [{q: "private"}]}); */',
    'const example = "await tools.mcp__codex_app__automation_update({})";',
    'await tools.exec_command({cmd: "ffmpeg -i private.wav mix.mp3"});',
    'await tools.mcp__codex_apps__github_create_repository({name: "PRIVATE PROJECT"});',
    "await tools.mcp__cua_repl__js({code: 'await tab.goto(\"https://coconala.com/services/123\")'});",
    "await tools.exec_command({cmd: 'Write-Output \"gpt-image audio sales research model\"'});",
  ].join("\n");
  await writeFile(
    rollout,
    event("task_started", now - 10_000, { turn_id: "a" }) +
      toolEvent("functions.exec", code, now - 9000),
  );
  const snapshot = await source.snapshot();
  assert.deepEqual(
    snapshot.tasks[0].activeRoles.map((role) => role.roleId),
    ["engineering", "design", "sales"],
  );
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE PROJECT"), false);
  assert.equal(JSON.stringify(snapshot).includes("private.wav"), false);
  await appendFile(
    rollout,
    event("task_complete", now - 8000, { turn_id: "a" }) +
      event("task_started", now - 7000, { turn_id: "b" }) +
      toolEvent("functions.exec", "// no observed tools", now - 6000),
  );
  assert.deepEqual((await source.snapshot()).tasks[0].activeRoles, []);
});

test("file changes use only file types and metadata roles do not require a model", async (t) => {
  const { db, hd, source } = await fixture(t);
  const now = Date.now();
  insert(db, "threads", {
    id: "work",
    title: "Unrelated",
    agent_role: "sales",
    agent_path: "/root/research",
  });
  insert(hd, "thread_turns", {
    thread_id: "work",
    turn_id: "a",
    rollout_ordinal: 1,
    status: "inProgress",
    started_at: Math.floor((now - 5000) / 1000),
  });
  item(hd, "work", "a", 1, {
    type: "fileChange",
    changes: [
      { path: "/PRIVATE_LOCATION/app.mjs", diff: "PRIVATE SOURCE CODE" },
      { path: "/PRIVATE_LOCATION/readme.md", diff: "PRIVATE DOCUMENT" },
      { path: "/PRIVATE_LOCATION/cover.svg", diff: "PRIVATE VECTOR" },
    ],
  });
  const snapshot = await source.snapshot();
  assert.deepEqual(
    snapshot.tasks[0].activeRoles.map((role) => role.roleId),
    ["engineering", "design", "sales", "writing", "research"],
  );
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE_"), false);
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE SOURCE CODE"), false);
});

test("a large current-turn tail remains attributable through its stored byte offset", async (t) => {
  const { root, db, hd, source } = await fixture(t);
  const now = Date.now();
  const rollout = path.join(root, "sessions", "rollout-offset.jsonl");
  insert(db, "threads", { id: "work", title: "Work", rollout_path: rollout });
  const old =
    event("task_started", now - 15_000, { turn_id: "a" }) +
    toolEvent("image_gen.imagegen", "{}", now - 14_000) +
    event("task_complete", now - 13_000, { turn_id: "a" });
  const current =
    event("task_started", now - 12_000, { turn_id: "b" }) +
    JSON.stringify({
      type: "response_item",
      timestamp: new Date(now - 11_000).toISOString(),
      payload: {
        type: "function_call_output",
        output: "PRIVATE".repeat(25_000),
      },
    }) +
    "\n" +
    toolEvent(
      "functions.exec",
      'await tools.exec_command({cmd: "npm run build"})',
      now - 10_000,
    );
  await writeFile(rollout, old + current);
  insert(hd, "thread_turns", {
    thread_id: "work",
    turn_id: "b",
    rollout_ordinal: 100,
    status: "inProgress",
    started_at: Math.floor((now - 12_000) / 1000),
    rollout_byte_offset: Buffer.byteLength(old),
  });
  const snapshot = await source.snapshot();
  assert.deepEqual(
    snapshot.tasks[0].activeRoles.map((role) => role.roleId),
    ["engineering"],
  );
  assert.equal(JSON.stringify(snapshot).includes("PRIVATE"), false);
});
