// @ts-check
// One session: info bar, request list, view tabs and the step detail panel.
import { h, clip, timeOf } from "../dom.js";
import { stepsOf, titleOf } from "/core/model.js";
import { computeStats, shortNumber } from "/core/stats.js";
import { render, syncHash, state as appState } from "../app.js";
import { renderMap, replayStep, replayToggle } from "./map.js";
import { renderChat } from "./chat.js";
import { renderStats } from "./stats.js";
import { renderHealth } from "./health.js";
import { renderFiles } from "./files.js";
import { renderDetail } from "./detail.js";

const LIVE_MS = 2 * 60_000;
const TABS = [
  ["map", "Map", "Who did what, step by step"],
  ["chat", "Conversation", "Read the request like a chat"],
  ["stats", "Stats", "Tokens and time"],
  ["health", "Health", "Errors, loops and risky steps"],
  ["files", "Files", "Files read, changed and created"],
];

/** The request on screen (newest when none chosen). */
export function currentRequest(state) {
  const n = state.model.requests.length;
  return state.request < 0 || state.request >= n ? n - 1 : state.request;
}

export function selectStep(id) {
  const s = appState.model.steps.find((x) => x.id === id);
  appState.step = id;
  if (s) appState.request = s.request;
  syncHash();
  render();
}

export function selectRequest(i) {
  appState.request = i;
  appState.step = null;
  appState.replay = { cursor: Infinity, playing: false, speed: appState.replay.speed };
  syncHash();
  render();
}

export function setView(v) {
  appState.view = v;
  syncHash();
  render();
}

/** @param {typeof appState} state */
export function renderSession(state) {
  const m = state.model;
  if (!state.ready) {
    return h("main", { class: "page" }, h("p", { class: "muted" }, `Reading the session… ${state.loadedRecords} lines so far.`), state.streamError ? h("p", { class: "error" }, state.streamError) : null);
  }
  if (m.requests.length === 0) {
    return h("main", { class: "page" }, h("p", null, "This session has no messages yet."), h("p", { class: "muted" }, "If Claude Code is running, they'll appear here as soon as you send one."));
  }
  const live = Date.now() - m.meta.lastTs < LIVE_MS;
  const ri = currentRequest(state);
  const perRequest = state.view === "map" || state.view === "chat";
  let main;
  if (state.view === "stats") main = renderStats(state);
  else if (state.view === "health") main = renderHealth(state);
  else if (state.view === "files") main = renderFiles(state);
  else if (state.view === "chat") main = renderChat(state, ri);
  else main = renderMap(state, ri);

  return h("div", { class: "session" },
    h("div", { class: "infobar" },
      h("div", { class: "info-title" }, live ? h("span", { class: "dot-live", title: "Claude Code wrote to this session in the last 2 minutes" }) : null, clip(titleOf(m), 120)),
      h("div", { class: "info-meta" },
        m.meta.cwd ? h("span", { title: "Folder Claude worked in" }, "📁 ", clip(m.meta.cwd, 70)) : null,
        m.meta.gitBranch ? h("span", { title: "Git branch" }, "⑂ ", m.meta.gitBranch) : null,
        m.meta.models.length ? h("span", { title: "Claude models used" }, "🧠 ", m.meta.models.join(", ")) : null,
        m.meta.permissionMode ? h("span", { title: "Permission mode: how much Claude may do without asking" }, "🛡 ", m.meta.permissionMode) : null,
        m.meta.version ? h("span", { title: "Claude Code version" }, "v", m.meta.version) : null,
      ),
      state.streamError ? h("p", { class: "error" }, state.streamError) : null,
    ),
    h("div", { class: "layout" },
      requestList(state, ri),
      h("section", { class: "main" },
        h("nav", { class: "tabs", role: "tablist" }, TABS.map(([id, label, title], i) =>
          h("button", { class: `tab${state.view === id ? " active" : ""}`, role: "tab", "aria-selected": state.view === id ? "true" : "false", title: `${title} (key ${i + 1})`, onclick: () => setView(id) }, label))),
        perRequest ? h("div", { class: "request-head" }, h("span", { class: "req-num" }, `Request ${ri + 1} of ${m.requests.length}`), h("span", { class: "req-text" }, clip(m.requests[ri].text, 200))) : null,
        main,
      ),
      state.step ? renderDetail(state) : null,
    ),
  );
}

function requestList(state, ri) {
  const stats = computeStats(state.model);
  return h("aside", { class: "requests", "data-scroll": "requests", "aria-label": "Your requests" },
    h("div", { class: "aside-title" }, "Your requests"),
    state.model.requests.map((r, i) => {
      const steps = stepsOf(state.model, i);
      const failed = steps.some((s) => s.status === "error");
      return h("button", { class: `req${i === ri ? " active" : ""}`, onclick: () => selectRequest(i), title: r.text },
        h("div", { class: "req-line" }, h("span", { class: "req-n" }, `#${i + 1}`), h("span", { class: "req-time" }, timeOf(r.ts))),
        h("div", { class: "req-label" }, clip(r.text, 90)),
        h("div", { class: "req-foot" },
          `${steps.length} steps`,
          stats.byRequest[i]?.total ? ` · ${shortNumber(stats.byRequest[i].total)} tokens` : "",
          failed ? h("span", { class: "warn-mark", title: "Some steps failed" }, " · ✕") : null),
      );
    }),
  );
}

// Keyboard shortcuts (ignored while typing in a box).
document.addEventListener("keydown", (e) => {
  if (!appState.current || !appState.ready) return;
  const t = /** @type {HTMLElement} */ (e.target);
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const n = appState.model.requests.length;
  const ri = currentRequest(appState);
  if (e.key === "Escape" && appState.step) {
    appState.step = null;
    syncHash();
    render();
  } else if (e.key === "j") selectRequest(Math.min(n - 1, ri + 1));
  else if (e.key === "k") selectRequest(Math.max(0, ri - 1));
  else if (/^[1-5]$/.test(e.key)) setView(TABS[Number(e.key) - 1][0]);
  else if (appState.view === "map" && e.key === "ArrowRight") replayStep(1);
  else if (appState.view === "map" && e.key === "ArrowLeft") replayStep(-1);
  else if (appState.view === "map" && e.key === " ") replayToggle();
  else return;
  e.preventDefault();
});
