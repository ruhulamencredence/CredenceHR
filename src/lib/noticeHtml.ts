/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// A notice's HTML, cleaned once more right before it is drawn (the server
// already cleans it on save and on read, NoticeSafety.ts): plain formatting,
// links and pictures only — no scripts, frames, forms, event handlers or
// javascript: links. Links open in a new tab.

import DOMPurify from 'dompurify';

let hooked = false;
export function sanitizeNoticeHtml(html: string | null | undefined): string {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }
  return DOMPurify.sanitize(html || '', {
    FORBID_TAGS: ['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base', 'svg', 'math'],
    FORBID_ATTR: ['srcdoc', 'formaction', 'action'],
    ADD_ATTR: ['target'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|data:image\/(?:png|jpe?g|gif|webp);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i
  }) as unknown as string;
}
