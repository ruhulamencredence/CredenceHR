/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The one password rule, used by the server (every place a person sets or is
// given a password they chose) and by the forms that ask for one, so both
// say the same thing. Company policy: any password the person likes —
// short and simple ones too (e.g. 1234) — only not empty and not absurdly
// long. Wrong-password lockout (LoginGuard) still guards sign-in.
// Passwords the system makes itself (temporary ones, the 6-character bulk
// project logins) don't go through it.
export const PASSWORD_MIN = 1;
export const PASSWORD_HINT = 'Any password';

/** Why this password isn't allowed, or null when it is. */
export function passwordProblem(password: unknown, _who?: { email?: string | null; name?: string | null; username?: string | null }): string | null {
  const pw = typeof password === 'string' ? password : String(password ?? '');
  if (!pw) return 'Enter a password.';
  if (pw.length > 128) return 'The password can be at most 128 characters.';
  return null;
}
