// @ts-check
// The panel that explains one step: what happened, why, and (on request) the technical details.
import { h, clip, timeOf, hueOf } from "../dom.js";
import { riskOf } from "/core/risk.js";
import { shortDuration } from "/core/stats.js";
import { render, syncHash, state as appState } from "../app.js";

const MAX_SHOW = 20_000;
const STATUS_WORDS = { ok: "Worked", error: "Didn't work", declined: "You said no", running: "Still running (or no result recorded)" };

/** Long text in a box, cut at MAX_SHOW characters with a button to see the rest. */
export function textBlock(text, cls = "") {
  const t = String(text ?? "");
  const pre = h("pre", { class: `text ${cls}` }, t.length > MAX_SHOW ? t.slice(0, MAX_SHOW) : t);
  if (t.length <= MAX_SHOW) return pre;
  const more = h("button", { class: "btn small", onclick: () => { pre.textContent = t; more.remove(); } }, `Show all (${Math.round(t.length / 1000)}k characters)`);
  return h("div", null, pre, more);
}

export function images(list) {
  if (!list?.length) return null;
  return h("div", { class: "images" }, list.slice(0, 8).map((img) => h("img", { src: `data:${img.mediaType};base64,${img.data}`, alt: "An image from the session", loading: "lazy" })));
}

/** @param {typeof appState} state */
export function renderDetail(state) {
  const s = state.model.steps.find((x) => x.id === state.step);
  if (!s) return null;
  const actor = state.model.actors.get(s.actor);
  const to = s.to ? state.model.actors.get(s.to) : null;
  const risk = s.tool ? riskOf(s) : null;
  const close = () => {
    appState.step = null;
    syncHash();
    render();
  };
  const panel = h("aside", { class: "detail", "data-scroll": `detail-${s.id}`, "aria-label": "Step details" },
    h("div", { class: "detail-head" },
      h("span", { class: "detail-icon", "aria-hidden": "true" }, s.icon),
      h("h3", null, s.title),
      h("button", { class: "icon-btn", onclick: close, title: "Close (Esc)" }, "✕"),
    ),
    h("div", { class: "detail-meta" },
      h("span", { class: "who" }, actor?.name ?? s.actor, to ? ` → ${to.name}` : ""),
      h("span", null, timeOf(s.ts)),
      s.endTs !== undefined ? h("span", null, `took ${shortDuration(s.endTs - s.ts)}`) : null,
      s.status ? h("span", { class: `st-word st-${s.status}` }, STATUS_WORDS[s.status]) : null,
      s.model ? h("span", { class: "muted" }, s.model) : null,
    ),
    risk ? h("div", { class: `risk-box risk-${risk.level}` }, risk.level === "risky" ? "⚠ Risky: " : "Worth a look: ", risk.reason) : null,
    s.subtitle && s.kind === "tool" ? h("p", { class: "subtitle" }, s.subtitle) : null,
    s.what ? h("div", { class: "explain" }, h("h4", null, "What happened"), h("p", null, s.what)) : null,
    s.why ? h("div", { class: "explain" }, h("h4", null, "Why"), h("p", null, s.why)) : null,
    s.text ? h("div", null, h("h4", null, s.kind === "brief" ? "The brief Claude gave" : s.kind === "report" ? "What the helper reported" : "Message"), textBlock(s.text)) : null,
    images(s.images),
    s.tool && s.output !== undefined && s.kind !== "brief" ? h("div", null, h("h4", null, s.status === "error" ? "What went wrong" : "Result"), textBlock(clip(s.output, 4000) || "(no output)")) : null,
    s.tool ? h("div", { class: "tech" },
      h("button", { class: "btn small", onclick: () => { appState.showTech = !appState.showTech; render(); } }, appState.showTech ? "Hide technical details" : "Show technical details"),
      appState.showTech ? h("div", null,
        h("h4", null, `Tool: ${s.tool}`),
        h("h4", null, "Input"), textBlock(JSON.stringify(s.input, null, 2), "code"),
        s.output !== undefined ? h("div", null, h("h4", null, "Full output"), textBlock(s.output, "code")) : null,
      ) : null,
    ) : null,
  );
  panel.style.setProperty("--hue", String(hueOf(s.actor)));
  return panel;
}
