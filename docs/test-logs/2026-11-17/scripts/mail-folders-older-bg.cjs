// (1) "Older mail from the server": a folder with 250 mails first brings the latest 200,
//     then the button brings the other 50 (and says nothing is left); the same for Inbox.
// (2) Background: with the mail page open (the person is online), a mail filed straight into a
//     folder on the server (an Outlook / server rule) comes in by itself within ~5 minutes —
//     nobody opens that folder. Dovecot with prefix=INBOX. separator=. ; dev server :3200.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { ImapFlow } = require('/home/user/CredenceHR/node_modules/imapflow');
const { execSync } = require('child_process');
const B = 'http://localhost:3200';
const sql = (s) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "${s}"`).toString().trim();
const imap = async (fn) => { const c = new ImapFlow({ host: '127.0.0.1', port: 143, secure: false, auth: { user: 'qa.mail@credence.test', pass: 'MailPass123' }, logger: false }); await c.connect(); try { return await fn(c); } finally { await c.logout(); } };
const msg = (s) => Buffer.from(`From: bulk@site.test\r\nTo: qa.mail@credence.test\r\nSubject: ${s}\r\nMessage-ID: <${s.replace(/\W/g, '')}-${Math.random().toString(36).slice(2)}@qa>\r\n\r\n${s}\r\n`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  const acc = Number(sql("SELECT id FROM mail_accounts WHERE email='qa.mail@credence.test'"));
  sql(`DELETE FROM mail_folders WHERE account_id=${acc}; DELETE FROM mail_folder_state WHERE account_id=${acc}; DELETE FROM mail_messages WHERE account_id=${acc}; UPDATE mail_accounts SET folders_json=NULL WHERE id=${acc}`);
  sql(`UPDATE mail_accounts SET user_id=0 WHERE user_id=1 AND id<>${acc}`);
  await imap(async (c) => {
    for (const m of (await c.list()).sort((a, b) => b.path.length - a.path.length)) if (m.path !== 'INBOX') await c.mailboxDelete(m.path).catch(() => {});
    const l = await c.getMailboxLock('INBOX'); try { if (c.mailbox.exists) await c.messageDelete('1:*'); } finally { l.release(); }
    await c.mailboxCreate('INBOX.Bulk'); await c.mailboxCreate('INBOX.Reports');
    for (let i = 1; i <= 250; i++) await c.append('INBOX.Bulk', msg(`Bulk ${i}`));
    for (let i = 1; i <= 210; i++) await c.append('INBOX', msg(`Inbox ${i}`));
    await c.append('INBOX.Reports', msg('Report 1'));
  });
  const a = await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@credence.test', password: 'ProbePass123' }) })).json();
  const call = async (m, p, b) => { const r = await fetch(B + '/api/mail' + p, { method: m, headers: { Authorization: 'Bearer ' + a.token, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  await call('POST', '/sync', { accountId: acc });
  const f = (await call('GET', `/folders?accountId=${acc}&refresh=1`)).body.folders || [];
  const bulk = f.find((x) => x.path === 'INBOX.Bulk'), rep = f.find((x) => x.path === 'INBOX.Reports');
  await call('POST', '/sync', { accountId: acc, folderId: bulk.id });
  const count = (role) => Number(sql(`SELECT COUNT(*) FROM mail_messages WHERE account_id=${acc} AND folder_role='${role}'`));
  ok(count(`f:${bulk.id}`) === 200, `folder with 250: first the latest 200 (${count(`f:${bulk.id}`)})`);
  let r = await call('POST', '/older', { label: `Folder:${bulk.id}` });
  ok(r.body.added === 50 && r.body.left === 0 && count(`f:${bulk.id}`) === 250, `"Older mail": +${r.body.added}, ${r.body.left} left, now ${count(`f:${bulk.id}`)}`);
  r = await call('POST', '/older', { label: `Folder:${bulk.id}` });
  ok(r.body.added === 0 && r.body.left === 0, 'again: nothing more (the screen says so)');
  ok(sql(`SELECT COUNT(*) FROM mail_messages WHERE account_id=${acc} AND folder_role='f:${bulk.id}' AND subject='Bulk 1'`) === '1', 'the very first mail is there');
  ok(count('inbox') === 200, `Inbox: latest 200 first (${count('inbox')})`);
  r = await call('POST', '/older', { label: 'Inbox', accountId: acc });
  ok(r.body.added === 10 && r.body.left === 0 && count('inbox') === 210, `Inbox "Older mail": +${r.body.added} -> ${count('inbox')}`);
  // (2) Background sync of folders, with the page open.
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 600; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9)); }, [a.token, a.user]);
  const p = await ctx.newPage(); await p.goto(B + '/self/mail'); await p.locator('[aria-label="My folders"]').first().waitFor({ timeout: 60000 });
  // First background check: Reports (never opened) comes in by itself.
  for (let i = 0; i < 9 && count(`f:${rep.id}`) === 0; i++) await wait(15000);
  ok(count(`f:${rep.id}`) === 1, 'background: a folder nobody opened came in by itself');
  const t0 = Date.now();
  await imap(async (c) => c.append('INBOX.Reports', msg('Report 2 filed by an Outlook rule')));
  for (let i = 0; i < 28 && count(`f:${rep.id}`) < 2; i++) await wait(15000);
  ok(count(`f:${rep.id}`) === 2, `background: new mail in the folder came in by itself after ${Math.round((Date.now() - t0) / 1000)} s (nobody opened it)`);
  await b.close();
  sql(`UPDATE mail_accounts SET user_id=1 WHERE user_id=0`);
  console.log(`\n${pass} passed, ${fail} failed`);
})().catch((e) => { console.error(e); try { sql(`UPDATE mail_accounts SET user_id=1 WHERE user_id=0`); } catch {} process.exit(1); });
