/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Remembers which one-time startup steps have already run (and, for the
// .env Superadmin, which .env values were last applied), so a server restart
// never repeats them over what people changed since. Without it, a restart:
//  - copied every Head-office-only holiday onto the Project-site calendar,
//  - re-created "Migrated Global Chain" templates an admin had deleted,
//  - put the .env password and name back on the Superadmin after they
//    changed their own.
// Table: startup_migrations (name, done_at, value).

let ensured = false;

async function ensure(dbPool: any) {
  if (ensured) return;
  await dbPool.query(`
    CREATE TABLE IF NOT EXISTS startup_migrations (
      name VARCHAR(100) NOT NULL PRIMARY KEY,
      done_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      value VARCHAR(255) NULL
    )
  `);
  ensured = true;
}

// The step's record, or null if it never ran.
export async function getStartupMarker(dbPool: any, name: string): Promise<{ value: string | null } | null> {
  await ensure(dbPool);
  const [rows]: any = await dbPool.query("SELECT value FROM startup_migrations WHERE name = ?", [name]);
  return Array.isArray(rows) && rows.length ? { value: rows[0].value ?? null } : null;
}

export async function setStartupMarker(dbPool: any, name: string, value: string | null = null): Promise<void> {
  await ensure(dbPool);
  await dbPool.query(
    "INSERT INTO startup_migrations (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), done_at = CURRENT_TIMESTAMP",
    [name, value]
  );
}
