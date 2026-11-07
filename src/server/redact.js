// @ts-check
// "Hide private info": masks secrets and personal details in text before it leaves the server.
// It works by recognising patterns, so it is a safety net, not a guarantee.
import os from "node:os";

export const MASK = "‹hidden›";

/** [pattern, replacement]. Every pattern is linear (no nested quantifiers), so huge strings can't stall it. */
const RULES = /** @type {[RegExp, string][]} */ ([
  // Private key blocks
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]{0,20000}?-----END [A-Z ]{0,40}PRIVATE KEY-----/g, MASK],
  // Provider keys and tokens
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/g, MASK], // Anthropic
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g, MASK], // OpenAI
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, MASK], // GitHub
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK], // GitLab
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, MASK], // AWS access key id
  [/\b[rsp]k_(?:live|test)_[A-Za-z0-9]{10,}/g, MASK], // Stripe
  [/\bwhsec_[A-Za-z0-9]{10,}/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, MASK], // Slack
  [/\bAIza[0-9A-Za-z_-]{35}/g, MASK], // Google
  [/\bnpm_[A-Za-z0-9]{36}\b/g, MASK], // npm
  [/\bhf_[A-Za-z0-9]{30,}/g, MASK], // Hugging Face
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, MASK], // SendGrid
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK], // JWT
  // Sign-in headers and bearer tokens
  [/(\bauthorization\b["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;]{4,}/gi, `$1${MASK}`],
  [/(\bbearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, `$1${MASK}`],
  [/(\b(?:x-api-key|api-key|x-auth-token)\b["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi, `$1${MASK}`],
  // Passwords inside addresses: postgres://user:pw@host
  [/(\b[a-z][\w+.-]{0,20}:\/\/[^\s:/@]{0,100}:)[^\s@/]{1,200}(?=@)/gi, `$1${MASK}`],
  // NAME_SECRET=value, API_KEY: value, password=value
  [/(\b[A-Za-z0-9_]{0,40}(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_?SECRET|CREDENTIALS?)[A-Za-z0-9_]{0,40}\s{0,3}[=:]\s{0,3}["']?)[^\s"'`,;]{3,}/gi, `$1${MASK}`],
  // "password": "value" in JSON
  [/("(?:password|passwd|secret|token|api_?key|apikey|access_?token|refresh_?token|client_?secret|private_?key)"\s{0,3}:\s{0,3}")[^"]{1,500}"/gi, `$1${MASK}"`],
  // Email addresses
  [/\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}\b/g, MASK],
]);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Builds the personal-detail rules (home folder, user name) for this computer. */
export function personalRules(home = os.homedir(), user = safeUserName()) {
  /** @type {[RegExp, string][]} */
  const rules = [];
  if (home && home.length > 3) {
    const variants = new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")]);
    for (const v of variants) rules.push([new RegExp(escapeRe(v), "gi"), "~"]);
  }
  if (user && user.length >= 3) {
    // Whole word only, so "dev" doesn't eat "devices". Also covers Claude Code's dash-spelled folder names.
    rules.push([new RegExp(`(?<![A-Za-z0-9])${escapeRe(user)}(?![A-Za-z0-9])`, "gi"), "‹user›"]);
  }
  return rules;
}

function safeUserName() {
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
}

/** Creates a masker. `personal` rules are separate so tests can pass a fake home and user. */
export function createRedactor(personal = personalRules()) {
  const all = [...RULES, ...personal];
  /** @param {string} text */
  return function redact(text) {
    if (typeof text !== "string" || text.length === 0) return text;
    let out = text;
    for (const [re, rep] of all) {
      re.lastIndex = 0;
      out = out.replace(re, rep);
    }
    return out;
  };
}

/**
 * Masks every string (and object key) inside a JSON value. Base64 image data ({type:"base64", data}) is left
 * alone: masking would corrupt it, and it is pixels, not text. Returns a new value; the input is not changed.
 * @param {unknown} value
 * @param {(s: string) => string} redact
 * @returns {unknown}
 */
export function redactDeep(value, redact) {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === "object") {
    const isBase64 = /** @type {any} */ (value).type === "base64";
    /** @type {Record<string, unknown>} */
    const out = Object.create(null);
    for (const [k, v] of Object.entries(value)) {
      out[redact(k)] = isBase64 && k === "data" ? v : redactDeep(v, redact);
    }
    return out;
  }
  return value;
}
