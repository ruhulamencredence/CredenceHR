// AI Assistant ("Credence Assistant") — a chat helper every account can open
// from the floating button (unless HR switches it off for them in Module
// Access: users.can_use_ai_assistant).
//
// It answers three kinds of question:
//   1. the account's own data — leave balance, leave applications, this
//      month's attendance / late days, claims, loans, tasks, holidays;
//   2. how to use the app — where a page is, with a button that opens it;
//   3. HR/Admin figures — today's attendance, pending work, onboarding,
//      headcount, finding a colleague.
//
// Every figure is fetched by calling the app's OWN API on this server with the
// asker's own token (see callApi), so the assistant can never show something
// the account couldn't already open: a 403 there is "you don't have access"
// here. Nothing is written — it only reads and points to the right page.
//
// Two engines:
//   - local  (always available): Bangla / English / Banglish keyword matching
//     with fixed Bangla answers. Needs no key, sends nothing outside.
//   - gemini (when GEMINI_API_KEY is set): free-form questions; Gemini picks
//     which of the same read-only tools to call. Falls back to local on any
//     error. Note: in this mode the question and the tool results are sent to
//     Google.

import type { Express } from "express";
import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface AiAssistantDeps {
  authenticateToken: any;
  queryDB: QueryDB;
  getAdminModules: (userId: number) => Promise<string[]>;
  todayInDhaka: () => string;
}

// A page the client can open. kind:target is understood by AiAssistant.tsx.
export interface AssistantAction {
  label: string;
  nav: string; // 'self:<view>' | 'admin:<tab>' | 'claims:<movementClaims|conveyanceBill>' | 'hrops:<tab>' | 'home' | 'profile'
}

interface Ctx {
  req: any;
  userId: number;
  name: string;
  role: string;
  modules: string[];
  flags: Record<string, boolean>;
  today: string;
}

interface ToolResult {
  ok: boolean;
  text: string; // ready-made Bangla answer (local engine)
  data?: any; // compact facts (Gemini engine)
  actions?: AssistantAction[];
}

