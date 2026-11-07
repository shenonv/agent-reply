// @ts-check
// Data minimisation: only the fields the page actually shows leave the server. Everything else in a log record
// (tool schemas, system prompts, signatures, Claude's private thinking, API blobs) is dropped here.
import { isSafeImageType } from "../core/records.js";

const KEEP_TYPES = new Set(["user", "assistant", "system", "summary", "custom-title", "ai-title", "agent-name"]);
const TOP_FIELDS = [
  "type", "uuid", "parentUuid", "timestamp", "sessionId", "agentId", "isSidechain", "isMeta", "isCompactSummary",
  "cwd", "gitBranch", "version", "entrypoint", "permissionMode", "subtype", "level", "content", "customTitle",
  "aiTitle", "agentName", "summary", "isApiErrorMessage",
];
const USAGE_FIELDS = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"];
const RESULT_FIELDS = ["type", "filePath", "oldString", "newString", "originalFile", "stdout", "stderr", "interrupted", "durationMs", "totalDurationMs", "agentId", "status", "numFiles", "totalTokens"];

const MAX_TEXT = 2 * 1024 * 1024; // longest single text we pass on
const MAX_IMAGE = 8 * 1024 * 1024; // largest base64 image we pass on
const BASE64 = /^[A-Za-z0-9+/=\r\n]*$/;

/** @param {Record<string, any>} src @param {string[]} keys */
function pick(src, keys) {
  /** @type {Record<string, unknown>} */
  const out = Object.create(null);
  for (const k of keys) {
    const v = src[k];
    if (v === undefined) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean" || v === null) out[k] = clipStr(v);
  }
  return out;
}

const clipStr = (v) => (typeof v === "string" && v.length > MAX_TEXT ? `${v.slice(0, MAX_TEXT)}\n… (cut: too long to show)` : v);

/** Copies plain JSON (strings clipped), depth-limited, for tool inputs. */
function plain(v, depth = 0) {
  if (typeof v === "string") return clipStr(v);
  if (typeof v === "number" || typeof v === "boolean" || v === null) return v;
  if (depth > 8) return undefined;
  if (Array.isArray(v)) return v.slice(0, 1000).map((x) => plain(x, depth + 1));
  if (v && typeof v === "object") {
    /** @type {Record<string, unknown>} */
    const out = Object.create(null);
    let n = 0;
    for (const [k, x] of Object.entries(v)) {
      if (n++ > 200) break;
      if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
      out[k] = plain(x, depth + 1);
    }
    return out;
  }
  return undefined;
}

function slimImage(b) {
  const s = b?.source;
  if (!s || s.type !== "base64" || !isSafeImageType(s.media_type) || typeof s.data !== "string") return null;
  if (s.data.length > MAX_IMAGE || !BASE64.test(s.data)) return null;
  return { type: "image", source: { type: "base64", media_type: s.media_type, data: s.data } };
}

function slimBlocks(content) {
  if (typeof content === "string") return clipStr(content);
  if (!Array.isArray(content)) return undefined;
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") out.push({ type: "text", text: clipStr(b.text) });
    else if (b.type === "thinking" || b.type === "redacted_thinking") out.push({ type: "thinking" }); // presence only
    else if (b.type === "tool_use") out.push({ type: "tool_use", id: String(b.id ?? ""), name: String(b.name ?? ""), input: plain(b.input) });
    else if (b.type === "tool_result") {
      out.push({ type: "tool_result", tool_use_id: String(b.tool_use_id ?? ""), is_error: b.is_error === true, content: slimBlocks(b.content) });
    } else if (b.type === "image") {
      const img = slimImage(b);
      if (img) out.push(img);
    }
  }
  return out;
}

/**
 * The parts of one log record the page needs, or null to drop it entirely.
 * @param {unknown} r
 */
export function slimRecord(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const rec = /** @type {Record<string, any>} */ (r);
  if (!KEEP_TYPES.has(rec.type)) return null;
  const out = pick(rec, TOP_FIELDS);
  const m = rec.message;
  if (m && typeof m === "object") {
    /** @type {Record<string, unknown>} */
    const msg = pick(m, ["id", "role", "model", "stop_reason"]);
    const content = slimBlocks(m.content);
    if (content !== undefined) msg.content = content;
    if (m.usage && typeof m.usage === "object") msg.usage = pick(m.usage, USAGE_FIELDS);
    out.message = msg;
  }
  const tur = rec.toolUseResult;
  if (tur && typeof tur === "object" && !Array.isArray(tur)) {
    const res = pick(tur, RESULT_FIELDS);
    if (tur.file && typeof tur.file === "object") res.file = pick(tur.file, ["filePath", "numLines", "startLine", "totalLines"]);
    out.toolUseResult = res;
  }
  return out;
}

/** Helper metadata: four short fields, nothing else. */
export function slimAgentMeta(meta) {
  if (!meta || typeof meta !== "object") return {};
  return pick(meta, ["agentType", "description", "toolUseId", "model"]);
}
