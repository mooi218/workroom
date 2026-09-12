import { Office } from "./office.js";
import { assignRoles, DEFAULT_ROLES } from "./roles.mjs";
import {
  LANGUAGES,
  setLocale,
  getLocale,
  detectLocale,
  t,
  roleName,
} from "./i18n.js";
import { projectKey, projectName, groupWork } from "./projects.js";
import { createDeliveryTray } from "./delivery.js";
import { createFocusView } from "./focus.js";
const $ = (selector) => document.querySelector(selector),
  order = { working: 0, waiting: 1, error: 2, unknown: 3, idle: 4, done: 5 };
let prefs;
try {
  prefs = JSON.parse(localStorage.getItem("workroom.preferences.v1")) || {};
} catch {
  prefs = {};
}
const reduced = matchMedia("(prefers-reduced-motion: reduce)"),
  darkSystem = matchMedia("(prefers-color-scheme: dark)");
const settings = {
  sound: prefs.sound === true,
  motion: prefs.motion ?? !reduced.matches,
  walking: prefs.walking === true,
  volume: Math.min(
    1,
    Math.max(0, Number.isFinite(prefs.volume) ? prefs.volume : 0.25),
  ),
  locale:
    prefs.locale || detectLocale(navigator.languages || [navigator.language]),
  theme: ["system", "graphite", "dark", "light"].includes(prefs.theme)
    ? prefs.theme
    : "system",
  roles: Array.isArray(prefs.roles)
    ? prefs.roles.filter(
        (r) =>
          r &&
          typeof r.id === "string" &&
          typeof r.name === "string" &&
          /^#[a-f0-9]{6}$/i.test(r.color) &&
          Array.isArray(r.keywords),
      )
    : [],
  overrides:
    prefs.overrides && typeof prefs.overrides === "object"
      ? prefs.overrides
      : {},
};
setLocale(settings.locale);
let state = { tasks: [], roles: DEFAULT_ROLES, health: {} },
  tasks = [],
  roles = DEFAULT_ROLES,
  selected = null,
  selectedRole = "",
  project = "",
  filterStatus = "working",
  demo = false,
  liveState = null,
  previous = new Map(),
  connected = false,
  initial = true,
  audioCtx = null,
  source;
