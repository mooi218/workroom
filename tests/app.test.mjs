import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createWorkroom } from "../server.mjs";
import { CloudStore } from "../lib/cloud-store.mjs";
import { classifyTask, assignRoles, DEFAULT_ROLES } from "../lib/roles.mjs";

test("roles handle Japanese, English token boundaries, manual assignments and custom teams", () => {
  assert.equal(classifyTask({ title: "新しい記事を執筆" }).roleId, "writing");
  assert.equal(classifyTask({ title: "Build pipeline" }).roleId, "other");
  assert.equal(classifyTask({ title: "Review UI design" }).roleId, "design");
  assert.equal(
    classifyTask({ id: "a", title: "実装" }, DEFAULT_ROLES, { a: "sales" })
      .roleId,
    "sales",
  );
  const roles = [
    ...DEFAULT_ROLES,
    { id: "support", keywords: ["お問い合わせ"], name: "サポート" },
  ];
  assert.equal(
    classifyTask({ title: "お問い合わせ対応" }, roles).roleId,
    "support",
  );
  assert.equal(
    classifyTask({ title: "unrelated" }, roles).reason,
    "unclassified",
  );
});
test("cloud observations expire to unknown and remain independent across tabs", () => {
  let now = Date.parse("2026-09-01T00:00:00Z");
  const cloud = new CloudStore({ now: () => now, staleMs: 90000 });
  const job = {
    id: "a",
    title: "Synthetic design",
    status: "working",
    url: "https://chatgpt.com/c/example-1",
    project: "Example",
    updatedAt: new Date(now).toISOString(),
  };
  cloud.ingest({ observerId: "tab-1", tasks: [job] });
  assert.equal(cloud.snapshot().tasks[0].status, "working");
  now += 1000;
  cloud.ingest({ observerId: "tab-2", tasks: [{ ...job, status: "waiting" }] });
  assert.equal(cloud.snapshot().tasks[0].status, "waiting");
  cloud.ingest({ observerId: "tab-1", tasks: [] });
  assert.equal(cloud.snapshot().tasks.length, 1);
  now += 91000;
  assert.equal(cloud.snapshot().tasks[0].status, "unknown");
  assert.equal(cloud.snapshot().health.status, "stale");
  cloud.ingest({ observerId: "tab-2", tasks: [] });
  assert.equal(cloud.snapshot().tasks.length, 0);
});
test("observed work creates multiple departments without duplicating tasks, and manual assignment wins", () => {
  const task = {
    id: "campaign",
    title: "Synthetic campaign",
    status: "working",
    activeRoles: [
      { roleId: "engineering" },
      { roleId: "design" },
      { roleId: "pr" },
      { roleId: "pr" },
      { roleId: "nonexistent" },
    ],
  };
  assert.deepEqual(
    assignRoles(task).map((r) => r.roleId),
    ["engineering", "design", "pr"],
  );
  assert.deepEqual(
    assignRoles(task, DEFAULT_ROLES, { campaign: "sales" }).map(
      (r) => r.roleId,
    ),
    ["sales"],
  );
  assert.equal(
    assignRoles({ ...task, status: "done" })[0].reason,
    "unclassified",
  );
  assert.equal(
    classifyTask({ title: "Implementation project", agentTask: "research" })
      .roleId,
    "research",
  );
});
test("cloud accepts only conversation metadata and rejects external URLs", () => {
  const cloud = new CloudStore();
  const task = {
    id: "a",
    title: "Example",
    url: "https://chatgpt.com/c/example-2?private=1",
    status: "made-up",
    messages: ["PRIVATE"],
    token: "SECRET",
  };
  cloud.ingest({ observerId: "a", tasks: [task] });
  const result = cloud.snapshot().tasks[0];
  assert.equal(result.url, "https://chatgpt.com/c/example-2");
  assert.equal(result.status, "unknown");
  assert.equal("messages" in result, false);
  assert.equal("token" in result, false);
  for (const url of [
    "https://evil.example/c/id",
    "https://chatgpt.com.evil.example/c/id",
    "https://chatgpt.com/settings",
    "file:///tmp/data",
  ])
    assert.throws(() =>
      cloud.ingest({ observerId: "a", tasks: [{ ...task, url }] }),
    );
});
test("local server protects task data, pairs cloud ingestion, and streams refreshed state", async () => {
  const dir = await mkdtemp(
    path.join(process.env.WORKROOM_TEST_TMP || os.tmpdir(), "workroom-server-"),
  );
  let status = "working",
    failure = false;
  const source = {
    snapshot: async () => {
      if (failure) throw Error("Read error");
      return {
        tasks: [
          {
            id: "local-fixture",
            title: "Synthetic task",
            status,
            source: "codex",
            project: "Fixture",
          },
        ],
        health: { status: "connected" },
      };
    },
  };
  const app = await createWorkroom({ port: 0, dataDir: dir, source });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    let response = await fetch(base + "/");
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-security-policy"),
      /frame-ancestors 'none'/,
    );
    const initial = await (await fetch(base + "/api/state")).json();
    assert.equal(initial.tasks[0].status, "working");
    assert.equal("token" in initial, false);
    for (const endpoint of ["/api/state", "/api/pair", "/api/events"]) {
      response = await fetch(base + endpoint, {
        headers: { Origin: "https://evil.example" },
      });
      assert.equal(response.status, 403);
    }
    response = await fetch(base + "/api/state", {
      headers: { "Sec-Fetch-Site": "cross-site" },
    });
    assert.equal(response.status, 403);
    const badHost = await new Promise((resolve, reject) => {
      http
        .get(
          base + "/api/state",
          { headers: { Host: `evil.example:${app.port}` } },
          (r) => {
            r.resume();
            resolve(r.statusCode);
          },
        )
        .on("error", reject);
    });
    assert.equal(badHost, 403);
    response = await fetch(base + "/missing");
    assert.equal(response.status, 404);
    const { token } = await (await fetch(base + "/api/pair")).json();
    const snapshot = {
      observerId: "fixture",
      tasks: [
        {
          id: "x",
          title: "Synthetic cloud",
          status: "waiting",
          url: "https://chatgpt.com/c/example-1",
        },
      ],
    };
    for (const credential of ["", "x".repeat(64), "é".repeat(64)]) {
      response = await fetch(base + "/api/cloud", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify(snapshot),
      });
      assert.equal(response.status, 401);
    }
    response = await fetch(base + "/api/cloud", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Origin: "chrome-extension://" + "a".repeat(32),
      },
      body: JSON.stringify(snapshot),
    });
    assert.equal(response.status, 200);
    const merged = await (await fetch(base + "/api/state")).json();
    assert.equal(merged.tasks.length, 2);
    const controller = new AbortController();
    const stream = await fetch(base + "/api/events", {
      signal: controller.signal,
    });
    const reader = stream.body.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /Synthetic task/);
    status = "done";
    await app.refresh();
    const changed = await reader.read();
    assert.match(new TextDecoder().decode(changed.value), /"status":"done"/);
    failure = true;
    await app.refresh();
    const failed = await reader.read();
    assert.match(new TextDecoder().decode(failed.value), /"status":"unknown"/);
    controller.abort();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
