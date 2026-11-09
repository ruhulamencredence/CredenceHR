/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Adds values to an ENUM column without ever dropping one.
//
// The old startup pattern ran a chain of `MODIFY COLUMN x ENUM(<old list>)`
// then `ENUM(<old list + new>)` on every start. On a MySQL / MariaDB whose
// sql_mode is not strict (common on shared hosting), the first, narrower
// MODIFY doesn't fail — it silently turns every row holding a newer value
// into '' — so Vehicle / Mobile / Loan approval templates lost their Request
// Type (and vanished from their tab) on each restart, and assigned /
// expired rides lost their status. This reads the column's current list and
// only ALTERs when a wanted value is missing, keeping every value already
// there.

export async function widenEnum(dbPool: any, table: string, column: string, wanted: string[], tail: string): Promise<void> {
  const [rows]: any = await dbPool.query(`SHOW COLUMNS FROM \`${table}\` LIKE ?`, [column]);
  const type = String((Array.isArray(rows) ? rows[0] : null)?.Type ?? (Array.isArray(rows) ? rows[0]?.type : "") ?? "");
  const m = /^enum\((.*)\)$/i.exec(type.trim());
  if (!m) return; // not an ENUM (or the column is missing) — nothing safe to do
  const current = Array.from(m[1].matchAll(/'((?:[^']|'')*)'/g)).map((x) => x[1].replace(/''/g, "'"));
  if (wanted.every((v) => current.includes(v))) return;
  const all = [...wanted, ...current.filter((v) => !wanted.includes(v))];
  const list = all.map((v) => `'${v.replace(/'/g, "''")}'`).join(",");
  await dbPool.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ENUM(${list}) ${tail}`);
}
