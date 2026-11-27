/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> New Joiner Onboarding: the Appointment Letter, issued at
// Hire — before the joiner is an Employee. HR types the offered salary and
// probation, previews the letter from the Appointment Letter template, edits
// it if needed and issues it. The joiner gets it in My Onboarding, signs it
// and uploads the signed copy; on approval it moves onto the new Employee.
// POST /api/hr-ops/joiner-onboarding/:id/appointment-letter[/preview].

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, FileSignature, Eye } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { PdfPreviewModal } from './PdfPreviewModal';
import { letterPdfBytes, saveLetterPdf } from './HrOpsShared';
import { letterFileName } from '../lib/hrLetterPdf';

const field = 'liquid-glass-inset block w-full px-3 py-2 rounded-xl text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600';
const label = 'block text-[11px] font-semibold text-slate-600 mb-1';

export interface JoinerLetterCompany {
  name: string;
  address?: string;
  signatory_name?: string;
  signatory_designation?: string;
}

export const JoinerLetterPopup: React.FC<{
  token: string;
  applicationId: number;
  joinerName: string;
  company: JoinerLetterCompany;
  onClose: () => void;
  onIssued: (refNo: string) => void;
}> = ({ token, applicationId, joinerName, company, onClose, onIssued }) => {
  const today = new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 10);
  const [gross, setGross] = useState('');
  const [basic, setBasic] = useState('');
  const [probation, setProbation] = useState('6');
  const [letterDate, setLetterDate] = useState(today);
  const [preview, setPreview] = useState<{ ref_no: string; subject: string; body: string; letter_date: string } | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pdf, setPdf] = useState<Uint8Array | null>(null);

  const post = async (path: string, payload: any) => {
    const res = await fetch(apiUrl(`/api/hr-ops/joiner-onboarding/${applicationId}/appointment-letter${path}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Something went wrong');
    return data;
  };
  const input = () => ({ gross_salary: gross || null, basic_salary: basic || null, probation_months: probation || null, letter_date: letterDate });

  const makePreview = async () => {
    setError('');
    if (!(Number(gross) > 0)) return setError('Type the gross salary offered.');
    setBusy(true);
    try {
      const r = await post('/preview', input());
      setPreview(r);
      setSubject(r.subject);
      setBody(r.body);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const issue = async () => {
    setError('');
    setBusy(true);
    try {
      const r = await post('', { ...input(), subject, body });
      onIssued(r.ref_no);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[95] liquid-glass-backdrop flex items-end sm:items-center justify-center p-3 sm:p-4" onClick={onClose}>
      <div role="dialog" aria-label="Issue Appointment Letter" className="liquid-glass liquid-glass-in rounded-[32px] max-w-2xl w-full max-h-[92vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onClose} className="liquid-glass-chip absolute top-3.5 right-3.5 z-10 p-1.5 text-slate-600 hover:text-slate-900 rounded-full" aria-label="Close">
          <X className="w-4 h-4" />
        </button>
        <div className="px-5 pt-5 pb-2 pr-14">
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <FileSignature className="w-4 h-4" /> Appointment Letter — {joinerName}
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">They get it in My Onboarding, sign it and upload the signed copy with their form.</p>
        </div>
        <div className="px-5 pb-4 overflow-y-auto space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <label className={label}>
              Gross salary (BDT) *
              <input className={field} inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value.replace(/[^\d.]/g, ''))} />
            </label>
            <label className={label}>
              Basic salary (BDT)
              <input className={field} inputMode="decimal" value={basic} onChange={(e) => setBasic(e.target.value.replace(/[^\d.]/g, ''))} />
            </label>
            <label className={label}>
              Probation (months)
              <input className={field} inputMode="numeric" value={probation} onChange={(e) => setProbation(e.target.value.replace(/\D/g, ''))} />
            </label>
            <label className={label}>
              Letter date
              <input type="date" className={field} value={letterDate} onChange={(e) => setLetterDate(e.target.value)} />
            </label>
          </div>
          {!preview ? (
            <button type="button" disabled={busy} onClick={makePreview} className="liquid-glass-button rounded-full px-5 py-2.5 text-xs font-semibold disabled:opacity-50">
              {busy ? 'Preparing…' : 'Prepare the letter'}
            </button>
          ) : (
            <>
              <div className="text-[11px] text-slate-500">
                Ref <b className="font-mono text-slate-700">{preview.ref_no}</b> · from the Appointment Letter template — edit anything before issuing.
              </div>
              <label className={label}>
                Subject
                <input className={field} value={subject} onChange={(e) => setSubject(e.target.value)} />
              </label>
              <label className={label}>
                Letter
                <textarea className={`${field} font-mono text-xs leading-relaxed`} rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
              </label>
              <button type="button" onClick={makePreview} disabled={busy} className="text-[11px] font-semibold text-blue-700 hover:underline">
                Fill it again from the salary above
              </button>
            </>
          )}
          {error && <p className="text-xs text-rose-600">{error}</p>}
        </div>
        <div className="px-5 py-4 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className="liquid-glass-chip px-5 py-2.5 rounded-full text-slate-700 text-xs font-semibold">
            Cancel
          </button>
          {preview && (
            <button
              type="button"
              onClick={async () => setPdf(await letterPdfBytes(company, { ref_no: preview.ref_no, letter_date: letterDate, subject, body, employee_name: joinerName }, true))}
              className="liquid-glass-chip px-5 py-2.5 rounded-full text-slate-700 text-xs font-semibold inline-flex items-center gap-1.5"
            >
              <Eye className="w-3.5 h-3.5" /> View PDF
            </button>
          )}
          {preview && (
            <button type="button" disabled={busy || !subject.trim() || !body.trim()} onClick={issue} className="liquid-glass-button rounded-full px-5 py-2.5 text-xs font-semibold disabled:opacity-50">
              {busy ? 'Issuing…' : 'Issue to the joiner'}
            </button>
          )}
        </div>
      </div>
      <PdfPreviewModal
        isOpen={pdf !== null}
        pdfBytes={pdf}
        filename={letterFileName(preview?.ref_no || 'draft', joinerName)}
        onClose={() => setPdf(null)}
        onDownload={() => saveLetterPdf(company, { ref_no: preview!.ref_no, letter_date: letterDate, subject, body, employee_name: joinerName })}
      />
    </div>,
    document.body
  );
};
