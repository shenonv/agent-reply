# Security

agent-replay shows Claude Code session logs, which can contain anything you or Claude typed: code, passwords,
API keys, personal details. It is built so that this data never leaves your computer and nothing else can read it
through agent-replay.

## What it promises

| Promise | How it's kept | Checked by |
| --- | --- | --- |
| **No tokens, no AI calls** | It never talks to Claude or any AI service. Token numbers are read from the logs. | `test/security.test.js`: no network APIs in `src/` or `bin/` |
| **No network** | The server listens on `127.0.0.1` only and makes no outgoing requests: no telemetry, no update checks. | source scan + `server.test.js` |
| **Read-only** | Log files are opened read-only. It never writes, moves or deletes files anywhere. | source scan for every write/delete API |
| **Saves nothing** | No database, no cache files, no browser storage. Responses are sent with `Cache-Control: no-store`. Closing the tab or stopping the server forgets everything. | source scan for `localStorage`, `indexedDB`, cookies in page code |
| **Private info hidden by default** | Keys, tokens, passwords, emails, your home folder and user name are masked on the server, before anything reaches the browser. | `security.test.js` redaction tests |
| **Data minimisation** | Only the fields the page shows are sent. Claude's private thinking, tool schemas, system prompts and signatures are dropped. | `slim` tests |
| **No dependencies** | Zero runtime and zero development dependencies, and no install scripts. What you install is what's in this repository. | `security.test.js` checks `package.json` |

## Who can open it

- **Other websites in your browser:** blocked. Requests with a foreign `Host` (DNS rebinding), a foreign `Origin` or
  `Sec-Fetch-Site: cross-site` are refused, and no CORS headers are ever sent.
- **Other programs or users on your computer:** they need the per-launch secret. The secret is 256 random bits, made
  fresh every start, printed only in your terminal, and swapped for an `HttpOnly; SameSite=Strict` session cookie on
  first use. Secrets are compared in constant time.
- **Other computers:** can't connect; the server is bound to `127.0.0.1`.

## Log content is treated as hostile

Logs contain web pages, files and command output that may include HTML or script. The page:

- builds every element with `createElement`/`textContent`; `innerHTML`, `eval` and similar are banned by a test;
- runs under a strict Content-Security-Policy (`default-src 'none'; script-src 'self'; …; frame-ancestors 'none'`);
- shows images only as base64 PNG/JPEG/GIF/WebP (never SVG);
- accepts only opaque ids from the browser, never file paths. Ids must match real entries inside
  `~/.claude/projects`, symlinks are refused, and project folder names (which contain your user name) are replaced by
  per-launch HMAC handles.

## Limits

- Masking works by recognising patterns. It catches common secrets but can't promise to catch every one. Check
  screenshots before sharing them.
- Anyone who can already read your home folder can read the logs directly; agent-replay doesn't change that.
- Don't forward agent-replay's port to a network or tunnel.

## Reporting a problem

Please report security issues privately via GitHub's "Report a vulnerability" (Security tab) on this repository
rather than in a public issue. Include steps to reproduce. You'll get a reply within a few days.
