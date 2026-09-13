const ACTIVE = new Set(["working", "waiting"]);
const FINISHABLE = new Set(["working", "waiting", "unknown", "error"]);
const FALLBACK = {
  deliveryTray: "Completion tray",
  deliveryLatest: "Latest response completed",
  deliveryEmpty: "No new completions yet",
  deliveryAcknowledge: "Got it",
  deliveryCount: "{count}",
  deliveryOpen: "Open completion tray",
  deliveryClose: "Close",
  deliveryViewTask: "Open task",
  deliveryShowReply: "Show reply",
  deliveryHideReply: "Hide reply",
  deliveryReply: "Codex reply",
  deliveryReplyLoading: "Loading this reply…",
  deliveryReplyUnavailable:
    "This completed reply is not available. Open the task to view its history.",
  deliveryReplyUnsupported:
    "Reply previews are available for local Codex tasks. Open the task to read this reply.",
  deliveryReplyError: "The reply could not be loaded.",
  deliveryReplyRetry: "Try again",
  deliveryReplyTruncated:
    "This reply is shortened. Open the task to read the complete response.",
  deliveryReplyDemo: "Sample reply",
};

function identity(task) {
  const id = task?.taskId || task?.id;
  if (typeof id !== "string" || !id) return null;
  return { id, key: `${task.source || ""}:${id}` };
}

function turnOf(task) {
  const id = task.turnId ?? task.currentTurnId;
  return typeof id === "string" && id ? id : null;
}

/** Observe metadata only. No polling, model calls, storage, or task-state mutations. */
export function createDeliveryTracker({ limit = 30, now = Date.now } = {}) {
  const capacity = Math.max(1, Math.min(30, Math.trunc(Number(limit)) || 30));
  const scopes = new Map();
  let sequence = 0;
  function stateFor(scope = "live") {
    const name = scope === "demo" ? "demo" : "live";
    if (!scopes.has(name))
      scopes.set(name, { previous: new Map(), entries: [] });
    return { name, state: scopes.get(name) };
  }
  function trim() {
    const all = [...scopes.values()].flatMap((state) => state.entries);
    const retained = new Set(
      all
        .sort((a, b) => b.sequence - a.sequence)
        .slice(0, capacity)
        .map((entry) => entry.id),
    );
    for (const state of scopes.values())
      state.entries = state.entries.filter((entry) => retained.has(entry.id));
  }
  return {
    observe(tasks, { scope = "live" } = {}) {
      const { name, state } = stateFor(scope);
      const next = new Map(),
        created = [];
      for (const task of Array.isArray(tasks) ? tasks : []) {
        const ident = identity(task);
        if (!ident || next.has(ident.key)) continue;
        const previous = state.previous.get(ident.key),
          turnId = turnOf(task);
        const sameTurn =
          !previous?.turnId || !turnId || previous.turnId === turnId;
        const active = ACTIVE.has(task.status);
        const alreadyDeliveredTurn =
          turnId &&
          (previous?.deliveredTurn === turnId ||
            state.entries.some(
              (entry) => entry.key === ident.key && entry.turnId === turnId,
            ));
        const completed =
          previous &&
          previous.knownActive &&
          sameTurn &&
          FINISHABLE.has(previous.status) &&
          task.status === "done" &&
          !alreadyDeliveredTurn;
        if (completed) {
          const entry = {
            id: `${name}:${++sequence}`,
            sequence,
            key: ident.key,
            taskId: ident.id,
            source: typeof task.source === "string" ? task.source : "",
            scope: name,
            title:
              typeof task.title === "string"
                ? task.title.slice(0, 500)
                : ident.id,
            at: now(),
            turnId,
            acknowledged: false,
          };
          state.entries.unshift(entry);
          created.push({ ...entry });
        }
        // Unknown/error can preserve an observed active response through a connection gap.
        // A task first seen as done, or an old completion reappearing, is never a new delivery.
        next.set(ident.key, {
          status: task.status,
          turnId: turnId || (sameTurn ? previous?.turnId : null),
          knownActive:
            active ||
            (sameTurn &&
              ["unknown", "error"].includes(task.status) &&
              Boolean(previous?.knownActive)),
          deliveredTurn:
            task.status === "done" && turnId ? turnId : previous?.deliveredTurn,
        });
      }
      state.previous = next;
      trim();
      return created;
    },
    entries(scope = "live") {
      return stateFor(scope).state.entries.map((entry) => ({ ...entry }));
    },
    acknowledge(id, { scope = "live" } = {}) {
      const entry = stateFor(scope).state.entries.find(
        (item) => item.id === id,
      );
      if (!entry) return false;
      entry.acknowledged = true;
      return true;
    },
    reset(scope) {
      if (scope === undefined) scopes.clear();
      else scopes.delete(scope === "demo" ? "demo" : "live");
    },
  };
}

