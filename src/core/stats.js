// @ts-check
// Token and time numbers, all read from the logs (never estimated).

/** @typedef {{ input: number, cacheWrite: number, cacheRead: number, output: number, total: number, replies: number }} Tokens */

/** @returns {Tokens} */
export const emptyTokens = () => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, total: 0, replies: 0 });

function add(t, u) {
  t.input += u.input;
  t.cacheWrite += u.cacheWrite;
  t.cacheRead += u.cacheRead;
  t.output += u.output;
  t.total += u.input + u.cacheWrite + u.cacheRead + u.output;
  t.replies += 1;
}

/** @param {import("./model.js").Model} model */
export function computeStats(model) {
  const totals = emptyTokens();
  /** @type {Map<string, Tokens>} */
  const byModel = new Map();
  /** @type {Map<string, Tokens>} */
  const byActor = new Map();
  /** @type {Tokens[]} */
  const byRequest = model.requests.map(() => emptyTokens());
  const get = (map, k) => {
    let t = map.get(k);
    if (!t) map.set(k, (t = emptyTokens()));
    return t;
  };
  for (const u of model.usage) {
    add(totals, u);
    add(get(byModel, u.model), u);
    add(get(byActor, u.actor), u);
    if (byRequest[u.request]) add(byRequest[u.request], u);
  }

  /** @type {Map<string, { calls: number, errors: number, declined: number, ms: number, timed: number }>} */
  const tools = new Map();
  for (const s of model.steps) {
    if (!s.tool) continue;
    let t = tools.get(s.tool);
    if (!t) tools.set(s.tool, (t = { calls: 0, errors: 0, declined: 0, ms: 0, timed: 0 }));
    t.calls++;
    if (s.status === "error") t.errors++;
    if (s.status === "declined") t.declined++;
    if (Number.isFinite(s.endTs) && s.endTs >= s.ts) {
      t.ms += s.endTs - s.ts;
      t.timed++;
    }
  }

  const requestTimes = model.requests.map((r) => {
    let end = r.ts;
    for (const s of r.steps) end = Math.max(end, s.endTs ?? s.ts);
    return Math.max(0, end - r.ts);
  });

  const fed = totals.input + totals.cacheWrite + totals.cacheRead;
  return {
    totals,
    byModel: [...byModel].sort((a, b) => b[1].total - a[1].total),
    byActor: [...byActor].sort((a, b) => b[1].total - a[1].total),
    byRequest,
    cacheShare: fed > 0 ? totals.cacheRead / fed : 0,
    tools: [...tools].sort((a, b) => b[1].calls - a[1].calls),
    requestTimes,
    duration: Number.isFinite(model.meta.lastTs - model.meta.firstTs) ? model.meta.lastTs - model.meta.firstTs : 0,
    stepCount: model.steps.length,
  };
}

/** 1234567 -> "1.2M", 15300 -> "15.3k". */
export function shortNumber(n) {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 75000 -> "1m 15s". */
export function shortDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
