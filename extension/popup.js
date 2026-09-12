"use strict";
const element = (id) => document.getElementById(id);
const STATUS_NAMES = {
  working: "作業中",
  waiting: "確認待ち",
  done: "完了",
  idle: "待機中",
  error: "エラー",
  unknown: "不明",
};
const CONNECTION_NAMES = {
  "not-configured": "接続コードを保存すると、オフィスとつながります。",
  ready: "接続コードを保存済み。タスクの表示を待っています。",
  connected: "このタスクの表示状態を反映しています。",
  untracked: "この会話は追跡していません。",
  unauthorized: "接続コードが一致しません。Workroom の設定をご確認ください。",
  offline: "Workroom に接続できません。オフィスを起動してください。",
  "server-error": "Workroom が応答できません。オフィスの状態をご確認ください。",
};
let state = null;
let busy = false;

function showFeedback(message, error = false) {
  element("feedback").textContent = message;
  element("feedback").classList.toggle("error", error);
}

function render(next) {
  state = next;
  element("task-title").textContent = next.title;
  element("status-badge").textContent = STATUS_NAMES[next.status] || "不明";
  element("status-badge").dataset.status = next.status;
  const tracking =
    next.paired && (next.mode === "manual" || next.mode === "automatic");
  const button = element("track-button");
  button.textContent = tracking ? "このタスクの追跡を停止" : "このタスクを追跡";
  button.dataset.tracking = String(tracking);
  button.disabled = busy || !next.canTrack || !next.paired;
  element("tracking-detail").textContent = !next.canTrack
    ? "ChatGPT の会話ページで追跡を開始できます。"
    : !next.paired
      ? "接続コードを保存すると、タスクを追跡できます。"
      : next.mode === "manual"
        ? "選んだタスクを追跡しています。"
        : next.mode === "automatic"
          ? "Work の表示を見つけ、自動で追跡しています。"
          : next.mode === "stopped"
            ? "このタスクの自動追跡も停止しています。"
            : "この会話をオフィスに表示するには、追跡を選びます。";
  element("connection-state").textContent =
    CONNECTION_NAMES[next.connection] || CONNECTION_NAMES.ready;
  element("connection-dot").className =
    `dot${next.connection === "connected" ? " connected" : ["offline", "unauthorized", "server-error"].includes(next.connection) ? " problem" : ""}`;
  element("pair-code").placeholder = next.paired
    ? "保存済み · 変更する場合は貼り付け"
    : "接続コードを貼り付け";
  element("auto-detect").checked = next.autoDetect;
  element("disconnect-button").hidden = !next.paired;
}

async function request(message, successMessage = "") {
  if (busy) return;
  busy = true;
  element("save-button").disabled = true;
  element("track-button").disabled = true;
  element("disconnect-button").disabled = true;
  element("auto-detect").disabled = true;
  try {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok)
      throw new Error(result?.error || "接続状態を取得できませんでした。");
    busy = false;
    render(result);
    if (successMessage) showFeedback(successMessage);
  } catch (error) {
    busy = false;
    if (state) render(state);
    showFeedback(error.message, true);
  } finally {
    busy = false;
    element("save-button").disabled = false;
    element("disconnect-button").disabled = false;
    element("auto-detect").disabled = false;
  }
}

element("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = element("pair-code").value;
  await request(
    {
      type: "workroom:save-settings",
      pairCode: code,
      autoDetect: element("auto-detect").checked,
    },
    "接続設定を保存しました。",
  );
  element("pair-code").value = "";
});
element("auto-detect").addEventListener("change", () => {
  void request(
    {
      type: "workroom:save-settings",
      autoDetect: element("auto-detect").checked,
    },
    "自動追跡の設定を保存しました。",
  );
});
element("track-button").addEventListener("click", () => {
  const enabled = state?.mode !== "manual" && state?.mode !== "automatic";
  void request(
    { type: "workroom:track-current", enabled },
    enabled ? "このタスクを追跡します。" : "このタスクの追跡を停止しました。",
  );
});
element("disconnect-button").addEventListener("click", () => {
  void request(
    { type: "workroom:disconnect" },
    "Workroom との接続を解除しました。",
  );
});
void request({ type: "workroom:popup-state" });
