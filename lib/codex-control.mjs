import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { access, realpath, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";

export const USAGE_REFRESH_MS = 60_000;
export const MAX_INSTRUCTION_BYTES = 32_768;
export const MAX_REPLY_BYTES = 65_536;
export const MAX_CACHED_REPLIES = 30;
export const CONTROL_POLICY = Object.freeze({
  approvalPolicy: "never",
  sandbox: "workspace-write",
  networkAccess: false,
  excludeTmpdirEnvVar: true,
  excludeSlashTmp: true,
});
const SAFE_ARGS = Object.freeze([
  "app-server",
  "--stdio",
  "-c",
  'approval_policy="never"',
  "-c",
  'sandbox_mode="workspace-write"',
  "-c",
  "sandbox_workspace_write.network_access=false",
  "-c",
  "sandbox_workspace_write.writable_roots=[]",
  "-c",
  "sandbox_workspace_write.exclude_tmpdir_env_var=true",
  "-c",
  "sandbox_workspace_write.exclude_slash_tmp=true",
]);
const METHODS = new Set([
  "account/read",
  "account/rateLimits/read",
  "thread/read",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/interrupt",
  "windowsSandbox/readiness",
]);
const MUTATIONS = new Set([
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/interrupt",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(["completed", "interrupted", "failed"]);
const safeString = (value, max = 120) =>
  typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max)
    : null;
const finite = (value) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const iso = (value) => new Date(value).toISOString();

export class CodexControlError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CodexControlError";
    this.code = code;
    this.outcomeUnknown = details.outcomeUnknown === true;
    this.taskId = UUID.test(details.taskId || "") ? details.taskId : null;
    this.turnId = UUID.test(details.turnId || "") ? details.turnId : null;
    this.rpcCode = finite(details.rpcCode);
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      outcomeUnknown: this.outcomeUnknown,
      taskId: this.taskId,
      turnId: this.turnId,
      rpcCode: this.rpcCode,
    };
  }
}

function controlError(error) {
  return error instanceof CodexControlError
    ? error
    : new CodexControlError(
        "CODEX_UNAVAILABLE",
        "Codex could not complete this request.",
      );
}

function threadId(value) {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new CodexControlError("INVALID_TASK", "Choose a local Codex task.");
  }
  return value;
}

async function directory(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    /[\u0000\r\n]/.test(value)
  ) {
    throw new CodexControlError(
      "INVALID_DIRECTORY",
      "Choose an existing local folder.",
    );
  }
  try {
    const resolved = await realpath(value);
    if (!(await stat(resolved)).isDirectory()) throw new Error();
    return resolved;
  } catch {
    throw new CodexControlError(
      "INVALID_DIRECTORY",
      "The selected local folder is unavailable.",
    );
  }
}

/**
 * Resolve an installed native Codex binary or the standard npm JS entrypoint.
 * Batch/PowerShell shims are never executed through a shell or parsed as code.
 */
