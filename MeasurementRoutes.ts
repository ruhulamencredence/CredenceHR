/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// PEPM Management -> Measurement Sheet. Upload a building design (DWG / DXF),
// get the BOQ measurement sheet (MeasurementEngine.ts); fix what the drawing
// could not say (beam names, slab thickness...) and the sheet follows.
//
//   measurement_sheets  one row per uploaded drawing: the drawing as read
//                       (gzip JSON — the original file is not kept, so a
//                       re-analysis never needs the DWG reader), the settings
//                       and the person's changes. Company-owned (companyScope
//                       OWN_TABLES).
//
// Access: Admin Panel module "measurement_sheet" — layer "read" opens and
// exports sheets, "edit_add" uploads a drawing and changes a sheet,
// "delete_trash" removes one (edit_add / delete_trash are explicit-only).

import type { Express } from "express";
import zlib from "zlib";
import { analyse, buildBudget, normaliseBudget, buildSheet, normaliseSettings, readDrawing, guessBeamLayers, guessColumnLayers, type Overrides, type RawDrawing } from "./MeasurementEngine";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export interface RegisterMeasurementRoutesDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireModuleLayer: any;
  hasModuleLayer: (user: any, moduleKey: any, layer: string) => Promise<boolean>;
  queryDB: QueryDB;
}

export async function ensureMeasurementSchema(dbPool: any): Promise<void> {
  try {
    await dbPool.query(
      `CREATE TABLE IF NOT EXISTS measurement_sheets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        company_id INT NOT NULL DEFAULT 1,
        title VARCHAR(200) NOT NULL,
        file_name VARCHAR(255) NULL,
        raw_gz LONGBLOB NOT NULL,
        settings_json MEDIUMTEXT NULL,
        budget_json MEDIUMTEXT NULL,
        overrides_json MEDIUMTEXT NULL,
        created_by INT NULL,
        updated_by INT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_measurement_sheets_company (company_id)
      )`
    );
  } catch (err: any) {
    console.warn(`⚠️ Measurement Sheet (schema): ${err.message}`);
  }
  try {
    await dbPool.query("ALTER TABLE measurement_sheets ADD COLUMN budget_json MEDIUMTEXT NULL");
  } catch (err: any) {
    if (err.code !== "ER_DUP_FIELDNAME") console.warn(`⚠️ Measurement Sheet (budget column): ${err.message}`);
  }
}

const MAX_FILE = 15 * 1024 * 1024;
const unpack = (buf: Buffer): RawDrawing => JSON.parse(zlib.gunzipSync(buf).toString("utf8"));
const parseJson = (s: any, d: any) => {
  try {
    return s ? JSON.parse(String(s)) : d;
  } catch {
    return d;
  }
};

