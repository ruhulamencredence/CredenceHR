/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Pieces of HR Operations -> Service Book (Employee 360, HrOps360.tsx):
// the types mirrored from HrOps360Routes.ts, the Add/Edit form for the four
// HR-maintained record types (experience, education, family, training), the
// small forms for operations that belong to other modules (document upload,
// loan, disciplinary action), and the Dossier PDF / Excel export.

import React, { useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { Paperclip } from 'lucide-react';
import { Spinner } from './Spinner';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import credenceLogo from '../assets/credence-logo.png';
import { serviceLength, type ServiceEvent } from './HrOpsServiceBook';
import { useHrApi, Modal, Notice, fmtDate, monthLabel, inputCls, labelCls, btnPrimary, btnGhost } from './HrOpsShared';

// ---------------------------------------------------------------------------
// Types (mirror HrOps360Routes.ts)
// ---------------------------------------------------------------------------

export interface P360Overview {
  permissions: { payroll: boolean; document_vault: boolean; grievance_disciplinary: boolean; asset_management: boolean; employees: boolean };
  employee: {
    id: number;
    name: string;
    employee_code: string | null;
    designation: string | null;
    department: string | null;
    branch: string | null;
    grade: string | null;
    supervisor: string | null;
    project: string | null;
    joining_date: string | null;
    job_base: string | null;
    is_active: boolean;
    gross_salary: number | null;
    probation_end_date: string | null;
    confirmation_date: string | null;
    contract_end_date: string | null;
    probation_months: number | null;
    service_length_months: number | null;
    service_status: string;
    user_id: number | null;
  };
  profile: Record<string, any>;
  summary: {
    service_months: number | null;
    prior_experience_months: number;
    total_experience_months: number;
    highest_education: string | null;
    gross_salary: number | null;
    loan_outstanding: number | null;
    active_loans: number | null;
    leave_taken: number;
    leave_remaining: number;
    attendance_month: string;
    attendance_percent: number | null;
    absent_this_month: number;
    late_this_month: number;
    claims_pending_count: number;
    claims_pending_amount: number;
    claims_approved_year: number;
    documents: number;
    documents_missing: number;
    documents_expired: number;
    assets_held: number;
    nominees: number;
    emergency_contacts: number;
  };
  events: ServiceEvent[];
}

export type RecordKind = 'experience' | 'education' | 'family' | 'training';

// ---------------------------------------------------------------------------
// Record form config — one list per type drives the form, the cards and the
// exports.
// ---------------------------------------------------------------------------

type FieldDef = { key: string; label: string; type?: 'text' | 'date' | 'number' | 'textarea' | 'select' | 'check'; options?: string[]; wide?: boolean; placeholder?: string };

export const RECORD_FIELDS: Record<RecordKind, { title: string; fields: FieldDef[]; hasFile: boolean; hasVerify: boolean }> = {
  experience: {
    title: 'Previous Experience',
    hasFile: true,
    hasVerify: true,
    fields: [
      { key: 'company_name', label: 'Company name *', wide: true },
      { key: 'company_business', label: 'Type of business', placeholder: 'e.g. Real Estate' },
      { key: 'location', label: 'Location' },
      { key: 'designation', label: 'Designation' },
      { key: 'department', label: 'Department' },
      { key: 'from_date', label: 'From', type: 'date' },
      { key: 'to_date', label: 'To', type: 'date' },
      { key: 'last_salary', label: 'Last gross salary (BDT)', type: 'number' },
      { key: 'leaving_reason', label: 'Reason for leaving' },
      { key: 'responsibilities', label: 'Responsibilities', type: 'textarea', wide: true },
      { key: 'reference_name', label: 'Reference person' },
      { key: 'reference_contact', label: 'Reference contact' }
    ]
  },
  education: {
    title: 'Education',
    hasFile: true,
    hasVerify: true,
    fields: [
      { key: 'level', label: 'Level', type: 'select', options: ['PhD', 'Masters', 'Bachelor', 'Diploma', 'HSC / A Level', 'SSC / O Level', 'Professional', 'Other'] },
      { key: 'degree', label: 'Degree / Exam title *', placeholder: 'e.g. B.Sc in Civil Engineering' },
      { key: 'major', label: 'Major / Group' },
      { key: 'institute', label: 'Institute' },
      { key: 'board_university', label: 'Board / University' },
      { key: 'passing_year', label: 'Passing year', type: 'number' },
      { key: 'result', label: 'Result', placeholder: 'e.g. CGPA 3.50 / GPA 5.00' },
      { key: 'duration', label: 'Duration', placeholder: 'e.g. 4 years' }
    ]
  },
  family: {
    title: 'Family / Nominee',
    hasFile: false,
    hasVerify: false,
    fields: [
      { key: 'name', label: 'Name *' },
      { key: 'relation', label: 'Relation', type: 'select', options: ['Father', 'Mother', 'Spouse', 'Wife', 'Husband', 'Son', 'Daughter', 'Brother', 'Sister', 'Other'] },
      { key: 'date_of_birth', label: 'Date of birth', type: 'date' },
      { key: 'occupation', label: 'Occupation' },
      { key: 'phone', label: 'Phone' },
      { key: 'nid', label: 'NID / Birth reg. no.' },
      { key: 'address', label: 'Address', wide: true },
      { key: 'is_nominee', label: 'Nominee', type: 'check' },
      { key: 'nominee_percent', label: 'Nominee share (%)', type: 'number' },
      { key: 'is_emergency', label: 'Emergency contact', type: 'check' },
      { key: 'is_dependent', label: 'Dependent', type: 'check' },
      { key: 'remarks', label: 'Remarks', wide: true }
    ]
  },
  training: {
    title: 'Training',
    hasFile: true,
    hasVerify: false,
    fields: [
      { key: 'title', label: 'Training title *', wide: true },
      { key: 'training_type', label: 'Type', type: 'select', options: ['internal', 'external', 'online', 'overseas'] },
      { key: 'organizer', label: 'Organized by' },
      { key: 'location', label: 'Location' },
      { key: 'from_date', label: 'From', type: 'date' },
      { key: 'to_date', label: 'To', type: 'date' },
      { key: 'hours', label: 'Duration (hours)', type: 'number' },
      { key: 'cost', label: 'Cost (BDT)', type: 'number' },
      { key: 'result', label: 'Result / Grade' },
      { key: 'certificate_no', label: 'Certificate no.' },
      { key: 'remarks', label: 'Remarks', wide: true }
    ]
  }
};

// File -> base64 (FileReader), same upload shape as the other HR Ops forms.
export const readFileBase64 = (file: File) =>
  new Promise<{ base64: string; name: string; mime: string }>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ base64: String(r.result).split(',')[1] || '', name: file.name, mime: file.type || 'application/octet-stream' });
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsDataURL(file);
  });

