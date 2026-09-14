import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createWorkroom } from "../server.mjs";
import {
  taskSelectionKey,
  DEFAULT_DISPLAY_SELECTION,
} from "../lib/selection-model.mjs";

test("display choices survive server restart, stay private, and reject unsolicited writes", async () => {
  const parent = path.resolve(process.env.WORKROOM_TEST_TMP || os.tmpdir());
  const dataDir = await mkdtemp(path.join(parent, "workroom-display-route-"));
  const source = {
    snapshot: async () => ({ tasks: [], health: { status: "connected" } }),
  };
  const options = { port: 0, source, dataDir };
  let app = await createWorkroom(options);
  let base = `http://127.0.0.1:${app.port}`;
  const headers = () => ({
    Origin: base,
    "Content-Type": "application/json",
    "X-Workroom-Action": "display-selection",
  });
  const selection = {
    version: 1,
    mode: "selected",
    taskKeys: [
      taskSelectionKey({ source: "codex", id: "same-id" }),
      taskSelectionKey({ source: "work", id: "same-id" }),
    ],
    status: "",
  };
  try {
    assert.deepEqual(
      await (await fetch(base + "/api/display-selection")).json(),
      DEFAULT_DISPLAY_SELECTION,
    );
    let response = await fetch(base + "/api/display-selection", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(selection),
    });
    assert.equal(response.status, 403);
    response = await fetch(base + "/api/display-selection", {
      method: "PUT",
      headers: { ...headers(), Origin: "https://outside.example" },
      body: JSON.stringify(selection),
    });
    assert.equal(response.status, 403);
    response = await fetch(base + "/api/display-selection", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ ...selection, title: "PRIVATE" }),
    });
    assert.equal(response.status, 400);
    await mkdir(path.join(dataDir, "sounds"));
    await writeFile(
      path.join(dataDir, "sounds", "success.mp3"),
      "unchanged-sound",
    );
    const pair = await readFile(path.join(dataDir, "pair-code"), "utf8");
    response = await fetch(base + "/api/display-selection", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify(selection),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), selection);
    await app.close();
    app = await createWorkroom(options);
    base = `http://127.0.0.1:${app.port}`;
    response = await fetch(base + "/api/display-selection");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), selection);
    assert.equal(
      (
        await fetch(base + "/api/display-selection", {
          headers: { Origin: "https://outside.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(base + "/.workroom/display-selection.json")).status,
      404,
    );
    assert.equal(await readFile(path.join(dataDir, "pair-code"), "utf8"), pair);
    assert.equal(
      await readFile(path.join(dataDir, "sounds", "success.mp3"), "utf8"),
      "unchanged-sound",
    );
    response = await fetch(base + "/api/display-selection", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ ...selection, taskKeys: [] }),
    });
    assert.equal((await response.json()).mode, "selected");
    const none = await (await fetch(base + "/api/display-selection")).json();
    assert.deepEqual(none.taskKeys, []);
  } finally {
    await app.close();
    assert.equal(path.dirname(dataDir), parent);
    await rm(dataDir, { recursive: true, force: true });
  }
});
