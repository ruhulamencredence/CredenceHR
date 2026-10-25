// Ruhul's 5 years at Credence, end to end through the API, in date order:
// hiring -> onboarding -> login -> every Self Service feature -> 59 payroll
// months with increments, bonuses, two loans -> leave every year -> targets,
// appraisals, grievance, warning, promotion, transfer -> resignation ->
// clearance -> final settlement -> login blocked.
// Every step is recorded (PASS / FAIL / GAP) and the run carries on after a
// failure so one run shows every problem. Output: life/report.json.
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire('/home/user/CredenceHR/package.json');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const QRCode = require('qrcode');
const BASE = process.env.BASE || 'http://localhost:3100';

const results = [];
let phase = '';
let when = '';
const rec = (status, name, detail = '') => {
  results.push({ when, phase, status, name, detail: String(detail).slice(0, 400) });
  console.log(`${status.padEnd(4)} [${when}] ${name}${detail && status !== 'PASS' ? '  — ' + String(detail).slice(0, 300) : ''}`);
};
const check = (name, ok, detail = '') => (rec(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail), ok);
const gap = (name, detail) => rec('GAP', name, detail);
const at = (w, p) => { when = w; if (p) phase = p; };

const api = async (t, m, p, b) => {
  const r = await fetch(BASE + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b !== undefined ? JSON.stringify(b) : undefined });
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch { body = txt; }
  return { status: r.status, body };
};
const J = (r) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
const sql = (q) => /undefined|NaN/.test(q) ? '' : execFileSync('mysql', ['-N', 'mpr_tracker_db', '-e', q]).toString().trim();
const login = async (id, pw) => api(null, 'POST', '/api/auth/login', { identifier: id, password: pw });
const ok2 = (r) => r.status >= 200 && r.status < 300;
// step(): a call that must succeed; records it and returns the body.
const step = async (name, promise, expect = ok2) => { const r = await promise; check(name, expect(r), J(r)); return r; };

const pad = (n) => String(n).padStart(2, '0');
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(new Date(y, m, 0).getDate())}`; };
const months = [];
for (let y = 2021, m = 11; y < 2026 || (y === 2026 && m <= 10); m === 12 ? (y++, m = 1) : m++) months.push(`${y}-${pad(m)}`);
const mkPdf = async (title) => { const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); d.addPage([595, 842]).drawText(title, { x: 60, y: 760, size: 18, font: f }); return Buffer.from(await d.save()).toString('base64'); };
const sigPng = async (t) => 'data:image/png;base64,' + (await QRCode.toBuffer(t, { type: 'png', width: 200 })).toString('base64');

// Approve whatever the approver has pending for this source.
async function approveAs(token, sourceType, sourceId, action = 'approved', remarks = 'OK') {
  const list = await api(token, 'GET', '/api/my-approvals');
  const rows = Array.isArray(list.body) ? list.body : list.body?.items || list.body?.rows || [];
  const row = rows.find((r) => r.source_type === sourceType && Number(r.source_id) === Number(sourceId));
  if (!row) return { status: 404, body: { error: `no pending ${sourceType} #${sourceId} for this approver`, have: rows.map((r) => `${r.source_type}#${r.source_id}`) } };
  return api(token, 'POST', `/api/my-approvals/${row.id}/act`, { action, remarks });
}

// ---------------------------------------------------------------------------
at('2021-09', 'Company setup');
const SA = (await login('admin@credence.test', 'AdminPass123')).body.token;
check('Superadmin logs in', !!SA);
await step('Onboarding asks for NID and Photograph', api(SA, 'PUT', '/api/hr-ops/settings', { required_documents: 'NID\nPhotograph' }));
const proj = await step('Head Office project with a 200 m geofence', api(SA, 'POST', '/api/projects', { project_name: 'Head Office', location_lat: 23.7806, location_lng: 90.4074, location_radius: 200, location_label: 'Gulshan' }));
const projectId = proj.body.id;
for (const [from, to] of [['2021-11-01', '2023-10-31'], ['2023-11-01', '2025-10-31'], ['2025-11-01', '2026-10-31']])
  await step(`Fridays off ${from.slice(0, 4)}–${to.slice(0, 4)}`, api(SA, 'POST', '/api/holidays/bulk-weekly', { from, to, weekday: 5, applies_to: 'head_office', title: 'Weekly holiday' }));
for (const [d, t] of [['2022-05-03', 'Eid-ul-Fitr'], ['2023-04-22', 'Eid-ul-Fitr'], ['2024-04-11', 'Eid-ul-Fitr'], ['2025-03-31', 'Eid-ul-Fitr'], ['2026-03-21', 'Eid-ul-Fitr'], ['2026-12-16', 'Victory Day']])
  await step(`Holiday ${t} ${d}`, api(SA, 'POST', '/api/holidays', { entry_date: d, day_type: 'holiday', title: t, applies_to: 'head_office' }));

// People around Ruhul: an HR officer, his line manager, the IT and Finance clearance people.
const hrU = await step('HR officer account (Nasrin)', api(SA, 'POST', '/api/users', { name: 'Nasrin Sultana', email: 'nasrin.hr@credence.test', password: 'Pass12345', role: 'admin' }));
const hrId = hrU.body.id;
await step('Nasrin gets Recruitment, HR Operations, Employees, Exit, Assets', api(SA, 'PUT', `/api/users/${hrId}/module-permissions`, { modules: ['recruitment', 'hr_operations', 'employees', 'exit_offboarding', 'asset_management'] }));
await step('Nasrin can open onboarding (not approve)', api(SA, 'PUT', `/api/users/${hrId}/module-permission-layers`, { module: 'hr_operations', layers: ['read', 'onboarding_create', 'onboarding_review'] }));
const HR = (await login('nasrin.hr@credence.test', 'Pass12345')).body.token;
check('Nasrin logs in', !!HR);
const karim = await step('Line manager Karim (MIS) with a login', api(SA, 'POST', '/api/employees', { name: 'Karim Ahmed', designation: 'IT Manager', department_id: 2, joining_date: '2018-01-01', email: 'karim@credence.test', create_login: true, login_email: 'karim@credence.test', login_password: 'Pass12345' }));
const karimEmp = karim.body.id, karimUser = karim.body.user_id;
const KARIM = (await login('karim@credence.test', 'Pass12345')).body.token;
check('Karim logs in', !!KARIM);
await step('Karim (a manager) has My Targets on; Farhana does not', api(SA, 'PUT', `/api/users/${karimUser}/targets-access`, { can_view_targets: true }));
const TANVIR = (await login('tanvir.r@credence.test', 'Pass12345')).body.token;
const FARHANA = (await login('farhana.r@credence.test', 'Pass12345')).body.token;
check('Tanvir (IT) and Farhana (Finance) log in', !!TANVIR && !!FARHANA);
for (const [dep, uid] of [['IT', 132], ['Finance', 131], ['Admin', hrId], ['HR', hrId]])
  await step(`Exit clearance approver for ${dep}`, api(SA, 'PUT', `/api/exit-clearance-approvers/${dep}`, { approver_user_id: uid }));
await step('Leave: no reliever needed for Casual', api(SA, 'PUT', '/api/leave-policies/casual', { min_advance_notice_days: 0, reliever_required: false, max_consecutive_days: null, require_paid_leave_exhausted: false }));
await step('Leave: no reliever needed for Sick', api(SA, 'PUT', '/api/leave-policies/sick', { min_advance_notice_days: 0, reliever_required: false, max_consecutive_days: null, require_paid_leave_exhausted: false }));

