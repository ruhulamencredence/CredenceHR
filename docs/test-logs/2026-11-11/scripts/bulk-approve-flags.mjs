const B = 'http://127.0.0.1:3200';
const login = async (id) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: id, password: 'ProbePass123', workspace: 'credence' }) })).json()).token;
for (const who of ['admin@credence.test', 'roster.hr@credence.test', 'relink01']) {
  const t = await login(who);
  const r = await fetch(B + '/api/admin-dashboard/extras', { headers: { authorization: 'Bearer ' + t } });
  const x = await r.json();
  const fmt = (l) => (l || []).map((i) => `${i.name}:${i.approve ? i.approve.via : '—'}`).join(', ');
  console.log(who, r.status, '\n  approvals  ', fmt(x.attendance_approvals), '\n  corrections', fmt(x.attendance_corrections));
}
