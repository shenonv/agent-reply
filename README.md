# agent-replay

See what Claude Code and its helper agents did, in plain English, and replay it step by step.

agent-replay reads the logs [Claude Code](https://docs.claude.com/en/docs/claude-code) already keeps on your
computer and turns each session into a map: one lane for you, one for Claude and one for every helper agent, with
every step explained in plain words.

- **Uses no tokens.** It never talks to Claude or any AI service. Running it costs nothing.
- **Private.** Runs only on your computer, sends nothing anywhere, saves nothing, and hides passwords, keys and your
  name by default.
- **Read-only.** It never changes, moves or deletes your files or logs.
- **No dependencies.** Plain Node.js, so there's nothing to install and nothing else to trust.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer and Claude Code (used at least once, so there are logs to show).

```bash
git clone https://github.com/YOUR-GITHUB-NAME/agent-replay.git
cd agent-replay
node bin/agent-replay.js
```

There's no `npm install` step, because there are no dependencies.

It prints a private link like this and opens it in your browser:

```
agent-replay is running on this computer only.
  Private link: http://127.0.0.1:4848/?k=4f2a…
```

If the browser doesn't open, copy the whole link (including the part after `?k=`) into it. Keep the terminal open
while you use agent-replay.

**To stop it:** press `Ctrl + C` in the terminal, or close the terminal window. The link then stops working, and
the next start makes a new one.

| Option | What it does |
| --- | --- |
| `--port 5000` | Use another port (default 4848, or the next free one) |
| `--no-open` | Don't open the browser; just print the link |
| `--help`, `--version` | Help and version |

Logs are read from `~/.claude/projects`, or from `$CLAUDE_CONFIG_DIR/projects` if you set that (the same variable
Claude Code uses).

> An npm package (`npx …`) is planned. Until then, run it from a clone as shown above.

## What you can do

**Find a session.** Every session on your computer, newest first, grouped by day, with search and a "Running now"
list.

**Map.** One lane per participant, steps left to right. Each box says what happened ("Reads a file", "Runs the
tests", "Briefs a helper"), marked ✓ worked, ✕ didn't work or ⊘ you said no. Messages between you, Claude and its
helpers are arrows. Click any box for what happened and why, with the technical details one click away.

**Replay.** Play, pause, step forward and back, scrub, change speed, or jump to **Live** to follow new steps as
Claude works.

**Conversation.** The same request read like a chat; each tool step opens to show its command and result.

**Stats.** Tokens per request, per model and per participant, how much was re-read from cache, the tools used and
how long things took. All numbers come from the logs; nothing is estimated.

**Health.** A rough score plus what stood out: repeated steps, commands that kept failing, searches that found
nothing, the same file read again and again, and **risky steps** such as `rm -rf`, `git push --force`,
`git reset --hard`, piping a download into a shell, or editing `.env` files. Risky steps also get a red dot on the
map.

**Files.** Every file Claude read, changed or created, each change shown as a before/after diff, and a button to copy
the file as it was before Claude's changes.

**Keyboard:** `1`–`5` switch views, `j`/`k` next or previous request, `←`/`→` step the replay, `Space` play/pause,
`Esc` close the details.

## How it works

1. Claude Code writes every session to a log file (one JSON record per line) in `~/.claude/projects`, and each
   helper agent gets its own log next to it.
2. agent-replay starts a small web server on `127.0.0.1` (this computer only), protected by a random key that is
   made fresh at every start.
3. When you open a session, the server reads the log, drops every field the page doesn't need, hides private info,
   and streams the result to your browser. It keeps watching the file, so new steps appear live.
4. The page turns the records into steps, lanes, stats and health checks by plain counting and pattern matching.
   No AI is involved.

## Privacy and security

Nothing leaves your computer, nothing is written anywhere, and private details stay hidden unless you choose to
show them in one tab. [SECURITY.md](SECURITY.md) explains exactly how, and how each promise is tested.

**Hide private info** is on by default. It masks:

- API keys and tokens (Anthropic, OpenAI, GitHub, AWS, Stripe, Slack, Google, npm, Hugging Face, GitLab, JWTs)
- passwords, including those inside database and web addresses
- sign-in headers and private keys
- email addresses
- your home folder and user name

It works by recognising patterns, so check screenshots before you share them.

Found a security problem? Please report it privately; see [SECURITY.md](SECURITY.md).

## Develop

```bash
node --test          # unit tests, security rules and a real-server test
node bin/agent-replay.js
```

There's no build step and nothing to install.

| Path | What it does |
| --- | --- |
| `bin/agent-replay.js` | Command line: starts the server, prints and opens the private link |
| `src/server/server.js` | Local web server: checks, routing, page files held in memory |
| `src/server/security.js` | Host/origin checks, per-launch key, security headers |
| `src/server/paths.js` | Finds the logs; turns ids into file paths safely |
| `src/server/reader.js` | Reads growing log files piece by piece |
| `src/server/stream.js` | Live updates (Server-Sent Events) |
| `src/server/slim.js` | Drops every field the page doesn't need |
| `src/server/redact.js` | "Hide private info" |
| `src/core/` | Shared with the page: session model, plain-English explanations, stats, health, risk, files |
| `public/` | The page (plain JavaScript, no framework) |
| `test/` | Tests, with made-up sample logs in `test/fixtures` |

Contributions are welcome. Please keep the project's rules: no dependencies, no network calls, no file writes and
no `innerHTML`. The tests in `test/security.test.js` check all of these.

## License

MIT. agent-replay is an independent project, not made or endorsed by Anthropic.