// ---------------------------------------------------------------------------
at('2021-09', 'Hiring');
const post = await step('Job posting: Officer, MIS', api(HR, 'POST', '/api/job-postings', { title: 'Officer — MIS', department: 'MIS', designation: 'Officer', vacancy_count: 1, closing_date: '2021-10-10' }));
const cand = await step('Ruhul applies (candidate)', api(HR, 'POST', '/api/job-candidates', { posting_id: post.body.id, name: 'Ruhul Amin', email: 'ruhul.amin@credence.test', phone: '01711000111', source: 'LinkedIn' }));
await step('Shortlisted', api(HR, 'PUT', `/api/job-candidates/${cand.body.id}`, { status: 'shortlisted' }));
const iv = await step('Interview scheduled with Karim', api(HR, 'POST', '/api/candidate-interviews', { candidate_id: cand.body.id, scheduled_at: '2021-10-05 11:00:00', interviewer_id: karimUser }));
await step('Interview done, rated 4/5', api(HR, 'PUT', `/api/candidate-interviews/${iv.body.id}`, { status: 'completed', rating: 4, feedback: 'Strong SQL, good attitude' }));
await step('Offered', api(HR, 'PUT', `/api/job-candidates/${cand.body.id}`, { status: 'offered' }));
await step('Hired', api(HR, 'PUT', `/api/job-candidates/${cand.body.id}`, { status: 'hired' }));

at('2021-10', 'Onboarding');
const onb = await step('Nasrin opens Ruhul\'s onboarding (joining 1 Nov 2021)', api(HR, 'POST', '/api/hr-ops/joiner-onboarding', { candidate_id: cand.body.id, joining_date: '2021-11-01', department_id: 2 }), (r) => r.status === 201);
const ONB = (await login(onb.body.login_id, onb.body.password)).body.token;
check(`Ruhul logs in with the temporary ${onb.body.login_id} login`, !!ONB);
check('Temporary login cannot open anything else', (await api(ONB, 'GET', '/api/notices/board')).status === 403);
const me0 = await step('Ruhul sees his onboarding form', api(ONB, 'GET', '/api/onboarding/me'));
for (const d of me0.body.required_documents || []) await step(`Uploads ${d}`, api(ONB, 'POST', '/api/onboarding/me/documents', { doc_type: d, file_name: `${d}.pdf`, file_mime: 'application/pdf', file_base64: await mkPdf(d) }));
const early = await api(ONB, 'POST', '/api/onboarding/me/submit', { personal: {} });
check('Submitting an empty form is refused with what is missing', early.status === 400 && Array.isArray(early.body.missing), J(early));
const personal = { gender: 'Male', date_of_birth: '1996-03-14', nid_ssn: '1996123456789', mobile: '01711000111', present_address: 'Mirpur 10, Dhaka', permanent_address: 'Bogura Sadar, Bogura', personal_email: 'ruhul.amin@credence.test', blood_group: 'B+', marital_status: 'Single', religion: 'Islam' };
await step('Saves a draft', api(ONB, 'PUT', '/api/onboarding/me', { personal, contacts: [{ name: 'Abdul Amin', relation: 'Father', phone: '01811000222' }], nominees: [{ name: 'Rokeya Begum', relation: 'Mother', phone: '01911000333', nominee_percent: 100 }] }));
await step('Submits the onboarding form', api(ONB, 'POST', '/api/onboarding/me/submit', { personal, contacts: [{ name: 'Abdul Amin', relation: 'Father', phone: '01811000222' }], nominees: [{ name: 'Rokeya Begum', relation: 'Mother', phone: '01911000333', nominee_percent: 100 }] }));
check('Nasrin (who opened it) cannot approve it', (await api(HR, 'POST', `/api/hr-ops/joiner-onboarding/${onb.body.id}/approve`)).status === 403);
const appr = await step('HR head approves: Ruhul becomes an Employee', api(SA, 'POST', `/api/hr-ops/joiner-onboarding/${onb.body.id}/approve`));
const empId = Number(appr.body.employee_id), empCode = appr.body.employee_code;
const ruhulUser = Number(sql(`SELECT user_id FROM all_employees WHERE id=${empId}`));
check(`Employee ${empCode} linked to his login`, ruhulUser > 0);
check('Temporary login session ended', (await api(ONB, 'GET', '/api/onboarding/me')).status === 401);

at('2021-11', 'First day');
let L = await login(empCode, onb.body.password);
check(`Ruhul logs in with his employee code ${empCode}`, L.status === 200, J(L));
check('He is asked to change his password', L.body.user?.must_change_password == 1 || L.body.user?.must_change_password === true, JSON.stringify(L.body.user || {}).slice(0, 200));
let R = L.body.token;
await step('Changes his password', api(R, 'PUT', '/api/profile/password', { current_password: onb.body.password, new_password: 'Ruhul@2021' }));
L = await login('ruhul.amin@credence.test', 'Ruhul@2021');
check('Logs in with his email and new password', L.status === 200, J(L));
R = L.body.token;

// All Self Service switches on.
const SWITCHES = [['leave-application-access', 'can_view_leave_application'], ['movement-claim-access', 'can_view_movement_claims'], ['conveyance-claim-access', 'can_view_conveyance_claims'], ['timesheet-access', 'can_view_timesheet'], ['tasks-access', 'can_view_tasks'], ['mobile-bill-access', 'can_view_mobile_bill'], ['service-book-access', 'can_view_service_book'], ['loan-request-access', 'can_view_loan_request'], ['targets-access', 'can_view_targets'], ['mail-access', 'can_use_mail'], ['sign-documents-access', 'can_sign_documents'], ['roster-access', 'can_view_roster'], ['calls-access', 'can_use_calls'], ['payslip-access', 'can_view_payslip']];
for (const [route, col] of SWITCHES) await step(`Switch on ${col}`, api(SA, 'PUT', `/api/users/${ruhulUser}/${route}`, { [col]: true }));
await step('Switch on attendance, tracking, leave summary; pinned to Head Office', api(SA, 'PUT', `/api/users/${ruhulUser}/feature-permissions`, { can_use_attendance: true, can_use_tracking: true, can_view_leave_summary: true, attendance_project_id: projectId }));
const me = await step('Ruhul\'s session shows the switches', api(R, 'GET', '/api/auth/me'));
const meU = me.body.user || me.body;
const off = SWITCHES.map(([, c]) => c).concat(['can_use_attendance', 'can_view_leave_summary', 'can_view_my_leave']).filter((c) => !(meU[c] === true || meU[c] === 1));
check('Every Self Service switch is on for Ruhul', off.length === 0, 'off: ' + off.join(','));