// Keep only the shape Overrides understands, with sane sizes.
function cleanOverrides(v: any): Record<string, Overrides> {
  const out: Record<string, Overrides> = {};
  if (!v || typeof v !== "object") return out;
  const num = (x: any) => (Number.isFinite(Number(x)) ? Number(x) : null);
  for (const planId of Object.keys(v).slice(0, 50)) {
    const o = v[planId] || {};
    const c: Overrides = {};
    if (o.beamTags && typeof o.beamTags === "object") {
      c.beamTags = {};
      for (const [k, t] of Object.entries(o.beamTags).slice(0, 5000)) c.beamTags[String(k).slice(0, 20)] = String(t ?? "").slice(0, 60);
    }
    if (o.tagSizes && typeof o.tagSizes === "object") {
      c.tagSizes = {};
      for (const [k, t] of Object.entries<any>(o.tagSizes).slice(0, 500)) {
        const w = num(t?.widthIn), d = num(t?.depthIn);
        if (w && d && w > 0 && d > 0 && w < 200 && d < 300) c.tagSizes[String(k).slice(0, 60)] = { widthIn: w, depthIn: d };
      }
    }
    if (Array.isArray(o.skipBeams)) c.skipBeams = o.skipBeams.slice(0, 5000).map((x: any) => String(x).slice(0, 20));
    if (Array.isArray(o.skipColumns)) c.skipColumns = o.skipColumns.slice(0, 5000).map((x: any) => String(x).slice(0, 20));
    if (o.panels && typeof o.panels === "object") {
      c.panels = {};
      for (const [k, p] of Object.entries<any>(o.panels).slice(0, 5000)) {
        const e: { include?: boolean; thicknessIn?: number } = {};
        if (p?.include !== undefined) e.include = !!p.include;
        const t = num(p?.thicknessIn);
        if (t !== null && t >= 0 && t <= 48) e.thicknessIn = t;
        c.panels[String(k).slice(0, 20)] = e;
      }
    }
    if (o.columnHeights && typeof o.columnHeights === "object") {
      c.columnHeights = {};
      for (const [k, h] of Object.entries<any>(o.columnHeights).slice(0, 5000)) {
        const n = num(h);
        if (n && n > 0 && n < 200) c.columnHeights[String(k).slice(0, 20)] = n;
      }
    }
    if (Array.isArray(o.extra)) {
      c.extra = o.extra.slice(0, 200).map((e: any) => ({
        section: (["beam", "column", "slab", "other"].includes(e?.section) ? e.section : "other") as any,
        desc: String(e?.desc ?? "").slice(0, 200),
        nos: num(e?.nos) ?? 1,
        l: num(e?.l),
        b: num(e?.b),
        d: num(e?.d),
        unit: (["cft", "sft", "rft", "nos"].includes(e?.unit) ? e.unit : "cft") as any
      }));
    }
    out[String(planId).slice(0, 20)] = c;
  }
  return out;
}

function render(row: any, canEdit: boolean, canDelete: boolean, canBudget = false) {
  const raw = unpack(row.raw_gz);
  const settings = normaliseSettings(parseJson(row.settings_json, {}));
  const overrides = cleanOverrides(parseJson(row.overrides_json, {}));
  const model = analyse(raw, settings);
  const sheets = model.plans.map((p) => buildSheet(p, settings, overrides[p.id] || {}));
  return {
    id: row.id,
    title: row.title,
    file_name: row.file_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    settings,
    overrides,
    model,
    sheets,
    all_layers: raw.layers,
    guessed: { beam: guessBeamLayers(raw.layers), column: guessColumnLayers(raw.layers) },
    can_edit: canEdit,
    can_delete: canDelete,
    can_budget: canBudget,
    // The Material Budget (rates included) is only sent to accounts with its own layer.
    ...(canBudget ? { budget_config: normaliseBudget(parseJson(row.budget_json, {})), budget: buildBudget(sheets, overrides, parseJson(row.budget_json, {})) } : {})
  };
}

