// @ts-check
// The map: one lane per participant (you, Claude, each helper), steps left to right, messages as arrows.
// Replay reveals the steps one by one.
import { h, svg, clip, hueOf } from "../dom.js";
import { stepsOf, actorsIn, helperState } from "/core/model.js";
import { riskOf } from "/core/risk.js";
import { render, state as appState } from "../app.js";
import { selectStep, currentRequest } from "./session.js";

const LABEL_W = 180;
const COL = 172;
const BOX_W = 154;
const BOX_H = 66;
const LANE_H = 100;
const SPEEDS = [0.5, 1, 2, 4];

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;

function stepCount() {
  return stepsOf(appState.model, currentRequest(appState)).length;
}

function visibleCount() {
  return Math.min(appState.replay.cursor, stepCount());
}

export function replayStep(delta) {
  const n = stepCount();
  const cur = visibleCount();
  appState.replay.cursor = Math.max(0, Math.min(n, cur + delta));
  if (appState.replay.cursor >= n && delta > 0 && !appState.replay.playing) appState.replay.cursor = Infinity;
  render();
}

export function replayToggle() {
  if (appState.replay.playing) return stopPlay();
  if (visibleCount() >= stepCount()) appState.replay.cursor = 0; // at the end: start over
  appState.replay.playing = true;
  startTimer();
  render();
}

function startTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (!appState.current || appState.view !== "map") return stopPlay();
    if (visibleCount() >= stepCount()) {
      stopPlay();
      appState.replay.cursor = Infinity;
      return render();
    }
    appState.replay.cursor = visibleCount() + 1;
    render();
  }, 900 / appState.replay.speed);
}

function stopPlay() {
  if (timer) clearInterval(timer);
  timer = null;
  appState.replay.playing = false;
  render();
}

const STATUS = {
  ok: ["✓", "Worked"],
  error: ["✕", "Didn't work (Claude usually tries another way)"],
  declined: ["⊘", "You said no to this"],
  running: ["…", "Still running"],
};

/** @param {typeof appState} state @param {number} ri */
export function renderMap(state, ri) {
  const m = state.model;
  const steps = stepsOf(m, ri);
  const actors = actorsIn(m, ri);
  const lane = new Map(actors.map((a, i) => [a.id, i]));
  const shown = Math.min(state.replay.cursor, steps.length);
  const following = state.replay.cursor === Infinity;
  const width = LABEL_W + Math.max(1, steps.length) * COL + 40;
  const height = actors.length * LANE_H;

  const canvas = h("div", { class: "map-canvas" });
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  actors.forEach((a, i) => {
    const bg = h("div", { class: `lane${i % 2 ? " odd" : ""}` });
    bg.style.top = `${i * LANE_H}px`;
    bg.style.height = `${LANE_H}px`;
    bg.style.width = `${width}px`;
    const st = a.kind === "helper" ? helperState(m, a.id) : null;
    const label = h("div", { class: "lane-label", title: a.role },
      h("div", { class: "lane-name" }, a.name),
      h("div", { class: "lane-role" }, clip(a.role, 60)),
      st ? h("span", { class: `chip chip-${st}` }, st === "done" ? "finished" : st) : null,
    );
    label.style.setProperty("--hue", String(hueOf(a.id)));
    label.style.height = `${LANE_H}px`;
    bg.appendChild(label);
    canvas.appendChild(bg);
  });

  const arrows = svg("svg", { class: "arrows", width, height, "aria-hidden": "true" },
    svg("defs", {}, svg("marker", { id: "head", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "7", markerHeight: "7", orient: "auto-start-reverse" }, svg("path", { d: "M0,0 L10,5 L0,10 z", class: "arrow-head" }))));
  canvas.appendChild(arrows);

  steps.forEach((s, i) => {
    if (i >= shown) return;
    const x = LABEL_W + i * COL + (COL - BOX_W) / 2;
    const li = lane.get(s.actor) ?? 1;
    const y = li * LANE_H + (LANE_H - BOX_H) / 2;
    if (s.to && lane.has(s.to) && s.to !== s.actor) {
      const ti = /** @type {number} */ (lane.get(s.to));
      const cx = x + BOX_W / 2;
      const y1 = ti > li ? y + BOX_H : y;
      const y2 = ti > li ? ti * LANE_H + (LANE_H - BOX_H) / 2 : ti * LANE_H + (LANE_H + BOX_H) / 2;
      arrows.appendChild(svg("line", { x1: cx, y1, x2: cx, y2, class: `arrow arrow-${s.kind}`, "marker-end": "url(#head)" }));
    }
    const risk = s.tool ? riskOf(s) : null;
    const status = s.status ? STATUS[s.status] : null;
    const box = h("button", {
      class: `step kind-${s.kind}${s.status ? ` st-${s.status}` : ""}${state.step === s.id ? " selected" : ""}${!following && i === shown - 1 ? " current" : ""}`,
      onclick: () => selectStep(s.id),
      title: `${s.title}${s.subtitle ? `: ${s.subtitle}` : ""}${status ? ` (${status[1]})` : ""}${risk ? `. ${risk.reason}` : ""}`,
    },
      h("div", { class: "step-top" }, h("span", { class: "step-icon", "aria-hidden": "true" }, s.icon), h("span", { class: "step-title" }, s.title),
        status ? h("span", { class: `step-status st-${s.status}`, "aria-label": status[1] }, status[0]) : null),
      h("div", { class: "step-sub" }, clip(s.subtitle || s.text || "", 46)),
      risk ? h("span", { class: `risk-dot risk-${risk.level}`, "aria-label": risk.reason }) : null,
    );
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.setProperty("--hue", String(hueOf(s.actor)));
    canvas.appendChild(box);
  });

  // Following: stay at the newest step. Replaying: keep the current step in view.
  const focusX = following ? null : LABEL_W + Math.max(0, shown - 1) * COL;
  const scroller = h("div", { class: "map-scroll", "data-scroll": `map-${ri}`, ...(following ? { "data-scroll-end": "" } : { "data-scroll-x": String(focusX) }) }, canvas);
  return h("div", { class: "map-wrap" }, replayBar(steps.length, shown, following), steps.length === 0 ? h("p", { class: "muted" }, "No steps in this request yet.") : scroller, legend());
}