// Joining paperwork.
await step('Direct supervisor: Karim', api(SA, 'POST', `/api/employees/${empId}/supervisors`, { supervisor_id: karimEmp, effective_date: '2021-11-01', is_direct: true }), (r) => r.status === 201);
const appt = await step('Appointment letter issued', api(SA, 'POST', '/api/hr-ops/letters', { employee_id: empId, letter_type: 'appointment', letter_date: '2021-11-01' }));
const myL = await step('Ruhul sees it under My Letters', api(R, 'GET', '/api/hr-ops/my/letters'));
check('Appointment letter is in his list', (myL.body.letters || []).some((l) => l.id === appt.body.id));
await step('Ruhul acknowledges the appointment letter', api(R, 'POST', `/api/hr-ops/my/letters/${appt.body.id}/acknowledge`, { note: 'Received with thanks' }));
const chk = await step('Onboarding checklist started', api(SA, 'GET', `/api/hr-ops/onboarding/${empId}`));
const items = chk.body.items || chk.body || [];
let done = 0;
for (const it of (Array.isArray(items) ? items : []).filter((i) => i.status === 'pending')) if (ok2(await api(SA, 'PUT', `/api/hr-ops/onboarding/items/${it.id}`, { status: 'done', note: 'Done on joining' }))) done++;
check(`Checklist items ticked (${done})`, done > 0, JSON.stringify(chk.body).slice(0, 200));
const svc = (await api(SA, 'GET', '/api/hr-ops/employees')).body;
const svcRow = (Array.isArray(svc) ? svc : svc.employees || svc.rows || []).find((e) => Number(e.id) === empId || Number(e.employee_id) === empId);
check('On 6-month probation until 2022-05-01', String(svcRow?.probation_end_date || '').startsWith('2022-05-01') && svcRow?.service_status === 'probation', JSON.stringify(svcRow || svc).slice(0, 300));
await step('Salary structure: gross 35,000 (tax 300, PF 1,050)', api(SA, 'POST', '/api/payroll/salary-structures', { employee_id: empId, effective_date: '2021-11-01', basic_salary: 21000, house_rent: 10500, medical_allowance: 2100, conveyance_allowance: 1400, tax_deduction: 300, pf_deduction: 1050 }));
await step('Office attendance device PIN 501', api(SA, 'PUT', `/api/employees/${empId}/zk-pin`, { zk_device_pin: '501' }));
await step('Bank account for salary', api(SA, 'POST', `/api/employees/${empId}/payment-accounts`, { method: 'bank', bank_name: 'Dutch-Bangla Bank', account_name: 'Ruhul Amin', account_number: '1011100223344', branch_name: 'Mirpur', is_primary: true }), (r) => r.status < 300 || r.status === 400);

await step('Leave for Nov–Dec 2021 (pro rata): CL 2, SL 2', api(SA, 'PUT', `/api/leave-balances/${ruhulUser}`, { casual_leave: 2, sick_leave: 2, leave_without_pay: 0 }));
// Laptop through an asset requisition.
const req1 = await step('Ruhul requests a laptop', api(R, 'POST', '/api/assets/requisitions', { items: [{ item_name: 'Laptop', purpose: 'Daily work', unit: 'pcs', quantity: 1 }], urgency: 'high', target_date: '2026-10-30' }));
const a1 = await approveAs(KARIM, 'asset_requisition', req1.body.id);
check('Karim approves the laptop', ok2(a1) || a1.status === 404, J(a1));
await step('IT hands over the laptop', api(SA, 'POST', `/api/assets/requisitions/${req1.body.id}/fulfill`, { items: [{ item_name: 'Laptop', quantity: 1, unit: 'pcs', asset_tag: 'CHL-LT-0451', serial_number: 'PF3K9X2', requested_index: 0 }], condition_on_assign: 'new' }));
const myA = await step('Ruhul sees the laptop in My Assets', api(R, 'GET', '/api/assets/my'));
const asg = (Array.isArray(myA.body) ? myA.body : myA.body.assignments || myA.body.items || [])[0];
check('Laptop assigned to him', !!asg, JSON.stringify(myA.body).slice(0, 200));
const assignmentId = asg?.assignment_id || asg?.id;
await step('Ruhul acknowledges receiving it', api(R, 'POST', `/api/assets/assignments/${assignmentId}/acknowledge`, {}));

// Employment contract to sign.
const contract = await step('Employment contract uploaded for signing', api(SA, 'POST', '/api/employee-documents', { user_id: ruhulUser, doc_type: 'Employment Contract', file_name: 'contract.pdf', file_mimetype: 'application/pdf', file_base64: await mkPdf('Employment Contract — Ruhul Amin') }));
await step('Sent to Ruhul for e-signature', api(SA, 'POST', `/api/esign/documents/${contract.body.id}/request`, { signers: [{ user_id: ruhulUser, label: 'Employee' }] }));
await step('Ruhul signs it', api(R, 'POST', `/api/esign/documents/${contract.body.id}/sign`, { signed_name: 'Ruhul Amin', image: await sigPng('ruhul'), agree: true }));
const docs = await step('Contract shows as signed in his documents', api(R, 'GET', '/api/employee-documents'));
check('Contract status completed', (Array.isArray(docs.body) ? docs.body : docs.body.documents || []).some((d) => d.id === contract.body.id && d.sign_status === 'completed'), JSON.stringify(docs.body).slice(0, 300));
await step('Welcome notice to everyone', api(SA, 'POST', '/api/notices', { title: 'Welcome Ruhul Amin to MIS', content_html: '<p>Please welcome Ruhul.</p>', target_type: 'all', is_active: true }));
const board = await step('Ruhul reads the notice board', api(R, 'GET', '/api/notices/board'));
check('Welcome notice on his board', JSON.stringify(board.body).includes('Welcome Ruhul'));

// What Ruhul can and cannot open.
at('2021-11', 'Permissions');
const SELF = ['/api/my-payslips', '/api/leave-balances/mine', '/api/leave-applications/mine', '/api/attendance/mine', '/api/attendance/my-projects', '/api/my-loans', '/api/mobile-bill/my', '/api/tasks/mine', '/api/targets/mine', '/api/my-roster', '/api/hr-ops/my/service-book', '/api/hr-ops/my/p360', '/api/hr-ops/my/letters', '/api/my-cases', '/api/assets/my', '/api/employee-documents', '/api/esign/my', '/api/bill-claim-policy/mine', '/api/employee-directory', '/api/exit-requests', '/api/holidays?from=2021-11-01&to=2021-12-31', '/api/notices/board'];
const selfFail = [];
for (const p of SELF) { const r = await api(R, 'GET', p); if (!ok2(r)) selfFail.push(`${p} ${r.status}`); }
check(`Ruhul opens all ${SELF.length} Self Service pages`, selfFail.length === 0, selfFail.join(', '));
const PLAIN = (await login('plain.r@credence.test', 'Pass12345')).body.token;
const gated = ['/api/my-payslips', '/api/attendance/mine', '/api/my-loans', '/api/mobile-bill/my', '/api/tasks/mine', '/api/my-roster', '/api/hr-ops/my/p360', '/api/esign/my'];
const leaks = [];
for (const p of gated) { const r = await api(PLAIN, 'GET', p); if (ok2(r)) leaks.push(p); }
check('An account with the switches off is refused those pages', leaks.length === 0, 'open: ' + leaks.join(', '));
const ADMIN = ['/api/employees', '/api/payroll?month_year=2021-11', '/api/exit-requests/pending', '/api/hr-analytics/summary', '/api/users', '/api/job-postings', '/api/hr-ops/employees', '/api/performance-cycles'];
const adminLeaks = [];
for (const p of ADMIN) { const r = await api(R, 'GET', p); if (ok2(r)) adminLeaks.push(p); }
check('Ruhul cannot open Admin Panel data', adminLeaks.length === 0, 'open: ' + adminLeaks.join(', '));