let trayNumber = 0;

export function createDeliveryTray({
  panel,
  getMotion = () => true,
  t,
  onOpenTask,
  getReply,
  getSeats = () => [],
}) {
  const doc = panel.ownerDocument;
  const tracker = createDeliveryTracker();
  let scope = "live",
    open = false,
    toastId = null,
    compactTimer,
    destroyed = false,
    lastRenderKey;
  let replyVersion = 0,
    replyGeneration = 0;
  const flights = new Set();
  const cardButtons = new Map();
  const replyButtons = new Map(),
    replyStates = new Map(),
    replyRequests = new Map(),
    expandedReplies = new Set();
  const replyKey = (entry) =>
    JSON.stringify([
      entry.scope,
      entry.source,
      entry.taskId,
      entry.turnId,
      entry.id,
    ]);

  function cancelReply(key) {
    replyRequests.get(key)?.controller.abort();
    replyRequests.delete(key);
    if (replyStates.get(key)?.status === "loading") replyStates.delete(key);
  }
  function cancelReplyReads() {
    replyGeneration++;
    for (const key of replyRequests.keys()) cancelReply(key);
  }
  function pruneReplies() {
    const retained = new Set(
      [...tracker.entries("live"), ...tracker.entries("demo")].map(replyKey),
    );
    for (const key of replyStates.keys())
      if (!retained.has(key)) {
        cancelReply(key);
        replyStates.delete(key);
        expandedReplies.delete(key);
      }
  }
  function loadReply(entry, retry = false) {
    const key = replyKey(entry);
    if (replyRequests.has(key) || (!retry && replyStates.has(key))) return;
    const controller = new AbortController(),
      generation = replyGeneration;
    const request = { controller, generation };
    replyRequests.set(key, request);
    replyStates.set(key, { status: "loading" });
    replyVersion++;
    render();
    Promise.resolve()
      .then(() => {
        if (
          controller.signal.aborted ||
          destroyed ||
          generation !== replyGeneration
        )
          return;
        return typeof getReply === "function"
          ? getReply({ ...entry }, { signal: controller.signal })
          : { status: "unsupported" };
      })
      .then((result) => {
        if (
          destroyed ||
          controller.signal.aborted ||
          generation !== replyGeneration ||
          replyRequests.get(key) !== request ||
          entry.scope !== scope
        )
          return;
        let state;
        if (
          result?.status === "available" &&
          typeof result.text === "string" &&
          result.taskId === entry.taskId &&
          result.turnId === entry.turnId &&
          (typeof entry.turnId === "string" ||
            (entry.scope === "demo" && result.fictional === true)) &&
          (!result.fictional || entry.scope === "demo")
        ) {
          state = {
            status: "available",
            text: result.text.slice(0, 65536),
            truncated: Boolean(result.truncated) || result.text.length > 65536,
            fictional: entry.scope === "demo" && result.fictional === true,
          };
        } else
          state = {
            status: ["unsupported", "unavailable", "error"].includes(
              result?.status,
            )
              ? result.status
              : "error",
          };
        replyStates.set(key, state);
        replyRequests.delete(key);
        replyVersion++;
        render();
      })
      .catch((error) => {
        if (
          destroyed ||
          controller.signal.aborted ||
          generation !== replyGeneration ||
          replyRequests.get(key) !== request
        )
          return;
        replyRequests.delete(key);
        if (error?.name === "AbortError") replyStates.delete(key);
        else replyStates.set(key, { status: "error" });
        replyVersion++;
        render();
      });
  }
  function toggleReply(entry) {
    const key = replyKey(entry);
    if (expandedReplies.has(key)) {
      expandedReplies.delete(key);
      cancelReply(key);
    } else {
      expandedReplies.add(key);
      open = true;
      toastId = null;
      clearTimeout(compactTimer);
      loadReply(entry);
    }
    replyVersion++;
    render();
    replyButtons.get(entry.id)?.focus({ preventScroll: true });
  }
  function tr(key, values = {}) {
    const translated = typeof t === "function" ? t(key, values) : null;
    let value =
      translated && translated !== key ? translated : FALLBACK[key] || key;
    for (const [name, replacement] of Object.entries(values))
      value = value.replaceAll(`{${name}}`, String(replacement));
    return value;
  }
  function node(tag, className, value) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  }
  const root = node("section", "delivery-root"),
    recent = node("div", "delivery-recent"),
    drawer = node("section", "delivery-history");
  recent.hidden = true;
  recent.setAttribute("role", "status");
  recent.setAttribute("aria-live", "polite");
  recent.setAttribute("aria-atomic", "true");
  drawer.hidden = true;
  drawer.id = `delivery-history-${++trayNumber}`;
  const header = node("div", "delivery-history-heading"),
    heading = node("h2"),
    closeButton = node("button", "delivery-close", "×"),
    subtitle = node("p", "delivery-subtitle"),
    list = node("ol", "delivery-list"),
    empty = node("p", "delivery-empty");
  closeButton.type = "button";
  header.append(heading, closeButton);
  drawer.append(header, subtitle, list, empty);
  const trigger = node("button", "delivery-toggle"),
    icon = node("span", "delivery-tray-icon"),
    triggerLabel = node("span", "delivery-toggle-label"),
    badge = node("span", "delivery-badge");
  trigger.type = "button";
  icon.setAttribute("aria-hidden", "true");
  badge.setAttribute("aria-hidden", "true");
  trigger.setAttribute("aria-controls", drawer.id);
  trigger.append(icon, triggerLabel, badge);
  root.append(recent, drawer, trigger);
  panel.append(root);

  function formatTime(at) {
    try {
      return new Intl.DateTimeFormat(doc.documentElement.lang || undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }).format(at);
    } catch {
      return new Date(at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
  }
  function clearFlights() {
    for (const flight of flights) {
      clearTimeout(flight.timer);
      flight.element.remove();
    }
    flights.clear();
  }
  function syncMotion() {
    root.dataset.motion = getMotion() ? "on" : "off";
    if (!getMotion()) clearFlights();
  }
  function acknowledge(id) {
    tracker.acknowledge(id, { scope });
    if (toastId === id) {
      toastId = null;
      clearTimeout(compactTimer);
    }
    render();
    if (open) cardButtons.get(id)?.focus({ preventScroll: true });
  }
  function card(entry, isRecent = false) {
    const card = node(
      "article",
      `delivery-card${isRecent ? " is-new" : ""}${entry.acknowledged ? " acknowledged" : ""}`,
    );
    if (isRecent)
      card.append(node("p", "delivery-card-kicker", tr("deliveryLatest")));
    const title = node("button", "delivery-task-title", entry.title);
    title.type = "button";
    title.title = tr("deliveryShowReply");
    title.onclick = () => toggleReply(entry);
    if (!isRecent) cardButtons.set(entry.id, title);
    const footer = node("div", "delivery-card-footer"),
      time = node("time", "delivery-time", formatTime(entry.at)),
      acknowledgeButton = node(
        "button",
        "delivery-acknowledge",
        `${entry.acknowledged ? "✓ " : ""}${tr("deliveryAcknowledge")}`,
      );
    time.dateTime = new Date(entry.at).toISOString();
    acknowledgeButton.type = "button";
    acknowledgeButton.disabled = entry.acknowledged;
    acknowledgeButton.onclick = () => acknowledge(entry.id);
    footer.append(time, acknowledgeButton);
    const key = replyKey(entry),
      expanded = expandedReplies.has(key);
    title.title = tr(expanded ? "deliveryHideReply" : "deliveryShowReply");
    const actions = node("div", "delivery-card-actions"),
      replyButton = node(
        "button",
        "delivery-reply-toggle",
        tr(expanded ? "deliveryHideReply" : "deliveryShowReply"),
      ),
      openTaskButton = node(
        "button",
        "delivery-view-task",
        tr("deliveryViewTask"),
      ),
      reply = node("div", "delivery-reply");
    reply.id = `delivery-reply-${trayNumber}-${entry.sequence}-${isRecent ? "recent" : "history"}`;
    reply.hidden = !expanded;
    reply.setAttribute("aria-label", tr("deliveryReply"));
    replyButton.type = openTaskButton.type = "button";
    for (const button of [title, replyButton]) {
      button.setAttribute("aria-controls", reply.id);
      button.setAttribute("aria-expanded", String(expanded));
    }
    replyButton.onclick = () => toggleReply(entry);
    openTaskButton.onclick = () => onOpenTask?.(entry.taskId);
    if (!isRecent) replyButtons.set(entry.id, replyButton);
    actions.append(replyButton, openTaskButton);
    if (expanded) {
      const state = replyStates.get(key) || { status: "unavailable" };
      if (state.status === "available") {
        // Replies can contain HTML, Markdown and code. They are always plain text.
        if (state.fictional)
          reply.append(
            node("p", "delivery-reply-status", tr("deliveryReplyDemo")),
          );
        reply.append(node("pre", "delivery-reply-text", state.text));
        if (state.truncated)
          reply.append(
            node("p", "delivery-reply-status", tr("deliveryReplyTruncated")),
          );
      } else {
        const labels = {
          loading: "deliveryReplyLoading",
          unsupported: "deliveryReplyUnsupported",
          unavailable: "deliveryReplyUnavailable",
          error: "deliveryReplyError",
        };
        const feedback = node(
          "p",
          "delivery-reply-status",
          tr(labels[state.status] || "deliveryReplyUnavailable"),
        );
        feedback.setAttribute("role", "status");
        reply.append(feedback);
        if (["unavailable", "error"].includes(state.status)) {
          const retry = node(
            "button",
            "delivery-reply-retry",
            tr("deliveryReplyRetry"),
          );
          retry.type = "button";
          retry.onclick = () => loadReply(entry, true);
          reply.append(retry);
        }
      }
    }
    card.append(title, actions, reply, footer);
    return card;
  }
  function render(force = false) {
    if (destroyed) return;
    const entries = tracker.entries(scope),
      unread = entries.filter((entry) => !entry.acknowledged).length;
    syncMotion();
    const signature = JSON.stringify([
      scope,
      open,
      toastId,
      doc.documentElement.lang,
      replyVersion,
      entries.map((entry) => [entry.id, entry.acknowledged]),
    ]);
    if (!force && signature === lastRenderKey) return;
    lastRenderKey = signature;
    root.dataset.scope = scope;
    root.classList.toggle(
      "is-reading",
      entries.some((entry) => expandedReplies.has(replyKey(entry))),
    );
    root.setAttribute("aria-label", tr("deliveryTray"));
    triggerLabel.textContent = tr("deliveryTray");
    badge.textContent = String(unread);
    trigger.setAttribute(
      "aria-label",
      `${tr("deliveryOpen")} · ${tr("deliveryCount", { count: unread })}`,
    );
    trigger.setAttribute("aria-expanded", String(open));
    trigger.classList.toggle("has-unread", unread > 0);
    heading.textContent = tr("deliveryTray");
    subtitle.textContent = tr("deliveryLatest");
    closeButton.setAttribute("aria-label", tr("deliveryClose"));
    empty.textContent = tr("deliveryEmpty");
    empty.hidden = entries.length > 0;
    cardButtons.clear();
    const focusedReply = [...replyButtons].find(
      ([, button]) => button === doc.activeElement,
    )?.[0];
    replyButtons.clear();
    list.replaceChildren(
      ...entries.map((entry) => {
        const item = node("li");
        item.append(card(entry));
        return item;
      }),
    );
    drawer.hidden = !open;
    const current = entries.find(
      (entry) => entry.id === toastId && !entry.acknowledged,
    );
    recent.replaceChildren();
    recent.hidden = !current || open;
    if (current && !open) recent.append(card(current, true));
    if (focusedReply)
      replyButtons.get(focusedReply)?.focus({ preventScroll: true });
  }
  function setOpen(value, returnFocus = false) {
    open = value;
    render();
    if (open) closeButton.focus({ preventScroll: true });
    if (returnFocus) trigger.focus({ preventScroll: true });
  }
  trigger.onclick = () => setOpen(!open);
  closeButton.onclick = () => setOpen(false, true);
  const onKeyDown = (event) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false, true);
    }
  };
  const onOutside = (event) => {
    if (open && !root.contains(event.target)) setOpen(false);
  };
  root.addEventListener("keydown", onKeyDown);
  doc.addEventListener("pointerdown", onOutside);

  function flyPaper(entry) {
    if (!getMotion() || doc.hidden || flights.size >= 3) return;
    const viewport = panel.querySelector("#office-viewport");
    if (!viewport || viewport.hidden) return;
    const bounds = panel.getBoundingClientRect(),
      view = viewport.getBoundingClientRect(),
      target = trigger.getBoundingClientRect();
    if (!view.width || !view.height || !target.width) return;
    const seats = getSeats() || [];
    const seat = seats.find(
      (item) =>
        (item.task?.taskId || item.task?.id) === entry.taskId && item.button,
    );
    const origin = seat?.button?.getBoundingClientRect();
    const originVisible =
      origin &&
      origin.top < view.bottom &&
      origin.bottom > view.top &&
      origin.left < view.right &&
      origin.right > view.left;
    const fromX =
      Math.min(
        view.right - 12,
        Math.max(
          view.left + 12,
          originVisible
            ? origin.left + origin.width / 2
            : view.left + view.width * 0.6,
        ),
      ) - bounds.left;
    const fromY =
      Math.min(
        view.bottom - 18,
        Math.max(
          view.top + 20,
          originVisible
            ? origin.top + origin.height * 0.7
            : view.top + Math.min(view.height * 0.45, 220),
        ),
      ) - bounds.top;
    const toX = target.left + 25 - bounds.left,
      toY = target.top + target.height / 2 - bounds.top;
    const paper = node("span", "delivery-paper");
    paper.setAttribute("aria-hidden", "true");
    paper.style.left = `${fromX}px`;
    paper.style.top = `${fromY}px`;
    paper.style.setProperty("--delivery-dx", `${toX - fromX}px`);
    paper.style.setProperty("--delivery-dy", `${toY - fromY}px`);
    panel.append(paper);
    const flight = { element: paper };
    flight.timer = setTimeout(() => {
      paper.remove();
      flights.delete(flight);
    }, 1150);
    flights.add(flight);
  }

  render();
  return {
    observe(tasks, options = {}) {
      if (destroyed) return [];
      const nextScope = options.scope === "demo" ? "demo" : "live";
      if (nextScope !== scope) {
        cancelReplyReads();
        expandedReplies.clear();
        scope = nextScope;
        open = false;
        toastId = null;
        clearTimeout(compactTimer);
        clearFlights();
      }
      const created = tracker.observe(tasks, { scope });
      pruneReplies();
      if (created.length) {
        toastId = created.at(-1).id;
        clearTimeout(compactTimer);
        compactTimer = setTimeout(() => {
          toastId = null;
          render();
        }, 8000);
      }
      render();
      created.slice(-3).forEach(flyPaper);
      return created;
    },
    refreshText: () => render(true),
    refreshMotion: syncMotion,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelReplyReads();
      replyStates.clear();
      expandedReplies.clear();
      clearTimeout(compactTimer);
      clearFlights();
      root.removeEventListener("keydown", onKeyDown);
      doc.removeEventListener("pointerdown", onOutside);
      root.remove();
      tracker.reset();
    },
  };
}