const SELF_FLAGS = [
  "can_view_movement_claims", "can_view_conveyance_claims", "can_view_timesheet", "can_view_leave_application",
  "can_view_my_leave", "can_view_tasks", "can_view_mobile_bill", "can_view_loan_request", "can_manage_leave"
] as const;

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
const bn = (v: any) => String(v ?? "").replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);
const BN_MONTHS = ["জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন", "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"];
const bnDate = (iso: any) => {
  const s = String(iso || "").slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${bn(Number(m[3]))} ${BN_MONTHS[Number(m[2]) - 1]} ${bn(m[1])}` : s;
};
const bnMonth = (ym: string) => {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  return m ? `${BN_MONTHS[Number(m[2]) - 1]} ${bn(m[1])}` : ym;
};
const money = (v: any) => `৳${bn(Math.round(Number(v) || 0).toLocaleString("en-IN"))}`;
const STATUS_BN: Record<string, string> = {
  pending: "অপেক্ষমাণ", approved: "অনুমোদিত", rejected: "বাতিল", cancelled: "প্রত্যাহার", returned: "ফেরত",
  paid: "পরিশোধিত", disbursed: "পরিশোধিত", active: "চলমান", completed: "সম্পূর্ণ", closed: "বন্ধ", open: "খোলা",
  in_progress: "চলছে", submitted: "জমা", draft: "খসড়া", ongoing: "চলমান"
};
const st = (s: any) => STATUS_BN[String(s || "").toLowerCase()] || String(s || "-");

const isSuper = (c: Ctx) => c.role === "superadmin";
const hasMod = (c: Ctx, k: string) => isSuper(c) || c.modules.includes(k);

// ---------------------------------------------------------------------------
// App help — where things are. `can` keeps a page out of the answer when the
// account couldn't open it anyway (same rules as GlobalSidebar).
// ---------------------------------------------------------------------------
interface HelpEntry {
  id: string;
  title: string;
  keys: string[];
  steps: string;
  nav?: string;
  can?: (c: Ctx) => boolean;
}

const HELP: HelpEntry[] = [
  { id: "leave_apply", title: "ছুটির আবেদন", keys: ["leave apply", "apply leave", "chuti nibo", "chuti nite", "leave nibo", "ছুটি নেব", "ছুটি নিতে", "ছুটির আবেদন", "leave application", "ছুটি চাই", "chuti chai"],
    steps: "মেনু → Leave & Attendance → **Leave Application** → \"New Leave Application\"। ছুটির ধরন, তারিখ আর কারণ দিন, দরকার হলে Reliever বেছে Submit করুন। আবেদন আপনার supervisor / approval chain-এ যাবে।",
    nav: "self:leaveApplication", can: (c) => isSuper(c) || c.flags.can_view_leave_application || c.flags.can_view_my_leave },
  { id: "movement_claim", title: "Movement Claim", keys: ["movement", "মুভমেন্ট", "check in", "check-in", "চেক ইন", "checkin"],
    steps: "মেনু → Requests & Claims → **Movement Claims**। কাজে বের হওয়ার সময় Check In, ফেরার সময় Check Out দিন — লোকেশন নিজে থেকে বসে যায়।",
    nav: "claims:movementClaims", can: (c) => isSuper(c) || c.flags.can_view_movement_claims },
  { id: "conveyance", title: "Conveyance Bill Claim", keys: ["conveyance", "কনভেয়েন্স", "bill claim", "বিল জমা", "bill dibo", "যাতায়াত বিল", "transport bill"],
    steps: "মেনু → Requests & Claims → **Conveyance Bill Claim** → New Claim। তারিখ, খরচের ধরন, টাকা আর বিবরণ দিয়ে জমা দিন। Transport হলে আগের Movement check-in/out রেফারেন্স হিসেবে বেছে নিতে পারবেন।",
    nav: "claims:conveyanceBill", can: (c) => isSuper(c) || c.flags.can_view_conveyance_claims || c.modules.includes("conveyance") },
  { id: "timesheet", title: "Timesheet", keys: ["timesheet", "টাইমশিট"],
    steps: "মেনু → Leave & Attendance → **Timesheet**।", nav: "self:timesheet", can: (c) => isSuper(c) || c.flags.can_view_timesheet },
  { id: "asset", title: "Asset চাওয়া", keys: ["asset", "অ্যাসেট", "laptop", "ল্যাপটপ", "computer", "কম্পিউটার", "চেয়ার", "furniture"],
    steps: "মেনু → Requests & Claims → **My Asset** → New Requisition। কী লাগবে লিখে জমা দিন; অনুমোদনের পর Inventory থেকে দেওয়া হবে।", nav: "self:assetManagement" },
  { id: "vehicle", title: "গাড়ি বুক করা", keys: ["vehicle", "গাড়ি", "gari", "car", "ride", "book a ride", "transport chai"],
    steps: "মেনু → Requests & Claims → **Book a Ride**। কোথা থেকে কোথায়, কবে, কতজন — দিয়ে requisition দিন।", nav: "self:vehicleManagement" },
  { id: "resignation", title: "Resignation", keys: ["resign", "রিজাইন", "পদত্যাগ", "চাকরি ছাড়", "resignation"],
    steps: "মেনু → Others → **My Resignation**। শেষ কর্মদিবস আর কারণ দিয়ে জমা দিন; HR exit প্রক্রিয়া শুরু করবে।", nav: "self:resignation" },
  { id: "letters", title: "Letter / Certificate", keys: ["letter", "লেটার", "certificate", "সার্টিফিকেট", "প্রত্যয়ন", "salary certificate", "experience letter", "noc"],
    steps: "মেনু → Requests & Claims → **My Letters & Service Record**। আপনাকে দেওয়া চিঠি দেখা যায়, আর \"Request a letter\" দিয়ে Salary / Experience certificate চাওয়া যায়।", nav: "self:myLetters" },
  { id: "loan", title: "Loan / Advance", keys: ["loan", "লোন", "ঋণ", "advance", "অ্যাডভান্স", "অগ্রিম"],
    steps: "মেনু → Requests & Claims → **My Loan / Advance** → New Request। টাকা, কিস্তি আর কারণ দিয়ে জমা দিন।", nav: "self:myLoans", can: (c) => isSuper(c) || c.flags.can_view_loan_request },
  { id: "sim", title: "Mobile SIM / বিল", keys: ["sim", "সিম", "mobile bill", "মোবাইল বিল", "phone bill", "limit"],
    steps: "মেনু → Requests & Claims → **My Mobile SIM**। আপনার SIM, মাসিক limit আর বিল দেখা যায়; limit বাড়াতে request দিন।", nav: "self:myMobileSim", can: (c) => isSuper(c) || c.flags.can_view_mobile_bill || c.modules.includes("mobile_bill") },
  { id: "tasks", title: "My Tasks", keys: ["task", "টাস্ক"],
    steps: "মেনু → Work & Approvals → **My Tasks**।", nav: "self:myTasks", can: (c) => isSuper(c) || c.flags.can_view_tasks || c.modules.includes("task_management") },
  { id: "approve", title: "আবেদন অনুমোদন", keys: ["approve", "অনুমোদন", "approval", "এপ্রুভ", "approve korbo"],
    steps: "মেনু → Work & Approvals → **Approve Application**। আপনার কাছে যত আবেদন অপেক্ষায় আছে (ছুটি, claim, asset…) সব এক জায়গায়।", nav: "self:approveApplications" },
  { id: "directory", title: "Employee Directory", keys: ["directory", "ডিরেক্টরি", "সহকর্মী", "colleague", "phone number", "ফোন নম্বর"],
    steps: "মেনু → Others → **Employee Directory**। নাম বা ID দিয়ে খুঁজুন।", nav: "self:employeeDirectory" },
  { id: "grievance", title: "অভিযোগ (Grievance)", keys: ["grievance", "অভিযোগ", "complain", "complaint", "নালিশ"],
    steps: "মেনু → Others → **Grievance & Disciplinary** → New Grievance। গোপনীয়ভাবে HR-এর কাছে যায়।", nav: "self:myCases" },
  { id: "password", title: "Password / Profile", keys: ["password", "পাসওয়ার্ড", "profile", "প্রোফাইল", "ছবি", "photo", "username"],
    steps: "আপনার **Profile** পাতায় (ওয়েবে উপরে ডান কোণে নামের অক্ষরে চাপলে খোলে) ছবি, ব্যক্তিগত তথ্য, Username আর Password বদলানো যায়। নিচের বোতামেও খোলা যাবে।", nav: "profile" },
  { id: "chat", title: "Chat", keys: ["chat", "চ্যাট", "message", "মেসেজ", "call", "কল"],
    steps: "উপরের বারে Chat আইকন (💬) চাপুন। কাউকে খুঁজে মেসেজ পাঠান; Calls চালু থাকলে অডিও/ভিডিও কলও করা যায়।" },
  { id: "payslip", title: "বেতন / Payslip", keys: ["payslip", "পে স্লিপ", "salary slip", "বেতন", "salary", "স্যালারি"],
    steps: "বেতনের হিসাব Payroll বিভাগ তৈরি করে। Payslip বা বেতন-সংক্রান্ত প্রশ্নে HR/Accounts-এ যোগাযোগ করুন। Salary certificate লাগলে My Letters থেকে চাইতে পারেন।", nav: "self:myLetters" },
  // HR / Admin pages
  { id: "add_employee", title: "নতুন Employee যোগ", keys: ["add employee", "new employee", "নতুন কর্মী", "employee add", "employee jog", "কর্মী যোগ"],
    steps: "Admin Panel → Employee Management → **Employees** → \"Add Employee\"। অনেকজন একসাথে হলে HR Data Import ব্যবহার করুন।", nav: "admin:employees", can: (c) => hasMod(c, "employees") },
  { id: "import", title: "Data Import", keys: ["import", "ইমপোর্ট", "excel upload", "bulk"],
    steps: "Admin Panel → **HR Data Import**। ধরন বেছে Template নামান, পূরণ করে Upload → Check → Import।", nav: "admin:data_import", can: (c) => isSuper(c) || c.modules.includes("data_import") },
  { id: "payroll", title: "Payroll চালানো", keys: ["payroll", "পেরোল", "run payroll", "বেতন তৈরি"],
    steps: "Admin Panel → Payroll → **Payroll** → Run Payroll। মাস বেছে ধাপে ধাপে attendance, adjustment দেখে Generate, তারপর Audit/Accounts approval।", nav: "self:payroll", can: (c) => hasMod(c, "payroll") },
  { id: "module_access", title: "Permission / Module Access", keys: ["permission", "পারমিশন", "module access", "access dibo", "access দেব", "অনুমতি"],
    steps: "Admin Panel → **Users** → user-এর পাশে \"Module Access\"। Module আর তার ভেতরের layer টিক দিয়ে Save।", nav: "admin:users", can: (c) => isSuper(c) || c.modules.includes("users") },
  { id: "holidays", title: "Holiday যোগ", keys: ["holiday add", "ছুটির দিন যোগ", "holiday set", "weekend set"],
    steps: "Admin Panel → **Holidays**। তারিখ, ধরন (Holiday/Weekend) আর কাদের জন্য তা দিয়ে Save।", nav: "admin:holidays", can: (c) => hasMod(c, "holidays") },
  { id: "onboarding", title: "Onboarding", keys: ["onboarding", "অনবোর্ডিং", "new joiner", "নতুন যোগদান", "joiner"],
    steps: "Admin Panel → HR Operations → **Onboarding**। New Joiners-এ যোগদানকারীর login, Checklist-এ ID card, Bank, SIM-এর মতো কাজ কার কী বাকি।", nav: "hrops:onboarding", can: (c) => hasMod(c, "hr_operations") },
  { id: "issue_letter", title: "Letter issue", keys: ["issue letter", "letter dibo", "appointment letter", "চিঠি দেব", "letter issue"],
    steps: "Admin Panel → HR Operations → **Letters** → New Letter। Employee আর template বেছে দেখে Issue করুন।", nav: "hrops:letters", can: (c) => hasMod(c, "hr_operations") },
  { id: "leave_admin", title: "Leave Applications (HR)", keys: ["leave report", "সবার ছুটি", "leave applications", "leave approve"],
    steps: "Admin Panel → Leave → **Leave Applications**। সবার আবেদন, অবস্থা আর রিপোর্ট।", nav: "admin:leave_applications", can: (c) => hasMod(c, "leave_applications") },
  { id: "notice", title: "Notice দেওয়া", keys: ["notice", "নোটিশ", "announcement", "ঘোষণা"],
    steps: "Admin Panel → **Notices** → New Notice।", nav: "admin:notices", can: (c) => hasMod(c, "notices") },
  { id: "approval_chain", title: "Approval Chain", keys: ["approval chain", "chain", "approver set", "কে approve করবে"],
    steps: "Admin Panel → **Approval Chain**। কোন আবেদন কোন ধাপে কে approve করবে, তা এখানে ঠিক করা হয়।", nav: "admin:approvals", can: (c) => hasMod(c, "approvals") },
  { id: "reports", title: "Reports", keys: ["report", "রিপোর্ট"],
    steps: "Admin Panel → **Reports & Insights**। তৈরি রিপোর্ট বা নিজের মতো রিপোর্ট বানিয়ে Excel/PDF।", nav: "admin:reports_insights", can: (c) => isSuper(c) || c.modules.includes("reports_insights") }
];

// Whether this account could open the page behind a button (same rules as the
// menu); buttons it couldn't use are dropped.
function canNav(c: Ctx, nav: string): boolean {
  if (isSuper(c)) return true;
  const [kind, target] = nav.split(":");
  const f = c.flags;
  if (kind === "self") {
    switch (target) {
      case "leaveApplication": return f.can_view_leave_application || f.can_view_my_leave;
      case "leaveManagement": return f.can_manage_leave;
      case "timesheet": return f.can_view_timesheet;
      case "myTasks": return f.can_view_tasks || c.modules.includes("task_management");
      case "myMobileSim": return f.can_view_mobile_bill || c.modules.includes("mobile_bill");
      case "myLoans": return f.can_view_loan_request;
      case "payroll": return c.modules.includes("payroll");
      default: return true;
    }
  }
  if (kind === "claims") return target === "movementClaims" ? f.can_view_movement_claims : f.can_view_conveyance_claims || c.modules.includes("conveyance");
  if (kind === "admin") return target === "dashboard" ? c.role === "admin" || c.modules.includes("admin_dashboard") : c.modules.includes(target);
  if (kind === "hrops") return c.modules.includes("hr_operations");
  return true;
}
const allowedActions = (c: Ctx, actions: AssistantAction[]) => actions.filter((a) => canNav(c, a.nav));

const helpAction = (h: HelpEntry): AssistantAction[] => (h.nav ? [{ label: `${h.title} খুলুন`, nav: h.nav }] : []);

// ---------------------------------------------------------------------------
// The account's own API, called with the account's own token.
// ---------------------------------------------------------------------------
async function callApi(req: any, path: string): Promise<{ ok: boolean; status: number; body: any }> {
  const port = req.socket?.localPort;
  const headers: Record<string, string> = { Authorization: String(req.headers.authorization || "") };
  if (req.headers["x-company-id"]) headers["X-Company-Id"] = String(req.headers["x-company-id"]);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal: AbortSignal.timeout(15000) });
    const body = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

const NO_ACCESS: ToolResult = { ok: false, text: "এই তথ্য দেখার অনুমতি আপনার account-এ নেই। দরকার হলে HR / Superadmin-কে বলুন।", data: { error: "no_access" } };
const FAILED: ToolResult = { ok: false, text: "দুঃখিত, এই মুহূর্তে তথ্যটা আনতে পারছি না। একটু পরে আবার চেষ্টা করুন।", data: { error: "failed" } };
const fail = (status: number) => (status === 403 ? NO_ACCESS : FAILED);

const monthShift = (ym: string, delta: number) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

// ---------------------------------------------------------------------------
// Tools — each reads one thing. `available` hides a tool from Gemini when the
// account plainly can't use it; the API's own 403 is still the real gate.
// ---------------------------------------------------------------------------
interface Tool {
  name: string;
  description: string;
  params?: Record<string, { type: string; description: string }>;
  available?: (c: Ctx) => boolean;
  run: (c: Ctx, args: any) => Promise<ToolResult>;
}

const TOOLS: Tool[] = [
  {
    name: "my_leave_balance",
    description: "The asking employee's own remaining leave balance by leave type.",
    run: async (c) => {
      const r = await callApi(c.req, "/api/leave-balances/mine");
      if (!r.ok) return fail(r.status);
      const b = Array.isArray(r.body) ? r.body[0] : r.body;
      if (!b) return { ok: true, text: "আপনার নামে এখনো কোনো ছুটির ব্যালেন্স সেট করা নেই। HR-এর সাথে কথা বলুন।", data: { balances: [] } };
      const list = [
        { label: "Casual", balance: Number(b.casual_leave) || 0 },
        { label: "Sick", balance: Number(b.sick_leave) || 0 },
        ...((b.custom_leaves || []) as any[]).map((x) => ({ label: String(x.label), balance: Number(x.balance) || 0 }))
      ];
      const lines = list.map((x) => `• ${x.label}: **${bn(x.balance)} দিন**`).join("\n");
      return { ok: true, text: `আপনার ছুটি বাকি আছে:\n${lines}`, data: { balances: list }, actions: [{ label: "Leave Application খুলুন", nav: "self:leaveApplication" }] };
    }
  },
  {
    name: "my_leave_applications",
    description: "The asking employee's own recent leave applications with their status (pending/approved/rejected).",
    run: async (c) => {
      const r = await callApi(c.req, "/api/leave-applications/mine");
      if (!r.ok) return fail(r.status);
      const rows: any[] = Array.isArray(r.body) ? r.body : [];
      if (!rows.length) return { ok: true, text: "আপনার কোনো ছুটির আবেদন পাওয়া যায়নি।", data: { applications: [] }, actions: [{ label: "Leave Application খুলুন", nav: "self:leaveApplication" }] };
      const recent = [...rows].sort((a, b) => String(b.start_date).localeCompare(String(a.start_date))).slice(0, 5);
      const pending = rows.filter((x) => x.status === "pending").length;
      const lines = recent.map((x) => `• ${x.leave_type_label || x.leave_type} — ${bnDate(x.start_date)}${x.end_date && x.end_date !== x.start_date ? ` থেকে ${bnDate(x.end_date)}` : ""} (${bn(x.day_count)} দিন): **${st(x.status)}**`).join("\n");
      return {
        ok: true,
        text: `${pending ? `আপনার ${bn(pending)}টি আবেদন অনুমোদনের অপেক্ষায়।\n` : ""}সাম্প্রতিক আবেদন:\n${lines}`,
        data: { pending, recent: recent.map((x) => ({ type: x.leave_type_label || x.leave_type, from: x.start_date, to: x.end_date, days: x.day_count, status: x.status, current_step: x.current_step, total_steps: x.total_steps })) },
        actions: [{ label: "Leave Application খুলুন", nav: "self:leaveApplication" }]
      };
    }
  },
  {
    name: "my_attendance_summary",
    description: "The asking employee's own attendance for a salary month: present, absent, leave and late days. Optional month_year 'YYYY-MM' (default current month).",
    params: { month_year: { type: "string", description: "Month as YYYY-MM; omit for the current month." } },
    run: async (c, args) => {
      const ym = /^\d{4}-\d{2}$/.test(String(args?.month_year || "")) ? String(args.month_year) : "";
      const r = await callApi(c.req, `/api/my-attendance-summary${ym ? `?month_year=${ym}` : ""}`);
      if (!r.ok) return fail(r.status);
      const s = r.body || {};
      if (s.linked === false) return { ok: true, text: "আপনার login এখনো কোনো Employee record-এর সাথে যুক্ত নয়, তাই হাজিরার হিসাব দেখানো যাচ্ছে না। HR-কে জানান।", data: { linked: false } };
      const text =
        `${bnMonth(String(s.month_year || ym))}-এর হাজিরা (${bnDate(s.period_start)} – ${bnDate(s.period_end)}):\n` +
        `• উপস্থিত: **${bn(s.present_days ?? 0)} দিন**\n• ছুটি: ${bn(s.leave_days ?? 0)} দিন\n• অনুপস্থিত: ${bn(s.absent_days ?? 0)} দিন\n` +
        `• দেরি (late): **${bn(s.late_count ?? 0)} বার**${Number(s.late_deduction_days) ? ` — এর জন্য ${bn(s.late_deduction_days)} দিন কাটা যেতে পারে` : ""}\n` +
        `• এখন পর্যন্ত কর্মদিবস: ${bn(s.working_days_so_far ?? 0)} / ${bn(s.working_days ?? 0)}`;
      return { ok: true, text, data: s };
    }
  },
  {
    name: "my_late_days",
    description: "The exact dates the asking employee came late between two dates (YYYY-MM-DD). Defaults to the current month.",
    params: { from: { type: "string", description: "Start date YYYY-MM-DD" }, to: { type: "string", description: "End date YYYY-MM-DD" } },
    run: async (c, args) => {
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.from || "")) ? String(args.from) : c.today.slice(0, 8) + "01";
      const to = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.to || "")) ? String(args.to) : c.today;
      const r = await callApi(c.req, `/api/my-late-days?from=${from}&to=${to}`);
      if (!r.ok) return fail(r.status);
      if (r.body?.linked === false) return { ok: true, text: "আপনার login এখনো Employee record-এর সাথে যুক্ত নয়, তাই দেরির হিসাব দেখানো যাচ্ছে না। HR-কে জানান।", data: { linked: false } };
      // { days: { 'YYYY-MM-DD': 'delay' | 'extreme' } }
      const days = Object.entries((r.body?.days || {}) as Record<string, string>).sort(([a], [b]) => a.localeCompare(b));
      if (!days.length) return { ok: true, text: `${bnDate(from)} থেকে ${bnDate(to)} পর্যন্ত আপনার কোনো দেরি নেই। 👍`, data: { from, to, days: [] } };
      const extreme = days.filter(([, k]) => k === "extreme").length;
      const lines = days.slice(0, 12).map(([d, k]) => `• ${bnDate(d)}${k === "extreme" ? " — অনেক দেরি" : ""}`).join("\n");
      return {
        ok: true,
        text: `${bnDate(from)} – ${bnDate(to)}: **${bn(days.length)} দিন দেরি**${extreme ? ` (এর মধ্যে ${bn(extreme)} দিন অনেক দেরি)` : ""}\n${lines}${days.length > 12 ? `\n…আরও ${bn(days.length - 12)} দিন` : ""}`,
        data: { from, to, late_days: days.map(([d, k]) => ({ date: d, kind: k === "extreme" ? "extreme_late" : "late" })) }
      };
    }
  },
  {
    name: "my_claims",
    description: "The asking employee's own movement claims and conveyance bill claims with status.",
    available: (c) => isSuper(c) || c.flags.can_view_movement_claims || c.flags.can_view_conveyance_claims || c.modules.includes("conveyance"),
    run: async (c) => {
      const [m, u] = await Promise.all([callApi(c.req, "/api/claims/mine"), callApi(c.req, "/api/user-claims/mine")]);
      if (!m.ok && !u.ok) return fail(m.status === 403 && u.status === 403 ? 403 : 500);
      const parts: string[] = [];
      const data: any = {};
      const actions: AssistantAction[] = [];
      if (u.ok) {
        const rows: any[] = Array.isArray(u.body) ? u.body : u.body?.rows || [];
        const pend = rows.filter((x) => x.status === "pending");
        data.bill_claims = { total: rows.length, pending: pend.length, pending_amount: pend.reduce((s, x) => s + (Number(x.amount) || 0), 0), recent: rows.slice(0, 5).map((x) => ({ date: x.claim_date, category: x.category, amount: x.amount, status: x.status })) };
        parts.push(rows.length
          ? `**Conveyance / Bill claim:** মোট ${bn(rows.length)}টি, অপেক্ষমাণ ${bn(pend.length)}টি (${money(data.bill_claims.pending_amount)})\n` + rows.slice(0, 4).map((x) => `• ${bnDate(x.claim_date)} — ${x.category || "Bill"} ${money(x.amount)}: ${st(x.status)}`).join("\n")
          : "**Conveyance / Bill claim:** কোনো claim নেই।");
        actions.push({ label: "Conveyance Bill খুলুন", nav: "claims:conveyanceBill" });
      }
      if (m.ok) {
        const rows: any[] = Array.isArray(m.body) ? m.body : [];
        const open = rows.filter((x) => x.check_in_at && !x.check_out_at).length;
        data.movement_claims = { total: rows.length, open_check_ins: open, by_status: rows.reduce((a: any, x) => ((a[x.status] = (a[x.status] || 0) + 1), a), {}) };
        parts.push(rows.length
          ? `**Movement claim:** মোট ${bn(rows.length)}টি${open ? `, ${bn(open)}টিতে এখনো Check Out দেওয়া হয়নি` : ""}।`
          : "**Movement claim:** কোনো claim নেই।");
        actions.push({ label: "Movement Claims খুলুন", nav: "claims:movementClaims" });
      }
      return { ok: true, text: parts.join("\n\n"), data, actions };
    }
  },
  {
    name: "my_loans",
    description: "The asking employee's own running loans/advances (remaining amount) and loan requests.",
    run: async (c) => {
      const r = await callApi(c.req, "/api/my-loans");
      if (!r.ok) return fail(r.status);
      const b = r.body || {};
      if (b.linked === false) return { ok: true, text: "আপনার login এখনো Employee record-এর সাথে যুক্ত নয়। HR-কে জানান।", data: { linked: false } };
      const loans: any[] = (b.loans || []).filter((l: any) => l.status === "active");
      const reqs: any[] = (b.requests || []).filter((x: any) => x.status === "pending");
      const due = loans.reduce((s, l) => s + Math.max(0, (Number(l.total_amount) || 0) - (Number(l.paid_amount) || 0)), 0);
      const text = (loans.length
        ? `চলমান loan/advance ${bn(loans.length)}টি, মোট বাকি **${money(due)}**।\n` + loans.map((l) => `• ${money(l.total_amount)} — পরিশোধ ${money(l.paid_amount)}, মাসিক কিস্তি ${money(l.monthly_installment)}`).join("\n")
        : "আপনার কোনো চলমান loan / advance নেই।") + (reqs.length ? `\nঅপেক্ষমাণ আবেদন: ${bn(reqs.length)}টি।` : "");
      return { ok: true, text, data: { active_loans: loans.map((l) => ({ total: l.total_amount, paid: l.paid_amount, installment: l.monthly_installment })), remaining: due, pending_requests: reqs.length }, actions: [{ label: "My Loan / Advance খুলুন", nav: "self:myLoans" }] };
    }
  },
  {
    name: "my_tasks",
    description: "Tasks assigned to the asking employee that are still open, with due dates.",
    available: (c) => isSuper(c) || c.flags.can_view_tasks || c.modules.includes("task_management"),
    run: async (c) => {
      const r = await callApi(c.req, "/api/tasks/mine");
      if (!r.ok) return fail(r.status);
      const open: any[] = (r.body?.assigned || []).filter((t: any) => !["completed", "cancelled"].includes(String(t.status)));
      if (!open.length) return { ok: true, text: "আপনার কোনো খোলা task নেই। 🎉", data: { open: [] }, actions: [{ label: "My Tasks খুলুন", nav: "self:myTasks" }] };
      const late = open.filter((t) => t.due_date && String(t.due_date).slice(0, 10) < c.today).length;
      const lines = open.slice(0, 6).map((t) => `• ${t.title}${t.due_date ? ` — শেষ তারিখ ${bnDate(t.due_date)}` : ""}${t.due_date && String(t.due_date).slice(0, 10) < c.today ? " ⚠️" : ""}`).join("\n");
      return { ok: true, text: `আপনার ${bn(open.length)}টি task খোলা${late ? `, এর মধ্যে ${bn(late)}টির সময় পেরিয়ে গেছে` : ""}:\n${lines}`, data: { open: open.slice(0, 20).map((t) => ({ title: t.title, due: t.due_date, status: t.status, priority: t.priority })) }, actions: [{ label: "My Tasks খুলুন", nav: "self:myTasks" }] };
    }
  },
  {
    name: "upcoming_holidays",
    description: "Upcoming public holidays (not weekends) from today.",
    run: async (c) => {
      const r = await callApi(c.req, "/api/holidays");
      if (!r.ok) return fail(r.status);
      const seen = new Set<string>();
      const list = (Array.isArray(r.body) ? r.body : [])
        .filter((h: any) => h.day_type !== "weekend" && String(h.entry_date).slice(0, 10) >= c.today)
        .sort((a: any, b: any) => String(a.entry_date).localeCompare(String(b.entry_date)))
        .filter((h: any) => { const k = String(h.entry_date).slice(0, 10) + h.title; if (seen.has(k)) return false; seen.add(k); return true; })
        .slice(0, 6);
      if (!list.length) return { ok: true, text: "সামনে কোনো ছুটির দিন এখনো ঘোষণা করা হয়নি।", data: { holidays: [] } };
      return { ok: true, text: "সামনের ছুটির দিন:\n" + list.map((h: any) => `• ${bnDate(h.entry_date)} — ${h.title}`).join("\n"), data: { holidays: list.map((h: any) => ({ date: String(h.entry_date).slice(0, 10), title: h.title, applies_to: h.applies_to })) } };
    }
  },
  {
    name: "find_colleague",
    description: "Find a colleague in the Employee Directory by name, employee ID or designation; returns designation, department and contact.",
    params: { query: { type: "string", description: "Name, employee ID or designation to search for." } },
    run: async (c, args) => {
      const q = String(args?.query || "").trim().toLowerCase();
      if (q.length < 2) return { ok: false, text: "কার খোঁজ চান? নাম বা Employee ID লিখুন — যেমন \"Rahim-এর নম্বর\"।" };
      const r = await callApi(c.req, "/api/employee-directory");
      if (!r.ok) return fail(r.status);
      const hits = (Array.isArray(r.body) ? r.body : []).filter((e: any) =>
        [e.name, e.employee_id, e.designation].some((v) => String(v || "").toLowerCase().includes(q))
      ).slice(0, 5);
      if (!hits.length) return { ok: true, text: `"${args.query}" নামে কাউকে পাওয়া যায়নি।`, data: { results: [] }, actions: [{ label: "Employee Directory খুলুন", nav: "self:employeeDirectory" }] };
      const lines = hits.map((e: any) => `• **${e.name}** (${e.employee_id || "-"}) — ${e.designation || "-"}${e.department ? `, ${e.department}` : ""}${e.mobile || e.phone ? ` · 📞 ${e.mobile || e.phone}` : ""}${e.email ? ` · ${e.email}` : ""}`).join("\n");
      return { ok: true, text: lines, data: { results: hits.map((e: any) => ({ name: e.name, id: e.employee_id, designation: e.designation, department: e.department, mobile: e.mobile || e.phone, email: e.email, supervisor: e.supervisor_name })) }, actions: [{ label: "Employee Directory খুলুন", nav: "self:employeeDirectory" }] };
    }
  },
  // ---- HR / Admin ----
  {
    name: "admin_pending_work",
    description: "HR/Admin: counts of items waiting in the organisation (leave applications, claims, bills to disburse, asset/vehicle requisitions, personnel actions…).",
    available: (c) => isSuper(c) || c.role === "admin" || c.modules.includes("admin_dashboard"),
    run: async (c) => {
      const r = await callApi(c.req, "/api/admin-dashboard/extras");
      if (!r.ok) return fail(r.status);
      const tasks: any[] = (r.body?.tasks || []).filter((t: any) => Number(t.count) > 0);
      if (!tasks.length) return { ok: true, text: "এই মুহূর্তে কিছুই অপেক্ষায় নেই। 👍", data: { pending: [] } };
      const actions = tasks.filter((t) => t.tab).slice(0, 3).map((t) => ({ label: `${t.label} খুলুন`, nav: t.tab === "hr_operations" ? "hrops:dashboard" : `admin:${t.tab}` }));
      return { ok: true, text: "যা অপেক্ষায় আছে:\n" + tasks.map((t) => `• ${t.label}: **${bn(t.count)}**`).join("\n"), data: { pending: tasks.map((t) => ({ item: t.label, count: t.count })) }, actions };
    }
  },
  {
    name: "attendance_on_date",
    description: "HR/Admin: who was present / absent / on holiday on a date (default today). Optional date YYYY-MM-DD.",
    params: { date: { type: "string", description: "YYYY-MM-DD; omit for today." } },
    available: (c) => hasMod(c, "attendance_reports"),
    run: async (c, args) => {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.date || "")) ? String(args.date) : c.today;
      const r = await callApi(c.req, `/api/attendance/report/daily?date=${date}`);
      if (!r.ok) return fail(r.status);
      const b = r.body || {};
      const present: any[] = b.present || [], absent: any[] = b.absent || [], off: any[] = b.on_holiday || [];
      const names = (a: any[]) => a.slice(0, 8).map((x) => x.user_name).join(", ") + (a.length > 8 ? ` …আরও ${bn(a.length - 8)} জন` : "");
      const text = `${bnDate(date)}${b.holiday_title ? ` (${b.holiday_title})` : ""}:\n• উপস্থিত: **${bn(present.length)} জন**\n• অনুপস্থিত: **${bn(absent.length)} জন**${absent.length ? ` — ${names(absent)}` : ""}${off.length ? `\n• ছুটিতে: ${bn(off.length)} জন` : ""}\n• মোট: ${bn(b.total_users ?? present.length + absent.length + off.length)} জন`;
      return { ok: true, text, data: { date, present: present.length, absent: absent.length, on_holiday: off.length, absent_names: absent.slice(0, 30).map((x) => x.user_name), holiday: b.holiday_title || null }, actions: [{ label: "Monthly Attendance Report খুলুন", nav: "admin:attendance_reports" }] };
    }
  },
  {
    name: "onboarding_overview",
    description: "HR: employees in onboarding — how many complete / in progress / not started / overdue, and which checklist items are pending for whom.",
    available: (c) => hasMod(c, "hr_operations"),
    run: async (c) => {
      const r = await callApi(c.req, "/api/hr-ops/onboarding");
      if (!r.ok) return fail(r.status);
      const list: any[] = Array.isArray(r.body) ? r.body : [];
      const complete = list.filter((j) => j.started && j.total > 0 && j.done >= j.total);
      const notStarted = list.filter((j) => !j.started || !j.total);
      const inProg = list.filter((j) => j.started && j.total > 0 && j.done < j.total);
      const overdue = list.filter((j) => Number(j.overdue) > 0);
      const byTask = new Map<string, string[]>();
      for (const j of inProg) for (const p of j.pending || []) byTask.set(p.label, [...(byTask.get(p.label) || []), j.name]);
      const top = [...byTask.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 6);
      const text = `Onboarding-এ মোট **${bn(list.length)} জন**: সম্পূর্ণ ${bn(complete.length)}, চলছে ${bn(inProg.length)}, শুরু হয়নি ${bn(notStarted.length)}${overdue.length ? `, সময় পেরোনো কাজ আছে ${bn(overdue.length)} জনের` : ""}।` +
        (top.length ? "\nযা সবচেয়ে বেশি বাকি:\n" + top.map(([label, who]) => `• ${label}: ${bn(who.length)} জন (${who.slice(0, 3).join(", ")}${who.length > 3 ? "…" : ""})`).join("\n") : "");
      return { ok: true, text, data: { total: list.length, complete: complete.length, in_progress: inProg.length, not_started: notStarted.length, with_overdue: overdue.length, people: list.slice(0, 40).map((j) => ({ name: j.name, done: j.done, total: j.total, overdue: j.overdue, pending: (j.pending || []).map((p: any) => p.label) })) }, actions: [{ label: "Onboarding খুলুন", nav: "hrops:onboarding" }] };
    }
  },
  {
    name: "headcount",
    description: "HR: total active headcount and by department, open positions, pending exits, open grievances.",
    available: (c) => hasMod(c, "hr_analytics"),
    run: async (c) => {
      const r = await callApi(c.req, "/api/hr-analytics/summary");
      if (!r.ok) return fail(r.status);
      const b = r.body || {};
      const deps: any[] = (b.headcount_by_department || []).slice(0, 8);
      const text = `মোট কর্মী: **${bn(b.headcount_total ?? 0)} জন**\n` + deps.map((d) => `• ${d.department}: ${bn(d.count)}`).join("\n") +
        `\nখোলা পদ: ${bn(b.open_positions ?? 0)} · Exit চলছে: ${bn(b.pending_exits ?? 0)} · খোলা অভিযোগ: ${bn(b.open_grievances ?? 0)}`;
      return { ok: true, text, data: { total: b.headcount_total, by_department: deps, open_positions: b.open_positions, pending_exits: b.pending_exits, open_grievances: b.open_grievances }, actions: [{ label: "HR Analytics খুলুন", nav: "admin:hr_analytics" }] };
    }
  },
  {
    name: "app_help",
    description: "How to do something in the CredenceHR app (apply leave, claim a bill, request an asset, change password, add employee, run payroll…). Returns the steps and the page to open.",
    params: { topic: { type: "string", description: "What the user wants to do, in their words." } },
    run: async (c, args) => {
      const hits = matchHelp(c, String(args?.topic || ""), 3);
      const blocked = hits.length ? [] : matchHelp(c, String(args?.topic || ""), 1, true);
      if (blocked.length) return { ok: false, text: `"${blocked[0].title}" আপনার account-এ চালু নেই। দরকার হলে HR / Superadmin-কে বলুন।`, data: { error: "no_access", page: blocked[0].title } };
      if (!hits.length) return { ok: true, text: "এ বিষয়ে আমার কাছে নির্দিষ্ট নির্দেশনা নেই।", data: { topics: HELP.filter((h) => !h.can || h.can(c)).map((h) => h.title) } };
      return { ok: true, text: hits.map((h) => `**${h.title}:** ${h.steps}`).join("\n\n"), data: { steps: hits.map((h) => ({ title: h.title, steps: h.steps })) }, actions: hits.flatMap(helpAction) };
    }
  }
];

const toolAvailable = (t: Tool, c: Ctx) => !t.available || t.available(c);

// ---------------------------------------------------------------------------
// Local engine
// ---------------------------------------------------------------------------
const norm = (s: string) => ` ${String(s || "").toLowerCase().replace(/[?!.,।]+/g, " ").replace(/\s+/g, " ").trim()} `;
const hasAny = (t: string, keys: string[]) => keys.some((k) => t.includes(k));

// blocked = true finds only the pages this account can NOT open (to say so).
function matchHelp(c: Ctx, text: string, limit: number, blocked = false): HelpEntry[] {
  const t = norm(text);
  return HELP.filter((h) => (!h.can || h.can(c)) !== blocked)
    .map((h) => ({ h, score: h.keys.reduce((s, k) => s + (t.includes(k) ? k.length : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.h);
}

const HOW = ["kivabe", "kibhabe", "kivabe", "kemne", "kothay", "kotha", "কিভাবে", "কীভাবে", "কেমনে", "কোথায়", "how ", "where ", "how do", "how to", "নিয়ম", "niyom", "process", "প্রক্রিয়া", "দিতে চাই", "করতে চাই", "korte chai", "dite chai"];

interface Intent { tool: string; keys: string[]; args?: (t: string, c: Ctx) => any }

const LAST_MONTH = ["last month", "gotomash", "goto mash", "goto mas", "গত মাস", "আগের মাস", "previous month"];

const INTENTS: Intent[] = [
  { tool: "my_leave_balance", keys: ["leave balance", "balance", "ব্যালেন্স", "chuti koto", "chuti baki", "koto chuti", "ছুটি কত", "কত ছুটি", "ছুটি বাকি", "বাকি ছুটি", "leave baki", "leave koto", "leave left", "how many leave", "কয় দিন ছুটি", "koydin chuti"] },
  { tool: "my_leave_applications", keys: ["leave status", "amar leave", "আমার ছুটির আবেদন", "আবেদনের অবস্থা", "application status", "approve hoyeche", "অনুমোদন হয়েছে", "approved hoise", "leave ki holo", "ছুটির কী হল", "ছুটির কি হলো", "my leave", "leave application"] },
  { tool: "my_late_days", keys: ["kon din late", "কোন দিন দেরি", "কোন কোন দিন", "late days", "which days late", "late er din", "দেরির দিন", "কবে দেরি", "kobe late"],
    args: (t, c) => (hasAny(t, LAST_MONTH) ? (() => { const ym = monthShift(c.today.slice(0, 7), -1); const [y, m] = ym.split("-").map(Number); return { from: `${ym}-01`, to: `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}` }; })() : {}) },
  { tool: "my_attendance_summary", keys: ["attendance", "হাজিরা", "hajira", "present", "উপস্থিত", "absent", "অনুপস্থিত", "late", "দেরি", "লেট", "deri", "এটেন্ডেন্স", "অ্যাটেনডেন্স"],
    args: (t, c) => (hasAny(t, LAST_MONTH) ? { month_year: monthShift(c.today.slice(0, 7), -1) } : {}) },
  { tool: "my_claims", keys: ["claim", "ক্লেইম", "ক্লেম", "bill", "বিল", "conveyance", "কনভেয়েন্স", "movement", "মুভমেন্ট"] },
  { tool: "my_loans", keys: ["loan", "লোন", "ঋণ", "advance", "অ্যাডভান্স", "অগ্রিম", "কিস্তি", "kisti", "installment"] },
  { tool: "my_tasks", keys: ["task", "টাস্ক", "amar kaj", "আমার কাজ", "কাজ বাকি", "kaj baki"] },
  { tool: "upcoming_holidays", keys: ["holiday", "হলিডে", "ছুটির দিন", "সরকারি ছুটি", "next chuti", "porer chuti", "পরের ছুটি", "সামনের ছুটি", "eid", "ঈদ", "পূজা", "puja"] },
  { tool: "admin_pending_work", keys: ["pending", "পেন্ডিং", "অপেক্ষ", "বাকি কাজ", "কী বাকি", "ki baki", "to do", "todo", "approval baki"] },
  { tool: "attendance_on_date", keys: ["ke ke absent", "কে কে অনুপস্থিত", "কতজন অনুপস্থিত", "kotojon absent", "koto jon absent", "কতজন উপস্থিত", "koto jon present", "kotojon present", "today attendance", "আজকের হাজিরা", "ajker attendance", "who is absent", "who absent", "সবার হাজিরা", "কে আসেনি", "ke asheni", "ke ase nai"],
    args: (t, c) => {
      const d = /(\d{4}-\d{2}-\d{2})/.exec(t)?.[1];
      if (d) return { date: d };
      if (hasAny(t, ["gotokal", "গতকাল", "yesterday", "kalke", "কালকে"])) {
        const y = new Date(Date.parse(c.today + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
        return { date: y };
      }
      return {};
    } },
  { tool: "onboarding_overview", keys: ["onboarding", "অনবোর্ডিং", "joiner", "নতুন যোগদান", "id card", "আইডি কার্ড", "business card", "বিজনেস কার্ড"] },
  { tool: "headcount", keys: ["headcount", "হেডকাউন্ট", "মোট কর্মী", "কতজন কর্মী", "koto jon employee", "kotojon employee", "total employee", "how many employee", "কর্মী সংখ্যা"] }
];

const GREET = ["hi", "hello", "hey", "salam", "assalam", "হাই", "হ্যালো", "সালাম", "আসসালাম", "kemon acho", "কেমন আছ", "good morning", "শুভ সকাল"];
const THANKS = ["thanks", "thank you", "ধন্যবাদ", "dhonnobad", "thx", "অনেক ধন্যবাদ"];

function suggestionsFor(c: Ctx): string[] {
  const s = ["আমার ছুটি কত বাকি?", "এই মাসে কয়দিন দেরি করেছি?", ...(canNav(c, "self:leaveApplication") ? ["ছুটির আবেদন কীভাবে করব?"] : ["Password কীভাবে বদলাব?"]), "সামনের ছুটির দিন কবে?"];
  if (isSuper(c) || c.role === "admin" || c.modules.includes("admin_dashboard")) s.unshift("কী কী অপেক্ষায় আছে?");
  if (hasMod(c, "attendance_reports")) s.unshift("আজ কে কে অনুপস্থিত?");
  if (hasMod(c, "hr_operations")) s.push("Onboarding-এ কার কী বাকি?");
  return s.slice(0, 6);
}

async function localAnswer(c: Ctx, message: string): Promise<{ reply: string; actions: AssistantAction[] }> {
  const t = norm(message);
  const asksHow = hasAny(t, HOW);

  // "find X" / "X-এর নম্বর"
  const find = /(?:find|search|khujo|khuje dao|খুঁজ\S*)\s+(.{2,40})/.exec(t)?.[1] ||
    /\s(.{2,30}?)\s*(?:er|এর|-এর|'s)\s*(?:number|nombor|নম্বর|নাম্বার|phone|ফোন|mobile|মোবাইল|email|ইমেইল|designation|পদবি)/.exec(t)?.[1];
  if (find && !asksHow) {
    const r = await TOOLS.find((x) => x.name === "find_colleague")!.run(c, { query: find.replace(/\s+(er|এর|ke|কে)$/, "").trim() });
    return { reply: r.text, actions: r.actions || [] };
  }

  // Data questions win unless the person is asking HOW to do something. The
  // best match is taken even when this account can't use it, so the answer
  // is "no access" rather than some other, weaker match.
  const scored = INTENTS
    .map((i) => ({ i, score: i.keys.reduce((s, k) => s + (t.includes(k) ? k.length : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const help = matchHelp(c, message, 2);
  const blockedHelp = help.length ? [] : matchHelp(c, message, 1, true);

  if (scored.length && !(asksHow && (help.length || blockedHelp.length))) {
    const intent = scored[0].i;
    const tool = TOOLS.find((x) => x.name === intent.tool)!;
    if (!toolAvailable(tool, c)) return { reply: NO_ACCESS.text, actions: [] };
    const r = await tool.run(c, intent.args ? intent.args(t, c) : {});
    return { reply: r.text, actions: allowedActions(c, r.actions || []) };
  }
  if (help.length) {
    return { reply: help.map((h) => `**${h.title}:** ${h.steps}`).join("\n\n"), actions: help.flatMap(helpAction) };
  }
  if (blockedHelp.length) {
    return { reply: `"${blockedHelp[0].title}" আপনার account-এ চালু নেই। দরকার হলে HR / Superadmin-কে বলুন — তাঁরা Module Access থেকে চালু করে দিতে পারবেন।`, actions: [] };
  }
  if (hasAny(t, THANKS)) return { reply: "আপনাকেও ধন্যবাদ! আর কিছু লাগলে জিজ্ঞেস করুন। 🙂", actions: [] };
  if (hasAny(t, GREET)) {
    return { reply: `আসসালামু আলাইকুম, ${c.name.split(" ")[0]}! আমি Credence Assistant। আপনার ছুটি, হাজিরা, claim, loan বা app-এর কোন কাজ কোথায় — জিজ্ঞেস করুন।`, actions: [] };
  }
  return {
    reply: "দুঃখিত, প্রশ্নটা বুঝতে পারিনি। এভাবে জিজ্ঞেস করে দেখুন:\n" + suggestionsFor(c).map((s) => `• ${s}`).join("\n"),
    actions: []
  };
}

// ---------------------------------------------------------------------------
// Gemini engine (optional)
// ---------------------------------------------------------------------------
// GEMINI_MODEL may list several models, comma-separated: each call tries them
// in order and moves on when one is busy (503), gone (404), rate-limited
// (429) or too slow. The one that last worked is tried first next time.
const GEMINI_MODELS = (process.env.GEMINI_MODEL || "gemini-flash-lite-latest,gemini-flash-latest,gemini-3.8-flash")
  .split(",").map((m) => m.trim()).filter(Boolean);
const GEMINI_CALL_TIMEOUT_MS = 20000;
let preferredModel = 0;
let gemini: GoogleGenAI | null = null;
const geminiClient = () => {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return null;
  if (!gemini) gemini = new GoogleGenAI({ apiKey: key });
  return gemini;
};

async function generateWithFallback(ai: GoogleGenAI, req: { contents: Content[]; config: Record<string, any> }) {
  let lastErr: any = null;
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const idx = (preferredModel + i) % GEMINI_MODELS.length;
    try {
      const resp = await ai.models.generateContent({
        model: GEMINI_MODELS[idx],
        contents: req.contents,
        config: { ...req.config, httpOptions: { timeout: GEMINI_CALL_TIMEOUT_MS } }
      });
      preferredModel = idx;
      return resp;
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || err);
      // A bad key or a malformed request won't get better on another model.
      if (/API_KEY|PERMISSION_DENIED|INVALID_ARGUMENT|\b40[013]\b/.test(msg) && !/\b(404|429|503)\b/.test(msg)) throw err;
      console.warn(`AI Assistant: ${GEMINI_MODELS[idx]} unavailable (${msg.slice(0, 120)}), trying the next model`);
    }
  }
  throw lastErr || new Error("no Gemini model available");
}

async function geminiAnswer(c: Ctx, history: { role: string; text: string }[], message: string): Promise<{ reply: string; actions: AssistantAction[] }> {
  const ai = geminiClient();
  if (!ai) throw new Error("no key");
  const tools = TOOLS.filter((t) => toolAvailable(t, c));
  const declarations: FunctionDeclaration[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: { type: "object", properties: t.params || {} }
  }));
  const system =
    `You are "Credence Assistant", the helper inside CredenceHR, an HR app used by Credence Housing Limited in Bangladesh.\n` +
    `Today is ${c.today}. You are talking to ${c.name} (role: ${c.role}).\n` +
    `Rules:\n` +
    `- Reply in the user's language; default to Bangla. Banglish questions get Bangla answers. Be short and friendly; use bullet lines for lists.\n` +
    `- For any fact about the user, colleagues, attendance, leave, claims, loans, tasks, holidays or HR figures, call a tool. Never guess or invent numbers, names or dates.\n` +
    `- If a tool returns error "no_access", say politely that their account doesn't have permission and they can ask HR / Superadmin.\n` +
    `- You can only read and guide. You cannot apply, approve, edit or delete anything — tell them which page to open (the app shows a button for it).\n` +
    `- For any "how do I… / where is…" question ALWAYS call app_help first and give only the steps it returns — never describe menus or buttons from your own knowledge. If it returns no_access, say that page isn't turned on for their account and HR / Superadmin can enable it.\n` +
    `- Write Bangla only in Bangla script (no Arabic, Hindi or other scripts mixed in); English words like page names may stay in English.\n` +
    `- Don't answer questions unrelated to work / this app beyond a brief polite line.`;
  const contents: Content[] = [
    ...history.slice(-10).map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.text || "").slice(0, 2000) }] })),
    { role: "user", parts: [{ text: message }] }
  ];
  const actions: AssistantAction[] = [];
  for (let round = 0; round < 4; round++) {
    const resp = await generateWithFallback(ai, {
      contents,
      config: { systemInstruction: system, tools: [{ functionDeclarations: declarations }], temperature: 0.2 }
    });
    const calls = resp.functionCalls || [];
    if (!calls.length) {
      const text = (resp.text || "").trim();
      if (!text) throw new Error("empty reply");
      return { reply: text, actions };
    }
    contents.push(resp.candidates?.[0]?.content || { role: "model", parts: calls.map((fc) => ({ functionCall: fc })) });
    const parts = [];
    for (const fc of calls) {
      const tool = tools.find((t) => t.name === fc.name);
      const out = tool ? await tool.run(c, fc.args || {}) : { ok: false, text: "", data: { error: "unknown_tool" } };
      for (const a of out.actions || []) actions.push(a);
      parts.push({ functionResponse: { name: String(fc.name), response: { ok: out.ok, ...(out.data ?? {}), summary: out.text } } });
    }
    contents.push({ role: "user", parts });
  }
  throw new Error("too many tool rounds");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function registerAiAssistantRoutes(app: Express, deps: AiAssistantDeps) {
  const { authenticateToken, queryDB, getAdminModules, todayInDhaka } = deps;

  // Per-account switch (Module Access -> "AI Assistant"), ON by default.
  const loadCtx = async (req: any): Promise<Ctx | null> => {
    const u = req.user;
    if (!u || u.onb) return null;
    const rows: any[] = (await queryDB(`SELECT name, role, can_use_ai_assistant, ${SELF_FLAGS.join(", ")} FROM users WHERE id = ?`, [u.id]).catch(() => [])) || [];
    const row = rows[0];
    if (!row) return null;
    if (row.role !== "superadmin" && !Number(row.can_use_ai_assistant ?? 1)) return null;
    const flags: Record<string, boolean> = {};
    for (const f of SELF_FLAGS) flags[f] = !!Number(row[f] || 0);
    const modules = row.role === "superadmin" ? [] : await getAdminModules(u.id).catch(() => []);
    return { req, userId: u.id, name: String(row.name || ""), role: String(row.role || ""), modules, flags, today: todayInDhaka() };
  };

  const recent = new Map<number, number[]>();
  const limited = (userId: number) => {
    const now = Date.now();
    const list = (recent.get(userId) || []).filter((t) => now - t < 5 * 60_000);
    list.push(now);
    recent.set(userId, list);
    return list.length > 30;
  };

  app.get("/api/assistant/status", authenticateToken, async (req: any, res: any) => {
    const c = await loadCtx(req);
    if (!c) return res.status(403).json({ error: "AI Assistant isn't turned on for your account." });
    res.json({ enabled: true, engine: geminiClient() ? "gemini" : "local", suggestions: suggestionsFor(c) });
  });

  app.post("/api/assistant/chat", authenticateToken, async (req: any, res: any) => {
    const c = await loadCtx(req);
    if (!c) return res.status(403).json({ error: "AI Assistant isn't turned on for your account." });
    const message = String(req.body?.message || "").trim().slice(0, 1000);
    if (!message) return res.status(400).json({ error: "Message is required." });
    if (limited(c.userId)) return res.status(429).json({ error: "একটু বেশি প্রশ্ন হয়ে গেছে — কয়েক মিনিট পর আবার চেষ্টা করুন।" });
    const history = Array.isArray(req.body?.history) ? req.body.history.filter((m: any) => m && typeof m.text === "string") : [];
    let engine: "gemini" | "local" = "local";
    let out: { reply: string; actions: AssistantAction[] };
    try {
      if (geminiClient()) {
        out = await Promise.race([
          geminiAnswer(c, history, message),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 45000))
        ]);
        engine = "gemini";
      } else {
        out = await localAnswer(c, message);
      }
    } catch (err: any) {
      console.warn("AI Assistant: Gemini failed, using local answer:", err?.message || err);
      out = await localAnswer(c, message);
    }
    const seen = new Set<string>();
    const actions = allowedActions(c, out.actions).filter((a) => (seen.has(a.nav) ? false : (seen.add(a.nav), true))).slice(0, 3);
    res.json({ reply: out.reply, actions, engine });
  });
}
