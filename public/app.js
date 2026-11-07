// @ts-check
// Page entry: routing, the live connection, the header and the session list.
// Nothing is saved: all state lives in this tab's memory and is gone when you close it.
import { h, mount, clip, ago } from "./dom.js";
import { createModel, addRecords, addAgentMeta, titleOf } from "/core/model.js";
import { shortNumber } from "/core/stats.js";
import { renderSession } from "./views/session.js";
import { renderOverview } from "./views/overview.js";

const LIVE_MS = 2 * 60_000;
const OVERVIEW_FRESH_MS = 60_000;

export const state = {
  page: "list", // "list" | "overview" | "session"
  overview: {
    /** @type {any[] | null} */ sessions: null,
    loading: false,
    done: 0,
    total: 0,
    skipped: 0,
    error: "",
    range: 30,
    loadedAt: 0,
  },
  loadOverview,
  /** @type {any[]} */ sessions: [],
  listLoaded: false,
  listError: "",
  filter: "",
  /** @type {{ project: string, session: string } | null} */ current: null,
  /** @type {ReturnType<typeof createModel>} */ model: createModel(),
  ready: false,
  loadedRecords: 0,
  streamError: "",
  view: "map",
  request: -1, // -1 = newest
  /** @type {string | null} */ step: null,
  /** @type {string | null} */ file: null,
  reveal: false, // show private info: per tab, never remembered
  confirmReveal: false,
  replay: { cursor: Infinity, playing: false, speed: 1 },
  showTech: false,
};

/** @type {EventSource | null} */
let source = null;
let frame = 0;
const app = /** @type {HTMLElement} */ (document.getElementById("app"));

export function render() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    draw();
  });
}

// ---------- routing: #/  or  #/s/<project>/<session>/<view>/<request>/<step?>

export function go(parts) {
  location.hash = `#/${parts.map((p) => encodeURIComponent(String(p))).join("/")}`;
}

