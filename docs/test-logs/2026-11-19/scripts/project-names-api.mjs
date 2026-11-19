// Budget rows name their project in text: (1) renaming a Project renames it in
// Budget rows; (2) a Budget import with names not in Projects stops, lists them
// with look-alikes, and runs with the Admin's choice (project_map).
import { execSync } from 'node:child_process';
const B = process.env.BASE || 'http://localhost:3200';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
let fails = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const call = async (method, path, tok, body) => { const r = await fetch(B + path, { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { code: r.status, body: j }; };
const admin = (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@credence.test', password: 'ProbePass123' }) })).json()).token;
const tag = Date.now().toString(36);
const P = `QA Riverside ${tag}`;
sql(`INSERT INTO projects (project_name) VALUES ('${P}')`);
const pid = Number(sql(`SELECT id FROM projects WHERE project_name='${P}'`));
const b = await call('POST', '/api/budgets', admin, { budget_name: `QA Names ${tag}` });
const budgetId = b.body.id || Number(sql(`SELECT id FROM budgets WHERE budget_name='QA Names ${tag}'`));
ok(budgetId > 0, 'a budget to import into');
const rows = [
  { sl_no: '1', project_name: `qa riverside ${tag}`, mrf_no: `QAN-${tag}-1`, description: 'Cement', unit: 'bag', req_qty: '10' },
  { sl_no: '2', project_name: `QA Riversid ${tag}`, mrf_no: `QAN-${tag}-2`, description: 'Sand', unit: 'cft', req_qty: '20' },
  { sl_no: '3', project_name: `QA Riversid ${tag}`, mrf_no: `QAN-${tag}-3`, description: 'Rod', unit: 'ton', req_qty: '1' },
  { sl_no: '4', project_name: `QA Brand New Site ${tag}`, mrf_no: `QAN-${tag}-4`, description: 'Brick', unit: 'pcs', req_qty: '100' }
];
const before = Number(sql('SELECT COUNT(*) FROM projects'));
let r = await call('POST', `/api/budgets/${budgetId}/import`, admin, { rows });
ok(r.code === 409 && Array.isArray(r.body.needs_project_match), 'unknown names stop the import (409)');
const m = r.body.needs_project_match || [];
const typo = m.find((x) => x.name === `QA Riversid ${tag}`);
ok(typo && typo.rows === 2 && typo.suggestions.some((s) => s.id === pid), 'the typo is listed with its 2 rows and the look-alike project suggested');
ok(m.some((x) => x.name === `QA Brand New Site ${tag}`), 'the really new name is listed too');
ok(!m.some((x) => x.name === `qa riverside ${tag}`), 'a name that differs only in letter case is not asked about');
ok(sql(`SELECT COUNT(*) FROM budget_items WHERE budget_id=${budgetId}`) === '0' && Number(sql('SELECT COUNT(*) FROM projects')) === before, 'nothing saved, no project made');
r = await call('POST', `/api/budgets/${budgetId}/import`, admin, { rows, project_map: { [`QA Riversid ${tag}`]: pid, [`QA Brand New Site ${tag}`]: 'new' } });
ok(r.code === 200 && r.body.items_inserted === 4, 'imports with the choices (' + r.code + ')');
ok(sql(`SELECT COUNT(*) FROM budget_items WHERE budget_id=${budgetId} AND BINARY project_name='${P}'`) === '3', 'the typo rows (and the lower-case one) are saved with the project\'s own spelling');
ok(sql(`SELECT COUNT(*) FROM projects WHERE project_name LIKE 'QA Riversid ${tag}'`) === '0', 'no duplicate project for the typo');
ok(sql(`SELECT COUNT(*) FROM projects WHERE project_name='QA Brand New Site ${tag}'`) === '1', '"new" adds the new project');

// rename
const NEW = `QA Riverside Tower ${tag}`;
r = await call('PUT', `/api/projects/${pid}`, admin, { project_name: NEW });
ok(r.code === 200 && r.body.budget_rows_renamed === 3, 'renaming the project renames its Budget rows (' + r.body.budget_rows_renamed + ')');
ok(sql(`SELECT COUNT(*) FROM budget_items WHERE budget_id=${budgetId} AND project_name='${NEW}'`) === '3', 'Budget rows now carry the new name');
r = await call('POST', `/api/budgets/${budgetId}/import`, admin, { rows: [{ sl_no: '5', project_name: NEW, mrf_no: `QAN-${tag}-5`, description: 'Tiles', unit: 'sft', req_qty: '5' }] });
ok(r.code === 200, 'a later import with the new name goes straight in');
console.log(fails ? `${fails} of ${n} FAILED` : `ALL ${n} PASS`); process.exit(fails ? 1 : 0);
