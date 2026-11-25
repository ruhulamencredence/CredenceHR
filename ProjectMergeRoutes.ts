// Admin Panel -> Projects -> Merge projects.
//
// Two Projects for the same place (a duplicate, a misspelling, an old name)
// leave attendance, check-in lists, access, budgets and PEPM entries split
// between them. Merging moves everything that points at the duplicate onto the
// one to keep, then archives the duplicate (never deletes it, so its row stays
// for the record). Previewed first, checked again on the server, done in one
// transaction, and written to project_merge_log.
//
// Behind Projects + the explicit layer "merge_projects" (EXPLICIT_ONLY_LAYERS);
// a Superadmin always has it. Needs the MySQL database.
import type { Express } from "express";

type Q = (sql: string, params?: any[]) => Promise<any>;
type Tx = (fn: (q: Q) => Promise<void>) => Promise<void>;

interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (k: "projects") => any;
  requireModuleLayer: (k: "projects", layer: "merge_projects") => any;
  queryDB: Q;
  withTransaction?: Tx;
}

// Everything in the database that points at a Project (columns found in
// information_schema; see docs/branch-project-rules.md).
//   move        - plain move.
//   unique-keep - there is a "one per person / day" rule; rows that would
//                 collide with one already on the kept Project stay where they
//                 are (still readable) and are reported.
//   unique-drop - a list ("who may use it"): a row the person already has on
//                 the kept Project is redundant and is removed.
interface Ref {
  table: string;
  column: string;
  label: string;
  mode: "move" | "unique-keep" | "unique-drop";
  // The other columns of the unique key, for the collision check.
  key?: string[];
}
const REFS: Ref[] = [
  { table: "entries", column: "project_id", label: "PEPM entries", mode: "move" },
  { table: "entries", column: "for_project_id", label: "PEPM entries (For)", mode: "move" },
  { table: "attendance", column: "project_id", label: "attendance records", mode: "unique-keep", key: ["user_id", "attendance_date"] },
  { table: "attendance", column: "check_out_project_id", label: "attendance records (check-out place)", mode: "move" },
  { table: "attendance_admin_edits", column: "project_id", label: "attendance admin edits", mode: "move" },
  { table: "attendance_corrections", column: "project_id", label: "attendance corrections", mode: "move" },
  { table: "attendance_mock_attempts", column: "project_id", label: "mock-location attempts", mode: "move" },
  { table: "budget_project_locks", column: "project_id", label: "Budget locks", mode: "unique-drop", key: ["budget_id", "share_key"] },
  { table: "guard_posts", column: "project_id", label: "Duty Roster guard posts", mode: "move" },
  { table: "site_attendance_teams", column: "project_id", label: "Site Attendance teams", mode: "move" },
  { table: "users", column: "attendance_project_id", label: "accounts pinned to it for check-in", mode: "move" },
  { table: "user_attendance_projects", column: "project_id", label: "accounts with it in the check-in list", mode: "unique-drop", key: ["user_id"] },
  { table: "user_project_permissions", column: "project_id", label: "accounts with access to it", mode: "unique-drop", key: ["user_id"] }
];

