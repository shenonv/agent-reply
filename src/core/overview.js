// @ts-check
// Numbers across all sessions. The server summarises each session once (summarizeSession), and the page adds the
// summaries up for the chosen time range (combine). Pure code: plain counting, no AI, no files, no network.
import { titleOf } from "./model.js";
import { computeStats } from "./stats.js";
import { computeHealth } from "./health.js";
import { computeFiles } from "./files.js";

const MAX_RISKS = 50; // per session
const MAX_FILES = 30; // per session

/** Local calendar day, "2026-11-07". */
export function dayKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * A small, text-light summary of one session: totals, tokens per day and model, health and risky steps.
 * @param {import("./model.js").Model} model
 */
export function summarizeSession(model) {
  const stats = computeStats(model);
  const health = computeHealth(model);

  /** @type {Record<string, Record<string, number>>} day -> model -> tokens */
  const daily = {};
  /** @type {Record<string, number>} day -> requests started that day */
  const dailyRequests = {};
  let helperTokens = 0;
  for (const u of model.usage) {
    const day = dayKey(u.ts);
    if (!day) continue;
    const total = u.input + u.cacheWrite + u.cacheRead + u.output;
    const byModel = (daily[day] ??= {});
    byModel[u.model] = (byModel[u.model] ?? 0) + total;
    if (u.actor !== "claude") helperTokens += total;
  }
  for (const r of model.requests) {
    const day = dayKey(r.ts);
    if (day) dailyRequests[day] = (dailyRequests[day] ?? 0) + 1;
  }

  /** @type {Record<string, { calls: number, errors: number }>} */
  const tools = {};
  for (const [name, t] of stats.tools) tools[name] = { calls: t.calls, errors: t.errors };

  const files = computeFiles(model)
    .filter((f) => f.changes.length)
    .slice(0, MAX_FILES)
    .map((f) => ({ path: f.path, name: f.name, changes: f.changes.length, created: f.created }));

  const risks = health.risks.slice(0, MAX_RISKS).map(({ step, risk }) => ({
    level: risk?.level ?? "care",
    reason: risk?.reason ?? "",
    what: clip(String(step.input?.command ?? step.input?.file_path ?? step.input?.notebook_path ?? ""), 200),
    tool: step.tool ?? "",
    step: step.id,
    request: step.request,
    ts: step.ts,
  }));

  return {
    title: clip(titleOf(model), 160),
    folder: model.meta.cwd ?? "",
    firstTs: model.meta.firstTs,
    lastTs: model.meta.lastTs,
    models: model.meta.models,
    requests: model.requests.length,
    steps: stats.stepCount,
    helpers: [...model.actors.values()].filter((a) => a.kind === "helper").length,
    tokens: stats.totals,
    helperTokens,
    daily,
    dailyRequests,
    tools,
    files,
    health: {
      score: health.score,
      label: health.label,
      findings: health.findings.length,
      errors: health.errors.length,
      declined: health.declined.length,
      toolCalls: health.toolCalls,
      risky: health.risks.filter((r) => r.risk?.level === "risky").length,
    },
    risks,
  };
}

