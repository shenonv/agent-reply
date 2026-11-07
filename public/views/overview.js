// @ts-check
// Overview: token use, health and risky steps across all your sessions, for a chosen time range.
import { h, clip, ago } from "../dom.js";
import { combine } from "/core/overview.js";
import { shortNumber } from "/core/stats.js";
import { render, state as appState } from "../app.js";

const RANGES = [[7, "7 days"], [30, "30 days"], [90, "90 days"], [0, "All time"]];
const MAX_RISKS = 30;

/** Width or height set through CSSOM (allowed by the CSP, unlike style attributes). */
function sized(el, prop, fraction) {
  el.style[prop] = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  return el;
}

const sessionLink = (s, view = "map", tail = "-1") => `#/s/${s.project}/${s.sessionId}/${view}/${tail}`;

/** @param {typeof appState} state */
export function renderOverview(state) {
  const o = state.overview;
  const head = h("div", { class: "intro" },
    h("h1", null, "Overview"),
    h("p", { class: "muted" }, "Everything across your sessions, worked out from Claude Code's own logs on this computer. Looking at it uses no tokens."),
    h("div", { class: "row filters", role: "group", "aria-label": "Time range" },
      RANGES.map(([d, label]) => h("button", { class: `btn${o.range === d ? " active" : ""}`, "aria-pressed": o.range === d ? "true" : "false", onclick: () => { o.range = d; render(); } }, label)),
      h("span", { class: "spacer" }),
      h("button", { class: "btn", onclick: () => appState.loadOverview(true), disabled: o.loading }, "Refresh"),
    ),
  );

  if (o.error) return h("main", { class: "page wide" }, head, h("p", { class: "error" }, o.error));
  if (!o.sessions) {
    const bar = h("span", { class: "progress-fill" });
    sized(bar, "width", o.total ? o.done / o.total : 0);
    return h("main", { class: "page wide" }, head,
      h("div", { class: "loading" },
        h("p", null, o.total ? `Reading ${o.done} of ${o.total} sessions…` : "Finding your sessions…"),
        h("span", { class: "progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": String(o.total || 1), "aria-valuenow": String(o.done) }, bar),
        h("p", { class: "muted small" }, "The first time takes a few seconds per large session. After that, only sessions that changed are read again.")));
  }

  const c = combine(o.sessions, o.range);
  if (c.sessions === 0) {
    return h("main", { class: "page wide" }, head, h("div", { class: "empty" }, h("p", null, o.sessions.length ? "No sessions in this time range." : "No sessions found yet."), o.sessions.length ? h("p", { class: "muted" }, "Pick a longer range above.") : null));
  }

  return h("main", { class: "page wide", "data-scroll": "overview" },
    head,
    o.loading ? h("p", { class: "muted small" }, `Updating… ${o.done} of ${o.total}`) : null,
    h("div", { class: "cards" },
      tile("Tokens", shortNumber(c.tokens), `${shortNumber(c.output)} written by Claude`),
      tile("Sessions", String(c.sessions), `${c.requests} requests from you`),
      tile("Re-read from cache", `${Math.round(c.cacheShare * 100)}%`, "of what Claude read (faster)"),
      tile("Helpers' share", percent(c.helperTokens, c.tokens), "of tokens used by helper agents"),
      tile("Average health", c.health.average === null ? "–" : String(c.health.average), `${c.health.errors} of ${c.health.toolCalls} steps didn't work`),
    ),
    h("h3", null, "Tokens per day"),
    dailyChart(c.timeline),
    h("div", { class: "two-col" },
      h("div", null, h("h3", null, "By model"), barTable(c.byModel.map(([k, v]) => [k, v, ""]), c.tokens, "Model")),
      h("div", null, h("h3", null, "By project folder"), barTable(c.byFolder.map(([k, v]) => [clip(k, 48), v.tokens, `${v.sessions} session${v.sessions > 1 ? "s" : ""}`]), c.tokens, "Folder")),
    ),
    h("div", { class: "two-col" },
      h("div", null, h("h3", null, "Biggest sessions"), sessionList(c.biggest, (s) => `${shortNumber(s.rangeTokens)} tokens`)),
      h("div", null, h("h3", null, "Roughest sessions"), c.health.roughest.length ? sessionList(c.health.roughest, (s) => `health ${s.health.score} · ${s.health.errors} failed`, "health") : h("p", { class: "muted" }, "None.")),
    ),
    h("h3", null, `Steps worth a second look (${c.risks.length})`),
    c.risks.length === 0 ? h("p", { class: "muted" }, "No risky commands or secret files touched in this range.") : null,
    c.risks.slice(0, MAX_RISKS).map((r) => h("a", { class: `finding risk-${r.level} risk-link`, href: sessionLink(r, "map", `${r.request}/${r.step}`) },
      h("b", null, r.level === "risky" ? "⚠ Risky: " : "Worth a look: ", r.reason),
      h("div", null, h("code", null, clip(r.what, 160))),
      h("div", { class: "muted small" }, clip(r.title, 80), " · ", ago(r.ts)))),
    c.risks.length > MAX_RISKS ? h("p", { class: "muted small" }, `…and ${c.risks.length - MAX_RISKS} more. Open a session's Health tab to see all of its steps.`) : null,
    h("div", { class: "two-col" },
      h("div", null, h("h3", null, "Most-used tools"), h("table", { class: "table" },
        h("thead", null, h("tr", null, h("th", null, "Tool"), h("th", null, "Times"), h("th", null, "Didn't work"))),
        h("tbody", null, c.tools.slice(0, 12).map(([name, t]) => h("tr", null, h("td", null, clip(name, 40)), h("td", { class: "num" }, String(t.calls)), h("td", { class: `num${t.errors ? " bad" : ""}` }, String(t.errors))))))),
      h("div", null, h("h3", null, "Most-changed files"), c.files.length ? h("table", { class: "table" },
        h("thead", null, h("tr", null, h("th", null, "File"), h("th", null, "Changes"), h("th", null, "Sessions"))),
        h("tbody", null, c.files.map((f) => h("tr", null, h("td", { title: f.path }, clip(f.name, 40)), h("td", { class: "num" }, String(f.changes)), h("td", { class: "num" }, String(f.sessions)))))) : h("p", { class: "muted" }, "No files changed.")),
    ),
    o.skipped ? h("p", { class: "muted small" }, `${o.skipped} very large or unreadable session${o.skipped > 1 ? "s were" : " was"} left out.`) : null,
  );
}

