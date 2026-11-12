import React, { useEffect, useMemo, useRef, useState } from 'react';
import jsPDF from '../lib/jspdf';
import { loadBillApprovers, drawApproverBlock } from '../lib/approverSignatures';
import autoTable from 'jspdf-autotable';
import { Banknote, Printer, CheckSquare, Square, RotateCcw, X, ReceiptText, Search } from 'lucide-react';
import { ConveyanceBill, ConveyanceBillItem, User } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate, todayDateOnlyString } from '../lib/formatDate';
import { finalizePdfPageNumbers } from '../lib/pdfLetterhead';
import { drawStandardHeader, loadPdfCompany, pdfMoney, standardTable } from '../lib/pdfStandard';
import { savePdfCrossPlatform } from '../lib/saveFile';
import { EmailReportButton, emailReport, useCanEmailReports } from '../lib/reportEmail';
import { Spinner } from './Spinner';
import { PagerBar } from './PagerBar';
import { confirmDialog } from '../lib/confirmDialog';

import { SearchSelect } from './Combobox';
import { personLabel } from '../lib/personLabel';
import { PhoneSheet } from './PhoneSheet';
// ---- Voucher sections ----
// The Payment Voucher groups a Bill's lines by category, each with the
// columns it needs: travel categories (and Check In/Out / manual items,
// which are trips) show From / To / Distance; any other category shows a
// Description. An item from a Bill Claim is split into that
// claim's own category lines; if it was approved for less than those lines
// add up to, the difference is an Adjustment line so the total is what was
// paid.
interface VoucherLine {
  date: string | null;
  particulars: string;
  from?: string | null;
  to?: string | null;
  km?: number | null;
  amount: number;
}
interface VoucherSection {
  category: string;
  kind: 'travel' | 'other' | 'adjustment';
  lines: VoucherLine[];
  total: number;
}
const TRAVEL_CATEGORY = /convey|transport|travel|movement|rickshaw|cng|bus|taxi|ride|uber|pathao/i;

function voucherSections(items: ConveyanceBillItem[]): VoucherSection[] {
  const byCategory = new Map<string, VoucherSection>();
  const add = (category: string, kind: VoucherSection['kind'], line: VoucherLine) => {
    const key = kind === 'adjustment' ? '__adjustment' : category.trim().toLowerCase();
    if (!byCategory.has(key)) byCategory.set(key, { category, kind, lines: [], total: 0 });
    const sec = byCategory.get(key)!;
    sec.lines.push(line);
    sec.total = Math.round((sec.total + line.amount) * 100) / 100;
  };
  const kindOf = (category: string) => (TRAVEL_CATEGORY.test(category) ? 'travel' : 'other');
  for (const it of items) {
    const amount = Number(it.amount);
    if (it.source !== 'bill_claim') {
      add('Conveyance', 'travel', { date: it.entry_date, particulars: it.particulars || '', from: it.from_location, to: it.to_location, km: it.distance_km, amount });
      continue;
    }
    const lines = it.claim_lines || [];
    if (!lines.length) {
      const category = it.claim_category || 'Others';
      add(category, kindOf(category), { date: it.entry_date, particulars: it.particulars || '', amount });
      continue;
    }
    for (const l of lines) {
      add(l.category, kindOf(l.category), { date: l.bill_date, particulars: l.description || it.particulars || '', amount: Number(l.amount) });
    }
    const claimed = lines.reduce((s, l) => s + Number(l.amount), 0);
    const diff = Math.round((amount - claimed) * 100) / 100;
    if (Math.abs(diff) >= 0.01) {
      add('Adjustment', 'adjustment', {
        date: it.entry_date,
        particulars: `${diff < 0 ? 'Deducted at approval' : 'Added at approval'} — claim of ${formatDate(it.entry_date)} (claimed ${pdfMoney(claimed)}, approved ${pdfMoney(amount)})`,
        amount: diff
      });
    }
  }
  const order = (sec: VoucherSection) => (sec.kind === 'travel' ? 0 : sec.kind === 'other' ? 1 : 2);
  return [...byCategory.values()].sort((a, b) => order(a) - order(b));
}

