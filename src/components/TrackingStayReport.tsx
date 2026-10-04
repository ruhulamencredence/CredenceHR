/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Employee Tracking -> (an employee) -> Stay Report
// (GET /api/tracking/stay-report, TrackingStayReport.ts): how long the
// employee stayed at each place, day by day, inside a time window such as
// 09:00–18:00 — plus a summary per place and per day, PDF and Excel.
// Shown only with the tracking module's "Stay Report" layer.

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { FileDown, FileSpreadsheet, MapPin, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { reverseGeocode } from '../lib/reverseGeocode';
import { formatDate } from '../lib/formatDate';
import { finalizePdfPageNumbers } from '../lib/pdfLetterhead';
import { drawStandardHeader, loadPdfCompany, standardTable } from '../lib/pdfStandard';
import { savePdfCrossPlatform } from '../lib/saveFile';
import { Spinner } from './Spinner';

interface Stay {
  place_id: number;
  lat: number;
  lng: number;
  from: string;
  to: string;
  minutes: number;
  pings: number;
}
interface Day {
  date: string;
  window_min: number;
  pings: number;
  first_seen: string | null;
  last_seen: string | null;
  stays: Stay[];
  stay_min: number;
  moving_min: number;
  no_signal_min: number;
  not_seen_min: number;
}
interface Report {
  user: { id: number; name: string };
  settings: { from: string; to: string; from_time: string; to_time: string; radius_m: number; min_stay_min: number; max_gap_min: number };
  places: { id: number; lat: number; lng: number; total_min: number; days: number; visits: number }[];
  days: Day[];
  totals: { days: number; days_seen: number; pings: number; window_min: number; stay_min: number; moving_min: number; no_signal_min: number; not_seen_min: number };
}

// 135 -> "2h 15m"
export const dur = (min: number) => {
  const m = Math.round(min);
  if (!m) return '0m';
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
// "14:05" -> "02:05 PM"
const ampm = (hm: string | null) => {
  if (!hm) return '-';
  const [h, m] = hm.split(':').map(Number);
  return `${String(h % 12 || 12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
};
const todayYmd = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

const inputCls = 'text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white';
const labelCls = 'block text-[11px] font-semibold text-slate-500 mb-1';

export const TrackingStayReport: React.FC<{
  token: string;
  user: { id: number; name: string };
  initial: { from: string; to: string; fromTime: string; toTime: string };
  onClose: () => void;
}> = ({ token, user, initial, onClose }) => {
  const [from, setFrom] = useState(initial.from || todayYmd());
  const [to, setTo] = useState(initial.to || initial.from || todayYmd());
  const [fromTime, setFromTime] = useState(initial.fromTime || '09:00');
  const [toTime, setToTime] = useState(initial.toTime || '18:00');
  const [radius, setRadius] = useState(150);
  const [minStay, setMinStay] = useState(10);
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [addresses, setAddresses] = useState<Record<number, string | null>>({});

  const run = async () => {
    setLoading(true);
    setError('');
    try {
      const q = new URLSearchParams({ user_id: String(user.id), from, to, from_time: fromTime, to_time: toTime, radius: String(radius), min_stay: String(minStay) });
      const res = await fetch(apiUrl(`/api/tracking/stay-report?${q}`), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not make the report.');
      setReport(data);
      setAddresses({});
    } catch (e: any) {
      setError(e.message);
      setReport(null);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Each place's address (English, for the PDF too), one lookup at a time.
  useEffect(() => {
    if (!report) return;
    let alive = true;
    for (const p of report.places) {
      reverseGeocode(p.lat, p.lng, 'en', true).then((a) => {
        if (alive) setAddresses((prev) => ({ ...prev, [p.id]: a }));
      });
    }
    return () => {
      alive = false;
    };
  }, [report]);

  // Place numbers in order of time spent (P1 = most time).
  const placeNo = useMemo(() => new Map((report?.places || []).map((p, i) => [p.id, i + 1])), [report]);
  const placeName = (id: number) => {
    const p = report?.places.find((x) => x.id === id);
    const a = addresses[id];
    return a || (p ? `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}` : '');
  };

  const windowText = report ? `${ampm(report.settings.from_time)} – ${ampm(report.settings.to_time)}` : '';
  const period = report ? (report.settings.from === report.settings.to ? formatDate(report.settings.from) : `${formatDate(report.settings.from)} – ${formatDate(report.settings.to)}`) : '';
  const seenDays = report ? report.days.filter((d) => d.pings > 0) : [];

  const pdf = async () => {
    if (!report) return;
    setBusy(true);
    try {
      const co = await loadPdfCompany(token);
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const t = report.totals;
      let y = drawStandardHeader(doc, co, 'Employee Stay Report', [
        ['Employee', report.user.name],
        ['Period', period],
        ['Time Range', windowText],
        ['Same Place', `within ${report.settings.radius_m} m, at least ${report.settings.min_stay_min} min`],
        ['Days With Location', `${t.days_seen} of ${t.days}`],
        ['At Places', dur(t.stay_min)],
        ['Moving', dur(t.moving_min)],
        ['No Signal / Not Seen', `${dur(t.no_signal_min)} / ${dur(t.not_seen_min)}`]
      ]);
      const left = { halign: 'left' as const };
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text('Summary by Place', 8, y + 2);
      autoTable(doc, {
        ...standardTable(y + 4),
        head: [['Place', 'Location', 'Total Time', 'Days', 'Visits', 'Average per Day']],
        body: report.places.map((p) => [`P${placeNo.get(p.id)}`, placeName(p.id), dur(p.total_min), String(p.days), String(p.visits), dur(p.total_min / Math.max(1, p.days))]),
        columnStyles: { 0: { cellWidth: 14, halign: 'center' }, 2: { cellWidth: 24, halign: 'right' }, 3: { cellWidth: 14, halign: 'center' }, 4: { cellWidth: 14, halign: 'center' }, 5: { cellWidth: 28, halign: 'right' } }
      });
      y = (doc as any).lastAutoTable.finalY + 8;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text('Day-wise Summary', 8, y + 2);
      autoTable(doc, {
        ...standardTable(y + 4),
        head: [['Date', 'First Seen', 'Last Seen', 'At Places', 'Moving', 'No Signal', 'Not Seen', 'Places']],
        body: report.days.map((d) => [
          formatDate(d.date),
          ampm(d.first_seen),
          ampm(d.last_seen),
          dur(d.stay_min),
          dur(d.moving_min),
          dur(d.no_signal_min),
          dur(d.not_seen_min),
          d.stays.length ? Array.from(new Set(d.stays.map((s) => `P${placeNo.get(s.place_id)}`))).join(', ') : d.pings ? '-' : 'No location'
        ]),
        foot: [[{ content: 'Total', colSpan: 3, styles: left }, dur(report.totals.stay_min), dur(report.totals.moving_min), dur(report.totals.no_signal_min), dur(report.totals.not_seen_min), '']],
        columnStyles: { 0: { cellWidth: 26 }, 1: { halign: 'center' }, 2: { halign: 'center' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' } }
      });
      y = (doc as any).lastAutoTable.finalY + 8;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text('Day-wise Stays', 8, y + 2);
      const body: any[] = [];
      for (const d of seenDays) {
        d.stays.forEach((s, i) => body.push([i === 0 ? formatDate(d.date) : '', ampm(s.from), ampm(s.to), dur(s.minutes), `P${placeNo.get(s.place_id)}`, placeName(s.place_id)]));
        if (!d.stays.length) body.push([formatDate(d.date), '-', '-', '-', '-', `No stay of ${report.settings.min_stay_min} min or more (moving)`]);
      }
      autoTable(doc, {
        ...standardTable(y + 4),
        head: [['Date', 'From', 'To', 'Duration', 'Place', 'Location']],
        body: body.length ? body : [['', '', '', '', '', 'No location in this period']],
        columnStyles: { 0: { cellWidth: 26 }, 1: { cellWidth: 22, halign: 'center' }, 2: { cellWidth: 22, halign: 'center' }, 3: { cellWidth: 22, halign: 'right' }, 4: { cellWidth: 14, halign: 'center' } }
      });
      finalizePdfPageNumbers(doc);
      const safe = report.user.name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'Employee';
      await savePdfCrossPlatform(doc, `Stay-Report-${safe}-${report.settings.from}.pdf`);
    } catch (e: any) {
      setError(e.message || 'Could not make the PDF.');
    } finally {
      setBusy(false);
    }
  };

  const excel = () => {
    if (!report) return;
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        report.places.map((p) => ({
          Place: `P${placeNo.get(p.id)}`,
          Location: placeName(p.id),
          Latitude: Number(p.lat.toFixed(6)),
          Longitude: Number(p.lng.toFixed(6)),
          'Total Minutes': p.total_min,
          'Total Time': dur(p.total_min),
          Days: p.days,
          Visits: p.visits,
          'Average per Day': dur(p.total_min / Math.max(1, p.days))
        }))
      ),
      'By Place'
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        report.days.map((d) => ({
          Date: d.date,
          'First Seen': d.first_seen || '',
          'Last Seen': d.last_seen || '',
          'At Places (min)': d.stay_min,
          'Moving (min)': d.moving_min,
          'No Signal (min)': d.no_signal_min,
          'Not Seen (min)': d.not_seen_min,
          Places: Array.from(new Set(d.stays.map((s) => `P${placeNo.get(s.place_id)}`))).join(', ')
        }))
      ),
      'By Day'
    );
    const stays = seenDays.flatMap((d) => d.stays.map((s) => ({ Date: d.date, From: s.from, To: s.to, Minutes: s.minutes, Duration: dur(s.minutes), Place: `P${placeNo.get(s.place_id)}`, Location: placeName(s.place_id) })));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stays.length ? stays : [{ Note: 'No stays in this period' }]), 'Stays');
    XLSX.writeFile(wb, `Stay-Report-${report.user.name.replace(/[^a-zA-Z0-9]+/g, '-')}-${report.settings.from}.xlsx`);
  };

  const card = (label: string, value: string, cls = 'text-slate-900') => (
    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
      <div className="text-[10px] font-semibold text-slate-500">{label}</div>
      <div className={`text-base font-bold ${cls}`}>{value}</div>
    </div>
  );

  return createPortal(
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-3 sm:p-6" onClick={onClose}>
      <div role="dialog" aria-label="Stay Report" className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-5xl max-h-[92vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-100 shrink-0">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Stay Report — {user.name}</h3>
            <p className="text-[11px] text-slate-500">How long at each place, day by day, inside the time range.</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={pdf} disabled={!report || busy} className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40">
              <FileDown className="w-3.5 h-3.5" /> {busy ? 'Making PDF…' : 'PDF'}
            </button>
            <button type="button" onClick={excel} disabled={!report} className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40">
              <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
            </button>
            <button type="button" onClick={onClose} className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center" aria-label="Close">
              <X className="w-4 h-4 text-slate-500" />
            </button>
          </div>
        </div>

        <div className="px-5 py-3 border-b border-slate-100 bg-slate-50/60 flex flex-wrap items-end gap-3 shrink-0">
          <div>
            <label className={labelCls}>From date</label>
            <input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>To date</label>
            <input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Time from</label>
            <input type="time" className={inputCls} value={fromTime} onChange={(e) => setFromTime(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Time to</label>
            <input type="time" className={inputCls} value={toTime} onChange={(e) => setToTime(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Same place within</label>
            <select className={inputCls} value={radius} onChange={(e) => setRadius(Number(e.target.value))}>
              {[50, 100, 150, 250, 500].map((r) => (
                <option key={r} value={r}>
                  {r} m
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Count a stay from</label>
            <select className={inputCls} value={minStay} onChange={(e) => setMinStay(Number(e.target.value))}>
              {[5, 10, 15, 30, 60].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </div>
          <button type="button" onClick={run} disabled={loading} className="text-sm px-3.5 py-1.5 rounded-lg bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-50">
            {loading ? 'Working…' : 'Generate'}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {error && <p className="text-sm text-rose-600">{error}</p>}
          {loading && !report && (
            <div className="py-10 flex justify-center">
              <Spinner size={24} />
            </div>
          )}
          {report && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {card('Days with location', `${report.totals.days_seen} / ${report.totals.days}`)}
                {card('At places', dur(report.totals.stay_min), 'text-emerald-700')}
                {card('Moving', dur(report.totals.moving_min), 'text-sky-700')}
                {card('No signal', dur(report.totals.no_signal_min), 'text-amber-600')}
                {card('Not seen', dur(report.totals.not_seen_min), 'text-slate-500')}
              </div>
              <p className="text-[11px] text-slate-500">
                {period} · {windowText} · same place = within {report.settings.radius_m} m for at least {report.settings.min_stay_min} min. Moving = between places (gaps up to{' '}
                {report.settings.max_gap_min} min); No signal = a longer gap with no location; Not seen = before the first or after the last location of the day.
              </p>

              <div>
                <h4 className="text-xs font-bold text-slate-700 mb-1.5">Summary by place</h4>
                {report.places.length === 0 ? (
                  <p className="text-sm text-slate-400">No stay in this period.</p>
                ) : (
                  <div className="rounded-xl border border-slate-200 overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 text-slate-500">
                        <tr>
                          <th className="px-3 py-2 text-left">Place</th>
                          <th className="px-3 py-2 text-left">Location</th>
                          <th className="px-3 py-2 text-right">Total time</th>
                          <th className="px-3 py-2 text-center">Days</th>
                          <th className="px-3 py-2 text-center">Visits</th>
                          <th className="px-3 py-2 text-right">Avg / day</th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.places.map((p) => (
                          <tr key={p.id} className="border-t border-slate-100">
                            <td className="px-3 py-1.5 font-bold text-emerald-700">P{placeNo.get(p.id)}</td>
                            <td className="px-3 py-1.5">
                              <a href={`https://www.google.com/maps?q=${p.lat},${p.lng}`} target="_blank" rel="noreferrer" className="inline-flex items-start gap-1 hover:underline">
                                <MapPin className="w-3 h-3 mt-0.5 text-slate-400 shrink-0" />
                                {addresses[p.id] === undefined ? <span className="text-slate-400">Finding address…</span> : placeName(p.id)}
                              </a>
                            </td>
                            <td className="px-3 py-1.5 text-right font-semibold">{dur(p.total_min)}</td>
                            <td className="px-3 py-1.5 text-center">{p.days}</td>
                            <td className="px-3 py-1.5 text-center">{p.visits}</td>
                            <td className="px-3 py-1.5 text-right">{dur(p.total_min / Math.max(1, p.days))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div>
                <h4 className="text-xs font-bold text-slate-700 mb-1.5">Day by day</h4>
                <div className="space-y-2">
                  {report.days.map((d) => (
                    <div key={d.date} className="rounded-xl border border-slate-200">
                      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-slate-50 rounded-t-xl">
                        <span className="text-xs font-bold text-slate-800">{formatDate(d.date)}</span>
                        {d.pings ? (
                          <span className="text-[11px] text-slate-500">
                            Seen {ampm(d.first_seen)} – {ampm(d.last_seen)} · <b className="text-emerald-700">At places {dur(d.stay_min)}</b> · Moving {dur(d.moving_min)} · No signal {dur(d.no_signal_min)} · Not seen {dur(d.not_seen_min)}
                          </span>
                        ) : (
                          <span className="text-[11px] text-slate-400">No location in this time range</span>
                        )}
                      </div>
                      {d.stays.length > 0 && (
                        <table className="w-full text-xs">
                          <tbody>
                            {d.stays.map((s, i) => (
                              <tr key={i} className="border-t border-slate-100">
                                <td className="px-3 py-1.5 w-40 whitespace-nowrap">
                                  {ampm(s.from)} – {ampm(s.to)}
                                </td>
                                <td className="px-3 py-1.5 w-20 text-right font-semibold">{dur(s.minutes)}</td>
                                <td className="px-3 py-1.5">
                                  <span className="font-bold text-emerald-700 mr-1">P{placeNo.get(s.place_id)}</span>
                                  {placeName(s.place_id)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {d.pings > 0 && !d.stays.length && <p className="px-3 py-1.5 text-[11px] text-slate-400">No stay of {report.settings.min_stay_min} min or more — on the move.</p>}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