export async function resolveCodexLaunch({
  codexPath,
  env = process.env,
  platform = process.platform,
  nodePath = process.execPath,
} = {}) {
  const win = platform === "win32";
  const paths = win ? path.win32 : path.posix;
  const candidates = [];
  if (codexPath !== undefined) {
    if (
      typeof codexPath !== "string" ||
      !paths.isAbsolute(codexPath) ||
      /[\u0000\r\n]/.test(codexPath)
    ) {
      throw new CodexControlError(
        "INVALID_EXECUTABLE",
        "The Codex executable must be an absolute file path.",
      );
    }
    candidates.push(codexPath);
  } else {
    for (const entry of String(env.PATH || env.Path || "").split(
      win ? ";" : ":",
    )) {
      const folder = entry.replace(/^"|"$/g, "");
      if (!folder || !paths.isAbsolute(folder)) continue;
      for (const name of win
        ? ["codex.exe", "codex.cmd", "codex.ps1"]
        : ["codex"]) {
        candidates.push(paths.join(folder, name));
      }
    }
    if (win && env.LOCALAPPDATA) {
      const base = paths.join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
      try {
        const installs = await readdir(base, { withFileTypes: true });
        const found = await Promise.all(
          installs
            .filter((item) => item.isDirectory())
            .slice(0, 32)
            .map(async (item) => {
              const file = paths.join(base, item.name, "codex.exe");
              try {
                return { file, modified: (await stat(file)).mtimeMs };
              } catch {
                return null;
              }
            }),
        );
        candidates.push(
          ...found
            .filter(Boolean)
            .sort((a, b) => b.modified - a.modified)
            .map((item) => item.file),
        );
      } catch {
        /* The desktop bundle is optional. */
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(candidate);
      if (!(await stat(resolved)).isFile()) continue;
      if (/\.(cmd|bat|ps1)$/i.test(resolved)) {
        const entry = paths.join(
          paths.dirname(resolved),
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        if ((await stat(entry)).isFile()) {
          return {
            command: nodePath,
            args: [await realpath(entry), ...SAFE_ARGS],
          };
        }
        continue;
      }
      if (/\.m?js$/i.test(resolved))
        return { command: nodePath, args: [resolved, ...SAFE_ARGS] };
      if (win && !/\.exe$/i.test(resolved)) continue;
      if (!win) await access(resolved, constants.X_OK);
      return { command: resolved, args: [...SAFE_ARGS] };
    } catch {
      /* Try the next installed location without exposing path contents. */
    }
  }
  throw new CodexControlError(
    "CODEX_NOT_FOUND",
    "Install Codex CLI or select its executable.",
  );
}

export function createProcessTransport(options = {}) {
  return async () => {
    const launch = await resolveCodexLaunch(options);
    const env = { ...(options.env || process.env) };
    // Codex's home helper expects HOME on some packaged Windows builds.
    if (!env.HOME) env.HOME = os.homedir();
    env.CODEX_HOME = await directory(
      options.codexHome || env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    );
    const child = spawn(launch.command, launch.args, {
      env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Protect the brief interval before the client attaches its error handler.
    child.on("error", () => {});
    return child;
  };
}

/** Newline-delimited JSON-RPC transport. Never logs stdout, stderr, or RPC data. */
export class StdioAppServerClient extends EventEmitter {
  constructor({
    transportFactory,
    requestTimeoutMs = 15_000,
    maxLineBytes = 8 * 1024 * 1024,
    ...options
  } = {}) {
    super();
    this.transportFactory = transportFactory || createProcessTransport(options);
    this.requestTimeoutMs = requestTimeoutMs;
    this.maxLineBytes = maxLineBytes;
    this.child = null;
    this.ready = false;
    this.starting = null;
    this.closed = false;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = "";
  }

  async start() {
    if (this.closed)
      throw new CodexControlError(
        "CODEX_CLOSED",
        "The Codex connection is closed.",
      );
    if (this.ready) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const child = await this.transportFactory();
      if (this.closed) {
        child.kill();
        throw new CodexControlError(
          "CODEX_CLOSED",
          "The Codex connection is closed.",
        );
      }
      this.child = child;
      this.buffer = "";
      child.stdout.setEncoding?.("utf8");
      child.stdout.on("data", (data) => {
        if (this.child === child) this.consume(String(data));
      });
      child.stdout.on("error", () => this.fail(child, "CODEX_IO_ERROR"));
      child.stdin.on("error", () => this.fail(child, "CODEX_IO_ERROR"));
      child.stderr?.on("error", () => {});
      child.stderr?.resume();
      child.on("error", () => this.fail(child, "CODEX_UNAVAILABLE"));
      child.on("exit", () => this.fail(child, "CODEX_EXITED"));
      child.on("close", () => this.fail(child, "CODEX_EXITED"));
      await this.rawRequest("initialize", {
        clientInfo: { name: "workroom", title: "Workroom", version: "0.2.3" },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      this.write({ method: "initialized", params: {} });
      this.ready = true;
      this.emit("connected");
    })()
      .catch((error) => {
        const child = this.child;
        if (child) {
          this.fail(child, "CODEX_UNAVAILABLE");
          child.kill();
        }
        throw controlError(error);
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  async request(method, params) {
    if (!METHODS.has(method))
      throw new CodexControlError(
        "METHOD_NOT_ALLOWED",
        "This Codex operation is not available in Workroom.",
      );
    await this.start();
    return this.rawRequest(method, params);
  }

  rawRequest(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodexControlError(
            "CODEX_TIMEOUT",
            "Codex did not acknowledge this request in time.",
            {
              outcomeUnknown: MUTATIONS.has(method),
              taskId: params?.threadId,
            },
          ),
        );
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer,
        method,
        taskId: params?.threadId,
      });
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(controlError(error));
      }
    });
  }

  write(frame) {
    if (!this.child?.stdin?.writable || this.child.stdin.destroyed) {
      throw new CodexControlError(
        "CODEX_DISCONNECTED",
        "Codex is not connected.",
      );
    }
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  rejectServerRequest(id) {
    this.write({
      id,
      error: {
        code: -32601,
        message: "Continue this interactive request in Codex.",
      },
    });
  }

  consume(data) {
    this.buffer += data;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.maxLineBytes)
        return this.protocolFailure();
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        return this.protocolFailure();
      }
      if (!frame || typeof frame !== "object" || Array.isArray(frame))
        return this.protocolFailure();
      if (typeof frame.method === "string") {
        if (has(frame, "id")) {
          if (this.listenerCount("serverRequest"))
            this.emit("serverRequest", frame);
          else this.rejectServerRequest(frame.id);
        } else this.emit("notification", frame.method, frame.params || {});
        continue;
      }
      const pending = this.pending.get(frame.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(frame.id);
      if (frame.error) {
        pending.reject(
          new CodexControlError(
            frame.error.code === -32601
              ? "CODEX_UNSUPPORTED"
              : "CODEX_REQUEST_FAILED",
            "Codex rejected the request. Check the task or account in Codex.",
            { rpcCode: frame.error.code, taskId: pending.taskId },
          ),
        );
      } else if (has(frame, "result")) pending.resolve(frame.result);
      else
        pending.reject(
          new CodexControlError(
            "CODEX_PROTOCOL_ERROR",
            "Codex returned an unreadable response.",
          ),
        );
    }
    if (Buffer.byteLength(this.buffer) > this.maxLineBytes)
      this.protocolFailure();
  }

  protocolFailure() {
    const child = this.child;
    this.fail(child, "CODEX_PROTOCOL_ERROR");
    child?.kill();
  }

  fail(child, code) {
    if (!child || this.child !== child) return;
    this.child = null;
    this.ready = false;
    this.buffer = "";
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new CodexControlError(
          code,
          "The Codex connection became unavailable.",
          {
            outcomeUnknown: MUTATIONS.has(pending.method),
            taskId: pending.taskId,
          },
        ),
      );
    }
    this.pending.clear();
    this.emit("disconnected", { code });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    if (!child) return;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.end();
    let timer;
    await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(resolve, 1500);
      }),
    ]);
    clearTimeout(timer);
    if (this.child === child) {
      child.kill();
      this.fail(child, "CODEX_CLOSED");
    }
  }
}

