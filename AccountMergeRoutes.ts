// Admin Panel -> Users -> Merge accounts.
//
// Logins made by hand before the employees were imported, and then a second
// login per person made by the import (Login ID = Employee ID), leave one
// person with two accounts. Merging moves everything the old login did or
// owns — attendance, leave, claims, approvals, chat, tracking, tasks… every
// column in the database that points at a user — onto the import's login,
// then deletes the old one. Only the import's login is left.
//
// Behind Users + the explicit layer "merge_accounts" (EXPLICIT_ONLY_LAYERS);
// a Superadmin always has it. Can't be undone, so the page asks first and
// every merge is written to user_merge_log.
import type { Express } from "express";

type Q = (sql: string, params?: any[]) => Promise<any>;
type Tx = (fn: (q: Q) => Promise<void>) => Promise<void>;

interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (k: "users") => any;
  requireModuleLayer: (k: "users", layer: "merge_accounts") => any;
  queryDB: Q;
  withTransaction?: Tx;
}

// Tables that say what an account may open (module access, layers,
// departments / projects it may see). "Keep the old account's access" swaps
// these wholesale; otherwise the old account's rows are dropped.
const ACCESS_TABLES = new Set([
  "admin_module_permissions",
  "admin_module_permission_layers",
  "user_project_permissions",
  "user_attendance_projects",
  "tracking_employee_access",
  "tracking_department_access",
  "bill_claim_department_access",
  "duty_roster_department_access",
  "claim_department_access",
  "leave_application_department_access",
  "attendance_report_department_access",
  "user_app_access"
]);
// Never moved: rows that only make sense for the login they were made for.
const SKIP_TABLES = new Set(["user_sessions", "login_attempts", "sso_login_requests", "user_merge_log"]);
// users columns that are "what this account may do" (copied when the old access is kept).
const ACCESS_USER_COLS = (c: string) =>
  c === "role" || c.startsWith("can_") || ["app_access_custom", "max_devices", "attendance_project_id", "attendance_projects_by_branch"].includes(c);
// JSON / list values whose keys hold user ids (approval steps, HR action chains, recurring task assignees).
const USER_KEY = /(^|_)(user_id|user_ids|approver|approvers|approver_id|approver_ids|approver_user_ids|actor|actor_id|actor_user_id|assignee|assignee_ids|by|by_user_id|decided_by|user)$/i;

interface Col { table: string; column: string; fk: boolean }

// Every integer column that points at users.id: the declared foreign keys,
// plus same-named columns without one (…user_id, …_by, approver_id…) that
// don't point at another table.
async function userColumns(q: Q): Promise<Col[]> {
  const fks: any[] = await q(
    `/*unscoped*/ SELECT table_name AS t, column_name AS c, referenced_table_name AS r FROM information_schema.key_column_usage
     WHERE table_schema = DATABASE() AND referenced_table_name IS NOT NULL`
  );
  const toUsers = new Set(fks.filter((x) => x.r === "users").map((x) => `${x.t}.${x.c}`));
  const elsewhere = new Set(fks.filter((x) => x.r !== "users").map((x) => `${x.t}.${x.c}`));
  const ints: any[] = await q(
    `/*unscoped*/ SELECT table_name AS t, column_name AS c FROM information_schema.columns
     WHERE table_schema = DATABASE() AND data_type IN ('int','bigint','mediumint','smallint')
       AND (column_name LIKE '%user\\_id' OR column_name LIKE '%\\_by' OR column_name IN ('approver_id','actor_id','sender_id','recipient_id','reviewer_id','owner_id','assignee_id','viewer_id','uploader_id'))`
  );
  const out = new Map<string, Col>();
  for (const k of toUsers) {
    const [table, column] = k.split(".");
    out.set(k, { table, column, fk: true });
  }
  for (const x of ints) {
    const k = `${x.t}.${x.c}`;
    if (out.has(k) || elsewhere.has(k)) continue;
    out.set(k, { table: x.t, column: x.c, fk: false });
  }
  return [...out.values()].filter((c) => !SKIP_TABLES.has(c.table) && !(c.table === "users" && c.column === "id"));
}

async function listColumns(q: Q): Promise<{ table: string; column: string; csv: boolean }[]> {
  const rows: any[] = await q(
    `/*unscoped*/ SELECT table_name AS t, column_name AS c FROM information_schema.columns
     WHERE table_schema = DATABASE() AND data_type IN ('json','text','mediumtext','longtext','varchar')
       AND (column_name LIKE '%\\_ids' OR column_name IN ('chain_json','history_json','actions_json','approvers_json','steps_json'))`
  );
  // A list column only when its name says it holds user ids (assignee_ids, approver_user_ids) — never project_ids, employee_ids…
  return rows
    .filter((r) => !/_ids$/.test(r.c) || USER_KEY.test(r.c))
    .map((r) => ({ table: r.t, column: r.c, csv: /_ids$/.test(r.c) }));
}

