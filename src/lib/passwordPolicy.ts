/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The one password rule, used by the server (every place a person sets or is
// given a password they chose) and by the forms that ask for one, so both
// say the same thing. Passwords the system makes itself (temporary ones,
// the 6-character bulk project logins) don't go through it.
//   - 8 to 128 characters
//   - at least one letter and one number
//   - not one character repeated, not a run like 12345678 / abcdefgh
//   - not a well-known password, and not the person's own email / name
export const PASSWORD_MIN = 8;
export const PASSWORD_HINT = 'At least 8 characters, with letters and numbers';

const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'qwerty123', 'qwertyuiop',
  'abc12345', 'abcd1234', 'admin123', 'admin1234', 'administrator', 'welcome1', 'welcome123', 'iloveyou1', 'letmein1',
  'changeme', 'changeme1', 'credence1', 'credence123', 'bangladesh1', 'dhaka1234', '1q2w3e4r', '1qaz2wsx', 'zaq12wsx',
  'asdf1234', 'qwer1234', 'pass1234', 'test1234', 'user1234'
]);

const isRun = (s: string) => {
  if (s.length < 4) return false;
  const d = s.charCodeAt(1) - s.charCodeAt(0);
  if (Math.abs(d) !== 1) return false;
  for (let i = 2; i < s.length; i++) if (s.charCodeAt(i) - s.charCodeAt(i - 1) !== d) return false;
  return true;
};

/** Why this password isn't allowed, or null when it is. */
export function passwordProblem(password: unknown, who?: { email?: string | null; name?: string | null; username?: string | null }): string | null {
  const pw = typeof password === 'string' ? password : String(password ?? '');
  if (pw.length < PASSWORD_MIN) return `The password must be at least ${PASSWORD_MIN} characters.`;
  if (pw.length > 128) return 'The password can be at most 128 characters.';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'The password needs at least one letter and one number.';
  const low = pw.toLowerCase();
  if (/^(.)\1+$/.test(low) || isRun(low) || COMMON.has(low)) return 'This password is too easy to guess — choose another.';
  for (const v of [who?.email, who?.username, who?.name]) {
    const base = String(v || '').toLowerCase().split('@')[0].replace(/\s+/g, '');
    if (base.length >= 4 && low.replace(/[^a-z0-9]/g, '').includes(base.replace(/[^a-z0-9]/g, ''))) return "The password can't contain your email or name.";
  }
  return null;
}
