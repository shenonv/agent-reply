// Test helpers (not a test file itself). Uses node:http directly so tests can send any Host/Origin header.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "claude");
export const PROJECT = "C--Users-demo-shop";
export const SESSION = "11111111-2222-3333-4444-555555555555";

/** Copies the fixture logs to a temp folder so tests can append to them without touching the repo. */
export function tempClaudeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-replay-test-"));
  fs.cpSync(FIXTURES, dir, { recursive: true });
  return dir;
}

/** Reads the fixture records (main log or a helper log). */
export function fixtureRecords(rel) {
  return fs.readFileSync(path.join(FIXTURES, "projects", PROJECT, rel), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** GET with full control of headers. Resolves with status, headers and body text. */
export function get(port, pathname, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: pathname, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Opens an SSE stream and collects events until `until(events)` is true or the timeout passes. */
export function readStream(port, pathname, headers, until, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const events = [];
    let raw = "";
    const req = http.request({ host: "127.0.0.1", port, path: pathname, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return resolve({ status: res.statusCode, events, raw });
      }
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        raw += chunk;
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : null });
        }
        if (until(events)) {
          req.destroy();
          resolve({ status: 200, events, raw });
        }
      });
    });
    req.on("error", (e) => (e.code === "ECONNRESET" ? undefined : reject(e)));
    setTimeout(() => {
      req.destroy();
      resolve({ status: 200, events, raw, timedOut: true });
    }, timeout);
    req.end();
  });
}
