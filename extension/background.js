"use strict";
importScripts("observer-core.js");
const core = globalThis.WorkroomObserverCore;
const ENDPOINT = "http://127.0.0.1:4318/api/cloud";
const SETTINGS_KEY = "workroomSettings";
const queues = new Map();
// The pairing code belongs to this extension, never to the ChatGPT page.
const storageReady = chrome.storage.local.setAccessLevel({
  accessLevel: "TRUSTED_CONTEXTS",
});

function isChatGPTUrl(value) {
  try {
    return new URL(value).origin === "https://chatgpt.com";
  } catch {
    return false;
  }
}

async function settings() {
  await storageReady;
  const stored =
    (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || {};
  return {
    pairCode: typeof stored.pairCode === "string" ? stored.pairCode : "",
    autoDetect: stored.autoDetect !== false,
    manualIds: Array.isArray(stored.manualIds)
      ? stored.manualIds.filter((id) => typeof id === "string")
      : [],
    excludedIds: Array.isArray(stored.excludedIds)
      ? stored.excludedIds.filter((id) => typeof id === "string")
      : [],
  };
}

function policyFor(config, url) {
  const id = core.conversationFromUrl(url)?.id;
  return {
    manual: !!id && config.manualIds.includes(id),
    excluded: !!id && config.excludedIds.includes(id),
    autoDetect: config.autoDetect,
  };
}

function sessionKey(tabId) {
  return `workroomObserver:${tabId}`;
}

async function observation(tabId) {
  return (
    (await chrome.storage.session.get(sessionKey(tabId)))[sessionKey(tabId)] ||
    {}
  );
}

async function saveObservation(tabId, value) {
  await chrome.storage.session.set({ [sessionKey(tabId)]: value });
}

function serial(tabId, operation) {
  const previous = queues.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(tabId, current);
  void current
    .finally(() => {
      if (queues.get(tabId) === current) queues.delete(tabId);
    })
    .catch(() => {});
  return current;
}

async function sendToOffice(tabId, tasks, config, previous) {
  if (!config.pairCode) {
    const state = { ...previous, connection: "not-configured", active: false };
    await saveObservation(tabId, state);
    return { ok: true, connection: state.connection };
  }
  // Unrelated chats produce no traffic. An empty envelope is sent once only
  // when a previously observed tab is stopped or navigates away.
  if (tasks.length === 0 && !previous.active) {
    await saveObservation(tabId, { connection: "untracked", active: false });
    return { ok: true, connection: "untracked" };
  }
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.pairCode}`,
      },
      body: JSON.stringify({ observerId: String(tabId), tasks }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      const connection =
        response.status === 401 || response.status === 403
          ? "unauthorized"
          : "server-error";
      await saveObservation(tabId, { ...previous, connection });
      return { ok: false, connection };
    }
    const current = tasks[0];
    await saveObservation(tabId, {
      active: !!current,
      connection: current ? "connected" : "untracked",
      lastSentAt: new Date().toISOString(),
      task: current || null,
    });
    return {
      ok: true,
      connection: current ? "connected" : "untracked",
      status: current?.status || "unknown",
    };
  } catch {
    await saveObservation(tabId, { ...previous, connection: "offline" });
    return { ok: false, connection: "offline" };
  }
}

async function observeTab(tabId, snapshot) {
  return serial(tabId, async () => {
    const [config, previous] = await Promise.all([
      settings(),
      observation(tabId),
    ]);
    let task = core.taskFromSnapshot(snapshot, policyFor(config, snapshot.url));
    if (
      task &&
      core.taskFingerprint(task) === core.taskFingerprint(previous.task)
    )
      task.updatedAt = previous.task.updatedAt;
    task = core.sanitizeTask(task);
    return sendToOffice(tabId, task ? [task] : [], config, previous);
  });
}

async function activeChatTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab && Number.isInteger(tab.id) && isChatGPTUrl(tab.url) ? tab : null;
}

async function inspectTab(tab, inject = false) {
  if (!tab) return null;
  try {
    return (
      (await chrome.tabs.sendMessage(tab.id, { type: "workroom:inspect" }))
        ?.snapshot || null
    );
  } catch {
    if (!inject) return null;
    // User opened the extension on this tab. This also supports a tab that was
    // already open when the unpacked extension was installed or reloaded.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["observer-core.js", "content.js"],
    });
    return (
      (await chrome.tabs.sendMessage(tab.id, { type: "workroom:inspect" }))
        ?.snapshot || null
    );
  }
}

async function refreshChatTabs() {
  const tabs = await chrome.tabs.query({ url: "https://chatgpt.com/*" });
  await Promise.allSettled(
    tabs.map((tab) =>
      chrome.tabs.sendMessage(tab.id, { type: "workroom:refresh" }),
    ),
  );
}

async function popupState() {
  const [config, tab] = await Promise.all([settings(), activeChatTab()]);
  const conversation = core.conversationFromUrl(tab?.url);
  const snapshot = await inspectTab(tab);
  const policy = policyFor(config, tab?.url);
  const task = core.taskFromSnapshot(snapshot, policy);
  const current = tab ? await observation(tab.id) : {};
  return {
    ok: true,
    paired: !!config.pairCode,
    autoDetect: config.autoDetect,
    canTrack: !!conversation,
    title: conversation
      ? core.titleFromPage(snapshot?.title || tab.title)
      : "ChatGPT のタスクを開いてください",
    mode: policy.excluded
      ? "stopped"
      : policy.manual
        ? "manual"
        : task
          ? "automatic"
          : "untracked",
    status: config.pairCode ? task?.status || "unknown" : "unknown",
    connection: config.pairCode
      ? current.connection || "ready"
      : "not-configured",
    lastSentAt: current.lastSentAt || null,
  };
}

async function handlePopup(message) {
  if (message.type === "workroom:popup-state") return popupState();
  if (message.type === "workroom:save-settings") {
    const config = await settings();
    if (typeof message.pairCode === "string" && message.pairCode.trim()) {
      const code = message.pairCode.trim();
      if (!/^[a-zA-Z0-9_-]{8,256}$/u.test(code))
        return { ok: false, error: "接続コードをそのまま貼り付けてください。" };
      config.pairCode = code;
    }
    if (typeof message.autoDetect === "boolean")
      config.autoDetect = message.autoDetect;
    await chrome.storage.local.set({ [SETTINGS_KEY]: config });
    await refreshChatTabs();
    return popupState();
  }
  if (message.type === "workroom:disconnect") {
    const config = await settings();
    // Best effort: retire each active observer while the previous code exists.
    const entries = await chrome.storage.session.get(null);
    await Promise.allSettled(
      Object.entries(entries)
        .filter(
          ([key, value]) =>
            key.startsWith("workroomObserver:") && value?.active,
        )
        .map(([key]) => {
          const tabId = Number(key.slice("workroomObserver:".length));
          return serial(tabId, async () =>
            sendToOffice(tabId, [], config, await observation(tabId)),
          );
        }),
    );
    config.pairCode = "";
    await chrome.storage.local.set({ [SETTINGS_KEY]: config });
    await refreshChatTabs();
    return popupState();
  }
  if (message.type === "workroom:track-current") {
    const tab = await activeChatTab();
    const conversation = core.conversationFromUrl(tab?.url);
    if (!conversation)
      return { ok: false, error: "ChatGPT の会話ページで開いてください。" };
    const config = await settings();
    if (!config.pairCode)
      return {
        ok: false,
        error: "先に Workroom の接続コードを保存してください。",
      };
    const track = message.enabled === true;
    config.manualIds = config.manualIds.filter((id) => id !== conversation.id);
    config.excludedIds = config.excludedIds.filter(
      (id) => id !== conversation.id,
    );
    if (track) config.manualIds.push(conversation.id);
    else config.excludedIds.push(conversation.id);
    await chrome.storage.local.set({ [SETTINGS_KEY]: config });
    const snapshot = await inspectTab(tab, true);
    if (snapshot) await observeTab(tab.id, snapshot);
    await refreshChatTabs();
    return popupState();
  }
  return { ok: false, error: "この操作には対応していません。" };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || typeof message?.type !== "string")
    return false;
  let operation;
  if (message.type === "workroom:observe") {
    // Only our top-frame isolated content script may report an observation.
    if (
      !sender.tab ||
      sender.frameId !== 0 ||
      !isChatGPTUrl(sender.url) ||
      !isChatGPTUrl(message.snapshot?.url)
    )
      return false;
    const source = core.conversationFromUrl(sender.tab.url || sender.url);
    const reported = core.conversationFromUrl(message.snapshot.url);
    if ((source?.id || null) !== (reported?.id || null)) return false;
    operation = observeTab(sender.tab.id, message.snapshot);
  } else {
    if (sender.tab || sender.url !== chrome.runtime.getURL("popup.html"))
      return false;
    operation = handlePopup(message);
  }
  operation
    .then(respond)
    .catch(() =>
      respond({
        ok: false,
        error: "接続状態を取得できませんでした。拡張機能を開き直してください。",
      }),
    );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void serial(tabId, async () => {
    const [config, previous] = await Promise.all([
      settings(),
      observation(tabId),
    ]);
    if (previous.active) await sendToOffice(tabId, [], config, previous);
    await chrome.storage.session.remove(sessionKey(tabId));
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url || isChatGPTUrl(changeInfo.url)) return;
  void serial(tabId, async () => {
    const [config, previous] = await Promise.all([
      settings(),
      observation(tabId),
    ]);
    if (previous.active) await sendToOffice(tabId, [], config, previous);
  }).catch(() => {});
});
