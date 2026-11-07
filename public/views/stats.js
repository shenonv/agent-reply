// @ts-check
// Stats: token use and time, read straight from the logs.
import { h, clip } from "../dom.js";
import { computeStats, shortNumber, shortDuration } from "/core/stats.js";
import { selectRequest } from "./session.js";

/** A horizontal bar, width set through CSSOM (allowed by the CSP, unlike style attributes). */
function bar(fraction, cls = "") {
  const fill = h("span", { class: `bar-fill ${cls}` });
  fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  return h("span", { class: "bar" }, fill);
}

/** @param {any} state */
export function renderStats(state) {
  const m = state.model;
  const s = computeStats(m);
  const t = s.totals;
  const maxReq = Math.max(1, ...s.byRequest.map((r) => r.total));
  const name = (id) => m.actors.get(id)?.name ?? id;
  return h("div", { class: "panel-page", "data-scroll": "stats" },
    h("p", { class: "muted" }, "Tokens are pieces of words. These numbers come from Claude Code's own logs; nothing is estimated and looking at them costs nothing."),
    h("div", { class: "cards" },
      card("Total tokens", shortNumber(t.total), `${t.replies} replies from Claude`),
      card("Written by Claude", shortNumber(t.output), "Claude's answers, code and commands"),
      card("New to Claude", shortNumber(t.input + t.cacheWrite), "Text Claude read for the first time"),
      card("Re-read from cache", shortNumber(t.cacheRead), `${Math.round(s.cacheShare * 100)}% of what Claude read was cached (faster)`),
      card("Session length", shortDuration(s.duration), `${m.requests.length} requests · ${s.stepCount} steps`),
    ),
    h("h3", null, "Tokens per request"),
    h("table", { class: "table" },
      h("thead", null, h("tr", null, h("th", null, "#"), h("th", null, "Request"), h("th", null, "Tokens"), h("th", { class: "wide" }, ""), h("th", null, "Time"))),
      h("tbody", null, s.byRequest.map((r, i) => h("tr", { class: "click", onclick: () => selectRequest(i), title: "Open this request" },
        h("td", null, String(i + 1)), h("td", null, clip(m.requests[i].text, 60)), h("td", { class: "num" }, shortNumber(r.total)),
        h("td", { class: "wide" }, bar(r.total / maxReq)), h("td", { class: "num" }, shortDuration(s.requestTimes[i])))))),
    h("div", { class: "two-col" },
      h("div", null, h("h3", null, "By model"), tokenTable(s.byModel.map(([k, v]) => [k, v]), t.total)),
      h("div", null, h("h3", null, "By participant"), tokenTable(s.byActor.map(([k, v]) => [name(k), v]), t.total)),
    ),
    h("h3", null, "Tools used"),
    h("table", { class: "table" },
      h("thead", null, h("tr", null, h("th", null, "Tool"), h("th", null, "Times"), h("th", null, "Didn't work"), h("th", null, "You said no"), h("th", null, "Average time"))),
      h("tbody", null, s.tools.map(([tool, v]) => h("tr", null,
        h("td", null, tool), h("td", { class: "num" }, String(v.calls)), h("td", { class: `num${v.errors ? " bad" : ""}` }, String(v.errors)),
        h("td", { class: "num" }, String(v.declined)), h("td", { class: "num" }, v.timed ? shortDuration(v.ms / v.timed) : "–"))))),
  );
}

function card(title, value, note) {
  return h("div", { class: "card stat" }, h("div", { class: "stat-title" }, title), h("div", { class: "stat-value" }, value), h("div", { class: "stat-note" }, note));
}

function tokenTable(rows, total) {
  return h("table", { class: "table" },
    h("thead", null, h("tr", null, h("th", null, "Name"), h("th", null, "Tokens"), h("th", null, "Written"), h("th", { class: "wide" }, ""))),
    h("tbody", null, rows.map(([k, v]) => h("tr", null, h("td", null, k), h("td", { class: "num" }, shortNumber(v.total)), h("td", { class: "num" }, shortNumber(v.output)), h("td", { class: "wide" }, bar(v.total / Math.max(1, total)))))));
}
