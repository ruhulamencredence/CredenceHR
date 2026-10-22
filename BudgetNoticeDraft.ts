/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// PEPM: importing a Budget (a new one, or "Import more rows" into one) writes
// a DRAFT notice about it — never shown to anyone until someone with the
// Notices module checks it, edits it if needed and turns it on (Admin Panel ->
// Notices, the usual Activate button, which also sends the pushes).
//
//   - New Budget            "New Budget: <name>" with its projects and item
//                           counts and the delivery date window.
//   - Import more rows      "<name>: N new items" listing what was added.
//   - Addressed to the project accounts of the projects in it
//     (user_project_permissions); everyone when no project has one.
//   - One draft per Budget while unpublished (notices.source_ref =
//     "budget:<id>"): another import before it is published rewrites the same
//     draft (everything added since the draft was made), so nobody has to
//     clean up a pile of drafts. Once someone publishes or edits it
//     (NoticeRoutes.ts clears source_ref), it is theirs: the next import starts
//     a new draft and never overwrites their edits.
//   - Superadmins and accounts with the Notices module get an alert.

type QueryDB = (sql: string, params?: any[]) => Promise<any>;
type CreateAlert = (queryDB: QueryDB, params: { userId: number; type: any; title: string; message: string; relatedType?: string; relatedId?: number }) => Promise<void>;

export async function ensureBudgetNoticeSchema(dbPool: any): Promise<void> {
  // source_ref "budget:<id>"; source_from_id = the first budget_items id the
  // draft covers (rows of this Budget from there on are its new items).
  for (const [col, ddl] of [["source_ref", "VARCHAR(64) NULL"], ["source_from_id", "INT NULL"]]) {
    try {
      await dbPool.query(`ALTER TABLE notices ADD COLUMN ${col} ${ddl}`);
    } catch (err: any) {
      if (err?.code !== "ER_DUP_FIELDNAME") console.warn(`⚠️ notices.${col}: ` + err.message);
    }
  }
}

