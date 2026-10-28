/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// PEPM: importing a Budget (a new one, or "Import more rows" into one) writes
// a DRAFT notice about it — never shown to anyone until it is published:
//
//   Title    "<Budget name> - MPR Updated up to <date>"
//   Message  "<date> তারিখ পর্যন্ত যে সকল MPR পোস্টিং হয়েছে সেগুলো Budget
//            Optimization Software এ এন্ট্রি দিতে পারবেন।"
//
// The date is today until the importer picks a date or a range: the import
// page opens this draft for editing straight away (BudgetNoticePopup.tsx),
// where they check it and publish it or keep it as a draft for Notices.
//
//   - Addressed to the project accounts of the projects in the Budget
//     (user_project_permissions); everyone when no project has one.
//   - One draft per Budget while untouched (notices.source_ref =
//     "budget:<id>"): another import rewrites it. Once someone edits or
//     publishes it (NoticeRoutes.ts clears source_ref) it is theirs, and the
//     next import starts a new draft.
//   - Superadmins and accounts with the Notices module (other than the
//     importer, who has it open) get a "Draft notice to review" alert.

type QueryDB = (sql: string, params?: any[]) => Promise<any>;
type CreateAlert = (queryDB: QueryDB, params: { userId: number; type: any; title: string; message: string; relatedType?: string; relatedId?: number }) => Promise<void>;

export async function ensureBudgetNoticeSchema(dbPool: any): Promise<void> {
  try {
    await dbPool.query("ALTER TABLE notices ADD COLUMN source_ref VARCHAR(64) NULL");
  } catch (err: any) {
    if (err?.code !== "ER_DUP_FIELDNAME") console.warn("⚠️ notices.source_ref: " + err.message);
  }
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-10-22" -> "22-Oct-2026" (the app's date format).
export const noticeDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}-${MON[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}` : iso);
const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The same wording as BudgetNoticePopup.tsx builds while the date is changed.
export function budgetNoticeText(budgetName: string, upTo: string, from?: string | null) {
  const range = from ? `${noticeDate(from)} থেকে ${noticeDate(upTo)}` : noticeDate(upTo);
  return {
    title: `${budgetName} - MPR Updated up to ${from ? `${noticeDate(from)} to ${noticeDate(upTo)}` : noticeDate(upTo)}`.slice(0, 200),
    html: `<p>${esc(range)} তারিখ পর্যন্ত যে সকল MPR পোস্টিং হয়েছে সেগুলো Budget Optimization Software এ এন্ট্রি দিতে পারবেন।</p>`
  };
}

export interface BudgetNoticeDraft {
  id: number;
  created: boolean;
  budget_name: string;
  title: string;
  content_html: string;
  target_type: "all" | "specific";
  target_user_ids: number[];
}

export async function draftBudgetNotice(
  queryDB: QueryDB,
  createAlert: CreateAlert,
  opts: { budgetId: number; actorId: number; today: string }
): Promise<BudgetNoticeDraft | null> {
  const budget = ((await queryDB("SELECT id, budget_name FROM budgets WHERE id = ?", [opts.budgetId])) || [])[0];
  if (!budget) return null;
  const ref = `budget:${budget.id}`;
  const draft = ((await queryDB("SELECT id FROM notices WHERE source = 'budget_import' AND source_ref = ? AND is_active = 0 ORDER BY id DESC LIMIT 1", [ref])) || [])[0];
  const { title, html } = budgetNoticeText(String(budget.budget_name), opts.today);

  // The project accounts of the Budget's projects.
  const projects: any[] = (await queryDB("SELECT DISTINCT project_name FROM budget_items WHERE budget_id = ? AND project_name <> ''", [budget.id])) || [];
  const names = projects.map((p) => String(p.project_name));
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
      "INSERT INTO notices (title, content_html, target_type, is_active, created_by, source, source_ref) VALUES (?, ?, ?, 0, ?, 'budget_import', ?)",
      [title, html, targetType, opts.actorId, ref]
    );
    id = Number(r.insertId);
  }
  for (const uid of audience) await queryDB("INSERT INTO notice_targets (notice_id, user_id) VALUES (?, ?)", [id, uid]);

  if (created) {
    const reviewers: any[] =
      (await queryDB(
        `/*unscoped*/ SELECT DISTINCT u.id FROM users u
          WHERE u.group_id = (SELECT group_id FROM users WHERE id = ?) AND u.id <> ?
            AND (u.role = 'superadmin' OR (u.role IN ('admin', 'user') AND COALESCE(u.is_blocked, 0) = 0
                 AND EXISTS (SELECT 1 FROM admin_module_permissions m WHERE m.user_id = u.id AND m.module_key = 'notices')))`,
        [opts.actorId, opts.actorId]
      ).catch(() => [])) || [];
    for (const r of reviewers) {
      await createAlert(queryDB, {
        userId: Number(r.id),
        type: "notice_draft",
        title: "Draft notice to review",
        message: `"${title}" was written from the Budget import. Check it and publish it in Notices.`,
        relatedType: "notice",
        relatedId: id
      }).catch(() => {});
    }
  }
  return { id, created, budget_name: String(budget.budget_name), title, content_html: html, target_type: targetType, target_user_ids: audience };
}
