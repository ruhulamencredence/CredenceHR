// Admin Panel -> Designations (module "designations"): one list of
// designations for all companies of the group, each with a permanent code
// (DSG-001, DSG-002…) that never changes when the name does and is never
// given out again (a merged / deleted one keeps its code, marked so).
//
// Employees keep their designation as text (all_employees.designation — what
// every screen and report already reads) and are linked to the list by
// all_employees.designation_id. syncDesignations() links every employee's
// text to the list (case, spaces and dots don't make a new one; a new name
// adds a new designation) — so Employees, Excel import, Onboarding, HR
// actions all stay in step without each of them changing. Rename and Merge
// write the new name to the employees and to the rules that name a
// designation (OT rates, leave workflows), open job postings and onboarding;
// history (transfers, previous experience) keeps the name it had.
//
// Access: Designations + read to see, edit_add to add / rename / merge /
// level / active, delete_trash to delete one nobody has. Every account that
// can open the Admin Panel may read the names (the employee form's picker).
import type { Express } from "express";

type Q = (sql: string, params?: any[]) => Promise<any>;

interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (k: "designations") => any;
  requireModuleLayer: (k: "designations", layer: "read" | "edit_add" | "delete_trash") => any;
  queryDB: Q;
}

// "Executive", "executive " and "Executive." are one designation.
export const designationKey = (s: any) => String(s ?? "").toLowerCase().replace(/\./g, " ").replace(/\s+/g, " ").trim();
// "Sr. Executive" looks like "Senior Executive" — asked about, never merged by itself.
const ABBR: [RegExp, string][] = [
  [/\bsr\b/g, "senior"], [/\bjr\b/g, "junior"], [/\basstt?\b/g, "assistant"], [/\bdy\b/g, "deputy"], [/\bdpty\b/g, "deputy"],
  [/\bmgr\b/g, "manager"], [/\bengr\b/g, "engineer"], [/\bexec?\b/g, "executive"], [/\boffr\b/g, "officer"], [/\bcoord\b/g, "coordinator"]
];
export const designationLook = (s: any) => {
  let k = designationKey(s).replace(/&/g, " and ").replace(/[-_/,()]/g, " ");
  for (const [re, to] of ABBR) k = k.replace(re, to);
  return k.replace(/\s+/g, "").trim();
};
const codeOf = (n: number) => `DSG-${String(n).padStart(3, "0")}`;
// Other tables that name a designation as the rule / the current state (renamed with it).
const NAMED_IN: { table: string; label: string }[] = [
  { table: "ot_rates", label: "OT rates" },
  { table: "leave_balance_workflows", label: "Leave workflows" },
  { table: "employee_company_assignments", label: "Company assignments" },
  { table: "job_postings", label: "Job postings" },
  { table: "onboarding_applications", label: "Onboarding" }
];

