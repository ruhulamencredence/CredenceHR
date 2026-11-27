// Credence Mail -> My folders against a real IMAP server (Dovecot on 127.0.0.1:143,
// user qa.mail@credence.test / MailPass123; an SMTP stub on :2525) and the dev server on :3200.
// Checks every step on the mail server itself, the way Outlook / a phone would see it.
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
const mail = (subj, from = 'rahim@site.test') => Buffer.from(`From: ${from}\r\nTo: qa.mail@credence.test\r\nSubject: ${subj}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@qa>\r\nDate: ${new Date().toUTCString()}\r\n\r\n${subj} body\r\n`);
const login = async (email, password) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).token;
const api = (tok) => async (method, path, body) => { const r = await fetch(B + '/api/mail' + path, { method, headers: { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

// Fresh mailbox on the server: delete every folder but INBOX, empty INBOX, 3 mails in.
await imap(async (c) => {
  for (const m of (await c.list()).sort((a, b) => b.path.length - a.path.length)) if (m.path !== 'INBOX') await c.mailboxDelete(m.path).catch(() => {});
  const l = await c.getMailboxLock('INBOX'); try { if (c.mailbox.exists) await c.messageDelete('1:*'); } finally { l.release(); }
  for (const s of ['Gulshan slab casting', 'Gulshan cement order', 'Holiday notice']) await c.append('INBOX', mail(s));
});
const A = await login('admin@credence.test', 'ProbePass123');
const call = api(A);
// The test mailbox, connected once.
sql("DELETE FROM mail_messages WHERE account_id IN (SELECT id FROM mail_accounts WHERE email='qa.mail@credence.test'); DELETE FROM mail_folder_state WHERE account_id IN (SELECT id FROM mail_accounts WHERE email='qa.mail@credence.test'); DELETE FROM mail_folders WHERE account_id IN (SELECT id FROM mail_accounts WHERE email='qa.mail@credence.test'); DELETE FROM mail_accounts WHERE email='qa.mail@credence.test'");
const con = await call('POST', '/accounts', { email: 'qa.mail@credence.test', password: 'MailPass123', imapHost: '127.0.0.1', imapPort: 143, imapSecure: false, smtpHost: '127.0.0.1', smtpPort: 2525, smtpSecure: false, username: 'qa.mail@credence.test', name: 'QA Mail' });
ok(con.status === 200 || con.status === 201, `mailbox connected (${con.status} ${con.body.error || ''})`);
const acc = Number(sql("SELECT id FROM mail_accounts WHERE email='qa.mail@credence.test'"));
await new Promise((r) => setTimeout(r, 2500));
await call('POST', '/sync', { accountId: acc });
const inboxList = (await call('GET', `/messages?accountId=${acc}&label=Inbox`)).body.items || [];
ok(inboxList.length === 3, `3 mails in Inbox (${inboxList.length})`);

// Permission: folders come with Mail — no Mail, no folders; Mail on, folders on (no switch of their own).
sql("UPDATE users SET can_use_mail=0, role='user' WHERE email='qa.claimant@credence.test'");
let U = await login('qa.claimant@credence.test', 'ProbePass123');
ok((await api(U)('GET', '/folders')).status === 403, 'no Mail -> GET /folders 403');
ok((await api(U)('POST', '/folders', { accountId: acc, name: 'X' })).status === 403, 'no Mail -> cannot create');
sql("UPDATE users SET can_use_mail=1 WHERE email='qa.claimant@credence.test'");
await new Promise((r) => setTimeout(r, 31000)); // the server keeps an access answer 30 s
U = await login('qa.claimant@credence.test', 'ProbePass123');
ok((await api(U)('GET', '/folders')).status === 200 && (await api(U)('GET', '/status')).body.canFolders === true, 'Mail on -> folders on (canFolders, GET /folders 200), no extra switch');
ok((await api(U)('POST', '/folders', { accountId: acc, name: 'X' })).status === 404, "someone else's mailbox -> 404");
ok((await call('GET', '/status')).body.canFolders === true, 'Superadmin: status.canFolders');

// Create Projects, then Projects/Gulshan Tower — on the server.
const p1 = await call('POST', '/folders', { accountId: acc, name: 'Projects' });
ok(p1.status === 200, `create "Projects" (${p1.body.error || ''})`);
const p2 = await call('POST', '/folders', { accountId: acc, name: 'Gulshan Tower', parentId: p1.body.folder?.id });
ok(p2.status === 200 && p2.body.folder.path === 'Projects/Gulshan Tower', `create sub-folder: ${p2.body.folder?.path}`);
let sp = await paths();
ok(sp.includes('Projects') && sp.includes('Projects/Gulshan Tower'), `on the server: ${sp.join(', ')}`);
ok((await call('POST', '/folders', { accountId: acc, name: 'Gulshan Tower', parentId: p1.body.folder?.id })).status === 400, 'same name twice -> 400');
ok((await call('POST', '/folders', { accountId: acc, name: 'a/b' })).status === 400, 'name with "/" -> 400');
ok((await call('POST', '/folders', { accountId: acc, name: 'Sent' })).status === 400, 'reserved name "Sent" at top -> 400');
const subscribed = await imap(async (c) => (await c.list({ statusQuery: {} })).filter((m) => m.subscribed).map((m) => m.path));
ok(subscribed.includes('Projects/Gulshan Tower'), 'subscribed (Outlook / phone show it)');

// Move 2 mails into Gulshan Tower.
const gul = p2.body.folder.id;
const two = inboxList.filter((m) => m.subject.startsWith('Gulshan')).map((m) => m.id);
const mv = await call('POST', '/messages/batch', { ids: two, action: 'move', to: `Folder:${gul}` });
ok(mv.status === 200 && mv.body.done === 2, `move 2 to the folder (${mv.body.error || mv.body.done})`);
ok((await countIn('Projects/Gulshan Tower')) === 2 && (await countIn('INBOX')) === 1, 'server: 2 in Projects/Gulshan Tower, 1 in INBOX');
const inFolder = (await call('GET', `/messages?accountId=${acc}&label=Folder:${gul}`)).body.items || [];
ok(inFolder.length === 2, `the folder lists 2 (${inFolder.length})`);
ok(((await call('GET', `/messages?accountId=${acc}&label=Inbox`)).body.items || []).length === 1, 'Inbox lists 1');
const f1 = (await call('GET', '/folders')).body.folders || [];
ok(f1.find((f) => f.id === gul)?.total === 2 && f1.find((f) => f.id === gul)?.unread === 2, 'counts: 2, 2 unread');

// Read on the mail in the folder reaches the server.
await call('POST', '/messages/batch', { ids: [inFolder[0].id], patch: { isRead: true } });
await new Promise((r) => setTimeout(r, 1500));
const seen = await imap(async (c) => { const l = await c.getMailboxLock('Projects/Gulshan Tower'); try { let n = 0; for await (const m of c.fetch('1:*', { flags: true })) if (m.flags.has('\\Seen')) n++; return n; } finally { l.release(); } });
ok(seen === 1, 'marked read in the folder -> \\Seen on the server');

// A folder made in "Outlook" (straight on the server) with a mail: shows up and syncs.
await imap(async (c) => { await c.mailboxCreate('Vendors'); await c.append('Vendors', mail('Quotation rebar', 'sales@steel.test')); });
const f2 = (await call('GET', '/folders?refresh=1')).body.folders || [];
const ven = f2.find((f) => f.path === 'Vendors');
ok(!!ven, 'folder made elsewhere appears');
await call('POST', '/sync', { accountId: acc, folderId: ven.id });
ok(((await call('GET', `/messages?accountId=${acc}&label=Folder:${ven.id}`)).body.items || []).length === 1, 'its mail syncs in');

// Rename Projects -> Sites: the sub-folder follows; its mail stays.
const rn = await call('PATCH', `/folders/${p1.body.folder.id}`, { name: 'Sites' });
ok(rn.status === 200, `rename (${rn.body.error || ''})`);
sp = await paths();
ok(sp.includes('Sites/Gulshan Tower') && !sp.includes('Projects'), `server after rename: ${sp.join(', ')}`);
const f3 = (await call('GET', '/folders?refresh=1')).body.folders || [];
ok(f3.find((f) => f.id === gul)?.path === 'Sites/Gulshan Tower', 'sub-folder path follows (same folder, same id)');
await call('POST', '/sync', { accountId: acc, folderId: gul });
ok(((await call('GET', `/messages?accountId=${acc}&label=Folder:${gul}`)).body.items || []).length === 2, 'its 2 mails still listed after rename + sync');

// A rule: mail from steel.test -> Vendors (on the server too).
const rule = await call('POST', '/filters', { name: 'Steel to Vendors', conditions: { from: 'steel.test' }, actions: { moveToFolder: ven.id }, isActive: true });
ok(rule.status === 200 || rule.status === 201, 'rule saved');
await imap(async (c) => c.append('INBOX', mail('Invoice 4471', 'billing@steel.test')));
await new Promise((r) => setTimeout(r, 11000)); // past the 10 s manual-sync guard
await call('POST', '/sync', { accountId: acc });
ok((await countIn('Vendors')) === 2 && (await countIn('INBOX')) === 1, 'rule: new mail moved to Vendors on the server');
ok(((await call('GET', `/messages?accountId=${acc}&label=Folder:${ven.id}`)).body.items || []).some((m) => m.subject === 'Invoice 4471'), 'rule: listed in Vendors, not Inbox');
await call('DELETE', `/filters/${rule.body.id || ''}`);

// Back to Inbox from the folder.
const back = await call('POST', '/messages/batch', { ids: [inFolder[1].id], action: 'move', to: 'Inbox' });
ok(back.status === 200 && (await countIn('Sites/Gulshan Tower')) === 1 && (await countIn('INBOX')) === 2, 'move back to Inbox (server: 1 in folder, 2 in INBOX)');

// Delete Sites (with Gulshan Tower inside): its mail back to Inbox, folders gone.
const del = await call('DELETE', `/folders/${p1.body.folder.id}`);
ok(del.status === 200 && del.body.folders === 2, `delete folder + sub-folder (${del.body.error || del.body.folders})`);
sp = await paths();
ok(!sp.some((p) => p.startsWith('Sites')), `server after delete: ${sp.join(', ')}`);
ok((await countIn('INBOX')) === 3, 'its mail is back in INBOX on the server (none deleted)');
ok(((await call('GET', `/messages?accountId=${acc}&label=Inbox`)).body.items || []).length === 3, 'Inbox lists 3');
ok(sql(`SELECT COUNT(*) FROM mail_folders WHERE account_id=${acc}`) === '1', 'only Vendors left in the list');

// Trash from a folder: out of the folder.
const vm = (await call('GET', `/messages?accountId=${acc}&label=Folder:${ven.id}`)).body.items || [];
await call('POST', '/messages/batch', { ids: [vm[0].id], action: 'delete' });
ok(((await call('GET', `/messages?accountId=${acc}&label=Folder:${ven.id}`)).body.items || []).length === vm.length - 1, 'Delete from a folder: gone from the folder');

console.log(`\n${pass} passed, ${fail} failed`);