// ---------------------------------------------------------------------------
// Month by month.
const eid = new Set(['2022-05', '2022-07', '2023-04', '2023-06', '2024-04', '2024-06', '2025-03', '2025-06', '2026-03', '2026-05']);
const leavePlan = { '03': ['casual', 2], '08': ['sick', 3], '12': ['casual', 1] };
let loans = []; // { id, total, inst, paid }
let leaveDaysByMonth = {};
let sup = KARIM, supName = 'Karim';
let simId = null;
let deptName = 'MIS';
const payroll = [];
const year = (ym) => ym.slice(0, 4);

for (const ym of months) {
  const [y, mm] = ym.split('-');
  at(ym, `Year ${Number(y) - 2021 + (Number(mm) >= 11 ? 1 : 0)}`.replace('Year 0', 'Year 1'));

  // January: new leave year, appraisal of last year, increment.
  if (mm === '01') {
    await step(`New leave year ${y}: CL 10, SL 14`, api(SA, 'PUT', `/api/leave-balances/${ruhulUser}`, { casual_leave: 10, sick_leave: 14, leave_without_pay: 0 }));
    if (Number(y) >= 2023) {
      const cyc = await step(`Appraisal cycle ${Number(y) - 1}`, api(SA, 'POST', '/api/performance-cycles', { name: `Annual Appraisal ${Number(y) - 1}`, period_start: `${Number(y) - 1}-01-01`, period_end: `${Number(y) - 1}-12-31` }));
      await api(SA, 'PUT', `/api/performance-cycles/${cyc.body.id}`, { status: 'active' });
      const g = await step('Goal: keep MIS reports on time', api(SA, 'POST', '/api/performance-goals', { cycle_id: cyc.body.id, user_id: ruhulUser, title: 'Monthly MIS reports on time', weight: 60 }));
      await api(SA, 'PUT', `/api/performance-goals/${g.body.id}`, { manager_rating: 4, status: 'completed' });
      const rv = await step('Review created', api(SA, 'POST', '/api/performance-reviews', { cycle_id: cyc.body.id, user_id: ruhulUser, reviewer_id: karimUser }));
      await step(`Review submitted (rating ${y === '2025' ? 3.5 : 4.2})`, api(SA, 'PUT', `/api/performance-reviews/${rv.body.id}`, { overall_rating: y === '2025' ? 3.5 : 4.2, strengths: 'Reliable, quick learner', improvements: 'Presentation skills', submit: true }));
      const perf = await api(R, 'GET', '/api/hr-ops/my/p360/section/performance');
      check('Ruhul can read his appraisal', ok2(perf) && JSON.stringify(perf.body).includes(`Annual Appraisal ${Number(y) - 1}`), J(perf));
      const gross = { 2023: 38000, 2024: 41000, 2025: 47000, 2026: 52000 }[y];
      const inc = await step(`Annual increment to ${gross}`, api(SA, 'POST', '/api/hr-ops/actions', { employee_id: empId, action_type: 'increment', effective_date: `${y}-01-01`, to: { gross_salary: gross }, reason: 'Annual increment' }));
      check('Increment approved at once (no approval chain)', inc.body.status === 'approved', J(inc));
      await step('Increment letter', api(SA, 'POST', '/api/hr-ops/letters', { employee_id: empId, hr_action_id: inc.body.id }));
    }
  }

  if (ym === '2022-05') {
    const c = await step('Probation over: confirmation', api(SA, 'POST', '/api/hr-ops/actions', { employee_id: empId, action_type: 'confirmation', effective_date: '2022-05-01', reason: 'Probation completed' }));
    await step('Confirmation letter', api(SA, 'POST', '/api/hr-ops/letters', { employee_id: empId, hr_action_id: c.body.id }));
    const s = (await api(SA, 'GET', '/api/hr-ops/employees')).body;
    const row = (Array.isArray(s) ? s : s.employees || s.rows || []).find((e) => Number(e.id) === empId || Number(e.employee_id) === empId);
    check('Service status is confirmed', row?.service_status === 'confirmed', JSON.stringify(row).slice(0, 200));
    check('Job base became Permanent', sql(`SELECT job_base FROM all_employees WHERE id=${empId}`) === 'Permanent');
  }
  if (ym === '2022-01') {
    const sim = await step('Company SIM issued (limit 500)', api(SA, 'POST', '/api/mobile-bill/sims', { phone_number: '01713000555', operator: 'GP', employee_id: empId, limit_source: 'custom', limit_amount: 500, issued_on: '2022-01-01' }), (r) => r.status === 201);
    simId = sim.body.id;
  }
  if (simId && ym >= '2022-01' && ym <= '2026-09') {
    const r = await api(SA, 'PUT', '/api/mobile-bill/bills', { month: ym, sim_id: simId, amount: 300 + (Number(mm) * 37) % 300 });
    if (!ok2(r)) check(`Mobile bill ${ym}`, false, J(r));
  }
  if (mm === '02' && Number(y) >= 2022) {
    const t = await step(`Ruhul sets his ${y} targets`, api(R, 'POST', '/api/targets', { period_type: 'yearly', period: y, deadline: `${y}-12-31`, title: `MIS targets ${y}`, tasks: [{ title: 'Automate monthly reports', weight: 50 }, { title: 'Train 2 colleagues on dashboards', weight: 50 }] }), (r) => r.status === 201);
    const tid = t.body.created?.[0]?.id;
    const sh = await step('Shares them with the manager', api(R, 'POST', `/api/targets/${tid}/share`, {}));
    const shStatus = sql(`SELECT status FROM targets WHERE id=${tid}`);
    if (sup === KARIM) {
      check('Waiting for Karim\'s approval', shStatus === 'pending', shStatus);
      await step('Karim approves the targets', api(sup, 'POST', `/api/targets/${tid}/approve`, {}));
    } else {
      // Farhana (new direct supervisor) has My Targets off, and Karim is no longer his supervisor.
      check('Farhana has My Targets off, so the targets start at once instead of waiting for nobody', shStatus === 'active', shStatus);
      check('Old manager Karim can no longer open Ruhul\'s targets', (await api(KARIM, 'GET', `/api/targets/${tid}`)).status === 403);
      check('Karim got no alert for it', !JSON.stringify((await api(KARIM, 'GET', '/api/alerts')).body).includes(`MIS targets ${y}`));
    }
    const tg = await api(R, 'GET', `/api/targets/${tid}`);
    const tasks = tg.body.tasks || tg.body.target?.tasks || [];
    let upd = 0;
    for (const tk of tasks) if (ok2(await api(R, 'POST', `/api/target-tasks/${tk.id}/update`, { progress: 100, status: 'completed', note: 'Done' }))) upd++;
    check('Ruhul marks both target tasks completed', upd === 2, J(tg));
  }
  const lp = leavePlan[mm];
  if (lp && ym < '2026-10' && ym > '2021-11') {
    const [type, days] = lp;
    const start = `${ym}-1${mm === '12' ? 4 : 0}`, end = `${ym}-${pad(Number(start.slice(8)) + days - 1)}`;
    const la = await step(`Ruhul applies for ${days} day(s) ${type} leave ${start}`, api(R, 'POST', '/api/leave-applications', { leave_type: type, start_date: start, end_date: end, purpose: type === 'sick' ? 'Fever' : 'Family program' }));
    const reject = ym === '2024-12';
    const d = await approveAs(sup, 'leave_application', la.body.id, reject ? 'rejected' : 'approved', reject ? 'Year-end closing, please re-plan' : 'Approved');
    check(`${supName} ${reject ? 'rejects' : 'approves'} it`, ok2(d), J(d));
    const st = sql(`SELECT status FROM leave_applications WHERE id=${la.body.id}`);
    check(`Leave is ${reject ? 'rejected' : 'approved'}`, st === (reject ? 'rejected' : 'approved'), st);
    if (!reject) leaveDaysByMonth[ym] = days;
  }
  if (ym === '2022-06') {
    await step('HR asks Ruhul to update his nominee', api(SA, 'POST', '/api/hr-ops/info-requests', { employee_ids: [empId], items: [{ item_type: 'nominee' }], note: 'Please add your nominee details', due_date: '2026-11-30' }));
    const ir = await api(R, 'GET', '/api/hr-ops/my/info-requests');
    const req = (Array.isArray(ir.body) ? ir.body : ir.body.requests || ir.body.items || []).find((x) => x.item_type === 'nominee' && x.status !== 'approved');
    check('Ruhul sees the request', !!req, J(ir));
    if (req) {
      await step('Ruhul submits his nominees', api(R, 'POST', `/api/hr-ops/my/info-requests/${req.id}/submit`, { people: [{ name: 'Rokeya Begum', relation: 'Mother', phone: '01911000333', nominee_percent: 60 }, { name: 'Abdul Amin', relation: 'Father', phone: '01811000222', nominee_percent: 40 }] }));
      await step('HR approves the nominee update', api(SA, 'POST', `/api/hr-ops/info-requests/${req.id}/review`, { decision: 'approved' }));
    }
  }
  if (ym === '2022-09') {
    const g = await step('Ruhul raises a grievance (overtime not counted)', api(R, 'POST', '/api/grievances', { description: 'My weekend overtime in August was not counted.', category: 'Compensation' }), (r) => r.status === 201);
    await step('HR investigates', api(SA, 'PUT', `/api/grievances/${g.body.id}`, { status: 'investigating', assigned_to: hrId }));
    await step('HR resolves it', api(SA, 'PUT', `/api/grievances/${g.body.id}`, { status: 'resolved', resolution_notes: 'Overtime added to September salary.' }));
    const mc = await api(R, 'GET', '/api/my-cases');
    check('Ruhul sees it resolved', JSON.stringify(mc.body).includes('resolved'), J(mc));
  }
  if (ym === '2023-03' || ym === '2026-06') {
    const [total, n] = ym === '2023-03' ? [60000, 12] : [30000, 6];
    const lr = await step(`Ruhul requests a loan of ${total} over ${n} months`, api(R, 'POST', '/api/my-loans/requests', { kind: 'loan', total_amount: total, installments: n, reason: ym === '2023-03' ? 'Sister\'s wedding' : 'Medical' }), (r) => r.status === 201);
    const a = await approveAs(sup, 'advance_request', lr.body.id);
    check(`${supName} recommends the loan`, ok2(a) || a.status === 404, J(a));
    const d = await step('Payroll approves the loan', api(SA, 'POST', `/api/payroll/advance-requests/${lr.body.id}/decision`, { action: 'approve', remarks: 'OK' }));
    if (d.body?.advance_id) loans.push({ id: d.body.advance_id, total, inst: Math.ceil(total / n), paid: 0 });
    const my = await api(R, 'GET', '/api/my-loans');
    check('Ruhul sees the running loan', (my.body.loans || []).some((x) => Number(x.id) === Number(d.body?.advance_id)), J(my));
  }
  if (ym === '2023-07') {
    const lr = await step('Ruhul asks for a salary certificate (bank loan)', api(R, 'POST', '/api/hr-ops/my/letter-requests', { letter_type: 'salary_certificate', purpose: 'Home loan application' }));
    const iss = await step('HR issues it', api(SA, 'POST', `/api/hr-ops/letter-requests/${lr.body.id}/decision`, { decision: 'approved' }));
    const myl = await api(R, 'GET', '/api/hr-ops/my/letters');
    check('Salary certificate in his letters', (myl.body.letters || []).some((l) => l.ref_no === iss.body.ref_no), J(myl));
  }
  if (ym === '2024-07') {
    const p = await step('Promotion to Senior Officer, gross 45,000', api(SA, 'POST', '/api/hr-ops/actions', { employee_id: empId, action_type: 'promotion', effective_date: '2024-07-01', to: { designation: 'Senior Officer', gross_salary: 45000 }, reason: 'Excellent performance' }));
    await step('Promotion letter', api(SA, 'POST', '/api/hr-ops/letters', { employee_id: empId, hr_action_id: p.body.id }));
    check('Designation is now Senior Officer', sql(`SELECT designation FROM all_employees WHERE id=${empId}`) === 'Senior Officer');
  }
  if (ym === '2024-11') {
    const w = await step('Written warning: repeated late arrival', api(SA, 'POST', '/api/disciplinary-actions', { user_id: ruhulUser, action_type: 'written_warning', reason: 'Late arrival on 9 days in October 2024', document_text: 'You are warned to be punctual.' }), (r) => r.status === 201);
    await step('Ruhul replies', api(R, 'POST', `/api/disciplinary-actions/${w.body.id}/feedback`, { message: 'Road works near Mirpur; I will start earlier.' }));
    await step('Ruhul acknowledges the warning', api(R, 'PUT', `/api/disciplinary-actions/${w.body.id}`, { acknowledge: true }));
    await step('HR closes the case', api(SA, 'PUT', `/api/disciplinary-actions/${w.body.id}`, { status: 'closed' }));
  }
  if (ym === '2025-04') {
    const t = await step('Transfer to Finance (BI team), reporting to Farhana', api(SA, 'POST', '/api/hr-ops/actions', { employee_id: empId, action_type: 'transfer', effective_date: '2025-04-01', to: { department_id: 1, supervisor_id: 36 }, reason: 'New BI team' }));
    await step('Transfer letter', api(SA, 'POST', '/api/hr-ops/letters', { employee_id: empId, hr_action_id: t.body.id }));
    const dep = sql(`SELECT department FROM all_employees WHERE id=${empId}`);
    check('Department is now Finance', dep === 'Finance', dep);
    const sups = sql(`SELECT GROUP_CONCAT(CONCAT(supervisor_id, ':', is_direct)) FROM employee_supervisors WHERE employee_id=${empId}`);
    check('Farhana is now his only supervisor (Karim removed, kept in the transfer history)', sups === '36:1' && sql(`SELECT from_supervisor_id FROM employee_transfers WHERE employee_id=${empId} ORDER BY id DESC LIMIT 1`) === String(karimEmp), sups);
    sup = FARHANA; supName = 'Farhana'; deptName = 'Finance';
  }
  if (ym === '2025-08') {
    await step('Ruhul updates his address and photo', api(R, 'PUT', '/api/profile/personal-data', { first_name: 'Ruhul', last_name: 'Amin', date_of_birth: '1996-03-14', country: 'Bangladesh', state: 'Dhaka', city: 'Dhaka', full_address: 'Uttara Sector 7, Dhaka' }));
    await step('Married: info request for spouse as emergency contact', api(SA, 'POST', '/api/hr-ops/info-requests', { employee_ids: [empId], items: [{ item_type: 'emergency_contact' }], note: 'Add your spouse' }));
    const ir = await api(R, 'GET', '/api/hr-ops/my/info-requests');
    const req = (Array.isArray(ir.body) ? ir.body : ir.body.requests || ir.body.items || []).find((x) => x.item_type === 'emergency_contact' && x.status === 'pending');
    if (req) {
      await step('Ruhul adds his wife as emergency contact', api(R, 'POST', `/api/hr-ops/my/info-requests/${req.id}/submit`, { people: [{ name: 'Sadia Islam', relation: 'Wife', phone: '01611000444' }] }));
      await step('HR approves', api(SA, 'POST', `/api/hr-ops/info-requests/${req.id}/review`, { decision: 'approved' }));
    } else check('Emergency contact request reaches Ruhul', false, J(ir));
  }

  // Payroll for this month.
  if (ym <= '2026-10') {
    const struct = (await api(SA, 'GET', `/api/payroll/salary-structures?employee_id=${empId}`)).body;
    const cur = (Array.isArray(struct) ? struct : []).filter((s) => String(s.effective_date).slice(0, 10) <= lastDay(ym)).sort((a, b) => String(b.effective_date).localeCompare(String(a.effective_date)))[0];
    const gross = Number(cur?.gross_salary || 0);
    const final = ym === '2026-10';
    const wd = 26, leave = leaveDaysByMonth[ym] || 0, absent = final ? 13 : 0;
    const bonus = eid.has(ym) ? Number(cur?.basic_salary || 0) : 0;
    const g = await api(SA, 'POST', '/api/payroll/generate', { employee_id: empId, month_year: ym, total_working_days: wd, present_days: wd - leave - absent, leave_days: leave, absent_days: absent, bonus_amount: bonus, remarks: final ? 'Final month (1–15 Oct)' : '' });
    if (!ok2(g)) { check(`Payroll ${ym} generated`, false, J(g)); continue; }
    if (ym === months[0]) {
      const draft = await api(R, 'GET', '/api/my-payslips');
      check('A payroll run not yet approved is not shown in My Payslip', ok2(draft) && draft.body.payslips.length === 0, J(draft));
      check('Nor can it be opened by id', (await api(R, 'GET', `/api/my-payslips/${g.body.id}`)).status === 404);
    }
    const expLoan = loans.reduce((s, l) => s + Math.min(l.inst, l.total - l.paid), 0);
    const row = (await api(SA, 'GET', `/api/payroll/${g.body.id}`)).body;
    const absentDed = Math.round((gross / wd) * absent * 100) / 100;
    const exp = gross + bonus - Number(cur.tax_deduction) - Number(cur.pf_deduction) - expLoan - absentDed;
    const net = Number(row.net_salary);
    const sub = await api(SA, 'POST', `/api/payroll/approval/${ym}/submit`, {});
    const apv = await api(SA, 'POST', `/api/payroll/approval/${ym}/approve`, {});
    const pay = await api(SA, 'POST', `/api/payroll/approval/${ym}/pay`, { payment_date: final ? '2026-10-16' : `${lastDay(ym)}`, payment_method: 'Bank Transfer', payment_reference: `SAL-${ym}` });
    const allOk = ok2(sub) && ok2(apv) && ok2(pay) && Math.abs(net - exp) < 1 && Number(row.advance_deduction || 0) === expLoan;
    payroll.push({ ym, gross, bonus, loan: expLoan, net, exp });
    for (const l of loans) l.paid += Math.min(l.inst, l.total - l.paid);
    loans = loans.filter((l) => l.paid < l.total || (rec('PASS', `Loan #${l.id} fully repaid`), false));
    if (!allOk || bonus || expLoan || ym === months[0] || mm === '01' || final)
      check(`Salary ${ym}: gross ${gross}${bonus ? ` + Eid bonus ${bonus}` : ''}${expLoan ? ` − loan ${expLoan}` : ''}${absent ? ` − ${absent} days` : ''} → net ${net} paid`, allOk, `expected net ${exp}, advance ${row.advance_deduction}; ${J(sub)} ${J(apv)} ${J(pay)}`);
  }
}

