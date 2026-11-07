// @ts-check
// Everything that decides whether a request is allowed to see anything.
// Threats handled here:
//  - Other websites in your browser (CSRF, DNS rebinding): Host, Origin and Sec-Fetch-Site checks.
//  - Other programs or users on this computer: a random per-launch secret, held in an HttpOnly cookie.
//  - Script injection from log content: a strict Content-Security-Policy (the page also never uses innerHTML).
//  - Transcripts saved by the browser: Cache-Control: no-store on every response.
import crypto from "node:crypto";

/** A fresh 256-bit secret for this launch only. Never written to disk. */
export function createSecret() {
  return crypto.randomBytes(32).toString("hex");
}

/** Constant-time string comparison, so the secret can't be guessed byte by byte from timings. */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** The only Host headers we answer. Anything else may be a DNS-rebinding attack. */
export function isAllowedHost(host, port) {
  if (typeof host !== "string") return false;
  const h = host.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

/** Requests from another origin are refused. No Origin header (a plain navigation) is fine. */
export function isAllowedOrigin(origin, port) {
  if (origin === undefined) return true;
  if (typeof origin !== "string") return false;
  const o = origin.toLowerCase();
  return o === `http://127.0.0.1:${port}` || o === `http://localhost:${port}` || o === `http://[::1]:${port}`;
}

/** Browsers tell us when a request was started by another site; refuse those. */
export function isAllowedFetchSite(site) {
  return site === undefined || site === "same-origin" || site === "none";
}

/** The cookie name includes the port, so two copies on different ports don't overwrite each other. */
export const cookieName = (port) => `agent_replay_${port}`;

/** Session cookie: HttpOnly (page scripts can't read it), SameSite=Strict, no expiry (gone when the browser closes). */
export function sessionCookie(port, secret) {
  return `${cookieName(port)}=${secret}; HttpOnly; SameSite=Strict; Path=/`;
}

/** Reads one cookie value from a Cookie header without any parsing library. */
export function readCookie(header, name) {
  if (typeof header !== "string") return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

/** Sent on every response. */
export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": CSP,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), payment=()",
  "Cache-Control": "no-store",
  Pragma: "no-cache",
});
