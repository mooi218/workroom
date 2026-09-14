import {
  DEFAULT_DISPLAY_SELECTION,
  normalizeDisplaySelection,
  taskSelectionKey,
  matchesDisplaySelection,
} from "./selection-model.mjs";
import { groupWork, projectKey, projectName } from "./projects.js";

/** The live selection belongs to this PC; the fictional demo has separate browser storage. */
export function createWorkSelection({
  button,
  getTasks,
  t,
  onChange,
  onError,
}) {
  const doc = button.ownerDocument;
  const states = new Map(),
    loaded = new Set(),
    pending = new Map(),
    queues = new Map();
  let scope = "live",
    ready = false,
    loadError = false,
    saving = false,
    draft = null,
    query = "",
    opener;
  let chosen = new Set(),
    expanded = new Set();
  const empty = () =>
    normalizeDisplaySelection({
      ...DEFAULT_DISPLAY_SELECTION,
      mode: "selected",
      taskKeys: [],
    });
  const make = (tag, className, text) => {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const dialog = make("dialog", "work-selection-dialog");
  dialog.id = "work-selection-dialog";
  const header = make("div", "dialog-heading"),
    title = make("h2"),
    close = make("button", "icon-button", "×");
  title.id = "work-selection-title";
  dialog.setAttribute("aria-labelledby", title.id);
  close.type = "button";
  header.append(title, close);
  const help = make("p", "work-selection-help"),
    modes = make("fieldset", "work-selection-modes"),
    legend = make("legend", "sr-only");
  modes.append(legend);
  const allLabel = make("label"),
    someLabel = make("label");
  const all = make("input"),
    some = make("input"),
    allText = make("span"),
    someText = make("span");
  all.type = some.type = "radio";
  all.name = some.name = "work-selection-mode";
  all.value = "all";
  some.value = "selected";
  allLabel.append(all, allText);
  someLabel.append(some, someText);
  modes.append(allLabel, someLabel);
  const tools = make("div", "work-selection-tools"),
    search = make("input"),
    clear = make("button", "secondary-button");
  search.type = "search";
  clear.type = "button";
  tools.append(search, clear);
  const summary = make("p", "work-selection-summary"),
    missing = make("p", "work-selection-missing"),
    list = make("div", "work-selection-list");
  const feedback = make("p", "work-selection-feedback"),
    retry = make("button", "secondary-button"),
    footer = make("div", "work-selection-footer"),
    cancel = make("button", "secondary-button"),
    apply = make("button", "primary-button");
  feedback.setAttribute("role", "status");
  retry.type = cancel.type = apply.type = "button";
  retry.hidden = true;
  footer.append(retry, cancel, apply);
  dialog.append(
    header,
    help,
    modes,
    tools,
    summary,
    missing,
    list,
    feedback,
    footer,
  );
  doc.body.append(dialog);
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-controls", dialog.id);
  const current = () => states.get(scope) || empty();
  const rows = () => {
    const unique = new Map();
    for (const task of getTasks()) {
      const key = taskSelectionKey(task);
      if (key && !unique.has(key)) unique.set(key, task);
    }
    return [...unique].map(([key, task]) => ({ key, task }));
  };
  function activate(value) {
    states.set(scope, value);
    chosen = new Set(value.taskKeys);
    ready = true;
    refreshText();
    onChange?.(value);
  }
  async function read(which) {
    if (which === "demo") {
      const raw = localStorage.getItem("workroom.display.demo.v1");
      return raw === null
        ? DEFAULT_DISPLAY_SELECTION
        : normalizeDisplaySelection(JSON.parse(raw));
    }
    const response = await fetch("/api/display-selection", {
      cache: "no-store",
    });
    if (!response.ok) throw Error("Selection unavailable");
    return normalizeDisplaySelection(await response.json());
  }
  async function setScope(which, reload = false) {
    scope = which === "demo" ? "demo" : "live";
    const requested = scope;
    if (dialog.open) dialog.close();
    ready = loaded.has(scope) && !reload;
    loadError = false;
    chosen = new Set(current().taskKeys);
    refreshText();
    if (ready) {
      onChange?.(current());
      return true;
    }
    if (!pending.has(requested))
      pending.set(
        requested,
        read(requested).finally(() => pending.delete(requested)),
      );
    try {
      const value = await pending.get(requested);
      states.set(requested, value);
      loaded.add(requested);
      if (scope === requested) activate(value);
      return true;
    } catch {
      if (scope === requested) {
        ready = false;
        loadError = true;
        refreshText();
        onChange?.(empty());
      }
      return false;
    }
  }
  function write(value, which) {
    const operation = (queues.get(which) || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (which === "demo")
          localStorage.setItem(
            "workroom.display.demo.v1",
            JSON.stringify(value),
          );
        else {
          const body = JSON.stringify(value);
          const response = await fetch("/api/display-selection", {
            method: "PUT",
            keepalive: new TextEncoder().encode(body).length <= 60000,
            headers: {
              "Content-Type": "application/json",
              "X-Workroom-Action": "display-selection",
            },
            body,
          });
          if (!response.ok) throw Error("Selection was not saved");
          normalizeDisplaySelection(await response.json());
        }
        return value;
      });
    queues.set(which, operation);
    return operation;
  }
  function refreshText() {
    const value = current();
    button.disabled = !ready && !loadError;
    apply.disabled = saving || !ready;
    button.textContent = !ready
      ? t(loadError ? "selectionLoadErrorShort" : "selectionLoading")
      : value.mode === "all"
        ? t("allProjects")
        : t("selectionCount", { count: value.taskKeys.length });
    button.setAttribute(
      "aria-label",
      `${t("selectionTitle")}: ${button.textContent}`,
    );
    title.textContent = t("selectionTitle");
    close.setAttribute("aria-label", t("close"));
    help.textContent = t("selectionHelp");
    legend.textContent = t("selectionTitle");
    allText.textContent = t("allProjects");
    someText.textContent = t("selectionOnly");
    search.placeholder = t("selectionSearch");
    search.setAttribute("aria-label", t("selectionSearch"));
    clear.textContent = t("selectionClear");
    cancel.textContent = t("close");
    apply.textContent = t(saving ? "selectionSaving" : "selectionApply");
    retry.textContent = t("deliveryReplyRetry");
    if (dialog.open) renderRows();
  }
  function renderRows() {
    if (!draft) return;
    const savedScroll = list.scrollTop;
    const activeFocus = doc.activeElement?.dataset?.selectionFocus;
    const focus = new Map();
    all.checked = draft.mode === "all";
    some.checked = draft.mode === "selected";
    const every = draft.mode === "all",
      keys = new Set(draft.taskKeys),
      available = rows();
    const availableKeys = new Set(available.map((row) => row.key));
    const absent = draft.taskKeys.filter(
      (key) => !availableKeys.has(key),
    ).length;
    summary.textContent = every
      ? t("selectionAllInfo")
      : t("selectionCount", { count: keys.size });
    missing.hidden = every || !absent;
    missing.textContent = t("selectionMissing", { count: absent });
    clear.disabled = saving || every || !keys.size;
    all.disabled = some.disabled = search.disabled = saving;
    const match = query.trim().toLocaleLowerCase();
    const visible = available.filter(
      ({ task }) =>
        !match ||
        `${task.title} ${projectName(task)}`
          .toLocaleLowerCase()
          .includes(match),
    );
    list.replaceChildren();
    for (const group of groupWork(visible.map((row) => row.task))) {
      const members = visible.filter(
        (row) => projectKey(row.task) === group.key,
      );
      const sources = [...new Set(members.map((row) => row.task.source))]
        .sort()
        .map((source) =>
          source === "work"
            ? t("sourceWork")
            : source === "codex"
              ? t("sourceCodex")
              : source,
        )
        .join(" / ");
      const groupName = group.name || t("projectUnset");
      const section = make("section", "work-selection-group"),
        groupHeader = make("div", "work-selection-group-header");
      const groupCheck = make("input"),
        expand = make("button", "work-selection-expand"),
        label = make("strong", "", group.name || t("projectUnset")),
        count = make("span", "", t("taskCount", { count: members.length }));
      groupCheck.type = "checkbox";
      expand.type = "button";
      groupCheck.disabled = saving || every;
      groupCheck.checked = every || members.every((row) => keys.has(row.key));
      groupCheck.indeterminate =
        !every &&
        !groupCheck.checked &&
        members.some((row) => keys.has(row.key));
      groupCheck.setAttribute(
        "aria-label",
        t("selectionGroup", { name: `${groupName} · ${sources}` }),
      );
      groupCheck.dataset.selectionFocus = `group:${group.key}`;
      focus.set(groupCheck.dataset.selectionFocus, groupCheck);
      const isOpen = expanded.has(group.key);
      expand.setAttribute("aria-expanded", String(isOpen));
      expand.setAttribute(
        "aria-label",
        t("selectionExpand", { name: `${groupName} · ${sources}` }),
      );
      expand.dataset.selectionFocus = `expand:${group.key}`;
      focus.set(expand.dataset.selectionFocus, expand);
      label.append(make("small", "", sources));
      expand.append(
        label,
        count,
        make("span", "work-selection-chevron", isOpen ? "▾" : "▸"),
      );
      groupHeader.append(groupCheck, expand);
      section.append(groupHeader);
      groupCheck.onchange = () => {
        const selected = new Set(draft.taskKeys);
        members.forEach((row) =>
          groupCheck.checked ? selected.add(row.key) : selected.delete(row.key),
        );
        draft.taskKeys = [...selected];
        renderRows();
      };
      expand.onclick = () => {
        isOpen ? expanded.delete(group.key) : expanded.add(group.key);
        renderRows();
      };
      if (isOpen) {
        const children = make("div", "work-selection-children");
        for (const { key, task } of members) {
          const row = make("label", "work-selection-row"),
            check = make("input"),
            copy = make("span", "work-selection-copy");
          check.type = "checkbox";
          check.checked = every || keys.has(key);
          check.disabled = saving || every;
          check.dataset.selectionFocus = key;
          focus.set(key, check);
          check.setAttribute("aria-label", task.title);
          copy.append(
            make("span", "work-selection-task-title", task.title),
            make(
              "small",
              "",
              `${task.source === "work" ? t("sourceWork") : t("sourceCodex")} · ${t(["working", "waiting", "done", "idle", "error", "unknown"].includes(task.status) ? task.status : "unknown")}`,
            ),
          );
          check.onchange = () => {
            const selected = new Set(draft.taskKeys);
            check.checked ? selected.add(key) : selected.delete(key);
            draft.taskKeys = [...selected];
            renderRows();
          };
          row.append(check, copy);
          children.append(row);
        }
        section.append(children);
      }
      list.append(section);
    }
    if (!visible.length)
      list.append(make("p", "work-selection-help", t("noTasks")));
    list.scrollTop = savedScroll;
    if (activeFocus) focus.get(activeFocus)?.focus({ preventScroll: true });
  }
  function open() {
    draft = { ...current(), taskKeys: [...current().taskKeys] };
    query = "";
    search.value = "";
    expanded = new Set();
    const groups = groupWork(getTasks());
    if (groups.length <= 4) groups.forEach((group) => expanded.add(group.key));
    else
      for (const row of rows())
        if (chosen.has(row.key)) expanded.add(projectKey(row.task));
    feedback.textContent = loadError ? t("selectionLoadError") : "";
    retry.hidden = !loadError;
    opener = doc.activeElement;
    refreshText();
    renderRows();
    dialog.showModal();
    (draft.mode === "all" ? some : search).focus();
  }
  all.onchange = some.onchange = () => {
    draft.mode = all.checked ? "all" : "selected";
    renderRows();
  };
  search.oninput = () => {
    query = search.value;
    if (query.trim())
      rows()
        .filter(({ task }) =>
          `${task.title} ${projectName(task)}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase()),
        )
        .forEach(({ task }) => expanded.add(projectKey(task)));
    renderRows();
  };
  clear.onclick = () => {
    draft.taskKeys = [];
    renderRows();
  };
  close.onclick = cancel.onclick = () => {
    if (!saving) dialog.close();
  };
  dialog.addEventListener("cancel", (event) => {
    if (saving) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    opener?.focus?.({ preventScroll: true });
    draft = null;
  });
  retry.onclick = async () => {
    if (saving) return;
    const savedScope = scope;
    dialog.close();
    await setScope(savedScope, true);
    open();
  };
  apply.onclick = async () => {
    if (saving) return;
    const requested = scope;
    saving = true;
    apply.disabled = close.disabled = cancel.disabled = true;
    feedback.textContent = "";
    refreshText();
    try {
      const value = normalizeDisplaySelection({
        ...draft,
        status: current().status,
      });
      await write(value, requested);
      states.set(requested, value);
      loaded.add(requested);
      if (scope === requested) {
        loadError = false;
        activate(value);
        dialog.close();
      }
    } catch {
      feedback.textContent = t("selectionSaveError");
    } finally {
      saving = false;
      close.disabled = cancel.disabled = false;
      refreshText();
    }
  };
  button.onclick = open;
  function update(patch) {
    if (!ready) return Promise.resolve(false);
    const requested = scope,
      value = normalizeDisplaySelection({ ...current(), ...patch });
    activate(value);
    return write(value, requested)
      .then(() => true)
      .catch(() => {
        onError?.(t("selectionSaveError"));
        return false;
      });
  }
  refreshText();
  return {
    setScope,
    refreshText,
    refreshTasks: () => {
      if (dialog.open) renderRows();
    },
    matches: (task) => ready && matchesDisplaySelection(task, current()),
    caption: () =>
      current().mode === "all" && ready ? t("allProjects") : t("selectionOnly"),
    setStatus: (status) => update({ status }),
    followTask: (task) => {
      const key = taskSelectionKey(task);
      if (!key || !ready) return Promise.resolve(false);
      return update({
        status: "working",
        taskKeys:
          current().mode === "selected"
            ? [...new Set([...current().taskKeys, key])]
            : current().taskKeys,
      });
    },
    selection: () => current(),
    get ready() {
      return ready;
    },
    destroy: () => {
      dialog.remove();
      button.onclick = null;
    },
  };
}
