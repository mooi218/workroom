import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  open,
} from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_DISPLAY_SELECTION,
  MAX_DISPLAY_SELECTION_KEYS,
  MAX_TASK_SELECTION_KEY_LENGTH,
  normalizeDisplaySelection,
  taskSelectionKey,
  matchesDisplaySelection,
} from "../lib/selection-model.mjs";
import {
  createSelectionStore,
  DISPLAY_SELECTION_FILENAME,
  MAX_DISPLAY_SELECTION_FILE_BYTES,
} from "../lib/selection-store.mjs";

const key = (id, source = "codex") => taskSelectionKey({ id, source });
const selected = (ids = [], status = "working") => ({
  version: 1,
  mode: "selected",
  taskKeys: ids.map((id) => key(id)),
  status,
});
const tempRoot = path.resolve(process.env.WORKROOM_TEST_TMP || tmpdir());
async function fixture(t, { createDirectory = true } = {}) {
  const root = await mkdtemp(path.join(tempRoot, "workroom-selection-"));
  const dataDir = path.join(root, ".workroom"),
    filename = path.join(dataDir, DISPLAY_SELECTION_FILENAME);
  if (createDirectory) await mkdir(dataDir);
  const store = createSelectionStore({ dataDir });
  t.after(async () => {
    const target = path.resolve(root);
    assert.equal(path.dirname(target), tempRoot);
    assert.ok(path.basename(target).startsWith("workroom-selection-"));
    await rm(target, { recursive: true, force: true });
  });
  return { root, dataDir, filename, store };
}

test("all and explicit none are distinct, status is separate, and all retains an earlier subset", () => {
  assert.deepEqual(DEFAULT_DISPLAY_SELECTION, {
    version: 1,
    mode: "all",
    taskKeys: [],
    status: "working",
  });
  const job = { id: "a", source: "codex", status: "done" };
  assert.equal(matchesDisplaySelection(job, DEFAULT_DISPLAY_SELECTION), true);
  assert.equal(
    matchesDisplaySelection(job, normalizeDisplaySelection(selected([]))),
    false,
  );
  const all = normalizeDisplaySelection({
    ...selected(["a", "missing-job"]),
    mode: "all",
    status: "",
  });
  assert.deepEqual(all.taskKeys, [key("a"), key("missing-job")]);
  assert.equal(
    matchesDisplaySelection({ id: "not-in-subset", source: "work" }, all),
    true,
  );
  const subset = normalizeDisplaySelection({ ...all, mode: "selected" });
  assert.equal(matchesDisplaySelection(job, subset), true);
  assert.equal(
    matchesDisplaySelection({ id: "new-job", source: "codex" }, subset),
    false,
  );
  assert.ok(Object.isFrozen(subset) && Object.isFrozen(subset.taskKeys));
  assert.throws(() => subset.taskKeys.push(key("other")), TypeError);
});

test("canonical job keys deduplicate role seats and keep sources distinct", () => {
  const engineer = {
    id: "seat-engineer",
    taskId: "shared-job",
    source: "codex",
  };
  const designer = {
    id: "seat-designer",
    taskId: "shared-job",
    source: "codex",
  };
  assert.equal(taskSelectionKey(engineer), taskSelectionKey(designer));
  assert.notEqual(taskSelectionKey(engineer), key("shared-job", "work"));
  assert.deepEqual(JSON.parse(taskSelectionKey(engineer)), [
    "codex",
    "shared-job",
  ]);
  const model = normalizeDisplaySelection({
    ...selected(),
    taskKeys: [
      taskSelectionKey(engineer),
      ' [ "codex", "shared-job" ] ',
      key("shared-job", "work"),
    ],
  });
  assert.equal(model.taskKeys.length, 2);
  assert.equal(matchesDisplaySelection(engineer, model), true);
  assert.equal(matchesDisplaySelection(designer, model), true);
  for (const task of [
    null,
    {},
    { id: "a" },
    { id: "a", source: "" },
    { taskId: 2, id: "seat", source: "codex" },
    { id: "../../pair-code", source: "codex" },
  ])
    assert.equal(taskSelectionKey(task), null);
});

