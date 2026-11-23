// Credence Mail: tapping an image or PDF attachment opens it in the app
// (AttachmentViewer) with ‹ › / "1 / 3" through that mail's images and PDFs;
// the ⬇ next to it still downloads; any other file is downloaded on tap.
// Dev server :3200 + local Dovecot :143 (qa.mail@credence.test).
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { ImapFlow } = require('/home/user/CredenceHR/node_modules/imapflow');
const { execSync } = require('child_process');
const fs = require('fs');
const B = 'http://localhost:3200', OUT = process.argv[2] || '/tmp', IMGS = process.env.IMGS || '/tmp/claude-0/imgs';
const sql = (s) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "${s}"`).toString().trim();
const imap = async (fn) => { const c = new ImapFlow({ host: '127.0.0.1', port: 143, secure: false, auth: { user: 'qa.mail@credence.test', pass: 'MailPass123' }, logger: false }); await c.connect(); try { return await fn(c); } finally { await c.logout(); } };
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const acc = Number(sql("SELECT id FROM mail_accounts WHERE email='qa.mail@credence.test'"));
  sql(`DELETE FROM mail_messages WHERE account_id=${acc}; DELETE FROM mail_folder_state WHERE account_id=${acc}`);
  const subject = `Site photos ${Date.now().toString(36)}`;
  const part = (name, type, buf) => `--XB\r\nContent-Type: ${type}; name="${name}"\r\nContent-Disposition: attachment; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${buf.toString('base64').replace(/.{76}/g, '$&\r\n')}\r\n`;
  const raw = `From: Abdur Rahim <rahim@site.test>\r\nTo: qa.mail@credence.test\r\nSubject: ${subject}\r\nMessage-ID: <${Date.now()}@qa>\r\nDate: ${new Date().toUTCString()}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="XB"\r\n\r\n--XB\r\nContent-Type: text/plain\r\n\r\nPhotos and the letter attached.\r\n` +
    part('red.png', 'image/png', fs.readFileSync(`${IMGS}/red.png`)) + part('green.png', 'image/png', fs.readFileSync(`${IMGS}/green.png`)) +
    part('letter.pdf', 'application/pdf', fs.readFileSync(`${IMGS}/letter.pdf`)) + part('notes.txt', 'text/plain', Buffer.from('plain notes')) + '--XB--\r\n';
  await imap(async (c) => { await c.append('INBOX', Buffer.from(raw)); });
  const a = await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@credence.test', password: 'ProbePass123' }) })).json();
  await fetch(B + '/api/mail/sync', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token, 'content-type': 'application/json' }, body: JSON.stringify({ accountId: acc }) });
  const b = await chromium.launch();
  for (const phone of [false, true]) {
    const ctx = await b.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, acceptDownloads: true } : { viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 600; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9)); }, [a.token, a.user]);
    const p = await ctx.newPage(); const errs = []; let tabs = 0; p.on('pageerror', (e) => errs.push(String(e))); ctx.on('page', () => tabs++);
    const tag = phone ? 'phone' : 'computer';
    await p.goto(B + '/self/mail', { waitUntil: 'domcontentloaded' });
    await p.getByText(subject).first().waitFor({ timeout: 60000 });
    await p.getByText(subject).first().click(); await p.waitForTimeout(2500);
    const chips = p.getByTestId('mail-attachment').filter({ visible: true });
    ok((await chips.count()) === 4, `${tag}: four attachments`);
    await chips.filter({ hasText: 'green.png' }).click(); await p.waitForTimeout(1500);
    const dlg = p.getByRole('dialog', { name: 'green.png' });
    ok(await dlg.isVisible(), `${tag}: tap green.png → opens in the app`);
    ok((await p.getByTestId('attachment-viewer-count').innerText()).trim() === '2 / 3', `${tag}: "2 / 3" (two images + the PDF)`);
    // The server reads the file from the mail server: a few seconds the first time.
    ok(await dlg.locator('img[alt="green.png"]').waitFor({ timeout: 20000 }).then(() => true, () => false), `${tag}: the picture is shown`);
    if (!phone) await p.screenshot({ path: `${OUT}/mail-viewer-image.png` }).catch(() => {});
    await p.getByRole('button', { name: 'Next file' }).click(); await p.waitForTimeout(3500);
    const pdf = p.getByRole('dialog', { name: 'letter.pdf' });
    ok(await pdf.isVisible() && (await p.getByTestId('attachment-viewer-count').innerText()).trim() === '3 / 3', `${tag}: › → letter.pdf, 3 / 3`);
    ok(await pdf.locator('canvas[aria-label^="Page"]').first().waitFor({ timeout: 25000 }).then(() => true, () => false), `${tag}: PDF pages drawn in the app`);
    if (phone) await p.screenshot({ path: `${OUT}/mail-viewer-pdf-phone.png` }).catch(() => {});
    ok(await p.getByRole('button', { name: 'Next file' }).isDisabled(), `${tag}: no next after the last`);
    if (!phone) {
      await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(400);
      ok((await p.getByTestId('attachment-viewer-count').innerText()).trim() === '2 / 3', 'computer: ← key back to 2 / 3');
      ok(await p.locator('img[alt="green.png"]').waitFor({ timeout: 1500 }).then(() => true, () => false), 'computer: back to a file seen before — shown at once (kept, not fetched again)');
    } else {
      await p.getByRole('button', { name: 'Previous file' }).click(); await p.waitForTimeout(1200);
      ok((await p.getByTestId('attachment-viewer-count').innerText()).trim() === '2 / 3', 'phone: ‹ back to 2 / 3');
    }
    await p.getByRole('button', { name: 'Close' }).last().click(); await p.waitForTimeout(500);
    ok((await p.getByTestId('attachment-viewer-count').count()) === 0, `${tag}: ✕ closes`);
    if (!phone) {
      const [dl] = await Promise.all([p.waitForEvent('download', { timeout: 15000 }), p.getByRole('button', { name: 'Download red.png' }).click()]);
      ok(dl.suggestedFilename() === 'red.png', 'computer: ⬇ next to red.png downloads it');
      const [dl2] = await Promise.all([p.waitForEvent('download', { timeout: 15000 }), chips.filter({ hasText: 'notes.txt' }).click()]);
      ok(dl2.suggestedFilename() === 'notes.txt' && (await p.locator('[role="dialog"][aria-label="notes.txt"]').count()) === 0, 'computer: notes.txt (not viewable) downloads on tap, no viewer');
    }
    ok(tabs === 0 && errs.length === 0, `${tag}: no new tab, no page errors ` + JSON.stringify(errs));
    await ctx.close();
  }
  await b.close();
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})();
