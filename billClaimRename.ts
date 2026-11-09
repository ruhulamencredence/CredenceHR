/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// One-time move of an existing database from the old "Conveyance claim" /
// "user claim" names to "Bill Claim". Runs at start-up right after the base
// schema and BEFORE ensureSchemaMigrations, so the CREATE TABLE IF NOT EXISTS
// / ALTER statements there find the new names already in place and don't make
// empty twins. Every step checks first, so it does nothing on a new database
// or on one that was already moved; a failed step is only logged.
//
//   tables   user_claims, user_claim_items, user_claim_references,
//            user_claim_history -> bill_claims, bill_claim_*;
//            conveyance_claim_department_access -> bill_claim_department_access
//   columns  *.user_claim_id -> bill_claim_id;
//            users.can_view_conveyance_claims -> can_view_bill_claims
//   values   approval source 'user_claim' -> 'bill_claim'; approval request
//            type and Admin module 'conveyance' -> 'bill_claim'; data import
//            layer 'import_conveyance' -> 'import_bill_claims'; alert types
//            'conveyance_claim' / 'conveyance_approval' -> 'bill_claim' /
//            'bill_claim_approval'.
//
// Conveyance Bills (conveyance_bills, conveyance_bill_items, the disburser
// step) are a separate thing and keep their names.

type Pool = { query: (sql: string, params?: unknown[]) => Promise<any> };

const TABLES: [string, string][] = [
  ["user_claims", "bill_claims"],
  ["user_claim_items", "bill_claim_items"],
  ["user_claim_references", "bill_claim_references"],
  ["user_claim_history", "bill_claim_history"],
  ["conveyance_claim_department_access", "bill_claim_department_access"],
];

const COLUMNS: [string, string][] = [
  ["user_claim_id", "bill_claim_id"],
  ["can_view_conveyance_claims", "can_view_bill_claims"],
];

const ENUMS: [table: string, column: string, from: string, to: string][] = [
  ["approval_requests", "source_type", "user_claim", "bill_claim"],
  ["conveyance_bill_items", "source", "user_claim", "bill_claim"],
  ["approval_templates", "request_type", "conveyance", "bill_claim"],
  ["employee_template_assignments", "request_type", "conveyance", "bill_claim"],
];

const VALUES: [table: string, column: string, from: string, to: string][] = [
  ["admin_module_permissions", "module_key", "conveyance", "bill_claim"],
  ["admin_module_permission_layers", "module_key", "conveyance", "bill_claim"],
  ["admin_module_permission_layers", "layer_key", "import_conveyance", "import_bill_claims"],
  ["user_app_access", "item_key", "conveyance", "bill_claim"],
  ["user_app_access", "item_key", "can_view_conveyance_claims", "can_view_bill_claims"],
  ["alerts", "type", "conveyance_claim", "bill_claim"],
  ["alerts", "type", "conveyance_approval", "bill_claim_approval"],
  ["alerts", "related_type", "user_claim", "bill_claim"],
];

// Saved access templates keep their ticks as JSON text.
const JSON_TEXT: [table: string, column: string][] = [
  ["access_templates", "features_json"],
  ["access_templates", "modules_json"],
];
const JSON_TOKENS: [string, string][] = [
  ['"conveyance"', '"bill_claim"'],
  ['"can_view_conveyance_claims"', '"can_view_bill_claims"'],
  ['"import_conveyance"', '"import_bill_claims"'],
];

const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";

