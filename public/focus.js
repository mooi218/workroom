const FALLBACK = {
  focusEnter: "Show the office in full screen",
  focusExit: "Exit full screen",
};

export function createFocusView({
  panel,
  viewport,
  button,
  usagePanel = null,
  t,
}) {
  const doc = panel.ownerDocument,
    win = doc.defaultView;
  let active = false,
    native = false,
    saved = null,
    revision = 0,
    destroyed = false;
  const placeholder = doc.createComment("workroom-focus-button");
  const usagePlaceholder = doc.createComment("workroom-focus-usage");
  const icon = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "18");
  icon.setAttribute("height", "18");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  const corners = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  corners.setAttribute("d", "M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5");
  corners.setAttribute("fill", "none");
  corners.setAttribute("stroke", "currentColor");
  corners.setAttribute("stroke-width", "2");
  icon.append(corners);
  button.classList.add("focus-toggle");
  button.type = "button";
  function tr(key) {
    const translated = typeof t === "function" ? t(key) : null;
    return translated && translated !== key ? translated : FALLBACK[key];
  }
  function refreshText() {
    const label = tr(active ? "focusExit" : "focusEnter");
    if (active) button.textContent = `× ${label}`;
    else button.replaceChildren(icon);
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", String(active));
    button.title = label;
  }
  function muteOutside() {
    const changed = [];
    let current = panel;
    while (current.parentElement && current !== doc.body) {
      for (const sibling of current.parentElement.children) {
        if (
          sibling === current ||
          ["SCRIPT", "STYLE", "LINK"].includes(sibling.tagName)
        )
          continue;
        changed.push({
          element: sibling,
          inert: sibling.inert,
          hidden: sibling.getAttribute("aria-hidden"),
        });
        sibling.inert = true;
        sibling.setAttribute("aria-hidden", "true");
      }
      current = current.parentElement;
    }
    return changed;
  }
  function restore() {
    if (!active) return;
    active = false;
    native = false;
    const previous = saved;
    saved = null;
    panel.classList.remove("focus-mode");
    delete panel.dataset.focus;
    button.classList.remove("focus-exit");
    if (placeholder.parentNode) placeholder.replaceWith(button);
    if (usagePlaceholder.parentNode) usagePlaceholder.replaceWith(usagePanel);
    usagePanel?.classList.remove("focus-usage");
    if (previous) {
      doc.body.style.overflow = previous.overflow;
      doc.body.classList.toggle("workroom-focus-active", previous.bodyClass);
      viewport.hidden = previous.viewportHidden;
      if (previous.table) previous.table.hidden = previous.tableHidden;
      for (const { element, inert, hidden } of previous.muted) {
        element.inert = inert;
        if (hidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", hidden);
      }
      viewport.scrollTop = previous.viewportTop;
      viewport.scrollLeft = previous.viewportLeft;
      win.scrollTo(previous.scrollX, previous.scrollY);
      // Office layout is updated by ResizeObserver after the fullscreen dimensions change.
      const restoreRevision = revision;
      win.requestAnimationFrame(() =>
        win.requestAnimationFrame(() => {
          if (!active && revision === restoreRevision) {
            viewport.scrollTop = previous.viewportTop;
            viewport.scrollLeft = previous.viewportLeft;
            win.scrollTo(previous.scrollX, previous.scrollY);
          }
        }),
      );
    }
    refreshText();
    if (!destroyed) button.focus({ preventScroll: true });
  }
  async function enter() {
    if (active || destroyed) return active;
    const token = ++revision,
      table = panel.querySelector("#jobs-table");
    saved = {
      overflow: doc.body.style.overflow,
      bodyClass: doc.body.classList.contains("workroom-focus-active"),
      scrollX: win.scrollX,
      scrollY: win.scrollY,
      viewportTop: viewport.scrollTop,
      viewportLeft: viewport.scrollLeft,
      viewportHidden: viewport.hidden,
      table,
      tableHidden: table?.hidden,
    };
    active = true;
    button.before(placeholder);
    panel.append(button);
    if (usagePanel) {
      usagePanel.before(usagePlaceholder);
      panel.append(usagePanel);
      usagePanel.classList.add("focus-usage");
    }
    panel.classList.add("focus-mode");
    panel.dataset.focus = "fallback";
    button.classList.add("focus-exit");
    viewport.hidden = false;
    if (table) table.hidden = true;
    doc.body.style.overflow = "hidden";
    doc.body.classList.add("workroom-focus-active");
    saved.muted = muteOutside();
    refreshText();
    button.focus({ preventScroll: true });
    if (
      typeof panel.requestFullscreen === "function" &&
      !doc.fullscreenElement
    ) {
      try {
        await panel.requestFullscreen();
        if (destroyed || !active || token !== revision) {
          if (doc.fullscreenElement === panel) await doc.exitFullscreen?.();
          return false;
        }
        if (doc.fullscreenElement === panel) {
          native = true;
          panel.dataset.focus = "native";
        }
      } catch {
        // Browser policies and embedded previews can deny fullscreen; the fixed view remains usable.
      }
    }
    return active;
  }
  async function exit() {
    ++revision;
    const shouldExitNative = doc.fullscreenElement === panel;
    restore();
    if (shouldExitNative && typeof doc.exitFullscreen === "function") {
      try {
        await doc.exitFullscreen();
      } catch {
        /* The browser may already have exited. */
      }
    }
  }
  function onFullscreenChange() {
    if (doc.fullscreenElement === panel && active) {
      native = true;
      panel.dataset.focus = "native";
    } else if (native && active) {
      ++revision;
      restore();
    }
  }
  function onKeyDown(event) {
    if (active && event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      void exit();
    }
  }
  const onClick = () => {
    if (active) void exit();
    else void enter();
  };
  button.addEventListener("click", onClick);
  doc.addEventListener("keydown", onKeyDown);
  doc.addEventListener("fullscreenchange", onFullscreenChange);
  refreshText();
  return {
    enter,
    exit,
    toggle: () => (active ? exit() : enter()),
    refreshText,
    get active() {
      return active;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      void exit();
      button.removeEventListener("click", onClick);
      doc.removeEventListener("keydown", onKeyDown);
      doc.removeEventListener("fullscreenchange", onFullscreenChange);
      button.classList.remove("focus-toggle");
    },
  };
}
