// @ts-check
// Turns log records into a story: who took part (actors), what you asked (requests) and every step in between.
// Works incrementally, so live updates just add records. Pure code: no files, no network, no DOM.
import { textOf, imagesOf, userPrompt, tsOf, isToolResultRecord } from "./records.js";
import { describeTool } from "./explain.js";

/**
 * @typedef {{ id: string, kind: "you" | "lead" | "helper", name: string, role: string, type?: string, model?: string, firstTs?: number }} Actor
 * @typedef {"prompt" | "command" | "interrupt" | "compact" | "reply" | "tool" | "brief" | "report" | "problem"} StepKind
 * @typedef {{
 *   id: string, seq: number, request: number, kind: StepKind, actor: string, to?: string | null,
 *   ts: number, endTs?: number, icon: string, title: string, subtitle: string, what: string, why: string,
 *   text?: string, tool?: string, toolId?: string, input?: any, output?: string, images?: { mediaType: string, data: string }[],
 *   result?: any, status?: "running" | "ok" | "error" | "declined", model?: string, thought?: boolean
 * }} Step
 * @typedef {{ index: number, ts: number, kind: string, text: string, steps: Step[], dirty: boolean }} Request
 * @typedef {{ actor: string, request: number, model: string, input: number, cacheWrite: number, cacheRead: number, output: number, ts: number }} Usage
 */

export const AGENT_TOOLS = new Set(["Agent", "Task"]);

