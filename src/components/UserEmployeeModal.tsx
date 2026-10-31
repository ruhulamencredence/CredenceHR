// Admin Panel -> Users -> "Employee" on a row: the Employee record linked to
// that login account, read only (GET /api/employees/by-user/:id, which needs
// the "employees" module — the button only shows with it). "Open in
// Employees" jumps to the Employees list searched for this person.

import React, { useEffect, useState } from 'react';
import { X, IdCard, ExternalLink } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';

type Field = [label: string, key: string, kind?: 'date' | 'bool'];
const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: 'Job',
    fields: [
      ['Employee ID', 'employee_id'],
      ['Designation', 'designation'],
      ['Department', 'department'],
      ['Division', 'division'],
      ['Unit', 'unit'],
      ['Branch', 'branch'],
      ['Joining date', 'joining_date', 'date'],
      ['Job status', 'job_status'],
      ['Employment category', 'employment_category'],
      ['Job base', 'job_base'],
      ['Review month', 'review_month']
    ]
  },
  {
    title: 'Contact',
    fields: [
      ['Office email', 'email'],
      ['Personal email', 'personal_email'],
      ['Mobile', 'mobile'],
      ['Phone', 'phone'],
      ['Telephone', 'telephone'],
      ['Present address', 'present_address'],
      ['Permanent address', 'permanent_address']
    ]
  },
  {
    title: 'Personal',
    fields: [
      ['Gender', 'gender'],
      ['Date of birth', 'date_of_birth', 'date'],
      ['Blood group', 'blood_group'],
      ['Marital status', 'marital_status'],
      ['Religion', 'religion'],
      ['Nationality', 'nationality'],
      ['NID / SSN', 'nid_ssn'],
      ['Foreigner', 'is_foreigner', 'bool']
    ]
  }
];

export const UserEmployeeModal: React.FC<{
  token: string;
  account: { id: number; name: string };
  onClose: () => void;
  // Opens the Employees page searched for this employee.
  onOpenEmployees?: (search: string) => void;
}> = ({ token, account, onClose, onOpenEmployees }) => {
  const [state, setState] = useState<{ loading: boolean; error?: string; employee?: Record<string, any> | null }>({ loading: true });

  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl(`/api/employees/by-user/${account.id}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || 'Could not load the employee record.');
        if (!cancelled) setState({ loading: false, employee: data.linked ? data.employee : null });
      })
      .catch((e) => !cancelled && setState({ loading: false, error: e.message }));
    return () => {
      cancelled = true;
    };
  }, [token, account.id]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const emp = state.employee;
  const show = (f: Field) => {
    const v = emp?.[f[1]];
    if (f[2] === 'bool') return v ? 'Yes' : null;
    if (v == null || String(v).trim() === '') return null;
    return f[2] === 'date' ? formatDate(v) : String(v);
  };

  return (
    <div className="fixed inset-0 z-[95] liquid-glass-backdrop flex items-end sm:items-center justify-center p-3 sm:p-4" onClick={onClose}>
      <div role="dialog" aria-label={`Employee record of ${account.name}`} onClick={(e) => e.stopPropagation()} className="liquid-glass liquid-glass-in rounded-[32px] w-full max-w-2xl max-h-[90vh] flex flex-col">
        <button type="button" onClick={onClose} aria-label="Close" className="liquid-glass-chip absolute top-3.5 right-3.5 z-10 p-1.5 rounded-full text-slate-600 hover:text-slate-900">
          <X className="w-4 h-4" />
        </button>
        <div className="px-6 pt-6 pb-3 flex items-center gap-3">
          <div className="liquid-glass-inset w-12 h-12 rounded-[16px] flex items-center justify-center shrink-0">
            <IdCard className="w-6 h-6 text-violet-600" />
          </div>
          <div className="min-w-0 pr-8">
            <h2 className="text-lg font-bold text-slate-900 truncate">{emp?.name || account.name}</h2>
            <p className="text-sm text-slate-600 truncate">
              {emp ? [emp.employee_id, emp.designation, emp.department].filter(Boolean).join(' · ') || 'Employee record' : 'Employee record'}
              {emp && !emp.is_active && <span className="ml-2 text-[11px] font-semibold text-rose-600">Inactive</span>}
            </p>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-2">
          {state.loading ? (
            <p className="py-10 text-center text-sm text-slate-500">Loading…</p>
          ) : state.error ? (
            <p className="py-10 text-center text-sm font-semibold text-rose-600">{state.error}</p>
          ) : !emp ? (
            <div className="liquid-glass-inset rounded-[20px] px-5 py-8 text-center text-sm text-slate-600">
              This account isn't linked to an Employee yet. Link it from Employees (Link Existing User).
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {GROUPS.map((g) => {
                const rows = g.fields.map((f) => [f[0], show(f)] as const).filter(([, v]) => v != null);
                if (rows.length === 0) return null;
                return (
                  <section key={g.title} className="liquid-glass-inset rounded-[20px] px-4 py-3">
                    <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">{g.title}</h3>
                    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
                      {rows.map(([label, v]) => (
                        <div key={label} className="min-w-0">
                          <dt className="text-[11px] text-slate-500">{label}</dt>
                          <dd className="text-sm font-medium text-slate-900 break-words">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-6 pt-3 pb-5 flex gap-2">
          {emp && onOpenEmployees && (
            <button
              type="button"
              onClick={() => onOpenEmployees(String(emp.employee_id || emp.name || ''))}
              className="liquid-glass-button flex-1 py-3 rounded-full font-semibold inline-flex items-center justify-center gap-2"
            >
              <ExternalLink className="w-4 h-4" /> Open in Employees
            </button>
          )}
          <button type="button" onClick={onClose} className="liquid-glass-chip px-6 py-3 rounded-full font-semibold text-slate-700">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
