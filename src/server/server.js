// @ts-check
// The local web server. Listens on 127.0.0.1 only, answers GET requests only, and checks every request
// (host, origin, per-launch secret) before doing anything. Page files are loaded into memory at startup,
// so no request can ever name a file on disk.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SECURITY_HEADERS, createSecret, safeEqual, isAllowedHost, isAllowedOrigin, isAllowedFetchSite,
  cookieName, sessionCookie, readCookie,
} from "./security.js";
import { createRedactor } from "./redact.js";
import { resolveSession, listSessionFiles, realProjectsRoot } from "./paths.js";
import { readHeadTail, parseLines } from "./reader.js";
import { summarize, repoOf } from "../core/records.js";
import { streamSession } from "./stream.js";
import { createOverview } from "./overview.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "..", "..", "public");
const CORE_DIR = path.join(HERE, "..", "core");
const MAX_STREAMS = 8;
const LIVE_MS = 2 * 60_000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Reads the page's own files into memory: url path -> { body, type }. */
async function loadStatic() {
  /** @type {Map<string, { body: Buffer, type: string }>} */
  const files = new Map();
  const add = async (dir, prefix, depth) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory() && depth > 0) await add(abs, `${prefix}${e.name}/`, depth - 1);
      else if (e.isFile()) {
        const type = TYPES[path.extname(e.name)];
        if (type) files.set(`${prefix}${e.name}`, { body: await fs.readFile(abs), type });
      }
    }
  };
  await add(PUBLIC_DIR, "/static/", 2);
  await add(CORE_DIR, "/core/", 0);
  return files;
}

