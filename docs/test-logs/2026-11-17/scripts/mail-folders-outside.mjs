// Sub-folders made outside CredenceHR (Outlook / cPanel webmail create them straight on the
// IMAP server): they appear in the tree with the right parent, and their mail comes in.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { ImapFlow } = require('/home/user/CredenceHR/node_modules/imapflow');
const { execSync } = require('child_process');
const B = 'http://localhost:3200';
const sql = (s) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e "${s}"`).toString().trim();
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + m); };
const imap = async (fn) => { const c = new ImapFlow({ host: '127.0.0.1', port: 143, secure: false, auth: { user: 'qa.mail@credence.test', pass: 'MailPass123' }, logger: false }); await c.connect(); try { return await fn(c); } finally { await c.logout(); } };
const tok = (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@credence.test', password: 'ProbePass123' }) })).json()).token;
const call = async (m, p, b) => { const r = await fetch(B + '/api/mail' + p, { method: m, headers: { Authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return r.json(); };
const acc = Number(sql("SELECT id FROM mail_accounts WHERE email='qa.mail@credence.test'"));
const msg = (s) => Buffer.from(`From: client@abc.test\r\nTo: qa.mail@credence.test\r\nSubject: ${s}\r\nMessage-ID: <${Math.random().toString(36).slice(2)}@qa>\r\n\r\n${s}\r\n`);
// "Outlook": Clients / ABC Ltd / Invoices, two levels deep, mail in the deepest and the middle one.
await imap(async (c) => {
  for (const p of ['Clients/ABC Ltd/Invoices', 'Clients/ABC Ltd', 'Clients']) await c.mailboxDelete(p).catch(() => {});
  await c.mailboxCreate('Clients'); await c.mailboxCreate('Clients/ABC Ltd'); await c.mailboxCreate('Clients/ABC Ltd/Invoices');
  await c.append('Clients/ABC Ltd', msg('Meeting notes ABC')); await c.append('Clients/ABC Ltd/Invoices', msg('Invoice ABC-101')); await c.append('Clients/ABC Ltd/Invoices', msg('Invoice ABC-102'));
});
const f = (await call('GET', `/folders?accountId=${acc}&refresh=1`)).folders || [];
const by = (p) => f.find((x) => x.path === p);
ok(by('Clients') && by('Clients/ABC Ltd') && by('Clients/ABC Ltd/Invoices'), 'all three show up');
ok(by('Clients/ABC Ltd')?.parentId === by('Clients')?.id && by('Clients/ABC Ltd/Invoices')?.parentId === by('Clients/ABC Ltd')?.id, 'nested the same way: Clients > ABC Ltd > Invoices');
await call('POST', '/sync', { accountId: acc, folderId: by('Clients/ABC Ltd/Invoices').id });
await call('POST', '/sync', { accountId: acc, folderId: by('Clients/ABC Ltd').id });
const n = async (id) => ((await call('GET', `/messages?accountId=${acc}&label=Folder:${id}`)).items || []).length;
ok((await n(by('Clients/ABC Ltd/Invoices').id)) === 2 && (await n(by('Clients/ABC Ltd').id)) === 1, 'their mail comes in (Invoices 2, ABC Ltd 1)');
// "Outlook" renames and deletes: followed on the next refresh.
await imap(async (c) => { await c.mailboxRename('Clients/ABC Ltd/Invoices', 'Clients/ABC Ltd/Bills'); });
let g = (await call('GET', `/folders?accountId=${acc}&refresh=1`)).folders || [];
ok(g.some((x) => x.path === 'Clients/ABC Ltd/Bills') && !g.some((x) => x.path === 'Clients/ABC Ltd/Invoices'), 'renamed in "Outlook" -> renamed here');
await imap(async (c) => { for (const p of ['Clients/ABC Ltd/Bills', 'Clients/ABC Ltd', 'Clients']) await c.mailboxDelete(p).catch(() => {}); });
g = (await call('GET', `/folders?accountId=${acc}&refresh=1`)).folders || [];
ok(!g.some((x) => x.path.startsWith('Clients')), 'deleted in "Outlook" -> gone here');
console.log(`\n${pass} passed, ${fail} failed`);
