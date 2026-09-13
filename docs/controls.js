import { getLocale } from "./i18n.js";

export function usageWindows(usage) {
  const plan = String(usage?.planType || "").toLowerCase();
  return (Array.isArray(usage?.windows) ? usage.windows : []).filter(
    (window) =>
      Number.isFinite(window.usedPercent) &&
      Number.isFinite(window.durationMinutes) &&
      (plan === "pro"
        ? window.durationMinutes === 10080
        : plan === "plus"
          ? [300, 10080].includes(window.durationMinutes)
          : true),
  );
}

export function createCodexControls({ t, getView, onSubmitted }) {
  const $ = (selector) => document.querySelector(selector);
  const quota = $("#codex-usage"),
    windows = $("#usage-windows"),
    message = $("#usage-message");
  const dialog = $("#command-dialog"),
    form = $("#command-form"),
    input = $("#command-text");
  const project = $("#command-project"),
    feedback = $("#command-feedback");
  let usage = null,
    loading = false,
    target = null,
    sending = false,
    lastRequest = null,
    publicMode = document.documentElement.dataset.mode === "demo";
  const set = (selector, key) => {
    $(selector).textContent = t(key);
  };
  function refreshText() {
    set("#usage-heading", "usageTitle");
    $("#usage-refresh").setAttribute("aria-label", t("usageRefresh"));
    set("#command-heading", "commandTitle");
    set("#command-new", "commandNew");
    set("#command-continue", "commandContinue");
    set("#command-project-label", "commandProject");
    set("#command-input-label", "commandPrompt");
    set("#command-hint", "commandHint");
    set("#command-restriction", "commandRestricted");
    $("#command-close").setAttribute("aria-label", t("close"));
    input.placeholder = t("commandPlaceholder");
    $("#command-send").textContent = t(
      sending ? "commandSending" : "commandSend",
    );
    if (dialog.open)
      $("#command-dialog-title").textContent = t(
        target ? "commandContinue" : "commandNew",
      );
    renderUsage();
    refreshTask();
  }
  function renderUsage() {
    quota.dataset.state = usage?.status || "loading";
    $("#usage-plan").textContent = usage?.planType
      ? String(usage.planType).replace(/^./, (c) => c.toUpperCase())
      : "";
    $("#usage-refresh").disabled = loading || publicMode;
    windows.replaceChildren();
    if (publicMode) {
      message.textContent = t("usageDemo");
      return;
    }
    if (loading && !usage) {
      message.textContent = t("usageLoading");
      return;
    }
    const display = usageWindows(usage);
    message.textContent = display.length
      ? usage.stale
        ? t("usageUnavailable")
        : ""
      : t("usageUnavailable");
    for (const item of display) {
      const row = document.createElement("div");
      row.className = "usage-window";
      const heading = document.createElement("div");
      heading.className = "usage-window-heading";
      const label = document.createElement("span");
      label.textContent =
        item.durationMinutes === 10080
          ? t("usageWeek")
          : item.durationMinutes === 300
            ? t("usageHours")
            : `${item.durationMinutes} min`;
      const remaining = Math.max(0, Math.min(100, 100 - item.usedPercent));
      const amount = document.createElement("strong");
      amount.textContent = t("usageRemaining", {
        percent: new Intl.NumberFormat(getLocale(), {
          maximumFractionDigits: 1,
        }).format(remaining),
      });
      heading.append(label, amount);
      const bar = document.createElement("meter");
      bar.min = 0;
      bar.max = 100;
      bar.value = remaining;
      bar.setAttribute(
        "aria-label",
        `${label.textContent} ${amount.textContent}`,
      );
      row.append(heading, bar);
      if (Number.isFinite(item.resetsAt)) {
        const reset = document.createElement("small");
        reset.textContent = t("usageReset", {
          time: new Intl.DateTimeFormat(getLocale(), {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          }).format(new Date(item.resetsAt * 1000)),
        });
        row.append(reset);
      }
      windows.append(row);
    }
  }
  async function refreshUsage() {
    if (publicMode || loading || document.hidden) return;
    loading = true;
    renderUsage();
    try {
      const response = await fetch("/api/usage");
      if (!response.ok) throw Error();
      usage = await response.json();
    } catch {
      usage = { ...usage, status: "unavailable", stale: true };
    } finally {
      loading = false;
      renderUsage();
    }
  }
  function refreshTask() {
    const view = getView();
    const task = view.tasks.find((task) => task.id === view.selected);
    const allowed =
      task?.source === "codex" &&
      !["working", "waiting", "unknown"].includes(task.status) &&
      !view.demo;
    $("#command-continue").disabled = !allowed;
    $("#command-new").disabled = Boolean(view.demo || publicMode);
    $("#command-context").textContent =
      view.demo || publicMode
        ? t("commandDemo")
        : !task
          ? t("commandChoose")
          : task.source !== "codex"
            ? t("commandLocalOnly")
            : ["working", "waiting", "unknown"].includes(task.status)
              ? t("commandBusy")
              : task.title;
    const handoffs = view.control?.handoffs || [];
    $("#command-handoff").hidden = !handoffs.length;
    $("#command-handoff").textContent = handoffs.length
      ? t("commandHandoff")
      : "";
  }
  function open(task) {
    if (getView().demo || publicMode) return;
    target = task || null;
    feedback.textContent = "";
    input.value = "";
    lastRequest = null;
    $("#command-dialog-title").textContent = t(
      target ? "commandContinue" : "commandNew",
    );
    $("#command-target").textContent = target?.title || "";
    $("#command-project-row").hidden = Boolean(target);
    project.replaceChildren(new Option(t("commandWorkspace"), ""));
    const seen = new Set();
    for (const item of getView().tasks)
      if (
        item.source === "codex" &&
        !seen.has(item.projectKey || item.project)
      ) {
        seen.add(item.projectKey || item.project);
        project.append(
          new Option(item.projectName || item.project || item.title, item.id),
        );
      }
    dialog.showModal();
    input.focus();
  }
  $("#usage-refresh").onclick = refreshUsage;
  $("#command-new").onclick = () => open(null);
  $("#command-continue").onclick = () =>
    open(getView().tasks.find((task) => task.id === getView().selected));
  $("#command-close").onclick = () => {
    if (!sending) dialog.close();
  };
  dialog.addEventListener("cancel", (event) => {
    if (sending) event.preventDefault();
  });
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (sending || publicMode || getView().demo || !input.value.trim()) return;
    const body = {
      text: input.value.trim(),
      ...(target
        ? { taskId: target.id }
        : { projectTaskId: project.value || undefined }),
    };
    const fingerprint = JSON.stringify(body);
    if (!lastRequest || lastRequest.fingerprint !== fingerprint)
      lastRequest = { fingerprint, id: crypto.randomUUID() };
    body.requestId = lastRequest.id;
    sending = true;
    feedback.textContent = t("commandSending");
    $("#command-send").disabled = true;
    $("#command-close").disabled = true;
    input.disabled = true;
    project.disabled = true;
    refreshText();
    try {
      const response = await fetch("/api/instructions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Workroom-Action": "instruction",
        },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok || !result.taskId) {
        feedback.textContent = t(
          result.error === "busy"
            ? "commandBusy"
            : result.error === "outcome_unknown" ||
                result.code === "SANDBOX_SETUP_REQUIRED"
              ? "commandHandoff"
              : "commandFailed",
        );
        if (result.error !== "outcome_unknown") lastRequest = null;
        return;
      }
      feedback.textContent = t("commandSent");
      input.value = "";
      lastRequest = null;
      onSubmitted?.(result, body.text, target);
      void refreshUsage();
    } catch {
      feedback.textContent = t("commandFailed");
    } finally {
      sending = false;
      input.disabled = false;
      project.disabled = false;
      $("#command-send").disabled = false;
      $("#command-close").disabled = false;
      refreshText();
    }
  };
  const timer = setInterval(refreshUsage, 60000);
  const onVisible = () => {
    if (!document.hidden) void refreshUsage();
  };
  document.addEventListener("visibilitychange", onVisible);
  refreshText();
  void refreshUsage();
  return {
    refreshText,
    refreshTask,
    refreshUsage,
    destroy() {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    },
  };
}