// Claude Code's own words when you (or your settings) said no to a step. Anchored at the start on purpose:
// programs print "permission denied" for real failures, and those stay failures.
const DECLINED = /^\s*(?:<tool_use_error>\s*)?(?:Error:\s*)?(?:The user doesn't want to (?:proceed|take this action)|The tool use was rejected|User rejected|Permission to use \S+ has been denied)/i;

export function createModel() {
  return {
    /** @type {Map<string, Actor>} */
    actors: new Map([
      ["you", { id: "you", kind: "you", name: "You", role: "The person giving the instructions" }],
      ["claude", { id: "claude", kind: "lead", name: "Claude", role: "The main Claude Code agent" }],
    ]),
    /** @type {Step[]} */
    steps: [],
    /** @type {Request[]} */
    requests: [],
    /** @type {Map<string, Step>} tool_use id -> its step */
    tools: new Map(),
    /** @type {Map<string, string>} Agent tool_use id -> helper id */
    helperByTool: new Map(),
    /** @type {Usage[]} */
    usage: [],
    /** @type {Set<string>} */
    seenMessages: new Set(),
    meta: {
      /** @type {string | undefined} */ customTitle: undefined,
      /** @type {string | undefined} */ aiTitle: undefined,
      /** @type {string | undefined} */ cwd: undefined,
      /** @type {string | undefined} */ gitBranch: undefined,
      /** @type {string | undefined} */ version: undefined,
      /** @type {string | undefined} */ permissionMode: undefined,
      /** @type {string[]} */ models: [],
      firstTs: NaN,
      lastTs: NaN,
    },
    seq: 0,
    helperCount: 0,
    changed: 0,
  };
}

/** @typedef {ReturnType<typeof createModel>} Model */

/** Session title: your /rename name, then Claude's title, then your first message. */
export function titleOf(model) {
  return model.meta.customTitle || model.meta.aiTitle || model.requests.find((r) => r.kind === "prompt")?.text || "Untitled session";
}

/** The steps of one request, in time order. */
export function stepsOf(model, index) {
  const r = model.requests[index];
  if (!r) return [];
  if (r.dirty) {
    r.steps.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    r.dirty = false;
  }
  return r.steps;
}

/** Actors that appear in a request, in lane order: you, Claude, then helpers by first appearance. */
export function actorsIn(model, index) {
  const ids = new Set(["you", "claude"]);
  for (const s of stepsOf(model, index)) {
    ids.add(s.actor);
    if (s.to) ids.add(s.to);
  }
  return [...ids].map((id) => model.actors.get(id)).filter(Boolean);
}

function ensureHelper(model, id, ts) {
  let a = model.actors.get(id);
  if (!a) {
    model.helperCount++;
    a = { id, kind: "helper", name: id === "sidechain" ? "Helper" : `Helper ${model.helperCount}`, role: "A helper agent", firstTs: ts };
    model.actors.set(id, a);
  }
  return a;
}

const niceName = (t) => {
  const s = String(t).replace(/[-_]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "Helper";
};

/** Helper metadata from <agent>.meta.json: its type, its job, and which brief started it. */
export function addAgentMeta(model, id, meta) {
  const a = ensureHelper(model, id, NaN);
  if (meta?.agentType) {
    a.type = String(meta.agentType);
    a.name = niceName(meta.agentType);
  }
  if (meta?.description) a.role = String(meta.description);
  if (meta?.model) a.model = String(meta.model);
  if (meta?.toolUseId) linkHelper(model, String(meta.toolUseId), id);
  model.changed++;
}

/** Connects a brief (Agent tool call) to the helper it started, and moves the helper's steps under that request. */
function linkHelper(model, toolUseId, helperId) {
  if (model.helperByTool.get(toolUseId) === helperId) return;
  model.helperByTool.set(toolUseId, helperId);
  const brief = model.tools.get(toolUseId);
  if (!brief) return;
  brief.to = helperId;
  for (const s of model.steps) {
    if (s.kind === "report" && s.toolId === toolUseId) s.actor = helperId;
    if ((s.actor === helperId || s.to === helperId) && s.request !== brief.request && s !== brief) moveStep(model, s, brief.request);
  }
}

function moveStep(model, step, request) {
  const from = model.requests[step.request];
  if (from) from.steps = from.steps.filter((s) => s !== step);
  step.request = request;
  const to = model.requests[request];
  if (to) {
    to.steps.push(step);
    to.dirty = true;
  }
}

/** The request a step belongs to: a helper's steps go with the brief that started it, others with the latest. */
function requestFor(model, actor, ts) {
  if (actor !== "claude" && actor !== "you") {
    for (const [toolId, helper] of model.helperByTool) {
      if (helper === actor) {
        const brief = model.tools.get(toolId);
        if (brief) return brief.request;
      }
    }
    // Not linked yet: the latest request that started before this step.
    for (let i = model.requests.length - 1; i >= 0; i--) if (!(model.requests[i].ts > ts)) return i;
  }
  return Math.max(0, model.requests.length - 1);
}

function ensureRequest(model, ts) {
  if (model.requests.length === 0) {
    model.requests.push({ index: 0, ts, kind: "prompt", text: "(the session started without a message)", steps: [], dirty: false });
  }
}

/** @param {Model} model @param {Partial<Step> & { kind: StepKind, actor: string, ts: number }} fields */
function addStep(model, fields) {
  ensureRequest(model, fields.ts);
  const step = /** @type {Step} */ ({
    id: `s${model.seq}`,
    seq: model.seq++,
    request: fields.request ?? requestFor(model, fields.actor, fields.ts),
    icon: "•",
    title: "",
    subtitle: "",
    what: "",
    why: "",
    ...fields,
  });
  model.steps.push(step);
  const req = model.requests[step.request];
  req.steps.push(step);
  req.dirty = true;
  return step;
}

/**
 * Adds a batch of records from the main log (source null) or a helper's log (source = helper id).
 * @param {Model} model
 * @param {string | null} source
 * @param {any[]} records
 */
export function addRecords(model, source, records) {
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    try {
      addRecord(model, source, r);
    } catch {
      // one odd record never stops the rest
    }
  }
  model.changed++;
}

function noteMeta(model, r, ts) {
  const m = model.meta;
  if (r.type === "custom-title" && typeof r.customTitle === "string") m.customTitle = r.customTitle;
  if (r.type === "ai-title" && typeof r.aiTitle === "string") m.aiTitle = r.aiTitle;
  if (typeof r.cwd === "string" && !m.cwd) m.cwd = r.cwd;
  if (typeof r.gitBranch === "string" && r.gitBranch) m.gitBranch = r.gitBranch;
  if (typeof r.version === "string") m.version = r.version;
  if (typeof r.permissionMode === "string") m.permissionMode = r.permissionMode;
  if (Number.isFinite(ts)) {
    if (!(m.firstTs <= ts)) m.firstTs = ts;
    if (!(m.lastTs >= ts)) m.lastTs = ts;
  }
}

function addRecord(model, source, r) {
  const ts = tsOf(r);
  noteMeta(model, r, ts);
  const actor = source ?? (r.isSidechain ? "sidechain" : "claude");
  if (actor !== "claude") ensureHelper(model, actor, ts);
  const when = Number.isFinite(ts) ? ts : model.meta.lastTs || 0;

  if (r.type === "user") return addUser(model, actor, r, when, source);
  if (r.type === "assistant") return addAssistant(model, actor, r, when);
  if (r.type === "system" && (r.level === "error" || r.subtype === "api_error")) {
    addStep(model, { kind: "problem", actor, ts: when, icon: "⚠️", title: "A problem reaching Claude", subtitle: "", what: "Claude Code couldn't get an answer from Claude for a moment (for example a network or rate-limit problem). It usually retries by itself.", why: "Connections sometimes fail.", text: typeof r.content === "string" ? r.content : "" });
  }
}

function addUser(model, actor, r, ts, source) {
  if (isToolResultRecord(r)) {
    let first = true;
    for (const b of r.message.content) {
      if (!b || b.type !== "tool_result") continue;
      const step = model.tools.get(String(b.tool_use_id));
      const output = textOf(b.content) || (typeof b.content === "string" ? b.content : "");
      if (!step) continue;
      step.output = output;
      const imgs = imagesOf(b.content);
      if (imgs.length) step.images = imgs;
      step.endTs = ts;
      step.status = b.is_error ? (DECLINED.test(output.slice(0, 500)) ? "declined" : "error") : "ok";
      if (first && r.toolUseResult) step.result = r.toolUseResult;
      first = false;
      if (step.kind === "brief") addReport(model, step, output, ts, r.toolUseResult);
    }
    return;
  }
  const p = userPrompt(r);
  if (!p) return;
  if (source || actor !== "claude") return; // a helper's first message is its brief, already shown
  if (p.kind === "prompt" || p.kind === "command") {
    const index = model.requests.length;
    model.requests.push({ index, ts, kind: p.kind, text: p.text, steps: [], dirty: false });
    addStep(model, {
      kind: p.kind, actor: "you", to: "claude", ts, request: index, icon: p.kind === "command" ? "⌘" : "💬",
      title: p.kind === "command" ? "You run a command" : "You ask Claude", subtitle: p.text.slice(0, 80),
      what: p.kind === "command" ? "You typed a slash command or a shell command in Claude Code." : "You sent Claude a message. Everything after this, until your next message, is Claude working on it.",
      why: "", text: p.text, images: imagesOf(r.message?.content),
    });
  } else {
    addStep(model, {
      kind: p.kind, actor: p.kind === "interrupt" ? "you" : "claude", ts, icon: p.kind === "interrupt" ? "✋" : "🗜️",
      title: p.kind === "interrupt" ? "You stopped Claude" : "Memory summarized", subtitle: "",
      what: p.kind === "interrupt" ? "You pressed Esc or Stop while Claude was working." : "Claude's memory was getting full, so the earlier conversation was replaced by a summary.",
      why: p.kind === "compact" ? "Claude can only keep so much text in mind at once." : "", text: p.text,
    });
  }
}

function addReport(model, brief, output, ts, result) {
  const m = /agentId:\s*([A-Za-z0-9_-]{1,100})/.exec(output);
  if (m && brief.toolId) {
    ensureHelper(model, m[1], ts);
    linkHelper(model, brief.toolId, m[1]);
  }
  const helper = brief.to ?? (brief.toolId ? model.helperByTool.get(brief.toolId) : undefined) ?? "sidechain";
  ensureHelper(model, helper, ts);
  const clean = output.replace(/\n?agentId:\s*[A-Za-z0-9_-]+[\s\S]*$/, "").trim();
  addStep(model, {
    kind: "report", actor: helper, to: brief.actor, ts, request: brief.request, icon: "📨", title: "Reports back",
    subtitle: clean.slice(0, 80), what: "The helper finished its job and sent its findings to Claude.",
    why: "Claude uses the report to decide what to do next.", text: clean, toolId: brief.toolId,
    status: brief.status === "ok" ? "ok" : brief.status, result,
  });
}

function addAssistant(model, actor, r, ts) {
  const msg = r.message;
  if (!msg || typeof msg !== "object") return;
  const modelName = typeof msg.model === "string" && !msg.model.startsWith("<") ? msg.model : undefined;
  if (modelName && !model.meta.models.includes(modelName)) model.meta.models.push(modelName);
  if (modelName && actor !== "claude") {
    const a = model.actors.get(actor);
    if (a && !a.model) a.model = modelName;
  }

  // One reply can be split over several records that repeat the same usage: count it once.
  const key = `${actor}:${msg.id ?? r.uuid}`;
  if (msg.usage && !model.seenMessages.has(key)) {
    model.seenMessages.add(key);
    const u = msg.usage;
    ensureRequest(model, ts);
    model.usage.push({
      actor, request: requestFor(model, actor, ts), model: modelName ?? "unknown", ts,
      input: num(u.input_tokens), cacheWrite: num(u.cache_creation_input_tokens), cacheRead: num(u.cache_read_input_tokens), output: num(u.output_tokens),
    });
  }

  if (r.isApiErrorMessage) {
    addStep(model, { kind: "problem", actor, ts, icon: "⚠️", title: "A problem reaching Claude", subtitle: "", what: "Claude Code got an error instead of an answer. It usually retries by itself.", why: "Connections and limits sometimes get in the way.", text: textOf(msg.content) });
    return;
  }
  if (!Array.isArray(msg.content)) return;
  const who = model.actors.get(actor)?.name ?? "Claude";
  for (const b of msg.content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      addStep(model, { kind: "reply", actor, ts, icon: "💭", title: `${who} says`, subtitle: b.text.trim().slice(0, 80), what: "What Claude wrote back.", why: "", text: b.text, model: modelName });
    } else if (b.type === "tool_use") {
      const name = String(b.name ?? "tool");
      const d = describeTool(name, b.input);
      const isBrief = AGENT_TOOLS.has(name);
      const step = addStep(model, {
        kind: isBrief ? "brief" : "tool", actor, to: isBrief ? model.helperByTool.get(String(b.id)) ?? null : undefined, ts,
        ...d, tool: name, toolId: String(b.id), input: b.input, status: "running", model: modelName,
        text: isBrief ? String(b.input?.prompt ?? "") : undefined,
      });
      model.tools.set(String(b.id), step);
    }
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** A helper's state: done when it has reported, failed when its brief failed, otherwise still working. */
export function helperState(model, id) {
  for (const [toolId, h] of model.helperByTool) {
    if (h !== id) continue;
    const brief = model.tools.get(toolId);
    if (brief?.status === "ok") return "done";
    if (brief?.status === "error" || brief?.status === "declined") return "failed";
    return "working";
  }
  return model.steps.some((s) => s.kind === "report" && s.actor === id) ? "done" : "working";
}