/** @typedef {ReturnType<typeof summarizeSession> & { project: string, sessionId: string, repo?: string, repoName?: string, repoPath?: string }} SessionSummary */

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Every day from `from` to `to` (inclusive), as day keys. */
export function daysBetween(fromTs, toTs) {
  const out = [];
  const d = new Date(fromTs);
  d.setHours(12, 0, 0, 0); // midday avoids daylight-saving edge cases
  const end = new Date(toTs);
  end.setHours(12, 0, 0, 0);
  for (let i = 0; d <= end && i < 4000; i++) {
    out.push(dayKey(d.getTime()));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * Adds session summaries up for a time range. `days` = how many days back from `now` (0 = everything).
 * Tokens are counted per day, so a long session that started before the range only counts its days inside it.
 * @param {SessionSummary[]} sessions
 */
export function combine(sessions, days, now = Date.now()) {
  const cutoff = days > 0 ? dayKey(now - (days - 1) * 86_400_000) : "";
  const inRange = (day) => !cutoff || day >= cutoff;

  /** @type {Map<string, number>} */ const perDay = new Map();
  /** @type {Map<string, number>} */ const byModel = new Map();
  /** @type {Map<string, { tokens: number, sessions: number, name: string, path: string, repo: string }>} */ const byFolder = new Map();
  /** @type {Map<string, { calls: number, errors: number }>} */ const tools = new Map();
  /** @type {Map<string, { path: string, name: string, changes: number, sessions: number }>} */ const files = new Map();
  /** @type {any[]} */ const risks = [];
  /** @type {any[]} */ const active = [];
  let tokens = 0;
  let requests = 0;
  let firstDay = "";

  for (const s of sessions) {
    let sessionTokens = 0;
    for (const [day, models] of Object.entries(s.daily)) {
      if (!inRange(day)) continue;
      for (const [m, n] of Object.entries(models)) {
        sessionTokens += n;
        perDay.set(day, (perDay.get(day) ?? 0) + n);
        byModel.set(m, (byModel.get(m) ?? 0) + n);
      }
      if (!firstDay || day < firstDay) firstDay = day;
    }
    let sessionRequests = 0;
    for (const [day, n] of Object.entries(s.dailyRequests)) if (inRange(day)) sessionRequests += n;
    const touched = sessionTokens > 0 || sessionRequests > 0 || (Number.isFinite(s.lastTs) && inRange(dayKey(s.lastTs)));
    if (!touched) continue;

    active.push({ ...s, rangeTokens: sessionTokens });
    tokens += sessionTokens;
    requests += sessionRequests;
    // Grouped by repository (worktrees count as their repository); older summaries fall back to the folder.
    const key = s.repo || s.folder || "(unknown folder)";
    const f = byFolder.get(key) ?? { tokens: 0, sessions: 0, name: s.repoName || s.folder || "(unknown folder)", path: s.repoPath || s.folder || "", repo: s.repo || "" };
    f.tokens += sessionTokens;
    f.sessions++;
    byFolder.set(key, f);
    for (const [name, t] of Object.entries(s.tools)) {
      const x = tools.get(name) ?? { calls: 0, errors: 0 };
      x.calls += t.calls;
      x.errors += t.errors;
      tools.set(name, x);
    }
    for (const file of s.files) {
      const key = file.path.toLowerCase();
      const x = files.get(key) ?? { path: file.path, name: file.name, changes: 0, sessions: 0 };
      x.changes += file.changes;
      x.sessions++;
      files.set(key, x);
    }
    for (const r of s.risks) if (!cutoff || inRange(dayKey(r.ts))) risks.push({ ...r, project: s.project, sessionId: s.sessionId, title: s.title });
  }

  const start = days > 0 ? now - (days - 1) * 86_400_000 : firstDay ? Date.parse(`${firstDay}T12:00:00`) : now;
  const timeline = daysBetween(start, now).map((day) => ({ day, tokens: perDay.get(day) ?? 0 }));
  const scored = active.filter((s) => s.health.toolCalls > 0);
  const sum = (k) => active.reduce((n, s) => n + s.tokens[k], 0);

  return {
    sessions: active.length,
    requests,
    tokens,
    // Cache share uses the sessions' own totals (cache numbers aren't split per day).
    cacheShare: (() => {
      const fed = sum("input") + sum("cacheWrite") + sum("cacheRead");
      return fed > 0 ? sum("cacheRead") / fed : 0;
    })(),
    output: sum("output"),
    helperTokens: active.reduce((n, s) => n + s.helperTokens, 0),
    timeline,
    byModel: [...byModel].sort((a, b) => b[1] - a[1]),
    byFolder: [...byFolder].sort((a, b) => b[1].tokens - a[1].tokens),
    tools: [...tools].sort((a, b) => b[1].calls - a[1].calls),
    files: [...files.values()].sort((a, b) => b.changes - a.changes).slice(0, 15),
    risks: risks.sort((a, b) => (a.level === b.level ? b.ts - a.ts : a.level === "risky" ? -1 : 1)),
    health: {
      average: scored.length ? Math.round(scored.reduce((n, s) => n + s.health.score, 0) / scored.length) : null,
      errors: active.reduce((n, s) => n + s.health.errors, 0),
      toolCalls: active.reduce((n, s) => n + s.health.toolCalls, 0),
      roughest: [...scored].sort((a, b) => a.health.score - b.health.score).slice(0, 5),
    },
    biggest: [...active].sort((a, b) => b.rangeTokens - a.rangeTokens).slice(0, 5),
  };
}
