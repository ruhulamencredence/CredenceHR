/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Checks on an employee record's emails and date of birth, shared by
// Employees -> Add / Edit (EmployeeRoutes.ts) and HR Data Import
// (DataImportRoutes.ts). On an edit only the fields that changed are checked,
// so an old record with a bad value can still be saved for other changes.
//   - email / personal_email (and a login email): name@domain.tld
//   - date_of_birth: a real date, not in the future, aged MIN_EMPLOYEE_AGE..100
// MIN_EMPLOYEE_AGE is 14, the youngest age the Bangladesh Labour Act 2006
// (s.34) allows anyone to work at. Raise it here if company policy is 18.
export const MIN_EMPLOYEE_AGE = 14;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s.]{2,}$/;

const ageOn = (dob: string, today: string) => {
  const [y, m, d] = dob.split("-").map(Number);
  const [ty, tm, td] = today.split("-").map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
};

/** Why these employee fields can't be saved, or null when they can. */
export function employeeFieldProblem(
  fields: Record<string, any>,
  today: string,
  before?: Record<string, any> | null
): string | null {
  const changed = (k: string) => {
    const v = fields[k];
    if (v === undefined || v === null || String(v).trim() === "") return false;
    if (!before) return true;
    const old = before[k] instanceof Date ? before[k].toISOString().slice(0, 10) : before[k];
    return String(v).trim().slice(0, 10) !== String(old ?? "").trim().slice(0, 10) || k.includes("email") && String(v).trim() !== String(old ?? "").trim();
  };
  for (const [k, label] of [["email", "Email"], ["personal_email", "Personal Email"]] as const) {
    if (changed(k) && !EMAIL_RE.test(String(fields[k]).trim())) return `${label} "${String(fields[k]).trim().slice(0, 80)}" isn't a valid email address.`;
  }
  if (changed("login_email") && String(fields.login_email).includes("@") && !EMAIL_RE.test(String(fields.login_email).trim())) {
    return `Login email "${String(fields.login_email).trim().slice(0, 80)}" isn't a valid email address.`;
  }
  if (changed("date_of_birth")) {
    const dob = String(fields.date_of_birth).trim().slice(0, 10);
    const t = Date.parse(dob + "T00:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob) || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== dob) return `Date of Birth "${dob}" isn't a real date.`;
    if (dob > today) return "Date of Birth can't be in the future.";
    const age = ageOn(dob, today);
    if (age < MIN_EMPLOYEE_AGE) return `Date of Birth ${dob} makes this person ${age} — the minimum working age is ${MIN_EMPLOYEE_AGE}.`;
    if (age > 100) return `Date of Birth ${dob} makes this person ${age} — check the year.`;
  }
  return null;
}
