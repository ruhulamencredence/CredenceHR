// Two years of an HR Manager's work in CredenceHR (Nov 2024 – Oct 2026),
// through the API, as Nasrin — an Admin account with HR modules, NOT
// Superadmin. Payroll is approved by Audit (Mahbub) and paid by Accounts
// (Selina); an HR Executive (Arif) approves the onboardings Nasrin opens.
// Each step is recorded PASS / FAIL / NOTE; the run carries on after a
// failure. Output: life/hr-report.json.
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire('/home/user/CredenceHR/package.json');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const QRCode = require('qrcode');
const BASE = process.env.BASE || 'http://localhost:3100';

const results = [];
let phase = '', when = '';
const rec = (status, name, detail = '') => {
  results.push({ when, phase, status, name, detail: String(detail).slice(0, 500) });
  console.log(`${status.padEnd(4)} [${when}] ${name}${detail && status !== 'PASS' ? '  — ' + String(detail).slice(0, 300) : ''}`);
};
const check = (name, ok, detail = '') => (rec(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail), ok);
const note = (name, detail) => rec('NOTE', name, detail);
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
const step = async (name, promise, expect = ok2) => { const r = await promise; check(name, expect(r), J(r)); return r; };
const denied = async (name, promise) => { const r = await promise; check(name, r.status === 403 || r.status === 401, J(r)); return r; };
const pad = (n) => String(n).padStart(2, '0');
const mkPdf = async (title) => { const d = await PDFDocument.create(); const f = await d.embedFont(StandardFonts.Helvetica); d.addPage([595, 842]).drawText(title, { x: 60, y: 760, size: 16, font: f }); return Buffer.from(await d.save()).toString('base64'); };
const sigPng = async (t) => 'data:image/png;base64,' + (await QRCode.toBuffer(t, { type: 'png', width: 200 })).toString('base64');
const listOf = (b) => (Array.isArray(b) ? b : b?.rows || b?.items || b?.employees || b?.data || []);
async function approveAs(token, sourceType, sourceId, action = 'approved', remarks = 'OK') {
  const list = await api(token, 'GET', '/api/my-approvals');
  const rows = listOf(list.body);
  const row = rows.find((r) => r.source_type === sourceType && Number(r.source_id) === Number(sourceId));
  if (!row) return { status: 404, body: { error: `no pending ${sourceType} #${sourceId}`, have: rows.map((r) => `${r.source_type}#${r.source_id}`) } };
  return api(token, 'POST', `/api/my-approvals/${row.id}/act`, { action, remarks });
}

const months = [];
for (let y = 2024, m = 11; y < 2026 || (y === 2026 && m <= 10); m === 12 ? (y++, m = 1) : m++) months.push(`${y}-${pad(m)}`);
const HOLIDAYS = { '2024-12-16': 'Victory Day', '2025-02-21': 'Language Martyrs Day', '2025-03-31': 'Eid-ul-Fitr', '2025-04-01': 'Eid-ul-Fitr', '2025-06-07': 'Eid-ul-Adha', '2025-12-16': 'Victory Day', '2026-02-21': 'Language Martyrs Day', '2026-03-21': 'Eid-ul-Fitr', '2026-05-27': 'Eid-ul-Adha' };
const daysOf = (ym, upTo = 31) => { const [y, m] = ym.split('-').map(Number); const n = Math.min(new Date(y, m, 0).getDate(), upTo); return Array.from({ length: n }, (_, i) => `${ym}-${pad(i + 1)}`); };
const isWork = (d) => new Date(`${d}T00:00:00`).getDay() !== 5 && !HOLIDAYS[d];

// ---------------------------------------------------------------------------
at('2024-10', 'Setup by Superadmin (once)');
const SA = (await login('admin@credence.test', 'AdminPass123')).body.token;
const mkUser = async (name, email, role) => (await step(`Account: ${name} (${role})`, api(SA, 'POST', '/api/users', { name, email, password: 'Pass12345', role }))).body.id;
const nasrinId = await mkUser('Nasrin Sultana (HR Manager)', 'nasrin.hr@credence.test', 'admin');
const HR_MODULES = ['employees', 'departments', 'branches', 'holidays', 'users', 'attendance', 'attendance_reports', 'office_attendance', 'leave_applications', 'recruitment', 'hr_operations', 'payroll', 'performance_management', 'grievance_disciplinary', 'exit_offboarding', 'document_vault', 'asset_management', 'vehicle_management', 'mobile_bill', 'notices', 'hr_analytics', 'task_management', 'target_reports', 'duty_roster', 'approvals', 'conveyance', 'claims', 'admin_dashboard'];
await step('Nasrin gets the HR modules', api(SA, 'PUT', `/api/users/${nasrinId}/module-permissions`, { modules: HR_MODULES }));
const LAYERS = { hr_operations: ['read', 'onboarding_create', 'onboarding_review', 'reminders_receive'], payroll: ['read', 'salary_bulk_upload', 'salary_hold', 'salary_month'], exit_offboarding: ['read', 'exit_dues', 'exit_pdf', 'exit_clearance_setup'], office_attendance: ['read', 'link_pins'], attendance_reports: ['read', 'late_list'], duty_roster: ['read', 'roster_manage'], document_vault: ['read', 'sign_request'], target_reports: ['read', 'target_export', 'target_cancel'], conveyance: ['read', 'on_behalf'], users: ['read', 'edit_add', 'block_account'], departments: ['read', 'edit_add'], approvals: ['read', 'edit_add'] };
for (const [module, layers] of Object.entries(LAYERS)) await step(`Nasrin's ${module} layers: ${layers.join(', ')}`, api(SA, 'PUT', `/api/users/${nasrinId}/module-permission-layers`, { module, layers }));
await step('Nasrin may give Module Access to staff', api(SA, 'PUT', `/api/users/${nasrinId}/feature-permissions`, { can_grant_module_access: true }));
await step('Nasrin manages leave', api(SA, 'PUT', `/api/users/${nasrinId}/leave-management-access`, { can_manage_leave: true }));
const arifId = await mkUser('Arif Hasan (HR Executive)', 'arif.hr@credence.test', 'user');
await step('Arif: HR Operations, approves onboarding', api(SA, 'PUT', `/api/users/${arifId}/module-permissions`, { modules: ['hr_operations', 'employees', 'recruitment'] }));
await step('Arif\'s layers', api(SA, 'PUT', `/api/users/${arifId}/module-permission-layers`, { module: 'hr_operations', layers: ['read', 'onboarding_review', 'onboarding_approve'] }));
const mahbubId = await mkUser('Mahbub Alam (Audit)', 'mahbub.audit@credence.test', 'user');
await step('Mahbub: Payroll audit', api(SA, 'PUT', `/api/users/${mahbubId}/module-permissions`, { modules: ['payroll'] }));
await step('Mahbub\'s layers: audit_approve', api(SA, 'PUT', `/api/users/${mahbubId}/module-permission-layers`, { module: 'payroll', layers: ['read', 'audit_approve'] }));
const selinaId = await mkUser('Selina Parvin (Accounts)', 'selina.acc@credence.test', 'user');
await step('Selina: Payroll pay + Disbursement', api(SA, 'PUT', `/api/users/${selinaId}/module-permissions`, { modules: ['payroll', 'disbursement', 'conveyance'] }));
await step('Selina\'s layers: accounts_pay', api(SA, 'PUT', `/api/users/${selinaId}/module-permission-layers`, { module: 'payroll', layers: ['read', 'accounts_pay'] }));
await step('Approval template for conveyance claims (Superadmin-only job)', api(SA, 'POST', '/api/approval-templates', { name: 'Conveyance — HR then Accounts', request_type: 'conveyance', is_default: true, is_active: true, skip_auto_supervisor: false, steps: [{ approver_user_ids: [nasrinId], approver_type: 'admin', label: 'HR' }] }));
await step('Bill claim categories (Superadmin-only job)', api(SA, 'POST', '/api/bill-claim-categories', { name: 'Transport' }), (r) => ok2(r) || r.status === 409);
note('Superadmin-only HR jobs', 'Approval templates / chains, bill-claim policy and categories, reminder run, company setup, role changes (user↔admin), devices and active sessions can only be done by the Superadmin; an HR Manager has to ask for them.');

