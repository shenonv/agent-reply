// @ts-check
// Files: everything Claude read, changed or created, with each change as a before/after diff.
import { h, clip, timeOf } from "../dom.js";
import { computeFiles, diffLines } from "/core/files.js";
import { render, state as appState } from "../app.js";
import { selectStep } from "./session.js";

/** @param {any} state */
export function renderFiles(state) {
  const files = computeFiles(state.model);
  if (files.length === 0) return h("div", { class: "panel-page" }, h("p", { class: "muted" }, "Claude didn't read or change any files in this session."));
  const changed = files.filter((f) => f.changes.length);
  const read = files.filter((f) => !f.changes.length);
  const current = files.find((f) => f.path === state.file) ?? changed[0] ?? files[0];
  const item = (f) => h("button", { class: `file-item${f === current ? " active" : ""}`, onclick: () => { appState.file = f.path; render(); }, title: f.path },
    h("div", { class: "file-name" }, f.name, f.created ? h("span", { class: "chip chip-new" }, "new") : null),
    h("div", { class: "file-meta" }, f.changes.length ? `${f.changes.length} change${f.changes.length > 1 ? "s" : ""}` : "", f.changes.length && f.reads ? " · " : "", f.reads ? `read ${f.reads}×` : ""));
  return h("div", { class: "files" },
    h("div", { class: "file-list", "data-scroll": "file-list" },
      changed.length ? h("div", { class: "aside-title" }, `Changed or created (${changed.length})`) : null, changed.map(item),
      read.length ? h("div", { class: "aside-title" }, `Only read (${read.length})`) : null, read.map(item)),
    h("div", { class: "file-view", "data-scroll": `file-${current.path}` }, fileView(current)),
  );
}

function fileView(f) {
  const copy = f.original !== undefined
    ? h("button", { class: "btn", title: "Copies the whole file as it was before Claude's first change in this session", onclick: (e) => copyText(f.original, /** @type {HTMLElement} */ (e.currentTarget)) }, "📋 Copy the version from before Claude's changes")
    : null;
  return h("div", null,
    h("h3", null, f.name),
    h("p", { class: "muted path" }, f.path),
    f.created ? h("p", null, "Claude created this file.") : null,
    copy,
    copy ? h("p", { class: "muted small" }, "To undo Claude's changes, paste this into the file. agent-replay never changes files itself.") : null,
    f.changes.length === 0 ? h("p", { class: "muted" }, `Claude read this file ${f.reads} time${f.reads > 1 ? "s" : ""} and didn't change it.`) : null,
    f.changes.map((c, i) => h("div", { class: "change" },
      h("div", { class: "change-head" },
        h("b", null, `${i + 1}. ${c.kind === "create" ? "Created" : c.kind === "write" ? "Rewrote the whole file" : "Changed some lines"}`),
        h("span", { class: "muted" }, ` · ${timeOf(c.step.ts)}`),
        h("button", { class: "link", onclick: () => selectStep(c.step.id) }, "See the step")),
      diff(c.before, c.after),
    )),
  );
}

function diff(before, after) {
  const lines = diffLines(before, after);
  const shown = lines.slice(0, 1500);
  return h("pre", { class: "diff" },
    shown.map((l) => h("div", { class: `dl dl-${l.type}` }, h("span", { class: "dl-mark", "aria-hidden": "true" }, l.type === "add" ? "+" : l.type === "del" ? "−" : " "), l.text || " ")),
    lines.length > shown.length ? h("div", { class: "dl muted" }, clip(`… ${lines.length - shown.length} more lines`, 60)) : null);
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "✓ Copied";
  } catch {
    button.textContent = "Couldn't copy (your browser blocked it)";
  }
}
