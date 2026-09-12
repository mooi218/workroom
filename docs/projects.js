export function projectKey(task) {
  return (
    task.projectKey ||
    `${task.source || "task"}:${task.projectName || task.project || "unassigned"}`
  );
}

export function projectName(task) {
  return task.projectName || task.project || "";
}

export function groupWork(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    const key = projectKey(task);
    if (!groups.has(key))
      groups.set(key, {
        key,
        name: projectName(task),
        kind: task.projectKind || "project",
        rootCount: task.projectTaskCount || 1,
        count: 0,
        active: 0,
      });
    const group = groups.get(key);
    group.count++;
    if (task.status === "working") group.active++;
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.active > 0) - Number(a.active > 0) ||
      a.name.localeCompare(b.name) ||
      a.key.localeCompare(b.key),
  );
}
