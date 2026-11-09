/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> PEPM Manage -> Data Import -> Condition Set -> "Material
// conditions": a named group of materials (Description of Material, from the
// Budget imports) with its own minimum days' notice for the Delivery Date —
// on New Job Entry / Add MPR and/or Job Edit, for Admins too when ticked.
// Where the Global / Project / Budget rule also applies, the stricter (more
// days) wins (deliveryDateConditions.ts leadTimeProblem / materialRules;
// enforced in EntriesRoutes.ts and MprDispatchRoutes.ts, shown on the date
// pickers through GET /api/delivery-date-conditions/effective).
//
// A material is in at most one condition (per company group). "Auto-group"
// suggests groups from the material names (sand, chips, tiles, pipe…) and
// flags unassigned materials that look like an existing condition's — it
// never adds anything by itself.
//
// Same gate as the rest of Condition Set: Admin + the "imports" module.

import type { Express } from "express";
import { materialKey } from "./deliveryDateConditions";

export async function ensureMaterialConditionsSchema(dbPool: any): Promise<void> {
  const run = async (sql: string) => {
    try {
      await dbPool.query(sql);
    } catch (err: any) {
      if (!/already exists|Duplicate/i.test(err.message)) console.warn("⚠️ material conditions schema: " + err.message);
    }
  };
  await run(`
    CREATE TABLE IF NOT EXISTS delivery_material_conditions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      group_id INT NOT NULL DEFAULT 1,
      name VARCHAR(120) NOT NULL,
      min_lead_days INT NOT NULL DEFAULT 0,
      applies_entry TINYINT(1) NOT NULL DEFAULT 1,
      applies_job_edit TINYINT(1) NOT NULL DEFAULT 1,
      apply_to_admins TINYINT(1) NOT NULL DEFAULT 0,
      enabled TINYINT(1) NOT NULL DEFAULT 1,
      updated_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      KEY idx_dmc_group (group_id)
    )`);
  await run(`
    CREATE TABLE IF NOT EXISTS delivery_material_condition_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      group_id INT NOT NULL DEFAULT 1,
      condition_id INT NOT NULL,
      material VARCHAR(500) NOT NULL,
      material_key VARCHAR(500) NOT NULL,
      UNIQUE KEY uniq_dmci_material (group_id, material_key(255)),
      KEY idx_dmci_condition (condition_id),
      FOREIGN KEY (condition_id) REFERENCES delivery_material_conditions(id) ON DELETE CASCADE
    )`);
}

// Auto-group: words in a material's name -> a group. First match wins, so the
// more specific ones come first ("Brick Chips" is chips, "Basin wall tiles" is
// tiles). Days are only a starting point — the Admin sets them before creating.
const RULES: { name: string; re: RegExp; days: number }[] = [
  { name: "Tiles & stone finishing", re: /\btiles?\b|granite|marble|mosaic|skirting/i, days: 10 },
  { name: "Stone chips", re: /\bchips?\b|\bshingles?\b|\bkhoa\b/i, days: 5 },
  { name: "Sand", re: /\bsand\b/i, days: 3 },
  { name: "Cement", re: /cement|\bopc\b|\bpcc\b/i, days: 2 },
  { name: "MS Rod / steel", re: /\brods?\b|rebar|\bsteel\b|\bm\.?s\.?\s*(bar|angle|plate|flat|pipe)\b/i, days: 5 },
  { name: "Bricks & blocks", re: /\bbricks?\b|\bblocks?\b/i, days: 3 },
  { name: "Pipes & fittings", re: /pipe|fitting|\belbow\b|\btee\b|\bvalve\b|\bunion\b|\breducer\b/i, days: 7 },
  { name: "Sanitary", re: /basin|commode|toilet|\bsink\b|\btap\b|shower|faucet|cistern|urinal/i, days: 7 },
  { name: "Electrical", re: /\bwires?\b|cable|switch|breaker|\bmcb\b|\bdb\b|socket|\blights?\b|\blamp\b|bulb|conduit/i, days: 7 },
  { name: "Paint & chemicals", re: /paint|primer|putty|distemper|enamel|admixture|chemical|waterproof/i, days: 4 },
  { name: "Glass & aluminium", re: /glass|alumin(i)?um|thai\b/i, days: 10 },
  { name: "Wood & board", re: /plywood|\bboard\b|\btimber\b|\bdoor\b|\blaminate/i, days: 7 }
];
const ruleOf = (m: string) => RULES.find((r) => r.re.test(m)) || null;
const STOP = new Set(["the", "and", "for", "with", "of", "down", "local", "new", "type", "size", "grade", "mm", "inch", "ft"]);
// Leftovers: materials sharing a first real word ("Bitumen 60/70", "Bitumen
// emulsion") form a group too.
const firstWord = (m: string) =>
  (m.toLowerCase().match(/[a-z]{3,}/g) || []).find((w) => !STOP.has(w)) || null;

interface Deps {
  authenticateToken: any;
  requireAdmin: any;
  requireModule: (key: string) => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
}