// Fields for one record, rendered into a form — used by RecordModal and by
// the Add Employee form's Experience / Education rows.
export const RecordFields: React.FC<{ kind: RecordKind; form: Record<string, any>; onChange: (f: Record<string, any>) => void }> = ({ kind, form, onChange }) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
    {RECORD_FIELDS[kind].fields.map((f) =>
      f.type === 'check' ? (
        <label key={f.key} className="flex items-center gap-2 text-xs font-semibold text-slate-700 sm:pt-5">
          <input type="checkbox" checked={!!form[f.key]} onChange={(e) => onChange({ ...form, [f.key]: e.target.checked })} /> {f.label}
        </label>
      ) : (
        <div key={f.key} className={f.wide ? 'sm:col-span-2' : ''}>
          <label className={labelCls}>{f.label}</label>
          {f.type === 'textarea' ? (
            <textarea rows={3} value={form[f.key] ?? ''} onChange={(e) => onChange({ ...form, [f.key]: e.target.value })} className={inputCls} />
          ) : f.type === 'select' ? (
            <select value={form[f.key] ?? ''} onChange={(e) => onChange({ ...form, [f.key]: e.target.value })} className={inputCls}>
              <option value="">—</option>
              {f.options!.map((o) => (
                <option key={o} value={o}>
                  {o.charAt(0).toUpperCase() + o.slice(1)}
                </option>
              ))}
            </select>
          ) : (
            <input
              type={f.type || 'text'}
              value={form[f.key] ?? ''}
              placeholder={f.placeholder}
              onChange={(e) => onChange({ ...form, [f.key]: e.target.value })}
              className={inputCls}
            />
          )}
        </div>
      )
    )}
  </div>
);