test("schema normalization rejects malformed, excessive and future data without resetting it", () => {
  const invalid = [
    undefined,
    null,
    [],
    {},
    { ...selected(), version: "1" },
    { ...selected(), mode: "none" },
    { ...selected(), status: "active" },
    { ...selected(), title: "PRIVATE TITLE" },
    { ...selected(), taskKeys: "a" },
    { ...selected(), taskKeys: ["not-a-key"] },
    { ...selected(), taskKeys: ['["codex", "a", "extra"]'] },
    { ...selected(), taskKeys: ['["codex", "user prompt text"]'] },
    { ...selected(), taskKeys: ['["codex", ""]'] },
    { ...selected(), taskKeys: new Array(1) },
    {
      ...selected(),
      taskKeys: ["x".repeat(MAX_TASK_SELECTION_KEY_LENGTH + 1)],
    },
    {
      ...selected(),
      taskKeys: Array(MAX_DISPLAY_SELECTION_KEYS + 1).fill(key("same")),
    },
  ];
  for (const value of invalid)
    assert.throws(() => normalizeDisplaySelection(value), {
      code: "INVALID_DISPLAY_SELECTION",
    });
  const future = { ...selected(["keep-me"]), version: 2, futureChoice: true };
  assert.throws(() => normalizeDisplaySelection(future), {
    code: "UNSUPPORTED_DISPLAY_SELECTION_VERSION",
  });
  assert.deepEqual(future.taskKeys, [key("keep-me")]);
  assert.throws(
    () => matchesDisplaySelection({ id: "a", source: "codex" }, undefined),
    { code: "INVALID_DISPLAY_SELECTION" },
  );
  assert.equal(
    normalizeDisplaySelection(
      selected(
        Array.from(
          { length: MAX_DISPLAY_SELECTION_KEYS },
          (_, i) => `job-${i}`,
        ),
      ),
    ).taskKeys.length,
    MAX_DISPLAY_SELECTION_KEYS,
  );
});

test("a missing file uses the default without creating files, while selected-empty survives restart", async (t) => {
  const { dataDir, store, filename } = await fixture(t, {
    createDirectory: false,
  });
  assert.deepEqual(await store.read(), DEFAULT_DISPLAY_SELECTION);
  await assert.rejects(readdir(dataDir), { code: "ENOENT" });
  await store.write(selected([], ""));
  const reopened = createSelectionStore({ dataDir });
  assert.deepEqual(await reopened.read(), {
    version: 1,
    mode: "selected",
    taskKeys: [],
    status: "",
  });
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), {
    version: 1,
    mode: "selected",
    taskKeys: [],
    status: "",
  });
});

test("roundtrips retain temporarily missing IDs and do not affect sounds, pairing or unrelated temp files", async (t) => {
  const { dataDir, store } = await fixture(t);
  await mkdir(path.join(dataDir, "sounds"));
  const untouched = new Map([
    ["pair-code", "SYNTHETIC_PRIVATE_PAIR"],
    ["sound-settings.json", '{"enabled":true,"volume":0.4}'],
    [path.join("sounds", "custom.wav"), "SYNTHETIC_AUDIO"],
    [".display-selection.json.unrelated.tmp", "OTHER FILE"],
  ]);
  for (const [name, content] of untouched)
    await writeFile(path.join(dataDir, name), content);
  const original = selected(["online", "temporarily-missing"]);
  await store.write(original);
  const current = await store.read();
  assert.equal(
    matchesDisplaySelection({ id: "online", source: "codex" }, current),
    true,
  );
  await store.write({ ...current, mode: "all", status: "done" });
  const after = await createSelectionStore({ dataDir }).read();
  assert.deepEqual(after.taskKeys, original.taskKeys);
  for (const [name, content] of untouched)
    assert.equal(await readFile(path.join(dataDir, name), "utf8"), content);
  const entries = await readdir(dataDir);
  assert.deepEqual(
    entries.filter((name) => name.startsWith(".display-selection.json.")),
    [".display-selection.json.unrelated.tmp"],
  );
});

