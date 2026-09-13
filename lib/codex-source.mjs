import { DatabaseSync } from "node:sqlite";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";

const TAIL_BYTES = 64 * 1024;
const REPLY_BYTES = 64 * 1024;
const DEFAULT_STALE_MS = 15 * 60 * 1000;
const TURN_STATUS = {
  inProgress: "working",
  completed: "done",
  interrupted: "idle",
  failed: "error",
};
const SUMMARY = {
  working: "最後に観測したターンが実行中です。",
  waiting: "入力または承認を待っています。",
  done: "最後のターンの完了を確認しました。",
  idle: "最後のターンは中断されています。",
  error: "最後のターンでエラーが記録されています。",
  unknown: "実行状態を確認できる記録がありません。",
};
const START_EVENTS = new Set(["task_started", "turn_started"]);
const DONE_EVENTS = new Set(["task_complete", "task_completed"]);
const INTERRUPT_EVENTS = new Set([
  "turn_aborted",
  "task_aborted",
  "task_cancelled",
]);
const WAIT_EVENTS = new Set([
  "exec_approval_request",
  "apply_patch_approval_request",
  "request_user_input",
  "request_permissions",
  "mcp_elicitation_request",
]);
const WAIT_TOOLS = new Set([
  "request_user_input",
  "request_user_input_async",
  "request_permissions",
]);
const ROLE_IDS = [
  "engineering",
  "design",
  "pr",
  "sales",
  "writing",
  "research",
  "planning",
  "operations",
];
const ROLE_EVIDENCE = {
  engineering: "コードの変更・開発ツール",
  design: "画像・音声・映像の制作",
  pr: "公開・配信サービスの操作",
  sales: "営業・受発注サービスの操作",
  writing: "文書・原稿の編集",
  research: "検索・調査ツールの利用",
  planning: "計画ツールの更新",
  operations: "運用・予定管理の操作",
};
const ROLE_ITEM_TYPES = [
  "commandExecution",
  "mcpToolCall",
  "dynamicToolCall",
  "fileChange",
  "webSearch",
  "imageGeneration",
];
const ROLE_SCAN_ITEMS = 64;

function addRole(
  signals,
  roleId,
  evidence = ROLE_EVIDENCE[roleId],
  priority = 10,
) {
  if (!ROLE_IDS.includes(roleId)) return;
  if ((signals.get(roleId)?.priority ?? -1) <= priority)
    signals.set(roleId, { roleId, evidence, priority });
}

function addAssignmentRoles(signals, agent) {
  const role = agent.roleHint.normalize("NFKC").toLowerCase();
  const aliases = {
    engineering: [
      "engineering",
      "engineer",
      "developer",
      "エンジニア",
      "開発",
      "実装",
    ],
    design: ["design", "designer", "デザイン", "デザイナー"],
    pr: ["pr", "public relations", "広報"],
    sales: ["sales", "営業"],
    writing: ["writing", "writer", "editor", "執筆", "編集"],
    research: ["research", "researcher", "調査", "リサーチ"],
    planning: ["planning", "planner", "企画", "計画"],
    operations: ["operations", "運用", "管理"],
  };
  for (const [id, values] of Object.entries(aliases))
    if (values.includes(role)) addRole(signals, id, "保存された担当役割", 5);
  const assignment = agent.agentTask.normalize("NFKC").toLowerCase();
  const rules = {
    engineering:
      /\b(engineer|engineering|implementation|implement|code|coding|deploy|deployment|test|tests|debug|refactor|build)\b|実装|開発|テスト/,
    design:
      /\b(design|designer|illustration|image|images|audio|music|bgm|video|visual|artwork|cover|covers|ui|ux)\b|デザイン|画像|音楽|動画/,
    pr: /\b(pr|public relations|social|promotion|publicity|announcement)\b|広報|告知/,
    sales: /\b(sales|crm|lead|leads|proposal|proposals)\b|営業|商談/,
    writing:
      /\b(write|writer|writing|editor|editorial|article|newsletter|copywriting)\b|執筆|編集/,
    research:
      /\b(research|researcher|analysis|analyze|compare|investigate|investigation)\b|調査|分析/,
    planning: /\b(planning|planner|strategy|roadmap|requirements)\b|企画|計画/,
    operations: /\b(operations|admin|schedule|scheduling|organize)\b|運用|管理/,
  };
  for (const [id, pattern] of Object.entries(rules))
    if (pattern.test(assignment)) addRole(signals, id, "保存された担当名", 3);
}

function rolesFromPath(value, signals) {
  if (typeof value !== "string") return;
  const extension = path.extname(value.slice(0, 1024)).toLowerCase();
  if (
    /^\.(?:js|mjs|cjs|jsx|ts|tsx|py|rs|go|java|c|h|cpp|cs|rb|php|html|css|scss|sql|sh|ps1)$/.test(
      extension,
    )
  )
    addRole(signals, "engineering");
  if (
    /^\.(?:svg|png|jpg|jpeg|webp|psd|ai|blend|wav|mp3|ogg|flac|midi?|mp4|mov)$/.test(
      extension,
    )
  )
    addRole(signals, "design");
  if (/^\.(?:md|mdx|txt|docx|odt|tex)$/.test(extension))
    addRole(signals, "writing");
}