export const RecordModal: React.FC<{
  token: string;
  employeeId: number;
  kind: RecordKind;
  record: Record<string, any> | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ token, employeeId, kind, record, onClose, onSaved }) => {
  const api = useHrApi(token);
  const cfg = RECORD_FIELDS[kind];
  const [form, setForm] = useState<Record<string, any>>(() => {
    const init: Record<string, any> = {};
    for (const f of cfg.fields) init[f.key] = record ? (record[f.key] ?? (f.type === 'check' ? false : '')) : f.type === 'check' ? false : '';
    if (!record && kind === 'training') init.training_type = 'internal';
    return init;
  });
  const [file, setFile] = useState<File | null>(null);
  const [removeFile, setRemoveFile] = useState(false);
  const [verified, setVerified] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, any> = { ...form };
      if (file) {
        const f = await readFileBase64(file);
        Object.assign(body, { file_base64: f.base64, file_name: f.name, file_mime: f.mime });
      } else if (removeFile) body.remove_file = true;
      if (record) await api.put(`/api/hr-ops/p360/records/${kind}/${record.id}`, body);
      else await api.post(`/api/hr-ops/p360/${employeeId}/records/${kind}`, { ...body, verified });
      onSaved();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={`${record ? 'Edit' : 'Add'} ${cfg.title}`}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={saving} onClick={save}>
            {saving && <Spinner size={14} />} Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        <RecordFields kind={kind} form={form} onChange={setForm} />
        {cfg.hasFile && (
          <div className="rounded-lg border border-dashed border-slate-300 p-3">
            <label className={labelCls}>
              {kind === 'experience' ? 'Experience / release certificate' : kind === 'education' ? 'Certificate / transcript' : 'Certificate'} (PDF or image, up to 8 MB)
            </label>
            {record?.has_file && !file && !removeFile && (
              <div className="flex items-center gap-2 text-xs text-slate-600 mb-2">
                <Paperclip className="w-3.5 h-3.5" /> {record.file_name}
                <button type="button" className="text-rose-600 font-semibold" onClick={() => setRemoveFile(true)}>
                  Remove
                </button>
              </div>
            )}
            <input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] || null)} className="text-xs" />
          </div>
        )}
        {cfg.hasVerify && !record && (
          <label className="flex items-center gap-2 text-xs text-slate-700">
            <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} /> Already verified (certificate / reference checked)
          </label>
        )}
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Operations owned by other modules (their own endpoint + permission)
// ---------------------------------------------------------------------------

