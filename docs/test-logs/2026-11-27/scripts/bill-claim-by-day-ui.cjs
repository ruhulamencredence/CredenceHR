// Bill Claim, the day-by-day form: a card per day of From–To, a chip per
// category adds a dated bill, one bar (Cancel / Add) while a bill is being
// typed, "Same as <day before>", Cancel puts an edited bill back, then a
// Review step with the total by category, and Submit files the claim with
// every bill on its own date. Phone, and the same with the keyboard open.
// Dev server: BASE (default :3200).
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { execSync } = require('child_process');
const B = process.env.BASE || 'http://localhost:3200', OUT = process.argv[2] || '/tmp';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e ${JSON.stringify(q)}`).toString().trim();
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const dept = Number(sql("SELECT MAX(id) FROM departments WHERE name='Engineering'"));
  const [uid, email] = sql(`SELECT u.id,u.email FROM users u JOIN departments d ON d.head_user_id=u.id WHERE d.id=${dept}`).split('\t');
  sql(`UPDATE users SET can_view_bill_claims=1 WHERE id=${uid}`);
  sql(`DELETE FROM bill_claim_items WHERE bill_claim_id IN (SELECT id FROM bill_claims WHERE user_id=${uid}); DELETE FROM bill_claim_references WHERE bill_claim_id IN (SELECT id FROM bill_claims WHERE user_id=${uid}); DELETE FROM bill_claims WHERE user_id=${uid}`);
  // The rules' current version (made on first read after the policy changes).
  const pre = await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: email, password: 'Demo#2026pass' }) })).json();
  await fetch(B + '/api/bill-claim-rules/mine', { headers: { Authorization: 'Bearer ' + pre.token } });
  const ver = Number(sql('SELECT MAX(id) FROM bill_claim_rule_versions'));
  sql(`DELETE FROM bill_claim_rule_reads WHERE user_id=${uid}; INSERT INTO bill_claim_rule_reads (company_ref,user_id,version_id,action,created_at) VALUES (1,${uid},${ver},'confirm',NOW())`);
  const a = await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identifier: email, password: 'Demo#2026pass' }) })).json();
  const pol = await (await fetch(B + '/api/bill-claim-policy/mine', { headers: { Authorization: 'Bearer ' + a.token } })).json();
  const today = pol.today; const dd = (n) => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const b = await chromium.launch();
  const open = async (h) => {
    const ctx = await b.newContext({ viewport: { width: 390, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await ctx.addInitScript(([t, u, uid]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 900; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9)); try { sessionStorage.setItem('chr_boot_intro_played', '1'); } catch {} localStorage.setItem('mpr_user_section_' + uid, 'billClaim'); if (!localStorage.getItem('x_once')) { localStorage.setItem('x_once', '1'); localStorage.setItem('chr_draft:' + uid + ':bill-claim', JSON.stringify({ t: Date.now(), v: { open: true, fromDate: '', toDate: '', bills: [], description: '', selectedRefs: {}, fileName: null } })); } window.androidBridge = { postMessage() {} }; }, [a.token, a.user, uid]);
    const p = await ctx.newPage(); p.errs = []; p.on('pageerror', (e) => { if (!/not implemented on android/.test(String(e))) p.errs.push(String(e)); }); // the test fakes the Android app; its plugins aren't there
    await p.addLocatorHandler(p.getByText('How do you like the app?'), async () => { await p.getByRole('button', { name: 'Later' }).click(); });
    await p.goto(B + '/'); await p.getByText('New Bill Claim').first().waitFor({ timeout: 60000 }); await p.waitForTimeout(1500);
    return p;
  };
  const p = await open(844);
  const from = p.locator('input[type="date"]').first();
  await from.fill(dd(2)); await p.waitForTimeout(500);
  const days = p.getByTestId('bill-day');
  ok((await days.count()) === 3, 'From two days ago to today → 3 day cards');
  const day = (iso) => p.locator(`[data-testid="bill-day"][data-day="${iso}"]`);
  // Day 1: Fuel 650 (Enter adds), Parking 80 (bar's Add).
  await day(dd(2)).getByRole('button', { name: '+ Fuel' }).click();
  ok(await p.getByTestId('bill-edit-bar').isVisible(), 'a chip opens the bill with one bar: Cancel / Add');
  ok(!(await p.locator('[data-kb-self]').getByRole('button', { name: 'Review', exact: true }).isVisible()), "the popup's own Cancel / Review wait while the bill is typed");
  ok(await p.getByLabel('Bill 1 amount').evaluate((e) => document.activeElement === e), 'the Amount is ready to type in');
  await p.getByLabel('Bill 1 amount').fill('650'); await p.getByLabel('Bill 1 note').fill('Office car, 10 L'); await p.getByLabel('Bill 1 note').press('Enter');
  ok((await p.getByTestId('bill-editor').count()) === 0, 'Enter on the keyboard adds it');
  await day(dd(2)).getByRole('button', { name: '+ Parking' }).click();
  await p.getByLabel('Bill 2 amount').fill('80'); await p.getByTestId('bill-edit-bar').getByRole('button', { name: 'Add' }).click();
  ok((await day(dd(2)).innerText()).includes('৳730.00'), 'day 1 shows its own total ৳730.00');
  // Day 2: Toll 120.
  await day(dd(1)).getByRole('button', { name: '+ Toll' }).click();
  await p.getByLabel('Bill 3 amount').fill('120'); await p.getByLabel('Bill 3 note').fill('Padma bridge'); await p.getByTestId('bill-edit-bar').getByRole('button', { name: 'Add' }).click();
  // Day 3: "Same as" the day before.
  await day(dd(0)).getByRole('button', { name: /Same as/ }).click(); await p.waitForTimeout(300);
  ok((await day(dd(0)).innerText()).includes('Toll') && (await day(dd(0)).innerText()).includes('৳120.00'), '"Same as" copies the day before\'s bills');
  // An empty bill isn't added.
  await day(dd(0)).getByRole('button', { name: '+ Parking' }).click();
  await p.getByTestId('bill-edit-bar').getByRole('button', { name: 'Add' }).click();
  ok(await p.getByText('Enter an amount greater than 0.').isVisible(), 'Add with no amount → "Enter an amount greater than 0."');
  await p.getByTestId('bill-edit-bar').getByRole('button', { name: 'Cancel' }).click();
  ok((await day(dd(0)).innerText()).includes('1 bill'), 'Cancel on a new bill drops it');
  // Change a bill, then Cancel: it is back as it was.
  await day(dd(2)).getByRole('button', { name: /Fuel ৳650.00 — edit/ }).click();
  await p.getByLabel('Bill 1 amount').fill('999'); await p.getByTestId('bill-edit-bar').getByRole('button', { name: 'Cancel' }).click();
  ok((await day(dd(2)).innerText()).includes('৳650.00'), 'Cancel on a changed bill puts it back (৳650)');
  ok((await p.getByTestId('bill-claim-total').innerText()).includes('970.00'), 'Claim total ৳970.00');
  await p.screenshot({ path: `${OUT}/bill-claim-by-day.png` });
  // Keyboard: the page is the space above it.
  await p.setViewportSize({ width: 390, height: 554 });
  await day(dd(1)).getByRole('button', { name: /Toll ৳120.00 — edit/ }).click(); await p.waitForTimeout(800);
  const vis = async (loc) => { const r = await loc.boundingBox(); return !!r && r.y >= 0 && r.y + r.height <= 554; };
  ok(await vis(p.getByLabel('Bill 3 amount')), 'keyboard open: the Amount being typed is in view');
  ok(await vis(p.getByTestId('bill-edit-bar').getByRole('button', { name: 'Done' })), 'keyboard open: Done is just above the keyboard');
  await p.screenshot({ path: `${OUT}/bill-claim-keyboard.png` });
  await p.getByTestId('bill-edit-bar').getByRole('button', { name: 'Done' }).click();
  await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(300);
  // Review, Back, Review, Submit.
  await p.locator('[data-kb-self]').getByRole('button', { name: 'Review', exact: true }).click(); await p.waitForTimeout(400);
  const rv = await p.getByTestId('bill-claim-review').innerText();
  ok(rv.includes('৳970.00') && /Toll × 2/.test(rv) && rv.includes('Fuel') && rv.includes('Parking'), 'Review: ৳970.00, Toll × 2, Fuel, Parking');
  await p.screenshot({ path: `${OUT}/bill-claim-review.png` });
  await p.locator('[data-kb-self]').getByRole('button', { name: 'Back' }).click();
  ok((await p.getByTestId('bill-day').count()) === 3, 'Back returns to the days, bills kept');
  await p.locator('[data-kb-self]').getByRole('button', { name: 'Review', exact: true }).click();
  await p.getByPlaceholder(/CNG fare/).fill('Uttara site, 3 days');
  await p.locator('[data-kb-self]').getByRole('button', { name: 'Submit Claim' }).click(); await p.waitForTimeout(2500);
  const row = sql(`SELECT id, from_date, to_date, amount FROM bill_claims WHERE user_id=${uid} ORDER BY id DESC LIMIT 1`).split('\t');
  const items = sql(`SELECT GROUP_CONCAT(CONCAT(bill_date,'=',amount) ORDER BY bill_date, amount) FROM bill_claim_items WHERE bill_claim_id=${row[0]}`);
  ok(row[1] === dd(2) && row[2] === dd(0) && Number(row[3]) === 970, `claim filed: ${row[1]} – ${row[2]}, ৳${row[3]}`);
  ok(items === `${dd(2)}=80.00,${dd(2)}=650.00,${dd(1)}=120.00,${dd(0)}=120.00`, `each bill on its own date: ${items}`);
  ok(p.errs.length === 0, 'no page errors' + (p.errs.length ? ': ' + p.errs.join(' | ') : ''));
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS'); process.exit(fails ? 1 : 0);
})();
