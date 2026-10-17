/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// PEPM Management -> Measurement Sheet: reads a structural drawing (DWG, or DXF)
// and works out the quantities a BOQ engineer would measure by hand.
//
//   readDrawing()   DWG / DXF  ->  RawDrawing: the lines, polylines, texts and
//                   leaders by layer, the drawing unit and per-layer counts.
//                   (@mlightcad/libredwg-web — LibreDWG built for WebAssembly,
//                   so the server needs nothing installed besides npm packages.)
//   analyse()       RawDrawing + settings -> Model: for each plan (a cluster of
//                   beam lines — a DWG often holds several floors), its beams,
//                   columns / walls and slab panels, all in inches.
//                   - A beam is drawn as two parallel lines one beam width apart;
//                     two such lines that overlap make one beam segment, as long
//                     as the overlap. Segments are named from the beam tags ("FB-3
//                     (10"x21")") through their leader lines: the tag goes to the
//                     segment the leader's tip touches, then along that beam's run
//                     (segments in line, with only a column or a crossing beam
//                     between them). Whatever no leader reaches stays untagged,
//                     for the person to name.
//                   - Columns are the closed rectangles on the column layers.
//                   - Slab panels are the closed areas between the beams and
//                     columns (found on a grid); a panel holding the text VOID /
//                     STAIR / LIFT is an opening, not slab.
//   buildSheet()    Model + settings + the person's changes -> the Measurement
//                   Sheet: sections, rows (nos x length x breadth x depth =
//                   quantity, with the unit) and totals.
//
// Nothing here guesses what the drawing does not say: no reinforcement (that is
// in the detailing sheets), no slab thickness (a setting, default 5"), no
// storey height (a setting). Every such assumption is printed on the sheet.

import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------
export type Pt = { x: number; y: number };
export interface RawLine { layer: string; a: Pt; b: Pt }
export interface RawPoly { layer: string; pts: Pt[]; closed: boolean }
export interface RawText { layer: string; text: string; at: Pt; height: number; rotation: number }
export interface RawLeader { layer: string; pts: Pt[] }
export interface RawDrawing {
  /** Name of one drawing unit in inches (1 = the drawing is in inches, 12 = feet, 1/25.4 = mm). */
  inchPerUnit: number;
  unitName: string;
  lines: RawLine[];
  polys: RawPoly[];
  texts: RawText[];
  leaders: RawLeader[];
  layers: { name: string; lines: number; polys: number; texts: number; leaders: number }[];
  notes: string[];
}

// INSUNITS -> inches per unit.
const UNITS: Record<number, [string, number]> = {
  1: ["inch", 1],
  2: ["foot", 12],
  4: ["mm", 1 / 25.4],
  5: ["cm", 10 / 25.4],
  6: ["m", 1000 / 25.4],
  10: ["yard", 36]
};

export const unitFromName = (n: string): [string, number] | null => {
  const k = String(n || "").toLowerCase();
  if (k === "in" || k === "inch" || k === "inches") return UNITS[1];
  if (k === "ft" || k === "foot" || k === "feet") return UNITS[2];
  if (k === "mm") return UNITS[4];
  if (k === "cm") return UNITS[5];
  if (k === "m" || k === "meter" || k === "metre") return UNITS[6];
  return null;
};

let libP: Promise<any> | null = null;
async function lib() {
  if (!libP) {
    libP = (async () => {
      let mod: any;
      try {
        mod = await import("@mlightcad/libredwg-web");
      } catch {
        throw Object.assign(new Error("The drawing reader is not installed on this server. Run `npm install` in the project folder, restart the server, and try again."), { statusCode: 500 });
      }
      const dir = process.env.MS_LIBREDWG_WASM || path.join(process.cwd(), "node_modules", "@mlightcad", "libredwg-web", "wasm") + path.sep;
      return { LibreDwg: mod.LibreDwg, Dwg_File_Type: mod.Dwg_File_Type, instance: await mod.LibreDwg.create(dir) };
    })();
    libP.catch(() => (libP = null));
  }
  return libP;
}

const num = (v: any, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "bigint" ? Number(v) : d);
const pt = (p: any): Pt => ({ x: num(p?.x), y: num(p?.y) });
// MTEXT / TEXT: drop formatting codes (\pxqc; \L \P {...;} %%C and the like).
export const cleanText = (s: any) =>
  String(s ?? "")
    .replace(/\\P/g, " ")
    .replace(/\\[pPfFHWTQCAL][^;\\]*;/g, "")
    .replace(/\\[LlOoKk]/g, "")
    .replace(/[{}]/g, "")
    .replace(/%%[cC]/g, "ø")
    .replace(/%%[dD]/g, "°")
    .replace(/\s+/g, " ")
    .trim();