const LANDING = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>agent-replay</title></head>
<body><h1>agent-replay</h1><p>For your privacy this page needs the private link printed in the terminal where you
started agent-replay. Open that link (it starts with http://127.0.0.1) instead.</p></body></html>`;

/**
 * Starts the server.
 * @param {{ port?: number, tries?: number, redact?: (s: string) => string, quiet?: boolean }} [opts]
 */
export async function startServer(opts = {}) {
  const secret = createSecret();
  const redact = opts.redact ?? createRedactor();
  const files = await loadStatic();
  /** @type {Map<string, { key: string, value: object }>} */
  const listCache = new Map(); // in memory only, so the list doesn't re-read unchanged files
  let streams = 0;
  let port = 0;
  const overview = createOverview();

  // Claude Code names project folders after their full path ("C--Users-<you>-code-app"), which would leak your
  // user name. The page only ever sees an opaque handle that changes every launch.
  const handleOf = (projectName) => crypto.createHmac("sha256", secret).update(projectName).digest("hex").slice(0, 24);
  const projectFromHandle = async (handle) => {
    if (typeof handle !== "string" || !/^[0-9a-f]{24}$/.test(handle)) return null;
    const root = await realProjectsRoot();
    if (!root) return null;
    let names = [];
    try {
      names = await fs.readdir(root);
    } catch {
      return null;
    }
    return names.find((n) => safeEqual(handleOf(n), handle)) ?? null;
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "Something went wrong.");
      else res.end();
    });
  });
  // Slow or half-open connections can't pile up.
  server.headersTimeout = 10_000;
  server.requestTimeout = 0; // the live stream is long-lived; headersTimeout still guards slow clients
  server.maxHeadersCount = 50;

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handle(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

    if (!isAllowedHost(req.headers.host, port)) return send(res, 403, "Forbidden: agent-replay only answers on this computer.");
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    if (!isAllowedOrigin(origin, port) || !isAllowedFetchSite(typeof site === "string" ? site : undefined)) {
      return send(res, 403, "Forbidden: request from another website.");
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return send(res, 405, "Method not allowed.");
    }
    let url;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      return send(res, 400, "Bad request.");
    }

    // The private link: swap the secret in the address for a cookie, then drop it from the address bar.
    if (url.pathname === "/" && url.searchParams.has("k")) {
      if (!safeEqual(url.searchParams.get("k") ?? "", secret)) return send(res, 403, "This link is out of date. Use the link printed in the terminal.");
      res.setHeader("Set-Cookie", sessionCookie(port, secret));
      res.setHeader("Location", "/");
      return send(res, 302, "");
    }

    const authed = safeEqual(readCookie(req.headers.cookie, cookieName(port)) ?? "", secret);
    if (!authed) {
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      return void res.end(LANDING);
    }

    const reveal = url.searchParams.get("reveal") === "1";
    if (url.pathname === "/") return serveFile(res, files.get("/static/index.html"));
    if (url.pathname.startsWith("/static/") || url.pathname.startsWith("/core/")) return serveFile(res, files.get(url.pathname));
    if (url.pathname === "/api/sessions") return sendJson(res, await listSessions(reveal ? null : redact));
    if (url.pathname === "/api/overview") {
      if (streams >= MAX_STREAMS) return send(res, 429, "Too many open views. Close a tab and try again.");
      streams++;
      req.on("close", () => streams--);
      return overview.stream(req, res, handleOf, reveal ? null : redact);
    }
    if (url.pathname === "/api/stream") {
      const project = await projectFromHandle(url.searchParams.get("project"));
      const session = project ? await resolveSession(project, url.searchParams.get("session")) : null;
      if (!session) return send(res, 400, "Unknown session.");
      if (streams >= MAX_STREAMS) return send(res, 429, "Too many open views. Close a tab and try again.");
      streams++;
      req.on("close", () => streams--);
      return streamSession(req, res, session, reveal ? null : redact);
    }
    return send(res, 404, "Not found.");
  }

  /** @param {((s: string) => string) | null} mask */
  async function listSessions(mask) {
    const m = mask ?? ((s) => s);
    const now = Date.now();
    const out = [];
    for (const f of await listSessionFiles(500)) {
      const key = `${f.mtimeMs}:${f.size}`;
      let cached = listCache.get(f.file);
      if (!cached || cached.key !== key) {
        try {
          const { head, tail } = await readHeadTail(f.file);
          const s = summarize([...parseLines(head), ...parseLines(tail)]);
          cached = { key, value: s };
          listCache.set(f.file, cached);
        } catch {
          continue;
        }
      }
      const s = /** @type {ReturnType<typeof summarize>} */ (cached.value);
      const repo = repoOf(s.cwd);
      out.push({
        project: handleOf(f.projectId),
        repo: repo ? handleOf(`repo:${repo.key}`) : handleOf(`project:${f.projectId}`),
        repoName: repo ? m(repo.name) : "(unknown folder)",
        repoPath: repo ? m(repo.root) : "",
        worktree: repo?.worktree ?? false,
        sessionId: f.sessionId,
        title: m(clip(s.title ?? "(no message yet)", 160)),
        folder: s.cwd ? m(s.cwd) : "(unknown folder)",
        branch: s.gitBranch ? m(s.gitBranch) : undefined,
        models: s.models,
        lastActive: f.mtimeMs,
        live: now - f.mtimeMs < LIVE_MS,
      });
    }
    return { sessions: out, masked: !!mask };
  }

  await new Promise((resolve, reject) => {
    let attempt = 0;
    const first = opts.port ?? 4848;
    const tries = opts.tries ?? 10;
    const onError = (err) => {
      if (err.code === "EADDRINUSE" && first !== 0 && ++attempt < tries) return server.listen(first + attempt, "127.0.0.1");
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(undefined);
    };
    server.on("error", onError);
    server.once("listening", onListening);
    server.listen(first, "127.0.0.1"); // 127.0.0.1 only: never reachable from the network
  });
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;

  return {
    server,
    port,
    secret,
    url: `http://127.0.0.1:${port}/?k=${secret}`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r(undefined)); }),
  };
}

/** @param {http.ServerResponse} res */
function send(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

/** @param {http.ServerResponse} res */
function sendJson(res, value) {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

/** @param {http.ServerResponse} res @param {{ body: Buffer, type: string } | undefined} file */
function serveFile(res, file) {
  if (!file) return send(res, 404, "Not found.");
  res.writeHead(200, { "Content-Type": file.type, "Content-Length": file.body.length });
  res.end(file.body);
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
