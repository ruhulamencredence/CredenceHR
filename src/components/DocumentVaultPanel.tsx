import React, { useEffect, useState } from 'react';
import { FolderLock, Plus, X, AlertTriangle, CheckCircle2, FileText, Trash2, Download, ShieldCheck } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface DocumentVaultPanelProps {
  token: string;
}

interface VaultDocument {
  id: number;
  user_id: number;
  user_name: string | null;
  doc_type: string;
  file_name: string;
  requires_signature: boolean;
  is_signed: boolean;
  expiry_date: string | null;
  uploaded_at: string;
}

const DOC_TYPE_PRESETS = ['Appointment Letter', 'NID / Passport Copy', 'Employment Contract', 'Certificate', 'Experience Letter', 'Other'];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function expiryBadge(expiry: string | null): { text: string; className: string } | null {
  if (!expiry) return null;
  const days = Math.ceil((new Date(expiry).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (days < 0) return { text: 'Expired', className: 'bg-rose-50 text-rose-700 border-rose-200' };
  if (days <= 30) return { text: `Expires in ${days}d`, className: 'bg-amber-50 text-amber-700 border-amber-200' };
  return { text: `Valid to ${expiry}`, className: 'bg-slate-100 text-slate-500 border-slate-200' };
}

// Admin Panel -> HR Advanced -> "Document Vault" — upload documents against
// an employee (Appointment Letter, contract, certificates…), track
// signature status and expiry (visa/license style dates), and download/view
// the stored file. Management-only view — the backend's
// POST /api/employee-documents/:id/sign already lets the document's own
// employee e-sign it (typed name + timestamp), just not wired into a
// self-service page yet, same "layer on later" note as the other 5 HR
// Advanced panels.
export const DocumentVaultPanel: React.FC<DocumentVaultPanelProps> = ({ token }) => {
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const [documents, setDocuments] = useState<VaultDocument[]>([]);
  const [users, setUsers] = useState<{ id: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [showUpload, setShowUpload] = useState(false);
  const [uploadUserId, setUploadUserId] = useState('');
  const [uploadDocType, setUploadDocType] = useState(DOC_TYPE_PRESETS[0]);
  const [uploadRequiresSig, setUploadRequiresSig] = useState(false);
  const [uploadExpiry, setUploadExpiry] = useState('');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const fetchAll = async () => {
    setLoading(true);
    setError('');
    try {
      const [docsRes, usersRes] = await Promise.all([
        fetch(apiUrl('/api/employee-documents'), { headers: authHeaders }),
        fetch(apiUrl('/api/users'), { headers: authHeaders })
      ]);
      const docsData = await docsRes.json();
      if (!docsRes.ok) throw new Error(docsData.error || 'Failed to load documents');
      setDocuments(Array.isArray(docsData) ? docsData : []);
      const usersData = await usersRes.json();
      if (usersRes.ok) setUsers(Array.isArray(usersData) ? usersData.filter((u: any) => u.role !== 'superadmin') : []);
    } catch (err: any) {
      setError(err.message || 'Failed to load documents');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const upload = async () => {
    if (!uploadUserId || !uploadFile) {
      setError('Employee and a file are required.');
      return;
    }
    setUploading(true);
    setError('');
    setSuccess('');
    try {
      const base64 = await fileToBase64(uploadFile);
      const res = await fetch(apiUrl('/api/employee-documents'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          user_id: Number(uploadUserId),
          doc_type: uploadDocType,
          file_name: uploadFile.name,
          file_mimetype: uploadFile.type || 'application/octet-stream',
          file_base64: base64,
          requires_signature: uploadRequiresSig,
          expiry_date: uploadExpiry || null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to upload document');
      setDocuments((prev) => [data, ...prev]);
      setShowUpload(false);
      setUploadUserId('');
      setUploadRequiresSig(false);
      setUploadExpiry('');
      setUploadFile(null);
      setSuccess('Document uploaded.');
    } catch (err: any) {
      setError(err.message || 'Failed to upload document');
    } finally {
      setUploading(false);
    }
  };

  const deleteDocument = async (id: number) => {
    if (!window.confirm('Delete this document? This cannot be undone.')) return;
    setDeletingId(id);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/employee-documents/${id}`), { method: 'DELETE', headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete document');
      setDocuments((prev) => prev.filter((d) => d.id !== id));
    } catch (err: any) {
      setError(err.message || 'Failed to delete document');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-6 border-b border-slate-200 flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
            <FolderLock className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-800">Document Vault</h1>
            <p className="text-xs text-slate-500 mt-0.5 max-w-md">Store employee documents, track e-signature and expiry status.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowUpload((v) => !v)}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> Upload Document
        </button>
      </div>

      {showUpload && (
        <div className="px-6 py-5 border-b border-slate-200 bg-slate-50/60 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">Employee</label>
            <select value={uploadUserId} onChange={(e) => setUploadUserId(e.target.value)} className="w-44 px-3 py-2 text-xs border border-slate-200 rounded-xl">
              <option value="">Select…</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">Document Type</label>
            <select value={uploadDocType} onChange={(e) => setUploadDocType(e.target.value)} className="w-44 px-3 py-2 text-xs border border-slate-200 rounded-xl">
              {DOC_TYPE_PRESETS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">Expiry (optional)</label>
            <input type="date" value={uploadExpiry} onChange={(e) => setUploadExpiry(e.target.value)} className="px-3 py-2 text-xs border border-slate-200 rounded-xl" />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">File</label>
            <input
              type="file"
              onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
              className="text-xs w-56 file:mr-2 file:py-1.5 file:px-2.5 file:rounded-lg file:border-0 file:text-xs file:bg-slate-800 file:text-white"
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-slate-700 mb-2 cursor-pointer">
            <input type="checkbox" checked={uploadRequiresSig} onChange={(e) => setUploadRequiresSig(e.target.checked)} className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600" />
            Requires employee signature
          </label>
          <button
            type="button"
            onClick={upload}
            disabled={uploading}
            className="flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-xl disabled:opacity-50 mb-0.5"
          >
            {uploading && <Spinner size={12} />}
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
          <button type="button" onClick={() => setShowUpload(false)} className="px-2.5 py-2 text-slate-400 hover:text-slate-600">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {error && (
        <div className="mx-6 mt-4 px-4 py-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
        </div>
      )}
      {success && (
        <div className="mx-6 mt-4 px-4 py-2.5 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded-xl flex items-center gap-2">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> {success}
        </div>
      )}

      {loading ? (
        <div className="flex flex-col items-center justify-center py-16 text-slate-400">
          <Spinner size={24} className="mb-2" />
          <p className="text-xs">Loading…</p>
        </div>
      ) : (
        <div className="p-4 space-y-2">
          {documents.map((d) => {
            const badge = expiryBadge(d.expiry_date);
            return (
              <div key={d.id} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-4 py-3">
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-slate-800 truncate">
                      {d.doc_type} <span className="text-slate-400 font-normal">— {d.user_name}</span>
                    </p>
                    <p className="text-[11px] text-slate-400 truncate">{d.file_name}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {d.requires_signature && (
                    <span
                      className={`flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                        d.is_signed ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'
                      }`}
                    >
                      <ShieldCheck className="w-3 h-3" /> {d.is_signed ? 'Signed' : 'Unsigned'}
                    </span>
                  )}
                  {badge && <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${badge.className}`}>{badge.text}</span>}
                  <a
                    href={apiUrl(`/api/employee-documents/${d.id}/file`)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => {
                      // Attach the auth token via a short-lived query-string-free
                      // approach isn't available for a plain <a> download, so
                      // this relies on the same-origin fetch+blob trick instead.
                      e.preventDefault();
                      fetch(apiUrl(`/api/employee-documents/${d.id}/file`), { headers: authHeaders })
                        .then((r) => r.blob())
                        .then((blob) => {
                          const url = URL.createObjectURL(blob);
                          window.open(url, '_blank');
                        });
                    }}
                    className="p-1.5 text-slate-400 hover:text-blue-600 rounded-lg hover:bg-blue-50"
                    title="View / Download"
                  >
                    <Download className="w-3.5 h-3.5" />
                  </a>
                  <button
                    type="button"
                    onClick={() => deleteDocument(d.id)}
                    disabled={deletingId === d.id}
                    className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 disabled:opacity-50"
                    title="Delete"
                  >
                    {deletingId === d.id ? <Spinner size={14} /> : <Trash2 className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>
            );
          })}
          {documents.length === 0 && <p className="px-2 py-10 text-center text-xs text-slate-400">No documents uploaded yet.</p>}
        </div>
      )}
    </div>
  );
};