// ---------------------------------------------------------------------------
at('2026-10', 'Last month: daily work');
const salAlerts = await api(R, 'GET', '/api/alerts');
check('Ruhul got "Salary Paid" alerts', JSON.stringify(salAlerts.body).includes('Salary'), J(salAlerts));
const mps = await step('Ruhul opens My Payslip', api(R, 'GET', '/api/my-payslips'));
check(`All ${payroll.length} paid months are there, newest first`, mps.body.payslips.length === payroll.length && mps.body.payslips[0].month_year === '2026-10', `${mps.body.payslips.length} / ${mps.body.payslips[0]?.month_year}`);
const eidSlip = mps.body.payslips.find((p) => p.month_year === '2024-04');
const eidD = await step('Opens April 2024 (Eid month)', api(R, 'GET', `/api/my-payslips/${eidSlip?.id}`));
const eidP = payroll.find((p) => p.ym === '2024-04');
check('It shows the Eid bonus and the net that was paid', Number(eidD.body.bonus_amount) === eidP.bonus && Number(eidD.body.net_salary) === eidP.net, J(eidD));
check('Payroll\'s own fields (who approved, hold notes) are not sent', eidD.body.generated_by === undefined && eidD.body.hold_reason === undefined);
const loanSlip = await api(R, 'GET', `/api/my-payslips/${mps.body.payslips.find((p) => p.month_year === '2023-05')?.id}`);
check('May 2023 payslip shows the loan installment', Number(loanSlip.body.advance_deduction) === 5000, J(loanSlip));
check('Karim cannot open Ruhul\'s payslip', [403, 404].includes((await api(KARIM, 'GET', `/api/my-payslips/${eidSlip?.id}`)).status));
await step('Karim gets My Payslip (no payroll of his own yet)', api(SA, 'PUT', `/api/users/${karimUser}/payslip-access`, { can_view_payslip: true }));
check('…and still cannot open Ruhul\'s', (await api(KARIM, 'GET', `/api/my-payslips/${eidSlip?.id}`)).status === 404);
check('Karim\'s own list is empty', ((await api(KARIM, 'GET', '/api/my-payslips')).body.payslips || []).length === 0);
const ci = await api(R, 'POST', '/api/attendance/check-in', { project_id: projectId, latitude: 23.78065, longitude: 90.40745, remarks: 'Morning' });
check('Checks in at Head Office (inside the geofence)', ok2(ci), J(ci));
const far = await api(R, 'POST', '/api/attendance/check-out', { project_id: projectId, latitude: 23.81, longitude: 90.41 });
check('Check-out from 3 km away is refused', far.status === 403, J(far));
await step('Checks out at the office', api(R, 'POST', '/api/attendance/check-out', { project_id: projectId, latitude: 23.78061, longitude: 90.40741 }));
const corr = await step('Forgot to check in on 14 Oct: attendance correction', api(R, 'POST', '/api/attendance/corrections', { project_id: projectId, attendance_date: '2026-10-14', check_in_at: '2026-10-14 09:02:00', check_out_at: '2026-10-14 18:05:00', remarks: 'Phone battery died' }), (r) => r.status === 201);
const ca = await approveAs(sup, 'attendance_correction', corr.body.id);
check(`${supName} approves the correction`, ok2(ca) || sql(`SELECT status FROM attendance_corrections WHERE id=${corr.body.id}`) === 'approved', J(ca));
const ts = await step('Timesheet shows 14 Oct and today', api(R, 'GET', '/api/attendance/mine'));
const tsRows = Array.isArray(ts.body) ? ts.body : ts.body.rows || [];
check('14 Oct present in his timesheet', tsRows.some((x) => String(x.attendance_date).startsWith('2026-10-14')), JSON.stringify(tsRows.slice(0, 3)));
const shift = await step('HR creates a Day shift', api(SA, 'POST', '/api/roster/shifts', { name: 'Day', code: 'D', start_time: '09:00', end_time: '18:00', grace_minutes: 10 }));
await step('Roster: Ruhul on Day shift 1–15 Oct, off on 10 Oct', api(SA, 'PUT', '/api/roster/cells', { cells: Array.from({ length: 15 }, (_, i) => ({ employee_id: empId, date: `2026-10-${pad(i + 1)}`, shift_id: i === 9 ? null : shift.body.id, is_off: i === 9 })) }));
const myR = await step('Ruhul sees his roster', api(R, 'GET', '/api/my-roster?from=2026-10-01&to=2026-10-31'));
check('Roster shows 14 duty days and 1 off day', (myR.body.days || []).filter((d) => d.shift).length === 14 && (myR.body.days || []).filter((d) => d.is_off).length === 1, JSON.stringify(myR.body).slice(0, 200));
const task = await step('HR assigns a task: hand over BI dashboards', api(SA, 'POST', '/api/tasks', { title: 'Hand over BI dashboards', description: 'Document and hand over before leaving', priority: 'high', category: 'document', due_date: '2026-10-15', assignee_ids: [ruhulUser] }));
const taskId = task.body.id || task.body.task?.id;
await step('Ruhul starts the task', api(R, 'POST', `/api/tasks/${taskId}/start`, {}));
await step('Ruhul submits it', api(R, 'POST', `/api/tasks/${taskId}/submit`, { note: 'Handover document in the shared drive' }));
const cats = (await api(R, 'GET', '/api/bill-claim-categories')).body;
const cat = (Array.isArray(cats) ? cats : cats.categories || [])[0];
const mv = await step('Movement: client visit check-in', api(R, 'POST', '/api/claims/check-in', { purpose: 'Client visit — Motijheel', latitude: 23.7330, longitude: 90.4172 }));
await step('Movement: check-out', api(R, 'POST', `/api/claims/${mv.body.id}/check-out`, { latitude: 23.7806, longitude: 90.4074 }));
if (cat) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
  const cl = await step(`Conveyance claim for today (${cat.name || cat.label})`, api(R, 'POST', '/api/user-claims', { from_date: today, to_date: today, items: [{ category_id: cat.id, bill_date: today, amount: 350, description: 'CNG to Motijheel and back' }], description: 'Client visit' }), (r) => r.status === 201);
  const cla = await approveAs(sup, 'user_claim', cl.body.id);
  check(`${supName} approves the claim (or it auto-approves)`, ok2(cla) || cla.status === 404, J(cla));
} else gap('Conveyance claim', 'No bill claim categories are set up, so a claim cannot be filed.');
const veh = await step('HR registers a pool car', api(SA, 'POST', '/api/vehicles', { vehicle_no: 'DHA-GA-11-2233', model: 'Toyota Axio', vehicle_type: 'car' }), (r) => r.status === 201 || r.status === 200);
const tmr = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
const vr = await step('Ruhul books a car for tomorrow (bank visit)', api(R, 'POST', '/api/vehicles/requisitions', { purpose: 'Bank visit for final documents', pickup_location: 'Head Office', destination: 'Motijheel', ride_date: tmr, start_time: '10:00', estimated_duration_hours: 2 }), (r) => r.status === 201);
const va = await approveAs(sup, 'vehicle_requisition', vr.body.id);
check(`${supName} approves the car`, ok2(va) || va.status === 404, J(va));
await step('Car assigned', api(SA, 'PUT', `/api/vehicles/requisitions/${vr.body.id}/assign`, { vehicle_id: veh.body.id, driver_user_id: 1 }));
const msim = await api(R, 'GET', '/api/mobile-bill/my');
check('Ruhul sees his SIM and recent bills', ok2(msim) && JSON.stringify(msim.body).includes('01713000555'), J(msim));
const bal = await api(R, 'GET', '/api/leave-balances/mine');
check('Ruhul sees his leave balance', ok2(bal), J(bal));
const sb = await api(R, 'GET', '/api/hr-ops/my/service-book');
const sbs = JSON.stringify(sb.body);
check('Service book lists promotion, transfer and increments', ok2(sb) && sbs.includes('Senior Officer') && /Finance/.test(sbs), sbs.slice(0, 300));

