import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tempClaudeDir, get, readStream, PROJECT, SESSION } from "./helpers.js";

const dir = tempClaudeDir();
process.env.CLAUDE_CONFIG_DIR = dir;
const { startServer } = await import("../src/server/server.js");
const { createRedactor, personalRules } = await import("../src/server/redact.js");

let app;
let cookie;
let handle;
before(async () => {
  app = await startServer({ port: 0, redact: createRedactor(personalRules("C:\\Users\\demo", "demo")) });
  const res = await get(app.port, `/?k=${app.secret}`);
  cookie = res.headers["set-cookie"][0].split(";")[0];
  handle = JSON.parse((await get(app.port, "/api/sessions", { cookie })).body).sessions[0].project;
});
after(async () => {
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("listens on 127.0.0.1 only", () => {
  assert.equal(app.server.address().address, "127.0.0.1");
  assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+\/\?k=[0-9a-f]{64}$/);
});

test("every response carries the security headers", async () => {
  for (const p of ["/", "/nope", `/?k=${app.secret}`]) {
    const res = await get(app.port, p);
    assert.match(res.headers["content-security-policy"], /default-src 'none'/);
    assert.match(res.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  }
});

test("without the secret, nothing is served", async () => {
  for (const p of ["/", "/api/sessions", `/api/stream?project=${handle}&session=${SESSION}`, "/static/app.js", "/core/model.js"]) {
    const res = await get(app.port, p);
    assert.equal(res.status, 401, p);
    assert.doesNotMatch(res.body, /checkout/i);
  }
  const wrong = await get(app.port, `/?k=${"0".repeat(64)}`);
  assert.equal(wrong.status, 403);
  const forged = await get(app.port, "/api/sessions", { cookie: `agent_replay_${app.port}=${"a".repeat(64)}` });
  assert.equal(forged.status, 401);
});

test("the private link sets a strict, HttpOnly session cookie and leaves the address", async () => {
  const res = await get(app.port, `/?k=${app.secret}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, "/");
  const c = res.headers["set-cookie"][0];
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.doesNotMatch(c, /Expires|Max-Age/i);
});

test("refuses other hosts (DNS rebinding), other origins and cross-site requests", async () => {
  const evilHost = await get(app.port, "/api/sessions", { cookie, host: `evil.example:${app.port}` });
  assert.equal(evilHost.status, 403);
  const evilOrigin = await get(app.port, "/api/sessions", { cookie, origin: "http://evil.example" });
  assert.equal(evilOrigin.status, 403);
  const crossSite = await get(app.port, "/api/sessions", { cookie, "sec-fetch-site": "cross-site" });
  assert.equal(crossSite.status, 403);
  const ok = await get(app.port, "/api/sessions", { cookie, origin: `http://127.0.0.1:${app.port}`, "sec-fetch-site": "same-origin" });
  assert.equal(ok.status, 200);
});

test("only GET and HEAD", async () => {
  for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
    const res = await get(app.port, "/api/sessions", { cookie }, m);
    assert.equal(res.status, 405, m);
  }
});

test("lists sessions with private details hidden", async () => {
  const res = await get(app.port, "/api/sessions", { cookie });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.masked, true);
  const s = body.sessions.find((x) => x.sessionId === SESSION);
  assert.ok(s);
  assert.equal(s.title, "Fix the checkout total");
  assert.equal(s.folder, "~\\shop");
  assert.doesNotMatch(res.body, /demo/i);
});

test("refuses path tricks in session ids", async () => {
  const bad = [
    ["..", SESSION], ["../..", SESSION], [`${PROJECT}/..`, SESSION], ["C:\\Windows", SESSION], ["/etc", "passwd"],
    [PROJECT, "../../../secret"], [PROJECT, "..%2f..%2fx"], [PROJECT, `${SESSION}/../x`], [PROJECT, ""], ["", SESSION],
    [PROJECT, "a".repeat(200)], ["nope", SESSION], [PROJECT, SESSION],
    [handle, "../../../secret"], [handle, `${SESSION}/../x`], [handle, ""], [handle.toUpperCase(), SESSION], [`${handle}/..`, SESSION],
  ];
  for (const [p, s] of bad) {
    const res = await get(app.port, `/api/stream?project=${encodeURIComponent(p)}&session=${encodeURIComponent(s)}`, { cookie });
    assert.equal(res.status, 400, `${p} / ${s}`);
  }
  const raw = await get(app.port, "/static/../src/server/server.js", { cookie });
  assert.equal(raw.status, 404);
  const enc = await get(app.port, "/static/%2e%2e/%2e%2e/package.json", { cookie });
  assert.equal(enc.status, 404);
});

test("serves the page's own files only", async () => {
  assert.equal((await get(app.port, "/", { cookie })).status, 200);
  assert.equal((await get(app.port, "/core/model.js", { cookie })).status, 200);
  assert.equal((await get(app.port, "/package.json", { cookie })).status, 404);
});

test("streams a session: slimmed, masked, with helpers", async () => {
  const res = await readStream(app.port, `/api/stream?project=${handle}&session=${SESSION}`, { cookie }, (ev) => ev.some((e) => e.event === "ready"));
  assert.equal(res.status, 200);
  const agent = res.events.find((e) => e.event === "agent");
  assert.equal(agent.data.id, "a1b2c3");
  assert.equal(agent.data.meta.agentType, "code-reviewer");
  const main = res.events.filter((e) => e.event === "records" && e.data.source === null).flatMap((e) => e.data.records);
  const helper = res.events.filter((e) => e.event === "records" && e.data.source === "a1b2c3").flatMap((e) => e.data.records);
  assert.ok(main.length >= 20);
  assert.equal(helper.length, 4);
  // secrets and personal details never leave the server
  assert.doesNotMatch(res.raw, /sk-ant-api03/);
  assert.doesNotMatch(res.raw, /demo@example\.com/);
  assert.doesNotMatch(res.raw, /supersecretvalue123/);
  assert.doesNotMatch(res.raw, /Users\\\\demo/);
  // Claude's private thinking and signatures are dropped
  assert.doesNotMatch(res.raw, /secret thoughts/);
  assert.doesNotMatch(res.raw, /"signature"/);
});

test("reveal=1 shows the original text when asked", async () => {
  const res = await readStream(app.port, `/api/stream?project=${handle}&session=${SESSION}&reveal=1`, { cookie }, (ev) => ev.some((e) => e.event === "ready"));
  assert.match(res.raw, /sk-ant-api03/);
  assert.doesNotMatch(res.raw, /secret thoughts/); // thinking is never sent
});

test("sends new lines as they are written (live)", async () => {
  const file = path.join(dir, "projects", PROJECT, `${SESSION}.jsonl`);
  const line = JSON.stringify({ type: "user", timestamp: "2026-11-01T10:10:00.000Z", message: { role: "user", content: "One more thing: live update" } });
  let appended = false;
  const res = await readStream(app.port, `/api/stream?project=${handle}&session=${SESSION}`, { cookie }, (ev) => {
    if (!appended && ev.some((e) => e.event === "ready")) {
      appended = true;
      fs.appendFileSync(file, `${line}\n`);
    }
    return ev.some((e) => e.event === "records" && e.data.records.some((r) => r.message?.content === "One more thing: live update"));
  });
  assert.ok(!res.timedOut, "live line arrived");
});

test("overview: needs the key, streams progress, and masks private info", async () => {
  const denied = await get(app.port, "/api/overview");
  assert.equal(denied.status, 401);
  const res = await readStream(app.port, "/api/overview", { cookie }, (ev) => ev.some((e) => e.event === "overview"));
  assert.ok(res.events.some((e) => e.event === "progress" && e.data.done === e.data.total));
  const body = res.events.find((e) => e.event === "overview").data;
  assert.equal(body.masked, true);
  assert.equal(body.sessions.length, 1);
  assert.equal(body.sessions[0].project, handle);
  assert.ok(body.sessions[0].tokens.total > 0);
  assert.doesNotMatch(res.raw, /demo/i);
  assert.doesNotMatch(res.raw, /sk-ant-api03|supersecretvalue123/);
});

test("sessions are grouped by repository, with names masked", async () => {
  const body = JSON.parse((await get(app.port, "/api/sessions", { cookie })).body);
  const s = body.sessions[0];
  assert.match(s.repo, /^[0-9a-f]{24}$/);
  assert.notEqual(s.repo, s.project);
  assert.equal(s.repoName, "shop");
  assert.equal(s.repoPath, "~\\shop");
  assert.equal(s.worktree, false);
});