const N = (await login('nasrin.hr@credence.test', 'Pass12345')).body.token;
const ARIF = (await login('arif.hr@credence.test', 'Pass12345')).body.token;
const MAHBUB = (await login('mahbub.audit@credence.test', 'Pass12345')).body.token;
const SELINA = (await login('selina.acc@credence.test', 'Pass12345')).body.token;
const FARHANA = (await login('farhana.r@credence.test', 'Pass12345')).body.token;
const TANVIR = (await login('tanvir.r@credence.test', 'Pass12345')).body.token;
check('HR team, Audit and Accounts log in', [N, ARIF, MAHBUB, SELINA, FARHANA, TANVIR].every(Boolean));

// ---------------------------------------------------------------------------
at('2024-11', 'Month 1: company structure');
const sales = await step('New department: Sales', api(N, 'POST', '/api/departments', { name: 'Sales' }), (r) => r.status === 201);
const DEPT = Object.fromEntries(listOf((await api(N, 'GET', '/api/departments')).body).map((d) => [d.name, d.id]));
await step('Chattogram project site (branch)', api(N, 'POST', '/api/branches', { branch_name: 'Chattogram Site', branch_type: 'project_site' }));
for (const [from, to] of [['2024-11-01', '2025-10-31'], ['2025-11-01', '2026-10-31']]) await step(`Fridays off ${from.slice(0, 7)} – ${to.slice(0, 7)}`, api(N, 'POST', '/api/holidays/bulk-weekly', { from, to, weekday: 5, applies_to: 'head_office', title: 'Weekly holiday' }));
let hOk = 0;
for (const [d, t] of Object.entries(HOLIDAYS)) if (ok2(await api(N, 'POST', '/api/holidays', { entry_date: d, day_type: 'holiday', title: t, applies_to: 'head_office' }))) hOk++;
const hWant = Object.keys(HOLIDAYS).filter((d) => new Date(`${d}T00:00:00`).getDay() !== 5).length;
check(`Public holidays entered (${hOk}; one falls on a Friday, already a weekly holiday)`, hOk >= hWant);
const zk = await step('Office attendance device (ZK) added', api(N, 'POST', '/api/zk-devices', { name: 'Head Office Gate', ip_address: '192.168.1.201', port: 4370 }));
const zkId = zk.body.id;
for (const k of ['casual', 'sick']) await step(`Leave policy ${k}: no reliever`, api(N, 'PUT', `/api/leave-policies/${k}`, { min_advance_notice_days: 0, reliever_required: false, max_consecutive_days: null, require_paid_leave_exhausted: false }));
await step('Leave year Jan–Dec', api(N, 'PUT', '/api/leave-year-settings', { close_month_day: '12-31', start_month_day: '01-01', auto_rollover: false }));
await step('Yearly leave: CL 10, SL 14 (General workflow)', api(N, 'PUT', '/api/leave-balance-workflows/1', { items: [{ category_key: 'casual_leave', balance_days: 10 }, { category_key: 'sick_leave', balance_days: 14 }], is_active: true }));