export async function renameConveyanceClaimToBillClaim(dbPool: Pool | null): Promise<void> {
  if (!dbPool) return;
  const rows = async (sql: string, params: unknown[] = []): Promise<any[]> => {
    const [r] = await dbPool.query(sql, params);
    return Array.isArray(r) ? r : [];
  };
  const step = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err: any) {
      console.warn(`⚠️ Bill Claim rename — ${what}: ${err?.message || err}`);
    }
  };
  const tableExists = async (t: string) =>
    (await rows("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [t])).length > 0;
  const columnInfo = async (t: string, c: string) =>
    (await rows(
      "SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
      [t, c]
    ))[0] || null;
  // MariaDB reports a string default already quoted ('manual'), MySQL bare.
  const defaultOf = (col: any): string | null => {
    const d = col?.COLUMN_DEFAULT;
    if (d === null || d === undefined || d === "NULL") return null;
    const s = String(d);
    return s.length >= 2 && s.startsWith("'") && s.endsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s;
  };

  let moved = 0;

  for (const [from, to] of TABLES) {
    await step(`table ${from}`, async () => {
      if ((await tableExists(from)) && !(await tableExists(to))) {
        await dbPool.query(`RENAME TABLE \`${from}\` TO \`${to}\``);
        moved++;
      }
    });
  }

  for (const [from, to] of COLUMNS) {
    await step(`column ${from}`, async () => {
      const tables = await rows(
        "SELECT TABLE_NAME AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME = ?",
        [from]
      );
      for (const { t } of tables) {
        if (await columnInfo(t, to)) continue;
        try {
          await dbPool.query(`ALTER TABLE \`${t}\` RENAME COLUMN \`${from}\` TO \`${to}\``);
        } catch {
          // Older MySQL without RENAME COLUMN: restate the column.
          const col = await columnInfo(t, from);
          const def = defaultOf(col);
          await dbPool.query(
            `ALTER TABLE \`${t}\` CHANGE COLUMN \`${from}\` \`${to}\` ${col.COLUMN_TYPE} ${col.IS_NULLABLE === "YES" ? "NULL" : "NOT NULL"}` +
              (def !== null ? ` DEFAULT ${/^-?\d+(\.\d+)?$/.test(def) ? def : q(def)}` : "")
          );
        }
        moved++;
      }
    });
  }

  // Index names carry the old table name; rename so the "CREATE INDEX ...
  // idx_bill_claims_*" in the migrations doesn't add a duplicate index.
  await step("index names", async () => {
    const idx = await rows(
      "SELECT DISTINCT TABLE_NAME AS t, INDEX_NAME AS i FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME LIKE '%user\\_claim%'"
    );
    for (const { t, i } of idx) {
      const next = String(i).replace(/user_claim/g, "bill_claim");
      const clash = await rows(
        "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?",
        [t, next]
      );
      if (clash.length) continue;
      await dbPool.query(`ALTER TABLE \`${t}\` RENAME INDEX \`${i}\` TO \`${next}\``);
    }
  });

  for (const [table, column, from, to] of ENUMS) {
    await step(`${table}.${column}`, async () => {
      const col = await columnInfo(table, column);
      if (!col || !String(col.COLUMN_TYPE).startsWith("enum(")) return;
      const values = [...String(col.COLUMN_TYPE).matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
      if (!values.includes(from)) return;
      const def = defaultOf(col);
      const tail = (newDefault: string | null) =>
        `${col.IS_NULLABLE === "YES" ? "NULL" : "NOT NULL"}` + (newDefault !== null ? ` DEFAULT ${q(newDefault)}` : "");
      const both = values.includes(to) ? values : [...values, to];
      await dbPool.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ENUM(${both.map(q).join(",")}) ${tail(def)}`);
      await dbPool.query(`UPDATE \`${table}\` SET \`${column}\` = ? WHERE \`${column}\` = ?`, [to, from]);
      const final = both.filter((v) => v !== from);
      await dbPool.query(
        `ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ENUM(${final.map(q).join(",")}) ${tail(def === from ? to : def)}`
      );
      moved++;
    });
  }

  for (const [table, column, from, to] of VALUES) {
    await step(`${table}.${column} '${from}'`, async () => {
      if (!(await columnInfo(table, column))) return;
      // IGNORE: the same account may somehow hold both keys already.
      const [r] = await dbPool.query(`UPDATE IGNORE \`${table}\` SET \`${column}\` = ? WHERE \`${column}\` = ?`, [to, from]);
      await dbPool.query(`DELETE FROM \`${table}\` WHERE \`${column}\` = ?`, [from]);
      if (Number(r?.affectedRows || 0) > 0) moved++;
    });
  }

  for (const [table, column] of JSON_TEXT) {
    await step(`${table}.${column}`, async () => {
      if (!(await columnInfo(table, column))) return;
      let expr = `\`${column}\``;
      for (const [from, to] of JSON_TOKENS) expr = `REPLACE(${expr}, ${q(from)}, ${q(to)})`;
      const [r] = await dbPool.query(`UPDATE \`${table}\` SET \`${column}\` = ${expr} WHERE \`${column}\` IS NOT NULL`);
      if (Number(r?.changedRows || 0) > 0) moved++;
    });
  }

  if (moved) console.log(`✔ Bill Claim rename: ${moved} database change(s) applied (Conveyance claim -> Bill Claim).`);
}
