// @ts-check
// Small helpers for reading Claude Code log records. Pure functions, used by both the server and the page.

/** @typedef {Record<string, any>} LogRecord */

/** Plain text of a message's content: a string, or the text blocks of an array joined. */
export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const b of content) {
    if (b && typeof b === "object" && b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

const SAFE_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Base64 images in a content array, only in safe raster formats (never SVG, which can carry script). */
export function imagesOf(content) {
  /** @type {{ mediaType: string, data: string }[]} */
  const out = [];
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    const src = b && b.type === "image" ? b.source : null;
    if (src && src.type === "base64" && SAFE_IMAGE.has(src.media_type) && typeof src.data === "string") {
      out.push({ mediaType: src.media_type, data: src.data });
    }
  }
  return out;
}

export const isSafeImageType = (t) => SAFE_IMAGE.has(t);

/** True for a "user" record that only carries tool results (Claude Code writes those as user turns). */
export function isToolResultRecord(r) {
  const c = r?.message?.content;
  return Array.isArray(c) && c.some((b) => b && b.type === "tool_result");
}

const NOISE_TAGS = /^<(local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-stdout|bash-stderr|task-notification)>/;

/**
 * What a "user" record means to a person reading the session, or null when it isn't something you typed.
 * @param {LogRecord} r
 * @returns {null | { kind: "prompt" | "command" | "interrupt" | "compact", text: string }}
 */
export function userPrompt(r) {
  if (!r || r.type !== "user") return null;
  if (r.isCompactSummary) return { kind: "compact", text: "The earlier conversation was summarized to free up memory." };
  if (r.isMeta) return null;
  const content = r.message?.content;
  if (isToolResultRecord(r)) return null;
  const text = textOf(content).trim();
  if (!text) return imagesOf(content).length ? { kind: "prompt", text: "(an image)" } : null;
  if (/^\[Request interrupted/.test(text)) return { kind: "interrupt", text: "You stopped Claude." };
  const cmd = /<command-name>([^<]{1,200})<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([^<]{0,2000})<\/command-args>/.exec(text)?.[1]?.trim();
    return { kind: "command", text: `${cmd[1].trim()}${args ? ` ${args}` : ""}` };
  }
  const bash = /^<bash-input>([\s\S]{0,4000}?)<\/bash-input>/.exec(text);
  if (bash) return { kind: "command", text: `! ${bash[1].trim()}` };
  if (NOISE_TAGS.test(text)) return null;
  return { kind: "prompt", text };
}

/** ISO timestamp → milliseconds, or NaN. */
export function tsOf(r) {
  return typeof r?.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
}

/**
 * Title and basics from a slice of records, for the session list.
 * @param {LogRecord[]} records
 */
export function summarize(records) {
  /** @type {{ title?: string, customTitle?: string, aiTitle?: string, firstPrompt?: string, cwd?: string, gitBranch?: string, firstTs?: number, lastTs?: number, models: string[] }} */
  const s = { models: [] };
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    if (r.type === "custom-title" && typeof r.customTitle === "string") s.customTitle = r.customTitle;
    if (r.type === "ai-title" && typeof r.aiTitle === "string") s.aiTitle = r.aiTitle;
    if (!s.cwd && typeof r.cwd === "string") s.cwd = r.cwd;
    if (!s.gitBranch && typeof r.gitBranch === "string" && r.gitBranch) s.gitBranch = r.gitBranch;
    const t = tsOf(r);
    if (Number.isFinite(t)) {
      if (s.firstTs === undefined || t < s.firstTs) s.firstTs = t;
      if (s.lastTs === undefined || t > s.lastTs) s.lastTs = t;
    }
    if (!s.firstPrompt && !r.isSidechain) {
      const p = userPrompt(r);
      if (p && p.kind === "prompt") s.firstPrompt = p.text;
    }
    const m = r.message?.model;
    if (typeof m === "string" && !m.startsWith("<") && !s.models.includes(m)) s.models.push(m);
  }
  s.title = s.customTitle || s.aiTitle || s.firstPrompt;
  return s;
}
