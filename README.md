# agent-replay

See what Claude Code and its helper agents did, in plain English, and replay it step by step.

agent-replay reads the logs Claude Code already keeps on your computer and turns each session into a map: one lane
for you, one for Claude and one for every helper agent, with every step explained in plain words.

- **Uses no tokens.** It never talks to Claude or any AI service. Running it costs nothing.
- **Private.** Runs only on your computer, sends nothing anywhere, saves nothing, and hides passwords, keys and your
  name by default.
- **Read-only.** It never changes, moves or deletes your files or logs.
- **No dependencies.** Plain Node.js; installing it downloads nothing else.

## Run it

Needs [Node.js](https://nodejs.org) 20 or newer.

```bash
npx agent-replay
```

It prints a private link and opens it in your browser. The link only works on your computer, and only while
agent-replay is running. Press `Ctrl+C` to stop it.

Options:

| Option | What it does |
| --- | --- |
| `--port 5000` | Use another port (default 4848, or the next free one) |
| `--no-open` | Don't open the browser; just print the link |
| `--help`, `--version` | Help and version |

Logs are read from `~/.claude/projects`, or `$CLAUDE_CONFIG_DIR/projects` if you set that (the same variable Claude
Code uses).

## What you can do

**Find a session.** Every session on your computer, newest first, grouped by day, with search and a "Running now"
list.

**Map.** One lane per participant, steps left to right. Each box says what happened ("Reads a file", "Runs the
tests", "Briefs a helper") with ✓ worked, ✕ didn't work or ⊘ you said no. Messages between you, Claude and its
helpers are arrows. Click any box for what happened and why, with the technical details one click away.

**Replay.** Play, pause, step forward and back, scrub, change speed, or jump to **Live** to follow new steps as
Claude works.

**Conversation.** The same request read like a chat; each tool step opens to show its command and result.

**Stats.** Tokens per request, per model and per participant, how much was re-read from cache, tools used and how
long things took. All numbers come from the logs.

**Health.** A rough score plus what stood out: repeated steps, commands that kept failing, searches that found
nothing, re-reading the same file, and **risky steps** such as `rm -rf`, `git push --force`, `git reset --hard`,
piping a download into a shell, or editing `.env` files. Risky steps also get a red dot on the map.

**Files.** Every file Claude read, changed or created, each change as a before/after diff, and a button to copy the
file as it was before Claude's changes.

**Keyboard:** `1`–`5` switch views, `j`/`k` next/previous request, `←`/`→` step the replay, `Space` play/pause,
`Esc` close the details.

## Privacy and security

The short version: nothing leaves your computer, nothing is written anywhere, and private details are hidden unless
you choose to show them in one tab. See [SECURITY.md](SECURITY.md) for exactly how, and how each promise is tested.

**Hide private info** is on by default. It masks API keys and tokens (Anthropic, OpenAI, GitHub, AWS, Stripe, Slack,
Google, npm, Hugging Face, GitLab, JWTs), passwords (also inside database and web addresses), sign-in headers,
private keys, emails, your home folder and your user name. It works by recognising patterns, so check screenshots
before you share them.

## Develop

```bash
node --test          # unit tests, security rules and a real-server test
npm start            # run from this folder
```

No build step and no packages to install. Code layout:

| Path | What it does |
| --- | --- |
| `bin/agent-replay.js` | Command line: starts the server, prints and opens the private link |
| `src/server/server.js` | Local web server: checks, routing, page files held in memory |
| `src/server/security.js` | Host/origin checks, per-launch secret, security headers |
| `src/server/paths.js` | Finds the logs; turns ids into paths safely |
| `src/server/reader.js` | Reads growing log files piece by piece |
| `src/server/stream.js` | Live updates (Server-Sent Events) |
| `src/server/slim.js` | Drops every field the page doesn't need |
| `src/server/redact.js` | "Hide private info" |
| `src/core/` | Shared with the page: the session model, plain-English explanations, stats, health, risk, files |
| `public/` | The page (plain JavaScript, no framework) |
| `test/` | Tests, with made-up sample logs in `test/fixtures` |

## Publishing to npm

The name `agent-replay` is already taken on npm, so publish under your own scope (for example
`@your-npm-name/agent-replay`; the command stays `agent-replay`). `package.json` has `"private": true` so nothing is
published by accident.

1. Set `"name"` in `package.json`, remove `"private": true`, and add a `"repository"` field with your GitHub URL.
2. Turn on two-factor authentication for your npm account.
3. Either run `npm publish --provenance --access public` from a GitHub Action (`.github/workflows/publish.yml` does
   this when you publish a GitHub release; add an npm token as the `NPM_TOKEN` secret), or `npm publish --access
   public` from your computer.

## License

MIT. agent-replay is an independent project, not made or endorsed by Anthropic.