test("invalid, future and oversized saved files fail explicitly and cannot be overwritten by defaults", async (t) => {
  const { store, filename } = await fixture(t);
  for (const [bytes, code] of [
    [Buffer.from("{bad json"), "INVALID_SAVED_DISPLAY_SELECTION"],
    [Buffer.from([255]), "INVALID_SAVED_DISPLAY_SELECTION"],
    [
      Buffer.from(JSON.stringify({ ...selected(["protected"]), version: 2 })),
      "UNSUPPORTED_DISPLAY_SELECTION_VERSION",
    ],
    [
      Buffer.from(JSON.stringify({ ...selected(), title: "PRIVATE TITLE" })),
      "INVALID_SAVED_DISPLAY_SELECTION",
    ],
  ]) {
    await writeFile(filename, bytes);
    await assert.rejects(store.read(), { code });
    await assert.rejects(store.write(DEFAULT_DISPLAY_SELECTION), { code });
    assert.deepEqual(await readFile(filename), bytes);
  }
  const handle = await open(filename, "w");
  await handle.truncate(MAX_DISPLAY_SELECTION_FILE_BYTES + 1);
  await handle.close();
  await assert.rejects(store.read(), {
    code: "DISPLAY_SELECTION_FILE_TOO_LARGE",
  });
  await assert.rejects(store.write(selected()), {
    code: "DISPLAY_SELECTION_FILE_TOO_LARGE",
  });
});

test("writes are atomic for readers and serialized across store instances", async (t) => {
  const { dataDir, store, filename } = await fixture(t);
  await store.write(selected(["initial"]));
  const otherStore = createSelectionStore({ dataDir });
  const observed = [],
    reads = [];
  const watcher = watch(dataDir, (_event, changed) => {
    if (String(changed) === DISPLAY_SELECTION_FILENAME)
      reads.push(
        readFile(filename, "utf8").then((text) => {
          observed.push(normalizeDisplaySelection(JSON.parse(text)));
        }),
      );
  });
  try {
    const first = store.write(selected(["first"]));
    const between = otherStore.read();
    const second = otherStore.write(selected(["second"]));
    assert.deepEqual((await between).taskKeys, [key("first")]);
    await Promise.all([first, second]);
    const writes = Array.from({ length: 12 }, (_, i) =>
      (i % 2 ? store : otherStore).write(
        selected([`job-${i}`, "still-missing"], i % 2 ? "" : "working"),
      ),
    );
    await Promise.all(writes);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    watcher.close();
  }
  await Promise.all(reads);
  assert.ok(observed.length > 0);
  assert.deepEqual((await store.read()).taskKeys, [
    key("job-11"),
    key("still-missing"),
  ]);
  assert.deepEqual((await readdir(dataDir)).sort(), [
    DISPLAY_SELECTION_FILENAME,
  ]);
});

test("queued writes capture drafts, and a rejected operation does not poison subsequent writes", async (t) => {
  const { store, filename } = await fixture(t);
  const draft = selected(["captured"]);
  const pending = store.write(draft);
  draft.taskKeys.push(key("later-mutation"));
  draft.status = "error";
  await pending;
  assert.deepEqual(await store.read(), selected(["captured"]));
  await assert.rejects(store.write({ ...selected(), body: "PRIVATE BODY" }), {
    code: "INVALID_DISPLAY_SELECTION",
  });
  await store.write(selected(["after-error"], "waiting"));
  assert.deepEqual(await store.read(), selected(["after-error"], "waiting"));
  assert.equal(
    (await readFile(filename, "utf8")).includes("PRIVATE BODY"),
    false,
  );
});

test("non-file storage errors are explicit and never replaced with show-all defaults", async (t) => {
  const { store, filename } = await fixture(t);
  await mkdir(filename);
  await assert.rejects(store.read(), { code: "DISPLAY_SELECTION_READ_FAILED" });
  await assert.rejects(store.write(DEFAULT_DISPLAY_SELECTION), {
    code: "DISPLAY_SELECTION_READ_FAILED",
  });
});
