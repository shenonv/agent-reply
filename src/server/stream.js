// @ts-check
// Server-Sent Events for one session: sends what's in the logs now, then keeps sending new lines as Claude
// Code writes them. Helper agents that start later are picked up too. Everything sent is slimmed and, unless
// the page asked otherwise, masked.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { JsonlTail } from "./reader.js";
import { listAgentFiles } from "./paths.js";
import { slimRecord, slimAgentMeta } from "./slim.js";
import { redactDeep } from "./redact.js";

const BATCH = 400; // records per event
const POLL_MS = 1000;
const HEARTBEAT_MS = 15_000;
const MAX_META = 64 * 1024;

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {{ root: string, file: string, subagentsDir: string }} session
 * @param {((s: string) => string) | null} redact null = show everything (the page asked to reveal)
 */
export async function streamSession(req, res, session, redact) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let closed = false;
  const send = (event, data) => {
    if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const prepare = (records) => {
    const out = [];
    for (const r of records) {
      const s = slimRecord(r);
      if (s) out.push(redact ? redactDeep(s, redact) : s);
    }
    return out;
  };
  const sendRecords = (source, records) => {
    const list = prepare(records);
    for (let i = 0; i < list.length; i += BATCH) send("records", { source, records: list.slice(i, i + BATCH) });
  };

  const main = new JsonlTail(session.file);
  /** @type {Map<string, JsonlTail>} */
  const agents = new Map();
  /** @type {Map<string, number>} */
  const metaSeen = new Map();

  const checkMain = async () => {
    const { records, reset } = await main.read();
    if (reset) send("reset", null);
    if (records.length) sendRecords(null, records);
  };
  const checkAgents = async (kinds) => {
    const files = await listAgentFiles(session.root, session.subagentsDir);
    for (const f of files) {
      if (!kinds.includes(f.kind)) continue;
      if (f.kind === "meta") {
        try {
          const st = await fsp.stat(f.file);
          if (st.size > MAX_META || metaSeen.get(f.id) === st.mtimeMs) continue;
          const meta = slimAgentMeta(JSON.parse(await fsp.readFile(f.file, "utf8")));
          metaSeen.set(f.id, st.mtimeMs);
          send("agent", { id: f.id, meta: redact ? redactDeep(meta, redact) : meta });
        } catch {
          // half-written: the next check reads it again
        }
      } else {
        let tail = agents.get(f.id);
        if (!tail) agents.set(f.id, (tail = new JsonlTail(f.file)));
        const { records } = await tail.read();
        if (records.length) sendRecords(f.id, records);
      }
    }
  };

  // One check at a time, so two triggers never read the same bytes twice.
  let queue = Promise.resolve();
  const check = () => {
    queue = queue
      .then(async () => {
        if (closed) return;
        await checkAgents(["meta"]);
        await checkMain();
        await checkAgents(["jsonl"]);
      })
      .catch(() => send("problem", "Couldn't read part of the log."));
    return queue;
  };

  await check(); // helpers' names first, then the main log, then the helpers' logs
  send("ready", null);

  /** @type {fs.FSWatcher | null} */
  let watcher = null;
  try {
    watcher = fs.watch(session.file, { persistent: false }, () => void check());
    watcher.on("error", () => {});
  } catch {
    // some file systems don't support watching: the poll below still works
  }
  const poll = setInterval(() => void check(), POLL_MS);
  const beat = setInterval(() => !closed && res.write(": ping\n\n"), HEARTBEAT_MS);

  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(beat);
    watcher?.close();
    res.end();
  };
  req.on("close", stop);
  res.on("error", stop);
}