function rolesFromUrl(value, signals) {
  if (typeof value !== "string" || value.length > 4096) return;
  let url;
  try {
    url = new URL(value);
  } catch {
    return;
  }
  if (!["http:", "https:"].includes(url.protocol)) return;
  const host = url.hostname.toLowerCase();
  const within = (domain) => host === domain || host.endsWith(`.${domain}`);
  if (
    [
      "coconala.com",
      "crowdworks.jp",
      "lancers.jp",
      "salesforce.com",
      "hubspot.com",
      "apollo.io",
    ].some(within)
  )
    addRole(signals, "sales");
  if (["canva.com", "figma.com"].some(within)) addRole(signals, "design");
  if (
    host === "studio.youtube.com" ||
    (within("soundcloud.com") && /^\/upload(?:\/|$)/.test(url.pathname)) ||
    (["x.com", "twitter.com"].some(within) &&
      /^\/compose(?:\/|$)/.test(url.pathname))
  )
    addRole(signals, "pr");
  if (host === "editor.note.com") addRole(signals, "writing");
}

function rolesFromCommand(value, signals) {
  if (typeof value !== "string") return;
  const command = value.slice(0, TAIL_BYTES);
  const executable = (name) =>
    new RegExp(
      `(?:^|[\\r\\n;|&])\\s*(?:&\\s*)?(?:["'][^"'\\r\\n]*[\\\\/])?(?:${name})(?:\\.exe)?(?:["']?)(?=\\s|$)`,
      "im",
    ).test(command);
  if (
    executable(
      "npm|pnpm|yarn|bun|tsc|vitest|jest|pytest|cargo|rustc|git|gh|wrangler|docker|dotnet|cmake|ninja|mvn|gradle",
    ) ||
    /(?:^|[\r\n;|&])\s*(?:node\s+[^\r\n]*--test|python(?:3)?\s+-m\s+pytest|go\s+(?:build|test|run))\b/im.test(
      command,
    )
  )
    addRole(signals, "engineering");
  if (
    executable(
      "ffmpeg|ffprobe|magick|inkscape|blender|sox|fluidsynth|timidity",
    ) ||
    /^(?:from|import)\s+(?:PIL|pydub|soundfile|wave|mido|moviepy|pretty_midi|cairo)\b/m.test(
      command,
    )
  )
    addRole(signals, "design");
  if (
    executable("pandoc|typst") ||
    /^(?:from|import)\s+(?:docx|reportlab)\b/m.test(command)
  )
    addRole(signals, "writing");
  if (/^(?:from|import)\s+(?:pandas|polars|scipy|statsmodels)\b/m.test(command))
    addRole(signals, "research");
  if (
    /\b(?:curl|wget|Invoke-WebRequest|Invoke-RestMethod|Start-Process|open)\b/i.test(
      command,
    )
  ) {
    for (const match of command.matchAll(/https?:\/\/[^\s"'`<>]+/g))
      rolesFromUrl(match[0], signals);
  }
}

// A bounded lexical scan, not an evaluator. Quoted examples and comments cannot
// masquerade as tool calls. Dynamic strings, variables, and computed calls are
// deliberately left unclassified instead of trying to execute the program.
function decodeLiteral(raw) {
  if (raw[0] === "`" && raw.includes("${")) return undefined;
  let result = "";
  const body = raw.slice(1, -1);
  for (let index = 0; index < body.length; index++) {
    if (body[index] !== "\\") {
      result += body[index];
      continue;
    }
    const next = body[++index];
    if (next == null) return undefined;
    const simple = {
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      v: "\v",
      0: "\0",
    };
    if (next === "\n") continue;
    if (next === "\r") {
      if (body[index + 1] === "\n") index++;
      continue;
    }
    if (next === "u" || next === "x") {
      const size = next === "u" ? 4 : 2;
      const hex = body.slice(index + 1, index + size + 1);
      if (!new RegExp(`^[0-9a-f]{${size}}$`, "i").test(hex)) return undefined;
      result += String.fromCharCode(parseInt(hex, 16));
      index += size;
    } else result += simple[next] ?? next;
  }
  return result;
}

function lexCode(value) {
  const code = value.slice(0, TAIL_BYTES);
  const mask = code.split("");
  const strings = new Map();
  for (let index = 0; index < code.length; ) {
    const begin = index;
    if (code.startsWith("//", index)) {
      const newline = code.indexOf("\n", index + 2);
      index = newline < 0 ? code.length : newline;
    } else if (code.startsWith("/*", index)) {
      const end = code.indexOf("*/", index + 2);
      index = end < 0 ? code.length : end + 2;
    } else if ("\"'`".includes(code[index])) {
      const quote = code[index++];
      let complete = false;
      while (index < code.length) {
        if (code[index] === "\\") {
          index += 2;
          continue;
        }
        if (code[index++] === quote) {
          complete = true;
          break;
        }
      }
      if (complete)
        strings.set(begin, {
          end: index,
          value: decodeLiteral(code.slice(begin, index)),
        });
    } else {
      index++;
      continue;
    }
    for (let offset = begin; offset < Math.min(index, code.length); offset++)
      mask[offset] = " ";
  }
  return { code, mask: mask.join(""), strings };
}

function callEnd(mask, opening) {
  let depth = 0;
  for (let index = opening; index < mask.length; index++) {
    if (mask[index] === "(") depth++;
    else if (mask[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

function literalArguments(scan, begin, end) {
  while (/\s/.test(scan.code[begin] || "") && begin < end) begin++;
  const first = scan.strings.get(begin);
  if (first && first.end <= end) return first.value;
  const raw = scan.code.slice(begin, end).trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const result = {};
  const region = scan.mask.slice(begin, end);
  for (const match of region.matchAll(
    /\b(cmd|code|url|input|patch|path|file_path)\s*:/g,
  )) {
    let position = begin + match.index + match[0].length;
    while (/\s/.test(scan.code[position] || "") && position < end) position++;
    const literal = scan.strings.get(position);
    if (literal?.end <= end && literal.value !== undefined)
      result[match[1]] = literal.value;
  }
  return result;
}

function rolesFromCode(value, signals, depth = 0) {
  if (typeof value !== "string" || depth > 3) return;
  const scan = lexCode(value);
  for (const match of scan.mask.matchAll(/\btools\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const opening = match.index + match[0].lastIndexOf("(");
    const end = callEnd(scan.mask, opening);
    if (end >= 0)
      rolesFromTool(
        match[1],
        literalArguments(scan, opening + 1, end),
        signals,
        depth + 1,
      );
  }
  for (const match of scan.mask.matchAll(
    /(?:\.\s*(?:goto|navigate)|\bcreateBrowserTab|\bgetBrowser)\s*\(/g,
  )) {
    const opening = match.index + match[0].lastIndexOf("(");
    const end = callEnd(scan.mask, opening);
    if (end < 0) continue;
    const args = literalArguments(scan, opening + 1, end);
    rolesFromUrl(typeof args === "string" ? args : args?.url, signals);
    // createBrowserTab takes its URL after the browser name.
    for (const [position, literal] of scan.strings)
      if (position > opening && literal.end <= end)
        rolesFromUrl(literal.value, signals);
  }
}

function roleArguments(value) {
  if (typeof value !== "string") return value;
  if (value.length > TAIL_BYTES) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function rolesFromTool(name, rawArguments, signals, depth = 0) {
  if (typeof name !== "string") return;
  const tool = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (/\b(?:github|gitlab|wrangler|cloudflare)\b/.test(tool))
    addRole(signals, "engineering");
  if (
    /\b(?:imagegen|image gen|image generation|canva|figma|presentations)\b/.test(
      tool,
    )
  )
    addRole(signals, "design");
  if (
    /\b(?:youtube|soundcloud|twitter|tiktok|instagram|buffer)\b/.test(tool) &&
    /\b(?:upload|publish|post|insert)\b/.test(tool)
  )
    addRole(signals, "pr");
  if (
    /\b(?:salesforce|hubspot|apollo|coconala|crowdworks|lancers|crm)\b/.test(
      tool,
    )
  )
    addRole(signals, "sales");
  if (
    /\b(?:documents?|docx|word|gdocs|google docs)\b/.test(tool) &&
    /\b(?:create|edit|update|write|insert|replace|format|render|export)\b/.test(
      tool,
    )
  )
    addRole(signals, "writing");
  if (
    /\b(?:web run|web search|websearch|search query|scispace|consensus)\b/.test(
      tool,
    )
  )
    addRole(signals, "research");
  if (/\b(?:update plan|update turn plan|turn plan)\b/.test(tool))
    addRole(signals, "planning");
  if (/\b(?:automation update|calendar|todoist|ticktick)\b/.test(tool))
    addRole(signals, "operations");
  const args = roleArguments(rawArguments);
  if (/\b(?:exec command|shell command|run command)\b/.test(tool))
    rolesFromCommand(args?.cmd ?? args?.command, signals);
  if (
    /\b(?:functions exec|cua repl js|cua repl|node repl js)\b/.test(tool) ||
    tool === "exec"
  )
    rolesFromCode(
      typeof args === "string" ? args : (args?.code ?? args?.input),
      signals,
      depth,
    );
  if (/\b(?:browser|navigate|goto|cua)\b/.test(tool))
    rolesFromUrl(args?.url, signals);
  if (/\b(?:apply patch|file change)\b/.test(tool)) {
    const patch =
      typeof args === "string" ? args : (args?.patch ?? args?.input);
    if (typeof patch === "string")
      for (const match of patch
        .slice(0, TAIL_BYTES)
        .matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm))
        rolesFromPath(match[1], signals);
  }
}

function rolesFromItem(item, signals) {
  if (item.item_type === "webSearch") addRole(signals, "research");
  else if (item.item_type === "imageGeneration") addRole(signals, "design");
  else if (item.item_type === "commandExecution")
    rolesFromCommand(item.command, signals);
  else if (item.item_type === "fileChange") {
    try {
      for (const value of JSON.parse(item.paths || "[]"))
        rolesFromPath(value, signals);
    } catch {}
  } else
    rolesFromTool(
      `${item.server || ""}.${item.tool || ""}`,
      item.arguments,
      signals,
    );
}

function milliseconds(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(value)) {
    const n = Number(value);
    const ms = n < 1e12 ? n * 1000 : n;
    return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? ms : 0;
  }
  const n = Date.parse(value);
  return Number.isFinite(n) ? n : 0;
}

function label(value, fallback, maximum = 180) {
  return typeof value === "string" && value.trim()
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, maximum)
    : fallback;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function guardian(row) {
  if (row.thread_source === "guardian_review") return true;
  try {
    return JSON.parse(row.source)?.subagent?.other === "guardian";
  } catch {
    return false;
  }
}

function subagentMetadata(row, parents) {
  let subagent;
  try {
    subagent = JSON.parse(row.source)?.subagent;
  } catch {}
  const spawn = subagent?.thread_spawn;
  const parentId =
    parents.get(row.id) ||
    (typeof spawn?.parent_thread_id === "string"
      ? spawn.parent_thread_id
      : undefined);
  const agentPath = label(row.agent_path, label(spawn?.agent_path, ""), 500);
  const pathParts = agentPath.split("/").filter(Boolean);
  const agentTask =
    pathParts.length > 1
      ? label(pathParts.at(-1).replace(/[_-]+/g, " "), "", 60)
      : "";
  const agentName = label(
    row.agent_nickname,
    label(spawn?.agent_nickname, agentTask),
    60,
  );
  const roleHint = label(row.agent_role, label(spawn?.agent_role, ""), 80);
  return {
    isSubagent: Boolean(
      subagent || parentId || row.thread_source === "subagent",
    ),
    parentId: parentId && parentId !== row.id ? parentId : undefined,
    agentName,
    agentTask,
    roleHint,
  };
}

function taskTitle(row, rowsById, metadata, seen = new Set()) {
  const explicit = label(row.name, label(row.title, ""));
  if (explicit) return explicit;
  const agent = metadata.get(row.id);
  if (!agent?.isSubagent) return "無題のタスク";
  if (seen.has(row.id)) return agent.agentName || "名称未設定のサブタスク";
  seen.add(row.id);
  const parent = rowsById.get(agent.parentId);
  const parentTitle = parent
    ? label(taskTitle(parent, rowsById, metadata, seen), "", 72)
    : "";
  const assignment =
    agent.agentTask && agent.agentTask !== agent.agentName
      ? agent.agentTask
      : "";
  const name = agent.agentName || "名称未設定のサブタスク";
  return label(
    [parentTitle, [assignment, name].filter(Boolean).join(" · ")]
      .filter(Boolean)
      .join(" / "),
    name,
  );
}

function normalizedLocation(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) return null;
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(cwd);
  const normalized = (windows ? path.win32 : path.posix).normalize(cwd.trim());
  return (
    (windows ? normalized.toLowerCase() : normalized).replace(/[\\/]+$/, "") ||
    "/"
  );
}

function projectGroups(rows, rowsById, metadata, projects, projectRoots) {
  const saved = new Map(
    [...projects]
      .map(([id, name]) => [id, label(name, "")])
      .filter(([id, name]) => typeof id === "string" && id.trim() && name),
  );
  const savedByLocation = new Map();
  for (const root of projectRoots) {
    const location = normalizedLocation(root.path);
    if (!location || !saved.has(root.project_id)) continue;
    const ids = savedByLocation.get(location) ?? new Set();
    ids.add(root.project_id);
    savedByLocation.set(location, ids);
  }
  const lineageCache = new Map();
  function lineage(row) {
    if (lineageCache.has(row.id)) return lineageCache.get(row.id);
    const chain = [],
      seen = new Set();
    let current = row;
    while (current && !seen.has(current.id)) {
      chain.push(current);
      seen.add(current.id);
      current = rowsById.get(metadata.get(current.id)?.parentId);
    }
    lineageCache.set(row.id, chain);
    return chain;
  }
  const descriptions = new Map();
  function describe(row) {
    if (descriptions.has(row.id)) return descriptions.get(row.id);
    const chain = lineage(row);
    let projectId;
    for (const member of chain) {
      if (saved.has(member.project_id)) {
        projectId = member.project_id;
        break;
      }
      const matches = savedByLocation.get(normalizedLocation(member.cwd));
      if (matches?.size === 1) {
        projectId = matches.values().next().value;
        break;
      }
    }
    const location = chain
      .map((member) => normalizedLocation(member.cwd))
      .find(Boolean);
    const kind = projectId != null ? "project" : "task-group";
    const identity = projectId ?? location ?? `thread:${chain.at(-1).id}`;
    const description = {
      projectKey: `${kind}:${createHash("sha256").update(String(identity)).digest("hex").slice(0, 24)}`,
      projectKind: kind,
      savedName: saved.get(projectId),
    };
    descriptions.set(row.id, description);
    return description;
  }
  const groups = new Map();
  for (const row of rows) {
    const description = describe(row);
    const group = groups.get(description.projectKey) ?? {
      ...description,
      members: [],
      roots: new Map(),
    };
    group.members.push(row);
    // Prefer the farthest verified parent in this same group. Archived parents
    // may name an active child's group, but are not added back to task results.
    const root = lineage(row)
      .filter(
        (member) => describe(member).projectKey === description.projectKey,
      )
      .at(-1);
    group.roots.set(root.id, root);
    groups.set(description.projectKey, group);
  }
  const result = new Map();
  const recency = (row) =>
    Math.max(
      milliseconds(row.updated_at_ms ?? row.updated_at),
      milliseconds(row.created_at_ms ?? row.created_at),
    );
  for (const group of groups.values()) {
    const roots = [...group.roots.values()];
    const named = roots.filter((row) => label(row.name, label(row.title, "")));
    const representative = (named.length ? named : roots).sort(
      (a, b) => recency(b) - recency(a) || a.id.localeCompare(b.id),
    )[0];
    const projectName =
      group.savedName || taskTitle(representative, rowsById, metadata);
    const details = {
      project: projectName,
      projectKey: group.projectKey,
      projectKind: group.projectKind,
      projectName,
      projectTaskCount: group.roots.size,
      projectMemberCount: group.members.length,
    };
    for (const member of group.members) result.set(member.id, details);
  }
  return result;
}

function schema(db, table) {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => column.name),
  );
}

function selectColumns(columns, names) {
  return names
    .map((name) => (columns.has(name) ? name : `NULL AS ${name}`))
    .join(", ");
}

// Extract only lifecycle facts. Never retain or expose messages, arguments, outputs,
// reasoning, tokens, credentials, or arbitrary JSON fields from a rollout.
function lifecycle(lines, previous, initialTurnId) {
  let state = previous?.state ?? null;
  let activityAt = previous?.activityAt ?? 0;
  let rolesTurnId = initialTurnId ?? previous?.rolesTurnId ?? null;
  let roles = new Map(
    previous?.rolesTurnId === rolesTurnId ? previous.roles : [],
  );
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const at = milliseconds(entry.timestamp);
    if (!at) continue;
    activityAt = Math.max(activityAt, at);
    if (state && at < state.at) continue;
    const payload = entry.payload ?? {};
    const kind = payload.type;
    const turnId =
      typeof payload.turn_id === "string" ? payload.turn_id : undefined;
    if (turnId && turnId !== rolesTurnId) {
      rolesTurnId = turnId;
      roles = new Map();
    }
    if (entry.type === "event_msg" && START_EVENTS.has(kind) && !turnId) {
      rolesTurnId = null;
      roles = new Map();
    }
    if (rolesTurnId) {
      if (entry.type === "response_item") {
        if (kind === "function_call" || kind === "custom_tool_call")
          rolesFromTool(
            `${payload.namespace || ""}.${payload.name || ""}`,
            payload.arguments ?? payload.input,
            roles,
          );
        else if (kind === "web_search_call") addRole(roles, "research");
        else if (kind === "image_generation_call") addRole(roles, "design");
      } else if (
        entry.type === "event_msg" &&
        ["item_started", "item_completed"].includes(kind) &&
        payload.item
      ) {
        const item = payload.item;
        rolesFromItem(
          {
            item_type: item.type,
            server: item.server,
            tool: item.tool,
            command: item.command,
            arguments: item.arguments,
            paths: Array.isArray(item.changes)
              ? JSON.stringify(
                  item.changes.slice(0, 32).map((change) => change.path),
                )
              : undefined,
          },
          roles,
        );
      }
    }
    const set = (status, waitingCallId) => {
      state = { status, at, turnId: turnId ?? state?.turnId, waitingCallId };
    };
    if (entry.type === "event_msg") {
      if (START_EVENTS.has(kind)) set("working");
      else if (DONE_EVENTS.has(kind)) set("done");
      else if (INTERRUPT_EVENTS.has(kind)) set("idle");
      else if (kind === "task_failed") set("error");
      else if (WAIT_EVENTS.has(kind))
        set("waiting", payload.call_id ?? payload.request_id);
      else if (
        kind === "server_request_resolved" &&
        state?.status === "waiting"
      ) {
        const requestId = payload.request_id ?? payload.call_id;
        if (state.waitingCallId != null && requestId === state.waitingCallId)
          set("working");
      }
      // A generic error can be retried; it does not prove that the turn failed.
    } else if (entry.type === "response_item") {
      if (kind === "function_call" || kind === "custom_tool_call") {
        const tool =
          typeof payload.name === "string"
            ? payload.name.split(".").at(-1)
            : "";
        if (WAIT_TOOLS.has(tool)) set("waiting", payload.call_id);
      } else if (
        (kind === "function_call_output" ||
          kind === "custom_tool_call_output") &&
        state?.status === "waiting" &&
        state.waitingCallId != null &&
        payload.call_id === state.waitingCallId
      )
        set("working");
    }
  }
  return { state, activityAt, rolesTurnId, roles: [...roles] };
}

/** Observe the installed Codex application's files without starting a model turn.
 * The on-disk format is private and version-dependent. Unsupported formats report
 * unavailable/unknown; this adapter never repairs or writes Codex's own state.
 */
export function createCodexSource({
  codexHome = process.env.CODEX_HOME || path.join(homedir(), ".codex"),
  staleMs = DEFAULT_STALE_MS,
} = {}) {
  const root = path.resolve(codexHome);
  const staleAfter =
    Number.isFinite(staleMs) && staleMs >= 1000 ? staleMs : DEFAULT_STALE_MS;
  const connections = new Map();
  const tails = new Map();
  const roleHistory = new Map();
  const replyReads = new Set();
  let previousTasks = [];
  let inFlight;
  let closed = false;

  async function database(prefix, names) {
    const pattern = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`);
    const filename = names
      .filter((name) => pattern.test(name))
      .sort(
        (a, b) => Number(b.match(pattern)[1]) - Number(a.match(pattern)[1]),
      )[0];
    if (!filename) return null;
    const location = path.join(root, filename);
    const info = await stat(location);
    const signature = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
    let connection = connections.get(prefix);
    if (
      connection?.location !== location ||
      connection.signature !== signature
    ) {
      connection?.db.close();
      const db = new DatabaseSync(location, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 100");
      connection = { location, signature, db };
      connections.set(prefix, connection);
    }
    return connection;
  }

  async function tail(rolloutPath, turn) {
    if (typeof rolloutPath !== "string" || !rolloutPath.endsWith(".jsonl"))
      return null;
    try {
      const actualRoot = await realpath(root);
      const actual = await realpath(rolloutPath);
      if (
        !actual.endsWith(".jsonl") ||
        !["sessions", "archived_sessions"].some((directory) =>
          inside(path.join(actualRoot, directory), actual),
        )
      )
        return null;
      const info = await stat(actual);
      if (!info.isFile()) return null;
      const floor =
        Number.isSafeInteger(turn?.rollout_byte_offset) &&
        turn.rollout_byte_offset >= 0 &&
        turn.rollout_byte_offset <= info.size
          ? turn.rollout_byte_offset
          : null;
      const signature = `${info.ino}:${info.birthtimeMs}:${info.size}:${info.mtimeMs}:${turn?.turn_id || ""}:${floor}`;
      const cached = tails.get(actual);
      if (cached?.signature === signature) return cached.facts;
      const handle = await open(actual, "r");
      let buffer;
      let start;
      try {
        const current = await handle.stat();
        start = Math.max(floor ?? 0, current.size - TAIL_BYTES);
        buffer = Buffer.alloc(current.size - start);
        const result = await handle.read(buffer, 0, buffer.length, start);
        buffer = buffer.subarray(0, result.bytesRead);
      } finally {
        await handle.close();
      }
      const lines = buffer.toString("utf8").split("\n");
      if (start > 0 && start !== floor) lines.shift();
      // Appends may be incomplete. A JSONL record is committed at its newline.
      lines.pop();
      const sameFile =
        cached?.identity === `${info.ino}:${info.birthtimeMs}` &&
        info.size >= cached.size;
      const facts = lifecycle(
        lines,
        sameFile ? cached.facts : null,
        floor != null ? turn?.turn_id : undefined,
      );
      tails.set(actual, {
        signature,
        identity: `${info.ino}:${info.birthtimeMs}`,
        size: info.size,
        facts,
      });
      return facts;
    } catch {
      return null;
    }
  }

  async function readReply(taskId, options = {}) {
    const turnId = options?.turnId;
    const valid = (value) =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= 256 &&
      !value.includes("\0");
    if (!valid(taskId) || !valid(turnId))
      return {
        status: "unavailable",
        taskId: valid(taskId) ? taskId : null,
        turnId: valid(turnId) ? turnId : null,
        reason: "exact_turn_required",
      };
    const unavailable = (reason) => ({
      status: "unavailable",
      taskId,
      turnId,
      reason,
    });
    if (closed) return unavailable("closed");
    try {
      const names = await readdir(root);
      const state = await database("state", names);
      const history = await database("thread_history", names);
      if (closed) return unavailable("closed");
      if (!state || !history) return unavailable("unsupported_history");
      const threadColumns = schema(state.db, "threads");
      if (!threadColumns.has("id")) return unavailable("unsupported_history");
      const task = state.db
        .prepare(
          `SELECT ${selectColumns(threadColumns, ["id", "source", "thread_source"])} FROM threads WHERE id = ? LIMIT 1`,
        )
        .get(taskId);
      if (!task || guardian(task)) return unavailable("task_not_found");
      const turns = schema(history.db, "thread_turns"),
        items = schema(history.db, "thread_items");
      if (
        !["thread_id", "turn_id", "status", "final_agent_item_id"].every(
          (key) => turns.has(key),
        ) ||
        !["thread_id", "turn_id", "item_id", "item_type", "item_json"].every(
          (key) => items.has(key),
        )
      )
        return unavailable("unsupported_history");
      const turn = history.db
        .prepare(
          "SELECT status, final_agent_item_id FROM thread_turns WHERE thread_id = ? AND turn_id = ? LIMIT 1",
        )
        .get(taskId, turnId);
      if (!turn) return unavailable("turn_not_found");
      if (turn.status !== "completed") return unavailable("not_completed");
      if (
        typeof turn.final_agent_item_id !== "string" ||
        !turn.final_agent_item_id
      )
        return unavailable("reply_missing");
      // The final-item pointer and all three identifiers must match. Do not use
      // a latest-turn fallback or select commentary, prompts, reasoning or tools.
      const reply = history.db
        .prepare(
          `SELECT
        substr(CAST(json_extract(item_json, '$.text') AS BLOB), 1, ?) AS text_bytes,
        length(CAST(json_extract(item_json, '$.text') AS BLOB)) AS total_bytes
        FROM thread_items WHERE thread_id = ? AND turn_id = ? AND item_id = ?
          AND item_type = 'agentMessage' AND json_valid(item_json)
          AND json_extract(item_json, '$.type') = 'agentMessage'
          AND json_type(item_json, '$.text') = 'text'
          AND (json_extract(item_json, '$.phase') IN ('final', 'final_answer')
            OR json_type(item_json, '$.phase') IS NULL OR json_type(item_json, '$.phase') = 'null')
        LIMIT 1`,
        )
        .get(REPLY_BYTES, taskId, turnId, turn.final_agent_item_id);
      if (!reply?.total_bytes || !(reply.text_bytes instanceof Uint8Array))
        return unavailable("reply_missing");
      // Streaming decode omits an incomplete UTF-8 character at the byte limit.
      const text = new TextDecoder("utf-8").decode(reply.text_bytes, {
        stream: true,
      });
      return {
        status: "available",
        taskId,
        turnId,
        text,
        truncated: Buffer.byteLength(text, "utf8") < reply.total_bytes,
        totalBytes: reply.total_bytes,
      };
    } catch {
      return { status: "error", taskId, turnId, reason: "read_failed" };
    }
  }

  async function readSnapshot() {
    const now = Date.now();
    const observedAt = new Date(now).toISOString();
    if (closed)
      return {
        tasks: [],
        health: {
          status: "unavailable",
          mode: "none",
          message: "連携は終了しています。",
          observedAt,
          taskCount: 0,
        },
      };
    let historyUnavailable = false;
    try {
      const names = await readdir(root);
      const state = await database("state", names);
      if (!state) throw new Error("missing_state");
      const columns = schema(state.db, "threads");
      if (!columns.has("id") || !columns.has("archived"))
        throw new Error("unsupported_schema");
      const fields = [
        "id",
        "name",
        "title",
        "cwd",
        "project_id",
        "source",
        "thread_source",
        "agent_role",
        "agent_nickname",
        "agent_path",
        "rollout_path",
        "created_at",
        "created_at_ms",
        "updated_at",
        "updated_at_ms",
      ];
      const rows = state.db
        .prepare(
          `SELECT ${selectColumns(columns, fields)} FROM threads WHERE archived = 0`,
        )
        .all()
        .filter((row) => !guardian(row));
      const edgeColumns = schema(state.db, "thread_spawn_edges");
      const parents =
        edgeColumns.has("parent_thread_id") &&
        edgeColumns.has("child_thread_id")
          ? new Map(
              state.db
                .prepare(
                  "SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges",
                )
                .all()
                .map((edge) => [edge.child_thread_id, edge.parent_thread_id]),
            )
          : new Map();
      const metadata = new Map(
        rows.map((row) => [row.id, subagentMetadata(row, parents)]),
      );
      const rowsById = new Map(rows.map((row) => [row.id, row]));
      const readParent = state.db.prepare(
        `SELECT ${selectColumns(columns, fields)} FROM threads WHERE id = ? LIMIT 1`,
      );
      // An active child can outlive an archived parent. Only its parent's label is
      // needed; the archived parent must not reappear as a separate active task.
      for (const agent of metadata.values()) {
        if (!agent.parentId || rowsById.has(agent.parentId)) continue;
        const parent = readParent.get(agent.parentId);
        if (parent && !guardian(parent)) {
          rowsById.set(parent.id, parent);
          metadata.set(parent.id, subagentMetadata(parent, parents));
        }
      }
      const projectColumns = schema(state.db, "projects");
      const projects =
        projectColumns.has("id") && projectColumns.has("name")
          ? new Map(
              state.db
                .prepare("SELECT id, name FROM projects")
                .all()
                .map((row) => [row.id, row.name]),
            )
          : new Map();
      const rootColumns = schema(state.db, "project_roots");
      const projectRoots =
        rootColumns.has("project_id") && rootColumns.has("path")
          ? state.db.prepare("SELECT project_id, path FROM project_roots").all()
          : [];
      const groupDetails = projectGroups(
        rows,
        rowsById,
        metadata,
        projects,
        projectRoots,
      );
      let history;
      let latestTurn;
      let latestItem;
      let roleItems;
      try {
        history = await database("thread_history", names);
        if (history) {
          const turnColumns = schema(history.db, "thread_turns");
          if (
            ["thread_id", "turn_id", "status", "rollout_ordinal"].every(
              (column) => turnColumns.has(column),
            )
          ) {
            latestTurn = history.db.prepare(
              `SELECT ${selectColumns(turnColumns, ["turn_id", "status", "started_at", "completed_at", "rollout_byte_offset"])} FROM thread_turns WHERE thread_id = ? ORDER BY rollout_ordinal DESC LIMIT 1`,
            );
          }
          const itemColumns = schema(history.db, "thread_items");
          if (
            ["thread_id", "turn_id", "created_at_ms", "rollout_ordinal"].every(
              (column) => itemColumns.has(column),
            )
          ) {
            latestItem = history.db.prepare(
              "SELECT created_at_ms, rollout_ordinal FROM thread_items WHERE thread_id = ? AND turn_id = ? ORDER BY rollout_ordinal DESC LIMIT 1",
            );
          }
          if (
            latestItem &&
            itemColumns.has("item_json") &&
            itemColumns.has("item_type")
          ) {
            roleItems = history.db.prepare(`SELECT item_type, rollout_ordinal,
              substr(json_extract(item_json, '$.server'), 1, 256) AS server,
              substr(json_extract(item_json, '$.tool'), 1, 256) AS tool,
              CASE WHEN item_type IN ('mcpToolCall', 'dynamicToolCall') THEN substr(json_extract(item_json, '$.arguments'), 1, ${TAIL_BYTES}) END AS arguments,
              CASE WHEN item_type = 'commandExecution' THEN substr(json_extract(item_json, '$.command'), 1, ${TAIL_BYTES}) END AS command,
              CASE WHEN item_type = 'fileChange' THEN
                (SELECT json_group_array(substr(json_extract(change.value, '$.path'), 1, 1024))
                 FROM (SELECT value FROM json_each(thread_items.item_json, '$.changes') LIMIT 32) AS change)
              END AS paths
              FROM thread_items WHERE thread_id = ? AND turn_id = ?
                AND rollout_ordinal > ? AND rollout_ordinal <= ?
                AND item_type IN (${ROLE_ITEM_TYPES.map((type) => `'${type}'`).join(",")}) AND json_valid(item_json)
              ORDER BY rollout_ordinal DESC LIMIT ${ROLE_SCAN_ITEMS}`);
          }
          if (!latestTurn) historyUnavailable = true;
        }
      } catch {
        historyUnavailable = true;
      }

      let staleTaskCount = 0;
      const tasks = await Promise.all(
        rows.map(async (row) => {
          let turn;
          let itemActivity = 0;
          let lastItem;
          try {
            turn = latestTurn?.get(row.id);
            if (turn?.status === "inProgress") {
              lastItem = latestItem?.get(row.id, turn.turn_id);
              itemActivity = milliseconds(lastItem?.created_at_ms);
            }
          } catch {
            historyUnavailable = true;
          }
          const facts = await tail(row.rollout_path, turn);
          const start = milliseconds(turn?.started_at);
          const completion = milliseconds(turn?.completed_at);
          const dbState =
            turn && TURN_STATUS[turn.status]
              ? {
                  status: TURN_STATUS[turn.status],
                  at: completion || start,
                  turnId: turn.turn_id,
                }
              : null;
          let evidence = dbState;
          if (facts?.state && (!evidence || facts.state.at >= evidence.at))
            evidence = facts.state;
          // The history projection uses whole seconds. An older terminal event from
          // another turn must not overrule a new turn that started in that second.
          if (
            dbState?.status === "working" &&
            evidence?.turnId &&
            evidence.turnId !== dbState.turnId &&
            evidence.at < start + 1000
          )
            evidence = dbState;
          // Some older projections retain a terminal status without a completion
          // timestamp. Its own start event is not evidence of a new running turn.
          if (
            dbState &&
            dbState.status !== "working" &&
            !completion &&
            evidence?.turnId === dbState.turnId &&
            (evidence.status === "working" || evidence.status === "waiting")
          )
            evidence = dbState;
          let status = evidence?.status ?? "unknown";
          const activityAt = Math.max(
            start,
            itemActivity,
            facts?.activityAt ?? 0,
            evidence?.at ?? 0,
          );
          let summary = SUMMARY[status];
          if (
            status === "working" &&
            (!activityAt || now - activityAt > staleAfter)
          ) {
            status = "unknown";
            staleTaskCount += 1;
            summary =
              "実行中の記録がありますが、更新が止まっています。長い処理の可能性もあるため、完了とは判定していません。";
          }
          const updated = Math.max(
            milliseconds(row.updated_at_ms ?? row.updated_at),
            activityAt,
            milliseconds(row.created_at_ms ?? row.created_at),
          );
          const task = {
            id: row.id,
            title: taskTitle(row, rowsById, metadata),
            ...groupDetails.get(row.id),
            source: "codex",
            status,
            turnId: evidence?.turnId ?? turn?.turn_id ?? null,
            updatedAt: new Date(updated).toISOString(),
            observedAt,
            summary,
            url: `codex://threads/${encodeURIComponent(row.id)}`,
          };
          const agent = metadata.get(row.id);
          task.activeRoles = [];
          if (status === "working" || status === "waiting") {
            const turnId =
              evidence?.turnId ?? facts?.rolesTurnId ?? turn?.turn_id;
            let cachedRoles = roleHistory.get(row.id);
            if (!cachedRoles || cachedRoles.turnId !== turnId) {
              cachedRoles = { turnId, throughOrdinal: -1, signals: new Map() };
              roleHistory.set(row.id, cachedRoles);
            }
            if (turnId && roleItems) {
              try {
                const currentItem =
                  turnId === turn?.turn_id
                    ? lastItem
                    : latestItem?.get(row.id, turnId);
                const throughOrdinal = currentItem?.rollout_ordinal ?? -1;
                if (throughOrdinal > cachedRoles.throughOrdinal) {
                  for (const item of roleItems.all(
                    row.id,
                    turnId,
                    cachedRoles.throughOrdinal,
                    throughOrdinal,
                  ))
                    rolesFromItem(item, cachedRoles.signals);
                  cachedRoles.throughOrdinal = throughOrdinal;
                }
              } catch {
                historyUnavailable = true;
              }
            }
            const signals = new Map(cachedRoles.signals);
            if (turnId && facts?.rolesTurnId === turnId)
              for (const [, signal] of facts.roles)
                addRole(
                  signals,
                  signal.roleId,
                  signal.evidence,
                  signal.priority,
                );
            addAssignmentRoles(signals, agent);
            task.activeRoles = ROLE_IDS.filter((id) => signals.has(id)).map(
              (roleId) => ({ roleId, evidence: signals.get(roleId).evidence }),
            );
          } else roleHistory.delete(row.id);
          task.isSubagent = agent.isSubagent;
          if (agent.parentId) task.parentId = agent.parentId;
          if (agent.agentName) task.agentName = agent.agentName;
          if (agent.agentTask) task.agentTask = agent.agentTask;
          if (agent.roleHint) task.roleHint = agent.roleHint;
          return task;
        }),
      );
      tasks.sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      );
      const activeIds = new Set(rows.map((row) => row.id));
      for (const id of roleHistory.keys())
        if (!activeIds.has(id)) roleHistory.delete(id);
      previousTasks = tasks;
      return {
        tasks,
        health: {
          status: historyUnavailable ? "partial" : "connected",
          mode: "sqlite",
          observedAt,
          taskCount: tasks.length,
          staleTaskCount,
          message: historyUnavailable
            ? "一部の履歴を読み取れないため、取得できた記録を表示しています。"
            : "この端末のCodexタスクを読み取っています。",
        },
      };
    } catch {
      for (const connection of connections.values()) {
        try {
          connection.db.close();
        } catch {}
      }
      connections.clear();
      roleHistory.clear();
      const tasks = previousTasks.map((task) => ({
        ...task,
        status: "unknown",
        activeRoles: [],
        summary: "現在は読み取れないため、前回観測した一覧を表示しています。",
      }));
      return {
        tasks,
        health: {
          status: "unavailable",
          mode: "none",
          message:
            "Codexの状態を読み取れません。Codexの保存先とバージョンを確認してください。",
          observedAt,
          taskCount: tasks.length,
        },
      };
    }
  }

  return {
    getReply(taskId, options) {
      const pending = readReply(taskId, options);
      replyReads.add(pending);
      pending.finally(() => replyReads.delete(pending));
      return pending;
    },
    snapshot() {
      return (inFlight ??= readSnapshot().finally(() => {
        inFlight = undefined;
      }));
    },
    async close() {
      closed = true;
      if (inFlight) await inFlight;
      await Promise.allSettled(replyReads);
      for (const connection of connections.values()) connection.db.close();
      connections.clear();
      tails.clear();
      roleHistory.clear();
    },
  };
}
