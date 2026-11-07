// @ts-check
// The only way this page builds HTML: real elements and textContent. Log text can contain anything (web pages,
// code, HTML), so it is always shown as text, never interpreted. There is no innerHTML anywhere.

/**
 * h("div", { class: "x", onclick: fn, title: "t" }, "text", childEl, [more])
 * @param {string} tag
 * @param {Record<string, any> | null} [attrs]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "class") el.className = String(v);
      else if (k === "href") el.setAttribute("href", safeHref(v));
      else if (k === "src") el.setAttribute("src", safeSrc(v));
      else if (k === "style") throw new Error("Use classes, not inline styles (the CSP blocks them).");
      else el.setAttribute(k, v === true ? "" : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === undefined || c === null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

/** Only in-page links. */
function safeHref(v) {
  const s = String(v);
  return s.startsWith("#") ? s : "#";
}

/** Only base64 raster images (the model already filtered the type). */
function safeSrc(v) {
  const s = String(v);
  return /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/.test(s) ? s : "";
}

const SVG = "http://www.w3.org/2000/svg";

/** An SVG element with attributes. */
export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  for (const c of children) if (c) el.appendChild(c);
  return el;
}

/** Replaces an element's children. */
export function mount(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

/** Text clipped to n characters. */
export const clip = (s, n) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export const timeOf = (ts) => (Number.isFinite(ts) ? new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "");

export function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}

/** A stable colour (hue) per actor id. */
export function hueOf(id) {
  if (id === "you") return 210;
  if (id === "claude") return 25;
  let x = 0;
  for (const ch of id) x = (x * 31 + ch.charCodeAt(0)) % 360;
  return (x * 7 + 120) % 360;
}
