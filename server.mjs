import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { demoSnapshot } from "./lib/demo.mjs";
import { DEFAULT_ROLES } from "./lib/roles.mjs";
import { CloudStore } from "./lib/cloud-store.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
export async function createWorkroom({
  port = 4318,
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  dataDir = path.join(process.cwd(), ".workroom"),
  demo = false,
  source: providedSource,
} = {}) {
  await mkdir(dataDir, { recursive: true });
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
        tasks: [...local.tasks, ...remote.tasks],
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
    if (req.method !== "GET") return send(res, 405, { error: "GET required" });
    if (url.pathname === "/api/state") return send(res, 200, snapshot);
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
      "/i18n.js": "public/i18n.js",
      "/style.css": "public/style.css",
      "/favicon.svg": "public/favicon.svg",
      "/roles.mjs": "lib/roles.mjs",
    };
    if (!assets[url.pathname]) return send(res, 404, { error: "Not found" });
    try {
      const data = await readFile(path.join(ROOT, assets[url.pathname]));
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
  console.log(
    `Workroom: http://127.0.0.1:${app.port}\nLocal-only. No model calls. Press Ctrl+C to stop.`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await app.close();
      process.exit(0);
    });
}
