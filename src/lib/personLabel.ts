/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// How a person reads in every employee / user picker (CLAUDE.md "Picking a
// person"): "Name · Employee ID · Designation · Department". Typing any of
// them finds the person in <SearchSelect>, which searches the option text.
// Accepts the field names the different APIs use for the same things.

export interface PersonLike {
  name?: string | null;
  employee_name?: string | null;
  full_name?: string | null;
  employee_code?: string | null;
  emp_code?: string | null;
  designation?: string | null;
  department?: string | null;
  department_name?: string | null;
  email?: string | null;
  username?: string | null;
}

/** The parts after the name: Employee ID · Designation · Department. */
export function personDetails(p: PersonLike | null | undefined): string {
  if (!p) return '';
  // (employee_id is a row id in some APIs and the code in others, so callers
  // pass the code as employee_code.)
  const code = p.employee_code || p.emp_code;
  return [code, p.designation, p.department || p.department_name]
    .map((v) => (v == null ? '' : String(v).trim()))
    .filter(Boolean)
    .join(' · ');
}

/** "Name · Employee ID · Designation · Department" (only the parts known). */
export function personLabel(p: PersonLike | null | undefined, fallback = ''): string {
  if (!p) return fallback;
  const name = String(p.name || p.employee_name || p.full_name || '').trim() || p.email || p.username || fallback;
  const rest = personDetails(p);
  return rest ? `${name} · ${rest}` : String(name);
}
