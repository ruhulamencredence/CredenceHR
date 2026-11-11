// The server must refuse an approve from someone who may not, whatever the UI shows.
const B = 'http://127.0.0.1:3200';
const login = async (id) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: id, password: 'ProbePass123', workspace: 'credence' }) })).json()).token;
const t = await login('relink01');
const r = await fetch(B + '/api/my-approvals/28/act', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: JSON.stringify({ action: 'approved' }) });
console.log('relink01 approving check-out #28 directly:', r.status, await r.text());