/** Updates the address without adding history for every click inside a session. */
export function syncHash() {
  if (!state.current) return;
  const parts = ["s", state.current.project, state.current.session, state.view, state.request, ...(state.step ? [state.step] : [])];
  const hash = `#/${parts.map((p) => encodeURIComponent(String(p))).join("/")}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function route() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "s" && /^[0-9a-f]{24}$/.test(parts[1] ?? "") && /^[A-Za-z0-9-]{1,100}$/.test(parts[2] ?? "")) {
    const same = state.current && state.current.project === parts[1] && state.current.session === parts[2];
    state.current = { project: parts[1], session: parts[2] };
    state.view = ["map", "chat", "stats", "health", "files"].includes(parts[3]) ? parts[3] : "map";
    const r = Number(parts[4]);
    state.request = Number.isInteger(r) && r >= 0 ? r : -1;
    state.step = parts[5] && /^s\d+$/.test(parts[5]) ? parts[5] : null;
    state.page = "session";
    if (!same) connect();
  } else if (parts[0] === "overview") {
    state.page = "overview";
    state.current = null;
    disconnect();
    loadOverview(false);
  } else {
    state.page = "list";
    state.current = null;
    disconnect();
    loadSessions();
    loadOverview(false); // in the background, for the token and health badges on each card
  }
  render();
}

/** @type {EventSource | null} */
let overviewSource = null;

/** Reads every session's summary from the server, with progress. Reuses a recent result unless forced. */
function loadOverview(force) {
  const o = state.overview;
  if (o.loading) return;
  if (!force && o.sessions && Date.now() - o.loadedAt < OVERVIEW_FRESH_MS) return;
  o.loading = true;
  o.error = "";
  o.done = 0;
  o.total = 0;
  overviewSource?.close();
  const es = new EventSource(`/api/overview${state.reveal ? "?reveal=1" : ""}`);
  overviewSource = es;
  es.addEventListener("progress", (e) => {
    const d = parse(e);
    if (!d) return;
    o.done = Number(d.done) || 0;
    o.total = Number(d.total) || 0;
    render();
  });
  es.addEventListener("overview", (e) => {
    const d = parse(e);
    es.close();
    o.loading = false;
    if (!d || !Array.isArray(d.sessions)) {
      o.error = "Couldn't read the overview.";
    } else {
      o.sessions = d.sessions;
      o.skipped = Number(d.skipped) || 0;
      o.loadedAt = Date.now();
    }
    render();
  });
  es.addEventListener("error", () => {
    if (!o.loading) return;
    es.close();
    o.loading = false;
    o.error = "Couldn't read the overview. Is agent-replay still running in the terminal?";
    render();
  });
  render();
}

// ---------- data

async function loadSessions() {
  try {
    const res = await fetch(`/api/sessions${state.reveal ? "?reveal=1" : ""}`, { credentials: "same-origin", cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    state.sessions = Array.isArray(body.sessions) ? body.sessions : [];
    state.listError = "";
  } catch {
    state.listError = "Couldn't load your sessions. Is agent-replay still running in the terminal?";
  }
  state.listLoaded = true;
  render();
}

function disconnect() {
  source?.close();
  source = null;
}

export function connect() {
  disconnect();
  if (!state.current) return;
  const { project, session } = state.current;
  const reset = () => {
    state.model = createModel();
    state.ready = false;
    state.loadedRecords = 0;
    state.streamError = "";
  };
  reset();
  const url = `/api/stream?project=${encodeURIComponent(project)}&session=${encodeURIComponent(session)}${state.reveal ? "&reveal=1" : ""}`;
  const es = new EventSource(url);
  source = es;
  // A reconnect replays the whole log, so start from empty each time it opens.
  es.addEventListener("open", () => {
    reset();
    render();
  });
  es.addEventListener("records", (e) => {
    const data = parse(e);
    if (!data || !Array.isArray(data.records)) return;
    addRecords(state.model, typeof data.source === "string" ? data.source : null, data.records);
    state.loadedRecords += data.records.length;
    render();
  });
  es.addEventListener("agent", (e) => {
    const data = parse(e);
    if (data && typeof data.id === "string") addAgentMeta(state.model, data.id, data.meta ?? {});
    render();
  });
  es.addEventListener("reset", () => {
    state.model = createModel();
    render();
  });
  es.addEventListener("ready", () => {
    state.ready = true;
    render();
  });
  es.addEventListener("problem", () => {
    state.streamError = "Part of the log couldn't be read.";
    render();
  });
  es.addEventListener("error", () => {
    if (es.readyState === EventSource.CLOSED) {
      state.streamError = "Lost the connection. Is agent-replay still running in the terminal?";
      render();
    }
  });
}

function parse(e) {
  try {
    return JSON.parse(/** @type {MessageEvent} */ (e).data);
  } catch {
    return null;
  }
}

/** Turning private info on or off reloads the data from the server with the new setting. */
export function setReveal(on) {
  state.reveal = on;
  state.confirmReveal = false;
  overviewSource?.close();
  state.overview.loading = false;
  state.overview.sessions = null; // its text was masked (or not) for the old setting
  if (state.current) connect();
  else {
    loadSessions();
    loadOverview(true);
  }
  render();
}

// ---------- drawing

function draw() {
  const scrolls = saveScroll();
  mount(app, header(), state.page === "session" ? renderSession(state) : state.page === "overview" ? renderOverview(state) : sessionList());
  restoreScroll(scrolls);
  document.title = state.current && state.ready ? `${clip(titleOf(state.model), 50)} · agent-replay` : "agent-replay";
}

function saveScroll() {
  const out = new Map();
  for (const el of app.querySelectorAll("[data-scroll]")) out.set(el.getAttribute("data-scroll"), [el.scrollLeft, el.scrollTop]);
  return out;
}
function restoreScroll(saved) {
  for (const el of app.querySelectorAll("[data-scroll]")) {
    const s = saved.get(el.getAttribute("data-scroll"));
    if (s && !el.hasAttribute("data-scroll-reset")) {
      el.scrollLeft = s[0];
      el.scrollTop = s[1];
    }
    if (el.hasAttribute("data-scroll-end")) el.scrollLeft = el.scrollWidth;
    const x = Number(el.getAttribute("data-scroll-x"));
    if (el.hasAttribute("data-scroll-x") && Number.isFinite(x)) {
      const view = /** @type {HTMLElement} */ (el);
      if (x < view.scrollLeft + 180 || x > view.scrollLeft + view.clientWidth - 180) view.scrollLeft = Math.max(0, x - view.clientWidth / 2);
    }
  }
}

function header() {
  const privacy = state.reveal
    ? h("button", { class: "pill pill-danger", onclick: () => setReveal(false), title: "Hide passwords, keys, emails and your name again" }, "⚠ Private info visible · Hide")
    : h("button", { class: "pill pill-safe", onclick: () => { state.confirmReveal = true; render(); }, title: "Passwords, keys, emails, your home folder and user name are hidden" }, "🔒 Private info hidden");
  const bar = h("header", { class: "top" },
    h("a", { class: "brand", href: "#/" }, h("span", { class: "logo", "aria-hidden": "true" }, "▶"), "agent-replay"),
    h("nav", { class: "nav", "aria-label": "Pages" },
      h("a", { class: `nav-link${state.page !== "overview" ? " active" : ""}`, href: "#/", "aria-current": state.page === "list" ? "page" : undefined }, state.page === "session" ? "← Sessions" : "Sessions"),
      h("a", { class: `nav-link${state.page === "overview" ? " active" : ""}`, href: "#/overview", "aria-current": state.page === "overview" ? "page" : undefined }, "Overview")),
    h("span", { class: "spacer" }),
    h("span", { class: "badge-local", title: "Runs only on this computer. Uses no tokens. Saves nothing." }, "Local · read-only · no tokens"),
    privacy,
  );
  if (!state.confirmReveal) return bar;
  return h("div", null, bar, h("div", { class: "confirm", role: "alertdialog", "aria-label": "Show private info?" },
    h("p", null, "Show private info? Passwords, keys, emails, your home folder and user name will appear on screen. Only do this when nobody can see your screen, and never before a screenshot."),
    h("button", { class: "btn btn-danger", onclick: () => setReveal(true) }, "Show it in this tab"),
    h("button", { class: "btn", onclick: () => { state.confirmReveal = false; render(); } }, "Keep it hidden"),
  ));
}

function sessionList() {
  if (!state.listLoaded) return h("main", { class: "page" }, h("p", { class: "muted" }, "Loading your sessions…"));
  if (state.listError) return h("main", { class: "page" }, h("p", { class: "error" }, state.listError));
  const q = state.filter.trim().toLowerCase();
  const list = state.sessions.filter((s) => !q || `${s.title} ${s.folder} ${s.branch ?? ""} ${s.models.join(" ")}`.toLowerCase().includes(q));
  const now = Date.now();
  const live = list.filter((s) => now - s.lastActive < LIVE_MS);
  /** @type {Map<string, any[]>} */
  const byDay = new Map();
  for (const s of list) {
    if (now - s.lastActive < LIVE_MS) continue;
    const day = dayLabel(s.lastActive);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)?.push(s);
  }
  const search = h("input", { class: "search", type: "search", placeholder: "Search sessions by title, folder, branch or model", value: state.filter, "aria-label": "Search sessions" });
  search.addEventListener("input", () => {
    state.filter = /** @type {HTMLInputElement} */ (search).value;
    render();
    requestAnimationFrame(() => {
      const el = /** @type {HTMLInputElement | null} */ (document.querySelector(".search"));
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  });
  return h("main", { class: "page", "data-scroll": "list" },
    h("div", { class: "intro" },
      h("h1", null, "Your Claude Code sessions"),
      h("p", { class: "muted" }, "Pick one to see what Claude and its helpers did, step by step, in plain words. Everything stays on this computer."),
      h("div", { class: "row" }, search, h("button", { class: "btn", onclick: loadSessions }, "Refresh")),
    ),
    state.sessions.length === 0 ? h("div", { class: "empty" }, h("p", null, "No sessions found yet."), h("p", { class: "muted" }, "agent-replay reads the logs Claude Code keeps in the .claude/projects folder in your home folder. Use Claude Code once and they'll appear here.")) : null,
    live.length ? h("section", null, h("h2", null, h("span", { class: "dot-live" }), "Running now"), live.map(card)) : null,
    [...byDay].map(([day, items]) => h("section", null, h("h2", null, day), items.map(card))),
    list.length === 0 && state.sessions.length ? h("p", { class: "muted" }, "No session matches your search.") : null,
  );
}

function card(s) {
  const sum = state.overview.sessions?.find((x) => x.sessionId === s.sessionId);
  const score = sum && sum.health.toolCalls > 0 ? sum.health.score : null;
  return h("a", { class: "card", href: `#/s/${s.project}/${s.sessionId}/map/-1` },
    h("div", { class: "card-title" }, clip(s.title, 140)),
    h("div", { class: "card-meta" },
      h("span", { title: "Folder" }, "📁 ", clip(s.folder, 60)),
      s.branch ? h("span", { title: "Git branch" }, "⑂ ", clip(s.branch, 30)) : null,
      h("span", null, ago(s.lastActive)),
      sum ? h("span", { title: "Tokens used in this session" }, `${shortNumber(sum.tokens.total)} tokens`) : null,
      score !== null ? h("span", { class: `health-badge ${score >= 85 ? "good" : score >= 60 ? "ok" : "bad"}`, title: `Health score: ${sum.health.label}` }, `health ${score}`) : null,
      sum?.health.risky ? h("span", { class: "risk-count", title: "Risky steps in this session" }, h("span", { class: "risk-dot risk-risky inline" }), ` ${sum.health.risky} risky`) : null,
    ),
  );
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(today) - start(d)) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
}

window.addEventListener("hashchange", route);
setInterval(() => {
  if (state.page === "list" && !document.hidden) loadSessions();
}, 15_000);
route();
