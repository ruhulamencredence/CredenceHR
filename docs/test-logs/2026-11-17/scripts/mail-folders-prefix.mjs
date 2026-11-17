// My folders on a cPanel-style server: folders under "INBOX." with "." between levels
// (Dovecot namespace prefix=INBOX. separator=.). Run after switching Dovecot to that layout.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ImapFlow } = require('/home/user/CredenceHR/node_modules/imapflow');
const { execSync } = require('child_process');
const B = process.env.BASE || 'http://localhost:3200';
const sql = (s) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "${s}"`).toString().trim();
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const imap = async (fn) => { const c = new ImapFlow({ host: '127.0.0.1', port: 143, secure: false, auth: { user: 'qa.mail@credence.test', pass: 'MailPass123' }, logger: false }); await c.connect(); try { return await fn(c); } finally { await c.logout(); } };
const paths = () => imap(async (c) => (await c.list()).map((m) => m.path).sort());
const countIn = (p) => imap(async (c) => (await c.status(p, { messages: true })).messages);
const tok = (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@credence.test', password: 'ProbePass123' }) })).json()).token;
const call = async (method, path, body) => { const r = await fetch(B + '/api/mail' + path, { method, headers: { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const acc = Number(sql("SELECT id FROM mail_accounts WHERE email='qa.mail@credence.test'"));
sql(`DELETE FROM mail_folders WHERE account_id=${acc}; DELETE FROM mail_folder_state WHERE account_id=${acc}; DELETE FROM mail_messages WHERE account_id=${acc}; UPDATE mail_accounts SET folders_json=NULL WHERE id=${acc}`);
await imap(async (c) => {
  for (const m of (await c.list()).sort((a, b) => b.path.length - a.path.length)) if (m.path !== 'INBOX') await c.mailboxDelete(m.path).catch(() => {});
  const l = await c.getMailboxLock('INBOX'); try { if (c.mailbox.exists) await c.messageDelete('1:*'); } finally { l.release(); }
  await c.append('INBOX', Buffer.from(`From: a@site.test\r\nTo: qa.mail@credence.test\r\nSubject: Site report\r\nMessage-ID: <p1@qa>\r\n\r\nx\r\n`));
});
await call('POST', '/sync', { accountId: acc });
const ns = await imap(async (c) => c.namespace);
console.log('   server namespace:', JSON.stringify(ns));
const p1 = await call('POST', '/folders', { accountId: acc, name: 'Projects' });
const p2 = await call('POST', '/folders', { accountId: acc, name: 'Gulshan Tower', parentId: p1.body.folder?.id });
ok(p1.body.folder?.path === 'INBOX.Projects' && p2.body.folder?.path === 'INBOX.Projects.Gulshan Tower', `paths use the prefix and ".": ${p1.body.folder?.path} / ${p2.body.folder?.path}`);
ok((await call('POST', '/folders', { accountId: acc, name: 'a.b' })).status === 400, 'a name with "." -> 400 here');
const list = (await call('GET', `/folders?accountId=${acc}&refresh=1`)).body.folders || [];
ok(list.find((f) => f.id === p2.body.folder.id)?.parentId === p1.body.folder.id, 'tree from the server: Gulshan Tower inside Projects');
const m = ((await call('GET', `/messages?accountId=${acc}&label=Inbox`)).body.items || [])[0];
await call('POST', '/messages/batch', { ids: [m.id], action: 'move', to: `Folder:${p2.body.folder.id}` });
ok((await countIn('INBOX.Projects.Gulshan Tower')) === 1, 'mail moved into INBOX.Projects.Gulshan Tower on the server');
await call('PATCH', `/folders/${p1.body.folder.id}`, { name: 'Sites' });
let sp = await paths();
ok(sp.includes('INBOX.Sites.Gulshan Tower'), `rename keeps the prefix: ${sp.join(', ')}`);
const del = await call('DELETE', `/folders/${p1.body.folder.id}`);
sp = await paths();
ok(del.status === 200 && !sp.some((p) => p.startsWith('INBOX.Sites')) && (await countIn('INBOX')) === 1, `delete: folders gone, mail back in INBOX (${sp.join(', ')})`);
console.log(`\n${pass} passed, ${fail} failed`);
