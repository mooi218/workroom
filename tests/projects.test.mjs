import test from "node:test";
import assert from "node:assert/strict";
import { projectKey, projectName, groupWork } from "../public/projects.js";
test("project picker keeps same-named workspaces distinct and counts jobs, not role seats", () => {
  const rows = [
    {
      id: "a",
      projectKey: "one",
      projectName: "Website launch",
      projectKind: "task-group",
      projectTaskCount: 2,
      status: "working",
    },
    {
      id: "b",
      projectKey: "one",
      projectName: "Website launch",
      projectKind: "task-group",
      status: "done",
    },
    {
      id: "c",
      projectKey: "two",
      projectName: "Website launch",
      projectKind: "task-group",
      status: "working",
    },
  ];
  const groups = groupWork(rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].count, 2);
  assert.equal(groups[0].active, 1);
  assert.equal(groups[0].rootCount, 2);
  assert.equal(projectName(rows[0]), "Website launch");
  assert.notEqual(projectKey(rows[0]), projectKey(rows[2]));
});