/** 0.4% -> "<1%", so a small share never reads as none. */
function percent(part, whole) {
  if (!whole || !part) return "0%";
  const p = (part / whole) * 100;
  return p < 1 ? "<1%" : `${Math.round(p)}%`;
}

function tile(label, value, note) {
  return h("div", { class: "card stat" }, h("div", { class: "stat-title" }, label), h("div", { class: "stat-value" }, value), h("div", { class: "stat-note" }, note));
}

/** Column chart of tokens per day, with a hover/focus readout and a table view. */
function dailyChart(timeline) {
  const max = Math.max(1, ...timeline.map((d) => d.tokens));
  const top = niceCeil(max);
  const fmtDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
  const peak = timeline.reduce((a, b) => (b.tokens > a.tokens ? b : a), timeline[0]);
  const readout = h("div", { class: "readout", "aria-live": "polite" }, peak?.tokens ? `Busiest day: ${fmtDay(peak.day)}, ${shortNumber(peak.tokens)} tokens. Point at a bar for its day.` : "No tokens in this range.");
  const show = (d) => (readout.textContent = `${fmtDay(d.day)}: ${d.tokens ? `${d.tokens.toLocaleString()} tokens` : "no activity"}`);
  const cols = timeline.map((d) => {
    const fill = sized(h("span", { class: "col-fill" }), "height", d.tokens / top);
    const col = h("span", { class: `col${d.tokens ? "" : " zero"}`, tabindex: "0", "aria-label": `${fmtDay(d.day)}: ${d.tokens} tokens` }, fill);
    col.addEventListener("mouseenter", () => show(d));
    col.addEventListener("focus", () => show(d));
    return col;
  });
  const ticks = [1, 0.5, 0].map((f) => h("span", { class: "tick" }, shortNumber(top * f)));
  const labels = timeline.length > 1
    ? [timeline[0], timeline[Math.floor((timeline.length - 1) / 2)], timeline[timeline.length - 1]].map((d) => h("span", null, fmtDay(d.day)))
    : [h("span", null, fmtDay(timeline[0].day))];
  return h("div", { class: "chart-box" },
    readout,
    h("div", { class: "chart" },
      h("div", { class: "y-axis", "aria-hidden": "true" }, ticks),
      h("div", { class: "plot" }, h("span", { class: "grid g100" }), h("span", { class: "grid g50" }), h("div", { class: "cols", role: "img", "aria-label": "Tokens per day" }, cols))),
    h("div", { class: "x-axis", "aria-hidden": "true" }, labels),
    h("details", { class: "table-view" }, h("summary", null, "See as a table"),
      h("table", { class: "table" }, h("thead", null, h("tr", null, h("th", null, "Day"), h("th", null, "Tokens"))),
        h("tbody", null, [...timeline].reverse().filter((d) => d.tokens).map((d) => h("tr", null, h("td", null, fmtDay(d.day)), h("td", { class: "num" }, d.tokens.toLocaleString())))))),
  );
}

/** A clean round number at or above n, for the top of the axis. */
function niceCeil(n) {
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

function barTable(rows, total, label) {
  return h("table", { class: "table" },
    h("thead", null, h("tr", null, h("th", null, label), h("th", null, "Tokens"), h("th", { class: "wide" }, ""), h("th", null, ""))),
    h("tbody", null, rows.map(([k, v, note]) => h("tr", null,
      h("td", null, k), h("td", { class: "num" }, shortNumber(v)),
      h("td", { class: "wide" }, h("span", { class: "bar" }, sized(h("span", { class: "bar-fill" }), "width", v / Math.max(1, total)))),
      h("td", { class: "muted" }, note)))));
}

function sessionList(list, note, view = "map") {
  return h("div", null, list.map((s) => h("a", { class: "card compact", href: sessionLink(s, view) },
    h("div", { class: "card-title" }, clip(s.title, 90)),
    h("div", { class: "card-meta" }, h("span", null, note(s)), h("span", null, ago(s.lastTs))))));
}
