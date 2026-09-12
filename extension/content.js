/* Runs in Chrome's isolated world. It never reads messages, cookies, or page storage. */
(() => {
  "use strict";
  if (globalThis.__workroomCloudObserver) return;
  globalThis.__workroomCloudObserver = true;
  const core = globalThis.WorkroomObserverCore;
  const DEBOUNCE_MS = 500;
  const MAX_DEBOUNCE_MS = 2000;
  const HEARTBEAT_MS = 30_000;
  const MESSAGE_CONTENT =
    '[data-message-author-role], [data-testid^="conversation-turn"], article[data-turn], .markdown, pre, code, textarea, input, [contenteditable="true"]';
  const OTHER_TASKS =
    'nav, aside, [role="navigation"], [role="menu"], [role="listbox"]';
  let timer = null;
  let burstStartedAt = null;
  let previousSignature = "";
  let stopped = false;
  let sending = false;
  let pendingForce = false;

  function visible(element) {
    if (
      !element.isConnected ||
      element.closest('[hidden], [aria-hidden="true"]')
    )
      return false;
    if (!element.getClientRects().length) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none";
  }

  function record(element, readLabel = true) {
    const inConversation = !!element.closest(MESSAGE_CONTENT);
    const outsideTask = !!element.closest(OTHER_TASKS);
    const scope =
      !outsideTask && element.closest('main, [role="main"]')
        ? "main"
        : !outsideTask &&
            element.closest('header, [data-testid="conversation-header"]')
          ? "header"
          : "other";
    const qualifies = !inConversation && scope !== "other" && visible(element);
    let label = "";
    if (qualifies && readLabel) {
      // Only short labels from task controls are examined. Do not take the text
      // of an enclosing status region if it also contains a conversation.
      const accessible = element.getAttribute("aria-label");
      if (accessible) label = core.cleanText(accessible, 160);
      else if (!element.querySelector(MESSAGE_CONTENT)) {
        const text = element.textContent || "";
        if (text.length <= 160) label = core.cleanText(text, 160);
      }
    }
    return {
      visible: qualifies,
      inConversation,
      scope,
      label,
      testId: element.getAttribute("data-testid") || "",
      disabled: element.matches(':disabled, [aria-disabled="true"]'),
    };
  }

  function select(selector) {
    return Array.from(document.querySelectorAll(selector));
  }

  function collectSnapshot() {
    if (!core.conversationFromUrl(location.href))
      return { url: location.href, title: "", signals: {} };
    const controls = select(
      'button[aria-label], [role="button"][aria-label], button[data-testid="stop-button"], button[data-testid="stop-generating-button"]',
    )
      .slice(0, 250)
      .map((element) => record(element));
    const workMarkers = select(
      'button[aria-pressed="true"], [role="tab"][aria-selected="true"], [role="radio"][aria-checked="true"], [data-mode="work"], [data-chat-mode="work"], [data-work-mode="true"], [data-testid="work-mode-indicator"], [data-testid="work-mode-selected"]',
    )
      .slice(0, 100)
      .map((element) => ({
        ...record(
          element,
          !element.matches(
            '[data-mode="work"], [data-chat-mode="work"], [data-work-mode="true"]',
          ),
        ),
        selected: element.matches(
          '[aria-pressed="true"], [aria-selected="true"], [aria-checked="true"]',
        ),
        explicitWork: element.matches(
          '[data-mode="work"], [data-chat-mode="work"], [data-work-mode="true"], [data-testid="work-mode-indicator"], [data-testid="work-mode-selected"]',
        ),
      }));
    const busy = select(
      'main[aria-busy="true"], [role="main"][aria-busy="true"], [data-testid="conversation"][aria-busy="true"], [data-testid="work-status"][aria-busy="true"], [data-testid="agent-status"][aria-busy="true"]',
    )
      .slice(0, 100)
      .map((element) => ({ ...record(element, false), busy: true }));
    const statuses = select(
      '[data-task-status], [data-work-status], [data-testid="work-status"], [data-testid="task-status"], [data-testid="agent-status"], [role="status"][aria-label], [role="alert"][aria-label]',
    )
      .slice(0, 100)
      .map((element) => {
        const item = record(element);
        if (item.visible)
          item.label = core.cleanText(
            element.getAttribute("data-work-status") ||
              element.getAttribute("data-task-status") ||
              item.label,
            160,
          );
        return {
          ...item,
          explicitWork: element.matches(
            '[data-work-status], [data-testid="work-status"]',
          ),
        };
      });
    return {
      url: location.href,
      title: core.titleFromPage(document.title),
      signals: core.deriveSignals({ controls, workMarkers, busy, statuses }),
    };
  }

  async function observe(force = false) {
    if (stopped) return;
    if (sending) {
      pendingForce ||= force;
      schedule();
      return;
    }
    const snapshot = collectSnapshot();
    const signature = JSON.stringify(snapshot);
    if (!force && signature === previousSignature) return;
    sending = true;
    try {
      const result = await chrome.runtime.sendMessage({
        type: "workroom:observe",
        snapshot,
      });
      if (result?.ok) previousSignature = signature;
    } catch (error) {
      // Reloading an unpacked extension invalidates an old content context.
      if (/context invalidated/iu.test(String(error))) stop();
    } finally {
      sending = false;
      if (pendingForce) {
        pendingForce = false;
        void observe(true);
      }
    }
  }

  function schedule() {
    if (stopped) return;
    const now = Date.now();
    if (burstStartedAt === null) burstStartedAt = now;
    clearTimeout(timer);
    // Trailing 500 ms debounce, with a 2 s ceiling so continuously streaming
    // pages cannot postpone state updates indefinitely.
    const delay = Math.min(
      DEBOUNCE_MS,
      Math.max(0, MAX_DEBOUNCE_MS - (now - burstStartedAt)),
    );
    timer = setTimeout(() => {
      timer = null;
      burstStartedAt = null;
      void observe();
    }, delay);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "aria-busy",
      "aria-label",
      "aria-hidden",
      "aria-pressed",
      "aria-selected",
      "aria-checked",
      "aria-disabled",
      "hidden",
      "data-task-status",
      "data-work-status",
      "data-mode",
      "data-chat-mode",
      "data-work-mode",
      "data-testid",
      "disabled",
    ],
  });
  const heartbeat = setInterval(() => {
    void observe(true);
  }, HEARTBEAT_MS);
  const onNavigation = () => {
    void observe(true);
  };
  const onVisibility = () => {
    if (!document.hidden) void observe(true);
  };
  window.addEventListener("popstate", onNavigation);
  window.addEventListener("hashchange", onNavigation);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("pageshow", onNavigation);

  function onMessage(message, _sender, respond) {
    if (message?.type === "workroom:inspect") {
      respond({ ok: true, snapshot: collectSnapshot() });
    } else if (message?.type === "workroom:refresh") {
      previousSignature = "";
      void observe(true);
      respond({ ok: true });
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);

  function stop() {
    stopped = true;
    observer.disconnect();
    clearTimeout(timer);
    clearInterval(heartbeat);
    window.removeEventListener("popstate", onNavigation);
    window.removeEventListener("hashchange", onNavigation);
    window.removeEventListener("pageshow", onNavigation);
    document.removeEventListener("visibilitychange", onVisibility);
    chrome.runtime.onMessage.removeListener(onMessage);
  }
  void observe(true);
})();