// ---------------------------------------------------------------------------
at('2026-09', 'Exit');
const ex = await step('Ruhul resigns (notice 15 Sep, last day 15 Oct)', api(R, 'POST', '/api/exit-requests', { reason: 'Higher studies abroad', notice_date: '2026-09-15', last_working_day: '2026-10-15' }), (r) => r.status === 201);
const exitId = ex.body.id;
check('Four clearance items opened (IT, Finance, Admin, HR)', (ex.body.clearance_items || []).length === 4, J(ex));
const dup = await api(R, 'POST', '/api/exit-requests', { reason: 'again' });
check('A second resignation while one is open is refused', dup.status === 409, J(dup));
if (ok2(dup)) await api(SA, 'PUT', `/api/exit-requests/${dup.body.id}/status`, { status: 'cancelled' });
const others = await api(R, 'POST', '/api/exit-requests', { user_id: karimUser, reason: 'x' });
check('Ruhul cannot file an exit for someone else', others.status === 403, J(others));
const pend = await api(HR, 'GET', '/api/exit-requests/pending');
check('HR (Nasrin) sees it in pending exits', JSON.stringify(pend.body).includes('Ruhul'), J(pend));
await step('HR starts clearance', api(HR, 'PUT', `/api/exit-requests/${exitId}/status`, { status: 'clearance' }));
const dues = await api(SA, 'GET', `/api/exit-requests/${exitId}/dues`);
const dueKinds = (dues.body.items || []).map((d) => d.kind + (d.blocking ? '*' : ''));
check('Dues found: laptop, SIM, running loan', ['asset*', 'sim*', 'loan*'].every((k) => dueKinds.includes(k)), dueKinds.join(','));
const tooEarly = await api(SA, 'PUT', `/api/exit-requests/${exitId}/status`, { status: 'settled' });
check('Settling before clearance is refused', tooEarly.status === 409, J(tooEarly));

