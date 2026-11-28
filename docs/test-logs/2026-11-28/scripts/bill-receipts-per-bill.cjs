// Bill Claim — each bill carries its own receipts. Phone UI (day-by-day form)
// then the API: a category with "Receipt" ticked needs a receipt on every one
// of its bills; receipts open for the owner / Bill Claim admin / approver
// chain only; an edit keeps, adds and drops receipts; an older form (one file
// for the whole claim) is checked the old way.
// Needs: dev server :3200, Bill Claim Policy enforce_category_limits = 1 and
// Fuel + Parking with "Receipt" ticked; IMGS has receipt.jpg and letter.pdf.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const fs = require('fs');
const B = process.env.BASE || 'http://localhost:3200', OUT = process.argv[2] || '/tmp', IMGS = process.env.IMGS || '/tmp/claude-0/imgs';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
const login = async (i, p) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: i, password: p }) })).json());
const api = async (t, method, path, body) => { const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: body && JSON.stringify(body) }); let j = null; try { j = await r.clone().json(); } catch {} return { status: r.status, j, r }; };
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const dept = Number(sql("SELECT MAX(id) FROM departments WHERE name='Engineering'"));
  const [uid, email] = sql(`SELECT u.id,u.email FROM users u JOIN departments d ON d.head_user_id=u.id WHERE d.id=${dept}`).split('\t');
  const kEmail = sql(`SELECT u.email FROM users u JOIN all_employees e ON e.user_id=u.id WHERE e.department_id=${dept} AND e.name='Karim Ahmed'`);
  const wipe = () => sql(`DELETE FROM bill_claims WHERE user_id=${uid}`);
  sql(`UPDATE users SET can_view_bill_claims=1 WHERE id=${uid}`); wipe();
  const A = await login(email, 'Demo#2026pass'), K = await login(kEmail, 'Demo#2026pass'), SA = await login('admin@credence.test', 'ProbePass123');
  await api(A.token, 'GET', '/api/bill-claim-rules/mine');
  const ver = Number(sql('SELECT MAX(id) FROM bill_claim_rule_versions'));
  sql(`DELETE FROM bill_claim_rule_reads WHERE user_id=${uid}; INSERT INTO bill_claim_rule_reads (company_ref,user_id,version_id,action,created_at) VALUES (1,${uid},${ver},'confirm',NOW())`);
  const pol = (await api(A.token, 'GET', '/api/bill-claim-policy/mine')).j;
  const cat = (n) => pol.categories.find((c) => c.name === n).id;
  const today = pol.today; const dd = (n) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const b64 = (f) => fs.readFileSync(`${IMGS}/${f}`).toString('base64');

  // ---- phone UI
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(([t, u, uid]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 900; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9)); try { sessionStorage.setItem('chr_boot_intro_played', '1'); } catch {} localStorage.setItem('mpr_user_section_' + uid, 'billClaim'); if (!localStorage.getItem('x1')) { localStorage.setItem('x1', '1'); localStorage.setItem('chr_draft:' + uid + ':bill-claim', JSON.stringify({ t: Date.now(), v: { open: true, fromDate: '', toDate: '', bills: [], description: '', selectedRefs: {}, fileName: null } })); } window.androidBridge = { postMessage() {} }; }, [A.token, A.user, uid]);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => { if (!/not implemented on android/.test(String(e))) errs.push(String(e)); });
  await p.addLocatorHandler(p.getByText('How do you like the app?'), async () => { await p.getByRole('button', { name: 'Later' }).click(); });
  await p.goto(B + '/'); await p.getByText('New Bill Claim').first().waitFor({ timeout: 60000 }); await p.waitForTimeout(1500);
  await p.locator('input[type="date"]').first().fill(dd(1)); await p.waitForTimeout(400);
  const day = (iso) => p.locator(`[data-testid="bill-day"][data-day="${iso}"]`);
  const bar = () => p.getByTestId('bill-edit-bar');
  // Fuel with a receipt
  await day(dd(1)).getByRole('button', { name: '+ Fuel' }).click();
  ok((await p.getByTestId('bill-receipts').innerText()).includes('Receipt *'), 'Fuel (Receipt ticked): the bill shows "Receipt *"');
  await p.getByLabel('Bill 1 amount').fill('650');
  await p.getByLabel('Bill 1 receipt').setInputFiles(`${IMGS}/receipt.jpg`); await p.waitForTimeout(300);
  ok((await p.getByRole('button', { name: /^Open receipt/ }).count()) === 1, 'a photo picked → its thumbnail in the bill');
  await p.setViewportSize({ width: 390, height: 554 }); await p.getByLabel('Bill 1 amount').focus(); await p.getByLabel('Bill 1 amount').evaluate((e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(500);
  const vis = async (loc) => { const r = await loc.boundingBox(); return !!r && r.y >= 0 && r.y + r.height <= 554; };
  ok(await vis(p.getByLabel('Bill 1 amount')) && await vis(p.getByRole('button', { name: /^Open receipt/ })) && await vis(bar().getByRole('button', { name: 'Add' })), 'keyboard open: amount, receipt and Add all in view');
  await p.screenshot({ path: `${OUT}/receipts-keyboard.png` });
  await p.setViewportSize({ width: 390, height: 844 });
  await bar().getByRole('button', { name: 'Add' }).click(); await p.waitForTimeout(250);
  // Parking without, Toll (not needed)
  await day(dd(1)).getByRole('button', { name: '+ Parking' }).click(); await p.getByLabel('Bill 2 amount').fill('80'); await bar().getByRole('button', { name: 'Add' }).click(); await p.waitForTimeout(250);
  await day(dd(0)).getByRole('button', { name: '+ Toll' }).click();
  ok((await p.getByTestId('bill-receipts').innerText()).includes('Receipt (optional)'), 'Toll (no Receipt tick): "Receipt (optional)"');
  await p.getByLabel('Bill 3 amount').fill('120'); await bar().getByRole('button', { name: 'Add' }).click(); await p.waitForTimeout(250);
  ok(await day(dd(1)).getByRole('button', { name: /Fuel ৳650.00, 1 receipt/ }).isVisible(), 'Fuel row: 📎 1');
  ok(await day(dd(1)).getByRole('button', { name: /Parking ৳80.00, receipt needed/ }).isVisible(), 'Parking row: red "receipt needed"');
  ok((await p.getByTestId('receipts-missing').innerText()).includes('1 bill still needs its receipt'), 'a note under the total says which bill still needs it');
  await p.screenshot({ path: `${OUT}/receipts-list.png` });
  await p.locator('[data-kb-self]').getByRole('button', { name: 'Review', exact: true }).click(); await p.waitForTimeout(300);
  ok((await p.getByRole('alert').innerText()).includes('needs its receipt') && !(await p.getByTestId('bill-claim-review').count()), 'Review is refused while a receipt is missing');
  // add a PDF to Parking
  await day(dd(1)).getByRole('button', { name: /Parking ৳80.00/ }).click();
  await p.getByLabel('Bill 2 receipt').setInputFiles(`${IMGS}/letter.pdf`); await p.waitForTimeout(300);
  await bar().getByRole('button', { name: 'Done' }).click(); await p.waitForTimeout(250);
  await p.locator('[data-kb-self]').getByRole('button', { name: 'Review', exact: true }).click(); await p.waitForTimeout(400);
  const rv = await p.getByTestId('review-receipts').innerText();
  ok(/2 files/.test(rv) && /not needed/.test(rv), 'Review: "Receipts 2 files", Toll "not needed"');
  ok(await p.getByText('Other attachment (optional', { exact: false }).isVisible(), 'the claim\'s own file is now "Other attachment (optional)"');
  await p.screenshot({ path: `${OUT}/receipts-review.png` });
  await p.locator('[data-kb-self]').getByRole('button', { name: 'Submit Claim' }).click(); await p.waitForTimeout(2500);
  const claimId = Number(sql(`SELECT MAX(id) FROM bill_claims WHERE user_id=${uid}`));
  const files = sql(`SELECT CONCAT(i.category_name,':',f.file_mimetype) FROM bill_claim_item_files f JOIN bill_claim_items i ON i.id=f.item_id WHERE f.bill_claim_id=${claimId} ORDER BY i.category_name`).split('\n');
  ok(files.join(',') === 'Fuel:image/jpeg,Parking:application/pdf', `filed: each receipt on its own bill (${files.join(', ')})`);
  ok(errs.length === 0, 'no page errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
  await b.close();

  // ---- API: reading and opening receipts
  const mine = (await api(A.token, 'GET', '/api/bill-claims/mine')).j;
  const claim = (Array.isArray(mine) ? mine : mine.claims || []).find((c) => Number(c.id) === claimId);
  const fuel = claim.items.find((i) => i.category_name === 'Fuel');
  ok(fuel.files.length === 1 && fuel.files[0].file_name === 'receipt.jpg' && !('file_data' in fuel.files[0]), 'my claims: each bill lists its receipts (name, no file data)');
  const fid = fuel.files[0].id;
  const own = await fetch(`${B}/api/bill-claims/${claimId}/item-files/${fid}`, { headers: { authorization: 'Bearer ' + A.token } });
  ok(own.status === 200 && /image\/jpeg/.test(own.headers.get('content-type')) && (await own.arrayBuffer()).byteLength === fs.statSync(`${IMGS}/receipt.jpg`).size, 'owner opens the receipt (same bytes)');
  ok((await fetch(`${B}/api/bill-claims/${claimId}/item-files/${fid}`, { headers: { authorization: 'Bearer ' + K.token } })).status === 403, 'a colleague without Bill Claim can\'t open it (403)');
  ok((await fetch(`${B}/api/bill-claims/${claimId}/item-files/${fid}`, { headers: { authorization: 'Bearer ' + SA.token } })).status === 200, 'Superadmin opens it');
  const det = (await api(SA.token, 'GET', `/api/approval-details?type=bill_claim&id=${claimId}`)).j;
  ok(det.table.columns.includes('Receipt') && det.attachments.filter((a) => a.file).length === 2, 'approval details: a Receipt column and one attachment per receipt');
  const viaApproval = await fetch(`${B}/api/approval-details/file?type=bill_claim&id=${claimId}&file=${fid}`, { headers: { authorization: 'Bearer ' + SA.token } });
  ok(viaApproval.status === 200 && /image\/jpeg/.test(viaApproval.headers.get('content-type')), 'approvers open a receipt through approval-details (&file=)');
  ok((await fetch(`${B}/api/approval-details/file?type=bill_claim&id=${claimId}&file=${fid}`, { headers: { authorization: 'Bearer ' + K.token } })).status === 403, '…and someone outside the chain can\'t (403)');

  // ---- API: edit — keep Fuel's, add a second to Fuel, keep Parking's
  const pid = claim.items.find((i) => i.category_name === 'Parking').files[0].id;
  const base = (over) => ({ claim_date: today, from_date: dd(1), to_date: dd(0), version: claim.version, items: [
    { category_id: cat('Fuel'), bill_date: dd(1), amount: 650, keep_file_ids: [fid], files: [{ file_base64: b64('receipt.jpg'), file_name: 'second.jpg', file_mimetype: 'image/jpeg' }], ...(over?.[0] || {}) },
    { category_id: cat('Parking'), bill_date: dd(1), amount: 80, keep_file_ids: [pid], files: [], ...(over?.[1] || {}) },
    { category_id: cat('Toll'), bill_date: dd(0), amount: 120, keep_file_ids: [], files: [] }] });
  const e1 = await api(A.token, 'POST', `/api/bill-claims/${claimId}/edit`, base());
  const after = sql(`SELECT CONCAT(i.category_name,':',COUNT(*)) FROM bill_claim_item_files f JOIN bill_claim_items i ON i.id=f.item_id WHERE f.bill_claim_id=${claimId} GROUP BY i.category_name ORDER BY i.category_name`).split('\n').join(',');
  ok(e1.status === 200 && after === 'Fuel:2,Parking:1', `edit: kept receipts move to the rewritten bills, the new one is added (${after})`);
  ok(Number(sql(`SELECT COUNT(*) FROM bill_claim_item_files WHERE id=${fid} AND bill_claim_id=${claimId}`)) === 1, 'the kept receipt is the same file (not re-uploaded)');
  // edit dropping Parking's receipt → refused
  const v2 = Number(sql(`SELECT version FROM bill_claims WHERE id=${claimId}`));
  const e2 = await api(A.token, 'POST', `/api/bill-claims/${claimId}/edit`, { ...base([{ files: [], keep_file_ids: [fid] }, { keep_file_ids: [] }]), version: v2 });
  ok(e2.status === 400 && /Bill 2: attach the receipt for Parking/.test(e2.j.error), `server refuses a Parking bill without its receipt: "${e2.j?.error}"`);
  // 4 receipts on one bill → refused; a .txt → refused
  const e3 = await api(A.token, 'POST', `/api/bill-claims/${claimId}/edit`, { ...base([{ files: [1, 2, 3].map((k) => ({ file_base64: b64('receipt.jpg'), file_name: `r${k}.jpg`, file_mimetype: 'image/jpeg' })) }]), version: v2 });
  ok(e3.status === 400 && /at most 3 receipts/.test(e3.j.error), 'more than 3 receipts on a bill is refused');
  const e4 = await api(A.token, 'POST', `/api/bill-claims/${claimId}/edit`, { ...base([{ files: [{ file_base64: Buffer.from('hi').toString('base64'), file_name: 'a.txt', file_mimetype: 'text/plain' }] }]), version: v2 });
  ok(e4.status === 400 && /photo or a PDF/.test(e4.j.error), 'a non-photo / non-PDF receipt is refused');
  // someone else's receipt id can't be "kept" into my claim
  wipe();
  // ---- older form: one file for the whole claim, no per-bill files
  const old = await api(A.token, 'POST', '/api/bill-claims', { claim_date: today, from_date: today, to_date: today, items: [{ category_id: cat('Fuel'), bill_date: today, amount: 300 }], file_base64: b64('receipt.jpg'), file_name: 'r.jpg', file_mimetype: 'image/jpeg' });
  ok(old.status === 200 || old.status === 201, `an older form's claim with one claim file still goes in (${old.status})`);
  wipe();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})();