export const UploadDocumentModal: React.FC<{ token: string; userId: number; missing: string[]; onClose: () => void; onSaved: () => void }> = ({
  token,
  userId,
  missing,
  onClose,
  onSaved
}) => {
  const api = useHrApi(token);
  const [docType, setDocType] = useState(missing[0] || '');
  const [expiry, setExpiry] = useState('');
  const [needsSign, setNeedsSign] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const save = async () => {
    if (!docType.trim() || !file) return setMsg({ type: 'error', text: 'Pick a document type and a file.' });
    setSaving(true);
    try {
      const f = await readFileBase64(file);
      await api.post('/api/employee-documents', {
        user_id: userId,
        doc_type: docType.trim(),
        file_name: f.name,
        file_mimetype: f.mime,
        file_base64: f.base64,
        expiry_date: expiry || null,
        requires_signature: needsSign
      });
      onSaved();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Upload Document"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={saving} onClick={save}>
            {saving && <Spinner size={14} />} Upload
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        <div>
          <label className={labelCls}>Document type</label>
          <input list="p360-doc-types" value={docType} onChange={(e) => setDocType(e.target.value)} className={inputCls} placeholder="e.g. NID, CV, Educational Certificate" />
          <datalist id="p360-doc-types">
            {[...missing, 'NID', 'Photograph', 'CV / Resume', 'Educational Certificate', 'Experience Certificate', 'Appointment Letter (signed)', 'Medical Certificate', 'Police Clearance', 'Passport'].map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Expiry date (optional)</label>
            <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className={inputCls} />
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-700 pt-5">
            <input type="checkbox" checked={needsSign} onChange={(e) => setNeedsSign(e.target.checked)} /> Employee must e-sign
          </label>
        </div>
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} className="text-xs" />
        <p className="text-[11px] text-slate-400">Saved in Document Vault — the employee can see it from Self Service.</p>
      </div>
    </Modal>
  );
};

export const LoanModal: React.FC<{ token: string; employeeId: number; onClose: () => void; onSaved: () => void }> = ({ token, employeeId, onClose, onSaved }) => {
  const api = useHrApi(token);
  const [total, setTotal] = useState('');
  const [inst, setInst] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const months = Number(total) > 0 && Number(inst) > 0 ? Math.ceil(Number(total) / Number(inst)) : null;
  const save = async () => {
    setSaving(true);
    try {
      await api.post('/api/payroll/advances', { employee_id: employeeId, total_amount: Number(total), monthly_installment: Number(inst), reason });
      onSaved();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Give Loan / Salary Advance"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={saving} onClick={save}>
            {saving && <Spinner size={14} />} Save
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Total amount (BDT)</label>
            <input type="number" value={total} onChange={(e) => setTotal(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Monthly installment (BDT)</label>
            <input type="number" value={inst} onChange={(e) => setInst(e.target.value)} className={inputCls} />
          </div>
        </div>
        <div>
          <label className={labelCls}>Reason</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />
        </div>
        {months && <p className="text-[11px] text-slate-500">Recovered from salary in {months} installment(s) through Payroll.</p>}
      </div>
    </Modal>
  );
};

const DISCIPLINE_TYPES: [string, string][] = [
  ['verbal_warning', 'Verbal Warning'],
  ['written_warning', 'Written Warning'],
  ['show_cause', 'Show Cause'],
  ['suspension', 'Suspension'],
  ['termination', 'Termination']
];
export const DISCIPLINE_LABEL = Object.fromEntries(DISCIPLINE_TYPES);

export const DisciplineModal: React.FC<{ token: string; userId: number; onClose: () => void; onSaved: () => void }> = ({ token, userId, onClose, onSaved }) => {
  const api = useHrApi(token);
  const [type, setType] = useState('show_cause');
  const [reason, setReason] = useState('');
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const save = async () => {
    setSaving(true);
    try {
      await api.post('/api/disciplinary-actions', { user_id: userId, action_type: type, reason, document_text: text });
      onSaved();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Disciplinary Action"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={saving} onClick={save}>
            {saving && <Spinner size={14} />} Issue
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        <div>
          <label className={labelCls}>Action</label>
          <select value={type} onChange={(e) => setType(e.target.value)} className={inputCls}>
            {DISCIPLINE_TYPES.map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Reason</label>
          <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Letter text (optional)</label>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} className={inputCls} />
        </div>
        <p className="text-[11px] text-slate-400">The employee is notified and asked for feedback in Grievance &amp; Disciplinary.</p>
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Dossier — PDF and Excel of whichever sections HR ticks.
// ---------------------------------------------------------------------------

export const DOSSIER_SECTIONS: { key: string; label: string; payroll?: boolean }[] = [
  { key: 'profile', label: 'Personal profile' },
  { key: 'service', label: 'Service history' },
  { key: 'experience', label: 'Previous experience' },
  { key: 'education', label: 'Education & training' },
  { key: 'family', label: 'Family / nominee' },
  { key: 'documents', label: 'Documents' },
  { key: 'attendance', label: 'Attendance (year)' },
  { key: 'leave', label: 'Leave (year)' },
  { key: 'claims', label: 'Claims & conveyance (year)' },
  { key: 'salary', label: 'Salary history & payslips', payroll: true },
  { key: 'loans', label: 'Loans / advances', payroll: true },
  { key: 'other', label: 'Assets, discipline & performance' }
];

const n = (v: any) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }));

interface DossierData {
  overview: P360Overview;
  year: number;
  records?: any;
  documents?: any;
  attendance?: any;
  leave?: any;
  claims?: any;
  salary?: any;
  loans?: any;
  assets?: any;
  discipline?: any;
  performance?: any;
}

export async function loadDossier(api: ReturnType<typeof useHrApi>, overview: P360Overview, picked: Set<string>, year: number): Promise<DossierData> {
  const id = overview.employee.id;
  const sec = (s: string, q = '') => api.get<any>(`/api/hr-ops/p360/${id}/section/${s}${q}`);
  const want = (k: string) => picked.has(k);
  const pay = overview.permissions.payroll;
  const [records, documents, attendance, leave, claims, salary, loans, assets, discipline, performance] = await Promise.all([
    want('experience') || want('education') || want('family') ? sec('records') : null,
    want('documents') ? sec('documents') : null,
    want('attendance') ? sec('attendance_year', `?year=${year}`) : null,
    want('leave') ? sec('leave', `?year=${year}`) : null,
    want('claims') ? sec('claims', `?year=${year}`) : null,
    want('salary') && pay ? sec('salary') : null,
    want('loans') && pay ? sec('loans') : null,
    want('other') ? sec('assets') : null,
    want('other') ? sec('discipline') : null,
    want('other') ? sec('performance') : null
  ]);
  return { overview, year, records, documents, attendance, leave, claims, salary, loans, assets, discipline, performance };
}

// Every section as [title, header, rows] — shared by PDF and Excel.
function dossierTables(d: DossierData, picked: Set<string>): { title: string; head: string[]; rows: (string | number)[][] }[] {
  const o = d.overview;
  const p = o.profile;
  const out: { title: string; head: string[]; rows: (string | number)[][] }[] = [];
  const want = (k: string) => picked.has(k);
  if (want('profile')) {
    out.push({
      title: 'Personal Profile',
      head: ['Field', 'Value'],
      rows: [
        ['Date of birth', p.date_of_birth ? `${fmtDate(p.date_of_birth)}${p.age_years != null ? ` (${p.age_years} yrs)` : ''}` : ''],
        ['Gender', p.gender || ''],
        ['Blood group', p.blood_group || ''],
        ['Marital status', p.marital_status || ''],
        ['Religion', p.religion || ''],
        ['Nationality', p.nationality || ''],
        ['NID', p.nid || ''],
        ['Mobile', p.phone || ''],
        ['Email', [p.email, p.personal_email].filter(Boolean).join(', ')],
        ['Present address', p.present_address || ''],
        ['Permanent address', p.permanent_address || ''],
        ['Employment category', p.employment_category || ''],
        ['Job base', o.employee.job_base || ''],
        ['Probation until', fmtDate(o.employee.probation_end_date)],
        ['Confirmed on', fmtDate(o.employee.confirmation_date)],
        ['Previous experience', serviceLength(o.summary.prior_experience_months)],
        ['Total experience', serviceLength(o.summary.total_experience_months)]
      ].map(([k, v]) => [k, v || '—'])
    });
  }
  if (want('service'))
    out.push({
      title: 'Service History',
      head: ['Date', 'Event', 'Details'],
      rows: o.events.map((e) => [fmtDate(e.date), e.title + (e.status === 'pending' ? ' (pending)' : ''), [e.detail, e.reason].filter(Boolean).join(' — ')])
    });
  if (want('experience') && d.records)
    out.push({
      title: 'Previous Experience',
      head: ['Company', 'Designation', 'From', 'To', 'Last Salary', 'Reason for leaving', 'Verified'],
      rows: d.records.experience.map((x: any) => [x.company_name, x.designation || '', fmtDate(x.from_date), fmtDate(x.to_date), n(x.last_salary), x.leaving_reason || '', x.verified ? 'Yes' : 'No'])
    });
  if (want('education') && d.records) {
    out.push({
      title: 'Education',
      head: ['Degree', 'Major', 'Institute', 'Board / University', 'Year', 'Result', 'Verified'],
      rows: d.records.education.map((x: any) => [x.degree, x.major || '', x.institute || '', x.board_university || '', x.passing_year || '', x.result || '', x.verified ? 'Yes' : 'No'])
    });
    out.push({
      title: 'Training',
      head: ['Title', 'Type', 'Organizer', 'From', 'To', 'Hours', 'Result'],
      rows: d.records.training.map((x: any) => [x.title, x.training_type || '', x.organizer || '', fmtDate(x.from_date), fmtDate(x.to_date), n(x.hours), x.result || ''])
    });
  }
  if (want('family') && d.records)
    out.push({
      title: 'Family / Nominee / Emergency Contact',
      head: ['Name', 'Relation', 'Phone', 'Nominee', 'Share %', 'Emergency', 'Dependent'],
      rows: d.records.family.map((x: any) => [x.name, x.relation || '', x.phone || '', x.is_nominee ? 'Yes' : '', n(x.nominee_percent), x.is_emergency ? 'Yes' : '', x.is_dependent ? 'Yes' : ''])
    });
  if (want('documents') && d.documents)
    out.push({
      title: `Documents${d.documents.missing.length ? ` (missing: ${d.documents.missing.join(', ')})` : ''}`,
      head: ['Type', 'File', 'Uploaded', 'Expiry', 'Signed'],
      rows: d.documents.documents.map((x: any) => [x.doc_type, x.file_name, fmtDate(x.uploaded_at), fmtDate(x.expiry_date) + (x.expired ? ' (expired)' : ''), x.requires_signature ? (x.is_signed ? 'Yes' : 'Pending') : ''])
    });
  if (want('attendance') && d.attendance)
    out.push({
      title: `Attendance ${d.year}`,
      head: ['Month', 'Working', 'Present', 'Leave', 'Absent', 'Late', 'Extreme late', 'Attendance %'],
      rows: [
        ...d.attendance.months.map((m: any) => [monthLabel(m.month), m.working_days, m.present, m.leave, m.absent, m.late, m.extreme_late, m.attendance_percent ?? '']),
        ...(d.attendance.total
          ? [['Total', d.attendance.total.working_days, d.attendance.total.present, d.attendance.total.leave, d.attendance.total.absent, d.attendance.total.late, d.attendance.total.extreme_late, d.attendance.total.attendance_percent ?? '']]
          : [])
      ]
    });
  if (want('leave') && d.leave) {
    out.push({ title: `Leave Balance ${d.year}`, head: ['Leave type', 'Taken', 'Pending', 'Remaining'], rows: d.leave.balances.map((b: any) => [b.label, b.taken, b.pending, b.balance]) });
    out.push({
      title: 'Leave Applications',
      head: ['Type', 'From', 'To', 'Days', 'Status', 'Purpose'],
      rows: d.leave.applications.filter((a: any) => (a.start_date || '').startsWith(String(d.year))).map((a: any) => [a.leave_label, fmtDate(a.start_date), fmtDate(a.end_date), a.day_count, a.status, a.purpose || ''])
    });
  }
  if (want('claims') && d.claims) {
    out.push({
      title: `Conveyance Claims ${d.year}`,
      head: ['Date', 'Category', 'Claimed', 'Approved', 'Status', 'Description'],
      rows: d.claims.claims.map((c: any) => [fmtDate(c.claim_date), c.category, n(c.amount), n(c.approved_amount ?? (c.status === 'approved' ? c.amount : null)), c.status, c.description || ''])
    });
    if (d.claims.bills.length)
      out.push({ title: 'Conveyance Bills', head: ['Bill date', 'Items', 'Amount', 'Paid', 'Voucher'], rows: d.claims.bills.map((b: any) => [fmtDate(b.bill_date), b.items, n(b.amount), b.is_disbursed ? 'Yes' : 'No', b.voucher_no || '']) });
  }
  if (want('salary') && d.salary) {
    out.push({
      title: 'Salary Structure History',
      head: ['Effective', 'Basic', 'House Rent', 'Medical', 'Conveyance', 'Other', 'Gross', 'Change'],
      rows: d.salary.structures.map((s: any) => [
        fmtDate(s.effective_date),
        n(s.basic_salary),
        n(s.house_rent),
        n(s.medical_allowance),
        n(s.conveyance_allowance),
        n(s.other_allowance),
        n(s.gross_salary),
        s.change != null ? `${s.change >= 0 ? '+' : ''}${n(s.change)} (${s.change_percent ?? 0}%)` : ''
      ])
    });
    out.push({
      title: 'Payslips',
      head: ['Month', 'Present', 'Absent', 'Gross Earned', 'Deductions', 'Net Salary', 'Status'],
      rows: d.salary.payrolls.map((r: any) => [monthLabel(r.month_year), r.present_days, r.absent_days, n(r.gross_earned), n(r.total_deduction), n(r.net_salary), r.payment_status])
    });
  }
  if (want('loans') && d.loans)
    out.push({
      title: `Loans / Advances (outstanding ${n(d.loans.outstanding)})`,
      head: ['Given', 'Amount', 'Installment', 'Recovered', 'Remaining', 'Status', 'Reason'],
      rows: d.loans.loans.map((l: any) => [fmtDate(l.created_at), n(l.total_amount), n(l.monthly_installment), n(l.paid_amount), n(l.remaining), l.status, l.reason || ''])
    });
  if (want('other')) {
    if (d.assets?.assets.length)
      out.push({ title: 'Assets', head: ['Asset', 'Tag', 'Serial', 'Assigned', 'Returned'], rows: d.assets.assets.map((a: any) => [a.name, a.asset_tag || '', a.serial_number || '', fmtDate(a.assigned_date), a.returned_date ? fmtDate(a.returned_date) : 'With employee']) });
    if (d.discipline?.actions.length)
      out.push({ title: 'Disciplinary Actions', head: ['Date', 'Action', 'Reason', 'Status'], rows: d.discipline.actions.map((a: any) => [fmtDate(a.issued_at), DISCIPLINE_LABEL[a.action_type] || a.action_type, a.reason, a.status]) });
    if (d.performance?.reviews.length)
      out.push({ title: 'Performance Reviews', head: ['Cycle', 'Period', 'Rating', 'Reviewer', 'Status'], rows: d.performance.reviews.map((r: any) => [r.cycle, `${fmtDate(r.period_start)} – ${fmtDate(r.period_end)}`, r.overall_rating ?? '', r.reviewer || '', r.status]) });
  }
  return out;
}

// jsPDF's built-in Helvetica has no arrow or Taka glyph — swap the two this
// app's own text uses.
export const pdfSafe = (v: any) =>
  String(v ?? '')
    .replace(/→/g, '->')
    .replace(/৳/g, 'Tk ');

export async function saveDossierPdf(d: DossierData, picked: Set<string>) {
  const e = d.overview.employee;
  const logo = await loadImageElement(credenceLogo);
  const doc = new jsPDF();
  let y = drawPdfLetterhead(doc, logo, {
    reportTitle: 'Employee Dossier',
    filtersLabel: 'Employee:',
    filters: [
      ['Name', e.name],
      ['Employee ID', e.employee_code || '—'],
      ['Designation', e.designation || '—'],
      ['Department', e.department || '—'],
      ['Grade', e.grade || '—'],
      ['Joining Date', fmtDate(e.joining_date)],
      ['Service Length', serviceLength(e.service_length_months)],
      ...(d.overview.permissions.payroll && e.gross_salary != null ? ([['Current Gross', `BDT ${n(e.gross_salary)}`]] as [string, string][]) : [])
    ]
  });
  for (const t of dossierTables(d, picked)) {
    if (y > 260) {
      doc.addPage();
      y = 16;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(30, 41, 59);
    doc.text(pdfSafe(t.title), 14, y + 4);
    autoTable(doc, {
      startY: y + 6,
      head: [t.head.map(pdfSafe)],
      body: t.rows.length ? t.rows.map((r) => r.map((c) => pdfSafe(c))) : [[{ content: 'No records', colSpan: t.head.length, styles: { textColor: [148, 163, 184] } } as any]],
      styles: { fontSize: 7.5, cellPadding: 1.6 },
      headStyles: { fillColor: [37, 99, 235] },
      margin: { left: 14, right: 14 }
    });
    y = (doc as any).lastAutoTable.finalY + 6;
  }
  finalizePdfPageNumbers(doc);
  await savePdfCrossPlatform(doc, `Employee_Dossier_${e.name.replace(/\s+/g, '_')}.pdf`);
}

export function saveDossierExcel(d: DossierData, picked: Set<string>) {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  for (const t of dossierTables(d, picked)) {
    let name = t.title.replace(/[\\/?*[\]:]/g, '').slice(0, 31);
    while (used.has(name)) name = name.slice(0, 29) + '_' + used.size;
    used.add(name);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([t.head, ...t.rows]), name);
  }
  XLSX.writeFile(wb, `Employee_Dossier_${d.overview.employee.name.replace(/\s+/g, '_')}.xlsx`);
}

export const DossierModal: React.FC<{ token: string; overview: P360Overview; onClose: () => void }> = ({ token, overview, onClose }) => {
  const api = useHrApi(token);
  const sections = DOSSIER_SECTIONS.filter((s) => !s.payroll || overview.permissions.payroll);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(sections.map((s) => s.key)));
  const [year, setYear] = useState(new Date().getFullYear());
  const [busy, setBusy] = useState<'' | 'pdf' | 'xlsx'>('');
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const run = async (kind: 'pdf' | 'xlsx') => {
    setBusy(kind);
    try {
      const data = await loadDossier(api, overview, picked, year);
      if (kind === 'pdf') await saveDossierPdf(data, picked);
      else saveDossierExcel(data, picked);
      onClose();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy('');
    }
  };
  const thisYear = new Date().getFullYear();
  return (
    <Modal
      title="Employee Dossier"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnGhost} disabled={!!busy || picked.size === 0} onClick={() => run('xlsx')}>
            {busy === 'xlsx' && <Spinner size={14} />} Excel
          </button>
          <button type="button" className={btnPrimary} disabled={!!busy || picked.size === 0} onClick={() => run('pdf')}>
            {busy === 'pdf' && <Spinner size={14} />} PDF
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        <p className="text-xs text-slate-500">Everything about {overview.employee.name} in one file. Tick what to include.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {sections.map((s) => (
            <label key={s.key} className="flex items-center gap-2 text-xs text-slate-700">
              <input
                type="checkbox"
                checked={picked.has(s.key)}
                onChange={(e) =>
                  setPicked((p) => {
                    const next = new Set(p);
                    if (e.target.checked) next.add(s.key);
                    else next.delete(s.key);
                    return next;
                  })
                }
              />
              {s.label}
            </label>
          ))}
        </div>
        <div className="max-w-[160px]">
          <label className={labelCls}>Year for attendance / leave / claims</label>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} className={inputCls}>
            {Array.from({ length: 6 }, (_, i) => thisYear - i).map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </div>
    </Modal>
  );
};
