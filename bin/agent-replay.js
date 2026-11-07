#!/usr/bin/env node
// @ts-check
// `npx agent-replay`: starts the local viewer and opens it in your browser.
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { startServer } from "../src/server/server.js";

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`agent-replay needs Node.js 20 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      port: { type: "string", short: "p", default: "4848" },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  }));
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
}

if (args.version) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}

if (args.help) {
  console.log(`Usage: agent-replay [--port <number>] [--no-open]

See what Claude Code and its helper agents did, in plain English.

  -p, --port     Port to use on 127.0.0.1 (default 4848, or the next free one)
      --no-open  Don't open the browser; just print the private link
  -h, --help     Show this help
  -v, --version  Show the version

Reads Claude Code's logs from ~/.claude/projects (or $CLAUDE_CONFIG_DIR/projects).
Read-only. Local-only. Never uses tokens, never sends data anywhere, saves nothing.`);
  process.exit(0);
}

const port = Number(args.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("--port must be a whole number from 1024 to 65535.");
  process.exit(1);
}

const app = await startServer({ port });
console.log(`agent-replay is running on this computer only.

  Private link: ${app.url}

Anyone with this link can see your sessions while agent-replay runs, so don't share it.
Press Ctrl+C to stop.`);

if (!args["no-open"]) openBrowser(app.url);

/** Opens the link with the system's own opener. No shell, and the URL is checked first. */
function openBrowser(url) {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/\?k=[0-9a-f]{64}$/.test(url)) return;
  const [cmd, ...rest] =
    process.platform === "darwin" ? ["open"] : process.platform === "win32" ? ["cmd", "/c", "start", ""] : ["xdg-open"];
  try {
    spawn(cmd, [...rest, url], { stdio: "ignore", detached: true, windowsHide: true, shell: false })
      .on("error", () => {}) // no browser (e.g. over SSH): the link is printed above
      .unref();
  } catch {
    // same: the link is printed above
  }
}

const shutdown = () => {
  void app.close().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
