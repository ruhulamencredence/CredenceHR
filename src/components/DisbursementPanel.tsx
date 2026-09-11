import React, { useEffect, useMemo, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Banknote, Filter, Printer, CheckSquare, Square, RotateCcw, X, ReceiptText } from 'lucide-react';
import { ConveyanceBill, User } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate, todayDateOnlyString } from '../lib/formatDate';
import credenceLogo from '../assets/credence-logo.png';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import { Spinner } from './Spinner';

interface DisbursementPanelProps {
  token: string;
  users: User[];
}

// Auto-suggested Voucher No — "PV-<billId>-<YYYYMMDD>". Admin can overwrite it
// in the confirm dialog before disbursing; whatever is confirmed there is what
// gets saved and later reprinted on the Voucher PDF.
const suggestVoucherNo = (billId: number) => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `PV-${billId}-${y}${m}${day}`;
};

// Admin Panel -> Conveyance Disbursement (Superadmin + explicitly-granted
// Admins only — see ADMIN_MODULES/'disbursement'). Sits one step downstream of
// Conveyance Bill Claim: once a Bill's items have been approved and finalized
// there, this is where the money actually going out gets recorded (a Voucher
// No + who/when) and a printable Payment Voucher is produced for the
// claimant's signature. Kept as its own module so an Admin can be allowed to
// BUILD bills without also being trusted to authorize payouts, and vice versa.
export const DisbursementPanel: React.FC<DisbursementPanelProps> = ({ token, users }) => {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const plainUsers = users.filter((u) => u.role === 'user');

  const [bills, setBills] = useState<ConveyanceBill[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'disbursed'>('pending');
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const fetchBills = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const params = new URLSearchParams();
      if (userFilter) params.set('user_id', userFilter);
      const res = await fetch(apiUrl(`/api/conveyance-bills?${params.toString()}`), { headers: authHeaders });
      if (res.ok) {
        setBills(await res.json());
      } else {
        setLoadError('Failed to load conveyance bills.');
      }
    } catch (err) {
      console.error('Failed to load conveyance bills', err);
      setLoadError('Failed to load conveyance bills.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBills();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleBills = useMemo(
    () =>
      bills.filter((b) => {
        if (statusFilter === 'pending') return !b.is_disbursed;
        if (statusFilter === 'disbursed') return !!b.is_disbursed;
        return true;
      }),
    [bills, statusFilter]
  );

  const selectableIds = useMemo(() => visibleBills.filter((b) => !b.is_disbursed).map((b) => b.id), [visibleBills]);
  const allSelectableChecked = selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));

  const toggleOne = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => {
      if (allSelectableChecked) return new Set();
      return new Set(selectableIds);
    });
  };

  // ---- Payment Voucher PDF ----
  // Shared by both the auto-download-on-disburse flow below and the manual
  // per-row Printer button (for reprinting later, e.g. after closing the app
  // without saving the first download). The list endpoint (GET
  // /api/conveyance-bills) only returns item_count/total_amount, not the
  // actual line items, so this always does its own GET .../:id fetch first
  // rather than trusting whatever's already sitting in `bills` state.
  const buildAndSaveVoucherPdf = async (billId: number) => {
    const res = await fetch(apiUrl(`/api/conveyance-bills/${billId}`), { headers: authHeaders });
    if (!res.ok) throw new Error(`Failed to load Bill CB-${billId} for its voucher.`);
    const bill: ConveyanceBill = await res.json();

    const logoImg = await loadImageElement(credenceLogo);
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const items = bill.items || [];

    const letterheadOptions = {
      reportTitle: 'Conveyance Payment Voucher',
      filters: [
        ['Voucher No', bill.voucher_no || '—'],
        ['Paid To', bill.user_name || '—'],
        ['Bill No', `CB-${bill.id}`],
        ['Bill Date', formatDate(bill.bill_date) || '—'],
        ['Disbursed On', bill.disbursed_at ? formatDate(bill.disbursed_at) : '—']
      ] as [string, string][]
    };
    const contentStartY = drawPdfLetterhead(doc, logoImg, letterheadOptions);

    autoTable(doc, {
      startY: contentStartY,
      margin: { top: contentStartY, left: 8, right: 8 },
      head: [['SL', 'Date', 'Particulars', 'From', 'To', 'Distance (KM)', 'Amount']],
      body: items.map((it, idx) => [
        String(idx + 1),
        formatDate(it.entry_date) || '',
        it.particulars || '',
        it.from_location || '',
        it.to_location || '',
        it.distance_km != null ? String(it.distance_km) : '',
        it.amount.toFixed(2)
      ]),
      styles: { fontSize: 7.5, cellPadding: 1.7, overflow: 'linebreak' },
      columnStyles: {
        0: { cellWidth: 8 },
        1: { cellWidth: 20 },
        2: { cellWidth: 55 },
        3: { cellWidth: 26 },
        4: { cellWidth: 26 },
        5: { cellWidth: 22 },
        6: { cellWidth: 22 }
      },
      headStyles: { fillColor: [21, 128, 61], textColor: 255, fontSize: 7.5 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      didDrawPage: () => { drawPdfLetterhead(doc, logoImg, letterheadOptions); }
    });

    const total = items.reduce((s, it) => s + Number(it.amount), 0);
    const finalY = (doc as any).lastAutoTable.finalY;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(15, 23, 42);
    doc.text(`Total Amount Disbursed: ${total.toFixed(2)}`, 8, finalY + 8);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    doc.text(
      `I acknowledge receipt of the above amount in full settlement of the conveyance claim referenced above.`,
      8,
      finalY + 16,
      { maxWidth: doc.internal.pageSize.getWidth() - 16 }
    );

    // Signature lines — a Voucher is a physical payout receipt, so leave room
    // for both the person disbursing and the claimant receiving to sign.
    const pageWidth = doc.internal.pageSize.getWidth();
    const sigY = finalY + 40;
    doc.setDrawColor(148, 163, 184);
    doc.setLineWidth(0.2);
    doc.line(14, sigY, 74, sigY);
    doc.line(pageWidth / 2 - 30, sigY, pageWidth / 2 + 30, sigY);
    doc.line(pageWidth - 74, sigY, pageWidth - 14, sigY);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text('Prepared By', 14, sigY + 4);
    doc.text('Approved By', pageWidth / 2, sigY + 4, { align: 'center' });
    doc.text("Received By (Claimant)", pageWidth - 74, sigY + 4);

    finalizePdfPageNumbers(doc);
    const filename = `Payment_Voucher_${bill.voucher_no || bill.id}_${bill.user_name?.replace(/\s+/g, '_') || 'user'}.pdf`;
    await savePdfCrossPlatform(doc, filename);
  };

  const [printingId, setPrintingId] = useState<number | null>(null);
  const handlePrintVoucher = async (billRow: ConveyanceBill) => {
    setPrintingId(billRow.id);
    try {
      await buildAndSaveVoucherPdf(billRow.id);
    } catch (err) {
      console.error('Failed to print voucher', err);
      alert('Failed to load bill details for the voucher. Please try again.');
    } finally {
      setPrintingId(null);
    }
  };

  // ---- Disburse (single or bulk-selected) ----
  const [confirmingIds, setConfirmingIds] = useState<number[] | null>(null);
  const [voucherNoInput, setVoucherNoInput] = useState('');
  const [disbursing, setDisbursing] = useState(false);
  // Separate step/label from `disbursing` so the confirm button can say
  // "Disbursing…" while the API calls run and then "Preparing vouchers…"
  // while the auto-download PDFs are being built, instead of one generic spinner.
  const [downloadingVouchers, setDownloadingVouchers] = useState(false);
  const [disburseError, setDisburseError] = useState('');

  const openDisburseConfirm = (ids: number[]) => {
    setConfirmingIds(ids);
    setVoucherNoInput(ids.length === 1 ? suggestVoucherNo(ids[0]) : '');
    setDisburseError('');
  };

  const handleConfirmDisburse = async () => {
    if (!confirmingIds || confirmingIds.length === 0) return;
    setDisbursing(true);
    setDisburseError('');
    try {
      for (const id of confirmingIds) {
        const res = await fetch(apiUrl(`/api/conveyance-bills/${id}/disburse`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            voucher_no: confirmingIds.length === 1 ? voucherNoInput || suggestVoucherNo(id) : suggestVoucherNo(id)
          })
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `Failed to disburse Bill CB-${id}`);
        }
      }
      const disbursedIds = confirmingIds;
      setDisbursing(false);
      setSelected(new Set());
      await fetchBills();

      // Every Bill just disbursed successfully — auto-download its Payment
      // Voucher PDF right away (one file per Bill, one at a time so any
      // native "save file" prompt doesn't overlap with the next). Keep the
      // confirm modal open (showing "Preparing voucher(s)…") until every
      // download has been attempted, so it isn't dismissed mid-download. A
      // PDF that fails to build/save doesn't undo the disbursement itself
      // (already saved server-side) — it can always be reprinted later from
      // the per-row Printer button.
      setDownloadingVouchers(true);
      for (const id of disbursedIds) {
        try {
          await buildAndSaveVoucherPdf(id);
        } catch (pdfErr) {
          console.error(`Failed to auto-download voucher for Bill CB-${id}`, pdfErr);
        }
      }
      setDownloadingVouchers(false);
      setConfirmingIds(null);
    } catch (err: any) {
      setDisburseError(err.message || 'Failed to disburse.');
    } finally {
      setDisbursing(false);
      setDownloadingVouchers(false);
    }
  };

  // ---- Undo (mark back to pending) ----
  const [undoingId, setUndoingId] = useState<number | null>(null);
  const handleUndoDisburse = async (id: number) => {
    if (!confirm('Mark this Bill back as Pending? The Voucher No. will be cleared.')) return;
    setUndoingId(id);
    try {
      const res = await fetch(apiUrl(`/api/conveyance-bills/${id}/undisburse`), { method: 'POST', headers: authHeaders });
      if (res.ok) await fetchBills();
    } catch (err) {
      console.error('Failed to undo disbursement', err);
    } finally {
      setUndoingId(null);
    }
  };

  const selectedTotal = bills
    .filter((b) => selected.has(b.id))
    .reduce((s, b) => s + Number(b.total_amount || 0), 0);

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col gap-4">
          <div>
            <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Banknote className="w-4 h-4 text-emerald-600" /> Conveyance Disbursement
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Mark finalized Conveyance Bills as disbursed and print a Payment Voucher for each. Select one or more
              Pending bills to disburse them together.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end">
              <div className="min-w-0">
                <label className="block text-[10px] font-semibold text-slate-500 mb-1">User</label>
                <select
                  value={userFilter}
                  onChange={(e) => setUserFilter(e.target.value)}
                  className="w-full sm:w-auto text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:outline-none"
                >
                  <option value="">All Users</option>
                  {plainUsers.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </div>
              <div className="min-w-0">
                <label className="block text-[10px] font-semibold text-slate-500 mb-1">Status</label>
                <div className="flex bg-slate-100 rounded-lg p-0.5">
                  {(['pending', 'disbursed', 'all'] as const).map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setStatusFilter(s)}
                      className={`flex-1 px-2.5 py-1.5 rounded-md text-[11px] font-semibold capitalize transition-colors ${
                        statusFilter === s ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={fetchBills}
                className="col-span-1 flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium whitespace-nowrap transition-colors"
              >
                <Filter className="w-3.5 h-3.5" /> Apply
              </button>
            </div>

            {selected.size > 0 && (
              <button
                type="button"
                onClick={() => openDisburseConfirm(Array.from(selected))}
                className="sm:ml-auto flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold whitespace-nowrap transition-colors"
              >
                <Banknote className="w-3.5 h-3.5" />
                Disburse Selected ({selected.size}) — {selectedTotal.toFixed(2)}
              </button>
            )}
          </div>
        </div>

        {loadError && <p className="text-xs text-rose-600 px-6 pt-4">{loadError}</p>}

        {loading ? (
          <p className="text-xs text-slate-400 text-center py-12">Loading bills...</p>
        ) : visibleBills.length === 0 ? (
          <div className="text-center text-xs text-slate-400 py-12 flex flex-col items-center gap-2">
            <Banknote className="w-6 h-6 text-slate-300" />
            {statusFilter === 'pending' ? 'No bills waiting on disbursement.' : 'No conveyance bills found.'}
          </div>
        ) : (
          <>
            {/* Mobile — stacked cards. */}
            <div className="md:hidden divide-y divide-slate-100">
              {visibleBills.map((b) => (
                <div key={b.id} className="p-4 flex flex-col gap-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0">
                      {!b.is_disbursed && (
                        <button type="button" onClick={() => toggleOne(b.id)} className="mt-0.5 text-slate-400 hover:text-emerald-600 shrink-0">
                          {selected.has(b.id) ? <CheckSquare className="w-4 h-4 text-emerald-600" /> : <Square className="w-4 h-4" />}
                        </button>
                      )}
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-900 text-sm">CB-{b.id}</p>
                        <p className="text-xs text-slate-500 mt-0.5 truncate">{b.user_name || '—'}</p>
                      </div>
                    </div>
                    <span className="shrink-0 text-xs font-semibold text-slate-900">{Number(b.total_amount || 0).toFixed(2)}</span>
                  </div>

                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>{formatDate(b.bill_date)} · {b.item_count ?? 0} item{(b.item_count ?? 0) === 1 ? '' : 's'}</span>
                    {b.is_disbursed ? (
                      <span className="px-2 py-0.5 rounded-full font-semibold border text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">
                        Disbursed{b.voucher_no ? ` · ${b.voucher_no}` : ''}
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-full font-semibold border text-[10px] bg-amber-50 text-amber-700 border-amber-200">
                        Pending
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    {b.is_disbursed ? (
                      <>
                        <button
                          type="button"
                          onClick={() => handlePrintVoucher(b)}
                          disabled={printingId === b.id}
                          className="flex-1 flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 font-medium transition-colors disabled:opacity-50"
                        >
                          {printingId === b.id ? <Spinner size={14} /> : <Printer className="w-3.5 h-3.5" />} Print Voucher
                        </button>
                        <button
                          type="button"
                          onClick={() => handleUndoDisburse(b.id)}
                          disabled={undoingId === b.id}
                          className="flex items-center justify-center gap-1.5 text-xs px-3 py-2 text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                        >
                          {undoingId === b.id ? <Spinner size={14} /> : <RotateCcw className="w-3.5 h-3.5" />} Undo
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => openDisburseConfirm([b.id])}
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium transition-colors"
                      >
                        <Banknote className="w-3.5 h-3.5" /> Disburse
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop — full table. */}
            <div className="hidden md:block overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-2.5 text-left w-8">
                      <button type="button" onClick={toggleAll} className="text-slate-400 hover:text-emerald-600" title="Select all pending">
                        {allSelectableChecked ? <CheckSquare className="w-4 h-4 text-emerald-600" /> : <Square className="w-4 h-4" />}
                      </button>
                    </th>
                    <th className="px-4 py-2.5 text-left">Bill No</th>
                    <th className="px-4 py-2.5 text-left">User</th>
                    <th className="px-4 py-2.5 text-left">Bill Date</th>
                    <th className="px-4 py-2.5 text-left">Items</th>
                    <th className="px-4 py-2.5 text-left">Total Amount</th>
                    <th className="px-4 py-2.5 text-left">Status</th>
                    <th className="px-4 py-2.5 text-left"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {visibleBills.map((b) => (
                    <tr key={b.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap">
                        {!b.is_disbursed && (
                          <button type="button" onClick={() => toggleOne(b.id)} className="text-slate-400 hover:text-emerald-600">
                            {selected.has(b.id) ? <CheckSquare className="w-4 h-4 text-emerald-600" /> : <Square className="w-4 h-4" />}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap font-semibold text-slate-900 text-xs">CB-{b.id}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-700 text-xs">{b.user_name || '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600 text-xs">{formatDate(b.bill_date)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600 text-xs">{b.item_count ?? 0}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-900 font-semibold text-xs">{Number(b.total_amount || 0).toFixed(2)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs">
                        {b.is_disbursed ? (
                          <span className="px-2 py-0.5 rounded-full font-semibold border text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200">
                            Disbursed{b.voucher_no ? ` · ${b.voucher_no}` : ''}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-full font-semibold border text-[10px] bg-amber-50 text-amber-700 border-amber-200">
                            Pending
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs">
                        <div className="flex items-center gap-1">
                          {b.is_disbursed ? (
                            <>
                              <button
                                type="button"
                                onClick={() => handlePrintVoucher(b)}
                                disabled={printingId === b.id}
                                className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors disabled:opacity-50"
                                title="Print Payment Voucher"
                              >
                                {printingId === b.id ? <Spinner size={14} /> : <Printer className="w-3.5 h-3.5" />}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleUndoDisburse(b.id)}
                                disabled={undoingId === b.id}
                                className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                                title="Undo — mark back as Pending"
                              >
                                {undoingId === b.id ? <Spinner size={14} /> : <RotateCcw className="w-3.5 h-3.5" />}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openDisburseConfirm([b.id])}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-medium transition-colors"
                            >
                              <Banknote className="w-3 h-3" /> Disburse
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* Disburse confirm modal */}
      {confirmingIds && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm">
            <div className="flex items-center justify-between gap-4 p-5 border-b border-slate-200">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <ReceiptText className="w-4 h-4 text-emerald-600" />
                Confirm Disbursement
              </h3>
              <button
                onClick={() => setConfirmingIds(null)}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              {disburseError && <p className="text-xs text-rose-600">{disburseError}</p>}
              <p className="text-xs text-slate-500">
                {confirmingIds.length === 1
                  ? `Mark Bill CB-${confirmingIds[0]} as disbursed today (${formatDate(todayDateOnlyString())}). This records who paid it out and downloads a Payment Voucher PDF automatically.`
                  : `Mark ${confirmingIds.length} selected bills as disbursed today (${formatDate(todayDateOnlyString())}). Each will get its own Voucher No. and its own Payment Voucher PDF downloaded automatically.`}
              </p>
              {confirmingIds.length === 1 && (
                <div>
                  <label className="block text-[11px] font-medium text-slate-500 mb-1">Voucher No.</label>
                  <input
                    type="text"
                    value={voucherNoInput}
                    onChange={(e) => setVoucherNoInput(e.target.value)}
                    className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                  />
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 p-5 pt-0">
              <button
                type="button"
                disabled={disbursing || downloadingVouchers}
                onClick={handleConfirmDisburse}
                className="flex-1 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white rounded-xl text-sm font-medium transition-colors"
              >
                {disbursing ? 'Disbursing…' : downloadingVouchers ? 'Preparing voucher(s)…' : 'Confirm & Disburse'}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingIds(null)}
                className="flex-1 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 rounded-xl text-sm font-medium transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};