at('2026-10', 'Clearance');
await step('Ruhul asks to return the laptop', api(R, 'POST', `/api/assets/assignments/${assignmentId}/request-return`, {}));
await step('IT receives the laptop in good condition', api(SA, 'PUT', `/api/assets/assignments/${assignmentId}/return`, { condition_on_return: 'good' }));
await step('Admin takes back the SIM (set Inactive)', api(SA, 'PUT', `/api/mobile-bill/sims/${simId}`, { phone_number: '01713000555', operator: 'GP', employee_id: empId, limit_source: 'custom', limit_amount: 500, status: 'inactive' }));
const exItems = (await api(R, 'GET', '/api/exit-requests')).body.find?.((e) => e.id === exitId)?.clearance_items || [];
const byDep = Object.fromEntries(exItems.map((i) => [i.department, i]));
for (const [dep, tok, who] of [['IT', TANVIR, 'Tanvir'], ['Finance', FARHANA, 'Farhana'], ['Admin', HR, 'Nasrin'], ['HR', HR, 'Nasrin']]) {
  const q = await api(tok, 'GET', '/api/my-approvals');
  const inQueue = JSON.stringify(q.body).includes('exit_clearance');
  check(`${dep} clearance is in ${who}'s approvals`, inQueue, J(q));
  await step(`${who} clears ${dep}`, api(tok, 'POST', `/api/exit-clearance-items/${byDep[dep]?.id}/decision`, { action: 'approved', remarks: dep === 'Finance' ? 'Loan balance goes to settlement' : 'Cleared' }));
}
const myEx = (await api(R, 'GET', '/api/exit-requests')).body.find?.((e) => e.id === exitId);
check('Ruhul sees all 4 departments cleared', (myEx?.clearance_items || []).every((i) => i.is_cleared == 1), JSON.stringify(myEx).slice(0, 300));