export function registerDesignationRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireAdmin, requireModule, requireModuleLayer, queryDB } = deps;
  const read = [authenticateToken, requireAdmin, requireModule("designations"), requireModuleLayer("designations", "read")];
  const edit = [authenticateToken, requireAdmin, requireModule("designations"), requireModuleLayer("designations", "edit_add")];
  const del = [authenticateToken, requireAdmin, requireModule("designations"), requireModuleLayer("designations", "delete_trash")];
  const bad = (message: string, status = 400, extra: any = {}) => Object.assign(new Error(message), { status, extra });
  const handler = (fn: (req: any, res: any) => Promise<any>) => async (req: any, res: any) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      res.status(Number(e?.status) || 500).json({ error: e?.message || "Something went wrong.", ...(e?.extra || {}) });
    }
  };

  // ---- schema (one list for the whole group: no company_id) ----------------
  const ready = (async () => {
    await queryDB(
      `/*unscoped*/ CREATE TABLE IF NOT EXISTS designations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(20) NOT NULL,
        code_no INT NOT NULL,
        name VARCHAR(150) NOT NULL,
        name_key VARCHAR(150) NOT NULL,
        level INT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        is_deleted TINYINT(1) NOT NULL DEFAULT 0,
        merged_into INT NULL,
        created_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_designation_code (code),
        KEY idx_designation_key (name_key)
      ) DEFAULT CHARSET=utf8mb4`
    ).catch((e: any) => console.warn("⚠️ designations:", e.message));
    await queryDB("/*unscoped*/ ALTER TABLE all_employees ADD COLUMN designation_id INT NULL").catch(() => undefined);
    await queryDB("/*unscoped*/ ALTER TABLE all_employees ADD INDEX idx_emp_designation_id (designation_id)").catch(() => undefined);
  })();

  const all = async (): Promise<any[]> => ((await queryDB("/*unscoped*/ SELECT * FROM designations ORDER BY code_no ASC")) || []) as any[];
  const live = (rows: any[]) => rows.filter((r) => !Number(r.is_deleted));
  const nextCodeNo = async () => Number(((await queryDB("/*unscoped*/ SELECT COALESCE(MAX(code_no), 0) AS n FROM designations")) || [])[0]?.n || 0) + 1;
  async function create(name: string, userId: number | null) {
    for (let tries = 0; tries < 5; tries++) {
      const n = await nextCodeNo();
      try {
        const r: any = await queryDB("/*unscoped*/ INSERT INTO designations (code, code_no, name, name_key, created_by) VALUES (?, ?, ?, ?, ?)", [codeOf(n), n, name, designationKey(name), userId]);
        return { id: Number(r.insertId), code: codeOf(n), code_no: n, name, name_key: designationKey(name), is_active: 1, is_deleted: 0 };
      } catch (e: any) {
        if (!/Duplicate/i.test(String(e?.message))) throw e;
      }
    }
    throw new Error("Could not give the designation a code — try again.");
  }

  // Every employee's designation text linked to the list (a new name adds a
  // designation; a merged-away name goes to where it was merged).
  let syncing: Promise<void> | null = null;
  let syncedAt = 0;
  async function syncDesignations(force = false) {
    if (syncing) return syncing;
    if (!force && Date.now() - syncedAt < 30_000) return;
    syncing = (async () => {
      await ready;
      const emps: any[] = ((await queryDB("/*unscoped*/ SELECT id, designation, designation_id FROM all_employees WHERE designation IS NOT NULL AND TRIM(designation) <> ''")) || []) as any[];
      let rows = await all();
      const byKey = new Map<string, any>();
      for (const r of live(rows)) byKey.set(r.name_key, r);
      // A name merged away goes to the one it was merged into (an old Excel can still say it).
      for (const r of rows) {
        if (!Number(r.is_deleted) || !Number(r.merged_into) || byKey.has(r.name_key)) continue;
        let t = r;
        for (let hop = 0; hop < 10 && Number(t.merged_into); hop++) t = rows.find((x) => Number(x.id) === Number(t.merged_into)) || t;
        if (!Number(t.is_deleted)) byKey.set(r.name_key, t);
      }
      // Written as its code (an Excel with "DSG-006"): that designation (or where it was merged).
      for (const r of rows) {
        let t = r;
        for (let hop = 0; hop < 10 && Number(t.merged_into); hop++) t = rows.find((x) => Number(x.id) === Number(t.merged_into)) || t;
        if (!Number(t.is_deleted)) byKey.set(designationKey(r.code), t);
      }
      // New names: the spelling most people have becomes the designation's name.
      const fresh = new Map<string, Map<string, number>>();
      for (const e of emps) {
        const k = designationKey(e.designation);
        if (!k || byKey.has(k) || /^dsg-\d+$/.test(k)) continue;
        const m = fresh.get(k) || new Map<string, number>();
        const t = String(e.designation).replace(/\s+/g, " ").trim();
        m.set(t, (m.get(t) || 0) + 1);
        fresh.set(k, m);
      }
      for (const [k, spellings] of fresh) {
        const name = [...spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0].slice(0, 150);
        byKey.set(k, await create(name, null));
      }
      if (fresh.size) rows = await all();
      for (const e of emps) {
        const d = byKey.get(designationKey(e.designation));
        if (!d) continue;
        if (Number(e.designation_id) !== Number(d.id) || String(e.designation) !== String(d.name))
          await queryDB("/*unscoped*/ UPDATE all_employees SET designation_id = ?, designation = ? WHERE id = ?", [Number(d.id), d.name, Number(e.id)]);
      }
      syncedAt = Date.now();
    })().finally(() => {
      syncing = null;
    });
    return syncing;
  }
  setTimeout(() => void syncDesignations(true).catch((e) => console.warn("⚠️ designations sync:", e?.message)), 20_000);
  const timer = setInterval(() => void syncDesignations(true).catch(() => undefined), 10 * 60_000);
  (timer as any).unref?.();

  // Text in the other tables that names this designation (same key).
  async function namedIn(key: string) {
    const out: { table: string; label: string; values: string[]; rows: number }[] = [];
    for (const t of NAMED_IN) {
      const vals: any[] = ((await queryDB(`/*unscoped*/ SELECT designation AS v, COUNT(*) AS n FROM \`${t.table}\` WHERE designation IS NOT NULL GROUP BY designation`).catch(() => [])) || []) as any[];
      const hit = vals.filter((x) => designationKey(x.v) === key);
      if (hit.length) out.push({ table: t.table, label: t.label, values: hit.map((x) => String(x.v)), rows: hit.reduce((s, x) => s + Number(x.n), 0) });
    }
    return out;
  }
  async function renameEverywhere(id: number, fromKeys: string[], to: string) {
    let employees = 0;
    const r: any = await queryDB("/*unscoped*/ UPDATE all_employees SET designation = ?, designation_id = ? WHERE designation_id = ?", [to, id, id]);
    employees += Number(r?.affectedRows || 0);
    let rules = 0;
    for (const k of fromKeys) {
      for (const t of await namedIn(k)) {
        for (const v of t.values) {
          const u: any = await queryDB(`/*unscoped*/ UPDATE \`${t.table}\` SET designation = ? WHERE designation = ?`, [to, v]).catch(() => null);
          rules += Number(u?.affectedRows || 0);
        }
      }
    }
    return { employees, rules };
  }
  const counts = async () => {
    const rows: any[] = ((await queryDB("/*unscoped*/ SELECT designation_id AS id, SUM(COALESCE(is_active, 1) = 1) AS active, SUM(COALESCE(is_active, 1) <> 1) AS inactive FROM all_employees WHERE designation_id IS NOT NULL GROUP BY designation_id")) || []) as any[];
    return new Map<number, { active: number; inactive: number }>(rows.map((r) => [Number(r.id), { active: Number(r.active || 0), inactive: Number(r.inactive || 0) }]));
  };
  const one = async (id: any) => {
    const r = (await all()).find((x) => Number(x.id) === Number(id) && !Number(x.is_deleted));
    if (!r) throw bad("That designation no longer exists.", 404);
    return r;
  };
  // The same name (case / spaces / dots) — refused; a look-alike ("Sr." for "Senior") — asked about.
  async function clash(name: string, exceptId: number | null, force: boolean) {
    const rows = live(await all()).filter((r) => Number(r.id) !== exceptId);
    const same = rows.find((r) => r.name_key === designationKey(name));
    if (same) throw bad(`“${same.name}” already exists (${same.code}).`, 409, { existing: { id: Number(same.id), code: same.code, name: same.name } });
    const look = rows.find((r) => designationLook(r.name) === designationLook(name));
    if (look && !force) throw bad(`Looks like “${look.name}” (${look.code}) — use that one, or add it anyway.`, 409, { similar: { id: Number(look.id), code: look.code, name: look.name } });
  }
  const cleanName = (v: any) => {
    const n = String(v ?? "").replace(/[\u0000-\u001f]/g, "").replace(/\s+/g, " ").trim();
    if (!n) throw bad("Give the designation a name.");
    if (n.length > 150) throw bad("A designation can be at most 150 characters.");
    return n;
  };

  // The list, with how many people (all companies), where else it is named, and look-alike groups.
  app.get(
    "/api/designations",
    ...read,
    handler(async (_req, res) => {
      // The page always shows everyone's current designation (writes only what changed).
      await syncDesignations(true);
      const rows = live(await all());
      const c = await counts();
      const used = new Map<string, { label: string; rows: number }[]>();
      for (const t of NAMED_IN) {
        const vals: any[] = ((await queryDB(`/*unscoped*/ SELECT designation AS v, COUNT(*) AS n FROM \`${t.table}\` WHERE designation IS NOT NULL GROUP BY designation`).catch(() => [])) || []) as any[];
        for (const x of vals) {
          const k = designationKey(x.v);
          used.set(k, [...(used.get(k) || []), { label: t.label, rows: Number(x.n) }]);
        }
      }
      const looks = new Map<string, any[]>();
      for (const r of rows) looks.set(designationLook(r.name), [...(looks.get(designationLook(r.name)) || []), r]);
      res.json({
        designations: rows.map((r) => ({
          id: Number(r.id), code: r.code, name: r.name, level: r.level == null ? null : Number(r.level), isActive: !!Number(r.is_active),
          employees: c.get(Number(r.id))?.active || 0, inactiveEmployees: c.get(Number(r.id))?.inactive || 0,
          usedIn: (used.get(r.name_key) || []).reduce((acc: { label: string; rows: number }[], u) => {
            const hit = acc.find((x) => x.label === u.label);
            if (hit) hit.rows += u.rows;
            else acc.push({ ...u });
            return acc;
          }, [])
        })),
        lookAlikes: [...looks.values()].filter((g) => g.length > 1).map((g) => g.map((r) => Number(r.id)))
      });
    })
  );

  // The names for the employee form's picker (any Admin Panel account).
  app.get(
    "/api/designations/options",
    authenticateToken,
    requireAdmin,
    handler(async (_req, res) => {
      await syncDesignations().catch(() => undefined);
      const c = await counts();
      res.json(live(await all()).filter((r) => Number(r.is_active)).map((r) => ({ id: Number(r.id), code: r.code, name: r.name, employees: c.get(Number(r.id))?.active || 0 })));
    })
  );

  // What a rename / merge would change (the popup shows it first).
  app.get(
    "/api/designations/:id(\\d+)/impact",
    ...read,
    handler(async (req, res) => {
      const r = await one(req.params.id);
      const c = (await counts()).get(Number(r.id)) || { active: 0, inactive: 0 };
      res.json({ employees: c.active + c.inactive, namedIn: (await namedIn(r.name_key)).map((x) => ({ label: x.label, rows: x.rows })) });
    })
  );

  // { name, level?, force? }
  app.post(
    "/api/designations",
    ...edit,
    handler(async (req, res) => {
      await ready;
      const name = cleanName(req.body?.name);
      await clash(name, null, !!req.body?.force);
      const d = await create(name, Number(req.user.id) || null);
      const level = Number(req.body?.level);
      if (level > 0) await queryDB("/*unscoped*/ UPDATE designations SET level = ? WHERE id = ?", [Math.min(999, Math.floor(level)), d.id]);
      res.json({ success: true, designation: { id: d.id, code: d.code, name: d.name } });
    })
  );

  // { name?, level?, isActive?, force? } — a new name goes everywhere, the code stays.
  app.patch(
    "/api/designations/:id(\\d+)",
    ...edit,
    handler(async (req, res) => {
      const r = await one(req.params.id);
      const out: any = { success: true, code: r.code };
      if (req.body?.level !== undefined) {
        const level = req.body.level === null || req.body.level === "" ? null : Math.max(1, Math.min(999, Math.floor(Number(req.body.level)) || 1));
        await queryDB("/*unscoped*/ UPDATE designations SET level = ? WHERE id = ?", [level, Number(r.id)]);
      }
      if (req.body?.isActive !== undefined) await queryDB("/*unscoped*/ UPDATE designations SET is_active = ? WHERE id = ?", [req.body.isActive ? 1 : 0, Number(r.id)]);
      if (req.body?.name !== undefined) {
        const name = cleanName(req.body.name);
        if (name !== r.name) {
          // Everyone saved since the last pass is linked first, so nobody keeps the old name.
          await syncDesignations(true);
          // Same letters, other case / spaces: just tidy the name.
          if (designationKey(name) !== r.name_key) await clash(name, Number(r.id), !!req.body?.force);
          await queryDB("/*unscoped*/ UPDATE designations SET name = ?, name_key = ? WHERE id = ?", [name, designationKey(name), Number(r.id)]);
          Object.assign(out, await renameEverywhere(Number(r.id), [r.name_key], name));
        }
      }
      res.json(out);
    })
  );

  // { keepId, mergeIds: [] } — one designation in the end; the others' codes are retired, never reused.
  app.post(
    "/api/designations/merge",
    ...edit,
    handler(async (req, res) => {
      await syncDesignations(true);
      const keep = await one(req.body?.keepId);
      const ids = (Array.isArray(req.body?.mergeIds) ? req.body.mergeIds : []).map(Number).filter((n: number) => n > 0 && n !== Number(keep.id));
      if (!ids.length) throw bad("Pick the designations to merge into this one.");
      const gone: any[] = [];
      for (const id of ids) gone.push(await one(id));
      let employees = 0;
      let rules = 0;
      for (const g of gone) {
        const r: any = await queryDB("/*unscoped*/ UPDATE all_employees SET designation_id = ?, designation = ? WHERE designation_id = ?", [Number(keep.id), keep.name, Number(g.id)]);
        employees += Number(r?.affectedRows || 0);
        const moved = await renameEverywhere(Number(keep.id), [g.name_key], keep.name);
        rules += moved.rules;
        await queryDB("/*unscoped*/ UPDATE designations SET is_deleted = 1, is_active = 0, merged_into = ? WHERE id = ?", [Number(keep.id), Number(g.id)]);
      }
      res.json({ success: true, keep: { code: keep.code, name: keep.name }, merged: gone.map((g) => g.code), employees, rules });
    })
  );

  // Only one nobody has (its code is retired, never reused).
  app.delete(
    "/api/designations/:id(\\d+)",
    ...del,
    handler(async (req, res) => {
      const r = await one(req.params.id);
      const c = (await counts()).get(Number(r.id));
      if (c && c.active + c.inactive > 0) throw bad(`${c.active + c.inactive} employee(s) have “${r.name}” — merge it into another instead.`);
      await queryDB("/*unscoped*/ UPDATE designations SET is_deleted = 1, is_active = 0 WHERE id = ?", [Number(r.id)]);
      res.json({ success: true });
    })
  );
}
