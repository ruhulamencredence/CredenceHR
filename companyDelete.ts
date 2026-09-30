/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Deleting a sister company (a group's Superadmin) or a whole workspace (the
// system owner). Only for ones that hold no Employees — anything with people
// in it is switched off instead, so no history is ever lost by mistake.
//
// Which rows go is worked out from the database's own foreign keys: the
// company's (or group's) rows, plus the rows that hang off them (a template's
// steps, a notice's targets…). A row elsewhere that still points at one of
// them (e.g. another company's attendance at this company's project) stops
// the delete and is named. Everything runs in one transaction, so it either
// all goes or nothing does.

import { LINKED_TABLES } from "./companyScope";

export type TxQuery = (sql: string, params?: any[]) => Promise<any>;
export type WithTransaction = (fn: (q: TxQuery) => Promise<void>) => Promise<void>;

interface Fk {
  child: string;
  col: string;
  parent: string;
  nullable: boolean;
}

// Rows of these tables are never removed as a side effect.
const NEVER_CASCADE = new Set(["all_employees", "users", "companies", "company_groups"]);

// A company's own records that point at another of its records by a column
// that isn't their group link (a permission on a project, a pay grade's
// component, a template assignment).
const COMPANY_CASCADE_EXTRA = new Set(["user_project_permissions", "employee_template_assignments", "pay_grade_components"]);

const ident = (s: string) => "`" + String(s).replace(/`/g, "") + "`";
const int = (n: number) => String(Math.trunc(Number(n)) || 0);

async function loadSchema(q: TxQuery) {
  const fkRows: any[] = await q(
    `SELECT k.TABLE_NAME AS child, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_NAME AS parent, c.IS_NULLABLE AS nullable
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA = k.TABLE_SCHEMA AND c.TABLE_NAME = k.TABLE_NAME AND c.COLUMN_NAME = k.COLUMN_NAME
      WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL AND k.REFERENCED_COLUMN_NAME = 'id'`
  );
  const colRows: any[] = await q(
    `SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN ('company_id', 'group_id', 'is_platform_admin')`
  );
  const seen = new Set<string>();
  const fks: Fk[] = [];
  for (const r of fkRows) {
    const key = `${r.child}.${r.col}.${r.parent}`;
    if (seen.has(key)) continue;
    seen.add(key);
    fks.push({ child: String(r.child), col: String(r.col), parent: String(r.parent), nullable: String(r.nullable).toUpperCase() === "YES" });
  }
  const cols = new Map<string, Set<string>>();
  for (const r of colRows) {
    const t = String(r.t);
    if (!cols.has(t)) cols.set(t, new Set());
    cols.get(t)!.add(String(r.c));
  }
  return { fks, cols };
}

type Plan = { direct: Map<string, string>; canCascade: (fk: Fk) => boolean };

// Every row to delete, as a WHERE per table, in an order that removes
// children before their parents; and the rows outside it that still point in.
function expand(fks: Fk[], plan: Plan) {
  const childrenOf = new Map<string, Fk[]>();
  const parentsOf = new Map<string, Fk[]>();
  for (const fk of fks) {
    if (fk.child === fk.parent) continue;
    (childrenOf.get(fk.parent) || childrenOf.set(fk.parent, []).get(fk.parent)!).push(fk);
    (parentsOf.get(fk.child) || parentsOf.set(fk.child, []).get(fk.child)!).push(fk);
  }
  // Tables that lose rows: the direct ones plus what hangs off them.
  const targets = new Set(plan.direct.keys());
  const queue = [...targets];
  while (queue.length) {
    const t = queue.shift()!;
    for (const fk of childrenOf.get(t) || [])
      if (!targets.has(fk.child) && !NEVER_CASCADE.has(fk.child) && plan.canCascade(fk)) {
        targets.add(fk.child);
        queue.push(fk.child);
      }
  }
  const memo = new Map<string, string>();
  const cond = (t: string, stack: Set<string>): string => {
    if (memo.has(t)) return memo.get(t)!;
    if (stack.has(t)) return "0";
    stack.add(t);
    const parts: string[] = [];
    const own = plan.direct.get(t);
    if (own) parts.push(`(${own})`);
    for (const fk of parentsOf.get(t) || [])
      if (targets.has(fk.parent) && !NEVER_CASCADE.has(t) && plan.canCascade(fk))
        parts.push(`${ident(fk.col)} IN (SELECT id FROM ${ident(fk.parent)} WHERE ${cond(fk.parent, stack)})`);
    stack.delete(t);
    const out = parts.length ? parts.join(" OR ") : "0";
    memo.set(t, out);
    return out;
  };
  const where = new Map<string, string>();
  for (const t of targets) where.set(t, cond(t, new Set()));

  // Children first.
  const order: string[] = [];
  const done = new Set<string>();
  const visit = (t: string, stack: Set<string>) => {
    if (done.has(t) || stack.has(t)) return;
    stack.add(t);
    for (const fk of childrenOf.get(t) || []) if (targets.has(fk.child)) visit(fk.child, stack);
    stack.delete(t);
    done.add(t);
    order.push(t);
  };
  for (const t of targets) visit(t, new Set());

  // References from rows that stay.
  const outside: { fk: Fk; parentWhere: string; childWhere: string | null }[] = [];
  for (const t of targets)
    for (const fk of childrenOf.get(t) || []) {
      const cascades = targets.has(fk.child) && !NEVER_CASCADE.has(fk.child) && plan.canCascade(fk);
      if (!cascades) outside.push({ fk, parentWhere: where.get(t)!, childWhere: targets.has(fk.child) ? where.get(fk.child)! : null });
    }
  // A reference that would still point at a row already gone (a row pointing
  // at itself, or two tables pointing at each other) is emptied first.
  const pos = new Map(order.map((t, i) => [t, i]));
  const unlink = fks.filter((fk) => targets.has(fk.child) && targets.has(fk.parent) && pos.get(fk.parent)! <= pos.get(fk.child)!);
  return { where, order, outside, unlink };
}

const pretty = (t: string) => t.replace(/_/g, " ");

async function run(q: TxQuery, fks: Fk[], plan: Plan, what: string) {
  const { where, order, outside, unlink } = expand(fks, plan);
  const blockers: string[] = [];
  for (const o of outside) {
    const rows: any[] = await q(
      `SELECT COUNT(*) AS n FROM ${ident(o.fk.child)} WHERE ${ident(o.fk.col)} IN (SELECT id FROM ${ident(o.fk.parent)} WHERE ${o.parentWhere})` +
        (o.childWhere ? ` AND NOT (${o.childWhere})` : "")
    );
    if (Number(rows[0]?.n || 0) > 0) blockers.push(pretty(o.fk.child));
  }
  if (blockers.length)
    throw Object.assign(new Error(`${what} can't be deleted: other records still point to it (${[...new Set(blockers)].join(", ")}). Switch it off instead.`), {
      statusCode: 409
    });
  for (const fk of unlink)
    if (fk.nullable)
      await q(`UPDATE ${ident(fk.child)} SET ${ident(fk.col)} = NULL WHERE (${where.get(fk.child)}) AND ${ident(fk.col)} IS NOT NULL`);
  const removed: Record<string, number> = {};
  for (const t of order) {
    const r: any = await q(`DELETE FROM ${ident(t)} WHERE ${where.get(t)}`);
    if (Number(r?.affectedRows || 0)) removed[t] = Number(r.affectedRows);
  }
  return removed;
}

async function employeeCheck(q: TxQuery, companyIds: number[], what: string) {
  const ids = companyIds.map(int).join(",") || "0";
  const [emp]: any[] = await q(`SELECT COUNT(*) AS n FROM all_employees WHERE company_id IN (${ids})`);
  const [asg]: any[] = await q(`SELECT COUNT(*) AS n FROM employee_company_assignments WHERE company_id IN (${ids}) AND is_active = 1`).catch(() => [{ n: 0 }]);
  const n = Number(emp?.n || 0);
  const a = Number(asg?.n || 0);
  if (n)
    throw Object.assign(
      new Error(`${what} still has ${n} employee record${n === 1 ? "" : "s"} (active or not). Move them to another company first, or switch it off instead.`),
      { statusCode: 409 }
    );
  if (a)
    throw Object.assign(new Error(`${a} employee${a === 1 ? " works" : "s work"} in ${what} as an additional company. End that first.`), { statusCode: 409 });
}

/** Delete one company of a group (never the mother company). */
export async function deleteCompany(withTx: WithTransaction, companyId: number, groupId: number, name: string) {
  let removed: Record<string, number> = {};
  await withTx(async (q) => {
    const { fks, cols } = await loadSchema(q);
    await employeeCheck(q, [companyId], name);
    const direct = new Map<string, string>();
    for (const [t, c] of cols) if (c.has("company_id") && t !== "all_employees") direct.set(t, `company_id = ${int(companyId)}`);
    direct.set("companies", `id = ${int(companyId)} AND group_id = ${int(groupId)}`);
    removed = await run(q, fks, {
      direct,
      canCascade: (fk) => {
        const link = LINKED_TABLES.get(fk.child);
        return (!!link && link[0] === fk.col && link[1] === fk.parent) || COMPANY_CASCADE_EXTRA.has(fk.child);
      }
    }, `"${name}"`);
    // Accounts whose default company this was start in another one they have.
    const orphans: any[] = await q(
      `SELECT user_id, MIN(id) AS first FROM user_company_access GROUP BY user_id HAVING SUM(is_default = 1) = 0`
    );
    for (const o of orphans) await q("UPDATE user_company_access SET is_default = 1 WHERE id = ?", [Number(o.first)]);
  });
  return removed;
}

/** Delete a whole workspace: its companies, accounts and every record. */
export async function deleteWorkspace(withTx: WithTransaction, groupId: number, name: string) {
  let removed: Record<string, number> = {};
  await withTx(async (q) => {
    const { fks, cols } = await loadSchema(q);
    const companies: any[] = await q(`SELECT id FROM companies WHERE group_id = ${int(groupId)}`);
    const ids = companies.map((c) => Number(c.id));
    await employeeCheck(q, ids, `"${name}"`);
    // A fixed list: the companies themselves go before some of their rows.
    const inGroup = ids.map(int).join(",") || "0";
    const direct = new Map<string, string>();
    for (const [t, c] of cols) {
      if (t === "all_employees") continue;
      const parts: string[] = [];
      if (c.has("company_id")) parts.push(`company_id IN (${inGroup})`);
      if (c.has("group_id")) parts.push(`group_id = ${int(groupId)}`);
      if (parts.length) direct.set(t, parts.join(" OR "));
    }
    // The system owner's own account is never part of a workspace's accounts.
    direct.set("users", `group_id = ${int(groupId)}` + (cols.get("users")?.has("is_platform_admin") ? " AND COALESCE(is_platform_admin, 0) = 0" : ""));
    direct.set("company_groups", `id = ${int(groupId)}`);
    // One-row-per-group settings.
    for (const t of ["leave_year_settings", "rate_file_meta"]) {
      const exists: any[] = await q("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?", [t]);
      if (Number(exists[0]?.n || 0)) direct.set(t, `id = ${int(groupId)}`);
    }
    // Everything of the workspace goes, except accounts are only removed as
    // the workspace's own (never through a reference to them).
    removed = await run(q, fks, { direct, canCascade: () => true }, `"${name}"`);
  });
  return removed;
}