function normalizeWindow(value, kind, bucketId) {
  if (!value || typeof value !== "object") return null;
  const usedPercent = finite(value.usedPercent);
  const duration = finite(value.windowDurationMins);
  const reset = finite(value.resetsAt);
  return {
    kind,
    bucketId,
    durationMinutes: duration !== null && duration > 0 ? duration : null,
    usedPercent,
    remainingPercent:
      usedPercent === null
        ? null
        : Math.max(0, Math.min(100, 100 - usedPercent)),
    resetsAt: reset !== null && reset >= 0 ? reset : null,
  };
}

/** Preserve actual durations; primary/secondary are not synonyms for 5h/7d. */
export function normalizeAccountUsage(
  accountResponse,
  rateResponse,
  observedAt = new Date().toISOString(),
) {
  const account = accountResponse?.account;
  const accountType = safeString(account?.type);
  const accountPlan = safeString(account?.planType);
  const map = rateResponse?.rateLimitsByLimitId;
  const entries =
    map && typeof map === "object" && !Array.isArray(map)
      ? Object.entries(map).filter(
          ([, value]) => value && typeof value === "object",
        )
      : [];
  if (!entries.length && rateResponse?.rateLimits)
    entries.push([
      rateResponse.rateLimits.limitId || "codex",
      rateResponse.rateLimits,
    ]);
  const buckets = entries.slice(0, 100).map(([key, value]) => {
    const bucketId = safeString(value.limitId) || safeString(key);
    return {
      bucketId,
      limitName: safeString(value.limitName),
      planType: safeString(value.planType),
      normalModelSlug: safeString(value.normalModelSlug),
      rateLimitReachedType: safeString(value.rateLimitReachedType),
      windows: ["primary", "secondary"]
        .map((kind) => normalizeWindow(value[kind], kind, bucketId))
        .filter(Boolean),
    };
  });
  const codex = buckets.find((bucket) => bucket.bucketId === "codex");
  const planType = accountPlan || codex?.planType || null;
  const durations =
    planType === "pro" ? [10_080] : planType === "plus" ? [300, 10_080] : null;
  const windows = (codex?.windows || []).filter(
    (window) => !durations || durations.includes(window.durationMinutes),
  );
  return {
    status: !account
      ? "signed_out"
      : accountType !== "chatgpt"
        ? "unsupported_account"
        : rateResponse
          ? "available"
          : "unavailable",
    accountType,
    planType,
    windows,
    buckets,
    missingDurations: durations
      ? durations.filter(
          (duration) =>
            !windows.some((window) => window.durationMinutes === duration),
        )
      : [],
    ordinaryUsageAllowed:
      typeof rateResponse?.ordinaryUsageAllowed === "boolean"
        ? rateResponse.ordinaryUsageAllowed
        : null,
    observedAt,
    stale: false,
    error: null,
  };
}