export function registerMeasurementRoutes(app: Express, deps: RegisterMeasurementRoutesDeps) {
  const { authenticateToken, requireAdmin, requireModuleLayer, hasModuleLayer, queryDB } = deps;
  const canRead = [authenticateToken, requireAdmin, requireModuleLayer("measurement_sheet", "read")];
  const canEdit = [authenticateToken, requireAdmin, requireModuleLayer("measurement_sheet", "edit_add")];
  const canDelete = [authenticateToken, requireAdmin, requireModuleLayer("measurement_sheet", "delete_trash")];
  const fail = (res: any, err: any) => res.status(err?.statusCode || 500).json({ error: err?.message || String(err) });
  const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
  const flags = async (user: any) => ({
    edit: await hasModuleLayer(user, "measurement_sheet", "edit_add"),
    del: await hasModuleLayer(user, "measurement_sheet", "delete_trash"),
    budget: await hasModuleLayer(user, "measurement_sheet", "material_budget")
  });
  const load = async (id: any) => {
    const rows: any[] = (await queryDB("SELECT * FROM measurement_sheets WHERE id = ?", [Number(id)])) || [];
    if (!rows.length) throw bad("Measurement sheet not found.", 404);
    return rows[0];
  };

  app.get("/api/measurement-sheets", ...canRead, async (req: any, res) => {
    try {
      const rows: any[] =
        (await queryDB(
          `SELECT m.id, m.title, m.file_name, m.created_at, m.updated_at, u.name AS created_by_name
             FROM measurement_sheets m LEFT JOIN users u ON u.id = m.created_by ORDER BY m.id DESC`
        )) || [];
      const f = await flags(req.user);
      res.json({ items: rows, can_edit: f.edit, can_delete: f.del });
    } catch (err) {
      fail(res, err);
    }
  });

  app.post("/api/measurement-sheets", ...canEdit, async (req: any, res) => {
    try {
      const { title, file_name, data_base64 } = req.body || {};
      const name = String(file_name || "").slice(0, 255);
      const kind = /\.dxf$/i.test(name) ? "dxf" : /\.dwg$/i.test(name) ? "dwg" : null;
      if (!kind) throw bad("Choose a .dwg or .dxf file.");
      if (!data_base64 || typeof data_base64 !== "string") throw bad("The file is empty.");
      const buf = Buffer.from(data_base64, "base64");
      if (!buf.length) throw bad("The file is empty.");
      if (buf.length > MAX_FILE) throw bad("The file is larger than 15 MB.", 413);
      let raw: RawDrawing;
      try {
        raw = await readDrawing(buf, kind);
      } catch (e: any) {
        if (e?.statusCode === 500) throw e;
        throw bad(`Could not read this drawing: ${e?.message || e}. Save it again as DXF (or an older DWG version) and retry.`, 422);
      }
      if (!raw.lines.length && !raw.polys.length) throw bad("The drawing has no lines on its model space.", 422);
      const settings = normaliseSettings({});
      const model = analyse(raw, settings);
      if (!model.plans.length) throw bad("No beam plan was found in this drawing. Beam edges must be on a layer with \"beam\" in its name.", 422);
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(raw)));
      const r: any = await queryDB(
        "INSERT INTO measurement_sheets (title, file_name, raw_gz, settings_json, overrides_json, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [String(title || name.replace(/\.[^.]+$/, "") || "Measurement sheet").slice(0, 200), name, gz, JSON.stringify(settings), "{}", req.user.id, req.user.id]
      );
      res.json(render(await load(r.insertId), true, await hasModuleLayer(req.user, "measurement_sheet", "delete_trash"), await hasModuleLayer(req.user, "measurement_sheet", "material_budget")));
    } catch (err) {
      fail(res, err);
    }
  });

  app.get("/api/measurement-sheets/:id", ...canRead, async (req: any, res) => {
    try {
      const f = await flags(req.user);
      res.json(render(await load(req.params.id), f.edit, f.del, f.budget));
    } catch (err) {
      fail(res, err);
    }
  });

  app.put("/api/measurement-sheets/:id", ...canEdit, async (req: any, res) => {
    try {
      const row = await load(req.params.id);
      const b = req.body || {};
      const title = b.title !== undefined ? String(b.title).trim().slice(0, 200) : row.title;
      if (!title) throw bad("Give the sheet a title.");
      const settings = b.settings !== undefined ? normaliseSettings(b.settings) : normaliseSettings(parseJson(row.settings_json, {}));
      const overrides = b.overrides !== undefined ? cleanOverrides(b.overrides) : cleanOverrides(parseJson(row.overrides_json, {}));
      const f = await flags(req.user);
      if (b.budget !== undefined && !f.budget) throw bad("You don't have permission to change the Material Budget. Ask your Superadmin to grant it.", 403);
      const budgetJson = b.budget !== undefined ? JSON.stringify(normaliseBudget(b.budget)) : row.budget_json;
      await queryDB("UPDATE measurement_sheets SET title = ?, settings_json = ?, overrides_json = ?, budget_json = ?, updated_by = ? WHERE id = ?", [
        title,
        JSON.stringify(settings),
        JSON.stringify(overrides),
        budgetJson,
        req.user.id,
        row.id
      ]);
      res.json(render(await load(row.id), f.edit, f.del, f.budget));
    } catch (err) {
      fail(res, err);
    }
  });

  app.delete("/api/measurement-sheets/:id", ...canDelete, async (req: any, res) => {
    try {
      const row = await load(req.params.id);
      await queryDB("DELETE FROM measurement_sheets WHERE id = ?", [row.id]);
      res.json({ ok: true });
    } catch (err) {
      fail(res, err);
    }
  });
}
