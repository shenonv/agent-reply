// Security rules checked on every test run. If one of these fails, the change that caused it is unsafe.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRedactor, personalRules, redactDeep, MASK } from "../src/server/redact.js";
import { safeEqual, isAllowedHost, isAllowedOrigin, readCookie } from "../src/server/security.js";
import { isSafeName, isInside } from "../src/server/paths.js";
import { slimRecord } from "../src/server/slim.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** All .js/.html/.css files under a folder, as [relative path, text]. */
function sources(rel) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(js|mjs|html|css)$/.test(e.name)) out.push([path.relative(ROOT, p), fs.readFileSync(p, "utf8")]);
    }
  };
  walk(path.join(ROOT, rel));
  return out;
}
const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1"); // ignore comments

test("no dependencies, no install scripts", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "bundledDependencies"]) {
    assert.equal(pkg[k], undefined, `${k} must stay empty`);
  }
  for (const s of ["preinstall", "install", "postinstall", "prepare", "prepack", "postpack"]) {
    assert.equal(pkg.scripts?.[s], undefined, `no ${s} script`);
  }
  assert.ok(Array.isArray(pkg.files), "publish an explicit file list");
});

test("page code never turns text into HTML or runs strings as code", () => {
  const banned = /\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\s*\(|setTimeout\s*\(\s*["'`]|setInterval\s*\(\s*["'`]|createContextualFragment|DOMParser|srcdoc/;
  for (const [file, code] of [...sources("public"), ...sources("src/core")]) {
    assert.doesNotMatch(strip(code), banned, file);
  }
});

test("page saves nothing in the browser", () => {
  const banned = /localStorage|sessionStorage|indexedDB|document\.cookie|caches\.open|serviceWorker/;
  for (const [file, code] of [...sources("public"), ...sources("src/core")]) assert.doesNotMatch(strip(code), banned, file);
});

test("page loads nothing from other sites and has no inline script or style", () => {
  for (const [file, code] of sources("public")) {
    // The SVG namespace is an identifier, not a download, so it's the one allowed address.
    const code2 = strip(code).replaceAll('"http://www.w3.org/2000/svg"', '""');
    assert.doesNotMatch(code2, /\b(?:https?:)?\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+\.[a-z]{2,}/i, file);
    if (file.endsWith(".html")) {
      assert.doesNotMatch(code, /<script(?![^>]*\bsrc=)[^>]*>/i, `${file}: inline script`);
      assert.doesNotMatch(code, /\sstyle=|<style/i, `${file}: inline style`);
      assert.doesNotMatch(code, /\son[a-z]+=/i, `${file}: inline event handler`);
    }
  }
});

test("server and CLI never make network requests", () => {
  const banned = /\bfetch\s*\(|XMLHttpRequest|WebSocket|node:(?:net|tls|https|dns|dgram|http2)\b|\bhttps?\.(?:request|get)\s*\(|require\(/;
  for (const [file, code] of [...sources("src"), ...sources("bin")]) assert.doesNotMatch(strip(code), banned, file);
});

test("server and CLI never write, move or delete files", () => {
  const ops = "writeFile|appendFile|createWriteStream|unlink|rmdir|rm|rename|mkdir|mkdtemp|copyFile|cp|truncate|ftruncate|chmod|lchmod|chown|lchown|symlink|link|utimes|futimes|lutimes|opendir";
  const call = new RegExp(`\\b(?:fs|fsp|promises)\\.(?:${ops})(?:Sync)?\\s*\\(`);
  const imported = new RegExp(`import\\s*\\{[^}]*\\b(?:${ops})(?:Sync)?\\b[^}]*\\}\\s*from\\s*["']node:fs`);
  const openForWrite = /\.open\s*\([^,)]*,\s*["'](?!r["'])/;
  for (const [file, code] of [...sources("src"), ...sources("bin")]) {
    const c = strip(code);
    assert.doesNotMatch(c, call, file);
    assert.doesNotMatch(c, imported, file);
    assert.doesNotMatch(c, openForWrite, file);
  }
});

test("only the CLI may start a process, and never through a shell", () => {
  for (const [file, code] of sources("src")) assert.doesNotMatch(strip(code), /child_process|\bspawn\s*\(|(?<![.\w])exec(?:File)?(?:Sync)?\s*\(/, file);
  const cli = fs.readFileSync(path.join(ROOT, "bin", "agent-replay.js"), "utf8");
  assert.match(cli, /shell:\s*false/);
  assert.doesNotMatch(cli, /\bexec(?:Sync)?\s*\(/);
});

test("redact: keys, tokens, passwords, emails, home folder and user name", () => {
  const r = createRedactor(personalRules("C:\\Users\\alice", "alice"));
  const samples = [
    "sk-ant-api03-abcdefghijklmnopqrstuv",
    "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnop",
    "AKIAABCDEFGHIJKLMNOP",
    "sk_live_abcdefghijklmnop",
    "xoxb-1234567890-abcdefghij",
    "AIzaSyA1234567890abcdefghijklmnopqrstuv",
    "npm_abcdefghijklmnopqrstuvwxyz0123456789",
    "hf_abcdefghijklmnopqrstuvwxyz0123456789",
    "glpat-abcdefghijklmnopqrst",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
  ];
  for (const s of samples) assert.doesNotMatch(r(`value: ${s} end`), new RegExp(s.slice(4, 14).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), s);
  assert.equal(r("Authorization: Bearer abc.def.ghi123456"), `Authorization: ${MASK}`);
  assert.equal(r("postgres://admin:hunter2@db:5432/app"), `postgres://admin:${MASK}@db:5432/app`);
  assert.equal(r("DB_PASSWORD=hunter2"), `DB_PASSWORD=${MASK}`);
  assert.equal(r('{"password": "hunter2"}'), `{"password": "${MASK}"}`);
  assert.equal(r("mail alice.b@example.com"), `mail ${MASK}`);
  assert.equal(r("C:\\Users\\alice\\code\\app"), "~\\code\\app");
  assert.equal(r("C:/Users/alice/code"), "~/code");
  assert.equal(r("C--Users-alice-code"), "C--Users-‹user›-code");
  assert.equal(r("malice"), "malice"); // whole words only
  assert.equal(r("nothing to hide here"), "nothing to hide here");
});

test("redact: deep values, keys, and images left intact", () => {
  const r = createRedactor([]);
  const v = redactDeep({ a: ["sk-ant-api03-abcdefghijklmnop"], img: { type: "base64", data: "sk-ant-api03-abcdefghijklmnop" }, "sk-ant-api03-abcdefghijklmnop": 1 }, r);
  assert.equal(v.a[0], MASK);
  assert.equal(v.img.data, "sk-ant-api03-abcdefghijklmnop");
  assert.ok(MASK in v);
});

test("redact: big inputs stay fast", () => {
  const r = createRedactor(personalRules("/home/bob", "bob"));
  const big = `${"a".repeat(200_000)}@${"b".repeat(200_000)} ${"x=".repeat(100_000)} ${"-".repeat(100_000)}`;
  const t = Date.now();
  r(big);
  assert.ok(Date.now() - t < 2000, "linear time");
});

test("secret comparison and request checks", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual(undefined, "x"), false);
  assert.equal(isAllowedHost("127.0.0.1:4848", 4848), true);
  assert.equal(isAllowedHost("localhost:4848", 4848), true);
  assert.equal(isAllowedHost("localhost:4849", 4848), false);
  assert.equal(isAllowedHost("evil.com:4848", 4848), false);
  assert.equal(isAllowedHost("127.0.0.1.evil.com:4848", 4848), false);
  assert.equal(isAllowedHost(undefined, 4848), false);
  assert.equal(isAllowedOrigin(undefined, 4848), true);
  assert.equal(isAllowedOrigin("null", 4848), false);
  assert.equal(isAllowedOrigin("http://127.0.0.1:4848", 4848), true);
  assert.equal(isAllowedOrigin("https://evil.com", 4848), false);
  assert.equal(readCookie("a=1; agent_replay_1=xyz; b=2", "agent_replay_1"), "xyz");
  assert.equal(readCookie(undefined, "x"), undefined);
});

test("path checks", () => {
  for (const bad of ["..", ".", "a/b", "a\\b", "C:", "", "x\0y", "a\nb", "a".repeat(300)]) assert.equal(isSafeName(bad), false, JSON.stringify(bad));
  assert.equal(isSafeName("C--Users-demo-shop"), true);
  assert.equal(isInside("/a/b", "/a/b/c"), true);
  assert.equal(isInside("/a/b", "/a/b"), false);
  assert.equal(isInside("/a/b", "/a/bc"), false);
  assert.equal(isInside("/a/b", "/a"), false);
});

test("slim: only needed fields pass; thinking, tool schemas and attachments dropped", () => {
  assert.equal(slimRecord({ type: "attachment", attachment: { tools: [] } }), null);
  assert.equal(slimRecord({ type: "api-request-blob" }), null);
  const s = slimRecord({
    type: "assistant", extraSecret: "x", message: { id: "m", model: "claude", usage: { input_tokens: 1, server_tool_use: { a: 1 } }, content: [
      { type: "thinking", thinking: "private", signature: "sig" },
      { type: "tool_use", id: "t", name: "Bash", input: { command: "ls", __proto__: { polluted: true } } },
      { type: "image", source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" } },
    ] },
  });
  assert.equal(s.extraSecret, undefined);
  assert.deepEqual(Object.keys(s.message.usage), ["input_tokens"]);
  assert.deepEqual(s.message.content[0], { type: "thinking" });
  assert.equal(s.message.content.length, 2, "SVG image dropped");
  assert.equal({}.polluted, undefined);
});
