// System Data Cleanup (System -> Data cleanup tab) — only for the system
// owner (users.is_platform_admin, the /system login). Removes wrong Leave,
// Bill Claim, Check In/Out, Remote Attendance and Employee change-history
// records, one by one or every record the filters match, with a reason and a
// typed "DELETE n"; every removal is logged and can be put back for 30 days.
// Server: DataCleanupRoutes.ts.
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as XLSX from "xlsx";
import {
  Download,
  History,
  Loader2,
  Lock,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import {
  useHrApi,
  Notice,
  fmtDate,
  taka,
  inputCls,
  labelCls,
} from "./HrOpsShared";
import { SearchSelect } from "./Combobox";
import { confirmDialog } from "../lib/confirmDialog";
import { saveWorkbookCrossPlatform } from "../lib/saveFile";

type Kind = "leave" | "bill" | "claim" | "attendance" | "history";
type Msg = { type: "success" | "error"; text: string } | null;

const KINDS: { key: Kind; label: string; hint: string; noun: string }[] = [
  {
    key: "leave",
    label: "Leave applications",
    hint: "Balance goes back",
    noun: "leave applications",
  },
  {
    key: "bill",
    label: "Bill Claims",
    hint: "Not once disbursed",
    noun: "Bill Claims",
  },
  {
    key: "claim",
    label: "Check In/Out",
    hint: "Not once on a paid Bill",
    noun: "Check In/Out",
  },
  {
    key: "attendance",
    label: "Remote Attendance",
    hint: "In / Out of a day",
    noun: "days' attendance",
  },
  {
    key: "history",
    label: "Employee change history",
    hint: "Only the history line goes",
    noun: "history lines",
  },
];

const HELP: Record<Kind, string[]> = {
  leave: [
    "The days go back to the balance (Pending and Approved ones); its approval request closes.",
    "A Rejected one: nothing else to undo.",
    "Locked: an Approved leave in a month whose salary is Processed / Paid.",
  ],
  bill: [
    "The claim, its bill lines and receipts go.",
    "A pending one: its approval request closes and leaves the approvers' lists.",
    "On a Pending Bill: it comes off that Bill (an emptied Bill goes too). Its dates are free to be claimed again.",
    "Locked: on a Disbursed Bill — Undisburse it in Bill Disbursement first.",
  ],
  claim: [
    "The trip (Check In, Check Out, places and map points) goes.",
    "An open one (no Check Out): the person can start a new Check In right away. A pending one: its approval request closes.",
    "On a Pending Bill: it comes off it.",
    "Locked: on a Disbursed Bill, or used on a Bill Claim (remove that Bill Claim first).",
  ],
  attendance: [
    "Whole day removes the In and the Out; Out only keeps the In (the person can give the Out again).",
    "A Correct Attendance of that day goes with it; an off-site one waiting for approval closes.",
    "Overtime and Late of the day are worked out again; the day shows from the office machine, or Absent / Leave.",
    "Office machine (fingerprint) punches are not listed — they come from the device and stay.",
    "Locked: a day in a month whose salary is Processed / Paid.",
  ],
  history: [
    "Only the history line goes — from Change history, the Service Book and Employee 360’s timeline.",
    "The employee's current details stay exactly as they are.",
    "Tip: “No real change only” finds lines where Before and After are the same — what a repeat import leaves behind.",
  ],
};

const STATUS: Record<Kind, [string, string][]> = {
  leave: [
    ["pending", "Pending"],
    ["approved", "Approved"],
    ["rejected", "Rejected"],
  ],
  bill: [
    ["pending", "Pending"],
    ["approved", "Approved"],
    ["rejected", "Rejected"],
    ["returned", "Returned"],
  ],
  claim: [
    ["open", "Open (no Check Out)"],
    ["pending", "Pending"],
    ["approved", "Approved"],
    ["rejected", "Rejected"],
  ],
  attendance: [],
  history: [],
};

interface Filters {
  emp: string;
  dept: string;
  place: string;
  from: string;
  to: string;
  status: string;
  type: string;
  q: string;
  project: string;
  mode: string;
  by: string;
  nochange: string;
}
const EMPTY: Filters = {
  emp: "",
  dept: "",
  place: "",
  from: "",
  to: "",
  status: "",
  type: "",
  q: "",
  project: "",
  mode: "",
  by: "",
  nochange: "",
};

const fmtTime = (v: any) => {
  if (!v) return "—";
  const s = String(v).replace("T", " ");
  const m = s.match(/(\d{2}):(\d{2})/);
  if (!m) return s;
  const h = Number(m[1]);
  return `${String(((h + 11) % 12) + 1).padStart(2, "0")}:${m[2]} ${
    h < 12 ? "AM" : "PM"
  }`;
};
const fmtWhen = (v: any) => (v ? `${fmtDate(String(v))} ${fmtTime(v)}` : "—");
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const statusChip = (s: string) => {
  const t = s.toLowerCase();
  const c = /disbursed/.test(t)
    ? "bg-slate-200 text-slate-700"
    : /^pending|waiting|^open/.test(t)
    ? "bg-amber-100 text-amber-800"
    : /^approved|^completed/.test(t)
    ? "bg-emerald-100 text-emerald-800"
    : /^rejected/.test(t)
    ? "bg-rose-100 text-rose-800"
    : /correct/.test(t)
    ? "bg-indigo-100 text-indigo-800"
    : "bg-slate-100 text-slate-700";
  return (
    <span
      className={`inline-block leading-snug px-2 py-0.5 rounded-full text-[11px] font-semibold ${c}`}
    >
      {cap(s)}
    </span>
  );
};

export const DataCleanup: React.FC<{ token: string }> = ({ token }) => {
  const api = useHrApi(token);
  const [kind, setKind] = useState<Kind>("leave");
  const [f, setF] = useState<Filters>(EMPTY);
  const [opts, setOpts] = useState<any>(null);
  const [rows, setRows] = useState<any[] | null>(null);
  const [summary, setSummary] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [allMatch, setAllMatch] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [confirm, setConfirm] = useState<{ ids: string[] } | null>(null);
  const [log, setLog] = useState<any[] | null>(null);
  const [showLog, setShowLog] = useState(false);
  const SIZE = 50;

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    Object.entries(f).forEach(([k, v]) => v && p.set(k, v));
    return p;
  }, [f]);

  useEffect(() => {
    api
      .get("/api/system/cleanup/options")
      .then(setOpts)
      .catch((e) => setMsg({ type: "error", text: e.message }));
  }, [api]);

  const loadLog = useCallback(() => {
    api
      .get("/api/system/cleanup/log")
      .then((d) => setLog(d.batches))
      .catch(() => setLog([]));
  }, [api]);
  useEffect(loadLog, [loadLog]);

  const load = useCallback(
    (pg = 1) => {
      setBusy(true);
      const p = new URLSearchParams(qs);
      p.set("page", String(pg));
      p.set("size", String(SIZE));
      api
        .get(`/api/system/cleanup/${kind}?${p}`)
        .then((d) => {
          setRows(d.rows);
          setSummary(d.summary);
          setPage(pg);
        })
        .catch((e) => setMsg({ type: "error", text: e.message }))
        .finally(() => setBusy(false));
    },
    [api, kind, qs]
  );
  useEffect(() => {
    setSel(new Set());
    setAllMatch(false);
    load(1);
  }, [load]);

  const switchKind = (k: Kind) => {
    setKind(k);
    setF(EMPTY);
    setRows(null);
  };
  const set = (k: keyof Filters) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));

  const pageRows = rows || [];
  const free = pageRows.filter((r) => !r.locked);
  const allOnPage = free.length > 0 && free.every((r) => sel.has(r.id));
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const togglePage = () =>
    setSel((s) => {
      const n = new Set(s);
      free.forEach((r) => (allOnPage ? n.delete(r.id) : n.add(r.id)));
      return n;
    });
  const selCount = allMatch ? summary?.removable || 0 : sel.size;
  const selAmount =
    kind === "bill" && !allMatch
      ? pageRows
          .filter((r) => sel.has(r.id))
          .reduce((s, r) => s + Number(r.amount || 0), 0)
      : allMatch
      ? summary?.amount
      : 0;

  const startRemove = async () => {
    if (allMatch) {
      try {
        const p = new URLSearchParams(qs);
        p.set("ids_only", "1");
        const d = await api.get(`/api/system/cleanup/${kind}?${p}`);
        if (!d.ids.length)
          return setMsg({
            type: "error",
            text: "Nothing left to remove — everything that matches is locked.",
          });
        setConfirm({ ids: d.ids });
      } catch (e: any) {
        setMsg({ type: "error", text: e.message });
      }
    } else if (sel.size) setConfirm({ ids: [...sel] });
  };

  const exportExcel = async () => {
    try {
      const d = await api.get(
        `/api/system/cleanup/${kind}?${new URLSearchParams([
          ...qs,
          ["all", "1"],
        ])}`
      );
      const out = (d.rows as any[]).map((r) => {
        const base: any = {
          Employee: r.emp?.name || "",
          "Employee ID": r.emp?.code || "",
          Designation: r.emp?.designation || "",
          Department: r.emp?.department || "",
          "Head Office / Project": r.emp?.place || "",
        };
        if (kind === "leave")
          Object.assign(base, {
            Leave: r.leave_type,
            Days: r.days,
            From: r.date,
            To: r.end_date,
            Purpose: r.purpose,
          });
        if (kind === "bill")
          Object.assign(base, {
            Claim: `#${r.id}`,
            Date: r.date,
            Bills: r.cats,
            Amount: r.amount,
          });
        if (kind === "claim")
          Object.assign(base, {
            Date: r.date,
            Purpose: r.purpose,
            In: fmtTime(r.check_in_at),
            Out: fmtTime(r.check_out_at),
            Km: r.distance_km,
            Amount: r.amount,
          });
        if (kind === "attendance")
          Object.assign(base, {
            Date: r.date,
            Project: r.project,
            In: fmtTime(r.check_in_at),
            Out: fmtTime(r.check_out_at),
          });
        if (kind === "history")
          Object.assign(base, {
            When: r.date,
            "What changed": r.field,
            Before: r.old_value,
            After: r.new_value,
            By: r.by,
          });
        return {
          ...base,
          Status: r.status,
          "What removing does": r.locked || r.effect,
        };
      });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(out),
        "Records"
      );
      await saveWorkbookCrossPlatform(
        wb,
        `Data-cleanup-${kind}-${new Date().toISOString().slice(0, 10)}.xlsx`
      );
    } catch (e: any) {
      setMsg({ type: "error", text: e.message });
    }
  };

  const restore = async (b: any) => {
    if (
      !(await confirmDialog(
        `Put back the ${b.count} ${b.kind_label} removed on ${fmtWhen(
          b.created_at
        )}?`,
        { title: "Put back", confirmLabel: "Put back", tone: "default" }
      ))
    )
      return;
    try {
      const r = await api.post(`/api/system/cleanup/batches/${b.id}/restore`);
      setMsg({
        type: r.skipped?.length ? "error" : "success",
        text: `${r.restored} put back.${
          r.skipped?.length
            ? ` ${r.skipped.length} could not be: ${r.skipped
                .slice(0, 3)
                .map((s: any) => `${s.label} — ${s.why}`)
                .join("; ")}`
            : ""
        }`,
      });
      loadLog();
      load(page);
    } catch (e: any) {
      setMsg({ type: "error", text: e.message });
    }
  };

  const meta = KINDS.find((k) => k.key === kind)!;
  const pages = summary ? Math.max(1, Math.ceil(summary.total / SIZE)) : 1;
  const empOptions = (opts?.employees || []) as any[];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="text-xs text-slate-600 max-w-3xl">
          Remove wrong Leave, Bill Claim, Check In/Out and Remote Attendance
          records without touching the server. Only the system owner who signs
          in at /system sees this. Every removal is logged and can be put back
          for 30 days. Only this company’s records are listed.
        </p>
        <button
          type="button"
          onClick={() => setShowLog((v) => !v)}
          className="inline-flex items-center gap-1.5 h-9 px-3 rounded-full border border-slate-200 bg-white text-xs font-semibold text-slate-700"
        >
          <History className="w-3.5 h-3.5" /> Removal log &amp; put back
        </button>
      </div>
      <Notice msg={msg} onClose={() => setMsg(null)} />

      {showLog && <RemovalLog log={log} onRestore={restore} />}

      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-2">
        {KINDS.map((k) => (
          <button
            key={k.key}
            type="button"
            onClick={() => switchKind(k.key)}
            className={`text-left px-3.5 py-3 rounded-2xl bg-white border ${
              kind === k.key
                ? "border-2 border-orange-600 text-orange-800"
                : "border-slate-200 text-slate-800"
            }`}
          >
            <span className="block text-sm font-bold">{k.label}</span>
            <span className="block text-xs text-slate-500 mt-0.5">
              {k.hint}
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-4 items-start">
        <div className="flex-[999_1_640px] min-w-0 space-y-3">
          <div className="bg-white border border-slate-200 rounded-2xl p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
            <label className={labelCls}>
              Employee (type to search)
              <SearchSelect
                value={f.emp}
                onChange={set("emp")}
                className={inputCls}
              >
                <option value="">— Everyone —</option>
                {empOptions.map((e) => (
                  <option key={e.id} value={String(e.id)}>
                    {[e.name, e.employee_id, e.designation, e.department]
                      .filter(Boolean)
                      .join(" · ")}
                  </option>
                ))}
              </SearchSelect>
            </label>
            <label className={labelCls}>
              Department
              <SearchSelect
                value={f.dept}
                onChange={set("dept")}
                className={inputCls}
              >
                <option value="">— Any department —</option>
                {(opts?.departments || []).map((d: string) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </SearchSelect>
            </label>
            <label className={labelCls}>
              Head Office / Project
              <select
                value={f.place}
                onChange={set("place")}
                className={inputCls}
              >
                <option value="">Both</option>
                <option value="Head Office">Head Office</option>
                <option value="Project">Project</option>
                <option value="Not set">Not set</option>
              </select>
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className={labelCls}>
                From
                <input
                  type="date"
                  value={f.from}
                  onChange={set("from")}
                  className={inputCls}
                />
              </label>
              <label className={labelCls}>
                To
                <input
                  type="date"
                  value={f.to}
                  onChange={set("to")}
                  className={inputCls}
                />
              </label>
            </div>
            {STATUS[kind].length > 0 && (
              <label className={labelCls}>
                Status
                <select
                  value={f.status}
                  onChange={set("status")}
                  className={inputCls}
                >
                  <option value="">Any status</option>
                  {STATUS[kind].map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {kind === "leave" && (
              <label className={labelCls}>
                Leave type
                <select
                  value={f.type}
                  onChange={set("type")}
                  className={inputCls}
                >
                  <option value="">Any type</option>
                  {(opts?.leave_types || []).map((t: string) => (
                    <option key={t} value={t}>
                      {cap(t.replace(/_/g, " "))}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {kind === "bill" && (
              <label className={labelCls}>
                Category
                <SearchSelect
                  value={f.type}
                  onChange={set("type")}
                  className={inputCls}
                >
                  <option value="">— Any category —</option>
                  {(opts?.categories || []).map((t: string) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </SearchSelect>
              </label>
            )}
            {kind === "claim" && (
              <label className={labelCls}>
                Purpose contains
                <input
                  value={f.q}
                  onChange={set("q")}
                  placeholder="e.g. test"
                  className={inputCls}
                />
              </label>
            )}
            {kind === "attendance" && (
              <>
                <label className={labelCls}>
                  Project
                  <SearchSelect
                    value={f.project}
                    onChange={set("project")}
                    className={inputCls}
                  >
                    <option value="">— Any project —</option>
                    {(opts?.projects || []).map((p: any) => (
                      <option key={p.id} value={String(p.id)}>
                        {p.project_name}
                      </option>
                    ))}
                  </SearchSelect>
                </label>
                <label className={labelCls}>
                  Remove
                  <select
                    value={f.mode}
                    onChange={set("mode")}
                    className={inputCls}
                  >
                    <option value="">Whole day (In + Out)</option>
                    <option value="out">Out only (keep the In)</option>
                  </select>
                </label>
              </>
            )}
            {kind === "history" && (
              <>
                <label className={labelCls}>
                  What changed
                  <SearchSelect
                    value={f.type}
                    onChange={set("type")}
                    className={inputCls}
                  >
                    <option value="">— Any field —</option>
                    {(opts?.fields || []).map((t: string) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </SearchSelect>
                </label>
                <label className={labelCls}>
                  Changed by
                  <SearchSelect
                    value={f.by}
                    onChange={set("by")}
                    className={inputCls}
                  >
                    <option value="">— Anyone —</option>
                    {(opts?.changed_by || []).map((u: any) => (
                      <option key={u.id} value={String(u.id)}>
                        {u.name}
                      </option>
                    ))}
                  </SearchSelect>
                </label>
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 self-end h-9">
                  <input
                    type="checkbox"
                    checked={f.nochange === "1"}
                    onChange={(e) =>
                      setF((x) => ({
                        ...x,
                        nochange: e.target.checked ? "1" : "",
                      }))
                    }
                  />
                  No real change only
                </label>
              </>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 bg-slate-50 border-b border-slate-200">
              <span className="text-xs sm:text-sm text-slate-700">
                {busy && (
                  <Loader2 className="inline w-3.5 h-3.5 animate-spin mr-1" />
                )}
                {allMatch ? (
                  <>
                    <b>All {summary?.removable} that match</b> are selected
                    {summary?.locked ? ` (${summary.locked} locked stay)` : ""}{" "}
                    ·{" "}
                    <button
                      type="button"
                      className="text-orange-700 underline"
                      onClick={() => setAllMatch(false)}
                    >
                      Clear
                    </button>
                  </>
                ) : (
                  <>
                    <b>{sel.size} selected</b> of {summary?.total ?? 0}{" "}
                    {summary?.capped ? "(first 5,000)" : ""}
                    {summary && summary.removable > sel.size && (
                      <>
                        {" · "}
                        <button
                          type="button"
                          className="text-orange-700 underline"
                          onClick={() => setAllMatch(true)}
                        >
                          Select all {summary.removable} that match
                        </button>
                      </>
                    )}
                    {summary?.locked ? ` (${summary.locked} locked)` : ""}
                  </>
                )}
              </span>
              <div className="flex gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={exportExcel}
                  className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-full border border-slate-200 bg-white text-xs font-semibold text-slate-700"
                >
                  <Download className="w-3.5 h-3.5" /> Excel
                </button>
                <button
                  type="button"
                  disabled={!selCount}
                  onClick={startRemove}
                  className="inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-red-600 text-white text-xs font-bold disabled:opacity-40"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Remove {selCount || ""}{" "}
                  {allMatch ? "that match" : "selected"}
                  {kind === "bill" && selAmount ? ` · ${taka(selAmount)}` : ""}
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-[13px]">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-2.5 w-8">
                      <input
                        type="checkbox"
                        aria-label="Select page"
                        checked={allOnPage || allMatch}
                        disabled={allMatch || !free.length}
                        onChange={togglePage}
                      />
                    </th>
                    <Heads kind={kind} />
                    <th className="px-2 py-2.5">Status</th>
                    <th className="px-2 py-2.5">What removing does</th>
                  </tr>
                </thead>
                <tbody>
                  {rows && !rows.length && (
                    <tr>
                      <td
                        colSpan={8}
                        className="px-4 py-8 text-center text-slate-500"
                      >
                        Nothing matches these filters.
                      </td>
                    </tr>
                  )}
                  {pageRows.map((r) => {
                    const on = allMatch ? !r.locked : sel.has(r.id);
                    return (
                      <tr
                        key={r.id}
                        className={`border-t border-slate-100 ${
                          r.locked
                            ? "bg-slate-50 text-slate-500"
                            : on
                            ? "bg-orange-50"
                            : ""
                        }`}
                      >
                        <td className="px-4 py-2.5 align-top">
                          {r.locked ? (
                            <Lock
                              className="w-3.5 h-3.5 text-slate-400"
                              aria-label="Locked"
                            />
                          ) : (
                            <input
                              type="checkbox"
                              aria-label="Select"
                              checked={on}
                              disabled={allMatch}
                              onChange={() => toggle(r.id)}
                            />
                          )}
                        </td>
                        <Cells kind={kind} r={r} />
                        <td className="px-2 py-2.5 align-top min-w-[150px]">
                          {statusChip(r.status)}
                        </td>
                        <td
                          className={`px-2 py-2.5 align-top text-xs ${
                            r.locked
                              ? "text-red-700 font-semibold"
                              : "text-slate-600"
                          }`}
                        >
                          {r.locked || r.effect}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-slate-100 text-xs">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => load(page - 1)}
                  className="px-3 h-8 rounded-full border border-slate-200 disabled:opacity-40"
                >
                  Previous
                </button>
                <span>
                  Page {page} of {pages}
                </span>
                <button
                  type="button"
                  disabled={page >= pages}
                  onClick={() => load(page + 1)}
                  className="px-3 h-8 rounded-full border border-slate-200 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex-[1_1_280px] min-w-0 space-y-3">
          <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-2">
            <h3 className="text-sm font-bold text-slate-900">
              What removing {meta.label.replace(/s$/, "")} does
            </h3>
            {HELP[kind].map((t) => (
              <p
                key={t}
                className={`text-xs ${
                  /^Locked/.test(t)
                    ? "text-red-700 font-semibold"
                    : "text-slate-600"
                }`}
              >
                {t}
              </p>
            ))}
          </div>
          <div className="bg-white border border-red-200 rounded-2xl p-4 space-y-2">
            <h3 className="text-sm font-bold text-red-800">
              Before it is removed
            </h3>
            <p className="text-xs text-slate-600">
              A reason, then type <b>DELETE {selCount || "n"}</b>. It is logged
              and can be put back for 30 days.
            </p>
          </div>
        </div>
      </div>

      {confirm && (
        <RemoveSheet
          api={api}
          kind={kind}
          noun={meta.noun}
          ids={confirm.ids}
          mode={kind === "attendance" ? f.mode : ""}
          filters={f}
          leaveDays={
            kind === "leave" && allMatch ? summary?.leave_days : undefined
          }
          onClose={(done) => {
            setConfirm(null);
            if (done) {
              setMsg(done);
              setSel(new Set());
              setAllMatch(false);
              load(1);
              loadLog();
            }
          }}
        />
      )}
    </div>
  );
};

const th = (t: string) => (
  <th key={t} className="px-2 py-2.5">
    {t}
  </th>
);
const Heads: React.FC<{ kind: Kind }> = ({ kind }) => (
  <>
    {kind === "leave" && ["Employee", "Leave", "Dates"].map(th)}
    {kind === "bill" && ["Claim", "Employee", "Bills", "Amount"].map(th)}
    {kind === "claim" &&
      ["Date", "Employee", "Purpose", "In / Out", "Amount"].map(th)}
    {kind === "attendance" &&
      ["Date", "Employee", "Project", "In", "Out"].map(th)}
    {kind === "history" &&
      ["When", "Employee", "What changed", "Before → After", "By"].map(th)}
  </>
);

const Emp: React.FC<{ e: any }> = ({ e }) =>
  e ? (
    <div className="min-w-[170px]">
      <b className="text-slate-800">{e.name}</b>
      <br />
      <span className="text-[11px] text-slate-500">
        {[e.code, e.designation, e.department].filter(Boolean).join(" · ")}
      </span>
    </div>
  ) : (
    <span className="text-slate-400">—</span>
  );

const td = "px-2 py-2.5 align-top";
const Cells: React.FC<{ kind: Kind; r: any }> = ({ kind, r }) => {
  if (kind === "leave")
    return (
      <>
        <td className={td}>
          <Emp e={r.emp} />
        </td>
        <td className={td}>
          {cap(String(r.leave_type || "").replace(/_/g, " "))} · {r.days} day
          {Number(r.days) === 1 ? "" : "s"}
        </td>
        <td className={`${td} whitespace-nowrap`}>
          {r.date === r.end_date
            ? fmtDate(r.date)
            : `${fmtDate(r.date)} – ${fmtDate(r.end_date)}`}
        </td>
      </>
    );
  if (kind === "bill")
    return (
      <>
        <td className={td}>
          <b>#{r.id}</b>
          <br />
          <span className="text-[11px] text-slate-500">{fmtDate(r.date)}</span>
        </td>
        <td className={td}>
          <Emp e={r.emp} />
        </td>
        <td className={td}>{r.cats || "—"}</td>
        <td className={td}>{taka(r.amount)}</td>
      </>
    );
  if (kind === "claim")
    return (
      <>
        <td className={`${td} whitespace-nowrap`}>{fmtDate(r.date)}</td>
        <td className={td}>
          <Emp e={r.emp} />
        </td>
        <td className={td}>{r.purpose || "—"}</td>
        <td className={`${td} whitespace-nowrap`}>
          {fmtTime(r.check_in_at)} / {fmtTime(r.check_out_at)}
        </td>
        <td className={td}>{r.amount == null ? "—" : taka(r.amount)}</td>
      </>
    );
  if (kind === "attendance")
    return (
      <>
        <td className={`${td} whitespace-nowrap`}>{fmtDate(r.date)}</td>
        <td className={td}>
          <Emp e={r.emp} />
        </td>
        <td className={td}>{r.project || "—"}</td>
        <td className={`${td} whitespace-nowrap`}>
          {fmtTime(r.check_in_at)}{" "}
          {r.in_m != null && (
            <span className="text-[11px] text-slate-500">{r.in_m} m</span>
          )}
        </td>
        <td className={`${td} whitespace-nowrap`}>
          {fmtTime(r.check_out_at)}{" "}
          {r.out_m != null && (
            <span className="text-[11px] text-slate-500">{r.out_m} m</span>
          )}
        </td>
      </>
    );
  return (
    <>
      <td className={`${td} whitespace-nowrap`}>{fmtWhen(r.date)}</td>
      <td className={td}>
        <Emp e={r.emp} />
      </td>
      <td className={td}>{r.field}</td>
      <td className={`${td} max-w-[260px] break-words`}>
        {r.old_value || "—"} → {r.new_value || "—"}
      </td>
      <td className={td}>{r.by}</td>
    </>
  );
};

// The red liquid-glass confirm: reason + typed "DELETE n", then the removal
// runs in chunks with a bar and a Stop button.
const RemoveSheet: React.FC<{
  api: ReturnType<typeof useHrApi>;
  kind: Kind;
  noun: string;
  ids: string[];
  mode: string;
  filters: Filters;
  leaveDays?: number;
  onClose: (done: Msg | null) => void;
}> = ({ api, kind, noun, ids, mode, filters, leaveDays, onClose }) => {
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [prog, setProg] = useState<{ done: number; removed: number } | null>(
    null
  );
  const [err, setErr] = useState<string | null>(null);
  const stop = useRef(false);
  const code = `DELETE ${ids.length}`;
  const ok = reason.trim().length >= 3 && typed.trim().toUpperCase() === code;

  const run = async () => {
    setErr(null);
    stop.current = false;
    let batchId: number | null = null;
    let removed = 0;
    const skipped: any[] = [];
    setProg({ done: 0, removed: 0 });
    try {
      for (let i = 0; i < ids.length; i += 50) {
        if (stop.current) break;
        const r = await api.post(`/api/system/cleanup/${kind}/remove`, {
          ids: ids.slice(i, i + 50),
          total: ids.length,
          confirm: typed.trim(),
          reason: reason.trim(),
          mode,
          filters,
          batch_id: batchId,
        });
        batchId = r.batch_id || batchId;
        removed += r.removed;
        skipped.push(...(r.skipped || []));
        setProg({ done: Math.min(ids.length, i + 50), removed });
      }
      onClose({
        type: skipped.length ? "error" : "success",
        text: `${removed} ${noun} removed${stop.current ? " (stopped)" : ""}.${
          skipped.length
            ? ` ${skipped.length} left as they are: ${skipped
                .slice(0, 3)
                .map((s) => s.why)
                .join("; ")}`
            : ""
        } You can put them back from the Removal log for 30 days.`,
      });
    } catch (e: any) {
      setErr(e.message);
      if (removed) setProg((p) => p && { ...p });
    }
  };

  const running = !!prog && !err;
  return (
    <div
      className="fixed inset-0 z-[90] liquid-glass-backdrop flex items-end sm:items-center justify-center p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="liquid-glass liquid-glass-in rounded-[32px] max-w-md w-full max-h-[92vh] flex flex-col overflow-hidden">
        {!running && (
          <button
            type="button"
            onClick={() => onClose(null)}
            aria-label="Close"
            className="liquid-glass-chip absolute top-3.5 right-3.5 z-10 p-1.5 text-slate-600 hover:text-slate-900 rounded-full"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        <div className="p-5 sm:p-6 overflow-y-auto space-y-3">
          <div className="flex items-center gap-3">
            <span className="liquid-glass-inset w-10 h-10 rounded-xl flex items-center justify-center text-red-600">
              <Trash2 className="w-5 h-5" />
            </span>
            <h3 className="text-base font-bold text-red-800">
              Remove {ids.length} {noun}
              {kind === "attendance" && mode === "out" ? " (Out only)" : ""}
            </h3>
          </div>
          <p className="liquid-glass-inset rounded-2xl px-3 py-2 text-xs text-slate-700">
            They are taken out of every list, report and approval.
            {leaveDays
              ? ` ${leaveDays} leave days go back to the balances.`
              : ""}{" "}
            Logged with your reason; can be put back from the Removal log for 30
            days.
          </p>
          <label className="block text-xs font-semibold text-slate-600">
            Reason (kept in the log)
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              disabled={!!prog}
              className="mt-1 w-full rounded-xl border border-slate-200 bg-white/80 px-3 py-2 text-sm"
              placeholder="e.g. Test data before go-live"
            />
          </label>
          <label className="block text-xs font-semibold text-slate-600">
            Type <b className="text-red-700">{code}</b> to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={!!prog}
              className="mt-1 w-full h-10 rounded-xl border border-slate-200 bg-white/80 px-3 text-sm font-mono"
              autoComplete="off"
            />
          </label>
          {prog && (
            <div className="space-y-1">
              <div className="h-2 rounded-full bg-white/70 overflow-hidden">
                <div
                  className="h-full bg-red-600 transition-all"
                  style={{ width: `${(prog.done / ids.length) * 100}%` }}
                />
              </div>
              <p className="text-xs text-slate-600">
                Removing… {prog.done} of {ids.length}
              </p>
            </div>
          )}
          {err && <p className="text-xs text-red-700">{err}</p>}
          <div className="flex gap-2 pt-1">
            {running ? (
              <button
                type="button"
                onClick={() => (stop.current = true)}
                className="liquid-glass-button rounded-full flex-1 h-11 text-sm font-bold text-slate-800"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                disabled={!ok}
                onClick={run}
                className="liquid-glass-button rounded-full flex-1 h-11 text-sm font-bold disabled:opacity-40"
                style={{ "--g-accent": "#dc2626" } as React.CSSProperties}
              >
                Remove {ids.length} {noun}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const RemovalLog: React.FC<{
  log: any[] | null;
  onRestore: (b: any) => void;
}> = ({ log, onRestore }) => (
  <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-2">
    <h3 className="text-sm font-bold text-slate-900">Removal log</h3>
    {!log && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
    {log && !log.length && (
      <p className="text-xs text-slate-500">Nothing has been removed yet.</p>
    )}
    <ul className="divide-y divide-slate-100">
      {(log || []).map((b) => (
        <li
          key={b.id}
          className="py-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-700"
        >
          <span>
            <b>{fmtWhen(b.created_at)}</b> · {b.actor_name || "System owner"}{" "}
            removed <b>{b.count}</b> {b.kind_label}
            {b.mode === "out" ? " (Out only)" : ""} — “{b.reason}”
            {b.restored_at && (
              <span className="text-emerald-700">
                {" "}
                · {b.restored_count} put back {fmtWhen(b.restored_at)}
                {b.restored_by_name ? ` by ${b.restored_by_name}` : ""}
              </span>
            )}
          </span>
          {b.can_restore ? (
            <button
              type="button"
              onClick={() => onRestore(b)}
              className="inline-flex items-center gap-1 h-8 px-3 rounded-full border border-slate-200 font-semibold text-slate-700"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Put{" "}
              {b.count > 1 ? "all " : ""}back
            </button>
          ) : (
            <span className="text-slate-400">
              {b.restored_at ? "" : "Over 30 days — cannot be put back"}
            </span>
          )}
        </li>
      ))}
    </ul>
  </div>
);
