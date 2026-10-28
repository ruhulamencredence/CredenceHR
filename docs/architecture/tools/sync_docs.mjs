#!/usr/bin/env node
// docs/architecture কে কোডের সাথে মিলিয়ে রাখে।
//   npm run docs:sync   -> যা কোড থেকে তৈরি হয় তা নতুন করে বানায় + HTML
//   npm run docs:check  -> কিছু না লিখে শুধু দেখায় কী পুরনো হয়ে গেছে (CI-তে চলে)
//   npm run docs:db     -> চালু ডাটাবেস (DB_* env) থেকে ডাটাবেস ডকুমেন্ট, সব ছবি ও draw.io, তারপর docs:sync
// স্বয়ংক্রিয়: Access Matrix (src/types.ts), SBOM (package-lock.json), সব HTML।
// হাতে লিখতে হয় (এই স্ক্রিপ্ট শুধু ধরিয়ে দেয়): নতুন টেবিল -> data-dictionary.md,
// নতুন লাইব্রেরি -> 03-technology-and-libraries.md, নতুন workflow/নিরাপত্তা বদল।
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const DOCS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(DOCS, "../..");
const CHECK = process.argv.includes("--check");
const DB = process.argv.includes("--db");
const problems = [];
const changed = [];

function put(rel, text) {
  const file = path.join(DOCS, rel);
  const old = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  if (old === text) return;
  if (CHECK) problems.push(`${rel} পুরনো — \`npm run docs:sync\` চালান`);
  else { fs.writeFileSync(file, text); changed.push(rel); }
}

// 0. ডাটাবেস (শুধু --db): information_schema -> README/ডিকশনারি/ডায়াগ্রাম/draw.io
if (DB) {
  const T = path.join(DOCS, "tools/db");
  const WORK = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || "/tmp", "docs-db-"));
  // playwright ও graphviz: NODE_PATH-এ থাকলে সেখান থেকে, না থাকলে অস্থায়ী ফোল্ডারে ইনস্টল
  const find = (name) => { try { return createRequire(import.meta.url).resolve(name, { paths: [...(process.env.NODE_PATH || "").split(path.delimiter).filter(Boolean), path.join(WORK, "node_modules")] }); } catch { return null; } };
  const need = [["playwright", "playwright"], ["@hpcc-js/wasm-graphviz", "@hpcc-js/wasm-graphviz@1.30.0"]].filter(([n]) => !find(n)).map(([, v]) => v);
  if (need.length) execFileSync("npm", ["install", "--no-save", "--no-package-lock", "--prefix", WORK, ...need], { stdio: "inherit" });
  const gv = pathToFileURL(find("@hpcc-js/wasm-graphviz")).href, pw = pathToFileURL(find("playwright")).href;
  const env = { ...process.env, DOCS_DB_OUT: path.join(DOCS, "database"), GV_INDEX: gv, PLAYWRIGHT: pw, MERMAID_JS: path.join(DOCS, "assets/mermaid.min.js"), FULL_TPL: path.join(T, "full-diagram.template.html"), DB_NOTES: path.join(T, "module-notes.json"), NODE_PATH: path.join(REPO, "node_modules"), PYTHONHASHSEED: "0" };
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: WORK, env, stdio: "inherit" });
  run("node", [path.join(T, "dump_schema.mjs")]);
  run("python3", [path.join(T, "model.py"), path.join(T, "groups.json")]);
  for (const f of fs.readdirSync(path.join(DOCS, "database/diagrams"))) if (/\.(mmd|svg|png)$/.test(f) && !f.startsWith("full-application-er")) fs.unlinkSync(path.join(DOCS, "database/diagrams", f));
  run("python3", [path.join(T, "gen_db.py")]);
  run("node", [path.join(T, "render_mermaid.mjs")]);
  run("python3", [path.join(T, "gen_full.py")]);
  run("node", [path.join(T, "layout_full.mjs")]);
  run("node", [path.join(T, "export_full.mjs")]);
  run("python3", [path.join(T, "drawio_build.py")]);
  run("node", [path.join(T, "drawio_layout.mjs")]);
  run("python3", [path.join(T, "drawio_emit.py")]);
  run("python3", [path.join(T, "update_readme.py")]);
  fs.rmSync(WORK, { recursive: true, force: true });
  // PNG/PDF প্রতিবার কয়েক বাইট আলাদা হয়; সোর্স SVG না বদলালে পুরনোটাই রাখি (অকারণ কমিট নয়)
  try {
    const dir = path.join(DOCS, "database/diagrams");
    const git = (...a) => execFileSync("git", a, { cwd: REPO, encoding: "utf8" });
    const dirty = new Set(git("diff", "--name-only", "--", dir).split("\n").filter(Boolean).map(f => path.join(REPO, f)));
    for (const f of dirty) if (/\.(png|pdf)$/.test(f) && !dirty.has(f.replace(/\.(png|pdf)$/, ".svg"))) git("checkout", "--", f);
  } catch {}
  changed.push("database/*");
}

