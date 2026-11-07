// @ts-check
// Every file Claude read, changed or created, with each change, worked out from the tool steps in the log.
import { baseName } from "./explain.js";

/**
 * @typedef {{ step: import("./model.js").Step, kind: "edit" | "write" | "create", before: string, after: string }} Change
 * @typedef {{ path: string, name: string, reads: number, changes: Change[], created: boolean, original?: string, lastTs: number, actors: Set<string> }} FileInfo
 */

const OK = new Set(["ok", "running", undefined]);

/** @param {import("./model.js").Model} model @returns {FileInfo[]} */
export function computeFiles(model) {
  /** @type {Map<string, FileInfo>} */
  const files = new Map();
  const get = (p, ts) => {
    const k = p.toLowerCase();
    let f = files.get(k);
    if (!f) files.set(k, (f = { path: p, name: baseName(p), reads: 0, changes: [], created: false, lastTs: ts, actors: new Set() }));
    f.lastTs = Math.max(f.lastTs, ts);
    return f;
  };
  const steps = model.steps.filter((s) => s.tool).sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  for (const s of steps) {
    const input = s.input ?? {};
    const p = input.file_path ?? input.notebook_path;
    if (typeof p !== "string" || !p) continue;
    if (s.tool === "Read") {
      if (s.status !== "error") {
        const f = get(p, s.ts);
        f.reads++;
        f.actors.add(s.actor);
      }
      continue;
    }
    if (!OK.has(s.status)) continue; // a failed change didn't happen
    const original = typeof s.result?.originalFile === "string" ? s.result.originalFile : undefined;
    if (s.tool === "Edit") {
      const f = get(p, s.ts);
      f.actors.add(s.actor);
      if (f.original === undefined && original !== undefined && f.changes.length === 0) f.original = original;
      f.changes.push({ step: s, kind: "edit", before: str(input.old_string), after: str(input.new_string) });
    } else if (s.tool === "MultiEdit" && Array.isArray(input.edits)) {
      const f = get(p, s.ts);
      f.actors.add(s.actor);
      if (f.original === undefined && original !== undefined && f.changes.length === 0) f.original = original;
      for (const e of input.edits) f.changes.push({ step: s, kind: "edit", before: str(e?.old_string), after: str(e?.new_string) });
    } else if (s.tool === "Write") {
      const f = get(p, s.ts);
      f.actors.add(s.actor);
      const created = s.result?.type === "create";
      if (created && f.changes.length === 0) f.created = true;
      if (f.original === undefined && original !== undefined && f.changes.length === 0) f.original = original;
      f.changes.push({ step: s, kind: created ? "create" : "write", before: original ?? "", after: str(input.content) });
    } else if (s.tool === "NotebookEdit") {
      const f = get(p, s.ts);
      f.actors.add(s.actor);
      f.changes.push({ step: s, kind: "edit", before: "", after: str(input.new_source) });
    }
  }
  return [...files.values()].sort((a, b) => b.changes.length - a.changes.length || b.lastTs - a.lastTs);
}

const str = (v) => (typeof v === "string" ? v : "");

/**
 * Line diff (longest common subsequence). Big inputs fall back to "all removed, all added" to stay fast.
 * @returns {{ type: "same" | "add" | "del", text: string }[]}
 */
export function diffLines(before, after, limit = 1500) {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  if (a.length > limit || b.length > limit || a.length * b.length > 2_000_000) {
    return [...a.map((text) => ({ type: /** @type {const} */ ("del"), text })), ...b.map((text) => ({ type: /** @type {const} */ ("add"), text }))];
  }
  const n = a.length;
  const m = b.length;
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  /** @type {{ type: "same" | "add" | "del", text: string }[]} */
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) out.push({ type: "del", text: a[i++] });
    else out.push({ type: "add", text: b[j++] });
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}