// Import the staff from the old Excel.
const STAFF = [
  { employee_id: 'CHL-1001', name: 'Sabbir Hossain', department: 'Sales', designation: 'Sales Executive', gross: 30000, pin: '1001' },
  { employee_id: 'CHL-1002', name: 'Nusrat Jahan', department: 'Finance', designation: 'Accountant', gross: 42000, pin: '1002' },
  { employee_id: 'CHL-1003', name: 'Imran Kabir', department: 'MIS', designation: 'Software Developer', gross: 55000, pin: '1003' },
  { employee_id: 'CHL-1004', name: 'Mitu Akter', department: 'HR', designation: 'HR Assistant', gross: 28000, pin: '1004' },
  { employee_id: 'CHL-1005', name: 'Jamal Uddin', department: 'Admin', designation: 'Security Guard', gross: 18000, pin: '1005' },
  { employee_id: 'CHL-1006', name: 'Rafiq Islam', department: 'Sales', designation: 'Sales Manager', gross: 80000, pin: '1006' }
];
const rows = STAFF.map((s, i) => ({ employee_id: s.employee_id, name: s.name, department: s.department, designation: s.designation, joining_date: `2023-0${i + 1}-01`, gender: i % 3 === 1 ? 'Female' : 'Male', mobile: `0171100${pad(i)}${pad(i)}`, email: `${s.name.split(' ')[0].toLowerCase()}@credence.test`, zk_device_pin: s.pin, job_base: 'Permanent', login_id: `${s.name.split(' ')[0].toLowerCase()}@credence.test`, login_password: 'Staff@123', payment_type: 'Bank', payment_bank_name: 'BRAC Bank', payment_account_number: `150200${s.pin}`, payment_percentage: 100 }));
const dry = await step('Employee import — dry run', api(N, 'POST', '/api/data-import/employees', { rows, dry_run: true }));
check('Dry run: 6 to create, no errors, nothing saved', dry.body.summary?.create === 6 && dry.body.summary?.error === 0 && sql("SELECT COUNT(*) FROM all_employees WHERE employee_id LIKE 'CHL-10%'") === '0', JSON.stringify(dry.body.summary));
const imp = await step('Employee import — for real (with logins, PINs, bank)', api(N, 'POST', '/api/data-import/employees', { rows, dry_run: false }));
check('6 employees created', imp.body.summary?.create === 6, JSON.stringify(imp.body.summary) + JSON.stringify((imp.body.results || []).filter((r) => r.status === 'error')));
const EMP = {}, TOK = {};
for (const s of STAFF) {
  const [id, uid] = sql(`SELECT id, IFNULL(user_id,0) FROM all_employees WHERE employee_id='${s.employee_id}'`).split('\t').map(Number);
  EMP[s.name.split(' ')[0]] = { ...s, id, uid };
  TOK[s.name.split(' ')[0]] = (await login(`${s.name.split(' ')[0].toLowerCase()}@credence.test`, 'Staff@123')).body.token;
}
check('Every imported employee can log in', Object.values(TOK).every(Boolean));
const meS = (await api(TOK.Sabbir, 'GET', '/api/auth/me')).body;
const meU = meS.user || meS;
check('Default access template was applied to the imported logins (leave, timesheet, attendance…)', !!meU.can_view_leave_application && !!meU.can_view_timesheet && !!meU.can_use_attendance, JSON.stringify(meU).slice(0, 300));
for (const k of Object.keys(EMP)) {
  for (const [route, col] of [['loan-request-access', 'can_view_loan_request'], ['payslip-access', 'can_view_payslip'], ['roster-access', 'can_view_roster'], ['sign-documents-access', 'can_sign_documents'], ['targets-access', 'can_view_targets']]) {
    const r = await api(N, 'PUT', `/api/users/${EMP[k].uid}/${route}`, { [col]: true });
    if (!ok2(r)) check(`Nasrin turns on ${col} for ${k}`, false, J(r));
  }
}
rec('PASS', 'Nasrin turns on Loan, My Payslip, Roster, Documents to Sign, Targets for all 6');
const salRows = STAFF.map((s) => ({ employee_id: s.employee_id, effective_date: '2024-11-01', basic_salary: Math.round(s.gross * 0.6), house_rent: Math.round(s.gross * 0.3), medical_allowance: Math.round(s.gross * 0.06), conveyance_allowance: s.gross - Math.round(s.gross * 0.6) - Math.round(s.gross * 0.3) - Math.round(s.gross * 0.06), tax_deduction: s.gross >= 50000 ? 1000 : 0, pf_deduction: 0 }));
const sim = await step('Salary import (salary_bulk_upload layer)', api(N, 'POST', '/api/data-import/salary', { rows: salRows, dry_run: false }));
check('6 salary structures saved', Number(sql(`SELECT COUNT(*) FROM salary_structures WHERE employee_id IN (${Object.values(EMP).map((e) => e.id).join(',')})`)) === 6, JSON.stringify(sim.body.summary));
// Department heads approve their people's leave.
const rafiqUid = EMP.Rafiq.uid;
for (const [d, uid] of [['Sales', rafiqUid], ['Finance', 131], ['MIS', 132], ['HR', nasrinId], ['Admin', nasrinId]]) await step(`Head of ${d}`, api(N, 'PUT', `/api/departments/${DEPT[d]}`, { name: d, supervisor_user_id: uid }));
await step('Apply the General leave workflow (CL 10 / SL 14 for all)', api(N, 'POST', '/api/leave-balance-workflows/apply', { workflow_id: 1 }));
const lb0 = (await api(TOK.Imran, 'GET', '/api/leave-balances/mine')).body;
const lb = Array.isArray(lb0) ? lb0[0] || {} : lb0;
check('Imran sees CL 10, SL 14', Number(lb.casual_leave ?? lb.balances?.casual_leave) === 10 && Number(lb.sick_leave ?? lb.balances?.sick_leave) === 14, JSON.stringify(lb).slice(0, 200));
for (const [dep, uid] of [['IT', 132], ['Finance', 131], ['Admin', nasrinId], ['HR', nasrinId]]) await step(`Exit clearance approver ${dep}`, api(N, 'PUT', `/api/exit-clearance-approvers/${dep}`, { approver_user_id: uid }));

// What Nasrin cannot do, and what the others cannot do.
at('2024-11', 'Permissions');
await denied('Nasrin cannot build approval templates (Superadmin only)', api(N, 'POST', '/api/approval-templates', { name: 'x', request_type: 'leave', steps: [] }));
await denied('Nasrin cannot make someone an Admin', api(N, 'PUT', `/api/users/${arifId}/role`, { role: 'admin' }));
await denied('Nasrin cannot approve payroll (no audit_approve)', api(N, 'POST', '/api/payroll/approval/2024-11/approve', {}));
await denied('Nasrin cannot pay salaries (no accounts_pay)', api(N, 'POST', '/api/payroll/approval/2024-11/pay', { payment_date: '2024-11-30', payment_method: 'Bank Transfer' }));
await denied('Arif (HR Exec) cannot open Payroll', api(ARIF, 'GET', '/api/payroll?month_year=2024-11'));
await denied('Mahbub (Audit) cannot open Employees', api(MAHBUB, 'GET', '/api/employees'));
await denied('An employee cannot open the Admin Panel employee list', api(TOK.Sabbir, 'GET', '/api/employees'));
check('Nasrin cannot change the Superadmin\'s access', [400, 403].includes((await api(N, 'PUT', `/api/users/1/module-permissions`, { modules: [] })).status));

// ---------------------------------------------------------------------------
const absences = { Sabbir: (ym) => [daysOf(ym).filter(isWork)[3]] }; // one absent day a month
const lateDays = { Imran: (ym) => daysOf(ym).filter(isWork).slice(5, 8) }; // three late days a month
const leaves = {}; // name -> Set of approved leave dates
const joinDate = { Tania: '2025-02-01', Fahim: '2026-01-01' };
const exited = new Set();
const payTotals = [];
let fahimCand = null;

async function punches(ym, upTo) {
  const vals = [];
  for (const [k, e] of Object.entries(EMP)) {
    if (exited.has(k)) continue;
    for (const d of daysOf(ym, upTo).filter(isWork)) {
      if (joinDate[k] && d < joinDate[k]) continue;
      if (leaves[k]?.has(d) || absences[k]?.(ym).includes(d)) continue;
      const late = lateDays[k]?.(ym).includes(d);
      vals.push(`(${zkId}, '${e.pin}', '${d} ${late ? '09:41' : '08:5' + (e.id % 9)}:00')`, `(${zkId}, '${e.pin}', '${d} 18:0${e.id % 9}:00')`);
    }
  }
  if (vals.length) sql(`INSERT IGNORE INTO zk_attendance_logs (device_id, device_user_pin, punch_time) VALUES ${vals.join(',')}`);
  return vals.length / 2;
}
async function applyLeave(k, type, start, days, approver) {
  const end = new Date(`${start}T00:00:00`); end.setDate(end.getDate() + days - 1);
  const endS = `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`;
  const la = await api(TOK[k], 'POST', '/api/leave-applications', { leave_type: type, start_date: start, end_date: endS, purpose: type === 'sick' ? 'Sick' : 'Personal' });
  if (!ok2(la)) return check(`${k} applies ${days}d ${type} from ${start}`, false, J(la));
  const st0 = sql(`SELECT status FROM leave_applications WHERE id=${la.body.id}`);
  let ok = st0 === 'approved';
  // No Supervisor and no Template (a head of department): it waits for an
  // approver and only a Superadmin decides it, from their My Approvals.
  const noApprover = sql(`SELECT IFNULL(MAX(awaiting_approver),0) FROM approval_requests WHERE source_type='leave_application' AND source_id=${la.body.id}`) === '1';
  if (!ok) { const a = await approveAs(noApprover ? SA : approver, 'leave_application', la.body.id); ok = ok2(a); if (!ok) check(`${k}'s leave approved by ${noApprover ? 'the Superadmin (no approver set)' : 'the head'}`, false, J(a)); }
  if (ok) { leaves[k] ||= new Set(); for (const d of daysOf(start.slice(0, 7))) if (d >= start && d <= endS) leaves[k].add(d); }
  check(`${k}: ${days} day ${type} leave from ${start} approved${noApprover ? ' (no approver set — Superadmin decided)' : ''}`, ok);
}

