/* Pure, dependency-free functions shared by the isolated content script and worker. */
(() => {
  "use strict";
  if (globalThis.WorkroomObserverCore) return;

  const STATUS_VALUES = new Set([
    "working",
    "waiting",
    "done",
    "idle",
    "error",
    "unknown",
  ]);
  const STOP_LABEL =
    /^(?:stop generating|stop response|stop responding|stop working|生成を停止|応答を停止|作業を停止)$/iu;
  const WORK_LABEL = /^(?:chatgpt work|work|work mode|work モード|ワーク)$/iu;
  const STATUS_LABELS = [
    [
      "working",
      /^(?:working|running|in progress|generating|作業中|実行中|生成中)$/iu,
    ],
    [
      "waiting",
      /^(?:waiting for (?:your )?(?:approval|confirmation|input)|awaiting (?:approval|confirmation|input)|(?:needs|requires) (?:your )?(?:approval|confirmation|input)|(?:approval|confirmation|input) required|承認待ち|確認待ち|入力待ち|入力が必要|承認が必要|確認が必要|あなたの入力が必要)$/iu,
    ],
    [
      "done",
      /^(?:completed|task completed|work completed|done|完了|作業完了|タスク完了)$/iu,
    ],
    [
      "error",
      /^(?:failed|task failed|work failed|error|失敗|エラー|作業失敗)$/iu,
    ],
    ["idle", /^(?:idle|not started|待機中|未開始)$/iu],
  ];

  function cleanText(value, maxLength = 200) {
    return typeof value === "string"
      ? value
          .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, maxLength)
      : "";
  }

  function conversationFromUrl(value) {
    if (typeof value !== "string" || value.length > 2048) return null;
    try {
      const url = new URL(value);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "chatgpt.com" ||
        url.port ||
        url.username ||
        url.password
      )
        return null;
      const match = url.pathname.match(
        /^\/(?:g\/[a-zA-Z0-9_-]+\/)?c\/([a-zA-Z0-9_-]{6,128})\/?$/u,
      );
      if (!match) return null;
      return {
        conversationId: match[1],
        id: `work:${match[1]}`,
        url: `${url.origin}${url.pathname.replace(/\/$/u, "")}`,
      };
    } catch {
      return null;
    }
  }

  function titleFromPage(value) {
    const title = cleanText(value)
      .replace(/\s+[-|–—]\s+ChatGPT\s*$/iu, "")
      .trim();
    return !title || /^ChatGPT$/iu.test(title)
      ? "ChatGPT Work のタスク"
      : title;
  }

  // The DOM collector marks provenance explicitly. Transcript text, sidebars,
  // menus, and hidden elements never qualify as evidence about the current task.
  function isTaskControl(candidate) {
    return (
      !!candidate &&
      candidate.visible === true &&
      candidate.inConversation === false &&
      (candidate.scope === "main" || candidate.scope === "header")
    );
  }

  function statusFromLabel(value) {
    const label = cleanText(value, 160).replace(
      /^(?:task status|work status|status|状態|作業状態)\s*[:：]\s*/iu,
      "",
    );
    return (
      STATUS_LABELS.find(([, pattern]) => pattern.test(label))?.[0] || "unknown"
    );
  }

  function deriveSignals(ui = {}) {
    const signals = {
      work: false,
      working: false,
      waiting: false,
      done: false,
      error: false,
      idle: false,
    };
    for (const item of (Array.isArray(ui.workMarkers)
      ? ui.workMarkers
      : []
    ).slice(0, 100)) {
      if (!isTaskControl(item)) continue;
      if (
        item.explicitWork === true ||
        (item.selected === true && WORK_LABEL.test(cleanText(item.label, 160)))
      )
        signals.work = true;
    }
    for (const item of (Array.isArray(ui.controls) ? ui.controls : []).slice(
      0,
      250,
    )) {
      if (!isTaskControl(item) || item.disabled === true) continue;
      if (
        STOP_LABEL.test(cleanText(item.label, 160)) ||
        ["stop-button", "stop-generating-button"].includes(item.testId)
      )
        signals.working = true;
    }
    for (const item of (Array.isArray(ui.busy) ? ui.busy : []).slice(0, 100)) {
      if (isTaskControl(item) && item.busy === true) signals.working = true;
    }
    for (const item of (Array.isArray(ui.statuses) ? ui.statuses : []).slice(
      0,
      100,
    )) {
      if (!isTaskControl(item)) continue;
      if (item.explicitWork === true) signals.work = true;
      const status = statusFromLabel(item.label);
      if (status !== "unknown") signals[status] = true;
    }
    return signals;
  }

  function resolveStatus(signals = {}) {
    const has = (name) => signals[name] === true;
    // A live generation supersedes an old completion label; conflicting active
    // states are deliberately unknown instead of guessed.
    if (has("working"))
      return has("waiting") || has("error") ? "unknown" : "working";
    const explicit = ["waiting", "error", "done", "idle"].filter(has);
    return explicit.length === 1 ? explicit[0] : "unknown";
  }

  function taskFromSnapshot(
    snapshot,
    policy = {},
    now = new Date().toISOString(),
  ) {
    if (!snapshot || typeof snapshot !== "object") return null;
    const conversation = conversationFromUrl(snapshot.url);
    if (!conversation || policy.excluded === true) return null;
    if (
      policy.manual !== true &&
      !(policy.autoDetect === true && snapshot.signals?.work === true)
    )
      return null;
    const observed = typeof now === "string" ? new Date(now) : new Date(NaN);
    if (!Number.isFinite(observed.valueOf())) return null;
    return {
      id: conversation.id,
      title: titleFromPage(snapshot.title),
      project: "ChatGPT Work",
      status: resolveStatus(snapshot.signals),
      url: conversation.url,
      updatedAt: observed.toISOString(),
    };
  }

  function taskFingerprint(task) {
    return task
      ? JSON.stringify([task.id, task.title, task.status, task.url])
      : "none";
  }

  function sanitizeTask(task) {
    if (!task || typeof task !== "object") return null;
    const conversation = conversationFromUrl(task.url);
    if (
      !conversation ||
      task.id !== conversation.id ||
      !STATUS_VALUES.has(task.status)
    )
      return null;
    const updatedAt =
      typeof task.updatedAt === "string"
        ? new Date(task.updatedAt)
        : new Date(NaN);
    if (!Number.isFinite(updatedAt.valueOf())) return null;
    return {
      id: conversation.id,
      title: titleFromPage(task.title),
      project: "ChatGPT Work",
      status: task.status,
      url: conversation.url,
      updatedAt: updatedAt.toISOString(),
    };
  }

  globalThis.WorkroomObserverCore = Object.freeze({
    cleanText,
    conversationFromUrl,
    titleFromPage,
    statusFromLabel,
    deriveSignals,
    resolveStatus,
    taskFromSnapshot,
    taskFingerprint,
    sanitizeTask,
  });
})();