export function registerMaterialConditionsRoutes(app: Express, deps: Deps) {
  const { authenticateToken, requireAdmin, requireModule, queryDB } = deps;
  const gate = [authenticateToken, requireAdmin, requireModule("imports")];

  // Every distinct Description of Material in the Budget imports (this
  // group), with its unit and in how many Budgets it appears.
  const allMaterials = async (): Promise<{ material: string; key: string; unit: string; budgets: number }[]> => {
    const rows: any[] =
      (await queryDB(
        `SELECT MIN(TRIM(description)) AS material, MAX(unit) AS unit, COUNT(DISTINCT budget_id) AS budgets
           FROM budget_items
          WHERE description IS NOT NULL AND TRIM(description) <> ''
          GROUP BY LOWER(TRIM(description))`
      )) || [];
    return rows.map((r) => ({ material: String(r.material), key: materialKey(r.material), unit: String(r.unit || ""), budgets: Number(r.budgets) || 0 }));
  };
  const assigned = async (): Promise<Map<string, { id: number; name: string }>> => {
    const rows: any[] =
      (await queryDB(
        `SELECT i.material_key, c.id, c.name FROM delivery_material_condition_items i JOIN delivery_material_conditions c ON c.id = i.condition_id`
      )) || [];
    return new Map(rows.map((r) => [String(r.material_key), { id: Number(r.id), name: String(r.name) }]));
  };
  const loadOne = async (id: number) => ((await queryDB("SELECT * FROM delivery_material_conditions WHERE id = ?", [id])) || [])[0] || null;

  const parseBody = (b: any) => {
    const name = String(b?.name || "").trim().slice(0, 120);
    const days = Number(b?.min_lead_days);
    const materials: string[] = Array.isArray(b?.materials)
      ? Array.from(new Map(b.materials.map((m: any) => [materialKey(m), String(m).trim().slice(0, 500)])).entries())
          .filter(([k]) => !!k)
          .map(([, m]) => m as string)
      : [];
    return { name, days, materials, applies_entry: b?.applies_entry === false ? 0 : 1, applies_job_edit: b?.applies_job_edit === false ? 0 : 1, apply_to_admins: b?.apply_to_admins ? 1 : 0, enabled: b?.enabled === false ? 0 : 1 };
  };
  const problemOf = (p: ReturnType<typeof parseBody>, needMaterials: boolean) => {
    if (!p.name) return "Give the condition a name.";
    if (!Number.isInteger(p.days) || p.days < 0 || p.days > 365) return "Minimum days' notice must be a whole number from 0 to 365.";
    if (needMaterials && p.materials.length === 0) return "Pick at least one material.";
    if (!p.applies_entry && !p.applies_job_edit) return "Tick New Job Entry / Add MPR, Job Edit or both.";
    return null;
  };
  // A material is in one condition only: taking it here takes it out of any other.
  const setItems = async (cond: any, materials: string[]) => {
    await queryDB("DELETE FROM delivery_material_condition_items WHERE condition_id = ?", [cond.id]);
    for (const m of materials) {
      await queryDB("DELETE FROM delivery_material_condition_items WHERE group_id = ? AND material_key = ?", [cond.group_id, materialKey(m)]);
      await queryDB("INSERT INTO delivery_material_condition_items (condition_id, material, material_key) VALUES (?, ?, ?)", [cond.id, m, materialKey(m)]);
    }
    // A condition left with no materials (they all moved) goes away.
    await queryDB(
      `DELETE c FROM delivery_material_conditions c LEFT JOIN delivery_material_condition_items i ON i.condition_id = c.id
        WHERE c.group_id = ? AND i.id IS NULL AND c.id <> ?`,
      [cond.group_id, cond.id]
    );
  };

  app.get("/api/delivery-material-conditions", ...gate, async (_req: any, res: any) => {
    try {
      const conds: any[] = (await queryDB("SELECT * FROM delivery_material_conditions ORDER BY name")) || [];
      const items: any[] = (await queryDB("SELECT condition_id, material FROM delivery_material_condition_items ORDER BY material")) || [];
      res.json(conds.map((c) => ({ ...c, materials: items.filter((i) => Number(i.condition_id) === Number(c.id)).map((i) => String(i.material)) })));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // The material picker: search by name; shows unit, Budgets and which
  // condition a material is already in.
  app.get("/api/delivery-material-conditions/materials", ...gate, async (req: any, res: any) => {
    try {
      const q = materialKey(req.query.q || "");
      const [all, taken] = await Promise.all([allMaterials(), assigned()]);
      const hits = all
        .filter((m) => !q || m.key.includes(q))
        .sort((a, b) => b.budgets - a.budgets || a.material.localeCompare(b.material))
        .slice(0, 80)
        .map((m) => ({ ...m, condition: taken.get(m.key) || null }));
      res.json({ total: all.length, materials: hits });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Auto-group: groups for the materials in no condition yet, plus "these
  // look like <existing condition>" hints. Suggestions only.
  app.get("/api/delivery-material-conditions/suggest", ...gate, async (_req: any, res: any) => {
    try {
      const [all, taken] = await Promise.all([allMaterials(), assigned()]);
      const free = all.filter((m) => !taken.has(m.key));
      // Which rule each existing condition stands for (most of its materials).
      const conds: any[] = (await queryDB("SELECT id, name, min_lead_days FROM delivery_material_conditions")) || [];
      const condRule = new Map<string, { id: number; name: string }>();
      for (const c of conds) {
        const mine = all.filter((m) => taken.get(m.key)?.id === Number(c.id));
        const counts = new Map<string, number>();
        for (const m of mine) {
          const r = ruleOf(m.material);
          if (r) counts.set(r.name, (counts.get(r.name) || 0) + 1);
        }
        const best = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
        if (best && best[1] * 2 >= mine.length) condRule.set(best[0], { id: Number(c.id), name: String(c.name) });
      }
      const groups = new Map<string, { name: string; days: number; materials: typeof free }>();
      const addTo = new Map<number, { condition_id: number; name: string; materials: typeof free }>();
      const loose: typeof free = [];
      for (const m of free) {
        const r = ruleOf(m.material);
        if (!r) {
          loose.push(m);
          continue;
        }
        const existing = condRule.get(r.name);
        if (existing) {
          const h = addTo.get(existing.id) || { condition_id: existing.id, name: existing.name, materials: [] };
          h.materials.push(m);
          addTo.set(existing.id, h);
        } else {
          const g = groups.get(r.name) || { name: r.name, days: r.days, materials: [] };
          g.materials.push(m);
          groups.set(r.name, g);
        }
      }
      // Leftovers sharing a first word (2 or more) become a group too.
      const byWord = new Map<string, typeof free>();
      for (const m of loose) {
        const w = firstWord(m.material);
        if (w) byWord.set(w, [...(byWord.get(w) || []), m]);
      }
      const ungrouped: typeof free = [];
      for (const m of loose) {
        const w = firstWord(m.material);
        const set = w ? byWord.get(w)! : null;
        if (set && set.length >= 2) {
          const name = w!.charAt(0).toUpperCase() + w!.slice(1);
          const g = groups.get(`w:${w}`) || { name, days: 3, materials: [] };
          g.materials.push(m);
          groups.set(`w:${w}`, g);
        } else ungrouped.push(m);
      }
      res.json({
        groups: Array.from(groups.values()).sort((a, b) => b.materials.length - a.materials.length),
        add_to_existing: Array.from(addTo.values()),
        ungrouped,
        free: free.length,
        total: all.length
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/delivery-material-conditions", ...gate, async (req: any, res: any) => {
    try {
      const p = parseBody(req.body);
      const problem = problemOf(p, true);
      if (problem) return res.status(400).json({ error: problem });
      const r: any = await queryDB(
        `INSERT INTO delivery_material_conditions (name, min_lead_days, applies_entry, applies_job_edit, apply_to_admins, enabled, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [p.name, p.days, p.applies_entry, p.applies_job_edit, p.apply_to_admins, p.enabled, req.user.id]
      );
      const cond = await loadOne(Number(r.insertId));
      if (!cond) return res.status(500).json({ error: "Could not save the condition." });
      await setItems(cond, p.materials);
      res.json({ id: cond.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Edit: everything sent replaces what was there; "materials" left out keeps
  // the materials (the on/off switch sends only "enabled").
  app.put("/api/delivery-material-conditions/:id", ...gate, async (req: any, res: any) => {
    try {
      const cond = await loadOne(Number(req.params.id));
      if (!cond) return res.status(404).json({ error: "Condition not found." });
      const b = req.body || {};
      if (Object.keys(b).length === 1 && b.enabled !== undefined) {
        await queryDB("UPDATE delivery_material_conditions SET enabled = ?, updated_by = ? WHERE id = ?", [b.enabled ? 1 : 0, req.user.id, cond.id]);
        return res.json({ success: true });
      }
      const p = parseBody(b);
      const problem = problemOf(p, Array.isArray(b.materials));
      if (problem) return res.status(400).json({ error: problem });
      await queryDB(
        `UPDATE delivery_material_conditions SET name = ?, min_lead_days = ?, applies_entry = ?, applies_job_edit = ?, apply_to_admins = ?, enabled = ?, updated_by = ? WHERE id = ?`,
        [p.name, p.days, p.applies_entry, p.applies_job_edit, p.apply_to_admins, p.enabled, req.user.id, cond.id]
      );
      if (Array.isArray(b.materials)) await setItems(cond, p.materials);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/delivery-material-conditions/:id", ...gate, async (req: any, res: any) => {
    try {
      const cond = await loadOne(Number(req.params.id));
      if (!cond) return res.status(404).json({ error: "Condition not found." });
      await queryDB("DELETE FROM delivery_material_condition_items WHERE condition_id = ?", [cond.id]);
      await queryDB("DELETE FROM delivery_material_conditions WHERE id = ?", [cond.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