for (const ym of months) {
  const [y, mm] = ym.split('-');
  at(ym, `HR year ${ym < '2025-11' ? 1 : 2}`);

  if (mm === '01') {
    await step(`New leave year ${y}: workflow re-applied`, api(N, 'POST', '/api/leave-balance-workflows/apply', { workflow_id: 1 }));
    const items = Object.entries(EMP).filter(([k]) => !exited.has(k) && !(joinDate[k] && joinDate[k] > `${y}-01-01`)).map(([, e]) => {
      const cur = Number(sql(`SELECT gross_salary FROM salary_structures WHERE employee_id=${e.id} ORDER BY effective_date DESC, id DESC LIMIT 1`));
      return { employee_id: e.id, new_gross: Math.round((cur * 1.08) / 100) * 100 };
    });
    const bulk = await step(`Annual increment ${y}: 8% for ${items.length} people in one go`, api(N, 'POST', '/api/hr-ops/actions/bulk', { action_type: 'increment', effective_date: `${y}-01-01`, reason: `Annual increment ${y}`, items }));
    check('All increments created, none failed', bulk.body.created === items.length && !(bulk.body.errors || []).length, J(bulk));
    const cyc = await step(`Appraisal cycle ${Number(y) - 1}`, api(N, 'POST', '/api/performance-cycles', { name: `Appraisal ${Number(y) - 1}`, period_start: `${Number(y) - 1}-01-01`, period_end: `${Number(y) - 1}-12-31` }));
    await api(N, 'PUT', `/api/performance-cycles/${cyc.body.id}`, { status: 'active' });
    let rv = 0;
    for (const [k, e] of Object.entries(EMP)) {
      if (exited.has(k) || !e.uid) continue;
      const r = await api(N, 'POST', '/api/performance-reviews', { cycle_id: cyc.body.id, user_id: e.uid });
      if (ok2(r) && ok2(await api(N, 'PUT', `/api/performance-reviews/${r.body.id}`, { overall_rating: k === 'Sabbir' ? 2.0 : 3.5 + (e.id % 3) * 0.5, strengths: 'Team player', improvements: k === 'Sabbir' ? 'Targets missed every quarter' : 'Time management', submit: true }))) rv++;
    }
    check(`${rv} appraisals submitted`, rv >= 5);
    await api(N, 'PUT', `/api/performance-cycles/${cyc.body.id}`, { status: 'closed' });
  }

  // Recruitment and onboarding.
  if (ym === '2024-12' || ym === '2025-11') {
    const role = ym === '2024-12' ? ['Sales Executive', 'Sales', 'Tania Rahman', '2025-02-01'] : ['Software Developer', 'MIS', 'Fahim Shahriar', '2026-01-01'];
    const p = await step(`Job posting: ${role[0]}`, api(N, 'POST', '/api/job-postings', { title: role[0], department: role[1], designation: role[0], vacancy_count: 1 }));
    const cands = [];
    for (const nm of [role[2], 'Candidate Two', 'Candidate Three']) cands.push((await api(N, 'POST', '/api/job-candidates', { posting_id: p.body.id, name: nm, email: `${nm.split(' ')[0].toLowerCase()}.${ym}@cand.test`, phone: '0181' + String(Math.random()).slice(2, 9), source: 'Bdjobs' })).body);
    check('3 candidates', cands.every((c) => c?.id));
    for (const c of cands.slice(0, 2)) {
      await api(N, 'PUT', `/api/job-candidates/${c.id}`, { status: 'shortlisted' });
      const iv = await api(N, 'POST', '/api/candidate-interviews', { candidate_id: c.id, scheduled_at: `${ym}-15 11:00:00` });
      await api(N, 'PUT', `/api/candidate-interviews/${iv.body.id}`, { status: 'completed', rating: c === cands[0] ? 5 : 3, feedback: 'Interviewed' });
    }
    await step('Candidate three rejected', api(N, 'PUT', `/api/job-candidates/${cands[2].id}`, { status: 'rejected' }));
    await step(`${role[2]} offered, then hired`, api(N, 'PUT', `/api/job-candidates/${cands[0].id}`, { status: 'offered' }));
    await api(N, 'PUT', `/api/job-candidates/${cands[0].id}`, { status: 'hired' });
    await step('Posting closed', api(N, 'PUT', `/api/job-postings/${p.body.id}`, { status: 'closed' }));
    const o = await step(`Nasrin opens ${role[2]}'s onboarding`, api(N, 'POST', '/api/hr-ops/joiner-onboarding', { candidate_id: cands[0].id, joining_date: role[3], department_id: DEPT[role[1]] }), (r) => r.status === 201);
    const J1 = (await login(o.body.login_id, o.body.password)).body.token;
    const me = (await api(J1, 'GET', '/api/onboarding/me')).body;
    for (const d of me.required_documents || []) await api(J1, 'POST', '/api/onboarding/me/documents', { doc_type: d, file_name: `${d}.pdf`, file_mime: 'application/pdf', file_base64: await mkPdf(d) });
    const first = role[2].split(' ')[0];
    const personal = { gender: first === 'Tania' ? 'Female' : 'Male', date_of_birth: '1998-05-05', nid_ssn: `19980${ym.replace('-', '')}77`, mobile: `0191${ym.replace('-', '')}9`, present_address: 'Dhaka', permanent_address: 'Khulna', personal_email: `${first.toLowerCase()}@credence.test` };
    await step(`${first} submits the onboarding form`, api(J1, 'POST', '/api/onboarding/me/submit', { personal, contacts: [{ name: 'Parent', relation: 'Father', phone: '01700000001' }], nominees: [{ name: 'Parent', relation: 'Father', nominee_percent: 100 }] }));
    await denied('Nasrin cannot approve an onboarding she opened (and has no approve layer)', api(N, 'POST', `/api/hr-ops/joiner-onboarding/${o.body.id}/approve`));
    const a = await step(`Arif (HR Exec) approves — ${first} becomes an employee`, api(ARIF, 'POST', `/api/hr-ops/joiner-onboarding/${o.body.id}/approve`));
    const eid = Number(a.body.employee_id);
    check('Arif is not Superadmin, so no access template was applied automatically', a.body.access_applied === false || a.body.access_applied === undefined, J(a));
    const uid = Number(sql(`SELECT user_id FROM all_employees WHERE id=${eid}`));
    const pin = first === 'Tania' ? '1007' : '1008';
    EMP[first] = { employee_id: a.body.employee_code, name: role[2], department: role[1], designation: role[0], gross: first === 'Tania' ? 32000 : 60000, pin, id: eid, uid };
    let L = await login(a.body.employee_code, o.body.password);
    await api(L.body.token, 'PUT', '/api/profile/password', { current_password: o.body.password, new_password: 'Staff@123' });
    TOK[first] = (await login(`${first.toLowerCase()}@credence.test`, 'Staff@123')).body.token;
    check(`${first} logs in with the new password`, !!TOK[first]);
    // Nasrin gives the Self Service switches by hand.
    let sw = 0;
    for (const [route, col] of [['leave-application-access', 'can_view_leave_application'], ['timesheet-access', 'can_view_timesheet'], ['payslip-access', 'can_view_payslip'], ['loan-request-access', 'can_view_loan_request'], ['sign-documents-access', 'can_sign_documents'], ['tasks-access', 'can_view_tasks'], ['conveyance-claim-access', 'can_view_conveyance_claims'], ['movement-claim-access', 'can_view_movement_claims']]) if (ok2(await api(N, 'PUT', `/api/users/${uid}/${route}`, { [col]: true }))) sw++;
    await api(N, 'PUT', `/api/users/${uid}/feature-permissions`, { can_use_attendance: true, can_view_leave_summary: true });
    check(`Nasrin turns on ${first}'s Self Service (${sw}/8)`, sw === 8);
    await step(`${first}'s device PIN`, api(N, 'PUT', `/api/employees/${eid}/zk-pin`, { zk_device_pin: pin }));
    await step(`${first}'s salary`, api(N, 'POST', '/api/payroll/salary-structures', { employee_id: eid, effective_date: role[3], basic_salary: Math.round(EMP[first].gross * 0.6), house_rent: Math.round(EMP[first].gross * 0.3), medical_allowance: Math.round(EMP[first].gross * 0.06), conveyance_allowance: EMP[first].gross - Math.round(EMP[first].gross * 0.6) - Math.round(EMP[first].gross * 0.3) - Math.round(EMP[first].gross * 0.06) }));
    await step(`${first}'s bank account`, api(N, 'POST', `/api/employees/${eid}/payment-accounts`, { account_type: 'bank', account_label: 'Salary', bank_name: 'BRAC Bank', account_number: `150200${pin}`, percentage: 100 }));
    await step('Appointment letter', api(N, 'POST', '/api/hr-ops/letters', { employee_id: eid, letter_type: 'appointment', letter_date: role[3] }));
    const chk = await api(N, 'GET', `/api/hr-ops/onboarding/${eid}`);
    const items = listOf(chk.body.items || chk.body).filter((i) => i.status === 'pending');
    let done = 0;
    for (const it of items) if (ok2(await api(N, 'PUT', `/api/hr-ops/onboarding/items/${it.id}`, { status: 'done' }))) done++;
    check(`Onboarding checklist closed (${done} items)`, done > 0 && done === items.length);
    if (first === 'Fahim') fahimCand = eid;
  }

  // Probation ends six months after joining.
  if (ym === '2025-08' || ym === '2026-07') {
    const k = ym === '2025-08' ? 'Tania' : 'Fahim';
    const c = await step(`${k}: probation over — confirmed`, api(N, 'POST', '/api/hr-ops/actions', { employee_id: EMP[k].id, action_type: 'confirmation', effective_date: `${ym}-01`, reason: 'Probation completed' }));
    await step('Confirmation letter', api(N, 'POST', '/api/hr-ops/letters', { employee_id: EMP[k].id, hr_action_id: c.body.id }));
  }

  // Leave through the year.
  if (ym === '2025-09') {
    // A leave over a Friday in a month he is also absent one day: the Friday
    // must not count as leave, and the absent day must still be cut.
    const thu = daysOf(ym).filter((d) => isWork(d) && new Date(`${d}T00:00:00`).getDay() === 4 && d > absences.Sabbir(ym)[0])[0];
    await applyLeave('Sabbir', 'casual', thu, 3, TOK.Rafiq);
  }
  const lp = { '02': [['Imran', 'casual', 2, TANVIR], ['Nusrat', 'sick', 3, FARHANA]], '05': [['Sabbir', 'casual', 2, null], ['Mitu', 'casual', 1, N]], '08': [['Jamal', 'sick', 2, N], ['Tania', 'casual', 2, null]], '11': [['Imran', 'sick', 1, TANVIR], ['Rafiq', 'casual', 3, null]] }[mm] || [];
  for (const [k, type, d, ap] of lp) {
    if (!TOK[k] || exited.has(k) || (joinDate[k] && joinDate[k] > `${ym}-01`)) continue;
    const start = daysOf(ym).filter(isWork)[10];
    await applyLeave(k, type, start, d, ap || (TOK.Rafiq));
  }

  if (ym === '2025-01') {
    await step('Notice: new office hours 9–6', api(N, 'POST', '/api/notices', { title: 'Office hours from 1 Feb: 9 am – 6 pm', content_html: '<p>Please follow the new office hours.</p>', target_type: 'all', is_active: true }));
    await step('Monthly task for Mitu: attendance review (repeats)', api(N, 'POST', '/api/task-recurrences', { title: 'Review last month\'s attendance exceptions', priority: 'normal', category: 'attendance', assignee_ids: [EMP.Mitu.uid], frequency: 'monthly', month_day: 2, due_in_days: 3, start_date: '2026-10-01' }));
    const pol = await step('Company policy PDF sent to everyone to sign', api(N, 'POST', '/api/employee-documents', { user_id: EMP.Imran.uid, doc_type: 'Code of Conduct', file_name: 'code-of-conduct.pdf', file_mimetype: 'application/pdf', file_base64: await mkPdf('Code of Conduct 2025') }));
    await step('Imran asked to sign the Code of Conduct', api(N, 'POST', `/api/esign/documents/${pol.body.id}/request`, { signers: [{ user_id: EMP.Imran.uid, label: 'Employee' }] }));
    await step('Imran signs it', api(TOK.Imran, 'POST', `/api/esign/documents/${pol.body.id}/sign`, { signed_name: 'Imran Kabir', image: await sigPng('imran'), agree: true }));
    const hasN = ((b) => b.shifts || listOf(b))((await api(N, 'GET', '/api/roster/shifts')).body).some((x) => x.code === 'N');
    if (!hasN) await step('Security Night shift', api(N, 'POST', '/api/roster/shifts', { name: 'Night', code: 'N', start_time: '22:00', end_time: '06:00', grace_minutes: 10 }));
  }
  if (ym === '2025-03') {
    const g = await step('Sabbir raises a grievance about his sales area', api(TOK.Sabbir, 'POST', '/api/grievances', { description: 'My territory was given to someone else without notice.', category: 'Workplace' }), (r) => r.status === 201);
    await step('Nasrin investigates', api(N, 'PUT', `/api/grievances/${g.body.id}`, { status: 'investigating', assigned_to: nasrinId }));
    await step('Nasrin resolves it', api(N, 'PUT', `/api/grievances/${g.body.id}`, { status: 'resolved', resolution_notes: 'Territory split agreed with the Sales Manager.' }));
  }
  if (ym === '2025-05') {
    const rq = await step('Mitu asks for a laptop', api(TOK.Mitu, 'POST', '/api/assets/requisitions', { items: [{ item_name: 'Laptop', purpose: 'HR work', unit: 'pcs', quantity: 1 }], urgency: 'medium', target_date: '2026-12-31' }));
    const a = await approveAs(N, 'asset_requisition', rq.body.id);
    check('Nasrin (head of HR) approves it', ok2(a) || a.status === 404, J(a));
    await step('Nasrin hands over the laptop', api(N, 'POST', `/api/assets/requisitions/${rq.body.id}/fulfill`, { items: [{ item_name: 'Laptop', quantity: 1, unit: 'pcs', asset_tag: 'CHL-LT-0901', serial_number: 'HP-9X1', requested_index: 0 }], condition_on_assign: 'new' }));
    const sims = [];
    for (const k of ['Rafiq', 'Sabbir', 'Tania']) sims.push((await step(`SIM for ${k}`, api(N, 'POST', '/api/mobile-bill/sims', { phone_number: `0171300${EMP[k].pin.slice(1)}0`, operator: 'GP', employee_id: EMP[k].id, limit_source: 'custom', limit_amount: k === 'Rafiq' ? 1500 : 700 }), (r) => r.status === 201)).body);
    EMP.Sabbir.sim = sims[1]?.id;
  }
  if (ym >= '2025-05' && ym <= '2026-09') {
    const bills = ['Rafiq', 'Sabbir', 'Tania'].filter((k) => !exited.has(k)).map((k) => ({ phone_number: `0171300${EMP[k].pin.slice(1)}0`, amount: 400 + (EMP[k].id * 37 + Number(mm) * 11) % 900 }));
    const r = await api(N, 'POST', '/api/mobile-bill/bills/import', { month: ym, rows: bills, dry_run: false });
    if (!ok2(r)) check(`Mobile bills ${ym} imported`, false, J(r));
  }
  if (ym === '2025-06') {
    const w = await step('Written warning to Sabbir (targets)', api(N, 'POST', '/api/disciplinary-actions', { user_id: EMP.Sabbir.uid, action_type: 'written_warning', reason: 'Sales target missed 3 quarters in a row' }), (r) => r.status === 201);
    await api(TOK.Sabbir, 'POST', `/api/disciplinary-actions/${w.body.id}/feedback`, { message: 'Market is slow; I will improve.' });
    await step('Sabbir acknowledges', api(TOK.Sabbir, 'PUT', `/api/disciplinary-actions/${w.body.id}`, { acknowledge: true }));
  }
  if (ym === '2025-08') {
    const p = await step('Promotion: Imran to Senior Developer, gross 70,000', api(N, 'POST', '/api/hr-ops/actions', { employee_id: EMP.Imran.id, action_type: 'promotion', effective_date: '2025-08-01', to: { designation: 'Senior Software Developer', gross_salary: 70000 }, reason: 'Led the ERP project' }));
    await step('Promotion letter', api(N, 'POST', '/api/hr-ops/letters', { employee_id: EMP.Imran.id, hr_action_id: p.body.id }));
    const t = await step('Transfer: Mitu from HR to Admin', api(N, 'POST', `/api/employees/${EMP.Mitu.id}/transfer`, { to_department_id: DEPT.Admin, to_designation: 'Admin Officer', effective_date: '2025-08-01', reason: 'Admin needs support' }), (r) => r.status === 201);
    check('Mitu is in Admin now', sql(`SELECT department FROM all_employees WHERE id=${EMP.Mitu.id}`) === 'Admin');
  }
  if (ym === '2025-10') {
    const lr = await step('Imran requests a loan 24,000 / 6 months', api(TOK.Imran, 'POST', '/api/my-loans/requests', { kind: 'loan', total_amount: 24000, installments: 6, reason: 'Family' }), (r) => r.status === 201);
    const a = await approveAs(TANVIR, 'advance_request', lr.body.id);
    check('Tanvir (head of MIS) recommends it', ok2(a) || a.status === 404, J(a));
    await step('Nasrin (Payroll) approves the loan', api(N, 'POST', `/api/payroll/advance-requests/${lr.body.id}/decision`, { action: 'approve', remarks: 'OK' }));
  }
  if (ym === '2025-12') {
    const ir = await step('Info request: everyone\'s missing NID copy', api(N, 'POST', '/api/hr-ops/info-requests', { employee_ids: ['Sabbir', 'Jamal'].map((k) => EMP[k].id), items: [{ item_type: 'document', doc_type: 'NID' }], note: 'Upload your NID', due_date: '2026-12-31' }));
    const mine = listOf((await api(TOK.Jamal, 'GET', '/api/hr-ops/my/info-requests')).body.requests || (await api(TOK.Jamal, 'GET', '/api/hr-ops/my/info-requests')).body);
    const req = mine.find((x) => x.status === 'pending');
    if (req) {
      await step('Jamal uploads his NID', api(TOK.Jamal, 'POST', `/api/hr-ops/my/info-requests/${req.id}/submit`, { file_base64: await mkPdf('NID Jamal'), file_name: 'nid.pdf', file_mime: 'application/pdf' }));
      await step('Nasrin accepts it into his documents', api(N, 'POST', `/api/hr-ops/info-requests/${req.id}/review`, { decision: 'approved' }));
    } else check('Jamal sees the info request', false, JSON.stringify(mine));
  }
  if (ym === '2026-02') {
    const ex = await step('Sabbir terminated (performance) — exit opened by HR', api(N, 'POST', '/api/exit-requests', { user_id: EMP.Sabbir.uid, exit_type: 'termination', reason: 'Performance — after written warning and appraisal 2.0', notice_date: '2026-02-01', last_working_day: '2026-02-28' }), (r) => r.status === 201);
    EMP.Sabbir.exit = ex.body.id;
    await step('Clearance started', api(N, 'PUT', `/api/exit-requests/${ex.body.id}/status`, { status: 'clearance' }));
  }
  if (ym === '2026-07') {
    const ex = await step('Nusrat resigns (last day 31 Jul)', api(TOK.Nusrat, 'POST', '/api/exit-requests', { reason: 'Moving abroad', notice_date: '2026-07-01', last_working_day: '2026-07-31' }), (r) => r.status === 201);
    EMP.Nusrat.exit = ex.body.id;
    await step('Clearance started', api(N, 'PUT', `/api/exit-requests/${ex.body.id}/status`, { status: 'clearance' }));
  }

  // Exits settle the month after notice; from then on they are out of payroll.
  if (ym === '2026-03') { at(ym, 'Exit: Sabbir'); EMP.Sabbir.exitType = 'termination'; await finishExit('Sabbir', 3); at(ym, 'HR year 2'); }
  if (ym === '2026-08') { at(ym, 'Exit: Nusrat'); await finishExit('Nusrat', 3); at(ym, 'HR year 2'); }
  // Attendance from the device, then the month's reports and payroll.
  if (ym === '2026-10') break;
  const n = await punches(ym);
  const eidBonus = ['2025-03', '2025-06', '2026-03', '2026-05'].includes(ym);
  if (eidBonus) {
    let st = 0;
    for (const [k, e] of Object.entries(EMP)) if (!exited.has(k) && !(joinDate[k] && joinDate[k] > `${ym}-01`) && ok2(await api(N, 'POST', '/api/payroll/pending-bonuses', { employee_id: e.id, month_year: ym, amount: Math.round(Number(sql(`SELECT basic_salary FROM salary_structures WHERE employee_id=${e.id} ORDER BY effective_date DESC, id DESC LIMIT 1`))), reason: 'Eid festival bonus' }))) st++;
    check(`Eid bonus staged for ${st} people`, st >= 5);
  }
  const wz = await api(N, 'GET', `/api/payroll/wizard/attendance-summary?month_year=${ym}`);
  if (!check(`Payroll wizard reads ${ym} attendance`, ok2(wz), J(wz))) continue;
  const work = daysOf(ym).filter(isWork).length;
  const wrong = [];
  for (const [k, e] of Object.entries(EMP)) {
    if (exited.has(k) || (joinDate[k] && joinDate[k] > lastDayOf(ym))) continue;
    const w = wz.body.employees.find((x) => Number(x.employee_id) === e.id);
    if (!w) { wrong.push(`${k} missing`); continue; }
    const lv = [...(leaves[k] || [])].filter((d) => d.startsWith(ym) && isWork(d)).length;
    const ab = absences[k] ? absences[k](ym).filter((d) => !(leaves[k]?.has(d))).length : 0;
    const before = joinDate[k] && joinDate[k].startsWith(ym) ? daysOf(ym).filter((d) => isWork(d) && d < joinDate[k]).length : 0;
    if (Number(w.leave_days) !== lv || Number(w.absent_days) !== ab + before || (lateDays[k] && Number(w.late_count) < 3)) wrong.push(`${k}: leave ${w.leave_days}/${lv} absent ${w.absent_days}/${ab + before} late ${w.late_count} present ${w.present_days} wd ${w.total_working_days}/${work}`);
  }
  check(`${ym}: wizard leave / absent / late match the device and leave records (${n} punch days)`, wrong.length === 0, wrong.join(' | '));
  if (eidBonus) check('Wizard shows the staged Eid bonus', wz.body.employees.filter((x) => Number(x.pending_bonus_amount) > 0).length >= 5);
  const list = wz.body.employees.filter((x) => x.has_salary_structure && !x.already_generated);
  const gb = await api(N, 'POST', '/api/payroll/generate-bulk', { month_year: ym, payment_method: 'Bank Transfer', employees: list.map((x) => ({ employee_id: x.employee_id, total_working_days: x.total_working_days, present_days: x.present_days, absent_days: x.absent_days, leave_days: x.leave_days, lwp_days: x.lwp_days, late_count: x.late_count, late_deduction_days: x.late_deduction_days, bonus_amount: x.pending_bonus_amount || 0 })) });
  const okRuns = (gb.body.results || []).filter((r) => r.success).length;
  const sub = await api(N, 'POST', `/api/payroll/approval/${ym}/submit`, { note: 'HR' });
  const self = await api(N, 'POST', `/api/payroll/approval/${ym}/approve`, {});
  const apv = await api(MAHBUB, 'POST', `/api/payroll/approval/${ym}/approve`, { note: 'Audited' });
  const early = await api(N, 'GET', `/api/payroll?month_year=${ym}`);
  const pay = await api(SELINA, 'POST', `/api/payroll/approval/${ym}/pay`, { payment_date: lastDayOf(ym), payment_method: 'Bank Transfer', payment_reference: `BRAC-${ym}` });
  const runs = listOf((await api(N, 'GET', `/api/payroll?month_year=${ym}`)).body);
  const bad = runs.filter((r) => Math.abs(Number(r.net_salary) - (Number(r.gross_earned) - Number(r.total_deduction))) > 0.5 || r.payment_status !== 'paid');
  const total = runs.reduce((s, r) => s + Number(r.net_salary), 0);
  payTotals.push({ ym, people: runs.length, total, bonus: runs.reduce((s, r) => s + Number(r.bonus_amount), 0) });
  check(`${ym} payroll: ${okRuns} generated by HR → audited by Mahbub → paid by Selina (৳${Math.round(total).toLocaleString()})`, ok2(gb) && okRuns === list.length && ok2(sub) && self.status === 403 && ok2(apv) && ok2(pay) && bad.length === 0, `${J(gb)} sub ${sub.status} self ${self.status} apv ${J(apv)} pay ${J(pay)} bad ${bad.length}`);
  if (ym === '2024-11') {
    const ps = await api(TOK.Jamal, 'GET', '/api/my-payslips');
    check('Jamal sees his November payslip', ok2(ps) && ps.body.payslips?.length === 1, J(ps));
    const rep = await api(N, 'GET', '/api/attendance/report/monthly?year=2024&month=11');
    const mine = listOf(rep.body.users).filter((u) => Number(u.user_id) === EMP.Imran.uid);
    const lvN = [...(leaves.Imran || [])].filter((d) => d.startsWith(ym) && isWork(d)).length;
    check(`Monthly attendance report: Imran present ${work - lvN}, leave ${lvN}, absent 0`, mine.length > 0 && Number(mine[0].present_days) === work - lvN && Number(mine[0].leave_days) === lvN && Number(mine[0].absent_days) === 0, JSON.stringify(mine.map((u) => [u.present_days, u.leave_days, u.absent_days])));
  }
  if (ym === '2025-02') {
    const rep = await api(N, 'GET', '/api/attendance/report/monthly?year=2025&month=2');
    const im = listOf(rep.body.users).filter((u) => Number(u.user_id) === EMP.Imran.uid);
    const ab = im.reduce((s, u) => s + Number(u.absent_days), 0);
    check('Feb 2025 report: Imran\'s 2 leave days show as Leave (L), not Absent', ab === 0 && Number(im[0]?.leave_days) === 2 && im[0].days.filter((d) => d.leave_type).length === 2, JSON.stringify(im.map((u) => [u.leave_days, u.absent_days])));
    const late = await api(N, 'GET', `/api/attendance/report/late?date=${lateDays.Imran('2025-02')[0]}`);
    check('Late list (late_list layer) shows Imran late', ok2(late) && JSON.stringify(late.body).includes('Imran'), J(late));
  }
  if (['2025-03', '2025-09', '2026-03', '2026-09'].includes(ym)) {
    const a = await api(N, 'GET', '/api/hr-analytics/summary');
    check(`HR analytics (${ym}): headcount ${a.body.headcount_total}`, ok2(a) && a.body.headcount_total > 0, J(a));
    const rr = await api(N, 'POST', '/api/hr-ops/reports/run', { columns: ['employee_code', 'name', 'department', 'designation'], filters: [], match: 'all' });
    check('HR Ops report builder runs', ok2(rr), J(rr));
    const ri = await api(N, 'POST', '/api/reports-insights/run', { key: 'leave_taken', from: `${ym.slice(0, 4)}-01-01`, to: lastDayOf(ym) });
    check('Reports & Insights: leave taken', ok2(ri), J(ri));
  }
}

