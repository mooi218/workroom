const STATUSES = new Set([
  "working",
  "waiting",
  "done",
  "idle",
  "error",
  "unknown",
]);
const text = (value, max) =>
  typeof value === "string"
    ? value.replace(/[\x00-\x1f\x7f]/g, "").slice(0, max)
    : "";
export class CloudStore {
  constructor({ now = () => Date.now(), staleMs = 90000 } = {}) {
    this.now = now;
    this.staleMs = staleMs;
    this.observers = new Map();
  }
  ingest(input) {
    if (
      !input ||
      typeof input.observerId !== "string" ||
      !Array.isArray(input.tasks) ||
      input.tasks.length > 5000
    )
      throw new Error("Invalid snapshot");
    const at = this.now(),
      observedAt = new Date(at).toISOString();
    const tasks = input.tasks.map((task) => {
      if (!task || !text(task.id, 200) || !text(task.title, 300))
        throw new Error("Invalid task");
      let url;
      try {
        url = new URL(task.url);
      } catch {
        throw new Error("Invalid task URL");
      }
      if (
        url.origin !== "https://chatgpt.com" ||
        !/^\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9-]+\/?$/.test(url.pathname)
      )
        throw new Error("Unsupported task URL");
      url.search = "";
      url.hash = "";
      return {
        id: `work:${url.pathname.split("/c/")[1].replace(/\/$/, "")}`,
        title: text(task.title, 300),
        project: text(task.project, 100) || "ChatGPT Work",
        source: "work",
        status: STATUSES.has(task.status) ? task.status : "unknown",
        url: url.toString(),
        updatedAt:
          Number.isFinite(Date.parse(task.updatedAt)) &&
          Date.parse(task.updatedAt) <= at + 60000
            ? new Date(task.updatedAt).toISOString()
            : observedAt,
        observedAt,
        summary: "ブラウザーで最後に観測した状態です。",
      };
    });
    if (this.observers.size >= 200 && !this.observers.has(input.observerId))
      throw new Error("Too many observers");
    this.observers.set(text(input.observerId, 100), { at, tasks });
  }
  snapshot() {
    const now = this.now(),
      byId = new Map();
    let latest = 0;
    for (const record of this.observers.values()) {
      latest = Math.max(latest, record.at);
      for (const task of record.tasks) {
        if (byId.get(task.id)?._at > record.at) continue;
        const stale = now - record.at > this.staleMs;
        byId.set(task.id, {
          ...task,
          status: stale ? "unknown" : task.status,
          summary: stale
            ? "ブラウザーの観測が途切れています。タスクを開くと更新します。"
            : task.summary,
          _at: record.at,
        });
      }
    }
    const tasks = [...byId.values()].map(({ _at, ...task }) => task);
    return {
      tasks,
      health: {
        status: !latest
          ? "disconnected"
          : now - latest > this.staleMs
            ? "stale"
            : "connected",
        taskCount: tasks.length,
        lastSeen: latest ? new Date(latest).toISOString() : null,
        message:
          "拡張で追跡しているブラウザーの仕事のみ。未表示のクラウド作業は取得しません。",
      },
    };
  }
}
