// Credence Mail -> My folders in the browser (dev server :3200, Dovecot :143 with "/" folders).
// New folder, sub-folder from "⋯", Move to folder (toolbar), drag onto a folder, open it,
// reader button, rename, delete (mail back to Inbox) — each checked on the mail server.
const { chromium } = require('/opt/node-tools/node_modules/playwright/index.js');
const { ImapFlow } = require('/home/user/CredenceHR/node_modules/imapflow');
const { execSync } = require('child_process');
const B = 'http://localhost:3200', D = process.argv[2];
const sql = (s) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "${s}"`).toString().trim();
const imap = async (fn) => { const c = new ImapFlow({ host: '127.0.0.1', port: 143, secure: false, auth: { user: 'qa.mail@credence.test', pass: 'MailPass123' }, logger: false }); await c.connect(); try { return await fn(c); } finally { await c.logout(); } };
const countIn = (p) => imap(async (c) => (await c.status(p, { messages: true })).messages).catch(() => -1);
const paths = () => imap(async (c) => (await c.list()).map((m) => m.path).sort());
(async () => {
  let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
  const acc = Number(sql("SELECT id FROM mail_accounts WHERE email='qa.mail@credence.test'"));
  sql(`DELETE FROM mail_folders WHERE account_id=${acc}; DELETE FROM mail_folder_state WHERE account_id=${acc}; DELETE FROM mail_messages WHERE account_id=${acc}; UPDATE mail_accounts SET folders_json=NULL WHERE id=${acc}`);
  // Only this mailbox for the admin in this test.
  sql(`UPDATE mail_accounts SET user_id=0 WHERE user_id=1 AND id<>${acc}`);
  await imap(async (c) => {
    for (const m of (await c.list()).sort((a, b) => b.path.length - a.path.length)) if (m.path !== 'INBOX') await c.mailboxDelete(m.path).catch(() => {});
    const l = await c.getMailboxLock('INBOX'); try { if (c.mailbox.exists) await c.messageDelete('1:*'); } finally { l.release(); }
    for (const s of ['Gulshan slab casting', 'Gulshan cement order', 'Holiday notice']) await c.append('INBOX', Buffer.from(`From: Abdur Rahim <rahim@site.test>\r\nTo: qa.mail@credence.test\r\nSubject: ${s}\r\nMessage-ID: <${s.replace(/ /g, '')}@qa>\r\nDate: ${new Date().toUTCString()}\r\n\r\n${s}\r\n`));
  });
  const a = await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@credence.test', password: 'ProbePass123' }) })).json();
  await fetch(B + '/api/mail/sync', { method: 'POST', headers: { Authorization: 'Bearer ' + a.token, 'content-type': 'application/json' }, body: JSON.stringify({ accountId: acc }) });
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(([t, u]) => { localStorage.setItem('mpr_token', t); localStorage.setItem('mpr_user', JSON.stringify(u)); for (let i = 0; i < 600; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('chr_feedback_snooze', String(Date.now() + 9e9)); }, [a.token, a.user]);
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(String(e)));
  await p.goto(B + '/self/mail', { waitUntil: 'domcontentloaded' });
  await p.getByText('Gulshan slab casting').first().waitFor({ timeout: 60000 });
  const tree = p.locator('[aria-label="My folders"]').first();
  ok(await tree.getByRole('button', { name: /New folder/ }).isVisible(), 'sidebar: "Folders" with "New folder"');
  // New folder
  await tree.getByRole('button', { name: /New folder/ }).click();
  await p.locator('#mf-name').fill('Projects'); await p.getByRole('button', { name: 'Create' }).click();
  await tree.getByText('Projects', { exact: true }).waitFor({ timeout: 15000 });
  ok((await paths()).includes('Projects'), 'New folder -> "Projects" on the server');
  // Sub-folder from ⋯
  await tree.getByRole('button', { name: 'More for Projects' }).click({ force: true });
  await p.getByRole('menu').getByRole('button', { name: /New sub-folder/ }).click();
  ok((await p.locator('#mf-parent').inputValue()) !== '', '"Inside" already set to Projects');
  await p.locator('#mf-name').fill('Gulshan Tower'); await p.getByRole('button', { name: 'Create' }).click();
  await p.waitForTimeout(1500);
  ok((await paths()).includes('Projects/Gulshan Tower'), 'sub-folder on the server: Projects/Gulshan Tower');
  await tree.getByRole('button', { name: 'Open Projects' }).click();
  ok(await tree.getByText('Gulshan Tower', { exact: true }).isVisible(), 'tree: Gulshan Tower under Projects');
  await p.screenshot({ path: D + '/mail-folders-tree.png' });
  // Move to folder from the toolbar
  const row = (s) => p.locator('[role="button"]', { hasText: s }).first();
  await row('Gulshan slab casting').getByRole('button', { name: 'Select' }).click({ force: true });
  await p.getByRole('button', { name: 'Move to folder' }).first().click();
  await p.screenshot({ path: D + '/mail-folders-move.png' });
  await p.getByRole('dialog').getByRole('button', { name: /Gulshan Tower/ }).or(p.locator('button', { hasText: 'Gulshan Tower' }).last()).first().click();
  await p.waitForTimeout(2000);
  ok((await countIn('Projects/Gulshan Tower')) === 1, 'Move to folder -> 1 mail in Projects/Gulshan Tower on the server');
  // Drag a mail onto the folder
  await row('Gulshan cement order').dragTo(tree.locator('[data-folder-id]', { hasText: 'Gulshan Tower' }));
  await p.waitForTimeout(2500);
  ok((await countIn('Projects/Gulshan Tower')) === 2, 'drag onto the folder -> 2 there on the server');
  // Open the folder
  await tree.getByRole('button', { name: /Gulshan Tower/ }).first().click();
  await p.waitForTimeout(2500);
  ok(await p.getByText('Projects / Gulshan Tower').first().isVisible(), 'title shows the path');
  ok((await p.locator('[role="button"]', { hasText: 'Gulshan' }).count()) >= 2, 'the folder lists its 2 mails');
  ok(!(await p.locator('[role="button"]', { hasText: 'Holiday notice' }).count()), 'Inbox mail not here');
  // Reader: Move to folder button
  await row('Gulshan slab casting').click(); await p.waitForTimeout(1500);
  ok(await p.getByRole('button', { name: 'Move to folder' }).first().isVisible(), 'reader: "Move to folder" button');
  await p.screenshot({ path: D + '/mail-folders-open.png' });
  // Rename
  await tree.getByRole('button', { name: 'More for Projects' }).click({ force: true });
  await p.getByRole('menu').getByRole('button', { name: /Rename/ }).click();
  await p.locator('#mf-name').fill('Sites'); await p.getByRole('button', { name: 'Save' }).click();
  await p.waitForTimeout(2000);
  ok((await paths()).includes('Sites/Gulshan Tower'), 'Rename -> Sites/Gulshan Tower on the server');
  // Delete (red confirm)
  await tree.getByRole('button', { name: 'More for Sites' }).click({ force: true });
  await p.getByRole('menu').getByRole('button', { name: /Delete/ }).click();
  await p.getByText(/no mail is deleted/).waitFor();
  await p.screenshot({ path: D + '/mail-folders-delete.png' });
  await p.getByRole('button', { name: 'Delete folder' }).click();
  await p.waitForTimeout(3000);
  ok(!(await paths()).some((x) => x.startsWith('Sites')) && (await countIn('INBOX')) === 3, 'Delete -> folders gone on the server, all 3 mails back in INBOX');
  ok(await p.getByText('Holiday notice').first().isVisible(), 'back on Inbox after deleting the open folder');
  sql(`UPDATE mail_accounts SET user_id=1 WHERE user_id=0`);
  console.log('errors:', errs.slice(0, 3)); ok(errs.length === 0, 'no page errors');
  console.log(`\n${pass} passed, ${fail} failed`); await b.close();
})().catch((e) => { console.error(e); try { sql(`UPDATE mail_accounts SET user_id=1 WHERE user_id=0`); } catch {} process.exit(1); });