// 1. Access Control Matrix <- src/types.ts
{
  const rel = "security/access-control-matrix.md";
  const cur = fs.readFileSync(path.join(DOCS, rel), "utf8");
  const head = cur.split("\n").filter((l, i) => i < cur.split("\n").findIndex(x => x.startsWith("|"))).join("\n");
  const table = execFileSync(path.join(REPO, "node_modules/.bin/tsx"), [path.join(DOCS, "tools/access_matrix.mts")], { cwd: path.join(DOCS, "tools"), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  put(rel, head.replace(/\n*$/, "\n\n") + table.trim() + "\n");
}

// 2. SBOM <- package-lock.json (+ node_modules থেকে homepage, থাকলে)
{
  const lock = JSON.parse(fs.readFileSync(path.join(REPO, "package-lock.json"), "utf8"));
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
  const direct = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
  const seen = new Map();
  for (const [p, v] of Object.entries(lock.packages || {})) {
    if (!p || !v.version) continue;
    const name = v.name || p.replace(/^.*node_modules\//, "");
    const key = `${name}@${v.version}`;
    if (seen.has(key)) continue;
    let home = "";
    try { home = JSON.parse(fs.readFileSync(path.join(REPO, p, "package.json"), "utf8")).homepage || ""; } catch {}
    seen.set(key, [name, v.version, v.license || "", direct.has(name) ? "yes" : "no", v.dev ? "yes" : "", home]);
  }
  const q = s => (/[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : s);
  const rows = [...seen.values()].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
  // homepage আসে node_modules থেকে; না থাকলে (CI/চেক) আগের ফাইলের মান রাখি
  const prev = new Map();
  try { for (const l of fs.readFileSync(path.join(DOCS, "dependency-sbom.csv"), "utf8").split("\n").slice(1)) { const c = l.split(","); if (c[0]) prev.set(c[0] + "@" + c[1], c[c.length - 1]); } } catch {}
  for (const r of rows) if (!r[5]) r[5] = prev.get(r[0] + "@" + r[1]) || "";
  put("dependency-sbom.csv", ["package,version,license,direct_dependency,dev_only,homepage", ...rows.map(r => r.map(q).join(","))].join("\n") + "\n");

  // 3. নতুন লাইব্রেরি 03-এ লেখা আছে কিনা
  const libDoc = fs.readFileSync(path.join(DOCS, "03-technology-and-libraries.md"), "utf8");
  for (const d of [...direct].sort()) if (!d.startsWith("@types/") && !libDoc.includes("`" + d + "`")) problems.push(`লাইব্রেরি \`${d}\` 03-technology-and-libraries.md-তে নেই`);
  for (const m of libDoc.matchAll(/^\| `([^`]+)` \| [\d.]+/gm)) if (!direct.has(m[1])) problems.push(`\`${m[1]}\` package.json থেকে সরানো হয়েছে, কিন্তু 03-technology-and-libraries.md-তে আছে`);
}

// 4. নতুন টেবিল data-dictionary.md-তে আছে কিনা
{
  const tables = new Set();
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", "dist", "docs", "android", "ios", ".git"].includes(e.name)) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.ts$/.test(e.name)) for (const m of fs.readFileSync(f, "utf8").matchAll(/CREATE TABLE IF NOT EXISTS `?([a-z0-9_]+)`?\s*\(/gi)) tables.add(m[1].toLowerCase());
    }
  };
  walk(REPO);
  const dict = fs.readFileSync(path.join(DOCS, "database/data-dictionary.md"), "utf8");
  const documented = new Set([...dict.matchAll(/^### `([a-z0-9_]+)`/gm)].map(m => m[1]));
  for (const t of [...tables].sort()) if (!documented.has(t)) problems.push(`টেবিল \`${t}\` data-dictionary.md ও ডায়াগ্রামে নেই`);
}

// 5. HTML (সব পেজ + এক-ফাইলের ডকুমেন্টেশন)
if (!CHECK) {
  for (const s of ["build_html.py", "build_bundle.py"]) execFileSync("python3", [path.join(DOCS, "tools", s)], { stdio: "inherit" });
  changed.push("*.html");
}

for (const c of changed) console.log("✔ আপডেট:", c);
if (problems.length) {
  console.log("\nডকুমেন্টেশনে হাতে যা ঠিক করতে হবে:");
  for (const p of problems) console.log("  •", p);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "### Documentation\n" + problems.map(p => "- " + p).join("\n") + "\n");
  if (process.env.GITHUB_ACTIONS) for (const p of problems) console.log("::warning title=Docs::" + p.replace(/`/g, ""));
} else console.log("ডকুমেন্টেশন কোডের সাথে মিলছে ✔");
if (CHECK && process.argv.includes("--strict") && problems.length) process.exit(1);
