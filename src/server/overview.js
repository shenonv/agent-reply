// @ts-check
// Summaries of every session for the Overview page. Each log is read once and summarised; the summary is kept in
// memory (never on disk) and re-made only when its files change. Progress is streamed so big histories don't sit
// behind a blank page. Summaries are masked on the way out, unless the page asked to reveal.
import fsp from "node:fs/promises";
import { setImmediate as nextTick } from "node:timers/promises";
import { listSessionFiles, resolveSession, listAgentFiles } from "./paths.js";
import { JsonlTail } from "./reader.js";
import { slimRecord, slimAgentMeta } from "./slim.js";
import { redactDeep } from "./redact.js";
import { createModel, addRecords, addAgentMeta } from "../core/model.js";
import { summarizeSession } from "../core/overview.js";

const MAX_SESSION_BYTES = 200 * 1024 * 1024; // larger sessions are listed but not summarised
const MAX_META = 64 * 1024;

/** @typedef {{ key: string, summary: object | null }} CacheEntry */

export function createOverview() {
  /** @type {Map<string, CacheEntry>} file -> summary for a given file state */
  const cache = new Map();
  /** @type {Map<string, Promise<CacheEntry>>} builds in progress, shared between requests */
  const building = new Map();

  /** A fingerprint of the session's files: changes whenever Claude Code writes to any of them. */
  async function fingerprint(session, size, mtimeMs) {
    const agents = await listAgentFiles(session.root, session.subagentsDir);
    let total = size;
    const parts = [`${mtimeMs}:${size}`];
    for (const a of agents) {
      try {
        const st = await fsp.stat(a.file);
        total += st.size;
        parts.push(`${a.id}.${a.kind}:${st.mtimeMs}:${st.size}`);
      } catch {
        // removed while listing
      }
    }
    return { key: parts.join("|"), total, agents };
  }

  async function build(session, agents, total) {
    if (total > MAX_SESSION_BYTES) return null;
    const model = createModel();
    for (const a of agents) {
      if (a.kind !== "meta") continue;
      try {
        const st = await fsp.stat(a.file);
        if (st.size <= MAX_META) addAgentMeta(model, a.id, slimAgentMeta(JSON.parse(await fsp.readFile(a.file, "utf8"))));
      } catch {
        // half-written: skip
      }
    }
    const read = async (file) => (await new JsonlTail(file).read()).records.map(slimRecord).filter(Boolean);
    addRecords(model, null, await read(session.file));
    for (const a of agents) if (a.kind === "jsonl") addRecords(model, a.id, await read(a.file));
    return summarizeSession(model);
  }

  /** One session's summary, from memory when nothing changed. */
  async function summaryFor(f) {
    const session = await resolveSession(f.projectId, f.sessionId);
    if (!session) return null;
    const { key, total, agents } = await fingerprint(session, f.size, f.mtimeMs);
    const hit = cache.get(f.file);
    if (hit && hit.key === key) return hit;
    const pending = building.get(f.file);
    if (pending) return pending;
    const job = build(session, agents, total)
      .then((summary) => {
        const entry = { key, summary };
        cache.set(f.file, entry);
        return entry;
      })
      .catch(() => ({ key, summary: null }))
      .finally(() => building.delete(f.file));
    building.set(f.file, job);
    return job;
  }

  /**
   * Streams { done, total } progress, then every summary.
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   * @param {(projectFolderName: string) => string} handleOf
   * @param {((s: string) => string) | null} redact
   */
  async function stream(req, res, handleOf, redact) {
    let closed = false;
    req.on("close", () => (closed = true));
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (event, data) => {
      if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const files = await listSessionFiles(1000);
    const live = new Set(files.map((f) => f.file));
    for (const k of cache.keys()) if (!live.has(k)) cache.delete(k); // forget deleted sessions

    const out = [];
    let skipped = 0;
    let lastSent = 0;
    for (let i = 0; i < files.length && !closed; i++) {
      const f = files[i];
      const entry = await summaryFor(f);
      if (entry?.summary) {
        const s = { ...entry.summary, project: handleOf(f.projectId), sessionId: f.sessionId };
        out.push(redact ? redactDeep(s, redact) : s);
      } else skipped++;
      if (Date.now() - lastSent > 150 || i === files.length - 1) {
        send("progress", { done: i + 1, total: files.length });
        lastSent = Date.now();
      }
      await nextTick(); // let other requests run between sessions
    }
    send("overview", { sessions: out, skipped, masked: !!redact });
    if (!closed) res.end();
  }

  return { stream };
}