// ---- Toolbar filters ----
interface FilterOptions {
  departments: string[];
  designations: string[];
  branches: string[];
  disbursers: { id: number; name: string }[];
  categories: string[];
}
interface BillSummary {
  bills: number;
  total: number;
  pending: number;
  pending_total: number;
  disbursed: number;
  disbursed_total: number;
}
const SOURCE_LABEL: Record<string, string> = { bill_claim: 'Bill Claim', checkin: 'Check In/Out', manual: 'Typed in (manual)' };
const LBL = 'block text-[10px] font-semibold text-slate-500 mb-1';
const INPUT = 'w-full text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:outline-none';
const money = (n: number) => Number(n || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type PeriodKey = 'any' | 'this_month' | 'last_month' | 'this_year' | 'custom';
const PERIOD_LABEL: Record<PeriodKey, string> = { any: 'Any time', this_month: 'This month', last_month: 'Last month', this_year: 'This year', custom: 'Pick dates…' };
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function periodRange(p: PeriodKey, custom: { from: string; to: string }): { from: string; to: string } {
  const now = new Date();
  if (p === 'this_month') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to: ymd(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
  if (p === 'last_month') return { from: ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: ymd(new Date(now.getFullYear(), now.getMonth(), 0)) };
  if (p === 'this_year') return { from: `${now.getFullYear()}-01-01`, to: `${now.getFullYear()}-12-31` };
  if (p === 'custom') return custom;
  return { from: '', to: '' };
}
const periodText = (p: PeriodKey, r: { from: string; to: string }) =>
  p === 'custom' ? `${r.from ? formatDate(r.from) : '…'} – ${r.to ? formatDate(r.to) : '…'}` : PERIOD_LABEL[p];

const PeriodField: React.FC<{
  id: string;
  label: string;
  value: PeriodKey;
  onChange: (p: PeriodKey) => void;
  range: { from: string; to: string };
  onRange: (r: { from: string; to: string }) => void;
}> = ({ id, label, value, onChange, range, onRange }) => (
  <div className="min-w-0">
    <label htmlFor={id} className={LBL}>{label}</label>
    <select id={id} value={value} onChange={(e) => onChange(e.target.value as PeriodKey)} className={INPUT}>
      {(Object.keys(PERIOD_LABEL) as PeriodKey[]).map((k) => (
        <option key={k} value={k}>{PERIOD_LABEL[k]}</option>
      ))}
    </select>
    {value === 'custom' && (
      <div className="grid grid-cols-2 gap-1.5 mt-1.5">
        <input type="date" aria-label={`${label} from`} value={range.from} onChange={(e) => onRange({ ...range, from: e.target.value })} className={INPUT} />
        <input type="date" aria-label={`${label} to`} value={range.to} onChange={(e) => onRange({ ...range, to: e.target.value })} className={INPUT} />
      </div>
    )}
  </div>
);

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

// Admin Panel -> Bill Disbursement (Superadmin + explicitly-granted
// Admins only — see ADMIN_MODULES/'disbursement'). Sits one step downstream of
// Bill Claim: once a Bill's items have been approved and finalized
// there, this is where the money actually going out gets recorded (a Voucher
// No + who/when) and a printable Payment Voucher is produced for the
// claimant's signature. Kept as its own module so an Admin can be allowed to
// BUILD bills without also being trusted to authorize payouts, and vice versa.
export const DisbursementPanel: React.FC<DisbursementPanelProps> = ({ token, users }) => {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const canEmailReports = useCanEmailReports();
  // Everyone who can have a claim: Users, Admins and a Superadmin who is also an employee.
  const plainUsers = users.filter((u) => u.role !== 'superadmin' || !!u.employee_code);

  const [bills, setBills] = useState<ConveyanceBill[]>([]);
  // Claims approved by every Layer and now at a "Conveyance Disburser (Pay
  // Out)" Layer — no Bill yet; Disburse here (or in Approve Application)
  // makes the Bill and pays it (GET /api/disbursement/awaiting-claims).
  interface AwaitingClaim {
    approval_id: number;
    bill_claim_id: number;
    user_id: number;
    user_name: string | null;
    employee_code: string;
    designation: string;
    department: string;
    claim_date: string;
    category: string;
    description: string;
    amount: number;
    approved_amount: number;
    waiting_on: string[];
    can_disburse: boolean;
  }
  const [awaiting, setAwaiting] = useState<AwaitingClaim[]>([]);
  const [awaitVoucher, setAwaitVoucher] = useState<Record<number, string>>({});
  const [awaitBusy, setAwaitBusy] = useState<number | null>(null);
  const [awaitMsg, setAwaitMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const loadAwaiting = async () => {
    try {
      const res = await fetch(apiUrl('/api/disbursement/awaiting-claims'), { headers: authHeaders });
      setAwaiting(res.ok ? await res.json() : []);
    } catch {
      setAwaiting([]);
    }
  };
  useEffect(() => {
    void loadAwaiting();
  }, [token]);
  const disburseAwaiting = async (c: AwaitingClaim) => {
    const ok = await confirmDialog(
      `Disburse ৳${c.approved_amount.toLocaleString('en-BD', { minimumFractionDigits: 2 })} to ${c.user_name || 'this employee'}? The claim is approved, put on its own Bill and marked paid.`
    );
    if (!ok) return;
    setAwaitBusy(c.approval_id);
    setAwaitMsg(null);
    try {
      const res = await fetch(apiUrl(`/api/my-approvals/${c.approval_id}/act`), {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approved', voucher_no: awaitVoucher[c.approval_id] || undefined })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not disburse this claim.');
      setAwaitMsg({ ok: true, text: `Disbursed${data.voucher_no ? ` — voucher ${data.voucher_no}` : ''}.` });
      await loadAwaiting();
      void fetchBills();
    } catch (err: any) {
      setAwaitMsg({ ok: false, text: err.message || 'Could not disburse this claim.' });
    } finally {
      setAwaitBusy(null);
    }
  };
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  // ---- Filters (all in the toolbar; the server does the filtering) ----
  const [userFilter, setUserFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'disbursed'>('pending');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState(''); // `search`, a moment after typing stops
  const [department, setDepartment] = useState('');
  const [designation, setDesignation] = useState('');
  const [branch, setBranch] = useState('');
  const [billPeriod, setBillPeriod] = useState<PeriodKey>('any');
  const [billRange, setBillRange] = useState({ from: '', to: '' });
  const [paidPeriod, setPaidPeriod] = useState<PeriodKey>('any');
  const [paidRange, setPaidRange] = useState({ from: '', to: '' });
  const [disbursedBy, setDisbursedBy] = useState('');
  const [category, setCategory] = useState('');
  const [source, setSource] = useState('');
  const [minAmt, setMinAmt] = useState('');
  const [maxAmt, setMaxAmt] = useState('');
  const [options, setOptions] = useState<FilterOptions>({ departments: [], designations: [], branches: [], disbursers: [], categories: [] });
  const [summary, setSummary] = useState<BillSummary | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    fetch(apiUrl('/api/conveyance-bills/filter-options'), { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setOptions(d))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const billDates = periodRange(billPeriod, billRange);
  const paidDates = periodRange(paidPeriod, paidRange);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  // One page of bills at a time; every filter is applied on the server.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [total, setTotal] = useState(0);
  const listReq = useRef(0);
  const filterParams = useMemo(() => {
    const p = new URLSearchParams();
    if (userFilter) p.set('user_id', userFilter);
    if (statusFilter !== 'all') p.set('status', statusFilter);
    if (q) p.set('q', q);
    if (department) p.set('department', department);
    if (designation) p.set('designation', designation);
    if (branch) p.set('branch', branch);
    if (billDates.from) p.set('from', billDates.from);
    if (billDates.to) p.set('to', billDates.to);
    if (paidDates.from) p.set('dfrom', paidDates.from);
    if (paidDates.to) p.set('dto', paidDates.to);
    if (disbursedBy) p.set('disbursed_by', disbursedBy);
    if (category) p.set('category', category);
    if (source) p.set('source', source);
    if (minAmt !== '') p.set('min', minAmt);
    if (maxAmt !== '') p.set('max', maxAmt);
    return p.toString();
  }, [userFilter, statusFilter, q, department, designation, branch, billDates.from, billDates.to, paidDates.from, paidDates.to, disbursedBy, category, source, minAmt, maxAmt]);

  const fetchBills = async () => {
    const req = ++listReq.current;
    setLoading(true);
    setLoadError('');
    try {
      const params = new URLSearchParams(filterParams);
      params.set('page', String(page));
      params.set('limit', String(pageSize));
      const res = await fetch(apiUrl(`/api/conveyance-bills?${params.toString()}`), { headers: authHeaders });
      if (req !== listReq.current) return; // a newer request is on its way
      if (res.ok) {
        const data = await res.json();
        setBills(Array.isArray(data) ? data : data.rows || []);
        setTotal(Array.isArray(data) ? data.length : Number(data.total) || 0);
        setSummary(Array.isArray(data) ? null : data.summary || null);
      } else {
        setLoadError('Failed to load conveyance bills.');
      }
    } catch (err) {
      console.error('Failed to load conveyance bills', err);
      setLoadError('Failed to load conveyance bills.');
    } finally {
      if (req === listReq.current) setLoading(false);
    }
  };

  // Any filter change starts again from page 1.
  const firstFilters = useRef(true);
  useEffect(() => {
    if (firstFilters.current) {
      firstFilters.current = false;
      return;
    }
    if (page !== 1) setPage(1);
    else void fetchBills();
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterParams]);
  useEffect(() => {
    fetchBills();
    // Selection is per page — what's ticked is always on screen.
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, pageSize]);

  const visibleBills = bills;

  // The Employee list follows the Department (and Designation / Branch) picked.
  const pickableUsers = plainUsers.filter(
    (u: any) => (!department || u.department === department) && (!designation || u.designation === designation) && (!branch || u.branch === branch)
  );
  useEffect(() => {
    if (userFilter && !pickableUsers.some((u) => String(u.id) === userFilter)) setUserFilter('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [department, designation, branch]);

  // What is switched on, as chips (each with its own ×).
  const userName = plainUsers.find((u) => String(u.id) === userFilter)?.name;
  const chips: { label: string; clear: () => void }[] = [
    ...(search.trim() ? [{ label: `Search: ${search.trim()}`, clear: () => setSearch('') }] : []),
    ...(department ? [{ label: `Department: ${department}`, clear: () => setDepartment('') }] : []),
    ...(userFilter ? [{ label: `Employee: ${userName || userFilter}`, clear: () => setUserFilter('') }] : []),
    ...(designation ? [{ label: `Designation: ${designation}`, clear: () => setDesignation('') }] : []),
    ...(branch ? [{ label: `Branch: ${branch}`, clear: () => setBranch('') }] : []),
    ...(billPeriod !== 'any' && (billDates.from || billDates.to) ? [{ label: `Bill date: ${periodText(billPeriod, billDates)}`, clear: () => setBillPeriod('any') }] : []),
    ...(paidPeriod !== 'any' && (paidDates.from || paidDates.to) ? [{ label: `Disbursed: ${periodText(paidPeriod, paidDates)}`, clear: () => setPaidPeriod('any') }] : []),
    ...(disbursedBy ? [{ label: `Disbursed by: ${options.disbursers.find((d) => String(d.id) === disbursedBy)?.name || disbursedBy}`, clear: () => setDisbursedBy('') }] : []),
    ...(category ? [{ label: `Category: ${category}`, clear: () => setCategory('') }] : []),
    ...(source ? [{ label: `Source: ${SOURCE_LABEL[source] || source}`, clear: () => setSource('') }] : []),
    ...(minAmt !== '' ? [{ label: `Amount ≥ ৳${minAmt}`, clear: () => setMinAmt('') }] : []),
    ...(maxAmt !== '' ? [{ label: `Amount ≤ ৳${maxAmt}`, clear: () => setMaxAmt('') }] : [])
  ];
  const clearAll = () => {
    setSearch('');
    setDepartment('');
    setUserFilter('');
    setDesignation('');
    setBranch('');
    setBillPeriod('any');
    setPaidPeriod('any');
    setDisbursedBy('');
    setCategory('');
    setSource('');
    setMinAmt('');
    setMaxAmt('');
  };

  // "Claims waiting to be paid out" follows the same filters (they are
  // approved Bill Claims with no Bill yet, so disbursed-only filters hide them).
  const awaitingShown = awaiting.filter((c) => {
    if (paidDates.from || paidDates.to || disbursedBy) return false;
    if (source && source !== 'bill_claim') return false;
    if (userFilter && String(c.user_id) !== userFilter) return false;
    if (department && c.department !== department) return false;
    if (designation && c.designation !== designation) return false;
    if (branch) {
      const u: any = plainUsers.find((x) => x.id === c.user_id);
      if (!u || u.branch !== branch) return false;
    }
    const d = String(c.claim_date || '').slice(0, 10);
    if (billDates.from && d < billDates.from) return false;
    if (billDates.to && d > billDates.to) return false;
    if (category && c.category !== category) return false;
    if (minAmt !== '' && c.approved_amount < Number(minAmt)) return false;
    if (maxAmt !== '' && c.approved_amount > Number(maxAmt)) return false;
    if (q) {
      const t = q.toLowerCase();
      if (![c.user_name, c.employee_code, `#${c.bill_claim_id}`].some((v) => String(v || '').toLowerCase().includes(t))) return false;
    }
    return true;
  });

  // A Bill with no line items yet can't be disbursed (the server refuses it),
  // so it gets no checkbox or Disburse button until items are added.
  const canDisburse = (b: ConveyanceBill) => !b.is_disbursed && Number(b.item_count || 0) > 0;
  const selectableIds = useMemo(() => visibleBills.filter(canDisburse).map((b) => b.id), [visibleBills]);
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
  const buildAndSaveVoucherPdf = async (billId: number, mode: 'save' | 'email' = 'save') => {
    const res = await fetch(apiUrl(`/api/conveyance-bills/${billId}`), { headers: authHeaders });
    if (!res.ok) throw new Error(`Failed to load Bill CB-${billId} for its voucher.`);
    const bill: ConveyanceBill = await res.json();

    const co = await loadPdfCompany(token);
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const sections = voucherSections(bill.items || []);
    const total = sections.reduce((s, sec) => s + sec.total, 0);

    let y = drawStandardHeader(doc, co, 'Bill Payment Voucher', [
      ['Voucher No', bill.voucher_no || '-'],
      ['Employee Name', bill.user_name || '-'],
      ['Employee Code', bill.employee_code || '-'],
      ['Designation', bill.designation || '-'],
      ['Department', bill.department || '-'],
      ['Bill No', `CB-${bill.id}`],
      ['Bill Date', formatDate(bill.bill_date) || '-'],
      ['Claim Category', sections.filter((sec) => sec.kind !== 'adjustment').map((sec) => sec.category).join(', ') || '-'],
      ['Status', bill.is_disbursed ? `Disbursed${bill.disbursed_at ? ` on ${formatDate(bill.disbursed_at)}` : ''}${bill.disbursed_by_name ? ` by ${bill.disbursed_by_name}` : ''}` : 'Not disbursed']
    ]);
    const roomFor = (h: number) => {
      if (y + h > pageHeight - 18) {
        doc.addPage();
        y = 14;
      }
    };
    const left = { halign: 'left' as const };

    // One table per category, each with the columns that category needs.
    for (const sec of sections) {
      roomFor(22);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.setTextColor(40, 40, 40);
      doc.text(sec.kind === 'adjustment' ? 'Adjustment' : sec.category, 8, y + 2);
      const base = standardTable(y + 4);
      if (sec.kind === 'travel') {
        autoTable(doc, {
          ...base,
          head: [['Serial', 'Date', 'Particulars', 'From', 'To', 'Distance (KM)', 'Amount']],
          body: sec.lines.map((l, i) => [String(i + 1), formatDate(l.date) || '', l.particulars, l.from || '-', l.to || '-', l.km != null ? String(l.km) : '-', pdfMoney(l.amount)]),
          foot: [[{ content: 'Subtotal', colSpan: 6, styles: left }, pdfMoney(sec.total)]],
          columnStyles: { 0: { cellWidth: 13, halign: 'center' }, 1: { cellWidth: 22, halign: 'center' }, 3: { cellWidth: 30 }, 4: { cellWidth: 30 }, 5: { cellWidth: 20, halign: 'right' }, 6: { cellWidth: 24, halign: 'right' } }
        });
      } else if (sec.kind === 'adjustment') {
        autoTable(doc, {
          ...base,
          head: [['Serial', 'Particulars', 'Amount']],
          body: sec.lines.map((l, i) => [String(i + 1), l.particulars, pdfMoney(l.amount)]),
          columnStyles: { 0: { cellWidth: 13, halign: 'center' }, 2: { cellWidth: 24, halign: 'right' } }
        });
      } else {
        autoTable(doc, {
          ...base,
          head: [['Serial', 'Date', 'Description', 'Amount']],
          body: sec.lines.map((l, i) => [String(i + 1), formatDate(l.date) || '', l.particulars, pdfMoney(l.amount)]),
          foot: [[{ content: 'Subtotal', colSpan: 3, styles: left }, pdfMoney(sec.total)]],
          columnStyles: { 0: { cellWidth: 13, halign: 'center' }, 1: { cellWidth: 22, halign: 'center' }, 3: { cellWidth: 24, halign: 'right' } }
        });
      }
      y = (doc as any).lastAutoTable.finalY + 7;
    }

    // Category summary and the amount paid.
    roomFor(20 + sections.length * 6);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text('Summary', 8, y + 2);
    autoTable(doc, {
      ...standardTable(y + 4),
      tableWidth: 110,
      head: [['Category', 'Amount']],
      body: sections.map((sec) => [sec.kind === 'adjustment' ? 'Adjustment' : sec.category, pdfMoney(sec.total)]),
      foot: [[{ content: 'Total Amount', styles: left }, pdfMoney(total)]],
      columnStyles: { 1: { cellWidth: 30, halign: 'right' } }
    });
    y = (doc as any).lastAutoTable.finalY;

    roomFor(45);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(40, 40, 40);
    doc.text(`Received Tk ${pdfMoney(total)} in full settlement of the bill claim referenced above.`, 8, y + 8, { maxWidth: pageWidth - 16 });

    // Signature lines — a Voucher is a physical payout receipt, so leave room
    // for both the person disbursing and the claimant receiving to sign.
    // Each approving Layer's signature (Bill Claim Policy -> "Put each approver's
    // signature on the Bill and Voucher"); with none, the plain "Approved By" line.
    const approvers = await loadBillApprovers(token, bill.id);
    let sigY = y + 32;
    if (approvers.length) {
      const below = drawApproverBlock(doc, approvers, y + 16, 8, pageWidth - 8, { perRow: 3, title: 'Approved By' });
      sigY = below + 14;
      if (sigY > pageHeight - 20) {
        doc.addPage();
        sigY = 30;
      }
    }
    doc.setDrawColor(120, 120, 120);
    doc.setLineWidth(0.2);
    doc.line(8, sigY, 62, sigY);
    if (!approvers.length) doc.line(pageWidth / 2 - 27, sigY, pageWidth / 2 + 27, sigY);
    doc.line(pageWidth - 62, sigY, pageWidth - 8, sigY);
    doc.setFontSize(7.5);
    doc.text('Prepared By', 35, sigY + 4, { align: 'center' });
    if (!approvers.length) doc.text('Approved By', pageWidth / 2, sigY + 4, { align: 'center' });
    doc.text('Received By (Claimant)', pageWidth - 35, sigY + 4, { align: 'center' });

    finalizePdfPageNumbers(doc);
    const filename = `Payment_Voucher_${bill.voucher_no || bill.id}_${bill.user_name?.replace(/\s+/g, '_') || 'user'}.pdf`;
    if (mode === 'email') {
      await emailReport(doc, { fileName: filename, title: 'Bill Payment Voucher' });
      return;
    }
    await savePdfCrossPlatform(doc, filename);
  };

  const [printingId, setPrintingId] = useState<number | null>(null);
  const handlePrintVoucher = async (billRow: ConveyanceBill, mode: 'save' | 'email' = 'save') => {
    setPrintingId(billRow.id);
    try {
      await buildAndSaveVoucherPdf(billRow.id, mode);
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
    if (!(await confirmDialog('Mark this Bill back as Pending? The Voucher No. will be cleared.'))) return;
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
              <Banknote className="w-4 h-4 text-emerald-600" /> Bill Disbursement
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Mark finalized Bills as disbursed and print a Payment Voucher for each. Select one or more
              Pending bills to disburse them together.
            </p>
          </div>

          <div className="flex flex-col gap-3" data-testid="disb-toolbar">
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <div className="min-w-0 flex-1">
                <label htmlFor="disb-search" className={LBL}>Search</label>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    id="disb-search"
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Name, Employee ID, Bill No (CB-12) or Voucher No"
                    className={`${INPUT} pl-8`}
                  />
                </div>
              </div>
              <div className="min-w-0 sm:w-64">
                <span className={LBL}>Status</span>
                <div className="flex bg-slate-100 rounded-lg p-0.5" role="group" aria-label="Status">
                  {(['pending', 'disbursed', 'all'] as const).map((st) => (
                    <button
                      key={st}
                      type="button"
                      aria-pressed={statusFilter === st}
                      onClick={() => setStatusFilter(st)}
                      className={`flex-1 px-2.5 py-1.5 rounded-md text-[11px] font-semibold capitalize transition-colors ${
                        statusFilter === st ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'
                      }`}
                    >
                      {st}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <PhoneSheet label="Filters" kind="filter" title="Filter bills" activeCount={chips.filter((c) => !c.label.startsWith('Search:')).length}>
              <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-2 items-end">
                <div className="min-w-0">
                  <span className={LBL}>Department</span>
                  <SearchSelect value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department" className={INPUT}>
                    <option value="">All departments</option>
                    {options.departments.map((d) => <option key={d} value={d}>{d}</option>)}
                  </SearchSelect>
                </div>
                <div className="min-w-0">
                  <span className={LBL}>Employee</span>
                  <SearchSelect value={userFilter} onChange={(e) => setUserFilter(e.target.value)} aria-label="Employee" className={INPUT}>
                    <option value="">{department ? `All in ${department} (${pickableUsers.length})` : 'All employees'}</option>
                    {pickableUsers.map((u) => <option key={u.id} value={u.id}>{personLabel(u)}</option>)}
                  </SearchSelect>
                </div>
                <div className="min-w-0">
                  <span className={LBL}>Designation</span>
                  <SearchSelect value={designation} onChange={(e) => setDesignation(e.target.value)} aria-label="Designation" className={INPUT}>
                    <option value="">All designations</option>
                    {options.designations.map((d) => <option key={d} value={d}>{d}</option>)}
                  </SearchSelect>
                </div>
                <div className="min-w-0">
                  <span className={LBL}>Branch</span>
                  <SearchSelect value={branch} onChange={(e) => setBranch(e.target.value)} aria-label="Branch" className={INPUT}>
                    <option value="">All branches</option>
                    {options.branches.map((d) => <option key={d} value={d}>{d}</option>)}
                  </SearchSelect>
                </div>
                <PeriodField id="disb-bill" label="Bill date" value={billPeriod} onChange={setBillPeriod} range={billRange} onRange={setBillRange} />
                <PeriodField id="disb-paid" label="Disbursed date" value={paidPeriod} onChange={setPaidPeriod} range={paidRange} onRange={setPaidRange} />
                <div className="min-w-0">
                  <span className={LBL}>Disbursed by</span>
                  <SearchSelect value={disbursedBy} onChange={(e) => setDisbursedBy(e.target.value)} aria-label="Disbursed by" className={INPUT}>
                    <option value="">Anyone</option>
                    {options.disbursers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </SearchSelect>
                </div>
                <div className="min-w-0">
                  <span className={LBL}>Category</span>
                  <SearchSelect value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className={INPUT}>
                    <option value="">Any category</option>
                    {options.categories.map((d) => <option key={d} value={d}>{d}</option>)}
                  </SearchSelect>
                </div>
                <div className="min-w-0">
                  <label htmlFor="disb-source" className={LBL}>Source</label>
                  <select id="disb-source" value={source} onChange={(e) => setSource(e.target.value)} className={INPUT}>
                    <option value="">Any source</option>
                    {Object.entries(SOURCE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </div>
                <div className="min-w-0 col-span-2 sm:col-span-1">
                  <span className={LBL}>Amount (৳)</span>
                  <div className="grid grid-cols-2 gap-1.5">
                    <input type="number" min={0} inputMode="decimal" aria-label="Amount from" placeholder="from" value={minAmt} onChange={(e) => setMinAmt(e.target.value)} className={INPUT} />
                    <input type="number" min={0} inputMode="decimal" aria-label="Amount to" placeholder="to" value={maxAmt} onChange={(e) => setMaxAmt(e.target.value)} className={INPUT} />
                  </div>
                </div>
              </div>
            </PhoneSheet>

            {(chips.length > 0 || selected.size > 0) && (
              <div className="flex flex-wrap items-center gap-1.5" data-testid="disb-chips">
                {chips.map((c) => (
                  <span key={c.label} className="inline-flex items-center gap-1 text-[11px] font-semibold pl-2.5 pr-1 py-1 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">
                    {c.label}
                    <button type="button" onClick={c.clear} aria-label={`Remove ${c.label}`} className="w-4 h-4 rounded-full grid place-items-center hover:bg-emerald-100">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                {chips.length > 1 && (
                  <button type="button" onClick={clearAll} className="text-[11px] font-semibold text-slate-500 underline hover:text-slate-800 px-1">
                    Clear all
                  </button>
                )}
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
            )}
          </div>
        </div>

        {summary && (
          <div className="flex flex-wrap gap-x-5 gap-y-1 px-4 sm:px-6 py-2.5 bg-slate-50 border-b border-slate-200 text-xs text-slate-500 tabular-nums" data-testid="disb-summary">
            <span>
              <b className="text-slate-900">{summary.bills}</b> bill{summary.bills === 1 ? '' : 's'}
            </span>
            <span>
              Total <b className="text-slate-900">৳{money(summary.total)}</b>
            </span>
            <span>
              Pending <b className="text-amber-700">৳{money(summary.pending_total)}</b> ({summary.pending})
            </span>
            <span>
              Disbursed <b className="text-emerald-700">৳{money(summary.disbursed_total)}</b> ({summary.disbursed})
            </span>
          </div>
        )}

        {statusFilter !== 'disbursed' && awaitingShown.length > 0 && (
          <div className="px-4 sm:px-6 pt-4">
            <div className="rounded-xl border border-amber-200 bg-amber-50/60">
              <div className="px-4 py-2.5 border-b border-amber-200 flex items-center gap-2">
                <ReceiptText className="w-4 h-4 text-amber-600" />
                <span className="text-sm font-bold text-slate-800">Claims waiting to be paid out</span>
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Pending</span>
              </div>
              <p className="px-4 pt-2 text-[11px] text-slate-500">
                Approved by every Layer and now at the Conveyance Disburser Layer. No Bill yet — Disburse puts the claim on its own Bill and marks it paid.
              </p>
              {awaitMsg && <p className={`px-4 pt-2 text-xs font-medium ${awaitMsg.ok ? 'text-emerald-700' : 'text-rose-600'}`}>{awaitMsg.text}</p>}
              <div className="divide-y divide-amber-100">
                {awaitingShown
                  .map((c) => (
                    <div key={c.approval_id} className="px-4 py-3 flex flex-col md:flex-row md:items-center gap-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-slate-800 truncate">
                          {[c.user_name, c.employee_code, c.designation, c.department].filter(Boolean).join(' · ')}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          Claim #{c.bill_claim_id} · {formatDate(c.claim_date)} · {c.category}
                          {c.description ? ` — ${c.description}` : ''}
                        </div>
                        <div className="text-[11px] text-slate-400">Waiting on: {c.waiting_on.join(', ') || '—'}</div>
                      </div>
                      <div className="text-sm font-bold text-slate-900 whitespace-nowrap">৳{c.approved_amount.toLocaleString('en-BD', { minimumFractionDigits: 2 })}</div>
                      {c.can_disburse ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            aria-label="Voucher no"
                            placeholder="Voucher no (blank = automatic)"
                            value={awaitVoucher[c.approval_id] || ''}
                            onChange={(e) => setAwaitVoucher((p) => ({ ...p, [c.approval_id]: e.target.value }))}
                            className="w-44 text-xs px-2.5 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-600 focus:outline-none"
                          />
                          <button
                            type="button"
                            disabled={awaitBusy === c.approval_id}
                            onClick={() => disburseAwaiting(c)}
                            className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50 whitespace-nowrap"
                          >
                            <Banknote className="w-3.5 h-3.5" /> {awaitBusy === c.approval_id ? 'Disbursing…' : 'Disburse'}
                          </button>
                        </div>
                      ) : (
                        <span className="text-[11px] text-slate-500 whitespace-nowrap">Only the Disburser Layer pays this out</span>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}

        {loadError && <p className="text-xs text-rose-600 px-6 pt-4">{loadError}</p>}

        {loading ? (
          <p className="text-xs text-slate-400 text-center py-12">Loading bills...</p>
        ) : visibleBills.length === 0 ? (
          <div className="text-center text-xs text-slate-400 py-12 flex flex-col items-center gap-2">
            <Banknote className="w-6 h-6 text-slate-300" />
            {chips.length ? 'No bills match these filters.' : statusFilter === 'pending' ? 'No bills waiting on disbursement.' : 'No conveyance bills found.'}
          </div>
        ) : (
          <>
            {/* Mobile — stacked cards. */}
            <div className="md:hidden divide-y divide-slate-100">
              {visibleBills.map((b) => (
                <div key={b.id} className="p-4 flex flex-col gap-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0">
                      {canDisburse(b) && (
                        <button type="button" onClick={() => toggleOne(b.id)} className="mt-0.5 text-slate-400 hover:text-emerald-600 shrink-0">
                          {selected.has(b.id) ? <CheckSquare className="w-4 h-4 text-emerald-600" /> : <Square className="w-4 h-4" />}
                        </button>
                      )}
                      <div className="min-w-0">
                        <p className="font-semibold text-slate-900 text-sm">CB-{b.id}</p>
                        <p className="text-xs text-slate-700 mt-0.5 truncate">{b.user_name || '—'}</p>
                        {(b.designation || b.department) && (
                          <p className="text-[11px] text-slate-500 truncate">{[b.employee_code, b.designation, b.department].filter(Boolean).join(' · ')}</p>
                        )}
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
                        {canEmailReports && (
                          <EmailReportButton
                            onClick={() => handlePrintVoucher(b, 'email')}
                            disabled={printingId === b.id}
                            className="flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-700 font-medium transition-colors disabled:opacity-50"
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => handleUndoDisburse(b.id)}
                          disabled={undoingId === b.id}
                          className="flex items-center justify-center gap-1.5 text-xs px-3 py-2 text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                        >
                          {undoingId === b.id ? <Spinner size={14} /> : <RotateCcw className="w-3.5 h-3.5" />} Undo
                        </button>
                      </>
                    ) : !canDisburse(b) ? (
                      <span className="text-xs text-slate-400">No items yet — add them from Bill Claim first.</span>
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
                    <th className="px-4 py-2.5 text-left">Employee</th>
                    <th className="px-4 py-2.5 text-left">Department</th>
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
                        {canDisburse(b) && (
                          <button type="button" onClick={() => toggleOne(b.id)} className="text-slate-400 hover:text-emerald-600">
                            {selected.has(b.id) ? <CheckSquare className="w-4 h-4 text-emerald-600" /> : <Square className="w-4 h-4" />}
                          </button>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap font-semibold text-slate-900 text-xs">CB-{b.id}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs">
                        <span className="font-medium text-slate-800">{b.user_name || '—'}</span>
                        {(b.employee_code || b.designation) && (
                          <span className="block text-[11px] text-slate-500">{[b.employee_code, b.designation].filter(Boolean).join(' · ')}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600 text-xs">{b.department || '—'}</td>
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
                              {canEmailReports && (
                                <EmailReportButton
                                  onClick={() => handlePrintVoucher(b, 'email')}
                                  disabled={printingId === b.id}
                                  title="Email Payment Voucher as a PDF"
                                  className="flex items-center gap-1 p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors disabled:opacity-50"
                                />
                              )}
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
                          ) : !canDisburse(b) ? (
                            <span className="text-[11px] text-slate-400" title="Add items to this Bill from Bill Claim first">No items yet</span>
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
            <PagerBar page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
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