import React, { useEffect, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Wallet, Plus, Trash2, X, Route, PenLine, Filter, FileDown, Pencil, Check, Paperclip, MapPin, Clock, Save } from 'lucide-react';
import {
  ConveyanceBill,
  ConveyanceBillItem,
  ClaimRecord,
  User,
  UserClaim,
  UserClaimCategory,
  USER_CLAIM_CATEGORIES,
  UserClaimReference
} from '../types';
import { apiUrl } from '../lib/api';
import { formatDate, todayDateOnlyString } from '../lib/formatDate';
import credenceLogo from '../assets/credence-logo.png';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import { UserClaimStatusBadge } from './UserClaimStatusBadge';
import ClaimLocationMap from './ClaimLocationMap';
import { Spinner } from './Spinner';

interface ConveyanceBillPanelProps {
  token: string;
  users: User[];
}

// Blank draft for both the "Add Manual Item" form and the inline "Edit Item"
// form — same shape, since editing is really just re-submitting an item.
const blankItemDraft = () => ({
  entry_date: todayDateOnlyString(),
  particulars: '',
  from_location: '',
  to_location: '',
  distance_km: '',
  rate_per_km: '',
  amount: '',
  remarks: ''
});

// Admin Panel -> Conveyance Bill Claim (Superadmin + explicitly-granted Admins
// only — see ADMIN_MODULES/'conveyance'). A Bill groups several travel/conveyance
// line items for ONE User into a single claim document; each item either gets
// pulled in from that User's own completed Movement Claim (see the "Movement
// Claims" tab) or is added fully by hand.
export const ConveyanceBillPanel: React.FC<ConveyanceBillPanelProps> = ({ token, users }) => {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const plainUsers = users.filter((u) => u.role === 'user');

  const [bills, setBills] = useState<ConveyanceBill[]>([]);
  const [billItems, setBillItems] = useState<Record<number, ConveyanceBillItem[]>>({});
  const [userClaims, setUserClaims] = useState<UserClaim[]>([]);
  const [loading, setLoading] = useState(false);
  const [userFilter, setUserFilter] = useState('');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');
  const [deletingBillId, setDeletingBillId] = useState<number | null>(null);

  // Bill rows in the unified table show which items/claims were added inside
  // them — the list endpoint only returns item_count, so pull each bill's own
  // items in parallel (same endpoint the detail modal already uses) and cache
  // them by bill id.
  const loadBillItems = async (billsList: ConveyanceBill[]) => {
    try {
      const results = await Promise.all(
        billsList.map(async (b) => {
          const res = await fetch(apiUrl(`/api/conveyance-bills/${b.id}`), { headers: authHeaders });
          if (!res.ok) return [b.id, []] as const;
          const detail: ConveyanceBill = await res.json();
          return [b.id, detail.items || []] as const;
        })
      );
      setBillItems(Object.fromEntries(results));
    } catch (err) {
      console.error('Failed to load bill items', err);
    }
  };

  const fetchBills = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (userFilter) params.set('user_id', userFilter);
      if (fromFilter) params.set('from', fromFilter);
      if (toFilter) params.set('to', toFilter);
      const res = await fetch(apiUrl(`/api/conveyance-bills?${params.toString()}`), { headers: authHeaders });
      if (res.ok) {
        const data: ConveyanceBill[] = await res.json();
        setBills(data);
        loadBillItems(data);
      }
    } catch (err) {
      console.error('Failed to load conveyance bills', err);
    } finally {
      setLoading(false);
    }
  };

  // User Claims and Bills are shown together in ONE table (one row each) —
  // fetch both. The backend doesn't support a date-range filter on
  // /api/user-claims, so From/To are applied client-side on claim_date.
  const fetchUserClaims = async () => {
    try {
      const params = new URLSearchParams();
      if (userFilter) params.set('user_id', userFilter);
      const res = await fetch(apiUrl(`/api/user-claims?${params.toString()}`), { headers: authHeaders });
      if (res.ok) {
        const data: UserClaim[] = await res.json();
        const filtered = data.filter((c) => {
          const d = String(c.claim_date).slice(0, 10);
          if (fromFilter && d < fromFilter) return false;
          if (toFilter && d > toFilter) return false;
          return true;
        });
        setUserClaims(filtered);
      }
    } catch (err) {
      console.error('Failed to load user claims', err);
    }
  };

  const fetchAll = async () => {
    await Promise.all([fetchBills(), fetchUserClaims()]);
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasFilters = userFilter || fromFilter || toFilter;

  const handleDeleteBill = async (id: number) => {
    if (!confirm('Delete this bill and all its items? This cannot be undone. (Any Movement Claims used in it become billable again.)')) return;
    setDeletingBillId(id);
    try {
      const res = await fetch(apiUrl(`/api/conveyance-bills/${id}`), { method: 'DELETE', headers: authHeaders });
      if (res.ok) setBills((prev) => prev.filter((b) => b.id !== id));
    } catch (err) {
      console.error('Failed to delete bill', err);
    } finally {
      setDeletingBillId(null);
    }
  };

  // ---- New Bill ----
  const [showNewBill, setShowNewBill] = useState(false);
  const [newBillUserId, setNewBillUserId] = useState('');
  const [newBillDate, setNewBillDate] = useState(todayDateOnlyString());
  const [newBillRemarks, setNewBillRemarks] = useState('');
  const [creatingBill, setCreatingBill] = useState(false);
  const [createBillError, setCreateBillError] = useState('');

  const resetNewBillForm = () => {
    setShowNewBill(false);
    setNewBillUserId('');
    setNewBillDate(todayDateOnlyString());
    setNewBillRemarks('');
    setCreateBillError('');
  };

  const handleCreateBill = async () => {
    if (!newBillUserId) {
      setCreateBillError('Select a User for this bill.');
      return;
    }
    setCreatingBill(true);
    setCreateBillError('');
    try {
      const res = await fetch(apiUrl('/api/conveyance-bills'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ user_id: Number(newBillUserId), bill_date: newBillDate, remarks: newBillRemarks })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create bill');
      resetNewBillForm();
      await fetchBills();
      setViewingBillId(data.id);
    } catch (err: any) {
      setCreateBillError(err.message || 'Failed to create bill');
    } finally {
      setCreatingBill(false);
    }
  };

  // ---- Bill detail (view/edit items) ----
  const [viewingBillId, setViewingBillId] = useState<number | null>(null);
  const [billDetail, setBillDetail] = useState<ConveyanceBill | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const fetchBillDetail = async (id: number) => {
    setLoadingDetail(true);
    try {
      const res = await fetch(apiUrl(`/api/conveyance-bills/${id}`), { headers: authHeaders });
      if (res.ok) {
        const detail: ConveyanceBill = await res.json();
        setBillDetail(detail);
        // Keep the row-level items cache in sync while the modal is open, so
        // the table row reflects item add/edit/delete without a full refetch.
        setBillItems((prev) => ({ ...prev, [id]: detail.items || [] }));
      }
    } catch (err) {
      console.error('Failed to load bill detail', err);
    } finally {
      setLoadingDetail(false);
    }
  };

  useEffect(() => {
    if (viewingBillId === null) {
      setBillDetail(null);
      setShowClaimPicker(false);
      setShowManualForm(false);
      setEditingItemId(null);
      return;
    }
    fetchBillDetail(viewingBillId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingBillId]);

  const closeDetail = () => {
    setViewingBillId(null);
    fetchAll();
  };

  // ---- User Claim detail (unified table row click) ----
  const [viewingUserClaimId, setViewingUserClaimId] = useState<number | null>(null);
  const viewingUserClaim = userClaims.find((c) => c.id === viewingUserClaimId) || null;

  // ---- Add from Movement Claim ----
  const [showClaimPicker, setShowClaimPicker] = useState(false);
  const [availableClaims, setAvailableClaims] = useState<ClaimRecord[]>([]);
  const [loadingClaims, setLoadingClaims] = useState(false);
  const [claimRateDrafts, setClaimRateDrafts] = useState<Record<number, string>>({});
  const [addingClaimId, setAddingClaimId] = useState<number | null>(null);
  const [claimPickerError, setClaimPickerError] = useState('');

  const openClaimPicker = async () => {
    if (!billDetail) return;
    setShowClaimPicker(true);
    setShowManualForm(false);
    setClaimPickerError('');
    setLoadingClaims(true);
    try {
      const res = await fetch(apiUrl(`/api/conveyance-bills/available-claims/${billDetail.user_id}`), { headers: authHeaders });
      if (res.ok) setAvailableClaims(await res.json());
    } catch (err) {
      console.error('Failed to load available claims', err);
    } finally {
      setLoadingClaims(false);
    }
  };

  const handleAddFromClaim = async (claim: ClaimRecord) => {
    if (!billDetail) return;
    const rate = claimRateDrafts[claim.id];
    if (!rate || !(Number(rate) > 0)) {
      setClaimPickerError('Enter a Rate per KM for this claim before adding it.');
      return;
    }
    setClaimPickerError('');
    setAddingClaimId(claim.id);
    try {
      const res = await fetch(apiUrl(`/api/conveyance-bills/${billDetail.id}/items`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ source: 'movement_claim', claim_id: claim.id, rate_per_km: rate })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add item');
      setAvailableClaims((prev) => prev.filter((c) => c.id !== claim.id));
      await fetchBillDetail(billDetail.id);
    } catch (err: any) {
      setClaimPickerError(err.message || 'Failed to add item');
    } finally {
      setAddingClaimId(null);
    }
  };

  // ---- Add Manual Item ----
  const [showManualForm, setShowManualForm] = useState(false);
  const [manualDraft, setManualDraft] = useState(blankItemDraft());
  const [savingManual, setSavingManual] = useState(false);
  const [manualError, setManualError] = useState('');

  const openManualForm = () => {
    setShowManualForm(true);
    setShowClaimPicker(false);
    setManualDraft(blankItemDraft());
    setManualError('');
  };

  const computedAmount = (d: ReturnType<typeof blankItemDraft>): string => {
    if (d.amount) return d.amount;
    const dist = Number(d.distance_km);
    const rate = Number(d.rate_per_km);
    if (d.distance_km && d.rate_per_km && Number.isFinite(dist) && Number.isFinite(rate)) {
      return String(Math.round(dist * rate * 100) / 100);
    }
    return '';
  };

  const handleAddManual = async () => {
    if (!billDetail) return;
    if (!manualDraft.entry_date || !manualDraft.particulars.trim()) {
      setManualError('Date and Particulars are required.');
      return;
    }
    const amt = computedAmount(manualDraft);
    if (!amt || !(Number(amt) > 0)) {
      setManualError('Enter an Amount (or both Distance and Rate per KM).');
      return;
    }
    setSavingManual(true);
    setManualError('');
    try {
      const res = await fetch(apiUrl(`/api/conveyance-bills/${billDetail.id}/items`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ source: 'manual', ...manualDraft, amount: amt })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add item');
      setShowManualForm(false);
      setManualDraft(blankItemDraft());
      await fetchBillDetail(billDetail.id);
    } catch (err: any) {
      setManualError(err.message || 'Failed to add item');
    } finally {
      setSavingManual(false);
    }
  };

  // ---- Edit / Delete an existing item ----
  const [editingItemId, setEditingItemId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState(blankItemDraft());
  const [savingItem, setSavingItem] = useState(false);
  const [editError, setEditError] = useState('');
  const [deletingItemId, setDeletingItemId] = useState<number | null>(null);

  const startEditItem = (it: ConveyanceBillItem) => {
    setEditingItemId(it.id);
    setEditDraft({
      entry_date: it.entry_date,
      particulars: it.particulars,
      from_location: it.from_location || '',
      to_location: it.to_location || '',
      distance_km: it.distance_km !== null && it.distance_km !== undefined ? String(it.distance_km) : '',
      rate_per_km: it.rate_per_km !== null && it.rate_per_km !== undefined ? String(it.rate_per_km) : '',
      amount: String(it.amount),
      remarks: it.remarks || ''
    });
    setEditError('');
  };

  const handleSaveItem = async () => {
    if (!billDetail || editingItemId === null) return;
    const amt = computedAmount(editDraft);
    if (!editDraft.entry_date || !editDraft.particulars.trim() || !amt || !(Number(amt) > 0)) {
      setEditError('Date, Particulars and Amount (or Distance + Rate) are required.');
      return;
    }
    setSavingItem(true);
    setEditError('');
    try {
      const res = await fetch(apiUrl(`/api/conveyance-bills/${billDetail.id}/items/${editingItemId}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ ...editDraft, amount: amt })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save item');
      setEditingItemId(null);
      await fetchBillDetail(billDetail.id);
    } catch (err: any) {
      setEditError(err.message || 'Failed to save item');
    } finally {
      setSavingItem(false);
    }
  };

  const handleDeleteItem = async (itemId: number) => {
    if (!billDetail) return;
    if (!confirm('Remove this item from the bill?')) return;
    setDeletingItemId(itemId);
    try {
      const res = await fetch(apiUrl(`/api/conveyance-bills/${billDetail.id}/items/${itemId}`), { method: 'DELETE', headers: authHeaders });
      if (res.ok) await fetchBillDetail(billDetail.id);
    } catch (err) {
      console.error('Failed to delete item', err);
    } finally {
      setDeletingItemId(null);
    }
  };

  // ---- PDF export ----
  const handleExportPdf = async (bill: ConveyanceBill) => {
    const logoImg = await loadImageElement(credenceLogo);
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const items = bill.items || [];

    const letterheadOptions = {
      reportTitle: 'Conveyance Bill Claim',
      filters: [
        ['User', bill.user_name || '—'],
        ['Bill Date', formatDate(bill.bill_date) || '—']
      ] as [string, string][]
    };
    const contentStartY = drawPdfLetterhead(doc, logoImg, letterheadOptions);

    autoTable(doc, {
      startY: contentStartY,
      margin: { top: contentStartY, left: 8, right: 8 },
      head: [['SL', 'Date', 'Particulars', 'From', 'To', 'Distance (KM)', 'Rate/KM', 'Amount', 'Remarks']],
      body: items.map((it, idx) => [
        String(idx + 1),
        formatDate(it.entry_date) || '',
        it.particulars || '',
        it.from_location || '',
        it.to_location || '',
        it.distance_km != null ? String(it.distance_km) : '',
        it.rate_per_km != null ? String(it.rate_per_km) : '',
        it.amount.toFixed(2),
        it.remarks || ''
      ]),
      styles: { fontSize: 7, cellPadding: 1.5, overflow: 'linebreak' },
      columnStyles: {
        0: { cellWidth: 8 },
        1: { cellWidth: 18 },
        2: { cellWidth: 40 },
        3: { cellWidth: 24 },
        4: { cellWidth: 24 },
        5: { cellWidth: 18 },
        6: { cellWidth: 16 },
        7: { cellWidth: 18 },
        8: { cellWidth: 24 }
      },
      headStyles: { fillColor: [37, 99, 235], textColor: 255, fontSize: 7 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      didDrawPage: () => { drawPdfLetterhead(doc, logoImg, letterheadOptions); }
    });

    const total = items.reduce((s, it) => s + Number(it.amount), 0);
    const finalY = (doc as any).lastAutoTable.finalY;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(15, 23, 42);
    doc.text(`Total Claim Amount: ${total.toFixed(2)}`, 8, finalY + 8);

    // Signature lines — a Conveyance Bill is a physical claim document, so leave
    // room for the Claimant/Approver to sign the printed copy.
    const pageWidth = doc.internal.pageSize.getWidth();
    const sigY = finalY + 30;
    doc.setDrawColor(148, 163, 184);
    doc.setLineWidth(0.2);
    doc.line(14, sigY, 74, sigY);
    doc.line(pageWidth - 74, sigY, pageWidth - 14, sigY);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text('Claimant\'s Signature', 14, sigY + 4);
    doc.text('Approved By', pageWidth - 74, sigY + 4);

    finalizePdfPageNumbers(doc);
    const filename = `Conveyance_Bill_${bill.id}_${bill.user_name?.replace(/\s+/g, '_') || 'user'}.pdf`;
    await savePdfCrossPlatform(doc, filename);
  };

  // ---- Unified table: one row per Bill and per User Claim, sorted by date ----
  // Compact summary of the items/claims added inside a Bill, shown right in
  // the Bill's row so the admin doesn't have to open it to see what's inside.
  const renderBillItemsSummary = (billId: number, itemCount?: number) => {
    const items = billItems[billId];
    if (!items) {
      return <span className="text-slate-400">{itemCount ?? 0} item{(itemCount ?? 0) === 1 ? '' : 's'}</span>;
    }
    if (items.length === 0) {
      return <span className="text-slate-300">No items yet</span>;
    }
    const shown = items.slice(0, 3);
    return (
      <div className="flex flex-col gap-0.5">
        {shown.map((it) => (
          <span key={it.id} className="text-[11px] text-slate-600 truncate max-w-[220px]" title={it.particulars}>
            • {it.particulars}
          </span>
        ))}
        {items.length > shown.length && (
          <span className="text-[11px] text-slate-400">+{items.length - shown.length} more</span>
        )}
      </div>
    );
  };

  type CombinedRow =
    | { kind: 'bill'; key: string; date: string; user_name?: string | null; amount: number; bill: ConveyanceBill }
    | { kind: 'user_claim'; key: string; date: string; user_name?: string | null; amount: number; claim: UserClaim };

  const combinedRows: CombinedRow[] = [
    ...bills.map((b): CombinedRow => ({
      kind: 'bill',
      key: `bill-${b.id}`,
      date: b.bill_date,
      user_name: b.user_name,
      amount: Number(b.total_amount || 0),
      bill: b
    })),
    // A User Claim that's already been attached into a Bill (bill_id set)
    // is already visible inside that Bill's own row (its items list) —
    // showing it again here would just be the same claim twice.
    ...userClaims
      .filter((c) => !c.bill_id)
      .map((c): CombinedRow => ({
        kind: 'user_claim',
        key: `claim-${c.id}`,
        date: c.claim_date,
        user_name: c.user_name,
        amount: Number(c.amount),
        claim: c
      }))
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
        <div className="p-6 border-b border-slate-200 flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Wallet className="w-4 h-4 text-blue-600" /> Conveyance Bill Claim
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                User Claims and Bills together, one row each — click a row to view its details.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowNewBill(true)}
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium whitespace-nowrap transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> New Bill
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end">
            <div className="min-w-0">
              <label className="block text-[10px] font-semibold text-slate-500 mb-1">User</label>
              <select
                value={userFilter}
                onChange={(e) => setUserFilter(e.target.value)}
                className="w-full sm:w-auto text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
              >
                <option value="">All Users</option>
                {plainUsers.map((u) => (
                  <option key={u.id} value={u.id}>{u.name}</option>
                ))}
              </select>
            </div>
            <div className="min-w-0">
              <label className="block text-[10px] font-semibold text-slate-500 mb-1">From</label>
              <input
                type="date"
                value={fromFilter}
                onChange={(e) => setFromFilter(e.target.value)}
                className="w-full sm:w-auto text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
              />
            </div>
            <div className="min-w-0">
              <label className="block text-[10px] font-semibold text-slate-500 mb-1">To</label>
              <input
                type="date"
                value={toFilter}
                onChange={(e) => setToFilter(e.target.value)}
                className="w-full sm:w-auto text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
              />
            </div>
            <button
              type="button"
              onClick={fetchAll}
              className="col-span-1 flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium whitespace-nowrap transition-colors"
            >
              <Filter className="w-3.5 h-3.5" /> Apply
            </button>
            {hasFilters && (
              <button
                type="button"
                onClick={() => { setUserFilter(''); setFromFilter(''); setToFilter(''); }}
                className="col-span-1 text-xs px-3 py-2 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-900 hover:bg-slate-50 font-medium whitespace-nowrap transition-colors"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {loading ? (
          <p className="text-xs text-slate-400 text-center py-12">Loading...</p>
        ) : combinedRows.length === 0 ? (
          <div className="text-center text-xs text-slate-400 py-12 flex flex-col items-center gap-2">
            <Wallet className="w-6 h-6 text-slate-300" />
            No User Claims or Bills yet.
          </div>
        ) : (
          <>
            {/* Mobile — stacked cards instead of a squeezed table. */}
            <div className="md:hidden divide-y divide-slate-100">
              {combinedRows.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  onClick={() => (row.kind === 'bill' ? setViewingBillId(row.bill.id) : setViewingUserClaimId(row.claim.id))}
                  className="w-full text-left p-4 flex flex-col gap-2.5 hover:bg-slate-50/80 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                            row.kind === 'bill'
                              ? 'bg-blue-50 text-blue-700 border-blue-200'
                              : 'bg-violet-50 text-violet-700 border-violet-200'
                          }`}
                        >
                          {row.kind === 'bill' ? `CB-${row.bill.id}` : row.claim.category}
                        </span>
                      </div>
                      <p className="text-xs text-slate-500 mt-1 truncate">{row.user_name || '—'}</p>
                    </div>
                    <span className="shrink-0 text-xs font-semibold text-slate-900">{row.amount.toFixed(2)}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs text-slate-500">
                    <span>{formatDate(row.date)}</span>
                    {row.kind !== 'bill' && <UserClaimStatusBadge status={row.claim.status} />}
                  </div>
                  {row.kind === 'bill' && (
                    <div className="text-xs">{renderBillItemsSummary(row.bill.id, row.bill.item_count)}</div>
                  )}
                </button>
              ))}
            </div>

            {/* Desktop — full table. */}
            <div className="hidden md:block overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Type</th>
                    <th className="px-4 py-2.5 text-left">Reference</th>
                    <th className="px-4 py-2.5 text-left">User</th>
                    <th className="px-4 py-2.5 text-left">Date</th>
                    <th className="px-4 py-2.5 text-left">Items / Status</th>
                    <th className="px-4 py-2.5 text-left">Amount</th>
                    <th className="px-4 py-2.5 text-left"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {combinedRows.map((row) => (
                    <tr
                      key={row.key}
                      onClick={() => (row.kind === 'bill' ? setViewingBillId(row.bill.id) : setViewingUserClaimId(row.claim.id))}
                      className="hover:bg-slate-50/80 transition-colors cursor-pointer"
                    >
                      <td className="px-4 py-3 whitespace-nowrap text-xs">
                        <span
                          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                            row.kind === 'bill'
                              ? 'bg-blue-50 text-blue-700 border-blue-200'
                              : 'bg-violet-50 text-violet-700 border-violet-200'
                          }`}
                        >
                          {row.kind === 'bill' ? 'Bill' : 'User Claim'}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap font-semibold text-slate-900 text-xs">
                        {row.kind === 'bill' ? `CB-${row.bill.id}` : row.claim.category}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-700 text-xs">{row.user_name || '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600 text-xs">{formatDate(row.date)}</td>
                      <td className="px-4 py-3 text-slate-600 text-xs">
                        {row.kind === 'bill' ? (
                          renderBillItemsSummary(row.bill.id, row.bill.item_count)
                        ) : (
                          <UserClaimStatusBadge status={row.claim.status} />
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-900 font-semibold text-xs">{row.amount.toFixed(2)}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs">
                        {row.kind === 'bill' && (
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); setViewingBillId(row.bill.id); }}
                              className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                              title="View / Edit"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => { e.stopPropagation(); handleDeleteBill(row.bill.id); }}
                              disabled={deletingBillId === row.bill.id}
                              className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                              title="Delete this bill"
                            >
                              {deletingBillId === row.bill.id ? <Spinner size={14} /> : <Trash2 className="w-3.5 h-3.5" />}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {/* New Bill modal */}
      {showNewBill && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between gap-4 p-5 border-b border-slate-200">
              <h3 className="text-base font-bold text-slate-900">New Conveyance Bill</h3>
              <button onClick={resetNewBillForm} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                <X className="w-4.5 h-4.5" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              {createBillError && <p className="text-xs text-rose-600">{createBillError}</p>}
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">User</label>
                <select
                  value={newBillUserId}
                  onChange={(e) => setNewBillUserId(e.target.value)}
                  className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                >
                  <option value="">Select User</option>
                  {plainUsers.map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Bill Date</label>
                <input
                  type="date"
                  value={newBillDate}
                  onChange={(e) => setNewBillDate(e.target.value)}
                  className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Remarks (optional)</label>
                <textarea
                  value={newBillRemarks}
                  onChange={(e) => setNewBillRemarks(e.target.value)}
                  rows={2}
                  className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-sm bg-white"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 p-5 pt-0">
              <button
                type="button"
                disabled={creatingBill}
                onClick={handleCreateBill}
                className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-xl text-sm font-medium transition-colors"
              >
                {creatingBill ? 'Creating…' : 'Create & Add Items'}
              </button>
              <button
                type="button"
                onClick={resetNewBillForm}
                className="flex-1 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 rounded-xl text-sm font-medium transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bill detail modal */}
      {viewingBillId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 p-4 sm:p-5 border-b border-slate-200">
              <div className="min-w-0">
                <h3 className="text-base sm:text-lg font-bold text-slate-900 truncate">
                  Conveyance Bill CB-{viewingBillId}{billDetail ? ` — ${billDetail.user_name}` : ''}
                </h3>
                {billDetail && <p className="text-xs text-slate-500 mt-0.5">Bill Date: {formatDate(billDetail.bill_date)}</p>}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {billDetail && (billDetail.items?.length || 0) > 0 && (
                  <button
                    onClick={() => handleExportPdf(billDetail)}
                    className="flex items-center gap-1.5 py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl text-xs transition-all shadow-sm whitespace-nowrap"
                  >
                    <FileDown className="w-3.5 h-3.5" /> Export PDF
                  </button>
                )}
                <button onClick={closeDetail} className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors" title="Close">
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="overflow-auto flex-1 p-4 sm:p-5 space-y-4">
              {loadingDetail || !billDetail ? (
                <p className="text-sm text-slate-400 text-center py-10">Loading...</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 sm:flex sm:flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={openClaimPicker}
                      className="flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 font-medium transition-colors"
                    >
                      <Route className="w-3.5 h-3.5" /> Add from Movement Claim
                    </button>
                    <button
                      type="button"
                      onClick={openManualForm}
                      className="flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 text-slate-700 hover:bg-slate-100 font-medium transition-colors"
                    >
                      <PenLine className="w-3.5 h-3.5" /> Add Manual Item
                    </button>
                  </div>

                  {/* Movement Claim picker */}
                  {showClaimPicker && (
                    <div className="p-4 rounded-xl border border-blue-200 bg-blue-50/40 space-y-2">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold text-slate-700">Completed Movement Claims for {billDetail.user_name} (not yet billed)</h4>
                        <button onClick={() => setShowClaimPicker(false)} className="text-slate-400 hover:text-slate-700">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      {claimPickerError && <p className="text-xs text-rose-600">{claimPickerError}</p>}
                      {loadingClaims ? (
                        <p className="text-xs text-slate-400 flex items-center gap-1.5"><Spinner size={14} /> Loading...</p>
                      ) : availableClaims.length === 0 ? (
                        <p className="text-xs text-slate-400">No unbilled completed Movement Claims for this User.</p>
                      ) : (
                        <ul className="divide-y divide-blue-100 bg-white rounded-lg border border-blue-100 overflow-hidden">
                          {availableClaims.map((c) => (
                            <li key={c.id} className="p-2.5 flex flex-wrap items-center gap-2">
                              <div className="flex-1 min-w-[160px]">
                                <p className="text-xs font-medium text-slate-800 truncate" title={c.purpose}>{c.purpose}</p>
                                <p className="text-[11px] text-slate-400">
                                  {formatDate(c.check_in_at)} · {c.distance_km != null ? `${c.distance_km} km` : 'no distance recorded'}
                                </p>
                              </div>
                              <div className="flex items-center gap-1.5">
                                <label className="text-[11px] text-slate-500 whitespace-nowrap">Rate/KM</label>
                                <input
                                  type="number"
                                  min="0"
                                  step="any"
                                  value={claimRateDrafts[c.id] || ''}
                                  onChange={(e) => setClaimRateDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))}
                                  className="w-20 px-2 py-1.5 rounded-lg border border-slate-300 text-xs bg-white"
                                />
                              </div>
                              <button
                                type="button"
                                disabled={addingClaimId === c.id}
                                onClick={() => handleAddFromClaim(c)}
                                className="flex items-center gap-1 px-2.5 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-[11px] font-medium transition-colors"
                              >
                                {addingClaimId === c.id ? <Spinner size={12} /> : <Plus className="w-3 h-3" />} Add
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {/* Manual item form */}
                  {showManualForm && (
                    <div className="p-4 rounded-xl border border-slate-200 bg-slate-50 space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-bold text-slate-700">Add Manual Item</h4>
                        <button onClick={() => setShowManualForm(false)} className="text-slate-400 hover:text-slate-700">
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      {manualError && <p className="text-xs text-rose-600">{manualError}</p>}
                      <ItemFields draft={manualDraft} setDraft={setManualDraft} />
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={savingManual}
                          onClick={handleAddManual}
                          className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium disabled:opacity-50"
                        >
                          {savingManual ? 'Adding…' : 'Add Item'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setShowManualForm(false)}
                          className="px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-slate-600 text-xs"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Items — mobile cards, desktop table */}
                  {(billDetail.items?.length || 0) === 0 ? (
                    <p className="text-xs text-slate-400 text-center py-8">No items in this bill yet.</p>
                  ) : (
                    <>
                      {/* Mobile — stacked cards. */}
                      <div className="md:hidden border border-slate-200 rounded-xl divide-y divide-slate-100 overflow-hidden">
                        {billDetail.items!.map((it) =>
                          editingItemId === it.id ? (
                            <div key={it.id} className="p-4 bg-amber-50/40">
                              {editError && <p className="text-xs text-rose-600 mb-2">{editError}</p>}
                              <ItemFields draft={editDraft} setDraft={setEditDraft} />
                              <div className="flex items-center gap-2 mt-3">
                                <button
                                  type="button"
                                  disabled={savingItem}
                                  onClick={handleSaveItem}
                                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium disabled:opacity-50"
                                >
                                  <Check className="w-3.5 h-3.5" /> {savingItem ? 'Saving…' : 'Save'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setEditingItemId(null)}
                                  className="px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-slate-600 text-xs"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div key={it.id} className="p-4 flex flex-col gap-2">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="text-xs font-semibold text-slate-900 truncate" title={it.particulars}>{it.particulars}</p>
                                  <p className="text-[11px] text-slate-500 mt-0.5">{formatDate(it.entry_date)}</p>
                                </div>
                                <span
                                  className={`shrink-0 px-2 py-0.5 rounded-full font-semibold border text-[10px] ${
                                    it.source === 'movement_claim'
                                      ? 'bg-blue-50 text-blue-700 border-blue-200'
                                      : 'bg-slate-100 text-slate-600 border-slate-200'
                                  }`}
                                >
                                  {it.source === 'movement_claim' ? 'Movement Claim' : 'Manual'}
                                </span>
                              </div>

                              {(it.from_location || it.to_location) && (
                                <p className="text-xs text-slate-500">{it.from_location || '—'} → {it.to_location || '—'}</p>
                              )}

                              <div className="flex items-center flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                                <span>Distance: {it.distance_km != null ? `${it.distance_km} km` : '—'}</span>
                                <span>Rate/KM: {it.rate_per_km != null ? it.rate_per_km : '—'}</span>
                                <span className="font-semibold text-slate-900">Amount: {it.amount.toFixed(2)}</span>
                              </div>

                              <div className="flex items-center gap-2 pt-1">
                                <button
                                  type="button"
                                  onClick={() => startEditItem(it)}
                                  className="flex-1 flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-200 text-blue-700 font-medium transition-colors"
                                >
                                  <Pencil className="w-3.5 h-3.5" /> Edit
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDeleteItem(it.id)}
                                  disabled={deletingItemId === it.id}
                                  className="flex items-center justify-center gap-1.5 text-xs px-3 py-1.5 text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                                >
                                  {deletingItemId === it.id ? <Spinner size={14} /> : <Trash2 className="w-3.5 h-3.5" />} Remove
                                </button>
                              </div>
                            </div>
                          )
                        )}
                        <div className="p-3 flex items-center justify-between bg-slate-50 font-bold text-slate-900 text-sm">
                          <span>Total</span>
                          <span>{billDetail.items!.reduce((s, it) => s + Number(it.amount), 0).toFixed(2)}</span>
                        </div>
                      </div>

                      {/* Desktop — full table. */}
                      <div className="hidden md:block overflow-x-auto border border-slate-200 rounded-xl">
                      <table className="min-w-full divide-y divide-slate-200 text-xs">
                        <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider">
                          <tr>
                            <th className="px-3 py-2 text-left">Date</th>
                            <th className="px-3 py-2 text-left">Source</th>
                            <th className="px-3 py-2 text-left">Particulars</th>
                            <th className="px-3 py-2 text-left">From → To</th>
                            <th className="px-3 py-2 text-left">Distance</th>
                            <th className="px-3 py-2 text-left">Rate/KM</th>
                            <th className="px-3 py-2 text-left">Amount</th>
                            <th className="px-3 py-2 text-left"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {billDetail.items!.map((it) =>
                            editingItemId === it.id ? (
                              <tr key={it.id} className="bg-amber-50/40">
                                <td colSpan={8} className="p-3">
                                  {editError && <p className="text-xs text-rose-600 mb-2">{editError}</p>}
                                  <ItemFields draft={editDraft} setDraft={setEditDraft} />
                                  <div className="flex items-center gap-2 mt-2">
                                    <button
                                      type="button"
                                      disabled={savingItem}
                                      onClick={handleSaveItem}
                                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium disabled:opacity-50"
                                    >
                                      <Check className="w-3.5 h-3.5" /> {savingItem ? 'Saving…' : 'Save'}
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setEditingItemId(null)}
                                      className="px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-slate-600 text-xs"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            ) : (
                              <tr key={it.id} className="hover:bg-slate-50/80">
                                <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">{formatDate(it.entry_date)}</td>
                                <td className="px-3 py-2.5 whitespace-nowrap">
                                  <span
                                    className={`px-2 py-0.5 rounded-full font-semibold border text-[10px] ${
                                      it.source === 'movement_claim'
                                        ? 'bg-blue-50 text-blue-700 border-blue-200'
                                        : 'bg-slate-100 text-slate-600 border-slate-200'
                                    }`}
                                  >
                                    {it.source === 'movement_claim' ? 'Movement Claim' : 'Manual'}
                                  </span>
                                </td>
                                <td className="px-3 py-2.5 text-slate-700 max-w-[200px]">
                                  <span className="block truncate" title={it.particulars}>{it.particulars}</span>
                                </td>
                                <td className="px-3 py-2.5 text-slate-500 whitespace-nowrap">
                                  {it.from_location || it.to_location ? `${it.from_location || '—'} → ${it.to_location || '—'}` : <span className="text-slate-300">—</span>}
                                </td>
                                <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">{it.distance_km != null ? `${it.distance_km} km` : <span className="text-slate-300">—</span>}</td>
                                <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">{it.rate_per_km != null ? it.rate_per_km : <span className="text-slate-300">—</span>}</td>
                                <td className="px-3 py-2.5 whitespace-nowrap font-semibold text-slate-900">{it.amount.toFixed(2)}</td>
                                <td className="px-3 py-2.5 whitespace-nowrap">
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => startEditItem(it)}
                                      className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                      title="Edit item"
                                    >
                                      <Pencil className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handleDeleteItem(it.id)}
                                      disabled={deletingItemId === it.id}
                                      className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                                      title="Remove item"
                                    >
                                      {deletingItemId === it.id ? <Spinner size={14} /> : <Trash2 className="w-3.5 h-3.5" />}
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            )
                          )}
                        </tbody>
                        <tfoot>
                          <tr className="bg-slate-50 font-bold text-slate-900">
                            <td colSpan={6} className="px-3 py-2.5 text-right">Total</td>
                            <td className="px-3 py-2.5">{billDetail.items!.reduce((s, it) => s + Number(it.amount), 0).toFixed(2)}</td>
                            <td></td>
                          </tr>
                        </tfoot>
                      </table>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* User Claim detail modal — opened by clicking a "User Claim" row */}
      {viewingUserClaim && (
        <UserClaimDetailModal
          claim={viewingUserClaim}
          token={token}
          onClose={() => setViewingUserClaimId(null)}
          onChanged={fetchAll}
        />
      )}
    </div>
  );
};

// Shared field set for both "Add Manual Item" and "Edit Item" — Amount is left
// blank/auto so entering both Distance + Rate computes it, while still letting
// it be typed directly to override (e.g. a flat fare with no KM figure at all).
const ItemFields: React.FC<{
  draft: ReturnType<typeof blankItemDraft>;
  setDraft: React.Dispatch<React.SetStateAction<ReturnType<typeof blankItemDraft>>>;
}> = ({ draft, setDraft }) => {
  const set = (key: keyof ReturnType<typeof blankItemDraft>) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setDraft((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
      <div>
        <label className="block text-[11px] font-medium text-slate-500 mb-1">Date *</label>
        <input type="date" value={draft.entry_date} onChange={set('entry_date')} className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white" />
      </div>
      <div>
        <label className="block text-[11px] font-medium text-slate-500 mb-1">Particulars *</label>
        <input type="text" value={draft.particulars} onChange={set('particulars')} placeholder="e.g. Site visit — Gulshan to Uttara" className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white" />
      </div>
      <div>
        <label className="block text-[11px] font-medium text-slate-500 mb-1">From</label>
        <input type="text" value={draft.from_location} onChange={set('from_location')} className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white" />
      </div>
      <div>
        <label className="block text-[11px] font-medium text-slate-500 mb-1">To</label>
        <input type="text" value={draft.to_location} onChange={set('to_location')} className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white" />
      </div>
      <div>
        <label className="block text-[11px] font-medium text-slate-500 mb-1">Distance (KM)</label>
        <input type="number" min="0" step="any" value={draft.distance_km} onChange={set('distance_km')} className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white" />
      </div>
      <div>
        <label className="block text-[11px] font-medium text-slate-500 mb-1">Rate per KM</label>
        <input type="number" min="0" step="any" value={draft.rate_per_km} onChange={set('rate_per_km')} className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white" />
      </div>
      <div>
        <label className="block text-[11px] font-medium text-slate-500 mb-1">
          Amount {draft.distance_km && draft.rate_per_km && !draft.amount ? '(auto)' : '*'}
        </label>
        <input
          type="number"
          min="0"
          step="any"
          value={draft.amount}
          placeholder={draft.distance_km && draft.rate_per_km ? String(Math.round(Number(draft.distance_km) * Number(draft.rate_per_km) * 100) / 100) : ''}
          onChange={set('amount')}
          className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
        />
      </div>
      <div>
        <label className="block text-[11px] font-medium text-slate-500 mb-1">Remarks</label>
        <input type="text" value={draft.remarks} onChange={set('remarks')} className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white" />
      </div>
    </div>
  );
};
// Full detail view for ONE User Claim — opened by clicking a "User Claim" row
// in the unified table above. Ported from the old always-expanded
// UserClaimsReviewPanel list so nothing is lost (edit, delete, approve/reject
// for legacy pending claims with no Approval Request, referenced check-in/out
// map, attachment link) — just shown one claim at a time instead of a long list.
const UserClaimDetailModal: React.FC<{
  claim: UserClaim;
  token: string;
  onClose: () => void;
  onChanged: () => void;
}> = ({ claim, token, onClose, onChanged }) => {
  const authHeaders = { Authorization: `Bearer ${token}` };

  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState({
    claim_date: String(claim.claim_date).slice(0, 10),
    from_date: String(claim.from_date).slice(0, 10),
    to_date: String(claim.to_date).slice(0, 10),
    category: claim.category,
    amount: String(claim.amount),
    description: claim.description || ''
  });
  const [saving, setSaving] = useState(false);
  const [acting, setActing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState('');
  const [viewingRef, setViewingRef] = useState<UserClaimReference | null>(null);

  const hasRefs = !!claim.claim_refs && claim.claim_refs.length > 0;

  const refToClaimRecord = (ref: UserClaimReference): ClaimRecord => ({
    id: ref.claim_id,
    user_id: claim.user_id,
    user_name: claim.user_name,
    purpose: ref.purpose,
    status: ref.check_out_at ? 'completed' : 'open',
    check_in_at: ref.check_in_at,
    check_in_lat: Number(ref.check_in_lat),
    check_in_lng: Number(ref.check_in_lng),
    check_out_at: ref.check_out_at,
    check_out_lat: ref.check_out_lat != null ? Number(ref.check_out_lat) : null,
    check_out_lng: ref.check_out_lng != null ? Number(ref.check_out_lng) : null,
    distance_km: ref.distance_km,
    check_in_approval: ref.check_in_approval,
    check_out_approval: ref.check_out_approval
  });

  const startEdit = () => {
    setError('');
    setEditDraft({
      claim_date: String(claim.claim_date).slice(0, 10),
      from_date: String(claim.from_date).slice(0, 10),
      to_date: String(claim.to_date).slice(0, 10),
      category: claim.category,
      amount: String(claim.amount),
      description: claim.description || ''
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    if (String(editDraft.to_date) < String(editDraft.from_date)) {
      setError("To Date can't be before From Date.");
      return;
    }
    if (!hasRefs && (!editDraft.amount || Number(editDraft.amount) <= 0)) {
      setError('Claim Amount must be a positive number.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/user-claims/${claim.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          claim_date: editDraft.claim_date,
          from_date: editDraft.from_date,
          to_date: editDraft.to_date,
          category: editDraft.category,
          amount: hasRefs ? undefined : Number(editDraft.amount),
          description: editDraft.description.trim() || undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update claim');
      setEditing(false);
      onChanged();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to update claim');
    } finally {
      setSaving(false);
    }
  };

  const handleDecision = async (action: 'approve' | 'reject') => {
    if (action === 'reject' && !remarks.trim()) {
      setError('Add a remark so the User understands why this was rejected.');
      return;
    }
    setActing(true);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/user-claims/${claim.id}/decision`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ action, remarks: remarks.trim() || undefined })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to record the decision');
      onChanged();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to record the decision');
    } finally {
      setActing(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete this ${claim.category} claim from ${claim.user_name || 'this user'}? This cannot be undone.`)) return;
    setDeleting(true);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/user-claims/${claim.id}`), { method: 'DELETE', headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete claim');
      onChanged();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to delete claim');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between gap-4 p-5 border-b border-slate-200">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-slate-900 flex items-center gap-2 flex-wrap">
              {claim.category} Claim
              {claim.has_file && <Paperclip className="w-3.5 h-3.5 text-slate-400" />}
              <UserClaimStatusBadge status={claim.status} />
            </h3>
            <p className="text-xs text-slate-500 mt-0.5 truncate">{claim.user_name || '—'}</p>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors shrink-0">
            <X className="w-4.5 h-4.5" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          {error && <p className="text-xs px-3 py-2 rounded-lg bg-rose-50 text-rose-700">{error}</p>}

          {editing ? (
            <div className="space-y-2.5 bg-slate-50 border border-slate-200 rounded-xl p-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div>
                  <label className="block text-[10px] font-semibold text-slate-500 mb-1">Claim Date</label>
                  <input
                    type="date"
                    value={editDraft.claim_date}
                    onChange={(e) => setEditDraft((d) => ({ ...d, claim_date: e.target.value }))}
                    className="w-full text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-slate-500 mb-1">From</label>
                  <input
                    type="date"
                    value={editDraft.from_date}
                    onChange={(e) => setEditDraft((d) => ({ ...d, from_date: e.target.value }))}
                    className="w-full text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-slate-500 mb-1">To</label>
                  <input
                    type="date"
                    value={editDraft.to_date}
                    onChange={(e) => setEditDraft((d) => ({ ...d, to_date: e.target.value }))}
                    className="w-full text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-slate-500 mb-1">Category</label>
                  <select
                    value={editDraft.category}
                    onChange={(e) => setEditDraft((d) => ({ ...d, category: e.target.value as UserClaimCategory }))}
                    className="w-full text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  >
                    {USER_CLAIM_CATEGORIES.map((cat) => (
                      <option key={cat} value={cat}>{cat}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1">
                  Amount {hasRefs && '(derived from referenced check-in/outs — not editable)'}
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={editDraft.amount}
                  disabled={hasRefs}
                  onChange={(e) => setEditDraft((d) => ({ ...d, amount: e.target.value }))}
                  className="w-full text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none disabled:opacity-60"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1">Description</label>
                <textarea
                  value={editDraft.description}
                  onChange={(e) => setEditDraft((d) => ({ ...d, description: e.target.value }))}
                  rows={2}
                  className="w-full text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none resize-none"
                />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  disabled={saving}
                  className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 font-medium disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={saving}
                  className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-50 transition-colors"
                >
                  {saving ? <Spinner size={14} /> : <Save className="w-3.5 h-3.5" />}
                  Save
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="text-xs text-slate-500">
                {formatDate(claim.claim_date)}
                {String(claim.from_date) !== String(claim.to_date) && (
                  <span> (covers {formatDate(claim.from_date)} → {formatDate(claim.to_date)})</span>
                )}
                {' · '}
                <span className="font-semibold text-slate-800">
                  ৳{Number(claim.amount).toLocaleString('en-BD', { minimumFractionDigits: 2 })}
                </span>
              </div>

              {claim.description && <p className="text-xs text-slate-600">{claim.description}</p>}

              {hasRefs && (
                <div className="space-y-1">
                  {claim.claim_refs!.map((r) => (
                    <button
                      key={r.claim_id}
                      type="button"
                      onClick={() => setViewingRef(r)}
                      title="View check-in/out location"
                      className="w-full flex items-center justify-between gap-2 text-[11px] px-2 py-1 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-200 rounded-lg transition-colors text-left"
                    >
                      <span className="flex items-center gap-1 text-slate-600 min-w-0 truncate">
                        <MapPin className="w-3 h-3 text-blue-500 shrink-0" />
                        {formatDate(r.check_in_at)} · {r.purpose}
                      </span>
                      <span className="shrink-0 font-semibold text-slate-800">
                        ৳{Number(r.amount).toLocaleString('en-BD', { minimumFractionDigits: 2 })}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {claim.has_file && (
                <a
                  href={apiUrl(`/api/user-claims/${claim.id}/file`)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-blue-600 font-semibold hover:underline"
                >
                  <Paperclip className="w-3 h-3" /> View attachment
                </a>
              )}

              {claim.status !== 'pending' && claim.admin_remarks && (
                <p className="text-xs text-slate-500">
                  <span className="font-semibold text-slate-600">Remarks:</span> {claim.admin_remarks}
                </p>
              )}
              {claim.status === 'approved' && claim.bill_id && (
                <p className="text-[11px] text-slate-400">Attached to Bill #{claim.bill_id}.</p>
              )}

              {/* History — every log recorded against this claim: submission,
                  then each Approval Workflow Layer's decision (if it went
                  through a chain), or the single legacy decision (if it
                  didn't). Newest last, same order things actually happened. */}
              <div className="pt-2 border-t border-slate-100">
                <div className="text-[11px] font-semibold text-slate-400 mb-1.5">History</div>
                <div className="space-y-1.5">
                  <div className="flex items-start gap-2 text-xs">
                    <Clock className="w-3.5 h-3.5 text-slate-300 mt-0.5 shrink-0" />
                    <div className="text-slate-600">
                      Submitted by {claim.user_name || 'this user'}
                      {claim.created_at && <span className="text-slate-400"> &middot; {formatDate(claim.created_at)}</span>}
                    </div>
                  </div>
                  {claim.approval && claim.approval.actions && claim.approval.actions.length > 0 ? (
                    [...claim.approval.actions]
                      .sort((a, b) => a.step_order - b.step_order)
                      .map((a, i) => (
                        <div key={i} className="flex items-start gap-2 text-xs">
                          {a.action === 'approved' ? (
                            <Check className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
                          ) : (
                            <X className="w-3.5 h-3.5 text-rose-500 mt-0.5 shrink-0" />
                          )}
                          <div className={a.action === 'approved' ? 'text-emerald-700' : 'text-rose-700'}>
                            {a.approver_name} {a.action === 'approved' ? 'approved' : 'rejected'} (Layer {a.step_order})
                            {a.acted_at && <span className="text-slate-400"> &middot; {formatDate(a.acted_at)}</span>}
                            {a.remarks && <div className="text-slate-500 mt-0.5">"{a.remarks}"</div>}
                          </div>
                        </div>
                      ))
                  ) : claim.status !== 'pending' && claim.reviewed_by_name ? (
                    <div className="flex items-start gap-2 text-xs">
                      {claim.status === 'approved' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-500 mt-0.5 shrink-0" />
                      ) : (
                        <X className="w-3.5 h-3.5 text-rose-500 mt-0.5 shrink-0" />
                      )}
                      <div className={claim.status === 'approved' ? 'text-emerald-700' : 'text-rose-700'}>
                        {claim.reviewed_by_name} {claim.status}
                        {claim.reviewed_at && <span className="text-slate-400"> &middot; {formatDate(claim.reviewed_at)}</span>}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>

              {claim.status === 'pending' && (
                <>
                  {claim.approval ? (
                    <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700">
                      <Clock className="w-3.5 h-3.5 shrink-0" />
                      Waiting on Approval Workflow — step {claim.approval.current_step} of {claim.approval.total_steps}. Act on it
                      from the <span className="font-semibold">Approvals</span> tab.
                    </div>
                  ) : (
                    <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                      <input
                        type="text"
                        placeholder="Remarks (required to reject)"
                        value={remarks}
                        onChange={(e) => setRemarks(e.target.value)}
                        className="flex-1 min-w-[160px] text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={acting}
                          onClick={() => handleDecision('approve')}
                          className="flex items-center gap-1 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50 transition-colors"
                        >
                          {acting ? <Spinner size={14} /> : <Check className="w-3.5 h-3.5" />}
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={acting}
                          onClick={() => handleDecision('reject')}
                          className="flex items-center gap-1 text-xs px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-semibold disabled:opacity-50 transition-colors"
                        >
                          {acting ? <Spinner size={14} /> : <X className="w-3.5 h-3.5" />}
                          Reject
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}

              <div className="flex gap-2 justify-end pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg text-rose-600 hover:bg-rose-50 font-medium disabled:opacity-50 transition-colors"
                >
                  {deleting ? <Spinner size={14} /> : <Trash2 className="w-3.5 h-3.5" />} Delete
                </button>
                <button
                  type="button"
                  onClick={startEdit}
                  className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-blue-50 border border-blue-200 text-blue-700 font-medium transition-colors"
                >
                  <Pencil className="w-3.5 h-3.5" /> Edit
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {viewingRef && (
        <ClaimLocationMap claim={refToClaimRecord(viewingRef)} onClose={() => setViewingRef(null)} />
      )}
    </div>
  );
};