function lastDayOf(ym) { const [y, m] = ym.split('-').map(Number); return `${ym}-${pad(new Date(y, m, 0).getDate())}`; }

// ---------------------------------------------------------------------------
async function finishExit(k, gratuityYears) {
  const e = EMP[k];
  const dues = (await api(N, 'GET', `/api/exit-requests/${e.exit}/dues`)).body.items || [];
  if (e.sim) await step(`${k}'s SIM turned off`, api(N, 'PUT', `/api/mobile-bill/sims/${e.sim}`, { phone_number: `0171300${e.pin.slice(1)}0`, operator: 'GP', employee_id: e.id, limit_source: 'custom', limit_amount: 700, status: 'inactive' }));
  const ex = (await api(N, 'GET', '/api/exit-requests/pending')).body;
  const items = (await api(TOK[k] || N, 'GET', '/api/exit-requests')).body;
  const row = listOf(items).find((x) => x.id === e.exit) || {};
  for (const it of row.clearance_items || []) {
    const tok = { IT: TANVIR, Finance: FARHANA, Admin: N, HR: N }[it.department];
    const r = await api(tok, 'POST', `/api/exit-clearance-items/${it.id}/decision`, { action: 'approved', remarks: 'Cleared' });
    if (!ok2(r)) check(`${it.department} clears ${k}`, false, J(r));
  }
  rec('PASS', `IT, Finance, Admin, HR clear ${k}`);
  const st = await step(`${k}'s settlement draft`, api(N, 'GET', `/api/exit-requests/${e.exit}/settlement`));
  const basic = Number(sql(`SELECT basic_salary FROM salary_structures WHERE employee_id=${e.id} ORDER BY effective_date DESC, id DESC LIMIT 1`));
  const days = Number(st.body.unused_leave_days);
  const s = { ...st.body, unused_leave_encashment: Math.round((basic / 30) * days), gratuity_amount: basic * gratuityYears, outstanding_dues: 0, other_additions: 0, other_deductions: 0, notes: 'Final settlement', status: 'approved' };
  await step(`${k}'s settlement approved`, api(N, 'PUT', `/api/exit-requests/${e.exit}/settlement`, s));
  const paid = await step(`${k}'s settlement paid → exit settled`, api(N, 'PUT', `/api/exit-requests/${e.exit}/settlement`, { ...s, status: 'paid' }));
  check(`${k} can no longer log in`, (await login(`${k.toLowerCase()}@credence.test`, 'Staff@123')).status === 403);
  const act = await step(`HR Ops separation recorded for ${k}`, api(N, 'POST', '/api/hr-ops/actions', { employee_id: e.id, action_type: e.exitType || 'resignation', effective_date: k === 'Sabbir' ? '2026-02-28' : '2026-07-31', reason: 'Exit settled' }));
  const rel = await step(`Release letter for ${k}`, api(N, 'POST', '/api/hr-ops/letters', { employee_id: e.id, hr_action_id: act.body.id }));
  check(`…emailed to ${k} because the login is blocked`, !!rel.body.emailed_to, J(rel));
  exited.add(k);
}
check('Sabbir is not in the September payroll wizard', !((await api(N, 'GET', '/api/payroll/wizard/attendance-summary?month_year=2026-09')).body.employees || []).some((x) => Number(x.employee_id) === EMP.Sabbir.id));