export async function readDrawing(file: Buffer, kind: "dwg" | "dxf" = "dwg"): Promise<RawDrawing> {
  const { instance, Dwg_File_Type } = await lib();
  const ab = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const dwg = instance.dwg_read_data(ab, kind === "dxf" ? Dwg_File_Type.DXF : Dwg_File_Type.DWG);
  if (!dwg) throw new Error("The drawing could not be read. Save it again from AutoCAD (File → Save As → AutoCAD 2018 DWG, or DXF) and upload that.");
  const db: any = instance.convert(dwg);
  try {
    instance.dwg_free(dwg);
  } catch {
    // freed with the module
  }
  const insUnits = num(db?.header?.INSUNITS, 0);
  const notes: string[] = [];
  let unit = UNITS[insUnits];
  if (!unit) {
    unit = UNITS[1];
    notes.push(`The drawing does not say what unit it is in (INSUNITS ${insUnits}); inches are assumed. Change it in the settings if the sizes look wrong.`);
  }
  const raw: RawDrawing = { inchPerUnit: unit[1], unitName: unit[0], lines: [], polys: [], texts: [], leaders: [], layers: [], notes };
  const stats = new Map<string, { name: string; lines: number; polys: number; texts: number; leaders: number }>();
  const st = (l: string) => {
    if (!stats.has(l)) stats.set(l, { name: l, lines: 0, polys: 0, texts: 0, leaders: 0 });
    return stats.get(l)!;
  };
  let blocks = 0;
  for (const e of db?.entities || []) {
    const layer = String(e.layer ?? "0");
    switch (e.type) {
      case "LINE":
        raw.lines.push({ layer, a: pt(e.startPoint), b: pt(e.endPoint) });
        st(layer).lines++;
        break;
      case "LWPOLYLINE":
      case "POLYLINE": {
        const pts = (e.vertices || []).map(pt);
        if (pts.length >= 2) {
          // LWPOLYLINE: bit 512 (as LibreDWG gives it) or bit 1 means closed.
          raw.polys.push({ layer, pts, closed: (num(e.flag) & 513) !== 0 || (pts.length >= 4 && Math.hypot(pts[0].x - pts.at(-1)!.x, pts[0].y - pts.at(-1)!.y) < 0.01) });
          st(layer).polys++;
        }
        break;
      }
      case "TEXT":
      case "MTEXT": {
        const t = cleanText(e.text ?? e.contents);
        if (t) {
          raw.texts.push({ layer, text: t, at: pt(e.startPoint ?? e.insertionPoint), height: num(e.textHeight ?? e.height), rotation: num(e.rotation) });
          st(layer).texts++;
        }
        break;
      }
      case "LEADER": {
        const pts = (e.vertices || []).map(pt);
        if (pts.length >= 2) {
          raw.leaders.push({ layer, pts });
          st(layer).leaders++;
        }
        break;
      }
      case "INSERT":
        blocks++;
        break;
      default:
        break;
    }
  }
  if (blocks) notes.push(`${blocks} block insert${blocks === 1 ? "" : "s"} in the drawing were not opened — beams or columns drawn inside blocks are not measured.`);
  raw.layers = [...stats.values()].sort((a, b) => b.lines + b.polys - (a.lines + a.polys));
  return raw;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export interface MsSettings {
  /** Inches per drawing unit; null = as the drawing says. */
  inchPerUnit: number | null;
  /** Layers holding beam edge lines (null = found by name: contains "beam", not dim / sec / text). */
  beamLayers: string[] | null;
  columnLayers: string[] | null;
  /** Layers holding beam tags / leaders (null = every layer: a tag is recognised by its text). */
  tagLayers: string[] | null;
  /** Beam width used when a beam has no tag (inches). */
  defaultBeamWidthIn: number;
  /** Beam overall depth used when a beam has no tag (inches). */
  defaultBeamDepthIn: number;
  slabThicknessIn: number;
  /** Take the slab thickness off the beam depth (the slab is measured on its own). */
  deductSlabFromBeam: boolean;
  /** Storey height for columns and walls (feet). */
  storeyHeightFt: number;
  /** How many floors this plan repeats for (typical floors). */
  repeats: number;
}
export const DEFAULT_SETTINGS: MsSettings = {
  inchPerUnit: null,
  beamLayers: null,
  columnLayers: null,
  tagLayers: null,
  defaultBeamWidthIn: 10,
  defaultBeamDepthIn: 21,
  slabThicknessIn: 5,
  deductSlabFromBeam: true,
  storeyHeightFt: 10,
  repeats: 1
};
export function normaliseSettings(v: any): MsSettings {
  const s = { ...DEFAULT_SETTINGS };
  const n = (x: any, min: number, max: number, d: number) => (Number.isFinite(Number(x)) && Number(x) >= min && Number(x) <= max ? Number(x) : d);
  const list = (x: any) => (Array.isArray(x) ? x.map((y) => String(y).slice(0, 120)).slice(0, 200) : null);
  s.inchPerUnit = v?.inchPerUnit == null || v.inchPerUnit === "" ? null : n(v.inchPerUnit, 0.001, 100000, 1);
  s.beamLayers = list(v?.beamLayers);
  s.columnLayers = list(v?.columnLayers);
  s.tagLayers = list(v?.tagLayers);
  s.defaultBeamWidthIn = n(v?.defaultBeamWidthIn, 3, 60, DEFAULT_SETTINGS.defaultBeamWidthIn);
  s.defaultBeamDepthIn = n(v?.defaultBeamDepthIn, 6, 120, DEFAULT_SETTINGS.defaultBeamDepthIn);
  s.slabThicknessIn = n(v?.slabThicknessIn, 0, 24, DEFAULT_SETTINGS.slabThicknessIn);
  s.deductSlabFromBeam = v?.deductSlabFromBeam === undefined ? true : !!v.deductSlabFromBeam;
  s.storeyHeightFt = n(v?.storeyHeightFt, 1, 60, DEFAULT_SETTINGS.storeyHeightFt);
  s.repeats = Math.round(n(v?.repeats, 1, 200, 1));
  return s;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
export interface Beam {
  id: string;
  /** "H" runs along x, "V" along y. */
  dir: "H" | "V";
  /** Centre-line coordinate across the beam, and its extent along it (inches, drawing placement). */
  c: number;
  a: number;
  b: number;
  widthIn: number;
  length: number;
  tag: string | null;
  /** Where the tag came from. */
  tagFrom: "leader" | "run" | null;
}
export interface Column {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  d: number;
  kind: "column" | "wall";
}
export interface Panel {
  id: string;
  areaSqIn: number;
  cx: number;
  cy: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** "slab", "void", "stair", "lift" ... */
  kind: string;
  /** Text found in the panel, e.g. "beam bottom slab". */
  note: string | null;
  /** Outline for the preview (a few corner points of the panel's grid cells' bounding polygon). */
  cells: number;
}
export interface TagDef {
  tag: string;
  widthIn: number;
  depthIn: number;
}
export interface Plan {
  id: string;
  title: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
  beams: Beam[];
  columns: Column[];
  panels: Panel[];
  tags: TagDef[];
  voids: { label: string; at: Pt }[];
  warnings: string[];
}
export interface Model {
  unitName: string;
  inchPerUnit: number;
  plans: Plan[];
  notes: string[];
  layers: RawDrawing["layers"];
  usedBeamLayers: string[];
  usedColumnLayers: string[];
}

const DIM_WORDS = /(dim|sec|text|txt|reinf|rod|stirrup|hatch|grid|title|note)/i;
export const guessBeamLayers = (layers: RawDrawing["layers"]) =>
  layers.filter((l) => /beam/i.test(l.name) && !DIM_WORDS.test(l.name) && l.lines + l.polys >= 4).map((l) => l.name);
export const guessColumnLayers = (layers: RawDrawing["layers"]) =>
  layers.filter((l) => /(^|[^a-z])(col|column)/i.test(l.name) && !/(dim|text|txt|grid|hatch|tie|rod)/i.test(l.name) && l.polys >= 1).map((l) => l.name);

// "FB-3(10"x21")", "B1 (250x450)", "GB-2 ( 12" x 24" )" ...
const TAG_RE = /([A-Za-z]{1,4}[-\s]?\d+[A-Za-z]?)\s*\(\s*(\d+(?:\.\d+)?)\s*(?:"|''|mm|cm|in)?\s*[xX×*]\s*(\d+(?:\.\d+)?)\s*(?:"|''|mm|cm|in)?\s*\)/;
export function parseTag(text: string, inchPerUnit: number): TagDef | null {
  const m = TAG_RE.exec(text.replace(/[”“″]/g, '"'));
  if (!m) return null;
  let w = Number(m[2]);
  let d = Number(m[3]);
  const mm = /mm/i.test(text);
  const cm = /cm/i.test(text);
  const quote = /["']/.test(text);
  if (mm) { w /= 25.4; d /= 25.4; }
  else if (cm) { w /= 2.54; d /= 2.54; }
  else if (!quote && (w >= 100 || d >= 100)) { w /= 25.4; d /= 25.4; } // a bare 250x450 is millimetres
  void inchPerUnit;
  return { tag: m[1].toUpperCase().replace(/\s+/g, "-").replace(/--+/g, "-"), widthIn: +w.toFixed(2), depthIn: +d.toFixed(2) };
}

const near = (a: number, b: number, t: number) => Math.abs(a - b) <= t;

interface Edge { c: number; a: number; b: number }

// Join edges on the same line that touch or overlap into one: first group the
// edges by the line they lie on (within `eps`), then merge each group's
// intervals.
function mergeEdges(list: Edge[], eps: number): Edge[] {
  const sorted = [...list].sort((p, q) => p.c - q.c);
  const groups: Edge[][] = [];
  for (const e of sorted) {
    const g = groups.at(-1);
    if (g && e.c - g[0].c <= eps) g.push(e);
    else groups.push([e]);
  }
  const out: Edge[] = [];
  for (const g of groups) {
    const c = g.reduce((sum, e) => sum + e.c, 0) / g.length;
    const iv = g.sort((p, q) => p.a - q.a);
    let cur: Edge | null = null;
    for (const e of iv) {
      if (cur && e.a <= cur.b + eps) cur.b = Math.max(cur.b, e.b);
      else {
        if (cur) out.push(cur);
        cur = { c, a: e.a, b: e.b };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

function pairEdges(edges: Edge[], widths: number[], dir: "H" | "V"): { segs: Omit<Beam, "id" | "tag" | "tagFrom">[]; covered: number; total: number; unpaired: Edge[] } {
  const segs: Omit<Beam, "id" | "tag" | "tagFrom">[] = [];
  const used: { a: number; b: number }[][] = edges.map(() => []);
  const lo = Math.max(2, Math.min(...widths) - 1.2);
  const hi = Math.max(...widths) + 1.2;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const d = Math.abs(edges[i].c - edges[j].c);
      if (d < lo || d > hi) continue;
      const a = Math.max(edges[i].a, edges[j].a);
      const b = Math.min(edges[i].b, edges[j].b);
      if (b - a < 2) continue;
      segs.push({ dir, c: (edges[i].c + edges[j].c) / 2, a, b, widthIn: d, length: b - a });
      used[i].push({ a, b });
      used[j].push({ a, b });
    }
  }
  let covered = 0;
  let total = 0;
  const unpaired: Edge[] = [];
  edges.forEach((e, i) => {
    total += e.b - e.a;
    const iv = used[i].sort((p, q) => p.a - q.a);
    let c = 0;
    let end = -Infinity;
    for (const v of iv) {
      const s = Math.max(v.a, end);
      if (v.b > s) { c += v.b - s; end = v.b; }
    }
    covered += Math.min(c, e.b - e.a);
    if (e.b - e.a - c > 3) unpaired.push({ c: e.c, a: e.a, b: e.b });
  });
  return { segs, covered, total, unpaired };
}

const distPtSeg = (p: Pt, b: { dir: "H" | "V"; c: number; a: number; b: number }) => {
  if (b.dir === "H") return Math.hypot(p.x < b.a ? b.a - p.x : p.x > b.b ? p.x - b.b : 0, p.y - b.c);
  return Math.hypot(p.x - b.c, p.y < b.a ? b.a - p.y : p.y > b.b ? p.y - b.b : 0);
};

// Cluster by proximity (union-find on bounding boxes grown by `gap`).
function clusterBoxes(boxes: { x0: number; y0: number; x1: number; y1: number }[], gap: number): number[] {
  const parent = boxes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const order = boxes.map((_, i) => i).sort((p, q) => boxes[p].x0 - boxes[q].x0);
  for (let oi = 0; oi < order.length; oi++) {
    const i = order[oi];
    for (let oj = oi + 1; oj < order.length; oj++) {
      const j = order[oj];
      if (boxes[j].x0 > boxes[i].x1 + gap) break;
      if (boxes[j].y0 <= boxes[i].y1 + gap && boxes[j].y1 >= boxes[i].y0 - gap) parent[find(j)] = find(i);
    }
  }
  return boxes.map((_, i) => find(i));
}

const TITLE_RE = /(plan|layout|floor|roof|foundation|footing|beam|slab|column|stair)/i;

export function analyse(raw: RawDrawing, settingsIn: Partial<MsSettings> = {}): Model {
  const settings = normaliseSettings(settingsIn);
  const ipu = settings.inchPerUnit ?? raw.inchPerUnit;
  const k = ipu; // drawing units -> inches
  const notes = [...raw.notes];
  const beamLayers = settings.beamLayers && settings.beamLayers.length ? settings.beamLayers : guessBeamLayers(raw.layers);
  const columnLayers = settings.columnLayers && settings.columnLayers.length ? settings.columnLayers : guessColumnLayers(raw.layers);
  const model: Model = { unitName: raw.unitName, inchPerUnit: ipu, plans: [], notes, layers: raw.layers, usedBeamLayers: beamLayers, usedColumnLayers: columnLayers };
  if (!beamLayers.length) {
    notes.push("No beam layer was found by name. Pick the layer(s) that hold the beam lines in the settings.");
    return model;
  }
  const sc = (p: Pt): Pt => ({ x: p.x * k, y: p.y * k });

  // ---- beam edge lines (a polyline is split into its sides) ----
  const eps = 0.6;
  const H: Edge[] = [];
  const V: Edge[] = [];
  let diagonal = 0;
  const side = (p: Pt, q: Pt) => {
    const a = sc(p);
    const b = sc(q);
    if (Math.abs(a.y - b.y) < eps) H.push({ c: (a.y + b.y) / 2, a: Math.min(a.x, b.x), b: Math.max(a.x, b.x) });
    else if (Math.abs(a.x - b.x) < eps) V.push({ c: (a.x + b.x) / 2, a: Math.min(a.y, b.y), b: Math.max(a.y, b.y) });
    else diagonal++;
  };
  const isBeamLayer = new Set(beamLayers);
  for (const l of raw.lines) if (isBeamLayer.has(l.layer)) side(l.a, l.b);
  for (const pl of raw.polys) {
    if (!isBeamLayer.has(pl.layer)) continue;
    for (let i = 0; i + 1 < pl.pts.length; i++) side(pl.pts[i], pl.pts[i + 1]);
    if (pl.closed && pl.pts.length > 2) side(pl.pts.at(-1)!, pl.pts[0]);
  }
  if (diagonal) notes.push(`${diagonal} slanting beam line${diagonal === 1 ? "" : "s"} were skipped (only straight, along-the-grid beams are measured).`);

  // ---- tags: text like FB-3(10"x21") with its leader ----
  const tagTexts: { def: TagDef; at: Pt; text: string }[] = [];
  const tagLayerOk = (l: string) => !settings.tagLayers || !settings.tagLayers.length || settings.tagLayers.includes(l);
  for (const t of raw.texts) {
    if (!tagLayerOk(t.layer)) continue;
    const def = parseTag(t.text, ipu);
    if (def) tagTexts.push({ def, at: sc(t.at), text: t.text });
  }
  const widthSet = new Set<number>([settings.defaultBeamWidthIn, ...tagTexts.map((t) => Math.round(t.def.widthIn * 2) / 2)]);
  const widths = [...widthSet].filter((w) => w > 0);

  const mergedH = mergeEdges(H, eps);
  const mergedV = mergeEdges(V, eps);
  const ph = pairEdges(mergedH, widths, "H");
  const pv = pairEdges(mergedV, widths, "V");
  const allSegs = [...ph.segs, ...pv.segs];
  if (!allSegs.length) {
    notes.push("The beam layer has lines, but none of them pair up into beams (two parallel lines one beam width apart). Check the beam width in the settings.");
    return model;
  }
  const unpairedLen = [...ph.unpaired, ...pv.unpaired].reduce((s, e) => s + (e.b - e.a), 0);

  // ---- columns / walls ----
  const colLayerSet = new Set(columnLayers);
  const colsAll: Column[] = [];
  for (const pl of raw.polys) {
    if (!colLayerSet.has(pl.layer) || !pl.closed || pl.pts.length < 4 || pl.pts.length > 5) continue;
    const xs = pl.pts.map((p) => p.x * k);
    const ys = pl.pts.map((p) => p.y * k);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const w = x1 - x0, d = y1 - y0;
    if (Math.min(w, d) < 6 || Math.max(w, d) > 160 || w * d > 5000) continue;
    colsAll.push({ id: "", x0, y0, x1, y1, w, d, kind: Math.max(w, d) > 60 ? "wall" : "column" });
  }

  // ---- plans: clusters of beam segments ----
  const boxes = allSegs.map((s) => (s.dir === "H" ? { x0: s.a, x1: s.b, y0: s.c - s.widthIn / 2, y1: s.c + s.widthIn / 2 } : { x0: s.c - s.widthIn / 2, x1: s.c + s.widthIn / 2, y0: s.a, y1: s.b }));
  const cl = clusterBoxes(boxes, 300);
  const groups = new Map<number, number[]>();
  cl.forEach((g, i) => groups.set(g, [...(groups.get(g) || []), i]));
  const leaders = raw.leaders.map((l) => l.pts.map(sc));
  const titleCands = raw.texts.filter((t) => TITLE_RE.test(t.text) && t.text.length >= 8 && t.text.length <= 120 && /(plan|layout)/i.test(t.text));
  let planNo = 0;
  for (const [, idxs] of [...groups.entries()].sort((p, q) => Math.min(...p[1].map((i) => boxes[i].x0)) - Math.min(...q[1].map((i) => boxes[i].x0)))) {
    if (idxs.reduce((s, i) => s + allSegs[i].length, 0) < 120) continue; // a stray line or two
    planNo++;
    const bb = { x0: Math.min(...idxs.map((i) => boxes[i].x0)), y0: Math.min(...idxs.map((i) => boxes[i].y0)), x1: Math.max(...idxs.map((i) => boxes[i].x1)), y1: Math.max(...idxs.map((i) => boxes[i].y1)) };
    const warnings: string[] = [];
    const inBox = (p: Pt, m = 120) => p.x >= bb.x0 - m && p.x <= bb.x1 + m && p.y >= bb.y0 - m && p.y <= bb.y1 + m;
    // title: the closest "…PLAN / …LAYOUT" text around the plan
    let title = `Plan ${planNo}`;
    let best = Infinity;
    for (const t of titleCands) {
      const p = sc(t.at);
      const dx = p.x < bb.x0 ? bb.x0 - p.x : p.x > bb.x1 ? p.x - bb.x1 : 0;
      const dy = p.y < bb.y0 ? bb.y0 - p.y : p.y > bb.y1 ? p.y - bb.y1 : 0;
      const dist = Math.hypot(dx, dy);
      if (dist < best && dist < 600) { best = dist; title = t.text.replace(/\s+/g, " ").trim(); }
    }
    const beams: Beam[] = idxs
      .map((i) => allSegs[i])
      .sort((p, q) => (p.dir === q.dir ? (p.dir === "H" ? q.c - p.c || p.a - q.a : p.c - q.c || q.a - p.a) : p.dir === "H" ? -1 : 1))
      .map((s, n) => ({ ...s, id: `B${n + 1}`, tag: null, tagFrom: null }));
    const columns = colsAll
      .filter((c) => inBox({ x: (c.x0 + c.x1) / 2, y: (c.y0 + c.y1) / 2 }, 30))
      .sort((p, q) => q.y1 - p.y1 || p.x0 - q.x0)
      .map((c, n) => ({ ...c, id: `${c.kind === "wall" ? "W" : "C"}${n + 1}` }));

    // tags -> beams through leaders
    const tagsHere = tagTexts.filter((t) => inBox(t.at));
    const used = new Map<string, TagDef>();
    for (const t of tagsHere) {
      used.set(t.def.tag, t.def);
      // the leader that starts at the text; its far end is the arrow tip
      let tip: Pt | null = null;
      let bestD = 40;
      for (const l of leaders) {
        for (const [e, o] of [[l[0], l.at(-1)!], [l.at(-1)!, l[0]]] as [Pt, Pt][]) {
          const d = Math.hypot(e.x - t.at.x, e.y - t.at.y);
          if (d < bestD) { bestD = d; tip = o; }
        }
      }
      if (!tip) { warnings.push(`${t.def.tag}: no leader line found next to its text.`); continue; }
      let target: Beam | null = null;
      let td = 14;
      for (const b of beams) {
        const d = distPtSeg(tip, b) - b.widthIn / 2;
        if (d < td) { td = d; target = b; }
      }
      if (!target) { warnings.push(`${t.def.tag}: its leader does not touch a beam.`); continue; }
      if (target.tag && target.tagFrom === "leader" && target.tag !== t.def.tag) warnings.push(`${target.id} is pointed at by two tags (${target.tag} and ${t.def.tag}); ${t.def.tag} kept.`);
      target.tag = t.def.tag;
      target.tagFrom = "leader";
    }
    // along each beam's run: segments in line with only a column (or a crossing beam's width) between them
    const runKey = (b: Beam) => `${b.dir}:${Math.round(b.c / 2)}`;
    const byLine = new Map<string, Beam[]>();
    for (const b of beams) {
      const key = `${b.dir}:${Math.round(b.c / 3)}`;
      byLine.set(key, [...(byLine.get(key) || []), b]);
    }
    void runKey;
    for (const list of byLine.values()) {
      list.sort((p, q) => p.a - q.a);
      // runs: neighbours whose gap is at most 60" (a column or a crossing beam)
      const runs: Beam[][] = [];
      for (const b of list) {
        const last = runs.at(-1)?.at(-1);
        if (last && b.a - last.b <= 60) runs.at(-1)!.push(b);
        else runs.push([b]);
      }
      for (const run of runs) {
        const tagged = run.filter((b) => b.tag);
        if (!tagged.length) continue;
        run.forEach((b, i) => {
          if (b.tag) return;
          // nearest tagged segment along the run
          let bestJ = -1;
          for (let j = 0; j < run.length; j++) if (run[j].tag && (bestJ < 0 || Math.abs(j - i) < Math.abs(bestJ - i))) bestJ = j;
          if (bestJ >= 0 && new Set(tagged.map((t) => t.tag)).size === 1) { b.tag = run[bestJ].tag; b.tagFrom = "run"; }
        });
      }
    }

    // ---- slab panels (a grid; walls = beams + columns) ----
    // The walls are first grown by GROW cells (closing gaps up to 2 x GROW x cell
    // where two beam lines almost meet), the closed areas are found, and each is
    // then grown back over free cells so its area is the true clear area.
    const cell = 2;
    const GROW = 4;
    const gx0 = Math.floor(bb.x0 - 60);
    const gy0 = Math.floor(bb.y0 - 60);
    const gw = Math.ceil((bb.x1 - bb.x0 + 120) / cell);
    const gh = Math.ceil((bb.y1 - bb.y0 + 120) / cell);
    let panels: Panel[] = [];
    if (gw * gh <= 4_000_000) {
      const wall0 = new Uint8Array(gw * gh); // the real beams and columns
      const fill = (arr: Uint8Array, x0: number, y0: number, x1: number, y1: number) => {
        const i0 = Math.max(0, Math.floor((x0 - gx0) / cell));
        const i1 = Math.min(gw - 1, Math.ceil((x1 - gx0) / cell) - 1);
        const j0 = Math.max(0, Math.floor((y0 - gy0) / cell));
        const j1 = Math.min(gh - 1, Math.ceil((y1 - gy0) / cell) - 1);
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) arr[j * gw + i] = 1;
      };
      for (const bm of beams) bm.dir === "H" ? fill(wall0, bm.a, bm.c - bm.widthIn / 2, bm.b, bm.c + bm.widthIn / 2) : fill(wall0, bm.c - bm.widthIn / 2, bm.a, bm.c + bm.widthIn / 2, bm.b);
      for (const c of columns) fill(wall0, c.x0, c.y0, c.x1, c.y1);
      // grown walls
      const wall = new Uint8Array(wall0);
      {
        let cur = new Uint8Array(wall0);
        for (let r = 0; r < GROW; r++) {
          const nxt = new Uint8Array(cur);
          for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
            if (cur[j * gw + i]) continue;
            if ((i > 0 && cur[j * gw + i - 1]) || (i < gw - 1 && cur[j * gw + i + 1]) || (j > 0 && cur[(j - 1) * gw + i]) || (j < gh - 1 && cur[(j + 1) * gw + i])) nxt[j * gw + i] = 1;
          }
          cur = nxt;
        }
        wall.set(cur);
      }
      const marks = raw.texts
        .map((t) => ({ t, p: sc(t.at) }))
        .filter(({ t, p }) => inBox(p, 0) && /(void|stair|lift|shaft|opening)/i.test(t.text) && t.text.length < 24)
        .map(({ t, p }) => ({ label: t.text.replace(/[^A-Za-z ]/g, "").trim().toLowerCase(), p }));
      const notesIn = raw.texts.map((t) => ({ t, p: sc(t.at) })).filter(({ t, p }) => inBox(p, 0) && /beam bottom|sunk|drop|lowered/i.test(t.text));
      const seen = new Int32Array(gw * gh);
      const stack: number[] = [];
      const push = (i: number, j: number) => {
        if (i < 0 || j < 0 || i >= gw || j >= gh) return;
        const n = j * gw + i;
        if (wall[n] || seen[n]) return;
        seen[n] = -1;
        stack.push(n);
      };
      for (let i = 0; i < gw; i++) { push(i, 0); push(i, gh - 1); }
      for (let j = 0; j < gh; j++) { push(0, j); push(gw - 1, j); }
      while (stack.length) {
        const n = stack.pop()!;
        const i = n % gw, j = (n - i) / gw;
        push(i + 1, j); push(i - 1, j); push(i, j + 1); push(i, j - 1);
      }
      // label the closed areas
      let label = 0;
      for (let j0 = 0; j0 < gh; j0++) {
        for (let i0 = 0; i0 < gw; i0++) {
          const n0 = j0 * gw + i0;
          if (wall[n0] || seen[n0]) continue;
          label++;
          const st2 = [n0];
          seen[n0] = label;
          while (st2.length) {
            const n = st2.pop()!;
            const i = n % gw, j = (n - i) / gw;
            for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const ii = i + di, jj = j + dj;
              if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
              const nn = jj * gw + ii;
              if (wall[nn] || seen[nn]) continue;
              seen[nn] = label;
              st2.push(nn);
            }
          }
        }
      }
      // grow every area back over free (not real wall) cells
      const lab = new Int32Array(gw * gh);
      for (let n = 0; n < lab.length; n++) lab[n] = seen[n] > 0 ? seen[n] : 0;
      for (let r = 0; r < GROW + 1; r++) {
        const nxt = new Int32Array(lab);
        for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
          const n = j * gw + i;
          if (lab[n] || wall0[n]) continue;
          let v = 0;
          if (i > 0 && lab[n - 1] > 0) v = lab[n - 1];
          else if (i < gw - 1 && lab[n + 1] > 0) v = lab[n + 1];
          else if (j > 0 && lab[n - gw] > 0) v = lab[n - gw];
          else if (j < gh - 1 && lab[n + gw] > 0) v = lab[n + gw];
          if (v) nxt[n] = v;
        }
        lab.set(nxt);
      }
      const acc = new Map<number, { cnt: number; sx: number; sy: number; mnx: number; mxx: number; mny: number; mxy: number }>();
      for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
        const v = lab[j * gw + i];
        if (v <= 0) continue;
        const a2 = acc.get(v) || { cnt: 0, sx: 0, sy: 0, mnx: i, mxx: i, mny: j, mxy: j };
        a2.cnt++; a2.sx += i; a2.sy += j;
        if (i < a2.mnx) a2.mnx = i; if (i > a2.mxx) a2.mxx = i; if (j < a2.mny) a2.mny = j; if (j > a2.mxy) a2.mxy = j;
        acc.set(v, a2);
      }
      for (const [lb, a2] of acc) {
        const area = a2.cnt * cell * cell;
        if (area < 20 * 20) continue; // slivers between lines
        const bx0 = gx0 + a2.mnx * cell, bx1 = gx0 + (a2.mxx + 1) * cell, by0 = gy0 + a2.mny * cell, by1 = gy0 + (a2.mxy + 1) * cell;
        const cx = gx0 + (a2.sx / a2.cnt) * cell + cell / 2;
        const cy = gy0 + (a2.sy / a2.cnt) * cell + cell / 2;
        const insideLabel = (p: Pt) => {
          const ii = Math.floor((p.x - gx0) / cell), jj = Math.floor((p.y - gy0) / cell);
          return ii >= 0 && jj >= 0 && ii < gw && jj < gh && lab[jj * gw + ii] === lb;
        };
        const mark = marks.find((m) => insideLabel(m.p));
        const nt = notesIn.find(({ p }) => insideLabel(p));
        panels.push({ id: "", areaSqIn: area, cx, cy, x0: bx0, y0: by0, x1: bx1, y1: by1, kind: mark ? mark.label.split(" ")[0] || "void" : "slab", note: nt ? cleanText(nt.t.text) : null, cells: a2.cnt });
      }
      panels = panels.sort((p, q) => q.cy - p.cy || p.cx - q.cx);
      let sn = 0, vn = 0;
      panels = panels.map((pn) => ({ ...pn, id: pn.kind === "slab" ? `S${++sn}` : `V${++vn}` }));
    } else warnings.push("The plan is too large to find slab panels automatically.");

    const voids = raw.texts.map((t) => ({ t, p: sc(t.at) })).filter(({ t, p }) => inBox(p, 0) && /(void|stair|lift)/i.test(t.text) && t.text.length < 24).map(({ t, p }) => ({ label: cleanText(t.text), at: p }));
    if (unpairedLen > 600) warnings.push(`${Math.round(unpairedLen / 12)} ft of beam line on the beam layer did not pair into a beam (a single edge with no partner). Short ends are normal; if a whole beam is missing from the plan view, draw its second line or add it as an extra row.`);
    const untagged = beams.filter((b) => !b.tag).length;
    if (untagged) warnings.push(`${untagged} beam segment${untagged === 1 ? "" : "s"} have no tag; name them on the sheet (they are measured with the default ${settings.defaultBeamWidthIn}"x${settings.defaultBeamDepthIn}" meanwhile).`);
    model.plans.push({ id: `P${planNo}`, title, bbox: bb, beams, columns, panels, tags: [...used.values()].sort((p, q) => p.tag.localeCompare(q.tag, undefined, { numeric: true })), voids, warnings });
  }
  if (!model.plans.length) notes.push("No plan with enough beam length was found on the beam layers.");
  return model;
}