const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const dmy = (v: unknown) => {
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}-${s.slice(5, 7)}-${s.slice(0, 4)}` : "";
};
const bnNum = (n: number) => String(n).replace(/\d/g, (d) => "০১২৩৪৫৬৭৮৯"[Number(d)]);
const MAX_LINES = 40;
const TABLE = 'style="border-collapse:collapse;width:100%;font-size:13px"';
const TH = 'style="text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0;background:#f8fafc"';
const TD = 'style="padding:6px 8px;border-bottom:1px solid #f1f5f9"';

export async function draftBudgetNotice(
  queryDB: QueryDB,
  createAlert: CreateAlert,
  opts: { budgetId: number; isNew: boolean; actorId: number; fromId: number }
): Promise<{ id: number; created: boolean } | null> {
  const budget = ((await queryDB("SELECT id, budget_name, delivery_date_from, delivery_date_to FROM budgets WHERE id = ?", [opts.budgetId])) || [])[0];
  if (!budget) return null;
  const ref = `budget:${budget.id}`;
  const draft = ((await queryDB("SELECT id, title, source_from_id FROM notices WHERE source = 'budget_import' AND source_ref = ? AND is_active = 0 ORDER BY id DESC LIMIT 1", [ref])) || [])[0];
  // A draft that started as "New Budget" stays one until it is published.
  const isNew = opts.isNew || (draft && /^New Budget:/.test(String(draft.title)));
  const items: any[] =
    (await queryDB(
      `SELECT project_name, mrf_no, description, specification, req_qty, unit FROM budget_items WHERE budget_id = ?${isNew ? "" : " AND id >= ?"} ORDER BY project_name, id`,
      isNew ? [budget.id] : [budget.id, Number(draft?.source_from_id || opts.fromId)]
    )) || [];
  if (!items.length) return null;

  const byProject = new Map<string, number>();
  for (const it of items) byProject.set(String(it.project_name || "—"), (byProject.get(String(it.project_name || "—")) || 0) + 1);
  const window =
    budget.delivery_date_from || budget.delivery_date_to
      ? `<p>Delivery date: <b>${esc(dmy(budget.delivery_date_from) || "…")}</b> থেকে <b>${esc(dmy(budget.delivery_date_to) || "…")}</b> পর্যন্ত।</p>`
      : "";
  let title: string, html: string;
  if (isNew) {
    title = `New Budget: ${budget.budget_name}`.slice(0, 200);
    html =
      `<p>নতুন Budget <b>${esc(budget.budget_name)}</b> যোগ হয়েছে — মোট ${bnNum(items.length)}টি item, ${bnNum(byProject.size)}টি প্রজেক্টে।</p>` +
      `<p>এই Budget-এর item-এর জন্য এখন <b>Budget / Jobs → Job Entry</b> থেকে MPR দেওয়া যাবে।</p>` +
      `<table ${TABLE}><thead><tr><th ${TH}>Project</th><th ${TH}>Items</th></tr></thead><tbody>` +
      [...byProject.entries()].map(([p, n]) => `<tr><td ${TD}>${esc(p)}</td><td ${TD}>${bnNum(n)}</td></tr>`).join("") +
      `</tbody></table>` +
      window;
  } else {
    title = `${budget.budget_name}: ${items.length} new item${items.length === 1 ? "" : "s"}`.slice(0, 200);
    const shown = items.slice(0, MAX_LINES);
    html =
      `<p><b>${esc(budget.budget_name)}</b> Budget-এ নতুন ${bnNum(items.length)}টি item যোগ হয়েছে। এগুলোর জন্য <b>Budget / Jobs → Job Entry</b> থেকে MPR দেওয়া যাবে।</p>` +
      `<table ${TABLE}><thead><tr><th ${TH}>Project</th><th ${TH}>Item</th><th ${TH}>MRF</th><th ${TH}>Qty</th></tr></thead><tbody>` +
      shown
        .map(
          (it) =>
            `<tr><td ${TD}>${esc(it.project_name)}</td><td ${TD}>${esc(it.description)}${it.specification ? ` <span style="color:#64748b">(${esc(it.specification)})</span>` : ""}</td><td ${TD}>${esc(it.mrf_no)}</td><td ${TD}>${esc(it.req_qty)} ${esc(it.unit)}</td></tr>`
        )
        .join("") +
      `</tbody></table>` +
      (items.length > shown.length ? `<p>…আরও ${bnNum(items.length - shown.length)}টি item।</p>` : "") +
      window;
  }

  // The project accounts of these projects.
  const names = [...byProject.keys()].filter((p) => p !== "—");
  const audience: number[] = names.length
    ? ((await queryDB(
        `SELECT DISTINCT upp.user_id FROM user_project_permissions upp JOIN projects p ON p.id = upp.project_id JOIN users u ON u.id = upp.user_id
          WHERE LOWER(p.project_name) IN (${names.map(() => "LOWER(?)").join(",")}) AND COALESCE(u.is_blocked, 0) = 0`,
        names
      )) || []).map((r: any) => Number(r.user_id))
    : [];
  const targetType = audience.length ? "specific" : "all";

  let id: number;
  const created = !draft;
  if (draft) {
    id = Number(draft.id);
    await queryDB("UPDATE notices SET title = ?, content_html = ?, target_type = ? WHERE id = ?", [title, html, targetType, id]);
    await queryDB("DELETE FROM notice_targets WHERE notice_id = ?", [id]);
  } else {
    const r: any = await queryDB(
      "INSERT INTO notices (title, content_html, target_type, is_active, created_by, source, source_ref, source_from_id) VALUES (?, ?, ?, 0, ?, 'budget_import', ?, ?)",
      [title, html, targetType, opts.actorId, ref, opts.fromId]
    );
    id = Number(r.insertId);
  }
  for (const uid of audience) await queryDB("INSERT INTO notice_targets (notice_id, user_id) VALUES (?, ?)", [id, uid]);

  if (created) {
    const reviewers: any[] =
      (await queryDB(
        `/*unscoped*/ SELECT DISTINCT u.id FROM users u
          WHERE u.group_id = (SELECT group_id FROM users WHERE id = ?)
            AND (u.role = 'superadmin' OR (u.role IN ('admin', 'user') AND COALESCE(u.is_blocked, 0) = 0
                 AND EXISTS (SELECT 1 FROM admin_module_permissions m WHERE m.user_id = u.id AND m.module_key = 'notices')))`,
        [opts.actorId]
      ).catch(() => [])) || [];
    for (const r of reviewers) {
      await createAlert(queryDB, {
        userId: Number(r.id),
        type: "notice_draft",
        title: "Draft notice to review",
        message: `"${title}" was written from the Budget import. Check it, edit if needed and publish it in Notices.`,
        relatedType: "notice",
        relatedId: id
      }).catch(() => {});
    }
  }
  return { id, created };
}