export class CodexControl {
  constructor({
    client,
    onEvent,
    getTaskState,
    now = () => Date.now(),
    usageRefreshMs = USAGE_REFRESH_MS,
    platform = process.platform,
    ...options
  } = {}) {
    this.client = client || new StdioAppServerClient({ ...options, platform });
    this.now = now;
    this.platform = platform;
    this.getTaskState = getTaskState;
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this.usageRefreshMs = Math.max(USAGE_REFRESH_MS, usageRefreshMs);
    this.usage = null;
    this.usageAttemptAt = -Infinity;
    this.usagePending = null;
    this.account = null;
    this.owned = new Map();
    this.pendingStarts = new Set();
    this.ownedTurns = new Map();
    this.pendingReplies = new Map();
    this.completedReplies = new Map();
    this.locks = new Set();
    this.events = [];
    this.closed = false;
    this.client.on("serverRequest", (frame) => this.handleServerRequest(frame));
    this.client.on("notification", (method, params) =>
      this.handleNotification(method, params),
    );
    this.client.on("disconnected", (detail) => {
      for (const [id, turn] of this.owned) {
        if (!TERMINAL.has(turn.status))
          this.emit({
            type: "handoff",
            taskId: id,
            turnId: turn.turnId,
            reason: "connection_lost",
          });
      }
      if (this.usage)
        this.usage = {
          ...this.usage,
          stale: true,
          status: "unavailable",
          error: { code: detail.code, message: "Codex is disconnected." },
        };
    });
  }

  emit(event) {
    const value = { ...event, at: iso(this.now()) };
    this.events.push(value);
    this.events = this.events.slice(-64);
    try {
      this.onEvent(structuredClone(value));
    } catch {
      /* UI callbacks cannot break transport. */
    }
  }

  async getAccountUsage() {
    if (this.usagePending) return structuredClone(await this.usagePending);
    if (this.usage && this.now() - this.usageAttemptAt < this.usageRefreshMs)
      return structuredClone(this.usage);
    this.usageAttemptAt = this.now();
    this.usagePending = (async () => {
      try {
        const response = await this.client.request("account/read", {
          refreshToken: false,
        });
        this.account = {
          account: response?.account
            ? {
                type: safeString(response.account.type),
                planType: safeString(response.account.planType),
              }
            : null,
        };
        const rate =
          this.account?.account?.type === "chatgpt"
            ? await this.client.request("account/rateLimits/read")
            : null;
        this.usage = normalizeAccountUsage(this.account, rate, iso(this.now()));
      } catch (error) {
        const safe = controlError(error);
        const previous =
          this.usage || normalizeAccountUsage(this.account, null, null);
        this.usage = {
          ...previous,
          status: "unavailable",
          stale: true,
          error: { code: safe.code, message: safe.message },
        };
      }
      return this.usage;
    })();
    try {
      return structuredClone(await this.usagePending);
    } finally {
      this.usagePending = null;
    }
  }

  async readThreadContext(id) {
    const taskId = threadId(id);
    const response = await this.client.request("thread/read", {
      threadId: taskId,
      includeTurns: false,
    });
    const thread = response?.thread;
    if (!thread || thread.id !== taskId || typeof thread.cwd !== "string") {
      throw new CodexControlError(
        "CODEX_PROTOCOL_ERROR",
        "Codex did not return the selected task.",
      );
    }
    return {
      taskId,
      cwd: thread.cwd,
      status: ["notLoaded", "idle", "active", "systemError"].includes(
        thread.status?.type,
      )
        ? thread.status.type
        : "unknown",
      activeFlags: Array.isArray(thread.status?.activeFlags)
        ? thread.status.activeFlags.filter((value) =>
            ["waitingOnApproval", "waitingOnUserInput"].includes(value),
          )
        : [],
    };
  }