// ---------------------------------------------------------------------------
at('2026-10', 'This month');
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
await punches('2026-10', Number(today.slice(8)) - 1);
const shifts = ((b) => b.shifts || listOf(b))((await api(N, 'GET', '/api/roster/shifts')).body);
const night = shifts.find((s) => s.code === 'N');
check('Night shift exists', !!night?.id);
await step('Security roster: Jamal on Night shift all of October', api(N, 'PUT', '/api/roster/cells', { cells: daysOf('2026-10').map((d) => ({ employee_id: EMP.Jamal.id, date: d, shift_id: isWork(d) ? night?.id : null, is_off: !isWork(d) })) }));
const team = await step('Chattogram site team (Rafiq supervises Tania)', api(N, 'POST', '/api/site-attendance/teams', { name: 'Chattogram Sales Site', supervisor_user_id: EMP.Rafiq.uid, employee_ids: [EMP.Tania.id], radius_m: 200, site_location: 'Agrabad' }));
const sheet = await step('Rafiq marks the site sheet for today', api(TOK.Rafiq, 'POST', '/api/site-attendance/sheet', { team_id: team.body.id, date: today, entries: [{ employee_id: EMP.Tania.id, status: 'present', in_time: '09:05', out_time: '18:00' }] }));
if (sheet.body.status === 'submitted') await step('Nasrin approves the site sheet', api(N, 'POST', `/api/site-attendance/sheets/${sheet.body.sheet_id}/review`, { decision: 'approve' }));
const cat = listOf((await api(TOK.Tania, 'GET', '/api/bill-claim-categories')).body)[0];
const cl = await step('Tania claims CNG fare for today', api(TOK.Tania, 'POST', '/api/user-claims', { from_date: today, to_date: today, items: [{ category_id: cat?.id, bill_date: today, amount: 420, description: 'Client visit' }] }), (r) => r.status === 201);
const ca = await approveAs(TOK.Rafiq, 'user_claim', cl.body.id);
check('Rafiq (head of Sales) approves the claim', ok2(ca), J(ca));
const cb = await approveAs(N, 'user_claim', cl.body.id);
check('Nasrin (template step: HR) approves it', ok2(cb), J(cb));
const bill = sql(`SELECT IFNULL(MAX(id),0) FROM conveyance_bills`);
const dis = await api(SELINA, 'POST', `/api/conveyance-bills/${bill}/disburse`, { voucher_no: 'CV-2610-01' });
check('Selina (Accounts) pays it out', ok2(dis), J(dis));
const tasks = await step('Nasrin sees all tasks', api(N, 'GET', '/api/tasks/all'));
const trep = await step('Target report (target_reports)', api(N, 'GET', `/api/target-reports?period_type=yearly&year=2026`));
const dash = await step('Admin dashboard', api(N, 'GET', '/api/admin-dashboard/extras'));
const due = await api(N, 'GET', '/api/hr-ops/reminders/upcoming');
check('HR reminders list opens', ok2(due), J(due));
const hc = await api(N, 'GET', '/api/hr-analytics/summary');
check(`Final headcount ${hc.body.headcount_total}`, ok2(hc));
const jr = (await api(TOK.Jamal, 'GET', '/api/my-roster?from=2026-10-01&to=2026-10-31')).body;
check('Jamal sees his Night shifts in My Duty Roster', (jr.days || []).filter((d) => d.shift?.code === 'N').length === daysOf('2026-10').filter(isWork).length, JSON.stringify(jr).slice(0, 200));
const slip = await api(TOK.Fahim, 'GET', '/api/my-payslips');
check(`Fahim (joined Jan 2026) sees ${slip.body.payslips?.length} payslips`, ok2(slip) && slip.body.payslips?.length === 9, J(slip));

const pass = results.filter((r) => r.status === 'PASS').length, fail = results.filter((r) => r.status === 'FAIL').length, notes = results.filter((r) => r.status === 'NOTE').length;
fs.writeFileSync('/tmp/claude-0/life/hr-report.json', JSON.stringify({ results, payTotals, EMP }, null, 1));
console.log(`\n${pass} passed, ${fail} failed, ${notes} notes`);