const norm = (v: any) => String(v ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export function registerProjectMergeRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB, withTransaction } = deps;
  const guard = [authenticateToken, requireAdmin, requireModule("projects"), requireModuleLayer("projects", "merge_projects")];

  queryDB(
    `CREATE TABLE IF NOT EXISTS project_merge_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      from_project_id INT NOT NULL,
      from_name VARCHAR(255) NULL,
      into_project_id INT NOT NULL,
      into_name VARCHAR(255) NULL,
      moved_json MEDIUMTEXT NULL,
      merged_by INT NULL,
      merged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX (into_project_id)
    )`
  ).catch(() => {});

  const one = async (sql: string, p: any[]) => ((await queryDB(sql, p).catch(() => [])) as any[])[0];

  async function plan(fromId: number, intoId: number) {
    const from: any = await one("SELECT * FROM projects WHERE id = ?", [fromId]);
    const into: any = await one("SELECT * FROM projects WHERE id = ?", [intoId]);
    const blocked: string[] = [];
    if (!from || !into) return { from, into, blocked: ["Project not found."], rows: [] as any[], fromBranch: null as any, intoBranch: null as any, budgetNames: 0 };
    if (fromId === intoId) blocked.push("Pick a different Project to keep.");
    if (Number(into.is_archived)) blocked.push(`"${into.project_name}" is archived. Restore it first, or pick another Project to keep.`);
    const fromBranch: any = await one("SELECT id, branch_name FROM branches WHERE project_id = ?", [fromId]);
    const intoBranch: any = await one("SELECT id, branch_name FROM branches WHERE project_id = ?", [intoId]);
    if (fromBranch && intoBranch) {
      blocked.push(`Both Projects are linked to a Branch ("${fromBranch.branch_name}" and "${intoBranch.branch_name}"). Merge those two Branches first, or unlink one.`);
    }
    const rows: { label: string; count: number; collide: number; mode: Ref["mode"] }[] = [];
    for (const r of REFS) {
      const count = Number((await one(`/*unscoped*/ SELECT COUNT(*) AS n FROM \`${r.table}\` WHERE \`${r.column}\` = ?`, [fromId]))?.n || 0);
      let collide = 0;
      if (count && r.key) {
        const on = r.key.map((k) => `b.\`${k}\` <=> a.\`${k}\``).join(" AND ");
        collide = Number((await one(`/*unscoped*/ SELECT COUNT(*) AS n FROM \`${r.table}\` a WHERE a.\`${r.column}\` = ? AND EXISTS (SELECT 1 FROM \`${r.table}\` b WHERE b.\`${r.column}\` = ? AND ${on})`, [fromId, intoId]))?.n || 0);
      }
      if (count) rows.push({ label: r.label, count, collide, mode: r.mode });
    }
    const budgetNames = Number((await one("SELECT COUNT(*) AS n FROM budget_items WHERE LOWER(TRIM(project_name)) = LOWER(TRIM(?))", [from.project_name]))?.n || 0);
    return { from, into, blocked, rows, fromBranch, intoBranch, budgetNames };
  }

  const nameOf = (p: any) => ({ id: Number(p.id), name: p.project_name as string, archived: !!Number(p.is_archived), pin: p.location_lat != null && p.location_lng != null });

  app.get("/api/projects/:id/merge-preview", ...guard, async (req: any, res: any) => {
    try {
      const p = await plan(Number(req.params.id), Number(req.query.into));
      if (!p.from || !p.into) return res.status(404).json({ error: "Project not found" });
      res.json({
        from: nameOf(p.from),
        into: nameOf(p.into),
        rows: p.rows,
        budget_names: p.budgetNames,
        branch_moves: !!p.fromBranch && !p.intoBranch ? p.fromBranch.branch_name : null,
        blocked: p.blocked
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/projects/:id/merge", ...guard, async (req: any, res: any) => {
    try {
      if (!withTransaction) return res.status(503).json({ error: "Merging Projects needs the MySQL database." });
      const fromId = Number(req.params.id);
      const intoId = Number(req.body?.into_id);
      const p = await plan(fromId, intoId);
      if (!p.from || !p.into) return res.status(404).json({ error: "Project not found" });
      if (p.blocked.length) return res.status(400).json({ error: p.blocked.join(" ") });
      const moved: Record<string, number> = {};
      const left: Record<string, number> = {};
      const dropped: Record<string, number> = {};
      await withTransaction(async (q) => {
        for (const r of REFS) {
          const sql = r.mode === "move" ? `UPDATE \`${r.table}\` SET \`${r.column}\` = ? WHERE \`${r.column}\` = ?` : `UPDATE IGNORE \`${r.table}\` SET \`${r.column}\` = ? WHERE \`${r.column}\` = ?`;
          let done = 0;
          try {
            // UPDATE IGNORE reports the rows it matched, not the ones it changed,
            // so for the "one per ..." tables count what was there before and after.
            const before: any[] = r.mode === "move" ? [] : await q(`SELECT COUNT(*) AS n FROM \`${r.table}\` WHERE \`${r.column}\` = ?`, [fromId]);
            const out: any = await q(sql, [intoId, fromId]);
            done = Number(out?.affectedRows || 0);
            if (r.mode !== "move") {
              const rest: any[] = await q(`SELECT COUNT(*) AS n FROM \`${r.table}\` WHERE \`${r.column}\` = ?`, [fromId]);
              const n = Number(rest?.[0]?.n || 0);
              done = Number(before?.[0]?.n || 0) - n;
              if (n && r.mode === "unique-keep") left[r.label] = n;
              if (n && r.mode === "unique-drop") {
                await q(`DELETE FROM \`${r.table}\` WHERE \`${r.column}\` = ?`, [fromId]);
                dropped[r.label] = n;
              }
            }
          } catch (e: any) {
            // A table this install doesn't have (older database) has nothing to move.
            if (e?.code !== "ER_NO_SUCH_TABLE" && e?.code !== "ER_BAD_FIELD_ERROR") throw e;
          }
          if (done) moved[r.label] = (moved[r.label] || 0) + done;
        }
        // The Branch link goes with the people when the kept Project has none.
        if (p.fromBranch && !p.intoBranch) {
          await q("UPDATE branches SET project_id = ? WHERE id = ?", [intoId, p.fromBranch.id]);
          moved["Branch link"] = 1;
        }
        // The emptied Project is archived, never deleted.
        await q("UPDATE projects SET is_archived = 1 WHERE id = ?", [fromId]);
        await q("INSERT INTO project_merge_log (from_project_id, from_name, into_project_id, into_name, moved_json, merged_by) VALUES (?, ?, ?, ?, ?, ?)", [
          fromId,
          p.from.project_name,
          intoId,
          p.into.project_name,
          JSON.stringify({ moved, left, dropped }),
          req.user?.id ?? null
        ]);
      });
      // Budgets name their Project in text (budget_items.project_name): they follow too.
      if (norm(p.from.project_name) !== norm(p.into.project_name)) {
        await queryDB("UPDATE budget_items SET project_name = ? WHERE LOWER(TRIM(project_name)) = LOWER(TRIM(?))", [p.into.project_name, p.from.project_name]).catch(() => {});
      }
      res.json({ success: true, moved, left, dropped, archived_project_id: fromId });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/projects/merge/log", ...guard, async (_req: any, res: any) => {
    try {
      const rows: any[] = await queryDB(
        "SELECT l.*, u.name AS merged_by_name FROM project_merge_log l LEFT JOIN users u ON u.id = l.merged_by ORDER BY l.id DESC LIMIT 200"
      );
      res.json(rows.map((r) => ({ ...r, moved: (() => { try { return JSON.parse(r.moved_json || "{}"); } catch { return {}; } })() })));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