  async sendInstruction(input) {
    if (this.closed)
      throw new CodexControlError(
        "CODEX_CLOSED",
        "The Codex connection is closed.",
      );
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !["taskId", "projectTaskId", "cwd", "text"].includes(key),
      )
    ) {
      throw new CodexControlError(
        "INVALID_INSTRUCTION",
        "Use a task or project and a text instruction.",
      );
    }
    const { taskId: target, projectTaskId, cwd: suppliedCwd, text } = input;
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.includes("\0") ||
      Buffer.byteLength(text, "utf8") > MAX_INSTRUCTION_BYTES
    ) {
      throw new CodexControlError(
        "INVALID_INSTRUCTION",
        "Enter an instruction of at most 32 KiB.",
      );
    }
    if (target && (projectTaskId || suppliedCwd !== undefined)) {
      throw new CodexControlError(
        "INVALID_INSTRUCTION",
        "An existing task keeps its original folder.",
      );
    }
    if (target !== undefined) threadId(target);
    if (projectTaskId !== undefined) threadId(projectTaskId);
    const lock = target || "new:" + (projectTaskId || suppliedCwd || "");
    if (this.locks.has(lock))
      throw new CodexControlError(
        "TASK_BUSY",
        "An instruction is already being sent to this task.",
      );
    this.locks.add(lock);
    let id = target || null;
    try {
      let context = null;
      if (target) {
        const local = this.owned.get(target);
        if (local && !TERMINAL.has(local.status))
          throw new CodexControlError(
            "TASK_BUSY",
            "This task is still running. Continue it in Codex.",
            { taskId: target },
          );
        // Another app-server's notLoaded status is not proof that desktop work is idle.
        if (!local) {
          const state = await this.getTaskState?.(target);
          const status = typeof state === "string" ? state : state?.status;
          if (!["done", "idle", "error"].includes(status)) {
            throw new CodexControlError(
              "TASK_HANDOFF_REQUIRED",
              "The task must be confirmed idle before continuing. Open it in Codex.",
              { taskId: target },
            );
          }
        }
        context = await this.readThreadContext(target);
        if (
          context.status === "active" ||
          context.status === "systemError" ||
          context.status === "unknown"
        ) {
          throw new CodexControlError(
            "TASK_BUSY",
            "This task needs attention in Codex before continuing.",
            { taskId: target },
          );
        }
      } else if (projectTaskId)
        context = await this.readThreadContext(projectTaskId);
      const cwd = await directory(context?.cwd || suppliedCwd);
      if (
        context &&
        suppliedCwd !== undefined &&
        (await directory(suppliedCwd)) !== cwd
      ) {
        throw new CodexControlError(
          "INVALID_DIRECTORY",
          "The selected project folder changed.",
        );
      }
      if (this.platform === "win32") {
        const readiness = await this.client.request("windowsSandbox/readiness");
        if (readiness?.status !== "ready") {
          throw new CodexControlError(
            "SANDBOX_SETUP_REQUIRED",
            "Open Codex to finish its Windows sandbox setup.",
          );
        }
      }
      const params = { approvalPolicy: "never", sandbox: "workspace-write" };
      const result = target
        ? await this.client.request("thread/resume", {
            threadId: target,
            ...params,
            excludeTurns: true,
          })
        : await this.client.request("thread/start", { cwd, ...params });
      id = threadId(result?.thread?.id);
      if (target && id !== target)
        throw new CodexControlError(
          "CODEX_PROTOCOL_ERROR",
          "Codex resumed a different task.",
        );
      if (result.thread.status?.type !== "idle") {
        throw new CodexControlError(
          "TASK_BUSY",
          "The task is not ready for another instruction.",
          { taskId: id },
        );
      }
      if (
        result.approvalPolicy !== "never" ||
        result.sandbox?.type !== "workspaceWrite" ||
        result.sandbox.networkAccess !== false
      ) {
        throw new CodexControlError(
          "UNSAFE_CONFIGURATION",
          "Codex could not apply Workroom’s restricted execution policy.",
          { taskId: id },
        );
      }
      if ((await directory(result.cwd || result.thread.cwd)) !== cwd) {
        throw new CodexControlError(
          "INVALID_DIRECTORY",
          "Codex returned a different working folder.",
          { taskId: id },
        );
      }
      this.owned.set(id, { turnId: null, status: "starting" });
      this.pendingStarts.add(id);
      const accepted = await this.client.request("turn/start", {
        threadId: id,
        input: [{ type: "text", text, text_elements: [] }],
        cwd,
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: [cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        },
      });
      const turnId = threadId(accepted?.turn?.id);
      const seen = this.owned.get(id);
      const status =
        seen?.turnId === turnId && TERMINAL.has(seen.status)
          ? seen.status
          : ["inProgress", "completed", "interrupted", "failed"].includes(
                accepted.turn.status,
              )
            ? accepted.turn.status
            : "inProgress";
      this.recordOwnedTurn(id, turnId, status);
      for (const item of Array.isArray(accepted.turn.items)
        ? accepted.turn.items
        : [])
        this.captureFinalReply(id, turnId, item);
      if (status === "completed") this.finishReply(id, turnId);
      this.owned.set(id, { turnId, status });
      const response = {
        taskId: id,
        turnId,
        status,
        url: "codex://threads/" + id,
        acceptedAt: iso(this.now()),
      };
      this.emit({ type: "instructionAccepted", ...response });
      return response;
    } catch (error) {
      const safe = controlError(error);
      if (id && !safe.taskId) safe.taskId = id;
      if (id && this.owned.get(id)?.status === "starting") {
        this.owned.set(id, {
          turnId: null,
          status: safe.outcomeUnknown ? "unknown" : "failed",
        });
      }
      if (safe.outcomeUnknown)
        this.emit({
          type: "handoff",
          taskId: id,
          reason: "send_outcome_unknown",
        });
      throw safe;
    } finally {
      this.locks.delete(lock);
      if (id) this.pendingStarts.delete(id);
    }
  }

  handleServerRequest(frame) {
    // No credentials, questions, commands, or approval payloads reach the UI.
    try {
      this.client.rejectServerRequest(frame.id);
    } catch {
      /* Connection already closed. */
    }
    const rawId = frame.params?.threadId || frame.params?.conversationId;
    const id = UUID.test(rawId || "") ? rawId : null;
    const rawTurn = frame.params?.turnId || this.owned.get(id)?.turnId;
    const turnId = UUID.test(rawTurn || "") ? rawTurn : null;
    const reason =
      frame.method === "item/tool/requestUserInput"
        ? "user_input_required"
        : /Approval|approval|permissions/.test(frame.method)
          ? "approval_required"
          : /AuthTokens|attestation/.test(frame.method)
            ? "authentication_required"
            : "unsupported_tool";
    this.emit({ type: "handoff", taskId: id, turnId, reason });
    if (id && turnId && this.owned.has(id)) {
      void this.client
        .request("turn/interrupt", { threadId: id, turnId })
        .catch(() => {});
    }
  }

  handleNotification(method, params) {
    if (method === "account/rateLimits/updated") {
      // This is a bucket update, not necessarily a full account snapshot.
      // Leave scheduled reads responsible for replacing the full usage view.
      return;
    }
    if (method === "account/updated") {
      this.account = null;
      this.usage = null;
      this.usageAttemptAt = -Infinity;
      return;
    }
    const id = params?.threadId;
    if (!UUID.test(id || "") || !this.owned.has(id)) return;
    if (method === "item/completed") {
      if (UUID.test(params.turnId || ""))
        this.captureFinalReply(id, params.turnId, params.item);
      return;
    }
    if (["turn/started", "turn/completed"].includes(method)) {
      const turn = params.turn;
      if (!UUID.test(turn?.id || "")) return;
      const key = id + ":" + turn.id;
      if (
        method === "turn/started" &&
        !this.pendingStarts.has(id) &&
        !this.ownedTurns.has(key)
      )
        return;
      if (method === "turn/completed" && !this.ownedTurns.has(key)) return;
      const status =
        method === "turn/started"
          ? "inProgress"
          : TERMINAL.has(turn.status)
            ? turn.status
            : "unknown";
      this.recordOwnedTurn(id, turn.id, status);
      if (status === "completed") this.finishReply(id, turn.id);
      else if (TERMINAL.has(status)) {
        this.pendingReplies.delete(key);
        this.completedReplies.delete(key);
      }
      if (method === "turn/started" || this.owned.get(id)?.turnId === turn.id) {
        this.owned.set(id, { turnId: turn.id, status });
      }
      this.emit({
        type: method === "turn/started" ? "turnStarted" : "turnCompleted",
        taskId: id,
        turnId: turn.id,
        status,
      });
      if (this.owned.size > 128) {
        for (const [key, value] of this.owned) {
          if (key !== id && TERMINAL.has(value.status)) {
            this.owned.delete(key);
            break;
          }
        }
      }
    }
  }

  recordOwnedTurn(taskId, turnId, status) {
    const key = taskId + ":" + turnId;
    this.ownedTurns.set(key, { taskId, turnId, status });
    while (this.ownedTurns.size > 256)
      this.ownedTurns.delete(this.ownedTurns.keys().next().value);
  }

  captureFinalReply(taskId, turnId, item) {
    const key = taskId + ":" + turnId;
    const owned = this.ownedTurns.get(key);
    if (!owned || ["failed", "interrupted"].includes(owned.status)) return;
    if (
      item?.type !== "agentMessage" ||
      !["final_answer", "final"].includes(item.phase) ||
      typeof item.text !== "string" ||
      !item.text
    )
      return;
    const bytes = Buffer.from(item.text, "utf8");
    const text = new TextDecoder("utf-8").decode(
      bytes.subarray(0, MAX_REPLY_BYTES),
      { stream: true },
    );
    const reply = {
      status: "available",
      taskId,
      turnId,
      text,
      truncated: Buffer.byteLength(text, "utf8") < bytes.length,
      totalBytes: bytes.length,
    };
    this.pendingReplies.delete(key);
    this.pendingReplies.set(key, reply);
    while (this.pendingReplies.size > MAX_CACHED_REPLIES)
      this.pendingReplies.delete(this.pendingReplies.keys().next().value);
    if (owned.status === "completed") this.finishReply(taskId, turnId);
  }

  finishReply(taskId, turnId) {
    const key = taskId + ":" + turnId;
    if (this.ownedTurns.get(key)?.status !== "completed") return;
    const reply = this.pendingReplies.get(key);
    if (!reply) return;
    this.pendingReplies.delete(key);
    this.completedReplies.delete(key);
    this.completedReplies.set(key, reply);
    while (this.completedReplies.size > MAX_CACHED_REPLIES)
      this.completedReplies.delete(this.completedReplies.keys().next().value);
  }

  getReply(taskId, options = {}) {
    const turnId = options?.turnId;
    if (!UUID.test(taskId || "") || !UUID.test(turnId || "")) {
      return {
        status: "unavailable",
        taskId: null,
        turnId: null,
        reason: "exact_turn_required",
      };
    }
    const unavailable = (reason) => ({
      status: "unavailable",
      taskId,
      turnId,
      reason,
    });
    if (this.closed) return unavailable("closed");
    const key = taskId + ":" + turnId;
    const reply = this.completedReplies.get(key);
    if (reply) return { ...reply };
    const owned = this.ownedTurns.get(key);
    return unavailable(
      !owned
        ? "turn_not_owned"
        : owned.status !== "completed"
          ? "not_completed"
          : "reply_missing",
    );
  }

  getState() {
    return {
      connected: this.client.ready,
      closed: this.closed,
      policy: { ...CONTROL_POLICY },
      running: [...this.owned]
        .filter(([, value]) => !TERMINAL.has(value.status))
        .map(([taskId, value]) => ({ taskId, ...value })),
      events: structuredClone(this.events),
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const active = this.client.ready
      ? [...this.owned].filter(
          ([, value]) => value.turnId && !TERMINAL.has(value.status),
        )
      : [];
    await Promise.allSettled(
      active.map(([id, value]) =>
        this.client.request("turn/interrupt", {
          threadId: id,
          turnId: value.turnId,
        }),
      ),
    );
    await this.client.close();
    this.pendingReplies.clear();
    this.completedReplies.clear();
    this.ownedTurns.clear();
  }
}

export const createCodexControl = (options) => new CodexControl(options);
let defaultControl;
const sharedControl = () => (defaultControl ||= createCodexControl());
export const getAccountUsage = () => sharedControl().getAccountUsage();
export const readThreadContext = (id) => sharedControl().readThreadContext(id);
export const sendInstruction = (input) =>
  sharedControl().sendInstruction(input);
export const getReply = (taskId, options) =>
  sharedControl().getReply(taskId, options);
export const closeCodexControl = () => defaultControl?.close();