at('2026-10', 'Final settlement');
const st = await step('Settlement draft', api(SA, 'GET', `/api/exit-requests/${exitId}/settlement`));
const loanDue = (dues.body.items || []).find((d) => d.kind === 'loan');
const add = await step('Remaining loan added to the settlement', api(SA, 'POST', `/api/exit-requests/${exitId}/settlement/add-dues`, { keys: [loanDue?.key] }));
const lastStruct = payroll.at(-1);
const basicNow = Number(sql(`SELECT basic_salary FROM salary_structures WHERE employee_id=${empId} ORDER BY effective_date DESC, id DESC LIMIT 1`));
const balRow = sql(`SELECT casual_leave + sick_leave FROM leave_balances WHERE user_id=${ruhulUser}`);
const leaveDays = Number(st.body.unused_leave_days);
check(`Unused leave pre-filled from his balance (${leaveDays} days)`, Math.abs(leaveDays - Number(balRow)) < 0.01, `${leaveDays} vs ${balRow}`);
const encash = Math.round((basicNow / 30) * leaveDays);
const gratuity = basicNow * 4; // ~4.9 years: one basic per completed year
const s = { ...st.body, ...add.body, unused_leave_encashment: encash, gratuity_amount: gratuity, other_additions: 0, other_deductions: 0, notes: '4 completed years', status: 'approved' };
const sa = await step(`Settlement approved: encashment ${encash} + gratuity ${gratuity} − loan ${add.body.outstanding_dues}`, api(SA, 'PUT', `/api/exit-requests/${exitId}/settlement`, s));
check('Net payable = encashment + gratuity − loan', Number(sa.body.net_payable) === encash + gratuity - Number(add.body.outstanding_dues), J(sa));
const mySt = (await api(R, 'GET', '/api/exit-requests')).body.find?.((e) => e.id === exitId)?.settlement;
check('Ruhul sees the approved net amount', Number(mySt?.net_payable) === Number(sa.body.net_payable), JSON.stringify(mySt));
const exp = await step('Experience certificate issued', api(SA, 'POST', '/api/hr-ops/letters', { employee_id: empId, letter_type: 'experience', letter_date: '2026-10-16' }));
const stillIn = await api(R, 'GET', '/api/hr-ops/my/letters');
check('Ruhul sees the experience certificate before his last login', ok2(stillIn) && (stillIn.body.letters || []).some((l) => l.id === exp.body.id), J(stillIn));
await step('Ruhul acknowledges it', api(R, 'POST', `/api/hr-ops/my/letters/${exp.body.id}/acknowledge`, {}));
const paid = await step('Settlement paid', api(SA, 'PUT', `/api/exit-requests/${exitId}/settlement`, { ...s, status: 'paid' }));
const res = await step('HR Ops: resignation (separation) recorded', api(SA, 'POST', '/api/hr-ops/actions', { employee_id: empId, action_type: 'resignation', effective_date: '2026-10-15', reason: 'Higher studies' }));
const rel = await step('Release letter issued', api(SA, 'POST', '/api/hr-ops/letters', { employee_id: empId, hr_action_id: res.body.id }));
check('Ruhul can\'t log in any more, so the release letter is emailed to him', rel.body.emailed_to === 'ruhul.amin@credence.test', J(rel));
const eml = fs.readFileSync('/srv/mailtest/last-sent.eml', 'utf8');
check('The email carries the letter (ref no and text)', eml.includes(rel.body.ref_no) && /ruhul\.amin@credence\.test/.test(eml), eml.slice(0, 300));
check('HR can see it was emailed', sql(`SELECT emailed_to FROM hr_letters WHERE id=${rel.body.id}`) === 'ruhul.amin@credence.test');
check('The experience letter (he could still log in then) was not emailed', sql(`SELECT IFNULL(emailed_to,'') FROM hr_letters WHERE id=${exp.body.id}`) === '');
const exRow = sql(`SELECT status FROM exit_requests WHERE id=${exitId}`);
check('Exit is settled', exRow === 'settled', exRow);
check('Employee record inactive, job status Resigned', sql(`SELECT CONCAT(is_active,'/',IFNULL(job_status,''))  FROM all_employees WHERE id=${empId}`) === '0/Resigned', sql(`SELECT CONCAT(is_active,'/',IFNULL(job_status,'')) FROM all_employees WHERE id=${empId}`));
const old = await api(R, 'GET', '/api/auth/me');
check('His open session is ended', old.status === 401, J(old));
const relog = await login('ruhul.amin@credence.test', 'Ruhul@2021');
check('He can no longer log in', relog.status === 403 && relog.body.code === 'ACCOUNT_BLOCKED', J(relog));

at('2026-10', 'After exit');
const p360 = await api(SA, 'GET', `/api/hr-ops/p360/${empId}`);
check('HR still has his full 360 record', ok2(p360), J(p360));
const pr = (await api(SA, 'GET', `/api/payroll?employee_id=${empId}`)).body;
check(`All ${months.length} payroll months kept`, (Array.isArray(pr) ? pr : pr.rows || []).length === months.length, `${(Array.isArray(pr) ? pr : pr.rows || []).length}`);
const totals = payroll.reduce((a, p) => ({ net: a.net + p.net, bonus: a.bonus + p.bonus, loan: a.loan + p.loan }), { net: 0, bonus: 0, loan: 0 });
const lettersN = sql(`SELECT COUNT(*) FROM hr_letters WHERE employee_id=${empId}`);
const leavesN = sql(`SELECT CONCAT(COUNT(*), '/', IFNULL(SUM(day_count),0)) FROM leave_applications WHERE user_id=${ruhulUser} AND status='approved'`);
const summary = { empId, empCode, ruhulUser, months: months.length, totals, letters: lettersN, leaves: leavesN, settlement: sa.body, payroll };
const pass = results.filter((r) => r.status === 'PASS').length, fail = results.filter((r) => r.status === 'FAIL').length, gaps = results.filter((r) => r.status === 'GAP').length;
fs.writeFileSync('/tmp/claude-0/life/report.json', JSON.stringify({ summary, results }, null, 1));
console.log(`\n${pass} passed, ${fail} failed, ${gaps} gaps`);
console.log(JSON.stringify({ empCode, totals, letters: lettersN, leaves: leavesN }));
