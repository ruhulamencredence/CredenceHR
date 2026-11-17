/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> MPR Edit Log (module "editlog").
//
//   read          the edit history: one event per save (what one person
//                 changed on one MPR row within the same minute), filtered by
//                 time, Project, kind of change, who and Job / MPR / item, 50
//                 at a time — plus "Tried, not saved": an edit the server
//                 refused (locked Budget, rule broken…), recorded by
//                 recordEditAttempt below so "I did edit it" can be checked.
//   mpr_followup  Needs update (Delivery Date passed, material not fully
//                 received) and People (per MPR owner). Explicit-only.
//
// The Job Edit approvals on the same page stay in EntriesRoutes.ts.

import type { Express } from "express";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface Deps {
  authenticateToken: any;
  requireModule: (moduleKey: any) => any;
  requireModuleLayer: (moduleKey: any, layer: any) => any;
  queryDB: QueryDB;
  todayInDhaka: () => string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ymd = (v: any): string | null => {
  if (!v) return null;
  if (v instanceof Date) return new Date(v.getTime() + 6 * 3600 * 1000).toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return DATE_RE.test(s) ? s : null;
};
const num = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

// The kinds of change the page filters on (entry_edit_history.field_name).
const KIND_FIELDS: Record<string, string[]> = {
  delivery_date: ["delivery_date"],
  qty: ["requisitioned_qty"],
  item: ["item_name"],
  mpr: ["mpr_no"],
  job: ["job_name", "job_duration"],
  job_edit: ["job_edit_add", "job_edit_new_job"],
  close_short: ["close_short", "close_short_undo"]
};

export async function ensureMprEditLogSchema(dbPool: any): Promise<void> {
  await dbPool
    .query(
      `CREATE TABLE IF NOT EXISTS entry_edit_attempts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        entry_id INT NOT NULL,
        user_id INT NULL,
        fields_json TEXT NULL,
        reason VARCHAR(500) NULL,
        status_code INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_entry_edit_attempts_created (created_at),
        INDEX idx_entry_edit_attempts_entry (entry_id)
      ) DEFAULT CHARSET=utf8mb4`
    )
    .catch((err: any) => console.warn("⚠️ MPR Edit Log: " + err.message));
  await dbPool.query("ALTER TABLE entry_edit_history ADD INDEX idx_entry_edit_history_at (edited_at)").catch(() => {});
  // Close short (MprCloseShortRoutes.ts): the part of a row's Qty set aside
  // because it won't arrive inside its Budget — kept, never deleted.
  for (const col of [
    "closed_short_qty DECIMAL(14,3) NOT NULL DEFAULT 0",
    "closed_short_at DATETIME NULL",
    "closed_short_by INT NULL",
    "closed_short_reason VARCHAR(500) NULL"
  ]) {
    await dbPool.query(`ALTER TABLE entries ADD COLUMN ${col}`).catch((err: any) => {
      if (err?.code !== "ER_DUP_FIELDNAME") console.warn("⚠️ Close short: " + err.message);
    });
  }
}

// Put in front of PUT /api/entries/:id: when the edit is refused (400 / 403 /
// 409), what was tried and why is kept as a "Tried, not saved" event. Nothing
// is kept for an edit that went through (entry_edit_history has it) or for a
// missing row.
export function recordEditAttempt(queryDB: QueryDB) {
  return (req: any, res: any, next: any) => {
    const json = res.json.bind(res);
    res.json = (body: any) => {
      const code = Number(res.statusCode);
      if ((code === 400 || code === 403 || code === 409) && Number(req.params?.id) > 0 && req.user?.id) {
        const b = req.body || {};
        const fields: Record<string, any> = {};
        for (const k of ["item_name", "delivery_date", "requisitioned_qty", "mpr_id", "mpr_no", "job_name", "job_duration"]) {
          if (b[k] !== undefined && b[k] !== null && b[k] !== "") fields[k] = String(b[k]).slice(0, 200);
        }
        queryDB("INSERT INTO entry_edit_attempts (entry_id, user_id, fields_json, reason, status_code) VALUES (?, ?, ?, ?, ?)", [
          Number(req.params.id),
          Number(req.user.id),
          JSON.stringify(fields),
          String(body?.error || "").slice(0, 500),
          code
        ]).catch(() => {});
      }
      return json(body);
    };
    next();
  };
}

export function registerMprEditLogRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireModule, requireModuleLayer, queryDB, todayInDhaka } = deps;
  const readGate = [authenticateToken, requireModule("editlog"), requireModuleLayer("editlog", "read")];
  const followGate = [authenticateToken, requireModule("editlog"), requireModuleLayer("editlog", "mpr_followup")];

  // The time window: ?range=today|7d|month|all or ?from=&to= (YYYY-MM-DD).
  const windowOf = (q: any): { from: string | null; to: string | null } => {
    const today = todayInDhaka();
    const from = DATE_RE.test(String(q.from || "")) ? String(q.from) : null;
    const to = DATE_RE.test(String(q.to || "")) ? String(q.to) : null;
    if (from || to) return { from, to };
    const r = String(q.range || "7d");
    if (r === "all") return { from: null, to: null };
    if (r === "today") return { from: today, to: today };
    if (r === "month") return { from: `${today.slice(0, 7)}-01`, to: today };
    return { from: addDays(today, -6), to: today };
  };

  // Rows of entry_edit_history + entry_edit_attempts in the window, with the
  // entry's Job / MPR / item / Project / owner, as page events.
  async function loadEvents(q: any) {
    const w = windowOf(q);
    const kind = String(q.kind || "");
    const projectId = Number(q.project_id) || null;
    const editor = Number(q.editor) || null;
    const search = String(q.q || "").trim().toLowerCase();
    const where: string[] = [];
    const params: any[] = [];
    // edited_at is a server timestamp; the window is Bangladesh dates.
    if (w.from) {
      where.push("h.edited_at >= ?");
      params.push(`${w.from} 00:00:00`);
    }
    if (w.to) {
      where.push("h.edited_at < ?");
      params.push(`${addDays(w.to, 1)} 00:00:00`);
    }
    if (projectId) {
      where.push("e.project_id = ?");
      params.push(projectId);
    }
    if (editor) {
      where.push("h.edited_by = ?");
      params.push(editor);
    }
    const ENTRY_COLS = `e.id AS entry_id, e.item_name, e.project_id, e.created_by AS owner_id, j.job_no, m.mpr_no, p.project_name,
                        ou.name AS owner_name`;
    const ENTRY_JOINS = `JOIN entries e ON e.id = h.entry_id
                         LEFT JOIN jobs j ON j.id = e.job_id
                         LEFT JOIN mpr_numbers m ON m.id = e.mpr_id
                         LEFT JOIN projects p ON p.id = e.project_id
                         LEFT JOIN users ou ON ou.id = e.created_by`;
    let hist: any[] = [];
    if (kind !== "attempt") {
      const kf = KIND_FIELDS[kind];
      const w2 = [...where];
      const p2 = [...params];
      if (kf) {
        w2.push(`h.field_name IN (${kf.map(() => "?").join(",")})`);
        p2.push(...kf);
      }
      hist =
        (await queryDB(
          `SELECT h.id, h.field_name, h.old_value, h.new_value, h.edited_at, h.edited_by, u.name AS editor_name, ${ENTRY_COLS}
           FROM entry_edit_history h ${ENTRY_JOINS} LEFT JOIN users u ON u.id = h.edited_by
           ${w2.length ? "WHERE " + w2.join(" AND ") : ""}
           ORDER BY h.edited_at DESC, h.id DESC LIMIT 20000`,
          p2
        ).catch(() => [])) || [];
    }
    let tries: any[] = [];
    if (!kind || kind === "attempt") {
      const w3 = where.map((c) => c.replace("h.edited_at", "h.created_at").replace("h.edited_by", "h.user_id"));
      tries =
        (await queryDB(
          `SELECT h.id, h.fields_json, h.reason, h.created_at, h.user_id, u.name AS editor_name, ${ENTRY_COLS},
                  e.delivery_date AS cur_delivery_date, e.requisitioned_qty AS cur_qty, e.item_name AS cur_item
           FROM entry_edit_attempts h ${ENTRY_JOINS} LEFT JOIN users u ON u.id = h.user_id
           ${w3.length ? "WHERE " + w3.join(" AND ") : ""}
           ORDER BY h.created_at DESC, h.id DESC LIMIT 5000`,
          params
        ).catch(() => [])) || [];
    }

    // One event per save: same row, same person, same minute.
    const events: any[] = [];
    const byKey = new Map<string, any>();
    for (const h of hist) {
      const at = new Date(h.edited_at);
      const key = `${h.entry_id}|${h.edited_by}|${Math.floor(at.getTime() / 60000)}`;
      let ev = byKey.get(key);
      if (!ev) {
        ev = {
          id: `h${h.id}`,
          type: "edit",
          at: at.toISOString(),
          entry_id: h.entry_id,
          job_no: h.job_no,
          mpr_no: h.mpr_no,
          item_name: h.item_name,
          project_id: h.project_id,
          project_name: h.project_name,
          owner_name: h.owner_name,
          editor_id: h.edited_by,
          editor_name: h.editor_name,
          changes: [] as any[]
        };
        byKey.set(key, ev);
        events.push(ev);
      }
      ev.changes.push({ field: h.field_name, from: h.old_value, to: h.new_value });
    }
    for (const t of tries) {
      let fields: Record<string, any> = {};
      try {
        fields = JSON.parse(t.fields_json || "{}") || {};
      } catch {
        fields = {};
      }
      const changes: any[] = [];
      if (fields.delivery_date && ymd(fields.delivery_date) !== ymd(t.cur_delivery_date))
        changes.push({ field: "delivery_date", from: ymd(t.cur_delivery_date), to: ymd(fields.delivery_date) });
      if (fields.requisitioned_qty !== undefined && num(fields.requisitioned_qty) !== num(t.cur_qty))
        changes.push({ field: "requisitioned_qty", from: t.cur_qty == null ? "" : String(t.cur_qty), to: String(fields.requisitioned_qty) });
      if (fields.item_name && String(fields.item_name).trim() !== String(t.cur_item || "").trim())
        changes.push({ field: "item_name", from: t.cur_item, to: fields.item_name });
      events.push({
        id: `a${t.id}`,
        type: "attempt",
        at: new Date(t.created_at).toISOString(),
        entry_id: t.entry_id,
        job_no: t.job_no,
        mpr_no: t.mpr_no,
        item_name: t.item_name,
        project_id: t.project_id,
        project_name: t.project_name,
        owner_name: t.owner_name,
        editor_id: t.user_id,
        editor_name: t.editor_name,
        reason: t.reason || "",
        changes
      });
    }
    const matches = (ev: any) =>
      !search ||
      [ev.job_no, ev.mpr_no, ev.item_name, ev.editor_name, ev.owner_name, ev.project_name].some((v) => String(v || "").toLowerCase().includes(search));
    const list = events.filter(matches).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return { list, window: w };
  }

  // GET /api/mpr-edit-log?range=&from=&to=&project_id=&kind=&editor=&q=&limit=&offset=
  //   { items, total, stats, window, editors }
  app.get("/api/mpr-edit-log", ...readGate, async (req: any, res) => {
    try {
      const { list, window } = await loadEvents(req.query);
      const limit = req.query.limit === "all" ? 5000 : Math.min(500, Math.max(1, Number(req.query.limit) || 50));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const today = todayInDhaka();
      const local = (iso: string) => new Date(new Date(iso).getTime() + 6 * 3600 * 1000).toISOString().slice(0, 10);
      const edits = list.filter((e) => e.type === "edit");
      const stats = {
        saves: edits.length,
        today: edits.filter((e) => local(e.at) === today).length,
        later: edits.filter((e) => e.changes.some((c: any) => c.field === "delivery_date" && String(c.to || "") > String(c.from || ""))).length,
        attempts: list.length - edits.length,
        people: new Set(list.map((e) => e.editor_id).filter(Boolean)).size
      };
      // Who edited in the window — the "Edited by" picker.
      const editors = [...new Map(list.filter((e) => e.editor_id).map((e) => [e.editor_id, { id: e.editor_id, name: e.editor_name || `#${e.editor_id}` }])).values()].sort(
        (a: any, b: any) => String(a.name).localeCompare(String(b.name))
      );
      res.json({ items: list.slice(offset, offset + limit), total: list.length, stats, window, editors });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Could not load the edit log." });
    }
  });

  // GET /api/mpr-edit-log/entry/:id — one MPR row from the start: created,
  // every change, every refused try.
  app.get("/api/mpr-edit-log/entry/:id", ...readGate, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const e: any = ((await queryDB(
        `SELECT e.id, e.item_name, e.delivery_date, e.requisitioned_qty, e.created_at, e.entry_date, j.job_no, m.mpr_no, p.project_name, ou.name AS owner_name
         FROM entries e LEFT JOIN jobs j ON j.id = e.job_id LEFT JOIN mpr_numbers m ON m.id = e.mpr_id
         LEFT JOIN projects p ON p.id = e.project_id LEFT JOIN users ou ON ou.id = e.created_by WHERE e.id = ?`,
        [id]
      )) || [])[0];
      if (!e) return res.status(404).json({ error: "MPR row not found." });
      const hist: any[] =
        (await queryDB(
          `SELECT h.id, h.field_name, h.old_value, h.new_value, h.edited_at, h.edited_by, u.name AS editor_name
           FROM entry_edit_history h LEFT JOIN users u ON u.id = h.edited_by WHERE h.entry_id = ? ORDER BY h.edited_at DESC, h.id DESC`,
          [id]
        )) || [];
      const tries: any[] =
        (await queryDB(
          `SELECT h.id, h.fields_json, h.reason, h.created_at, u.name AS editor_name
           FROM entry_edit_attempts h LEFT JOIN users u ON u.id = h.user_id WHERE h.entry_id = ? ORDER BY h.created_at DESC`,
          [id]
        ).catch(() => [])) || [];
      res.json({
        entry: { ...e, delivery_date: ymd(e.delivery_date), entry_date: ymd(e.entry_date) },
        changes: hist.map((h) => ({ id: h.id, at: new Date(h.edited_at).toISOString(), field: h.field_name, from: h.old_value, to: h.new_value, by: h.editor_name })),
        attempts: tries.map((t) => ({ id: t.id, at: new Date(t.created_at).toISOString(), reason: t.reason, by: t.editor_name, fields: (() => { try { return JSON.parse(t.fields_json || "{}"); } catch { return {}; } })() }))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Could not load the history." });
    }
  });

  // Open MPR rows: not deleted, not fully received (Material Dispatch's
  // received Qty; the part closed short doesn't count as owed).
  const OPEN_ROWS = `FROM entries e
      LEFT JOIN jobs j ON j.id = e.job_id
      LEFT JOIN mpr_numbers m ON m.id = e.mpr_id
      LEFT JOIN projects p ON p.id = e.project_id
      LEFT JOIN users ou ON ou.id = e.created_by
      WHERE e.deleted_at IS NULL
        AND COALESCE(e.md_received_qty, 0) + COALESCE(e.closed_short_qty, 0) < COALESCE(e.requisitioned_qty, 0)`;

  // GET /api/mpr-edit-log/needs-update?project_id=&owner=  — Delivery Date
  // passed, material still owed, oldest first, with the last saved edit and
  // the last refused try.
  app.get("/api/mpr-edit-log/needs-update", ...followGate, async (req: any, res) => {
    try {
      const today = todayInDhaka();
      const params: any[] = [today];
      let extra = "";
      if (Number(req.query.project_id)) {
        extra += " AND e.project_id = ?";
        params.push(Number(req.query.project_id));
      }
      if (Number(req.query.owner)) {
        extra += " AND e.created_by = ?";
        params.push(Number(req.query.owner));
      }
      const rows: any[] =
        (await queryDB(
          `SELECT e.id, e.item_name, e.delivery_date, e.requisitioned_qty, COALESCE(e.md_received_qty, 0) AS received_qty,
                  COALESCE(e.closed_short_qty, 0) AS closed_short_qty, e.created_by AS owner_id, ou.name AS owner_name,
                  j.job_no, m.mpr_no, p.project_name,
                  (SELECT MAX(h.edited_at) FROM entry_edit_history h WHERE h.entry_id = e.id) AS last_edit_at,
                  (SELECT MAX(a.created_at) FROM entry_edit_attempts a WHERE a.entry_id = e.id) AS last_try_at
           ${OPEN_ROWS} AND e.delivery_date < ? ${extra}
           ORDER BY e.delivery_date ASC, e.id ASC LIMIT 2000`,
          params
        ).catch((err: any) => {
          // Before Close short's column exists.
          if (/closed_short_qty/.test(String(err?.message))) return [];
          throw err;
        })) || [];
      res.json(
        rows.map((r) => {
          const due = ymd(r.delivery_date) || today;
          return {
            id: r.id,
            job_no: r.job_no,
            mpr_no: r.mpr_no,
            item_name: r.item_name,
            project_name: r.project_name,
            owner_id: r.owner_id,
            owner_name: r.owner_name,
            delivery_date: due,
            overdue_days: Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86400000),
            qty: num(r.requisitioned_qty),
            received: num(r.received_qty),
            closed_short: num(r.closed_short_qty),
            last_edit_at: r.last_edit_at ? new Date(r.last_edit_at).toISOString() : null,
            last_try_at: r.last_try_at ? new Date(r.last_try_at).toISOString() : null
          };
        })
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Could not load the list." });
    }
  });

  // GET /api/mpr-edit-log/people?days=7|30|month — per MPR owner:
  //   overdue      open rows whose Delivery Date has passed, now
  //   due          rows whose Delivery Date fell in the window
  //   in_time      of those: fully received by the date, or its Delivery Date
  //                changed on / before the old date
  //   saves        edits this person saved in the window (any row)
  //   tries        edits of theirs refused in the window
  //   last_edit    their last saved edit
  app.get("/api/mpr-edit-log/people", ...followGate, async (req: any, res) => {
    try {
      const today = todayInDhaka();
      const d = String(req.query.days || "30");
      const from = d === "month" ? `${today.slice(0, 7)}-01` : addDays(today, -(d === "7" ? 6 : 29));
      const overdue: any[] =
        (await queryDB(`SELECT e.created_by AS uid, COUNT(*) AS n ${OPEN_ROWS} AND e.delivery_date < ? GROUP BY e.created_by`, [today]).catch(() => [])) || [];
      const due: any[] =
        (await queryDB(
          `SELECT e.id, e.created_by AS uid, e.delivery_date, e.requisitioned_qty, COALESCE(e.md_received_qty, 0) AS rq, e.md_received_date
           FROM entries e WHERE e.deleted_at IS NULL AND e.delivery_date BETWEEN ? AND ?`,
          [from, addDays(today, -1)]
        ).catch(() => [])) || [];
      const dueIds = due.map((r) => Number(r.id));
      const moved: any[] = dueIds.length
        ? (await queryDB(
            `SELECT entry_id, old_value, edited_at FROM entry_edit_history WHERE field_name = 'delivery_date' AND entry_id IN (${dueIds.map(() => "?").join(",")})`,
            dueIds
          ).catch(() => [])) || []
        : [];
      const movedInTime = new Set<number>();
      for (const m of moved) {
        const old = ymd(m.old_value);
        const at = ymd(m.edited_at);
        if (old && at && at <= old) movedInTime.add(Number(m.entry_id));
      }
      const saves: any[] =
        (await queryDB(
          `SELECT edited_by AS uid, COUNT(DISTINCT CONCAT(entry_id, '|', DATE_FORMAT(edited_at, '%Y-%m-%d %H:%i'))) AS n, MAX(edited_at) AS last_at
           FROM entry_edit_history WHERE edited_at >= ? GROUP BY edited_by`,
          [`${from} 00:00:00`]
        ).catch(() => [])) || [];
      const lastEver: any[] = (await queryDB("SELECT edited_by AS uid, MAX(edited_at) AS last_at FROM entry_edit_history GROUP BY edited_by").catch(() => [])) || [];
      const tries: any[] =
        (await queryDB("SELECT user_id AS uid, COUNT(*) AS n FROM entry_edit_attempts WHERE created_at >= ? GROUP BY user_id", [`${from} 00:00:00`]).catch(() => [])) || [];
      const people = new Map<number, any>();
      const row = (uid: number) => {
        if (!people.has(uid)) people.set(uid, { user_id: uid, overdue: 0, due: 0, in_time: 0, saves: 0, tries: 0, last_edit: null as string | null });
        return people.get(uid);
      };
      for (const o of overdue) if (o.uid) row(Number(o.uid)).overdue = num(o.n);
      for (const r of due) {
        if (!r.uid) continue;
        const p = row(Number(r.uid));
        p.due++;
        const due = ymd(r.delivery_date) || "";
        const fullyIn = num(r.rq) >= num(r.requisitioned_qty) && (!r.md_received_date || (ymd(r.md_received_date) || "") <= due);
        if (fullyIn || movedInTime.has(Number(r.id))) p.in_time++;
      }
      for (const s of saves) if (s.uid) row(Number(s.uid)).saves = num(s.n);
      for (const t of tries) if (t.uid) row(Number(t.uid)).tries = num(t.n);
      for (const l of lastEver) if (l.uid && people.has(Number(l.uid))) row(Number(l.uid)).last_edit = l.last_at ? new Date(l.last_at).toISOString() : null;
      const ids = [...people.keys()];
      const names: any[] = ids.length ? (await queryDB(`SELECT id, name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`, ids).catch(() => [])) || [] : [];
      const nameOf = new Map(names.map((n: any) => [Number(n.id), n.name]));
      const projects: any[] = ids.length
        ? (await queryDB(
            `SELECT e.created_by AS uid, GROUP_CONCAT(DISTINCT p.project_name ORDER BY p.project_name SEPARATOR ', ') AS names
             FROM entries e JOIN projects p ON p.id = e.project_id WHERE e.deleted_at IS NULL AND e.created_by IN (${ids.map(() => "?").join(",")}) GROUP BY e.created_by`,
            ids
          ).catch(() => [])) || []
        : [];
      const projOf = new Map(projects.map((r: any) => [Number(r.uid), r.names]));
      res.json({
        from,
        to: today,
        people: [...people.values()]
          .map((p) => ({ ...p, name: nameOf.get(p.user_id) || `#${p.user_id}`, projects: projOf.get(p.user_id) || "" }))
          .sort((a, b) => b.overdue - a.overdue || a.name.localeCompare(b.name))
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || "Could not load the people view." });
    }
  });
}
