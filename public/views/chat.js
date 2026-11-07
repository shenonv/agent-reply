// @ts-check
// The conversation view: one request read top to bottom like a chat. Tool steps are one line that opens up.
import { h, clip, timeOf, hueOf } from "../dom.js";
import { stepsOf } from "/core/model.js";
import { riskOf } from "/core/risk.js";
import { textBlock, images } from "./detail.js";
import { selectStep } from "./session.js";

const MARK = { ok: "✓", error: "✕", declined: "⊘", running: "…" };
/** Which tool rows are open, so live updates don't fold them shut. */
const open = new Set();

/** @param {any} state @param {number} ri */
export function renderChat(state, ri) {
  const m = state.model;
  const steps = stepsOf(m, ri);
  return h("div", { class: "chat", "data-scroll": `chat-${ri}` },
    steps.map((s) => {
      const actor = m.actors.get(s.actor);
      const helper = actor?.kind === "helper";
      const row = h("div", { class: `msg msg-${s.kind}${helper ? " msg-helper" : ""}${state.step === s.id ? " selected" : ""}` });
      row.style.setProperty("--hue", String(hueOf(s.actor)));
      const who = h("div", { class: "msg-who" }, h("span", { class: "who" }, actor?.name ?? s.actor), s.to ? ` → ${m.actors.get(s.to)?.name ?? "helper"}` : "", h("span", { class: "muted" }, ` · ${timeOf(s.ts)}`));
      if (s.kind === "tool" || s.kind === "brief") {
        const risk = riskOf(s);
        const details = h("details", { class: "tool-row", open: open.has(s.id), ontoggle: (e) => (e.currentTarget.open ? open.add(s.id) : open.delete(s.id)) },
          h("summary", null,
            h("span", { "aria-hidden": "true" }, s.icon, " "), h("b", null, s.title), s.subtitle ? ` · ${clip(s.subtitle, 70)}` : "",
            s.status ? h("span", { class: `step-status st-${s.status}` }, ` ${MARK[s.status]}`) : null,
            risk ? h("span", { class: `risk-dot risk-${risk.level} inline`, title: risk.reason }) : null),
          s.kind === "brief" && s.text ? textBlock(s.text) : null,
          s.kind === "tool" && s.input?.command ? textBlock(`$ ${s.input.command}`, "code") : null,
          s.output !== undefined && s.kind === "tool" ? textBlock(clip(s.output, 6000) || "(no output)", "code") : null,
          images(s.images),
          h("button", { class: "btn small", onclick: () => selectStep(s.id) }, "Explain this step"),
        );
        row.append(who, details);
      } else {
        // append() would print "null" for a missing part, so leave those out
        row.append(...[who, textBlock(s.text ?? s.what, "prose"), images(s.images)].filter(Boolean));
        row.addEventListener("dblclick", () => selectStep(s.id));
      }
      return row;
    }),
    steps.length === 0 ? h("p", { class: "muted" }, "No steps in this request yet.") : null,
  );
}
