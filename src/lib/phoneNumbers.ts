/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Phone numbers as people typed them into an Employee's Mobile / Phone cells
// (or an Excel import put them there): several in one cell, with commas,
// slashes, new lines — or with nothing at all between them
// ("018960554040156786651701741812421" is three Bangladeshi mobiles). Each
// comes out on its own, once, so each can be called.

const key = (n: string) => n.replace(/\D/g, '').replace(/^(?:00)?88(?=01\d{9}$)/, '');

export function splitPhones(raw: string | null | undefined): string[] {
  const out: string[] = [];
  if (!raw) return out;
  for (const part of String(raw).split(/[,;/|\n]+/)) {
    const p = part.trim();
    if (!p) continue;
    const digits = p.replace(/\D/g, '');
    // A run of 11-digit mobiles (01XXXXXXXXX, maybe with 88 in front) glued
    // together, or kept apart only by spaces / dashes.
    if (digits.length > 13) {
      const runs = digits.match(/(?:88)?01\d{9}/g);
      if (runs && runs.join('').length === digits.length) {
        out.push(...runs);
        continue;
      }
    }
    out.push(p);
  }
  return out;
}

// Mobile first, then Phone; the same number twice is shown once.
export function phonesOf(mobile: string | null | undefined, phone: string | null | undefined): { number: string; label: 'Mobile' | 'Phone' }[] {
  const seen = new Set<string>();
  const out: { number: string; label: 'Mobile' | 'Phone' }[] = [];
  for (const [raw, label] of [
    [mobile, 'Mobile'],
    [phone, 'Phone']
  ] as const) {
    for (const n of splitPhones(raw)) {
      const k = key(n);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push({ number: n, label });
    }
  }
  return out;
}

// 01896055404 -> "01896-055404", 8801896055404 -> "+880 1896-055404";
// anything else as typed.
export function formatPhone(n: string): string {
  const d = n.replace(/\D/g, '');
  if (/^01\d{9}$/.test(d)) return `${d.slice(0, 5)}-${d.slice(5)}`;
  if (/^8801\d{9}$/.test(d)) return `+880 ${d.slice(3, 7)}-${d.slice(7)}`;
  return n.trim();
}

// What a tel: link dials.
export const telHref = (n: string) => `tel:${n.trim().startsWith('+') ? '+' : ''}${n.replace(/\D/g, '')}`;