const swapIn = (v: any, from: number, to: number, key = ""): [any, boolean] => {
  if (Array.isArray(v)) {
    let hit = false;
    const out = v.map((x) => {
      if (USER_KEY.test(key) && (x === from || x === String(from))) { hit = true; return typeof x === "string" ? String(to) : to; }
      const [y, h] = swapIn(x, from, to, key);
      hit = hit || h;
      return y;
    });
    return [out, hit];
  }
  if (v && typeof v === "object") {
    let hit = false;
    const out: any = {};
    for (const [k, x] of Object.entries(v)) {
      if (USER_KEY.test(k) && (x === from || x === String(from))) { out[k] = typeof x === "string" ? String(to) : to; hit = true; continue; }
      const [y, h] = swapIn(x, from, to, k);
      out[k] = y;
      hit = hit || h;
    }
    return [out, hit];
  }
  return [v, false];
};

// A table name people can read: "leave_applications" -> "Leave applications".
const label = (t: string) => (t.charAt(0).toUpperCase() + t.slice(1)).replace(/_/g, " ");

export function registerAccountMergeRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB, withTransaction } = deps;
  const guard = [authenticateToken, requireAdmin, requireModule("users"), requireModuleLayer("users", "merge_accounts")];

  queryDB(
    `CREATE TABLE IF NOT EXISTS user_merge_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      from_user_id INT NOT NULL,
      from_name VARCHAR(255) NULL,
      from_login VARCHAR(255) NULL,
      to_user_id INT NOT NULL,
      to_name VARCHAR(255) NULL,
      kept_access VARCHAR(10) NOT NULL,
      kept_password VARCHAR(10) NOT NULL,
      moved_json MEDIUMTEXT NULL,
      merged_by INT NULL,
      merged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX (to_user_id)
    )`
  ).catch(() => {});

  // Rows on the old account, per table — what the merge will move.
  async function countsFor(q: Q, fromId: number) {
    const cols = await userColumns(q);
    const byTable = new Map<string, number>();
    for (const c of cols) {
      const r: any[] = await q(`/*unscoped*/ SELECT COUNT(*) AS n FROM \`${c.table}\` WHERE \`${c.column}\` = ?`, [fromId]).catch(() => [{ n: 0 }]);
      const n = Number(r?.[0]?.n || 0);
      if (n) byTable.set(c.table, (byTable.get(c.table) || 0) + n);
    }
    return [...byTable].map(([table, n]) => ({ table, label: label(table), rows: n, access: ACCESS_TABLES.has(table) })).sort((a, b) => b.rows - a.rows);
  }

  // Pairs to merge: each login that isn't linked to an employee, matched to
  // an employee's (import) login by name, email or Login ID; plus every
  // unlinked login for pairing by hand.
  app.get("/api/users/merge/candidates", ...guard, async (req: any, res: any) => {
    try {
      const users: any[] = await queryDB("SELECT id, name, email, username, role, last_login_at, created_at, is_blocked FROM users");
      const emps: any[] = await queryDB(
        "SELECT id, employee_id, name, designation, department, email, personal_email, mobile, phone, user_id, is_active FROM all_employees WHERE user_id IS NOT NULL"
      );
      const linked = new Set(emps.map((e) => Number(e.user_id)));
      const userById = new Map(users.map((u) => [Number(u.id), u]));
      const me = Number(req.user.id);
      const norm = (s: any) => String(s || "").toLowerCase().replace(/\b(md|mohammad|mohammed|muhammad|mst|mrs|mr)\b\.?/g, " ").replace(/[^a-z0-9ঀ-৿]+/g, " ").trim();
      const digits = (s: any) => String(s || "").replace(/\D/g, "").replace(/^(88)?0?/, "");
      const old = users.filter((u) => !linked.has(Number(u.id)) && u.role !== "superadmin" && Number(u.id) !== me);
      const keepers = emps
        .map((e) => ({ e, u: userById.get(Number(e.user_id)) }))
        .filter((x) => x.u)
        .map((x) => ({
          id: Number(x.u.id), name: x.u.name, email: x.u.email, username: x.u.username, role: x.u.role,
          employee_code: x.e.employee_id, designation: x.e.designation, department: x.e.department,
          emp_name: norm(x.e.name), emails: [x.e.email, x.e.personal_email, x.u.email].filter(Boolean).map((v: string) => v.toLowerCase()),
          phones: [x.e.mobile, x.e.phone].map(digits).filter((v) => v.length >= 9), code: String(x.e.employee_id || "").toLowerCase()
        }));
      const pairs: any[] = [];
      for (const u of old) {
        const em = String(u.email || "").toLowerCase();
        const login = String(u.username || "").toLowerCase();
        const n = norm(u.name);
        const hits = keepers
          .map((k) => {
            const why: string[] = [];
            if (em && k.emails.includes(em)) why.push("email");
            if (login && (login === k.code || (digits(login).length >= 9 && k.phones.includes(digits(login))))) why.push("login id");
            if (n && n === k.emp_name) why.push("name");
            return { k, why };
          })
          .filter((x) => x.why.length);
        if (!hits.length) continue;
        // The strongest match (email / login id beat a name) — a name alone shared by two people is left for a person to pick.
        hits.sort((a, b) => (b.why.includes("email") || b.why.includes("login id") ? 1 : 0) - (a.why.includes("email") || a.why.includes("login id") ? 1 : 0) || b.why.length - a.why.length);
        const strong = hits.filter((h) => h.why.includes("email") || h.why.includes("login id"));
        const ambiguous = strong.length === 0 && hits.length > 1;
        const { emails, phones, code, emp_name, ...keep } = hits[0].k as any;
        pairs.push({
          from: { id: Number(u.id), name: u.name, email: u.email, username: u.username, role: u.role, last_login_at: u.last_login_at, created_at: u.created_at, is_blocked: !!Number(u.is_blocked || 0) },
          to: keep,
          match: hits[0].why,
          ambiguous,
          others: ambiguous ? hits.slice(1, 5).map((h) => h.k.id) : []
        });
      }
      res.json({
        pairs,
        unlinked: old.map((u) => ({ id: Number(u.id), name: u.name, email: u.email, username: u.username, role: u.role, last_login_at: u.last_login_at })),
        keepers: keepers.map(({ emails, phones, code, emp_name, ...k }: any) => k)
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  const checkPair = async (fromId: number, toId: number, me: number) => {
    if (!fromId || !toId || fromId === toId) return "Pick two different accounts.";
    const rows: any[] = await queryDB("SELECT id, role FROM users WHERE id IN (?, ?)", [fromId, toId]);
    const from = rows.find((r) => Number(r.id) === fromId);
    const to = rows.find((r) => Number(r.id) === toId);
    if (!from || !to) return "One of these accounts no longer exists.";
    if (from.role === "superadmin") return "A Superadmin account can't be merged away.";
    if (fromId === me) return "You can't merge away the account you're signed in with.";
    const linked: any[] = await queryDB("/*unscoped*/ SELECT id FROM all_employees WHERE user_id = ? LIMIT 1", [fromId]);
    if (linked.length) return "The account to remove is linked to an employee — only a login with no employee can be merged away.";
    return "";
  };

  app.get("/api/users/merge/preview", ...guard, async (req: any, res: any) => {
    try {
      const fromId = Number(req.query.from), toId = Number(req.query.to);
      const bad = await checkPair(fromId, toId, Number(req.user.id));
      if (bad) return res.status(400).json({ error: bad });
      res.json({ tables: await countsFor(queryDB, fromId) });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Body: { pairs: [{ from, to }], access: "old" | "keep", password: "old" | "keep" }
  app.post("/api/users/merge", ...guard, async (req: any, res: any) => {
    if (!withTransaction) return res.status(503).json({ error: "Merging needs the MySQL database." });
    const pairs: { from: number; to: number }[] = (Array.isArray(req.body?.pairs) ? req.body.pairs : [])
      .map((p: any) => ({ from: Number(p?.from), to: Number(p?.to) }))
      .slice(0, 500);
    const access = req.body?.access === "keep" ? "keep" : "old";
    const password = req.body?.password === "keep" ? "keep" : "old";
    if (!pairs.length) return res.status(400).json({ error: "Nothing to merge." });
    const froms = new Set<number>();
    for (const p of pairs) {
      if (froms.has(p.from)) return res.status(400).json({ error: "The same account is in two pairs." });
      froms.add(p.from);
      if (pairs.some((x) => x.from === p.to)) return res.status(400).json({ error: "An account can't be both kept and removed." });
    }
    const me = Number(req.user.id);
    const done: any[] = [];
    const failed: any[] = [];
    for (const p of pairs) {
      const bad = await checkPair(p.from, p.to, me);
      if (bad) { failed.push({ ...p, error: bad }); continue; }
      try {
        const moved: Record<string, number> = {};
        let dropped = 0;
        let names: any = {};
        await withTransaction(async (q) => {
          const [from] = await q("SELECT * FROM users WHERE id = ? FOR UPDATE", [p.from]);
          const [to] = await q("SELECT * FROM users WHERE id = ? FOR UPDATE", [p.to]);
          names = { from_name: from.name, from_login: from.username || from.email, to_name: to.name };
          const cols = await userColumns(q);
          // Access: either the old account's rows replace the import's, or are dropped.
          for (const t of ACCESS_TABLES) {
            const has = cols.some((c) => c.table === t && c.column === "user_id");
            if (!has) continue;
            if (access === "old") {
              const n: any[] = await q(`SELECT COUNT(*) AS n FROM \`${t}\` WHERE user_id = ?`, [p.from]);
              if (Number(n?.[0]?.n || 0) > 0) await q(`DELETE FROM \`${t}\` WHERE user_id = ?`, [p.to]);
            } else {
              await q(`DELETE FROM \`${t}\` WHERE user_id = ?`, [p.from]);
            }
          }
          for (const c of cols) {
            if (c.table === "users") continue;
            const r: any = await q(`UPDATE IGNORE \`${c.table}\` SET \`${c.column}\` = ? WHERE \`${c.column}\` = ?`, [p.to, p.from]);
            const n = Number(r?.affectedRows || 0);
            if (n) moved[c.table] = (moved[c.table] || 0) + n;
            // Left over: the import's login already has that exact row (one per day, per module…) — theirs stays.
            const d: any = await q(`DELETE FROM \`${c.table}\` WHERE \`${c.column}\` = ?`, [p.from]);
            dropped += Number(d?.affectedRows || 0);
          }
          await q("UPDATE users SET blocked_by = ? WHERE blocked_by = ?", [p.to, p.from]);
          // Ids inside JSON / lists (approval steps, HR action chains, recurring task assignees).
          for (const l of await listColumns(q)) {
            const rows: any[] = await q(`SELECT * FROM \`${l.table}\` WHERE \`${l.column}\` LIKE ?`, [`%${p.from}%`]).catch(() => []);
            for (const row of rows) {
              const raw = row[l.column];
              let next: string | null = null;
              if (l.csv && !/^\s*[[{]/.test(String(raw))) {
                const parts = String(raw).split(",").map((s) => s.trim());
                if (parts.includes(String(p.from))) next = [...new Set(parts.map((s) => (s === String(p.from) ? String(p.to) : s)))].join(",");
              } else {
                let v: any;
                try { v = JSON.parse(String(raw)); } catch { continue; }
                const [out, hit] = swapIn(v, p.from, p.to, l.column);
                if (hit) next = JSON.stringify(out);
              }
              if (next === null || row.id === undefined) continue;
              await q(`UPDATE \`${l.table}\` SET \`${l.column}\` = ? WHERE id = ?`, [next, row.id]);
              moved[`${l.table} (list)`] = (moved[`${l.table} (list)`] || 0) + 1;
            }
          }
          // The kept login: the old one's access / password if asked; its email when the import's has none.
          const set: string[] = [];
          const vals: any[] = [];
          if (access === "old") {
            for (const k of Object.keys(from)) if (ACCESS_USER_COLS(k) && k !== "role") { set.push(`\`${k}\` = ?`); vals.push(from[k]); }
            if (to.role !== "superadmin") { set.push("role = ?"); vals.push(from.role); }
          }
          if (password === "old" && from.password_hash) {
            set.push("password_hash = ?", "must_change_password = 0", "sessions_valid_after = NOW()");
            vals.push(from.password_hash);
          }
          const moveEmail = !to.email && from.email;
          await q("DELETE FROM users WHERE id = ?", [p.from]);
          if (moveEmail) { set.push("email = ?"); vals.push(from.email); }
          if (set.length) await q(`UPDATE users SET ${set.join(", ")} WHERE id = ?`, [...vals, p.to]);
          await q(
            "INSERT INTO user_merge_log (from_user_id, from_name, from_login, to_user_id, to_name, kept_access, kept_password, moved_json, merged_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [p.from, names.from_name, names.from_login, p.to, names.to_name, access, password, JSON.stringify({ moved, dropped }), me]
          );
        });
        done.push({ ...p, ...names, moved: Object.values(moved).reduce((a, b) => a + b, 0), dropped });
      } catch (e: any) {
        failed.push({ ...p, error: e.message });
      }
    }
    res.json({ merged: done, failed });
  });

  app.get("/api/users/merge/log", ...guard, async (_req: any, res: any) => {
    try {
      const rows: any[] = await queryDB(
        "SELECT l.*, u.name AS merged_by_name FROM user_merge_log l LEFT JOIN users u ON u.id = l.merged_by ORDER BY l.id DESC LIMIT 200"
      );
      res.json(rows.map((r) => ({ ...r, moved: (() => { try { return JSON.parse(r.moved_json || "{}"); } catch { return {}; } })() })));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
