/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Pickers that hand someone work (assign, approve, give a SIM, file on
// behalf…) offer only people still here: a login that isn't blocked whose
// Employee record is active (GET /api/users -> employee_active). Whoever is
// already chosen stays in the list so an existing record still shows them.
// Report filters keep everyone, so a person who left can still be looked up.

export const isActivePerson = (u: { is_blocked?: any; employee_active?: boolean } | null | undefined) =>
  !!u && !Number(u.is_blocked) && u.employee_active !== false;

export function activePeople<T extends { id: number; is_blocked?: any; employee_active?: boolean }>(list: T[], ...keep: any[]): T[] {
  const kept = new Set(keep.filter((v) => v !== null && v !== undefined && v !== '').map((v) => Number(v)));
  return list.filter((u) => isActivePerson(u) || kept.has(Number(u.id)));
}