// ---------------------------------------------------------------------------
// The Measurement Sheet
// ---------------------------------------------------------------------------
export interface SheetRow {
  id: string;
  /** What it is: "FB-3 (10"x21")", "Column C4"... */
  desc: string;
  nos: number;
  /** Feet. */
  l: number | null;
  b: number | null;
  d: number | null;
  qty: number;
  unit: "cft" | "sft" | "rft" | "nos";
  remark?: string;
  /** "item" rows add up into the section total; "sub" rows are subtotals; "head" rows are headings. */
  kind: "item" | "sub" | "head";
  /** Which element this row came from (for editing). */
  ref?: string;
}
export interface SheetSection {
  key: string;
  title: string;
  rows: SheetRow[];
  totals: { label: string; qty: number; unit: string }[];
}
export interface Sheet {
  plan: { id: string; title: string };
  repeats: number;
  assumptions: string[];
  sections: SheetSection[];
}

/** The person's changes to what the drawing gave: beam tags, panel inclusion, extra rows. */
export interface Overrides {
  /** beam id -> tag (or "" to clear) */
  beamTags?: Record<string, string>;
  /** tag -> size */
  tagSizes?: Record<string, { widthIn: number; depthIn: number }>;
  /** beam ids to leave out */
  skipBeams?: string[];
  skipColumns?: string[];
  /** panel id -> { include, thicknessIn } */
  panels?: Record<string, { include?: boolean; thicknessIn?: number }>;
  /** column id -> storey height ft */
  columnHeights?: Record<string, number>;
  extra?: { section: "beam" | "column" | "slab" | "other"; desc: string; nos: number; l: number | null; b: number | null; d: number | null; unit: SheetRow["unit"] }[];
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const ftIn = (inches: number) => {
  const sign = inches < 0 ? "-" : "";
  const t = Math.round(Math.abs(inches) * 8) / 8;
  let ft = Math.floor(t / 12);
  let inch = t - ft * 12;
  if (inch >= 11.999) { ft++; inch = 0; }
  const whole = Math.floor(inch + 1e-9);
  const frac = Math.round((inch - whole) * 8);
  const fr = frac === 0 ? "" : ` ${frac / (frac % 4 === 0 ? 4 : frac % 2 === 0 ? 2 : 1)}/${8 / (frac % 4 === 0 ? 4 : frac % 2 === 0 ? 2 : 1)}`.replace(/^ /, "");
  return `${sign}${ft}'-${whole}${fr ? fr : ""}"`;
};
export const formatFtIn = ftIn;

export function buildSheet(plan: Plan, settingsIn: Partial<MsSettings>, ov: Overrides = {}): Sheet {
  const s = normaliseSettings(settingsIn);
  const assumptions: string[] = [];
  const sections: SheetSection[] = [];
  const sizeOf = (tag: string | null): { w: number; d: number; known: boolean } => {
    if (tag && ov.tagSizes?.[tag]) return { w: ov.tagSizes[tag].widthIn, d: ov.tagSizes[tag].depthIn, known: true };
    const t = tag ? plan.tags.find((x) => x.tag === tag) : null;
    return t ? { w: t.widthIn, d: t.depthIn, known: true } : { w: s.defaultBeamWidthIn, d: s.defaultBeamDepthIn, known: false };
  };
  const skip = new Set(ov.skipBeams || []);
  const beams = plan.beams.filter((b) => !skip.has(b.id)).map((b) => ({ ...b, tag: ov.beamTags && b.id in ov.beamTags ? ov.beamTags[b.id] || null : b.tag }));

  // ---- A. beams ----
  {
    const rows: SheetRow[] = [];
    const tags = [...new Set(beams.map((b) => b.tag ?? "(no tag)"))].sort((p, q) => p.localeCompare(q, undefined, { numeric: true }));
    let totC = 0, totS = 0, totL = 0;
    for (const tg of tags) {
      const list = beams.filter((b) => (b.tag ?? "(no tag)") === tg);
      const sz = sizeOf(tg === "(no tag)" ? null : tg);
      const dNet = s.deductSlabFromBeam ? Math.max(0, sz.d - s.slabThicknessIn) : sz.d;
      rows.push({ id: `h-${tg}`, desc: tg === "(no tag)" ? `Beams without a tag — taken as ${sz.w}"x${sz.d}"` : `${tg}  (${sz.w}"x${sz.d}")${s.deductSlabFromBeam ? `  — depth below slab ${r2(dNet)}"` : ""}`, nos: 0, l: null, b: null, d: null, qty: 0, unit: "cft", kind: "head" });
      let qc = 0, qs = 0, ql = 0;
      for (const b of list.sort((p, q) => p.id.localeCompare(q.id, undefined, { numeric: true }))) {
        const L = b.length / 12;
        const cft = L * (sz.w / 12) * (dNet / 12);
        rows.push({ id: b.id, ref: b.id, desc: `${b.id}  (${b.dir === "H" ? "along X" : "along Y"})`, nos: 1, l: r3(L), b: r3(sz.w / 12), d: r3(dNet / 12), qty: r3(cft), unit: "cft", kind: "item", remark: b.tagFrom === "run" ? "tag taken from the same beam" : b.tag ? undefined : "no tag" });
        qc += cft; qs += L * (sz.w / 12 + 2 * (dNet / 12)); ql += L;
      }
      rows.push({ id: `s-${tg}`, desc: `Total ${tg}`, nos: list.length, l: r3(ql), b: null, d: null, qty: r3(qc), unit: "cft", kind: "sub", remark: `Shuttering ${r2(qs)} sft` });
      totC += qc; totS += qs; totL += ql;
    }
    sections.push({
      key: "beam",
      title: "A. RCC floor beams",
      rows,
      totals: [
        { label: "Concrete", qty: r2(totC), unit: "cft" },
        { label: "Shuttering (bottom + 2 sides)", qty: r2(totS), unit: "sft" },
        { label: "Beam length", qty: r2(totL), unit: "rft" }
      ]
    });
    assumptions.push(`Beam length = the clear length between supporting faces, from the drawing (columns and crossing beams are not counted in it).`);
    assumptions.push(s.deductSlabFromBeam ? `Beam depth is the tag's depth less the ${s.slabThicknessIn}" slab (the slab is measured on its own); shuttering is the bottom and two sides of that depth.` : `Beam depth is the full tag depth; the slab is not deducted.`);
  }

  // ---- B. columns and walls ----
  {
    const rows: SheetRow[] = [];
    const skipC = new Set(ov.skipColumns || []);
    const cols = plan.columns.filter((c) => !skipC.has(c.id));
    const sizeKey = (c: Column) => `${c.kind}:${Math.round(Math.max(c.w, c.d))}x${Math.round(Math.min(c.w, c.d))}`;
    const groups = [...new Set(cols.map(sizeKey))].sort();
    let totC = 0, totS = 0;
    for (const g of groups) {
      const list = cols.filter((c) => sizeKey(c) === g);
      const [kind, sz] = g.split(":");
      const [a, bb] = sz.split("x").map(Number);
      rows.push({ id: `h-${g}`, desc: `${kind === "wall" ? "RCC wall" : "Column"} ${a}"x${bb}"`, nos: 0, l: null, b: null, d: null, qty: 0, unit: "cft", kind: "head" });
      let qc = 0, qs = 0;
      for (const c of list) {
        const H = (ov.columnHeights?.[c.id] ?? s.storeyHeightFt);
        const cft = (a / 12) * (bb / 12) * H;
        rows.push({ id: c.id, ref: c.id, desc: c.id, nos: 1, l: r3(a / 12), b: r3(bb / 12), d: r3(H), qty: r3(cft), unit: "cft", kind: "item" });
        qc += cft; qs += 2 * (a / 12 + bb / 12) * H;
      }
      rows.push({ id: `s-${g}`, desc: `Total ${kind} ${a}"x${bb}"`, nos: list.length, l: null, b: null, d: null, qty: r3(qc), unit: "cft", kind: "sub", remark: `Shuttering ${r2(qs)} sft` });
      totC += qc; totS += qs;
    }
    sections.push({ key: "column", title: "B. RCC columns and walls", rows, totals: [{ label: "Concrete", qty: r2(totC), unit: "cft" }, { label: "Shuttering (4 sides)", qty: r2(totS), unit: "sft" }, { label: "Columns / walls", qty: cols.length, unit: "nos" }] });
    assumptions.push(`Columns and walls are taken ${s.storeyHeightFt} ft high (storey height setting) — a column's real height depends on the levels, which the beam plan does not give.`);
  }

  // ---- C. slab ----
  {
    const rows: SheetRow[] = [];
    let totA = 0, totV = 0;
    const slabs = plan.panels.filter((p) => p.kind === "slab");
    for (const p of slabs) {
      const o = ov.panels?.[p.id] || {};
      if (o.include === false) continue;
      const t = o.thicknessIn ?? s.slabThicknessIn;
      const w = (p.x1 - p.x0) / 12, h = (p.y1 - p.y0) / 12;
      const area = p.areaSqIn / 144;
      const cft = area * (t / 12);
      rows.push({ id: p.id, ref: p.id, desc: `Slab panel ${p.id}${p.note ? ` (${p.note})` : ""}`, nos: 1, l: r3(w), b: r3(h), d: r3(t / 12), qty: r3(cft), unit: "cft", kind: "item", remark: `${r2(area)} sft clear area, ${t}" thick` });
      totA += area; totV += cft;
    }
    if (s.deductSlabFromBeam) {
      const beamArea = beams.reduce((sum, b) => sum + (b.length / 12) * (sizeOf(b.tag).w / 12), 0);
      const colArea = plan.columns.filter((c) => !(ov.skipColumns || []).includes(c.id)).reduce((sum, c) => sum + (c.w / 12) * (c.d / 12), 0);
      const cft = (beamArea + colArea) * (s.slabThicknessIn / 12);
      rows.push({ id: "slab-over", desc: "Slab over the beams and columns", nos: 1, l: null, b: null, d: r3(s.slabThicknessIn / 12), qty: r3(cft), unit: "cft", kind: "item", remark: `${r2(beamArea + colArea)} sft (beam top ${r2(beamArea)} + column top ${r2(colArea)}), because the beams above are measured below the slab` });
      totA += beamArea + colArea; totV += cft;
    }
    rows.push({ id: "s-slab", desc: "Total slab", nos: slabs.length, l: null, b: null, d: null, qty: r3(totV), unit: "cft", kind: "sub", remark: `${r2(totA)} sft` });
    const voidsN = plan.panels.filter((p) => p.kind !== "slab").length;
    sections.push({ key: "slab", title: "C. RCC slab", rows, totals: [{ label: "Concrete", qty: r2(totV), unit: "cft" }, { label: "Slab area (shuttering)", qty: r2(totA), unit: "sft" }, { label: "Openings left out (void / stair / lift)", qty: voidsN, unit: "nos" }] });
    assumptions.push(`Slab is ${s.slabThicknessIn}" thick (setting); panels are the closed areas between beams and columns, openings marked VOID / STAIR / LIFT are left out. Cantilever or open-edge slab is not found automatically — add it as an extra row.`);
  }

  // ---- extra rows ----
  const ex = ov.extra || [];
  if (ex.length) {
    const rows: SheetRow[] = ex.map((e, i) => {
      const vol = e.unit === "cft" ? e.nos * (e.l ?? 1) * (e.b ?? 1) * (e.d ?? 1) : e.unit === "sft" ? e.nos * (e.l ?? 1) * (e.b ?? 1) : e.unit === "rft" ? e.nos * (e.l ?? 1) : e.nos;
      return { id: `x${i + 1}`, desc: e.desc || "Extra item", nos: e.nos, l: e.l, b: e.b, d: e.d, qty: r3(vol), unit: e.unit, kind: "item" as const, remark: "added by hand" };
    });
    sections.push({ key: "other", title: "D. Added by hand", rows, totals: [] });
  }

  if (s.repeats > 1) assumptions.push(`This plan repeats for ${s.repeats} floors: multiply the totals by ${s.repeats}.`);
  assumptions.push("Reinforcement (rod) is not measured: it comes from the detailing sheets, not from the beam layout.");
  return { plan: { id: plan.id, title: plan.title }, repeats: s.repeats, assumptions, sections };
}

// ---------------------------------------------------------------------------
// Material Budget — what the measured quantities need in materials and money.
// Concrete cft -> cement / sand / stone chips through the mix ratio (dry volume
// = wet volume x dryFactor), rod from kg per cft of concrete (an estimate: the
// real figure comes from the detailing sheets), shuttering from its area.
// ---------------------------------------------------------------------------
export type BudgetPart = "beam" | "column" | "slab";
export interface BudgetConfig {
  /** Volume of one cement bag (cft). */
  cementBagCft: number;
  /** Dry volume of materials for 1 cft of wet concrete. */
  dryFactor: number;
  /** Extra on cement / sand / stone / shuttering for waste (%). */
  wastagePct: number;
  steelWastagePct: number;
  /** Mix ratio cement : sand : stone chips. */
  mix: Record<BudgetPart, [number, number, number]>;
  /** Rod, kg per cft of concrete. */
  steelKgPerCft: Record<BudgetPart, number>;
  /** Rates in Tk (0 = not set). */
  rates: { cement: number; sand: number; stone: number; steel: number; shuttering: number };
}
export const DEFAULT_BUDGET: BudgetConfig = {
  cementBagCft: 1.25,
  dryFactor: 1.54,
  wastagePct: 5,
  steelWastagePct: 3,
  mix: { beam: [1, 1.5, 3], column: [1, 1.5, 3], slab: [1, 1.5, 3] },
  steelKgPerCft: { beam: 4, column: 5, slab: 1.8 },
  rates: { cement: 0, sand: 0, stone: 0, steel: 0, shuttering: 0 }
};
export function normaliseBudget(v: any): BudgetConfig {
  const d = DEFAULT_BUDGET;
  const n = (x: any, min: number, max: number, def: number) => (x !== "" && x != null && Number.isFinite(Number(x)) && Number(x) >= min && Number(x) <= max ? Number(x) : def);
  const parts: BudgetPart[] = ["beam", "column", "slab"];
  const out: BudgetConfig = {
    cementBagCft: n(v?.cementBagCft, 0.5, 3, d.cementBagCft),
    dryFactor: n(v?.dryFactor, 1, 2, d.dryFactor),
    wastagePct: n(v?.wastagePct, 0, 50, d.wastagePct),
    steelWastagePct: n(v?.steelWastagePct, 0, 50, d.steelWastagePct),
    mix: { ...d.mix },
    steelKgPerCft: { ...d.steelKgPerCft },
    rates: { ...d.rates }
  };
  for (const p of parts) {
    const m = v?.mix?.[p];
    out.mix[p] = [n(m?.[0], 0.1, 20, d.mix[p][0]), n(m?.[1], 0, 20, d.mix[p][1]), n(m?.[2], 0, 20, d.mix[p][2])];
    out.steelKgPerCft[p] = n(v?.steelKgPerCft?.[p], 0, 50, d.steelKgPerCft[p]);
  }
  for (const k of Object.keys(d.rates) as (keyof BudgetConfig["rates"])[]) out.rates[k] = n(v?.rates?.[k], 0, 10000000, 0);
  return out;
}

export interface BudgetPartLine { key: BudgetPart; label: string; concrete: number; cement: number; sand: number; stone: number; steel: number; shuttering: number }
export interface BudgetLine { key: string; label: string; qty: number; unit: string; rate: number; amount: number }
export interface Budget {
  repeatsNote: string;
  parts: BudgetPartLine[];
  lines: BudgetLine[];
  total: number;
  rateMissing: boolean;
  notes: string[];
}

export function buildBudget(sheets: Sheet[], ovs: Record<string, Overrides>, cfgIn: any): Budget {
  const c = normaliseBudget(cfgIn);
  const base: Record<BudgetPart, { concrete: number; shuttering: number }> = { beam: { concrete: 0, shuttering: 0 }, column: { concrete: 0, shuttering: 0 }, slab: { concrete: 0, shuttering: 0 } };
  for (const sh of sheets) {
    const k = sh.repeats || 1;
    for (const sec of sh.sections) {
      if (sec.key !== "beam" && sec.key !== "column" && sec.key !== "slab") continue;
      for (const t of sec.totals) {
        if (t.label === "Concrete") base[sec.key].concrete += t.qty * k;
        else if (/shuttering/i.test(t.label)) base[sec.key].shuttering += t.qty * k;
      }
    }
    // Hand-added rows count under the element they were added for.
    for (const e of ovs[sh.plan.id]?.extra || []) {
      const p: BudgetPart | null = e.section === "beam" || e.section === "column" || e.section === "slab" ? e.section : null;
      if (!p) continue;
      if (e.unit === "cft") base[p].concrete += e.nos * (e.l ?? 1) * (e.b ?? 1) * (e.d ?? 1) * k;
      else if (e.unit === "sft") base[p].shuttering += e.nos * (e.l ?? 1) * (e.b ?? 1) * k;
    }
  }
  const labels: Record<BudgetPart, string> = { beam: "Beams", column: "Columns & walls", slab: "Slab" };
  const w = 1 + c.wastagePct / 100, ws = 1 + c.steelWastagePct / 100;
  const parts: BudgetPartLine[] = (["beam", "column", "slab"] as BudgetPart[]).map((p) => {
    const [a, b, s] = c.mix[p];
    const sum = a + b + s;
    const dry = base[p].concrete * c.dryFactor;
    return {
      key: p,
      label: labels[p],
      concrete: r2(base[p].concrete),
      cement: r2((dry * (a / sum) / c.cementBagCft) * w),
      sand: r2(dry * (b / sum) * w),
      stone: r2(dry * (s / sum) * w),
      steel: r2(base[p].concrete * c.steelKgPerCft[p] * ws),
      shuttering: r2(base[p].shuttering * w)
    };
  });
  const sum = (f: (p: BudgetPartLine) => number) => r2(parts.reduce((t, p) => t + f(p), 0));
  const mk = (key: string, label: string, qty: number, unit: string, rate: number): BudgetLine => ({ key, label, qty, unit, rate, amount: r2(qty * rate) });
  const lines = [
    mk("cement", "Cement", sum((p) => p.cement), "bag", c.rates.cement),
    mk("sand", "Sand", sum((p) => p.sand), "cft", c.rates.sand),
    mk("stone", "Stone chips / brick chips", sum((p) => p.stone), "cft", c.rates.stone),
    mk("steel", "Reinforcement rod", sum((p) => p.steel), "kg", c.rates.steel),
    mk("shuttering", "Shuttering (area)", sum((p) => p.shuttering), "sft", c.rates.shuttering)
  ];
  return {
    repeatsNote: sheets.some((s) => (s.repeats || 1) > 1) ? "Quantities are multiplied by the number of floors each plan repeats for." : "",
    parts,
    lines,
    total: r2(lines.reduce((t, l) => t + l.amount, 0)),
    rateMissing: lines.some((l) => l.rate === 0),
    notes: [
      `Cement, sand and stone from the mix ratio of each element (dry volume = ${c.dryFactor} x wet concrete, one cement bag = ${c.cementBagCft} cft), plus ${c.wastagePct}% waste.`,
      `Rod is an estimate from kg per cft of concrete (+${c.steelWastagePct}% waste) — the exact figure comes from the bar bending schedule.`,
      "Brick work, finishing, labour, formwork reuse and everything not on this drawing are not included."
    ]
  };
}