function replayBar(n, shown, following) {
  const slider = h("input", { type: "range", min: "0", max: String(n), value: String(shown), "aria-label": "Replay position", class: "slider" });
  slider.addEventListener("input", () => {
    const v = Number(/** @type {HTMLInputElement} */ (slider).value);
    appState.replay.cursor = v >= n ? Infinity : v;
    render();
  });
  const speed = h("select", { "aria-label": "Replay speed", class: "speed" }, SPEEDS.map((s) => h("option", { value: String(s), selected: appState.replay.speed === s }, `${s}×`)));
  speed.addEventListener("change", () => {
    appState.replay.speed = Number(/** @type {HTMLSelectElement} */ (speed).value) || 1;
    if (appState.replay.playing) startTimer();
  });
  return h("div", { class: "replay" },
    h("button", { class: "icon-btn", onclick: () => { appState.replay.cursor = 0; render(); }, title: "Back to the start" }, "⏮"),
    h("button", { class: "icon-btn", onclick: () => replayStep(-1), title: "Previous step (←)" }, "◀"),
    h("button", { class: "icon-btn play", onclick: replayToggle, title: "Play or pause the replay (Space)" }, appState.replay.playing ? "⏸" : "▶"),
    h("button", { class: "icon-btn", onclick: () => replayStep(1), title: "Next step (→)" }, "▶|"),
    slider,
    h("span", { class: "replay-pos" }, following ? `All ${n} steps` : `Step ${shown} of ${n}`),
    speed,
    h("button", { class: `btn${following ? " active" : ""}`, onclick: () => { appState.replay.cursor = Infinity; appState.replay.playing = false; if (timer) clearInterval(timer); render(); }, title: "Show everything and follow new steps as they happen" }, "● Live"),
  );
}

function legend() {
  return h("div", { class: "legend" },
    h("span", null, "✓ worked"), h("span", null, "✕ didn't work"), h("span", null, "⊘ you said no"),
    h("span", null, h("span", { class: "risk-dot risk-risky inline" }), " risky"), h("span", null, h("span", { class: "risk-dot risk-care inline" }), " worth a look"),
    h("span", null, "↕ a message between participants"),
  );
}
