// Appointment Letter at Hire: HR issues it for a joiner (before they are an
// Employee); the joiner sees it in My Onboarding, must upload the signed copy;
// on approval the letter moves onto the new Employee, acknowledged.
import { execSync } from 'node:child_process';
const B = process.env.BASE || 'http://localhost:3200';
const sql = (q) => execSync(`mysql -h127.0.0.1 -ucred -pcredpass ${process.env.DB_NAME || 'admin_ui'} -N -e ${JSON.stringify(q)}`).toString().trim();
let fails = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const call = async (method, path, tok, body) => {
  const r = await fetch(B + path, { method, headers: { authorization: 'Bearer ' + tok, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { code: r.status, body: j };
};
const login = async (email, password = 'ProbePass123') => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json());
const admin = (await login('admin@credence.test')).token;
const tag = Date.now().toString(36);

let c = await call('POST', '/api/hr-ops/joiner-onboarding', admin, { name: `Letter Joiner ${tag}`, designation: 'Site Engineer', joining_date: '2026-12-01' });
ok(c.code === 201, 'HR opens a joiner onboarding (' + c.code + ')');
const id = c.body.id;
let list = (await call('GET', '/api/hr-ops/joiner-onboarding', admin)).body.find((a) => a.id === id);
ok(list.appointment_letter === null && list.appointment_template === true, 'no letter yet; a template exists');

let p = await call('POST', `/api/hr-ops/joiner-onboarding/${id}/appointment-letter/preview`, admin, { gross_salary: 55000, basic_salary: 33000, probation_months: 3, letter_date: '2026-11-19' });
ok(p.code === 200 && p.body.body.includes(`Letter Joiner ${tag}`) && p.body.body.includes('55,000') && p.body.body.includes('Site Engineer') && /3 months/.test(p.body.body), 'preview: name, designation, salary, probation filled');
ok(/^.+\/APT\//.test(p.body.ref_no) || /APT/.test(p.body.ref_no), 'preview gives an APT ref no (' + p.body.ref_no + ')');

// the joiner, before the letter
const j = await login(c.body.login_id, c.body.password);
const jt = j.token;
let me = await call('GET', '/api/onboarding/me', jt);
ok(me.body.appointment_letter === null && !me.body.required_documents.some((d) => /appointment/i.test(d)), 'before the letter: nothing to sign is asked for');

let iss = await call('POST', `/api/hr-ops/joiner-onboarding/${id}/appointment-letter`, admin, { gross_salary: 55000, basic_salary: 33000, probation_months: 3, letter_date: '2026-11-19', subject: 'Letter of Appointment', body: p.body.body + '\n\nEdited by HR.' });
ok(iss.code === 200 && iss.body.ref_no, 'HR issues it (' + iss.body.ref_no + ')');
ok((await call('POST', `/api/hr-ops/joiner-onboarding/${id}/appointment-letter`, admin, { gross_salary: 1 })).code === 409, 'a second one is refused while one is issued');
ok(sql(`SELECT CONCAT(IFNULL(employee_id,'null'),'/',onboarding_id) FROM hr_letters WHERE id=${iss.body.id}`) === `null/${id}`, 'stored with the onboarding, no Employee yet');
ok(sql(`SELECT COUNT(*) FROM alerts WHERE user_id=${j.user.id} AND title LIKE 'Your Appointment Letter%'`) === '1', 'the joiner is alerted');

me = await call('GET', '/api/onboarding/me', jt);
const L = me.body.appointment_letter;
ok(L && L.ref_no === iss.body.ref_no && /Edited by HR\./.test(L.body) && L.company && L.company.name !== undefined, 'My Onboarding shows the issued letter (HR edits kept) with company details for the PDF');
ok(me.body.required_documents.includes(L.signed_doc_type) && me.body.missing.some((m) => m.includes(L.signed_doc_type)), 'now the signed copy is a required document (' + L.signed_doc_type + ')');
const letters = (await call('GET', '/api/hr-ops/letters', admin)).body;
ok(letters.some((l) => l.id === iss.body.id && /\(joiner\)/.test(l.employee_name)), 'Letters register lists it under the joiner');

// cancel + issue again
ok((await call('POST', `/api/hr-ops/joiner-onboarding/${id}/appointment-letter/cancel`, admin, { reason: 'salary changed' })).code === 200, 'HR cancels it');
me = await call('GET', '/api/onboarding/me', jt);
ok(me.body.appointment_letter === null, 'cancelled letter disappears for the joiner');
iss = await call('POST', `/api/hr-ops/joiner-onboarding/${id}/appointment-letter`, admin, { gross_salary: 60000, probation_months: 6 });
ok(iss.code === 200, 'a new one can be issued');

// permission
const pu = sql("SELECT email FROM users WHERE role='user' AND is_onboarding=0 AND COALESCE(is_blocked,0)=0 AND email LIKE 'qa.share.%' LIMIT 1");
if (pu) {
  const ut = (await login(pu)).token;
  ok((await call('POST', `/api/hr-ops/joiner-onboarding/${id}/appointment-letter/preview`, ut, { gross_salary: 1 })).code === 403, 'a plain user cannot prepare or issue it');
  ok((await call('GET', `/api/hr-ops/joiner-onboarding/${id}/appointment-letter`, ut)).code === 403, 'a plain user cannot read it');
}

// joiner fills, uploads (signed copy included), submits
const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
me = await call('GET', '/api/onboarding/me', jt);
for (const d of me.body.required_documents) await call('POST', '/api/onboarding/me/documents', jt, { doc_type: d, file_name: `${d}.pdf`, file_mime: 'application/pdf', file_base64: pdf });
const digits = String(parseInt(tag, 36)).slice(-8).padStart(8, '0');
const s = await call('POST', '/api/onboarding/me/submit', jt, {
  personal: { gender: 'Male', date_of_birth: '1995-05-05', nid_ssn: `78${digits}`, mobile: `018${digits}`, present_address: 'Dhaka', permanent_address: 'Khulna', personal_email: `letter.${tag}@test.invalid` },
  contacts: [{ name: `Father ${tag}`, relation: 'Father', phone: `019${digits}` }],
  nominees: [{ name: `Father ${tag}`, relation: 'Father', nominee_percent: 100 }]
});
ok(s.code === 200, 'joiner submits with the signed copy (' + JSON.stringify(s.body).slice(0, 120) + ')');
const det = (await call('GET', `/api/hr-ops/joiner-onboarding/${id}`, admin)).body;
ok(det.appointment_letter && det.documents.some((d) => d.doc_type === det.signed_letter_doc_type), 'HR review sees the letter and the signed copy');

sql(`UPDATE onboarding_applications SET created_by = NULL WHERE id = ${id}`); // the opener may not approve
const ap = await call('POST', `/api/hr-ops/joiner-onboarding/${id}/approve`, admin, {});
ok(ap.code === 200 && ap.body.employee_id, 'approved → Employee ' + (ap.body.employee_code || ''));
ok(ap.body.appointment_letter && ap.body.appointment_letter.issued && ap.body.appointment_letter.issued.ref_no === iss.body.ref_no, 'approval reports the letter already issued');
ok(sql(`SELECT CONCAT(employee_id, '/', acknowledged_at IS NOT NULL) FROM hr_letters WHERE id=${iss.body.id}`) === `${ap.body.employee_id}/1`, 'the letter now belongs to the Employee, acknowledged (signed)');
ok(sql(`SELECT COUNT(*) FROM hr_letters WHERE onboarding_id=${id} AND status='cancelled' AND employee_id=${ap.body.employee_id}`) === '1', 'the cancelled one moves too (kept in the register)');
ok(Number(sql(`SELECT COUNT(*) FROM employee_documents WHERE user_id=${j.user.id} AND doc_type LIKE '%ppointment%'`)) >= 1, 'signed copy is in the Employee\'s documents');

console.log(fails ? `${fails} of ${n} FAILED` : `ALL ${n} PASS`);
process.exit(fails ? 1 : 0);
