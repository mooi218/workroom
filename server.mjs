import http from "node:http";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { randomBytes, timingSafeEqual, randomUUID, createHash } from "node:crypto";
import { demoSnapshot } from "./lib/demo.mjs";
import { DEFAULT_ROLES } from "./lib/roles.mjs";
import { CloudStore } from "./lib/cloud-store.mjs";
import { spawn } from "node:child_process";
import { SOUND_TRACKS } from "./public/sound-catalog.js";
import { createCodexControl } from "./lib/codex-control.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
export async function createWorkroom({
  port = 4318,
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  dataDir = path.join(process.cwd(), ".workroom"),
  soundDir = path.join(dataDir, "sounds"),
  demo = false,
  source: providedSource,
  control: providedControl,
} = {}) {
  await mkdir(dataDir, { recursive: true });
  const soundFiles = new Map();
  const availableSounds = [];
  for (const [name, track] of Object.entries(SOUND_TRACKS)) {
    const file = path.join(soundDir, track.file);
    try {
      await access(file);
      soundFiles.set(`/sounds/${track.file}`, file);
      availableSounds.push(name);
    } catch {}
  }
  let pairToken;
  try {
    pairToken = (
      await readFile(path.join(dataDir, "pair-code"), "utf8")
    ).trim();
  } catch {}
  if (!/^[a-f0-9]{64}$/.test(pairToken || "")) {
    pairToken = randomBytes(32).toString("hex");
    await writeFile(path.join(dataDir, "pair-code"), pairToken, {
      mode: 0o600,
    });
  }
  let source = providedSource;
  if (!demo && !source) {
    try {
      const { createCodexSource } = await import("./lib/codex-source.mjs");
      source = createCodexSource({ codexHome });
    } catch {
      source = {
        snapshot: async () => ({
          tasks: [],
          health: {
            status: "unavailable",
            message: "Codexの作業記録に接続できません。",
          },
        }),
      };
    }
  }
  const cloud = new CloudStore();
  let snapshot = {
    tasks: [],
    roles: DEFAULT_ROLES,
    health: { status: "loading" },
    cloud: { status: "disconnected", taskCount: 0 },
    demo,
  };
  const clients = new Set();
  let control = providedControl;
  const instructionRequests = new Map(), ownedTasks = new Map();
  const controlStatus = value => value === "completed" ? "done" : value === "failed" ? "error" : value === "interrupted" ? "idle" : ["inProgress", "starting"].includes(value) ? "working" : "unknown";
  function ensureControl() {
    return control ??= createCodexControl({ codexHome,
      getTaskState: id => snapshot.tasks.find(task => task.id === id)?.status,
      onEvent: event => {
        const task = ownedTasks.get(event.taskId);
        if (task && (!task.turnId || task.turnId === event.turnId)) {
          if (event.status) task.status = controlStatus(event.status);
          else if (event.type === "handoff") task.status = "unknown";
          task.updatedAt = task.observedAt = new Date().toISOString();
        }
      },
    });
  }
  function mergeOwned(localTasks) {
    const result = new Map(localTasks.map(task => [task.id, task]));
    for (const [id, own] of ownedTasks) {
      const local = result.get(id);
      if (local?.turnId === own.turnId) own.sourceCaught = true;
      if (own.sourceCaught && local?.turnId && local.turnId !== own.turnId) { ownedTasks.delete(id); continue; }
      const { sourceCaught, ...metadata } = own;
      result.set(id, { ...local, ...metadata });
    }
    return [...result.values()];
  }
  let busy = false,
    closed = false;
  async function refresh() {
    if (busy || closed) return;
    busy = true;
    try {
      const local = demo ? demoSnapshot() : await source.snapshot(),
        remote = demo
          ? { tasks: [], health: { status: "demo", taskCount: 0 } }
          : cloud.snapshot();
      snapshot = {
        tasks: [...mergeOwned(local.tasks), ...remote.tasks],
        roles: DEFAULT_ROLES,
        health: local.health,
        cloud: remote.health,
        updatedAt: new Date().toISOString(),
        demo,
      };
    } catch {
      snapshot = {
        ...snapshot,
        updatedAt: new Date().toISOString(),
        health: {
          status: "unavailable",
          message: "状態を取得できません。再接続を待っています。",
        },
        tasks: snapshot.tasks.map((task) => ({ ...task, status: "unknown" })),
      };
    } finally {
      busy = false;
    }
    const currentControl = control?.getState?.();
    snapshot.control = currentControl ? {
      running: currentControl.running,
      handoffs: (currentControl.events || []).filter(event => event.type === "handoff" && snapshot.tasks.find(task => task.id === event.taskId)?.status !== "done").slice(-5),
    } : { running: [], handoffs: [] };
    const encoded = `data: ${JSON.stringify(snapshot)}\n\n`;
    for (const client of clients) {
      if (client.writableLength > 1024 * 1024) {
        client.destroy();
        clients.delete(client);
      } else client.write(encoded);
    }
  }
  await refresh();
  const interval = setInterval(refresh, 2500);
  interval.unref();
  const allowedHost = (host) =>
    ["127.0.0.1", "localhost"].some(
      (h) => host === `${h}:${server.address()?.port}`,
    );
  const send = (res, status, value) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
    });
    res.end(JSON.stringify(value));
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; media-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    if (!allowedHost(req.headers.host))
      return send(res, 403, { error: "Invalid host" });
    const origin = req.headers.origin;
    const sameOrigin = !origin || origin === `http://${req.headers.host}`;
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch {
      return send(res, 400, { error: "Invalid URL" });
    }
    if (url.pathname === "/api/cloud") {
      const extensionOrigin =
        origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
      if (origin && !extensionOrigin && !sameOrigin)
        return send(res, 403, { error: "Invalid origin" });
      if (extensionOrigin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type",
        );
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
      if (req.method !== "POST")
        return send(res, 405, { error: "POST required" });
      const candidate = String(req.headers.authorization || "").replace(
        /^Bearer /,
        "",
      );
      if (
        !/^[a-f0-9]{64}$/.test(candidate) ||
        !timingSafeEqual(Buffer.from(candidate), Buffer.from(pairToken))
      )
        return send(res, 401, { error: "Invalid pairing code" });
      if (
        !String(req.headers["content-type"] || "").startsWith(
          "application/json",
        )
      )
        return send(res, 415, { error: "JSON required" });
      let bytes = 0,
        body = "";
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            send(res, 413, { error: "Too large" });
            req.destroy();
            return;
          }
          body += chunk.toString();
        }
        cloud.ingest(JSON.parse(body));
        await refresh();
        return send(res, 200, { ok: true });
      } catch {
        return send(res, 400, { error: "Invalid snapshot" });
      }
    }
    if (!sameOrigin || req.headers["sec-fetch-site"] === "cross-site")
      return send(res, 403, { error: "Same origin required" });
    if (url.pathname === "/api/instructions") {
      if (demo) return send(res, 403, { error: "demo" });
      if (req.method !== "POST") return send(res, 405, { error: "POST required" });
      if (origin !== `http://${req.headers.host}` || req.headers["x-workroom-action"] !== "instruction")
        return send(res, 403, { error: "Explicit same-origin action required" });
      if (!String(req.headers["content-type"] || "").startsWith("application/json")) return send(res, 415, { error: "JSON required" });
      let input, bytes = 0;
      const body = [];
      try {
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 40 * 1024) { send(res, 413, { error: "too_large" }); req.destroy(); return; }
          body.push(chunk);
        }
        input = JSON.parse(Buffer.concat(body).toString("utf8"));
      } catch { return send(res, 400, { error: "invalid" }); }
      if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["text", "taskId", "projectTaskId", "requestId"].includes(key)) || typeof input.text !== "string" || !input.text.trim() || input.text.length > 8000 || Buffer.byteLength(input.text, "utf8") > 32768 || input.text.includes("\0") || typeof input.requestId !== "string" || !/^[a-f0-9-]{36}$/i.test(input.requestId))
        return send(res, 400, { error: "invalid" });
      const fingerprint = createHash("sha256").update(JSON.stringify([input.text, input.taskId, input.projectTaskId])).digest("hex");
      const existing = instructionRequests.get(input.requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) return send(res, 409, { error: "request_mismatch" });
        const saved = await existing.result; return send(res, saved.status, saved.body);
      }
      const target = input.taskId ? snapshot.tasks.find(task => task.id === input.taskId && task.source === "codex") : null;
      const projectTask = input.projectTaskId ? snapshot.tasks.find(task => task.id === input.projectTaskId && task.source === "codex") : null;
      if ((input.taskId && !target) || (input.projectTaskId && !projectTask) || (input.taskId && input.projectTaskId)) return send(res, 400, { error: "invalid_task" });
      if (target && !["done", "idle", "error"].includes(target.status)) return send(res, 409, { error: "busy" });
      if (instructionRequests.size >= 256) return send(res, 429, { error: "session_limit" });
      const result = (async () => {
        try {
          const params = { text: input.text.trim() };
          if (target) params.taskId = target.id;
          else if (projectTask) params.projectTaskId = projectTask.id;
          else {
            params.cwd = path.join(dataDir, "jobs", randomUUID());
            await mkdir(params.cwd, { recursive: true });
          }
          const accepted = await ensureControl().sendInstruction(params);
          const baseTask = target || projectTask;
          ownedTasks.set(accepted.taskId, {
            id: accepted.taskId, turnId: accepted.turnId, source: "codex",
            title: target?.title || params.text.split(/\r?\n/)[0].slice(0, 120),
            status: controlStatus(accepted.status),
            projectKey: baseTask?.projectKey || `workroom:${accepted.taskId}`,
            projectName: baseTask?.projectName || params.text.split(/\r?\n/)[0].slice(0, 80),
            projectKind: baseTask?.projectKind || "task-group",
            updatedAt: accepted.acceptedAt, observedAt: accepted.acceptedAt,
          });
          if (ownedTasks.size > 128) for (const [key, value] of ownedTasks) if (key !== accepted.taskId && value.status !== "working") { ownedTasks.delete(key); break; }
          return { status: 200, body: accepted };
        } catch (error) {
          return { status: ["TASK_BUSY", "TASK_HANDOFF_REQUIRED"].includes(error.code) ? 409 : 503,
            body: { error: ["TASK_BUSY", "TASK_HANDOFF_REQUIRED"].includes(error.code) ? "busy" : error.outcomeUnknown ? "outcome_unknown" : "unavailable", code: error.code || "CODEX_UNAVAILABLE" } };
        }
      })();
      instructionRequests.set(input.requestId, { fingerprint, result });
      const outcome = await result;
      if (outcome.status !== 200 && outcome.body.error !== "outcome_unknown") instructionRequests.delete(input.requestId);
      return send(res, outcome.status, outcome.body);
    }
    if (req.method !== "GET") return send(res, 405, { error: "GET required" });
    if (url.pathname === "/api/usage") {
      if (demo) return send(res, 200, { status: "demo", windows: [] });
      try { return send(res, 200, await ensureControl().getAccountUsage()); }
      catch { return send(res, 503, { status: "unavailable", windows: [] }); }
    }
    if (url.pathname === "/sound-manifest.json")
      return send(res, 200, { available: availableSounds });
    if (soundFiles.has(url.pathname)) {
      try {
        const data = await readFile(soundFiles.get(url.pathname));
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=3600" });
        return res.end(data);
      } catch { return send(res, 404, { error: "Sound unavailable" }); }
    }
    if (url.pathname === "/api/state") return send(res, 200, snapshot);
    if (url.pathname === "/api/reply") {
      const taskId = url.searchParams.get("taskId"), turnId = url.searchParams.get("turnId");
      if (![taskId, turnId].every(value => typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value)))
        return send(res, 400, { status: "unavailable", reason: "exact_turn_required" });
      try {
        const reply = source?.getReply ? await source.getReply(taskId, { turnId }) : { status: "unsupported" };
        if (reply.status === "available") return send(res, 200, reply);
        const owned = await control?.getReply?.(taskId, { turnId });
        return send(res, 200, owned?.status === "available" ? owned : reply);
      }
      catch { return send(res, 500, { status: "error", reason: "read_failed" }); }
    }
    if (url.pathname === "/api/demo")
      return send(res, 200, {
        ...demoSnapshot(),
        roles: DEFAULT_ROLES,
        cloud: { status: "demo" },
        demo: true,
        updatedAt: new Date().toISOString(),
      });
    if (url.pathname === "/api/pair")
      return send(res, 200, {
        token: pairToken,
        endpoint: `http://127.0.0.1:${server.address().port}`,
      });
    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const assets = {
      "/": "public/index.html",
      "/index.html": "public/index.html",
      "/app.js": "public/app.js",
      "/office.js": "public/office.js",
      "/sound.js": "public/sound.js",
      "/sound-catalog.js": "public/sound-catalog.js",
      "/features-i18n.js": "public/features-i18n.js",
      "/controls.js": "public/controls.js",
      "/connection-guide.js": "public/connection-guide.js",
      "/connection-guide.css": "public/connection-guide.css",
      "/projects.js": "public/projects.js",
      "/delivery.js": "public/delivery.js",
      "/focus.js": "public/focus.js",
      "/studio.css": "public/studio.css",
      "/delivery.css": "public/delivery.css",
      "/pixel-ui.css": "public/pixel-ui.css",
      "/i18n.js": "public/i18n.js",
      "/style.css": "public/style.css",
      "/favicon.svg": "public/favicon.svg",
      "/roles.mjs": "lib/roles.mjs",
    };
    for (const name of [
      "people-coarse.png",
      "people-actions-coarse.png",
      "furniture-coarse-1.png",
      "furniture-coarse-2.png",
      "furniture-coarse-3.png",
      "furniture-coarse-4.png",
      "skyline.svg",
      "frame-light.svg",
      "frame-dark.svg",
      "fonts/pixelify-sans.woff2",
      "fonts/ibm-plex-sans.woff2",
      "fonts/noto-sans-jp.woff2",
    ])
      assets[`/assets/${name}`] = `public/assets/${name}`;
    if (!assets[url.pathname]) return send(res, 404, { error: "Not found" });
    try {
      const data = await readFile(path.join(ROOT, assets[url.pathname]));
      if ([".woff2", ".png"].includes(path.extname(assets[url.pathname])))
        res.setHeader("Cache-Control", "public, max-age=86400");
      res.writeHead(200, {
        "Content-Type": mime[path.extname(assets[url.pathname])],
      });
      res.end(data);
    } catch {
      return send(res, 404, { error: "Not found" });
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    server,
    refresh,
    port: server.address().port,
    close: async () => {
      closed = true;
      clearInterval(interval);
      for (const client of clients) client.end();
      source?.close?.();
      await control?.close?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2),
    value = (name, fallback) =>
      args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const port = Number(value("--port", process.env.WORKROOM_PORT || 4318));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid port");
  const app = await createWorkroom({
    port,
    dataDir: path.resolve(
      value("--data-dir", path.join(process.cwd(), ".workroom")),
    ),
    codexHome: value(
      "--codex-home",
      process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    ),
    demo: args.includes("--demo"),
  });
  console.log(`Workroom: http://127.0.0.1:${app.port}\nPress Ctrl+C to stop.`);
  if (args.includes("--open")) {
    const address = `http://127.0.0.1:${app.port}`;
    const command =
      process.platform === "win32"
        ? "cmd.exe"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open";
    const commandArgs =
      process.platform === "win32"
        ? ["/d", "/c", "start", "", address]
        : [address];
    const browserProcess = spawn(command, commandArgs, {
      windowsHide: true,
      stdio: "ignore",
    });
    browserProcess.on("error", () =>
      console.log(`Open ${address} in your browser.`),
    );
    browserProcess.unref();
  }
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await app.close();
      process.exit(0);
    });
}
