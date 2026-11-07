// @ts-check
// Health: a rough score with what stood out. Plain counting, no AI.
import { h, clip, timeOf } from "../dom.js";
import { computeHealth } from "/core/health.js";
import { selectStep } from "./session.js";

/** @param {any} state */
export function renderHealth(state) {
  const m = state.model;
  const r = computeHealth(m);
  const byId = new Map(m.steps.map((s) => [s.id, s]));
  const jump = (id) => h("button", { class: "link", onclick: () => selectStep(id) }, stepLabel(byId.get(id)));
  return h("div", { class: "panel-page", "data-scroll": "health" },
    h("div", { class: `score score-${r.label === "Smooth" ? "good" : r.label === "Some bumps" ? "ok" : "bad"}` },
      h("div", { class: "score-num" }, String(r.score)),
      h("div", null, h("div", { class: "score-label" }, r.label), h("p", { class: "muted" }, `A rough score out of 100 from counting steps: ${r.toolCalls} tool steps, ${r.errors.length} didn't work, ${r.declined.length} you said no to. It's a hint, not a verdict.`)),
    ),
    h("h3", null, "What stood out"),
    r.findings.length === 0 ? h("p", { class: "muted" }, "Nothing unusual: no loops, repeats or runs of failures.") : null,
    r.findings.map((f) => h("div", { class: "finding" }, h("b", null, f.title), h("p", null, f.explain), h("div", { class: "jumps" }, f.steps.slice(0, 12).map(jump)))),
    h("h3", null, "Steps worth a second look"),
    r.risks.length === 0 ? h("p", { class: "muted" }, "No risky commands or secret files touched.") : null,
    r.risks.map(({ step, risk }) => h("div", { class: `finding risk-${risk?.level}` },
      h("b", null, risk?.level === "risky" ? "⚠ Risky: " : "Worth a look: ", risk?.reason),
      h("div", null, h("code", null, clip(step.input?.command ?? step.input?.file_path ?? "", 160))),
      h("div", { class: "jumps" }, jump(step.id)))),
    h("h3", null, "Steps that didn't work"),
    r.errors.length === 0 ? h("p", { class: "muted" }, "None.") : null,
    r.errors.slice(0, 100).map((s) => h("div", { class: "finding" }, h("div", null, jump(s.id)), h("pre", { class: "text code small" }, clip(s.output ?? "", 400)))),
  );
}

function stepLabel(s) {
  if (!s) return "step";
  return `${s.icon} ${s.title}${s.subtitle ? `: ${clip(s.subtitle, 40)}` : ""} · ${timeOf(s.ts)}`;
}
