import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { createWorkroom } from "../server.mjs";
import { usageWindows } from "../public/controls.js";

test("plan windows use reported durations and never invent missing percentages", () => {
  const windows = [
    { durationMinutes: 300, usedPercent: 18 },
    { durationMinutes: 10080, usedPercent: 27 },
    { durationMinutes: 10080, usedPercent: null },
  ];
  assert.deepEqual(
    usageWindows({ planType: "pro", windows }).map((w) => w.durationMinutes),
    [10080],
  );
  assert.deepEqual(
    usageWindows({ planType: "plus", windows }).map((w) => w.durationMinutes),
    [300, 10080],
  );
  assert.deepEqual(
    usageWindows({ planType: "pro", windows: [windows[0]] }),
    [],
  );
});

test("instructions require explicit local POST, reject busy work, and deduplicate accepted sends", async () => {
  const parent = path.resolve(process.env.WORKROOM_TEST_TMP || os.tmpdir());
  const dir = await mkdtemp(path.join(parent, "workroom-control-"));
  const taskId = randomUUID(),
    turnId = randomUUID();
  const sent = [];
  let status = "done";
  const source = {
    snapshot: async () => ({
      tasks: [
        {
          id: taskId,
          title: "Synthetic work",
          source: "codex",
          status,
          turnId,
        },
      ],
      health: { status: "connected" },
    }),
    getReply: async (id, { turnId }) => ({
      status: "available",
      taskId: id,
      turnId,
      text: "<b>plain text</b>\n  code",
      truncated: false,
    }),
  };
  const control = {
    getAccountUsage: async () => ({
      status: "available",
      planType: "pro",
      windows: [{ durationMinutes: 10080, usedPercent: 27 }],
    }),
    getState: () => ({ running: [], events: [] }),
    close: async () => {},
    sendInstruction: async (input) => {
      sent.push(input);
      return {
        taskId: input.taskId || randomUUID(),
        turnId: randomUUID(),
        status: "inProgress",
        acceptedAt: new Date().toISOString(),
      };
    },
  };
  await mkdir(path.join(dir, "sounds"));
  await writeFile(
    path.join(dir, "sounds", "success.mp3"),
    "synthetic-test-bytes",
  );
  const app = await createWorkroom({ port: 0, dataDir: dir, source, control });
  const base = `http://127.0.0.1:${app.port}`;
  const headers = {
    Origin: base,
    "Content-Type": "application/json",
    "X-Workroom-Action": "instruction",
  };
  const instruction = {
    taskId,
    text: "日本語の指示\nKeep literal `code` and $() intact.",
    requestId: randomUUID(),
  };
  try {
    let response = await fetch(base + "/api/instructions", {
      method: "POST",
      headers: { ...headers, Origin: "https://outside.example" },
      body: JSON.stringify(instruction),
    });
    assert.equal(response.status, 403);
    response = await fetch(base + "/api/instructions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(instruction),
    });
    assert.equal(response.status, 403);
    response = await fetch(base + "/api/instructions", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...instruction, cwd: "C:/unexpected" }),
    });
    assert.equal(response.status, 400);
    assert.equal(sent.length, 0);
    const responses = await Promise.all(
      [1, 2].map(() =>
        fetch(base + "/api/instructions", {
          method: "POST",
          headers,
          body: JSON.stringify(instruction),
        }).then((r) => r.json()),
      ),
    );
    assert.deepEqual(responses[0], responses[1]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, instruction.text);
    response = await fetch(base + "/api/instructions", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...instruction, text: "different" }),
    });
    assert.equal(response.status, 409);
    const usage = await (await fetch(base + "/api/usage")).json();
    assert.equal(usage.planType, "pro");
    const reply = await fetch(
      base + `/api/reply?taskId=${taskId}&turnId=${turnId}`,
    );
    assert.equal(reply.headers.get("cache-control"), "no-store");
    assert.equal((await reply.json()).text, "<b>plain text</b>\n  code");
    assert.equal(
      (await fetch(base + `/api/reply?taskId=${taskId}`)).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + `/api/reply?taskId=${taskId}&turnId=${turnId}`, {
          headers: { Origin: "https://outside.example" },
        })
      ).status,
      403,
    );
    assert.deepEqual(
      (await (await fetch(base + "/sound-manifest.json")).json()).available,
      ["success"],
    );
    assert.equal(
      (await fetch(base + "/sounds/success.mp3")).headers.get("content-type"),
      "audio/mpeg",
    );
    assert.equal((await fetch(base + "/sounds/pair-code")).status, 404);
    assert.equal(
      (
        await fetch(base + "/sounds/success.mp3", {
          headers: { Origin: "https://outside.example" },
        })
      ).status,
      403,
    );
    status = "working";
    // An owned accepted turn is immediately busy after the next observation.
    await new Promise((resolve) => setTimeout(resolve, 2600));
    response = await fetch(base + "/api/instructions", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...instruction, requestId: randomUUID() }),
    });
    assert.equal(response.status, 409);
    assert.equal(sent.length, 1);
    assert.equal(
      JSON.stringify(await (await fetch(base + "/api/state")).json()).includes(
        "plain text",
      ),
      false,
    );
  } finally {
    await app.close();
    assert.equal(path.dirname(path.resolve(dir)), parent);
    await rm(dir, { recursive: true, force: true });
  }
});