const publicDemo = document.documentElement.dataset.mode === "demo";
const office = new Office({
  canvas: $("#office-canvas"),
  overlay: $("#seat-overlay"),
  world: $("#office-world"),
  viewport: $("#office-viewport"),
  onSelect: selectTask,
});
const focusView = createFocusView({
  panel: $(".office-panel"),
  viewport: $("#office-viewport"),
  button: $("#focus-toggle"),
  t,
});
const delivery = createDeliveryTray({
  panel: $(".office-panel"),
  getMotion: () => settings.motion,
  t,
  getSeats: () => office.seats,
  onOpenTask: async (id) => {
    await focusView.exit();
    selectTask(id);
  },
});
function persist() {
  try {
    localStorage.setItem("workroom.preferences.v1", JSON.stringify(settings));
  } catch {
    toast(t("saveFailed"));
  }
}
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => ($("#toast").hidden = true), 3500);
}
function audioReady() {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}
function sound(kind, force = false) {
  if (!force && (!settings.sound || !audioCtx || audioCtx.state !== "running"))
    return;
  const ctx = force ? audioReady() : audioCtx;
  if (!ctx) return;
  const notes =
      kind === "done"
        ? [523.25, 659.25, 783.99]
        : kind === "waiting"
          ? [587.33, 440]
          : [392, 523.25],
    now = ctx.currentTime;
  notes.forEach((frequency, i) => {
    const osc = ctx.createOscillator(),
      gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = frequency;
    gain.gain.setValueAtTime(0, now + i * 0.095);
    gain.gain.linearRampToValueAtTime(
      settings.volume * 0.17,
      now + i * 0.095 + 0.012,
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.095 + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + i * 0.095);
    osc.stop(now + i * 0.095 + 0.23);
  });
}
function settingsUI() {
  $("#sound-toggle").textContent =
    `♪ ${t("sound")} ${t(settings.sound ? "on" : "off")}`;
  $("#sound-toggle").setAttribute("aria-pressed", settings.sound);
  $("#motion-toggle").textContent =
    `${t("motion")} ${t(settings.motion ? "on" : "off")}`;
  $("#motion-toggle").setAttribute("aria-pressed", settings.motion);
  $("#sound-setting").checked = settings.sound;
  $("#motion-setting").checked = settings.motion;
  $("#volume-setting").value = Math.round(settings.volume * 100);
  if ($("#walking-setting")) $("#walking-setting").checked = settings.walking;
  office.setMotion(settings.motion);
  office.setWandering?.(settings.walking);
  delivery.refreshMotion();
  $("#theme-setting").value = settings.theme;
  const theme =
    settings.theme === "system"
      ? darkSystem.matches
        ? "graphite"
        : "light"
      : settings.theme;
  document.documentElement.dataset.theme = theme;
  $("#theme-toggle").textContent = theme === "light" ? "☾" : "☀";
  office.setTheme(theme);
}
function setSound(value) {
  settings.sound = value;
  if (value) {
    audioReady();
    sound("done", true);
  }
  persist();
  settingsUI();
}
function setMotion(value) {
  settings.motion = value;
  persist();
  settingsUI();
}
function setTheme(value) {
  settings.theme = value;
  persist();
  settingsUI();
}
function language(value) {
  setLocale(value);
  settings.locale = getLocale();
  persist();
  localize();
  applyState.lastKey = null;
  applyState(state);
}
function text(selector, key) {
  const node = $(selector);
  if (node) node.textContent = t(key);
}
function attr(selector, name, key) {
  const node = $(selector);
  if (node) node.setAttribute(name, t(key));
}
function labelText(selector, key) {
  const node = $(selector);
  if (!node) return;
  const element = node.querySelector("input,select");
  node.replaceChildren(document.createTextNode(t(key)));
  if (element) node.append(element);
}
function localize() {
  const lang = LANGUAGES.find((l) => l.code === getLocale());
  document.documentElement.lang = getLocale();
  document.documentElement.dir = lang?.dir || "ltr";
  document.title = t("appTitle");
  for (const selector of ["#language-quick", "#language-setting"]) {
    const node = $(selector);
    node.replaceChildren(...LANGUAGES.map((l) => new Option(l.name, l.code)));
    node.value = getLocale();
    node.setAttribute("aria-label", t("langLabel"));
  }
  text("h1", "officeHeading");
  text("#credit-footnote", "creditSmall");
  attr("#credit-footnote", "title", "creditHelp");
  text("#download-app", "downloadApp");
  attr("#project-help-open", "aria-label", "projectInfo");
  text("#project-info-title", "projectHelpTitle");
  text("#project-info-text", "projectHelp");
  text("#demo-step", "demoStep");
  delivery.refreshText();
  focusView.refreshText();
  attr("#project-info-dialog .icon-button", "aria-label", "close");
  text("#office-view", "officeView");
  text("#list-view", "listView");
  attr("#settings-open", "aria-label", "settings");
  attr("#theme-toggle", "aria-label", "themeLabel");
  attr("#project-filter", "aria-label", "allProjects");
  attr("#status-filter", "aria-label", "allStatuses");
  attr(".toolbar", "aria-label", "allStatuses");
  attr(".office-panel", "aria-label", "officeView");
  attr("#office-canvas", "aria-label", "officeView");
  $(".brand").setAttribute("aria-label", "Workroom");
  text("#project-filter + .sr-only", "allProjects");
  $("#project-filter").previousElementSibling.textContent = t("allProjects");
  $("#status-filter").previousElementSibling.textContent = t("allStatuses");
  const names = {
    working: "activeOnly",
    "": "allStatuses",
    waiting: "waiting",
    done: "done",
    idle: "idle",
    error: "error",
    unknown: "unknown",
  };
  for (const option of $("#status-filter").options)
    option.text = t(names[option.value]);
  attr("#zoom-in", "aria-label", "zoomIn");
  attr("#zoom-out", "aria-label", "zoomOut");
  text("#zoom-fit", "fit");
  text(".overview .section-kicker", "officePulse");
  text(".overview h2", "nowHere");
  text(".teams-section h2", "teams");
  text("#add-role", "addRole");
  for (const button of document.querySelectorAll("[data-filter]")) {
    const span = button.querySelector("span"),
      dot = span.querySelector("i");
    span.replaceChildren(
      dot,
      document.createTextNode(t(button.dataset.filter)),
    );
  }
  for (const legend of document.querySelectorAll(".legend>span")) {
    const dot = legend.querySelector("i");
    legend.replaceChildren(dot, document.createTextNode(t(dot.className)));
  }
  text(".page-footer>span:first-child", "footerText");
  text("#active-help", "activeHelp");
  text("#settings-dialog h2", "settingsTitle");
  attr("#settings-dialog .icon-button", "aria-label", "close");
  text("#lang-label", "langLabel");
  text("#theme-label", "themeLabel");
  text("#language-note", "contentNotTranslated");
  for (const option of $("#theme-setting").options)
    option.text = t(
      {
        system: "themeSystem",
        light: "themeLight",
        dark: "themeDark",
        graphite: "themeGraphite",
      }[option.value],
    );
  const soundRow = $("#sound-setting").closest(".setting-row");
  soundRow.querySelector("strong").textContent = t("sound");
  soundRow.querySelector("p").textContent = t("soundHelp");
  attr("#sound-setting", "aria-label", "sound");
  $("#volume-setting").previousElementSibling.textContent = t("volume");
  attr("#volume-setting", "aria-label", "volume");
  text("#test-sound", "testSound");
  const motionRow = $("#motion-setting").closest(".setting-row");
  motionRow.querySelector("strong").textContent = t("motion");
  motionRow.querySelector("p").textContent = t("motionHelp");
  attr("#motion-setting", "aria-label", "motion");
  text("#walking-label", "walking");
  text("#walking-help", "walkingHelp");
  text("#walking-note", "walkingDefault");
  text("#effects-note", "effectsHelp");
  attr("#walking-setting", "aria-label", "walking");
  text("#cloud-heading", "cloudConnection");
  text("#cloud-help", "cloudHelp");
  text("#cloud-limit", "cloudLimit");
  text("#pair-show", "pairShow");
  text("#pair-copy", "pairCopy");
  attr("#pair-token", "aria-label", "pairCode");
  text(".settings-content>p:last-child", "settingsLocal");
  text("#role-dialog h2", "roleTitle");
  attr("#role-close", "aria-label", "close");
  labelText("#role-form>label:nth-of-type(1)", "roleName");
  labelText("#role-form>label:nth-of-type(2)", "roleColor");
  labelText("#role-form>label:nth-of-type(3)", "roleKeywords");
  attr("#role-name", "placeholder", "roleNamePlaceholder");
  attr("#role-keywords", "placeholder", "roleKeywordsPlaceholder");
  text("#role-form .settings-help", "roleHelp");
  text("#role-form .primary-button", "roleCreate");
  settingsUI();
}
function roleList() {
  return [
    ...(state.roles || DEFAULT_ROLES),
    ...settings.roles.filter(
      (r) => !(state.roles || DEFAULT_ROLES).some((x) => x.id === r.id),
    ),
  ];
}
function applyState(next) {
  delivery.observe(next.tasks || [], { scope: demo ? "demo" : "live" });
  state = next;
  roles = roleList();
  tasks = (next.tasks || [])
    .map((task) => {
      const assignments = assignRoles(task, roles, settings.overrides);
      return {
        ...task,
        assignments,
        roleId: assignments[0]?.roleId,
        reason: assignments[0]?.reason,
      };
    })
    .sort(
      (a, b) =>
        (order[a.status] ?? 5) - (order[b.status] ?? 5) ||
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
  if (!initial) {
    const changes = tasks.filter(
        (task) =>
          previous.has(task.id) && previous.get(task.id) !== task.status,
      ),
      notice =
        changes.find((task) => task.status === "waiting") ||
        changes.find((task) => task.status === "done") ||
        changes.find((task) => task.status === "working");
    if (notice) sound(notice.status);
  }
  previous = new Map(tasks.map((task) => [task.id, task.status]));
  initial = false;
  const groups = groupWork(tasks),
    picker = $("#project-filter");
  const groupSignature = JSON.stringify([groups, getLocale()]);
  if (picker.dataset.signature !== groupSignature) {
    picker.dataset.signature = groupSignature;
    picker.replaceChildren(new Option(t("allProjects"), ""));
    for (const kind of ["project", "task-group"]) {
      const members = groups.filter((group) => group.kind === kind);
      if (!members.length) continue;
      const optgroup = document.createElement("optgroup");
      optgroup.label = t(
        kind === "project" ? "projectProjects" : "projectGroups",
      );
      for (const group of members) {
        const more = group.rootCount > 1 ? ` (+${group.rootCount - 1})` : "";
        const option = new Option(
          `${group.name}${more} · ${t("projectActiveCount", { count: group.active })}`,
          group.key,
        );
        option.title = group.name;
        optgroup.append(option);
      }
      picker.append(optgroup);
    }
    if (!groups.some((group) => group.key === project)) project = "";
    picker.value = project;
  }
  const key = JSON.stringify(
    tasks.map((task) => [
      task.id,
      task.title,
      projectKey(task),
      projectName(task),
      task.assignments,
      task.status,
    ]),
  );
  if (key !== applyState.lastKey) {
    applyState.lastKey = key;
    render();
  } else renderDetails();
  renderHealth();
}
function filteredTasks() {
  return tasks.filter(
    (task) =>
      (!project || projectKey(task) === project) &&
      (!filterStatus || task.status === filterStatus) &&
      (!selectedRole ||
        task.assignments.some((a) => a.roleId === selectedRole)),
  );
}
function render() {
  const visible = filteredTasks(),
    visibleRoles = selectedRole
      ? roles.filter((role) => role.id === selectedRole)
      : roles,
    seats = visible.flatMap((task) =>
      task.assignments
        .filter((a) => !selectedRole || a.roleId === selectedRole)
        .map((assignment) => ({
          ...task,
          ...assignment,
          id: `${task.id}:${assignment.roleId}`,
          taskId: task.id,
        })),
    );
  office.setData(seats, visibleRoles, selected);
  $("#seat-count").textContent = t("seatSummary", {
    tasks: visible.length,
    seats: seats.length,
    teams: visibleRoles.length,
  });
  $("#floor-label").textContent =
    groupWork(tasks).find((group) => group.key === project)?.name ||
    t("allProjects");
  for (const status of ["working", "waiting", "done"])
    $(`#${status}-count`).textContent = tasks.filter(
      (task) =>
        (!project || projectKey(task) === project) && task.status === status,
    ).length;
  const teamRoot = $("#teams");
  teamRoot.replaceChildren();
  for (const role of roles) {
    const teamTasks = tasks.filter(
        (task) =>
          task.assignments.some((a) => a.roleId === role.id) &&
          (!project || projectKey(task) === project) &&
          (!filterStatus || task.status === filterStatus),
      ),
      button = document.createElement("button");
    button.className = `team-row${selectedRole === role.id ? " active" : ""}`;
    button.setAttribute("aria-pressed", selectedRole === role.id);
    const icon = document.createElement("span");
    icon.className = "team-icon";
    icon.style.setProperty("--team-color", role.color);
    icon.textContent = roleName(role)[0];
    const label = document.createElement("span");
    label.textContent = roleName(role);
    const count = document.createElement("span");
    count.className = "team-count";
    count.textContent = teamTasks.length;
    button.append(icon, label, count);
    if (teamTasks.some((task) => task.status === "working")) {
      const dot = document.createElement("span");
      dot.className = "team-running";
      button.append(dot);
    }
    button.onclick = () => {
      selectedRole = selectedRole === role.id ? "" : role.id;
      render();
    };
    teamRoot.append(button);
  }
  renderTable(visible);
  renderDetails();
}
function makeStatus(status) {
  const node = document.createElement("span");
  node.className = "job-status";
  const dot = document.createElement("i");
  dot.className = status;
  node.append(
    dot,
    document.createTextNode(t(status in order ? status : "unknown")),
  );
  return node;
}
function renderTable(visible) {
  const root = $("#jobs-table");
  root.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty-office";
    const h = document.createElement("h3");
    h.textContent = t("noTasks");
    const p = document.createElement("p");
    p.textContent = t("noTasksHelp");
    empty.append(h, p);
    root.append(empty);
    return;
  }
  const table = document.createElement("table"),
    head = document.createElement("thead"),
    row = document.createElement("tr");
  for (const key of ["jobTitle", "roleLabel", "allStatuses"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = t(key);
    row.append(cell);
  }
  head.append(row);
  const body = document.createElement("tbody");
  for (const task of visible) {
    const tr = document.createElement("tr"),
      name = document.createElement("td"),
      role = document.createElement("td"),
      status = document.createElement("td"),
      button = document.createElement("button");
    button.textContent = task.title;
    button.onclick = () => selectTask(task.id);
    name.append(button);
    role.textContent = task.assignments
      .map((a) => roleName(roles.find((r) => r.id === a.roleId)))
      .join(" · ");
    status.append(makeStatus(task.status));
    tr.append(name, role, status);
    body.append(tr);
  }
  table.append(head, body);
  root.append(table);
}
function selectTask(id) {
  selected = id;
  for (let i = 0; i < office.seats.length; i++)
    office.overlay.children[i]?.classList.toggle(
      "selected",
      office.seats[i].task.taskId === id,
    );
  renderDetails();
  if (innerWidth < 1100)
    $("#task-details").scrollIntoView({
      behavior: settings.motion ? "smooth" : "auto",
      block: "nearest",
    });
}
function renderDetails() {
  const task = tasks.find((task) => task.id === selected),
    root = $("#task-details"),
    locale = getLocale();
  if (!task) {
    selected = null;
    if (root.dataset.render !== `empty-${locale}`) {
      root.dataset.render = `empty-${locale}`;
      root.replaceChildren();
      const kicker = document.createElement("div");
      kicker.className = "section-kicker";
      kicker.textContent = t("atYourDesk");
      const empty = document.createElement("div");
      empty.className = "empty-detail";
      const icon = document.createElement("span");
      icon.textContent = "↖";
      icon.setAttribute("aria-hidden", "true");
      const title = document.createElement("h3");
      title.textContent = t("chooseDesk");
      const p = document.createElement("p");
      p.textContent = t("chooseDeskHelp");
      empty.append(icon, title, p);
      root.append(kicker, empty);
    }
    return;
  }
  const key = JSON.stringify([
    task.id,
    task.title,
    task.assignments,
    task.status,
    task.project,
    task.summary,
    task.url,
    roles,
    locale,
  ]);
  if (root.dataset.render === key) {
    const seen = root.querySelector("[data-observed]");
    if (seen)
      seen.textContent = `${t("observedAt")} ${formatDate(task.observedAt)}`;
    return;
  }
  root.dataset.render = key;
  root.replaceChildren();
  const kicker = document.createElement("div");
  kicker.className = "section-kicker";
  kicker.textContent = t(task.source === "work" ? "sourceWork" : "sourceCodex");
  const title = document.createElement("h3");
  title.className = "task-title";
  title.textContent = task.title;
  const meta = document.createElement("p");
  meta.className = "task-meta";
  meta.textContent = projectName(task) || t("projectUnset");
  const summary = document.createElement("p");
  summary.className = "task-meta";
  summary.textContent = t(
    task.status === "unknown"
      ? "staleObservation"
      : task.source === "work"
        ? "cloudHelp"
        : task.status === "done"
          ? "turnComplete"
          : "localObservation",
  );
  const seen = document.createElement("p");
  seen.className = "task-meta";
  seen.dataset.observed = "";
  seen.textContent = `${t("observedAt")} ${formatDate(task.observedAt)}`;
  const assignmentText = document.createElement("p");
  assignmentText.className = "task-meta";
  assignmentText.textContent = t(
    task.reason === "activity"
      ? "classificationActivity"
      : task.reason === "manual"
        ? "manualRole"
        : "classificationTitle",
  );
  const chips = document.createElement("div");
  chips.className = "detail-role-list";
  for (const assignment of task.assignments) {
    const chip = document.createElement("span");
    chip.className = "assignment-chip";
    chip.textContent = roleName(
      roles.find((role) => role.id === assignment.roleId),
    );
    chips.append(chip);
  }
  const label = document.createElement("label");
  label.className = "detail-role-label";
  label.htmlFor = "detail-role";
  label.textContent = t("roleLabel");
  const select = document.createElement("select");
  select.id = "detail-role";
  select.append(new Option(t("autoAssign"), ""));
  roles.forEach((role) => select.append(new Option(roleName(role), role.id)));
  select.value = settings.overrides[task.id] || "";
  select.onchange = () => {
    if (select.value) settings.overrides[task.id] = select.value;
    else delete settings.overrides[task.id];
    persist();
    applyState.lastKey = null;
    applyState(state);
    toast(t("roleUpdated"));
  };
  root.append(
    kicker,
    title,
    makeStatus(task.status),
    meta,
    summary,
    seen,
    assignmentText,
    chips,
    label,
    select,
  );
  if (task.url && safeTaskUrl(task.url)) {
    const link = document.createElement("a");
    link.href = task.url;
    link.textContent = `${t("openTask")} ↗`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    root.append(link);
  }
}
function safeTaskUrl(value) {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" && url.hostname === "chatgpt.com") ||
      (url.protocol === "codex:" && url.hostname === "threads")
    );
  } catch {
    return false;
  }
}
function formatDate(value) {
  const n = Date.parse(value);
  return Number.isFinite(n)
    ? new Date(n).toLocaleString(getLocale(), {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
}
function renderHealth() {
  const connection = $("#connection");
  connection.classList.toggle("disconnected", !connected && !demo);
  connection.lastChild.textContent = ` ${t(demo ? "demoOffice" : connected ? "localConnected" : "reconnecting")}`;
  $("#last-sync").textContent = demo
    ? t("demoOffice")
    : `${t("lastSync")} ${formatDate(state.updatedAt)}`;
  const health = state.health || {},
    cloud = state.cloud || {};
  $("#source-summary").textContent = demo
    ? t("demoOffice")
    : `Codex ${tasks.filter((task) => task.source === "codex").length} · Work ${tasks.filter((task) => task.source === "work").length}`;
  $("#health-details").textContent =
    `Codex: ${t(health.status === "connected" ? "localConnected" : "healthUnknown")} · Work: ${t(cloud.status === "connected" ? "cloudConnected" : cloud.status === "stale" ? "cloudStale" : "cloudDisconnected")}`;
  $("#demo-toggle").textContent =
    `${t(publicDemo ? "downloadApp" : demo ? "liveButton" : "demoButton")} ↗`;
  $("#demo-step").hidden = !demo;
  const notice = $("#notice");
  if (demo) {
    notice.hidden = false;
    notice.textContent = t(publicDemo ? "publicDemoNotice" : "demoNotice");
  } else if (
    !connected ||
    health.status === "unavailable" ||
    health.status === "partial"
  ) {
    notice.hidden = false;
    notice.textContent = t(!connected ? "connectionLost" : "healthUnknown");
  } else notice.hidden = true;
}
function connect() {
  if (publicDemo) {
    demo = true;
    $("#download-app").hidden = false;
    $("#pair-show").disabled = true;
    fetch("./demo-data.json")
      .then((response) => {
        if (!response.ok) throw new Error("Demo unavailable");
        return response.json();
      })
      .then((data) => {
        connected = true;
        applyState({ ...data, demo: true });
      })
      .catch(() => {
        connected = false;
        toast(t("demoFailed"));
      });
    return;
  }
  source = new EventSource("/api/events");
  source.onmessage = (event) => {
    try {
      const next = JSON.parse(event.data);
      connected = true;
      liveState = next;
      if (!demo) {
        if (next.demo) demo = true;
        applyState(next);
      }
    } catch (error) {
      console.error("Workroom render failed", error);
      toast(t("readFailed"));
    }
  };
  source.onerror = () => {
    connected = false;
    if (!demo)
      applyState({
        ...state,
        tasks: state.tasks.map((task) => ({ ...task, status: "unknown" })),
      });
    renderHealth();
  };
}
$("#project-filter").onchange = (event) => {
  project = event.target.value;
  render();
};
$("#project-help-open").onclick = () => $("#project-info-dialog").showModal();
$("#status-filter").onchange = (event) => {
  filterStatus = event.target.value;
  render();
};
document.querySelectorAll("[data-filter]").forEach(
  (button) =>
    (button.onclick = () => {
      filterStatus =
        filterStatus === button.dataset.filter ? "" : button.dataset.filter;
      $("#status-filter").value = filterStatus;
      render();
    }),
);
$("#zoom-in").onclick = () => office.setScale(office.scale + 0.1);
$("#zoom-out").onclick = () => office.setScale(office.scale - 0.1);
$("#zoom-fit").onclick = () => office.fit();
function setView(list) {
  $("#jobs-table").hidden = !list;
  $("#office-viewport").hidden = list;
  $("#office-view").classList.toggle("active", !list);
  $("#office-view").setAttribute("aria-pressed", !list);
  $("#list-view").classList.toggle("active", list);
  $("#list-view").setAttribute("aria-pressed", list);
  if (!list) office.fit();
}
$("#office-view").onclick = () => setView(false);
$("#list-view").onclick = () => setView(true);
$("#sound-toggle").onclick = () => setSound(!settings.sound);
$("#motion-toggle").onclick = () => setMotion(!settings.motion);
$("#sound-setting").onchange = (event) => setSound(event.target.checked);
$("#motion-setting").onchange = (event) => setMotion(event.target.checked);
$("#volume-setting").oninput = (event) => {
  settings.volume = Number(event.target.value) / 100;
  persist();
};
$("#test-sound").onclick = () => sound("done", true);
$("#language-quick").onchange = (event) => language(event.target.value);
$("#language-setting").onchange = (event) => language(event.target.value);
$("#theme-setting").onchange = (event) => setTheme(event.target.value);
$("#theme-toggle").onclick = () =>
  setTheme(
    document.documentElement.dataset.theme === "light" ? "graphite" : "light",
  );
$("#walking-setting")?.addEventListener("change", (event) => {
  settings.walking = event.target.checked;
  persist();
  settingsUI();
});
$("#settings-open").onclick = () => {
  $("#settings-dialog").showModal();
  settingsUI();
};
$("#settings-dialog").addEventListener("close", () => {
  $("#pair-area").hidden = true;
  $("#pair-token").value = "";
});
$("#pair-show").onclick = async () => {
  try {
    const response = await fetch("/api/pair");
    if (!response.ok) throw Error();
    const data = await response.json();
    $("#pair-token").value = data.token;
    $("#pair-area").hidden = false;
  } catch {
    toast(t("pairFailed"));
  }
};
$("#pair-copy").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("#pair-token").value);
    toast(t("pairCopied"));
  } catch {
    $("#pair-token").select();
    toast(t("copyManually"));
  }
};
$("#add-role").onclick = () => {
  $("#role-dialog").showModal();
  $("#role-name").focus();
};
$("#role-close").onclick = () => $("#role-dialog").close();
$("#role-form").onsubmit = (event) => {
  event.preventDefault();
  const name = $("#role-name").value.trim();
  if (!name) return;
  settings.roles.push({
    id: `custom-${crypto.randomUUID()}`,
    name,
    color: $("#role-color").value,
    keywords: $("#role-keywords")
      .value.split(/[,、\n]/)
      .map((s) => s.trim())
      .filter(Boolean),
  });
  persist();
  $("#role-dialog").close();
  $("#role-form").reset();
  applyState.lastKey = null;
  applyState(state);
  toast(t("roleAdded", { name }));
};
$("#demo-toggle").onclick = async () => {
  if (publicDemo) {
    window.open(
      "https://github.com/mooi218/workroom/releases/latest",
      "_blank",
      "noopener,noreferrer",
    );
    return;
  }
  initial = true;
  previous.clear();
  selected = null;
  selectedRole = "";
  project = "";
  filterStatus = "working";
  $("#project-filter").value = "";
  $("#status-filter").value = "working";
  applyState.lastKey = null;
  if (demo) {
    demo = false;
    if (liveState) {
      if (liveState.demo) {
        demo = true;
        toast(t("demoOnly"));
      }
      applyState(liveState);
    }
    return;
  }
  try {
    const response = await fetch("/api/demo");
    if (!response.ok) throw Error();
    demo = true;
    applyState(await response.json());
  } catch {
    toast(t("demoFailed"));
  }
};
$("#demo-step").onclick = () => {
  if (!demo) return;
  const job = state.tasks.find((task) => task.status === "working");
  if (!job) {
    toast(t("noTasks"));
    return;
  }
  const time = new Date().toISOString();
  applyState({
    ...state,
    updatedAt: time,
    tasks: state.tasks.map((task) =>
      task.id === job.id
        ? {
            ...task,
            status: "done",
            activeRoles: [],
            updatedAt: time,
            observedAt: time,
          }
        : task,
    ),
  });
};
reduced.addEventListener("change", (event) => {
  if (event.matches) setMotion(false);
});
darkSystem.addEventListener("change", () => settingsUI());
document.addEventListener(
  "pointerdown",
  () => {
    if (settings.sound) audioReady();
  },
  { once: true },
);
localize();
connect();
document.fonts?.ready.then(() => office.draw());
