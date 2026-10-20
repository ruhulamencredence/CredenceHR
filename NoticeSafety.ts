/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Notices are written as HTML by an Admin and shown to everyone they target
// (the login popup, the Notice board). Whatever is stored or sent back out is
// cleaned here first, so a notice can format text, link and show pictures but
// never run code in a reader's browser (where the sign-in token lives):
//   - sanitizeNoticeHtml: only plain formatting tags; no scripts, frames,
//     forms, event handlers (onerror…), javascript: links or CSS url();
//   - safeLottieJson: a pasted Lottie animation without expressions (Lottie
//     runs those as JavaScript);
//   - safeLottieUrl: an http(s) address only.
// Applied on save and again on every read, so notices saved before this are
// covered too. The client cleans once more before drawing (src/lib/noticeHtml.ts).

import sanitizeHtml from "sanitize-html";

// CSS values that may load or run something.
const UNSAFE_CSS = /url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|-moz-binding/i;
const anyValue = [/^(?!.*(url\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|-moz-binding)).*$/i];
const STYLE_PROPS = [
  "color", "background-color", "font-size", "font-weight", "font-style", "font-family", "text-align", "text-decoration",
  "line-height", "letter-spacing", "margin", "margin-top", "margin-bottom", "margin-left", "margin-right", "padding",
  "padding-top", "padding-bottom", "padding-left", "padding-right", "border", "border-radius", "border-color",
  "border-width", "border-style", "width", "max-width", "height", "display", "vertical-align", "white-space"
];

const NOTICE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "br", "hr", "div", "span", "b", "strong", "i", "em", "u", "s", "strike", "sub", "sup", "small", "mark", "code", "pre",
    "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "ul", "ol", "li", "a", "img", "font", "center",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col"
  ],
  allowedAttributes: {
    "*": ["style", "class", "align", "title", "dir"],
    a: ["href", "target", "rel", "name"],
    img: ["src", "alt", "width", "height"],
    font: ["color", "size", "face"],
    td: ["colspan", "rowspan", "width", "valign"],
    th: ["colspan", "rowspan", "width", "valign"],
    col: ["span", "width"],
    table: ["width", "cellpadding", "cellspacing", "border"]
  },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  allowedSchemesAppliedToAttributes: ["href", "src"],
  allowProtocolRelative: false,
  allowedStyles: { "*": Object.fromEntries(STYLE_PROPS.map((p) => [p, anyValue])) },
  // Script / style contents are dropped, not shown as text.
  nonTextTags: ["script", "style", "textarea", "noscript", "iframe", "object", "embed"],
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer" } }),
    // A data: picture must really be a picture.
    img: (tagName, attribs) => {
      const src = String(attribs.src || "");
      if (/^data:/i.test(src) && !/^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(src)) {
        const { src: _drop, ...rest } = attribs;
        return { tagName, attribs: rest };
      }
      return { tagName, attribs };
    }
  }
};

export function sanitizeNoticeHtml(html: unknown): string {
  const clean = sanitizeHtml(String(html ?? ""), NOTICE_OPTIONS);
  // Belt and braces for style values the per-property rule let through.
  return UNSAFE_CSS.test(clean) ? clean.replace(/style="[^"]*"/gi, (m) => (UNSAFE_CSS.test(m) ? "" : m)) : clean;
}

// Lottie keeps an expression as a string in a property named "x"; the full
// player runs it as JavaScript. Every such string (and any "xs" helper) goes.
function dropExpressions(node: any): void {
  if (Array.isArray(node)) {
    for (const v of node) dropExpressions(v);
    return;
  }
  if (!node || typeof node !== "object") return;
  for (const key of Object.keys(node)) {
    const v = node[key];
    if ((key === "x" || key === "xs") && typeof v === "string") delete node[key];
    else dropExpressions(v);
  }
}

export function safeLottieJson(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    dropExpressions(parsed);
    return JSON.stringify(parsed);
  } catch {
    return null;
  }
}

export function safeLottieUrl(value: unknown): string | null {
  const s = String(value ?? "").trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s.slice(0, 1000) : null;
}

// A notice row as sent to a browser.
export function safeNoticeFields<T extends { content_html?: any; lottie_json?: any; lottie_url?: any }>(n: T): T {
  return {
    ...n,
    content_html: sanitizeNoticeHtml(n.content_html),
    lottie_json: n.lottie_json ? safeLottieJson(n.lottie_json) : null,
    lottie_url: n.lottie_url ? safeLottieUrl(n.lottie_url) : null
  };
}
