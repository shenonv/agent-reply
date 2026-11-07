// @ts-check
// A rough health check of a session by counting steps: repeats, loops, empty searches, errors, risky steps.
import { riskOf } from "./risk.js";
import { baseName } from "./explain.js";

/**
 * @typedef {"repeat" | "fix-loop" | "empty-searches" | "many-errors" | "re-reads"} FindingKind
 * @typedef {{ kind: FindingKind, title: string, explain: string, steps: string[] }} Finding
 */

const PENALTY = { repeat: 8, "fix-loop": 12, "empty-searches": 4, "many-errors": 12, "re-reads": 5 };
// Checking on something that's still running is meant to repeat.
const POLLING = /^(?:BashOutput|TaskOutput|TaskGet|TaskList|TaskUpdate|TodoWrite|Monitor|KillShell|ScheduleWakeup|Sleep)$/;
const SEARCH = new Set(["Grep", "Glob", "LS", "WebSearch"]);
const EMPTY = /^\s*(?:no (?:files|matches|results)(?: found)?|found 0\b|0 (?:matches|files|results)|$)/i;
const CHANGES = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Same input in any key order gives the same text. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** @param {import("./model.js").Model} model */
export function computeHealth(model) {
  const toolSteps = model.steps.filter((s) => s.tool).sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  /** @type {Finding[]} */
  const findings = [];

  // 1. The same call three or more times in a row, by the same agent.
  /** @type {Map<string, { key: string, run: string[] }>} */
  const runs = new Map();
  const closeRun = (r) => {
    if (r && r.run.length >= 3) {
      findings.push({ kind: "repeat", title: `Did the same thing ${r.run.length} times in a row`, explain: "Repeating an identical step usually means Claude was stuck or waiting for something to change.", steps: [...r.run] });
    }
  };
  for (const s of toolSteps) {
    if (POLLING.test(s.tool ?? "")) continue;
    const key = `${s.tool}:${stable(s.input)}`;
    const r = runs.get(s.actor);
    if (r && r.key === key) r.run.push(s.id);
    else {
      closeRun(r);
      runs.set(s.actor, { key, run: [s.id] });
    }
  }
  for (const r of runs.values()) closeRun(r);

  // 2. The same command failing three or more times.
  /** @type {Map<string, string[]>} */
  const failing = new Map();
  for (const s of toolSteps) {
    const cmd = typeof s.input?.command === "string" ? s.input.command.trim() : "";
    if (!cmd || s.status !== "error") continue;
    const list = failing.get(cmd) ?? [];
    list.push(s.id);
    failing.set(cmd, list);
  }
  for (const [cmd, ids] of failing) {
    if (ids.length >= 3) findings.push({ kind: "fix-loop", title: `A command failed ${ids.length} times`, explain: `"${cmd.slice(0, 80)}" kept failing. Claude may have been going round in circles.`, steps: ids });
  }

  // 3. Five or more searches in a row that found nothing.
  let empties = [];
  const flushEmpty = () => {
    if (empties.length >= 5) findings.push({ kind: "empty-searches", title: `${empties.length} searches in a row found nothing`, explain: "Claude was looking for something that may not exist, or searching in the wrong place.", steps: empties });
    empties = [];
  };
  for (const s of toolSteps) {
    if (!SEARCH.has(s.tool ?? "")) continue;
    if (s.status === "ok" && EMPTY.test(s.output ?? "")) empties.push(s.id);
    else flushEmpty();
  }
  flushEmpty();

  // 4. Many failed steps.
  const errors = toolSteps.filter((s) => s.status === "error");
  const declined = toolSteps.filter((s) => s.status === "declined");
  if (errors.length >= 4 && errors.length / Math.max(1, toolSteps.length) >= 0.3) {
    findings.push({ kind: "many-errors", title: `${errors.length} of ${toolSteps.length} steps failed`, explain: "A lot of steps went wrong. Claude usually tries another way, but it costs time and tokens.", steps: errors.map((s) => s.id) });
  }

  // 5. The same file read three or more times with no change in between.
  /** @type {Map<string, string[]>} */
  const reads = new Map();
  for (const s of toolSteps) {
    const file = s.input?.file_path;
    if (typeof file !== "string") continue;
    const k = file.toLowerCase();
    if (CHANGES.has(s.tool ?? "")) reads.delete(k);
    else if (s.tool === "Read") {
      const list = reads.get(k) ?? [];
      list.push(s.id);
      reads.set(k, list);
      if (list.length === 3) findings.push({ kind: "re-reads", title: `Read ${baseName(file)} again and again`, explain: "The file didn't change between reads, so the extra reads only used up memory.", steps: list });
    }
  }

  const risks = toolSteps.map((s) => ({ step: s, risk: riskOf(s) })).filter((x) => x.risk);
  const riskyCount = risks.filter((x) => x.risk?.level === "risky").length;

  let score = 100;
  /** @type {Partial<Record<FindingKind, number>>} */
  const seen = {};
  for (const f of findings) {
    const n = (seen[f.kind] = (seen[f.kind] ?? 0) + 1);
    score -= PENALTY[f.kind] / n; // repeats of the same kind count for less
  }
  score -= Math.min(15, riskyCount * 3);
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    label: score >= 85 ? "Smooth" : score >= 60 ? "Some bumps" : "Rough",
    findings,
    errors,
    declined,
    risks,
    toolCalls: toolSteps.length,
  };
}
