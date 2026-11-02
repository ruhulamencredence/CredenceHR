// AI Assistant ("Credence Assistant") — a chat helper every account can open
// from the floating button (unless HR switches it off for them in Module
// Access: users.can_use_ai_assistant).
//
// It answers three kinds of question:
//   1. the account's own data — leave balance, leave applications, this
//      month's attendance / late days, claims, loans, tasks, holidays;
//   2. how to use the app — where a page is, with a button that opens it;
//   3. HR/Admin figures — today's attendance, pending work, onboarding,
//      headcount, length of service (who has completed N years), finding a
//      colleague.
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
//     error, and when its quota is used up it is left alone for a while
//     (pauseGemini) so local answers straight away. Note: in this mode the
//     question and the tool results are sent to Google.
//   The local engine also learns from Gemini (assistant_learned) and has
//   built-in example questions (TRAINING), corrects misspellings and reads a
//   short follow-up with the previous question — see "Learning" below.

import type { Express } from "express";
import { GoogleGenAI, type Content, type FunctionDeclaration } from "@google/genai";
import { salaryPeriodFor } from "./PayrollRoutes";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

interface AiAssistantDeps {
  authenticateToken: any;
  queryDB: QueryDB;
  getAdminModules: (userId: number) => Promise<string[]>;
  todayInDhaka: () => string;
  // The server's own layer check (requireModuleLayer's rule) — used where
  // a report's page checks a layer its API doesn't, so the Assistant shows
  // only what the page would.
  hasModuleLayer: (user: any, moduleKey: string, layer: string) => Promise<boolean>;
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
  canExport: boolean; // users.can_export_assistant_reports (Superadmin always)
  // Payroll -> Salary month setting (salary_month_settings): from which
  // salary month which start day applies. Attendance questions about "this
  // month" / "salary month" use the salary month's dates, not the calendar's.
  salaryStarts: { start_day: number; effective_month: string }[];
  // The question said "salary month" (set by localAnswer, which rewrites
  // those words before matching).
  salaryAsked?: boolean;
}

interface ToolResult {
  ok: boolean;
  text: string; // ready-made Bangla answer (local engine)
  data?: any; // compact facts (Gemini engine)
  actions?: AssistantAction[];
  draft?: AssistantDraft;
  report?: AssistantReport;
}

// A form the Assistant filled in but did NOT submit — the chat shows it as an
// editable card and only the person's own button posts it, to the same API
// (with all its checks) the page itself uses.
export type AssistantDraft = LeaveDraft | RideDraft | CorrectionDraft | MovementDraft;

// Movement Claim -> a live GPS Check In (purpose) or Check Out of the open
// claim. The card takes the device's location when its button is pressed
// and posts to /api/claims/check-in or /api/claims/:id/check-out — both
// stamp "now", so nothing can be back-dated.
export interface MovementDraft {
  kind: "movement_claim";
  mode: "check_in" | "check_out";
  purpose: string;
  remarks: string;
  claim_id: number | null; // the open claim (check_out)
  since: string | null; // when it was checked in
}

// Book a Ride -> POST /api/vehicles/requisitions.
export interface RideDraft {
  kind: "ride_booking";
  purpose: string;
  pickup_location: string;
  destination: string;
  ride_date: string;
  start_time: string; // HH:MM
  estimated_duration_hours: number;
  self_drive: boolean;
  self_drive_note: string | null; // why self-drive is off for them, if it is
  today: string;
}

// Timesheet -> Correct Attendance -> POST /api/attendance/corrections.
export interface CorrectionDraft {
  kind: "attendance_correction";
  attendance_date: string;
  check_in: string; // HH:MM or ""
  check_out: string; // HH:MM or ""
  remarks: string;
  // The project(s) it can be filed under, with that day's times on record.
  options: { project_id: number; name: string; check_in: string; check_out: string }[];
  today: string;
}

// A leave application the Assistant filled in but did NOT submit: the chat
// shows it as an editable card, and only the person's own "জমা দিন" posts it
// to POST /api/leave-applications (with all of that route's own checks).
export interface LeaveDraft {
  kind: "leave_application";
  leave_type: string;
  start_date: string;
  end_date: string;
  is_half_day: boolean;
  purpose: string;
  today: string;
  types: { value: string; label: string; balance: number | null; reliever_required: boolean }[];
  relievers: { id: number; name: string }[];
}

// The full table behind a list answer, for the PDF / Excel buttons under it
// (users.can_export_assistant_reports). Plain English so the PDF's built-in
// font can print it; the chat text itself stays Bangla.
export interface AssistantReport {
  title: string;
  file: string; // file name without extension
  details?: [string, string][];
  columns: string[];
  rows: (string | number | null)[][];
}

interface Answer {
  reply: string;
  actions: AssistantAction[];
  draft?: AssistantDraft;
  report?: AssistantReport;
  // Gemini only: which tool / how-to entry answered, kept so the local engine
  // can answer the same question itself later (see "Learning" below).
  learn?: { tool?: string; help?: string; args?: Record<string, any> };
}

const SELF_FLAGS = [
  "can_view_movement_claims", "can_view_conveyance_claims", "can_view_timesheet", "can_view_leave_application",
  "can_view_my_leave", "can_view_tasks", "can_view_mobile_bill", "can_view_loan_request", "can_view_targets", "can_manage_leave", "can_view_service_book",
  "can_use_attendance"
] as const;

const BN_DIGITS = "০১২৩৪৫৬৭৮৯";
const bn = (v: any) => String(v ?? "").replace(/[0-9]/g, (d) => BN_DIGITS[Number(d)]);
const BN_MONTHS = ["জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন", "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর"];
const bnDate = (iso: any) => {
  const s = String(iso || "").slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${bn(Number(m[3]))} ${BN_MONTHS[Number(m[2]) - 1]} ${bn(m[1])}` : s;
};
// "2016-10-14" from a stored date, or null when it isn't one.
const ymd = (v: any) => {
  const s = String(v || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && s !== "0000-00-00" ? s : null;
};
const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const enDate = (v: any) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ""));
  return m ? `${m[3]} ${EN_MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(v || "");
};
const enTime = (v: any) => /(\d{2}:\d{2})/.exec(String(v || ""))?.[1] || "";
// A numbered table (SL first).
const report = (title: string, file: string, columns: string[], rows: (string | number | null)[][], details?: [string, string][]): AssistantReport => ({
  title,
  file: file.replace(/[^A-Za-z0-9_-]+/g, "-"),
  columns: ["SL", ...columns],
  rows: rows.map((r, i) => [i + 1, ...r]),
  details
});
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

// The asker's login has no Employee record, so there is nothing of "their
// own" (attendance, late days, loans…). Someone who manages Employees — a
// Superadmin above all — is told how to link it themselves; anyone else to
// ask HR.
const notLinked = (c: Ctx, what: string): ToolResult => {
  const self = hasMod(c, "employees");
  return {
    ok: true,
    text: self
      ? `আপনার login কোনো Employee record-এর সাথে যুক্ত নয়, তাই আপনার নিজের ${what} নেই। আপনি নিজেই যুক্ত করতে পারেন: Admin Panel → Employees → আপনার নামের সারিতে **Link Existing** (🔗) → এই login বাছুন (আপনার Employee record না থাকলে আগে "Add Employee")।`
      : `আপনার login এখনো কোনো Employee record-এর সাথে যুক্ত নয়, তাই আপনার নিজের ${what} দেখানো যাচ্ছে না। HR-কে বলুন আপনার Employee record-এ এই login যুক্ত করে দিতে।`,
    data: { linked: false, can_link_self: self },
    actions: self ? [{ label: "Employees খুলুন", nav: "admin:employees" }] : []
  };
};
// Same people who see the Admin (HR) Dashboard — AdminDashboardRoutes.ts gate.
const canDash = (c: Ctx) => isSuper(c) || c.role === "admin" || c.modules.includes("admin_dashboard");

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
  { id: "leave_apply", title: "ছুটির আবেদন", keys: ["leave apply", "apply leave", "chuti apply", "ছুটি apply", "ছুটির আবেদন কীভাবে", "chutir abedon", "leave application kivabe", "chuti nibo", "chuti nite", "leave nibo", "ছুটি নেব", "ছুটি নিতে", "ছুটির আবেদন", "leave application", "ছুটি চাই", "chuti chai"],
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
  { id: "targets", title: "My Targets", keys: ["target", "টার্গেট", "লক্ষ্য", "lokkho", "monthly target", "yearly target"],
    steps: "মেনু → Work & Approvals → **My Targets**। মাসিক / বার্ষিক target আর তার task দেখা যায়; প্রতিটা task-এ **Update** চেপে % অগ্রগতি, status আর details দিন। Share হওয়া target edit / delete করা যায় না। Supervisor হলে **Team** ট্যাব থেকে team-কে target দিন আর approve করুন।", nav: "self:myTargets", can: (c) => isSuper(c) || c.flags.can_view_targets },
  { id: "target_give", title: "Team / Department-কে target দেওয়া (Supervisor)",
    keys: ["target dibo", "target dite", "target deya", "target set", "set target", "give target", "give a target", "target kivabe", "team target", "team ke target", "department task", "department target set", "department er task",
      "ডিপার্টমেন্ট টাস্ক", "ডিপার্টমেন্টের কাজ", "টার্গেট দেব", "টার্গেট দিতে", "টার্গেট সেট", "লক্ষ্য দেওয়া", "লক্ষ্য দিতে", "supervisor target", "কর্মীকে target", "task set", "টাস্ক সেট", "whole team",
      "টার্গেট কীভাবে দ", "টার্গেট কিভাবে দ", "টার্গেট কেমনে দ", "target kivabe d", "target kemne d", "target ki kore d", "how to give target", "how to set target"],
    steps:
      "১. মেনু → Work & Approvals → **My Targets** খুলুন → উপরে **Team** ট্যাব (শুধু supervisor-রা দেখেন)।\n" +
      "২. **\"Give a target\"** চাপুন → কাকে দেবেন বাছুন — এক-একজনকে টিক দিন, বা **\"Whole team\"** চাপলে department-এর সবাই একসাথে।\n" +
      "৩. **Monthly / Yearly** আর কোন মাস/বছর, **Deadline** আর target-এর নাম দিন।\n" +
      "৪. **Task** যোগ করুন — প্রতিটার নাম, বিবরণ, শেষ তারিখ আর গুরুত্ব (weight); মোট % এই গুরুত্ব ধরে হিসাব হয়।\n" +
      "৫. **Save draft** (শুধু আপনি দেখবেন, পরে বদলানো যায়) অথবা **Share** — Share করলে কর্মী notification পান। Share-এর পর edit / delete করা যায় না, শুধু task-এর অগ্রগতি, status আর details আপডেট হয়।\n" +
      "কর্মী আর supervisor দুজনেই অগ্রগতি দিতে পারেন; কর্মী নিজে target Share করলে Team ট্যাবে আপনার **Approve / Reject**-এর জন্য আসে। ভুল হলে কারণ লিখে **Cancel** করে **\"Copy as new\"** দিয়ে আবার দিন। Deadline-এর ৩ দিন আগে, শেষ দিনে আর পেরোলে রিমাইন্ডার যায়।\n" +
      "Team ট্যাব না দেখালে: Admin Panel → Departments-এ আপনাকে সেই department-এর **Supervisor** বানাতে হবে (বা কর্মীর Supervisor হিসেবে আপনাকে দিতে হবে)।",
    nav: "self:myTargets", can: (c) => isSuper(c) || c.flags.can_view_targets },
  { id: "target_setup", title: "Target চালু করা — Supervisor ও access (HR / Admin)",
    keys: ["department supervisor", "supervisor set", "supervisor kivabe", "supervisor ke", "supervisor বানা", "সুপারভাইজার সেট", "সুপারভাইজার কে", "target access", "my targets access", "target chalu", "টার্গেট চালু", "target on", "allow my targets"],
    steps:
      "১. **Supervisor ঠিক করুন:** Admin Panel → **Departments** → department খুলে **Supervisor** বেছে Save। (কোনো কর্মীর ব্যক্তিগত supervisor: Employees → কর্মী → Supervisor।)\n" +
      "২. **My Targets চালু করুন:** Admin Panel → Users → account → **Module Access** → **\"Also allow My Targets\"** — supervisor আর যাঁরা target পাবেন সেই কর্মী দুজনের জন্যই।\n" +
      "৩. পুরো কোম্পানির হিসাব: Module Access-এ **Target Reports** দিন; Excel/PDF আর অন্যের target Cancel করার জন্য আলাদা টিক (\"Targets — Excel / PDF\", \"Targets — Cancel / Close\")।",
    nav: "admin:departments", can: (c) => isSuper(c) || c.modules.includes("departments") || c.modules.includes("users") },
  { id: "target_reports", title: "Target Reports", keys: ["target report", "টার্গেট রিপোর্ট", "target status", "department target"],
    steps: "মেনু → HR Operations → Reports → **Target Reports**। বছর, মাস, department, employee আর status দিয়ে filter করুন; By department / By employee / Targets দেখুন।", nav: "admin:target_reports", can: (c) => isSuper(c) || c.modules.includes("target_reports") },
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
    steps: "উপরের বারে Chat আইকন (💬) চাপুন। কাউকে খুঁজে মেসেজ পাঠান; Calls চালু থাকলে অডিও/ভিডিও কলও করা যায়।",
    can: (c) => isSuper(c) || c.flags.can_use_chat },
  { id: "payslip", title: "বেতন / Payslip", keys: ["payslip", "পে স্লিপ", "salary slip", "বেতন", "salary", "স্যালারি"],
    steps: "বেতনের হিসাব Payroll বিভাগ তৈরি করে। Payslip বা বেতন-সংক্রান্ত প্রশ্নে HR/Accounts-এ যোগাযোগ করুন। Salary certificate লাগলে My Letters থেকে চাইতে পারেন।", nav: "self:myLetters" },
  // HR / Admin pages
  { id: "add_employee", title: "নতুন Employee যোগ", keys: ["add employee", "new employee", "নতুন কর্মী", "নতুন employee", "notun employee", "employee add", "employee jog", "কর্মী যোগ"],
    steps: "Admin Panel → Employee Management → **Employees** → \"Add Employee\"। অনেকজন একসাথে হলে HR Data Import ব্যবহার করুন।\nনতুন কাউকে চাকরিতে নিলে পুরো পথ: **Recruitment (ATS)** → New Posting → Add Candidate → Interview → Offered → Hired → **\"Start onboarding\"** → joiner নিজের তথ্য জমা দেন → HR Operations → Onboarding-এ **Approve** করলে Employee record আর Employee ID আপনা থেকে তৈরি হয়, তারপর Appointment Letter।", nav: "admin:employees", can: (c) => hasMod(c, "employees") },
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
  { id: "leave_manage", title: "ছুটির ব্যালেন্স সেট / বদলানো (Leave Manage)",
    keys: ["leave manage", "লিভ ম্যানেজ", "leave balance set", "set leave balance", "balance set", "set balance", "ব্যালেন্স সেট", "ছুটির ব্যালেন্স সেট", "balance edit", "edit balance", "ব্যালেন্স বদল", "balance change",
      "balance bosabo", "balance bosano", "ব্যালেন্স বসা", "bulk balance", "set balance in bulk", "leave category", "ছুটির ধরন যোগ", "add category", "earn leave", "আর্ন লিভ", "leave policy", "ছুটির নিয়ম", "leave type add"],
    steps:
      "মেনু → Self Service → HRM → Leave Manage → **Leave Manage**। এখানে সব কর্মীর ছুটির ব্যালেন্স দেখা যায়।\n" +
      "• **একজনের ব্যালেন্স বদলাতে:** তালিকায় কর্মীর সারিতে Edit করে Casual / Sick / Leave without Pay আর অন্য ধরনের দিন বসিয়ে Save।\n" +
      "• **অনেকজনের একসাথে:** **\"Set Balance in Bulk\"** → সবাই, বা নির্দিষ্ট Department বাছুন → প্রতিটা ছুটির ধরনের দিন দিন → Apply।\n" +
      "• **নতুন ছুটির ধরন (যেমন Earn Leave):** Set Balance in Bulk-এর ভেতরে **\"Add Category\"**; তারপর তার **Leave Policy** (কতদিন, কারা পাবে) ঠিক করুন।\n" +
      "• প্রতি বছর আপনা থেকে নতুন ব্যালেন্স বসাতে চাইলে নিচের \"Leave Year ও Balance Workflow\" দেখুন।",
    nav: "self:leaveManagement", can: (c) => isSuper(c) || c.flags.can_manage_leave },
  { id: "leave_year", title: "Leave Year ও Balance Workflow (বছর শেষে ব্যালেন্স)",
    keys: ["year settings", "leave year", "লিভ ইয়ার", "ছুটির বছর", "balance workflow", "designation wise leave", "পদবি অনুযায়ী ছুটি", "notun bochor", "notun bochorer", "new year leave", "নতুন বছর", "automatic balance", "auto balance", "balance automatic", "আপনা থেকে ব্যালেন্স", "yearly balance", "barshik chuti", "leave workflow", "নতুন বছরের ব্যালেন্স", "year end leave", "বছর শেষে ছুটি", "leave reset", "ছুটি রিসেট"],
    steps:
      "Self Service → HRM → Leave Manage → **Leave Manage** পাতার নিচের অংশে:\n" +
      "• **Year Settings:** HR-এর ছুটির বছর কবে শেষ আর কবে শুরু (যেমন ১ জানুয়ারি – ৩১ ডিসেম্বর) ঠিক করুন; নতুন বছর শুরু হলে workflow আপনা থেকে চলে।\n" +
      "• **Leave Balance Workflows:** \"General\" সবার জন্য, আর দরকার হলে পদবি (Designation) অনুযায়ী আলাদা workflow (যেমন Manager, GM) — প্রতিটা ছুটির ধরনে বছরে কত দিন। পদবির workflow সেই পদবির কর্মীদের জন্য General-এর বদলে খাটে। **\"Apply Now\"** দিয়ে সাথে সাথে ব্যালেন্স বসানো যায়।",
    nav: "self:leaveManagement", can: (c) => isSuper(c) || c.flags.can_manage_leave },
  { id: "leave_rules", title: "ছুটির নিয়ম — মাসে জমা, পরের বছরে টানা, কে আবেদন করতে পারবে (মাতৃত্বকালীন সহ)",
    keys: ["leave accrual", "accrual", "earn leave", "earned leave", "আর্ন লিভ", "মাসে ছুটি জমা", "ছুটি জমা", "carry forward", "carry-forward", "পরের বছরে টানা", "ছুটি টানা", "maternity", "মাতৃত্বকালীন", "paternity", "পিতৃত্বকালীন", "leave eligibility", "মাতৃত্ব ছুটি", "matrittho", "leave rules", "ছুটির নিয়ম"],
    steps:
      "মেনু → Self Service → HRM → Leave Manage → **Leave Policies** → প্রতিটা ছুটির ধরনের নিচে **Leave Rules**:\n" +
      "• **কে আবেদন করতে পারবে:** Everyone / Female only / Male only, আর কত মাসের চাকরি লাগবে (joining date থেকে)। শর্ত না মিললে আবেদনই নেওয়া হয় না। **Maternity preset** বোতামে নারী + ৬ মাস বসে; একই কার্ডের **Max Consecutive Days**-এ সর্বোচ্চ দিন (১৬ সপ্তাহ = ১১২) দিন।\n" +
      "• **মাসে কত দিন জমা:** Days earned per month (যেমন ১.৭ ≈ ১৮ দিনে ১); **Balance cap** দিলে এর বেশি জমে না। প্রতিটা পূর্ণ মাসের জন্য একবার করে নিজে থেকে জমা হয় (যিনি মাসের আগে যোগ দিয়েছেন তিনি); চালু করার **পরের মাস** থেকে শুরু, পেছনের মাস পরিশোধ হয় না।\n" +
      "• **পরের বছরে টানা:** Carry forward-এ সর্বোচ্চ কত দিন যাবে; ০ দিলে সব বাতিল, ফাঁকা রাখলে এই নিয়ম নেই। বছর শেষের rollover-এ কাজ করে (Year Settings-এ \"Start next year automatically\" চালু থাকতে হবে)।\n" +
      "• এই অংশের জন্য Module Access-এর Leave Manage layer-এ **Leave Rules** টিক লাগে (শুরুতে বন্ধ)।",
    nav: "self:leaveManagement", can: (c) => isSuper(c) || c.flags.can_manage_leave },
  { id: "leave_manage_access", title: "কাউকে Leave Manage-এর অনুমতি দেওয়া",
    keys: ["leave manage access", "leave manage permission", "balance edit access", "ব্যালেন্স এডিটের অনুমতি", "leave balance access", "allow editing leave"],
    steps:
      "Admin Panel → Users → account → **Module Access** → **\"Also allow editing Leave balances\"** চালু করুন। তার নিচে কোন কোন কাজ করতে পারবেন টিক দিন: Edit Balance, Set Balance in Bulk, Add Category, Leave Policy, Year Settings, Balance Workflows।",
    nav: "admin:users", can: (c) => isSuper(c) || c.modules.includes("users") },
  // ---- Admin pages (each only for accounts that have that module) ----
  { id: "users_admin", title: "User / Login তৈরি ও Block", keys: ["add user", "new user", "create user", "user add", "user banabo", "login banabo", "login create", "নতুন user", "ইউজার তৈরি", "লগইন তৈরি", "bulk add users", "account block", "user block", "ব্লক", "unblock", "password reset", "পাসওয়ার্ড রিসেট"],
    steps: "মেনু → Settings & Administration → **Users**।\n• একজন: **\"Add User\"** → নাম, email/username, role (User / Admin), password → Create User। অনেকজন: **\"Bulk Add Users\"**।\n• কোন পাতা খুলবে: user-এর সারিতে **Module Access**।\n• বন্ধ করতে: **Block Account** (কারণ লিখে) — আর login করতে পারবেন না; Unblock দিয়ে খোলা যায়।\n• Employee-র login: Employees-এ কর্মীর সারি থেকেও Create Login করা যায়।",
    nav: "admin:users", can: (c) => hasMod(c, "users") },
  { id: "departments_admin", title: "Department যোগ ও Supervisor", keys: ["add department", "new department", "department add", "department banabo", "ডিপার্টমেন্ট যোগ", "নতুন ডিপার্টমেন্ট", "department supervisor set", "department edit"],
    steps: "মেনু → Employee Management → **Departments** → **\"Add Department\"** → নাম, **Supervisor**, আর দরকার হলে \"supervisor-এর অনুমোদন লাগবে\" টিক → Save। কর্মীকে department-এ বসাতে Employees-এ কর্মী Edit করুন।",
    nav: "admin:departments", can: (c) => hasMod(c, "departments") },
  { id: "projects_branches", title: "Project / Branch যোগ", keys: ["add project", "new project", "project add", "প্রজেক্ট যোগ", "add branch", "new branch", "branch add", "ব্রাঞ্চ যোগ", "site add", "project location"],
    steps: "মেনু → Settings & Administration → **Projects** → **\"New Project\"** (নাম, ঠিকানা, check-in-এর জন্য location/radius)। Branch: Settings & Administration → **Branches** → **\"New Branch\"**।",
    nav: "admin:projects", can: (c) => hasMod(c, "projects") || hasMod(c, "branches") },
  { id: "pepm_admin", title: "PEPM — MPR, Report, Import", keys: ["mpr no", "mpr nos", "এমপিআর", "pepm", "পিইপিএম", "budget report", "job recycle", "mpr edit log", "mpr no", "new mpr"],
    steps: "মেনু → **PEPM Management**:\n• **MPR Nos** → \"New MPR No\" দিয়ে নতুন MPR।\n• **Reports** → Job/Entry/Budget রিপোর্ট ও Budget Submission Status।\n• **Data Import** → Excel থেকে Job/Entry আনা।\n• **Job Recycle** → মুছে ফেলা Job ফেরত আনা; **MPR Edit Log** → কে কী বদলেছে।",
    nav: "admin:reports", can: (c) => ["reports", "mprs", "imports", "recycle", "editlog"].some((k) => hasMod(c, k)) },
  { id: "office_attendance_admin", title: "Office Attendance — ZKTeco Device", keys: ["office attendance", "অফিস হাজিরা", "zkteco", "zk device", "device add", "fingerprint", "ফিঙ্গারপ্রিন্ট", "punch machine", "unlinked pin", "device pin"],
    steps: "মেনু → Attendance & Leave → **Office Attendance** → **\"Manage Devices\"** → **\"Add Device\"** (IP/port)। কোন PIN কোন কর্মীর, মেলাতে **\"Unlinked PINs\"** → কর্মী বেছে link করুন। Punch আপনা থেকে নির্দিষ্ট সময়ে টেনে আনা হয়।",
    nav: "admin:office_attendance", can: (c) => hasMod(c, "office_attendance") },
  { id: "site_attendance_admin", title: "Site Attendance — টিম ও Supervisor", keys: ["site attendance", "সাইট হাজিরা", "site team", "muster team", "new team", "team banabo", "site supervisor"],
    steps: "মেনু → Attendance & Leave → **Site Attendance** → **\"New team\"** → নাম, Project, Supervisor (আর backup), টিমের কর্মী → Save। Supervisor প্রতিদিন My Panel → Team Attendance থেকে হাজিরা দেন; HR এখানে সব টিমের হিসাব আর Excel পান।",
    nav: "admin:office_attendance", can: (c) => hasMod(c, "office_attendance") },
  { id: "remote_attendance_admin", title: "Remote Attendance (মাঠের হাজিরা) অনুমোদন", keys: ["remote attendance", "রিমোট হাজিরা", "field attendance", "check in approve", "check-in approve"],
    steps: "মেনু → Attendance & Leave → **Remote Attendance**। মাঠ থেকে দেওয়া Check In/Out-এর location দেখে অনুমোদন দিন। Monthly Attendance Report-এ মাসের হিসাব।",
    nav: "admin:attendance", can: (c) => hasMod(c, "attendance") },
  { id: "tracking_admin", title: "Employee Tracking", keys: ["employee tracking", "ট্র্যাকিং", "kothay ache", "কোথায় আছে", "live location", "লাইভ লোকেশন", "stay report", "live follow"],
    steps: "মেনু → Employee Management → **Employee Tracking**। **Live** — এখন কে কোথায় (location পাঠাচ্ছেন যাঁরা); **Stay Report** — দিনে কোথায় কতক্ষণ ছিলেন; **Live Follow** — একজনকে চলতি অবস্থায় দেখা (আলাদা অনুমতি লাগে)। কর্মীর ফোনে tracking চালু থাকতে হয়।",
    nav: "admin:tracking", can: (c) => hasMod(c, "tracking") },
  { id: "claims_admin", title: "Claim অনুমোদন ও বিল পরিশোধ (HR / Accounts)", keys: ["claim approve", "bill approve", "bill disburse", "disbursement", "ডিসবার্সমেন্ট", "বিল পরিশোধ", "bill pay", "claim policy", "bill claim policy", "conveyance limit"],
    steps: "মেনু → Payroll & Claims:\n• **Movement Claims** / **Bill Claim** — কর্মীদের claim দেখা, অনুমোদন / ফেরত / বাতিল।\n• **Bill Disbursement** — অনুমোদিত বিল বেছে পরিশোধ (Disburse) আর payment voucher PDF।\n• **Bill Claim Policy** — ধরন অনুযায়ী সীমা আর কতদিন পর্যন্ত claim করা যাবে।",
    nav: "admin:conveyance", can: (c) => ["claims", "conveyance", "disbursement"].some((k) => hasMod(c, k)) },
  { id: "asset_admin", title: "Asset Management (HR / Store)", keys: ["asset management", "asset assign", "asset dibo", "asset return", "asset ferot", "অ্যাসেট দেওয়া", "asset inventory", "নতুন asset", "add asset", "asset claim"],
    steps: "মেনু → HR Operations → Facilities → **Asset Management**:\n• **Approvals** — কর্মীদের asset requisition অনুমোদন ও হাতে দেওয়া (Fulfill)।\n• **Claims** — কর্মী \"এটা আমার কাছে আছে\" দাবি করলে মিলিয়ে নিশ্চিত করা।\n• **Inventory** — asset যোগ, কাকে দেওয়া, ফেরত নেওয়া (Settings থেকে \"Show Inventory tab\" চালু থাকতে হয়)।",
    nav: "admin:asset_management", can: (c) => hasMod(c, "asset_management") },
  { id: "vehicle_admin", title: "Vehicle Management (গাড়ি ও চালক)", keys: ["vehicle management", "gari add", "গাড়ি যোগ", "driver assign", "চালক দেওয়া", "ride approve", "emergency ride", "vehicle inventory"],
    steps: "মেনু → HR Operations → Facilities → **Vehicle Management**:\n• **Requests** — ride অনুমোদন, গাড়ি ও চালক দেওয়া, সময় বাড়ানোর আবেদন (Approve Extension)।\n• **Emergency** — HR সরাসরি ride দিতে পারে।\n• **Inventory** — গাড়ি যোগ (\"Add\")।",
    nav: "admin:vehicle_management", can: (c) => hasMod(c, "vehicle_management") },
  { id: "mobile_bill_admin", title: "Mobile Bill — SIM ও বিল (HR)", keys: ["give a sim", "sim dibo", "সিম দেওয়া", "sim add", "import bill", "bill import", "বিল ইমপোর্ট", "mobile limit set", "limit policy", "payment sheet"],
    steps: "মেনু → HR Operations → Facilities → **Mobile Bill**:\n• **\"Give a SIM\"** — নম্বর, অপারেটর, কর্মী, limit (policy অনুযায়ী বা নিজের মতো)।\n• **\"Add limit\"** — পদবি/ধরন অনুযায়ী limit policy।\n• **\"Import bill\"** — অপারেটরের Excel (\"Download template\" দেখে)। limit-এর বেশি হলে কর্মীর বেতন থেকে কাটা যায়।\n• **\"Payment sheet PDF\"** — মাসের পরিশোধ।",
    nav: "admin:mobile_bill", can: (c) => hasMod(c, "mobile_bill") },
  { id: "exit_admin", title: "Exit / Offboarding (HR)", keys: ["exit request", "new exit", "exit add", "offboarding kivabe", "clearance start", "start clearance", "settlement", "সেটেলমেন্ট", "final settlement", "mark paid", "clearance department", "experience certificate", "release letter"],
    steps: "মেনু → Employee Management → **Exit / Offboarding**:\n১. **\"New Exit Request\"** (কর্মী resignation দিলে নিজেও আসে) → কর্মী, ধরন, notice ও শেষ কর্মদিবস।\n২. **\"Start Clearance\"** → প্রতিটা department-এর clearance তার approver-এর কাছে যায় (কোন department, ঠিক করতে **\"Clearance Departments\"**)।\n৩. Settlement (Gratuity, ছুটির টাকা, কাটা loan) তৈরি → সব clearance আর বকেয়া শেষ হলে **\"Mark Paid & Settle\"**।\n৪. Clearance Certificate / Settlement Sheet PDF, আর HR Operations → Letters থেকে Release / Experience Letter।",
    nav: "admin:exit_offboarding", can: (c) => hasMod(c, "exit_offboarding") },
  { id: "recruitment_admin", title: "Recruitment — পদ, প্রার্থী, Interview", keys: ["new posting", "job posting", "চাকরির বিজ্ঞাপন", "add candidate", "প্রার্থী যোগ", "interview schedule", "interview time", "ইন্টারভিউ সময়", "hire", "start onboarding", "recruitment kivabe", "chakrite neya", "chakrite nite", "চাকরিতে নেওয়া", "নিয়োগ", "niyog", "hiring process", "notun lok neya", "নতুন লোক নেওয়া", "posting theke onboarding", "hiring", "new hire", "job post", "recruit", "candidate add", "posting to onboarding"],
    steps: "মেনু → Employee Management → **Recruitment (ATS)**:\n১. **\"New Posting\"** → পদ, department, পদবি, কতজন।\n২. Posting খুলে **\"Add Candidate\"**।\n৩. Status বদলান: Applied → Shortlisted → Interview scheduled (তখন **Interview-এর তারিখ ও সময়** দিন) → Interviewed → Offered → Hired।\n৪. Hired হলে **\"Start onboarding\"** — joiner-এর login তৈরি হয়, Onboarding-এ যায়।",
    nav: "admin:recruitment", can: (c) => hasMod(c, "recruitment") },
  { id: "performance_admin", title: "Performance Management (Appraisal)", keys: ["performance", "পারফরম্যান্স", "appraisal", "অ্যাপ্রাইজাল", "kpi", "new cycle", "review cycle", "goal set"],
    steps: "মেনু → Employee Management → **Performance Management** → **\"New Cycle\"** (সময়কাল) → কর্মীর **\"Add Goal\"** (KPI) → সময় হলে **\"Start Review\"** → নম্বর ও মন্তব্য দিয়ে **Submit**।",
    nav: "admin:performance_management", can: (c) => hasMod(c, "performance_management") },
  { id: "grievance_admin", title: "Grievance ও Disciplinary (HR)", keys: ["grievance handle", "অভিযোগ দেখা", "investigation", "disciplinary action", "শোকজ দেওয়া", "show cause dibo", "show cause", "শোকজ", "warning letter", "issue action"],
    steps: "মেনু → Employee Management → **Grievance & Disciplinary**:\n• **Grievances** — অভিযোগ খুলে দায়িত্ব দিন → **\"Start Investigating\"** → সমাধান লিখে বন্ধ করুন।\n• **Disciplinary Actions** — **\"Issue Action\"** (সতর্কতা, শোকজ, suspension…) — কর্মী নিজের পাতায় দেখেন ও উত্তর দেন।",
    nav: "admin:grievance_disciplinary", can: (c) => hasMod(c, "grievance_disciplinary") },
  { id: "document_vault_admin", title: "Document Vault", keys: ["document vault", "ডকুমেন্ট ভল্ট", "upload document", "document upload", "নথি আপলোড", "nid upload", "document expiry"],
    steps: "মেনু → Employee Management → **Document Vault** → **\"Upload Document\"** → কর্মী, ধরন (NID, সার্টিফিকেট…), মেয়াদ থাকলে তারিখ। মেয়াদ শেষ হওয়ার আগে Dashboard-এ সতর্কতা আসে।",
    nav: "admin:document_vault", can: (c) => hasMod(c, "document_vault") },
  { id: "hr_actions", title: "Promotion / Transfer / Increment / Confirmation (Personnel Action)", keys: ["promotion", "পদোন্নতি", "transfer", "বদলি", "confirmation dibo", "confirm korbo", "personnel action", "new hr action", "salary increase", "designation change", "পদবি বদল", "suspension"],
    steps: "মেনু → HR Operations → Employee records → **Personnel Actions** → **\"New HR Action\"** → কর্মী, ধরন (Promotion, Transfer, Increment, Confirmation, Probation extension, Separation…), নতুন মান আর কার্যকর তারিখ → Submit। Approval chain শেষ হলে কার্যকর তারিখে আপনা থেকে Employee record বদলায়; চিঠি Letters থেকে Issue করুন।",
    nav: "hrops:actions", can: (c) => hasMod(c, "hr_operations") },
  { id: "increments_admin", title: "Increment নিয়ম", keys: ["increment rule", "increment policy", "ইনক্রিমেন্ট", "বার্ষিক ইনক্রিমেন্ট", "increment due", "annual increment"],
    steps: "মেনু → HR Operations → Employee records → **Increments** → **\"Create Increment Rule\"** (কত % / কত টাকা, কোন মাসে, কারা)। যাঁদের increment-এর সময় হয়েছে তাঁদের তালিকা এখানে; প্রয়োগ হয় Personnel Action হিসেবে।",
    nav: "hrops:increments", can: (c) => hasMod(c, "hr_operations") },
  { id: "service_book_admin", title: "Employee 360 / Service Book", keys: ["employee 360", "service book", "সার্ভিস বুক", "dossier", "ডোসিয়ার", "employee profile full", "কর্মীর পুরো তথ্য"],
    steps: "মেনু → HR Operations → Employee records → **Service Book** → কর্মী বাছুন। এক পাতায় চাকরির ইতিহাস, হাজিরা, ছুটি, claim, loan, asset, document, অভিযোগ। **\"Dossier\"** দিয়ে PDF; এখান থেকে **\"Give Loan / Advance\"**-ও দেওয়া যায় (Payroll অনুমতি লাগে)।",
    nav: "hrops:service_book", can: (c) => hasMod(c, "hr_operations") },
  { id: "task_admin", title: "Task দেওয়া (Task Management)", keys: ["give a task", "task dibo", "টাস্ক দেওয়া", "task assign", "task management"],
    steps: "মেনু → HR Operations → Daily → **Task Management** → **\"Give a task\"** → কাকে, কী কাজ, শেষ তারিখ, গুরুত্ব। অগ্রগতি এখানে দেখা যায়, Excel-ও আছে; কর্মী My Tasks-এ পান।",
    nav: "admin:task_management", can: (c) => hasMod(c, "task_management") },
  { id: "payroll_settings", title: "Payroll — বেতনের মাস, Late policy, অনুমোদন, Hold", keys: ["salary month", "বেতনের মাস", "late policy", "লেট পলিসি", "late deduction", "দেরিতে কাটা", "payroll approval", "payroll audit", "salary hold", "বেতন আটকানো", "payslip generate", "generate payslips", "salary atke", "beton atke", "বেতন আটকে", "salary hold kivabe", "hold salary", "salary release"],
    steps: "মেনু → Payroll & Claims → **Payroll**:\n• **Run Payroll** → মাস বেছে Generate; **Generate Payslips** দিয়ে payslip।\n• বেতনের মাস কবে থেকে কবে (যেমন ২৬–২৫): **Salary Month Setting** (আলাদা অনুমতি)।\n• দেরিতে কাটা: **Late policy** (অফিস শুরু, grace, কয়টা দেরিতে ১ দিন কাটা)।\n• **Approval** ট্যাব: Submit → Audit Approve → Accounts Pay।\n• কারো বেতন আটকাতে: **Salary Hold / Release** (আলাদা অনুমতি)।",
    nav: "admin:payroll", can: (c) => hasMod(c, "payroll") },
  { id: "companies_admin", title: "Company (Sister concern) যোগ", keys: ["company add", "new company", "কোম্পানি যোগ", "sister concern", "সিস্টার কনসার্ন", "company switch", "workspace"],
    steps: "মেনু → Settings & Administration → **Companies** — কোম্পানি যোগ, logo/ঠিকানা, কোন user কোন কোম্পানিতে। উপরের company নাম থেকে কোম্পানি বদলানো যায়।",
    nav: "admin:companies", can: (c) => isSuper(c) },
  { id: "assistant_settings", title: "Assistant-এর অনুমতি (চালু/বন্ধ, রিপোর্ট, Live support)", keys: ["assistant off", "assistant bondho", "assistant permission", "assistant report download", "pdf download permission", "live support agent", "assistant support"],
    steps: "Settings & Administration → Users → account → **Module Access**:\n• **AI Assistant** — চালু/বন্ধ (ডিফল্ট চালু)।\n• **Assistant — report PDF / Excel download** — তালিকার উত্তরে PDF/Excel বোতাম (ডিফল্ট বন্ধ)।\n• **Assistant live support** — যাঁরা মানুষের সাথে কথা চাওয়া ব্যক্তিদের উত্তর দেবেন।",
    nav: "admin:users", can: (c) => hasMod(c, "users") },
  { id: "notice", title: "Notice দেওয়া", keys: ["notice", "নোটিশ", "announcement", "ঘোষণা"],
    steps: "Admin Panel → **Notices** → New Notice।", nav: "admin:notices", can: (c) => hasMod(c, "notices") },
  { id: "approval_chain", title: "Approval Chain", keys: ["approval chain", "chain", "approver set", "কে approve করবে"],
    steps: "Admin Panel → **Approval Chain**। কোন আবেদন কোন ধাপে কে approve করবে, তা এখানে ঠিক করা হয়।", nav: "admin:approvals", can: (c) => hasMod(c, "approvals") },
  { id: "dashboard", title: "HR Dashboard", keys: ["dashboard", "ড্যাশবোর্ড", "admin dashboard"],
    steps: "Admin Panel → **Admin Dashboard**। আজকের হাজিরা, অপেক্ষমাণ কাজ, জন্মদিন, probation/contract শেষ হওয়া, document-এর মেয়াদ আর সামনের personnel action এক জায়গায়।", nav: "admin:dashboard", can: canDash },
  { id: "reports", title: "Reports", keys: ["report", "রিপোর্ট"],
    steps: "Admin Panel → **Reports & Insights**। তৈরি রিপোর্ট বা নিজের মতো রিপোর্ট বানিয়ে Excel/PDF।", nav: "admin:reports_insights", can: (c) => isSuper(c) || c.modules.includes("reports_insights") }
];

// Whether this account could open the page behind a button (same rules as the
// menu); buttons it couldn't use are dropped.
function canNav(c: Ctx, nav: string): boolean {
  if (isSuper(c)) return true;
  // "admin:attendance_reports#custom" = that page on one tab: the page's rule.
  const [kind, target] = nav.split("#")[0].split(":");
  const f = c.flags;
  if (kind === "self") {
    switch (target) {
      case "leaveApplication": return f.can_view_leave_application || f.can_view_my_leave;
      case "leaveManagement": return f.can_manage_leave;
      case "timesheet": return f.can_view_timesheet;
      case "myTasks": return f.can_view_tasks || c.modules.includes("task_management");
      case "myMobileSim": return f.can_view_mobile_bill || c.modules.includes("mobile_bill");
      case "myLoans": return f.can_view_loan_request;
      case "myTargets": return f.can_view_targets;
      case "payroll": return c.modules.includes("payroll");
      default: return true;
    }
  }
  if (kind === "claims") return target === "movementClaims" ? f.can_view_movement_claims : f.can_view_conveyance_claims || c.modules.includes("conveyance");
  if (kind === "admin") return target === "dashboard" ? c.role === "admin" || c.modules.includes("admin_dashboard") : c.modules.includes(target);
  if (kind === "hrops") return c.modules.includes("hr_operations");
  return true; // home, profile, support:request
}
const allowedActions = (c: Ctx, actions: AssistantAction[]) => actions.filter((a) => canNav(c, a.nav));

const helpAction = (h: HelpEntry): AssistantAction[] => (h.nav ? [{ label: `${h.title} খুলুন`, nav: h.nav }] : []);

// ---------------------------------------------------------------------------
// The account's own API, called with the account's own token.
// ---------------------------------------------------------------------------
// Set when the routes are registered (see AiAssistantDeps.hasModuleLayer).
let layerCheck: ((user: any, moduleKey: string, layer: string) => Promise<boolean>) | null = null;
const layerOk = async (c: Ctx, moduleKey: string, layer: string) => isSuper(c) || (!!layerCheck && (await layerCheck(c.req.user, moduleKey, layer).catch(() => false)));

// Same as callApi, for the report APIs that take a POST body.
async function callApiPost(req: any, path: string, body: any): Promise<{ ok: boolean; status: number; body: any }> {
  const port = req.socket?.localPort;
  const headers: Record<string, string> = { Authorization: String(req.headers.authorization || ""), "Content-Type": "application/json" };
  if (req.headers["x-company-id"]) headers["X-Company-Id"] = String(req.headers["x-company-id"]);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(30000) });
    const out = await r.json().catch(() => null);
    return { ok: r.ok, status: r.status, body: out };
  } catch {
    return { ok: false, status: 0, body: null };
  }
}

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

// Reports & Insights (ReportsInsightsRoutes.ts) report keys.
const REPORT_KEYS = ["attendance_summary", "attendance_daily", "remote_attendance", "movement_claims", "bill_claims", "bill_claim_categories", "conveyance_bills", "bill_disbursements",
  "leave_applications", "leave_taken", "asset_register", "asset_assignments", "asset_requisitions", "vehicle_rides", "vehicle_utilization"];
// HR Operations -> Employee Reports ready-made lists (the same configs as
// HrOpsReports.tsx's presets). payroll: needs the Payroll module too — the
// API leaves those columns out otherwise.
const HR_PRESETS: Record<string, { title: string; payroll?: boolean; config: Record<string, any> }> = {
  salary_register: { title: "Salary register", payroll: true, config: { columns: ["name", "employee_code", "designation", "department", "grade", "basic_salary", "gross_salary", "last_increment_date", "last_increment_percent", "net_paid_year"] } },
  loans_outstanding: { title: "Loans outstanding", payroll: true, config: { columns: ["name", "department", "loan_outstanding", "active_loans", "loan_installment", "installments_left"], filters: [{ key: "loan_outstanding", op: "gt", value: 0 }] } },
  training_summary: { title: "Training summary", config: { columns: ["name", "department", "trainings", "training_count", "training_hours", "training_cost", "last_training_date"] } },
  pending_documents: { title: "Pending documents", config: { columns: ["name", "employee_code", "department", "missing_documents", "expired_documents"], filters: [{ key: "missing_documents_count", op: "gt", value: 0 }] } },
  missing_documents_by_type: { title: "Missing documents by type", config: { columns: ["name", "department", "missing_documents"], group_by: "missing_documents", filters: [{ key: "missing_documents_count", op: "gt", value: 0 }] } },
  nominee_gaps: { title: "Nominee / emergency contact gaps", config: { columns: ["name", "department", "nominee_status", "nominees", "has_emergency_contact"], match: "any", filters: [{ key: "nominee_status", op: "neq", value: "OK" }, { key: "has_emergency_contact", op: "is_false" }] } },
  education_levels: { title: "Education levels", config: { columns: ["name", "designation", "department", "highest_degree", "institutes"], group_by: "highest_level" } },
  experience_bands: { title: "Experience bands", config: { columns: ["name", "designation", "department", "prior_experience_years", "service_years", "total_experience_years"], group_by: "total_experience_band" } },
  unverified_records: { title: "Experience / education not verified", config: { columns: ["name", "department", "experience_unverified", "experience_no_certificate", "education_unverified", "education_no_certificate"], match: "any", filters: [{ key: "experience_unverified", op: "gt", value: 0 }, { key: "education_unverified", op: "gt", value: 0 }] } },
  no_education: { title: "No education recorded", config: { columns: ["name", "employee_code", "designation", "department", "joining_date"], filters: [{ key: "education_records", op: "eq", value: 0 }] } },
  joined_from_company: { title: "Joined from which company", config: { columns: ["name", "employee_code", "designation", "department", "last_company", "previous_companies", "prior_experience_years"], group_by: "previous_companies" } },
  probation_ending: { title: "Probation ending (60 days)", config: { columns: ["name", "designation", "department", "joining_date", "probation_end_date", "supervisor"], filters: [{ key: "service_status", op: "eq", value: "probation" }, { key: "probation_end_date", op: "next_days", value: 60 }] } },
  birthdays_this_month: { title: "Birthdays this month", config: { columns: ["name", "designation", "department", "date_of_birth", "age"], filters: [{ key: "birth_month", op: "eq", value: new Date().toLocaleString("en-US", { month: "long", timeZone: "Asia/Dhaka" }) }] } },
  anniversaries_this_month: { title: "Work anniversaries this month", config: { columns: ["name", "designation", "department", "joining_date", "service_years"], filters: [{ key: "joining_month", op: "eq", value: new Date().toLocaleString("en-US", { month: "long", timeZone: "Asia/Dhaka" }) }] } },
  assets_with_employees: { title: "Assets with employees", config: { columns: ["name", "department", "assets_held", "asset_names"], filters: [{ key: "assets_held", op: "gt", value: 0 }] } },
  blood_group_directory: { title: "Blood group directory", config: { columns: ["name", "department", "blood_group", "mobile"], group_by: "blood_group" } },
  headcount_list: { title: "Headcount by department", config: { columns: ["name", "employee_code", "designation", "department", "joining_date"], group_by: "department" } },
  leave_summary: { title: "Leave summary", config: { columns: ["name", "department", "casual_taken", "casual_balance", "sick_taken", "sick_balance", "lwp_taken", "leave_pending", "leave_remaining"] } },
  claims_summary: { title: "Claims & conveyance", config: { columns: ["name", "department", "claims_count", "claims_claimed", "claims_approved", "claims_pending", "conveyance_paid", "movement_km"] } },
  monthly_attendance: { title: "Monthly attendance", config: { columns: ["name", "department", "att_working", "att_present", "att_leave", "att_absent", "att_late", "att_extreme_late", "att_percent"] } }
};

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

// ---------------------------------------------------------------------------
// Reading a leave request out of free text ("20 oct family problem niye leave
// dao", "কাল থেকে ৩ দিন অসুস্থতার ছুটি"). Only fills the draft card — the
// person checks every field before submitting.
// ---------------------------------------------------------------------------
const MONTH_WORDS: [RegExp, number][] = [
  [/^(jan|january|জানু|জানুয়ারি|januari)/, 1], [/^(feb|february|ফেব্রু|ফেব্রুয়ারি|februari)/, 2], [/^(mar|march|মার্চ)/, 3],
  [/^(apr|april|এপ্রিল)/, 4], [/^(may|মে)$/, 5], [/^(jun|june|জুন)/, 6], [/^(jul|july|জুলাই)/, 7], [/^(aug|august|আগস্ট|আগষ্ট)/, 8],
  [/^(sep|sept|september|সেপ্টে|সেপ্টেম্বর)/, 9], [/^(oct|october|অক্টো|অক্টোবর|oktobor)/, 10], [/^(nov|november|নভে|নভেম্বর)/, 11], [/^(dec|december|ডিসে|ডিসেম্বর)/, 12]
];
const toAsciiDigits = (s: string) => s.replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)));
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const addDays = (isoDate: string, n: number) => new Date(Date.parse(isoDate + "T00:00:00Z") + n * 86400000).toISOString().slice(0, 10);

// The salary month's dates, the same way Payroll works them out
// (PayrollRoutes.ts getSalaryPeriod): with a 26th start, "2026-11" runs
// 26 Oct – 25 Nov, and a month always starts the day after the one before
// it ended. Start day 1 (the default) is the calendar month.
const salaryStartDay = (c: Ctx, ym: string) => {
  let d = 1;
  for (const s of c.salaryStarts || []) if (s.effective_month <= ym) d = Number(s.start_day) || 1;
  return Math.min(28, Math.max(1, d));
};
const salaryPeriod = (c: Ctx, ym: string) => {
  const own = salaryPeriodFor(ym, salaryStartDay(c, ym));
  const prev = monthShift(ym, -1);
  return { start: addDays(salaryPeriodFor(prev, salaryStartDay(c, prev)).end, 1), end: own.end };
};
// The salary month a date falls in (26 Oct is already November's).
const salaryMonthOf = (c: Ctx, date: string) => {
  const cal = date.slice(0, 7);
  for (const m of [cal, monthShift(cal, 1)]) {
    const p = salaryPeriod(c, m);
    if (p.start <= date && date <= p.end) return m;
  }
  return cal;
};
const salaryMonthStartsLater = (c: Ctx) => (c.salaryStarts || []).some((s) => Number(s.start_day) > 1);
const validDate = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();

function monthOf(word: string): number | null {
  for (const [re, m] of MONTH_WORDS) if (re.test(word)) return m;
  return null;
}

export function parseLeaveRequest(text: string, today: string) {
  const t = ` ${toAsciiDigits(String(text || "").toLowerCase()).replace(/[,।]/g, " ").replace(/\s+/g, " ")} `;
  const [ty, tm] = today.split("-").map(Number);
  const yearFor = (m: number, explicit?: number) => explicit || (m < tm - 2 ? ty + 1 : ty);
  let start: string | null = null;
  let end: string | null = null;

  // 2026-10-20 (… 2026-10-22)
  const isoHits = [...t.matchAll(/(\d{4})-(\d{1,2})-(\d{1,2})/g)].map((m) => iso(+m[1], +m[2], +m[3]));
  if (isoHits.length) { start = isoHits[0]; end = isoHits[1] || null; }

  // 20/10(/2026)
  if (!start) {
    const hits = [...t.matchAll(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/g)].filter((m) => validDate(ty, +m[2], +m[1]));
    if (hits.length) {
      const mk = (m: RegExpMatchArray) => { const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : yearFor(+m[2]); return iso(y, +m[2], +m[1]); };
      start = mk(hits[0]); end = hits[1] ? mk(hits[1]) : null;
    }
  }

  // 20 oct / 20-22 oct / 20 theke 22 october / oct 20
  if (!start) {
    const words = t.trim().split(" ");
    for (let i = 0; i < words.length && !start; i++) {
      const m = monthOf(words[i].replace(/(er|এর|-এর|e|তে)$/, ""));
      if (!m) continue;
      const before = words.slice(Math.max(0, i - 4), i).join(" ");
      const range = /(\d{1,2})\s*(?:-|–|to|theke|থেকে|hote|হতে)\s*(\d{1,2})(?:\s*(?:tarikh|তারিখ|ta|টা))?\s*$/.exec(before);
      const single = /(\d{1,2})(?:\s*(?:tarikh|তারিখ|ta|টা|th|st|nd|rd))?\s*$/.exec(before);
      const after = /^(\d{1,2})\b/.exec(words[i + 1] || "");
      const yearWord = /^(20\d{2})$/.exec(words[i + 1] || "") || /^(20\d{2})$/.exec(words[i + 2] || "");
      const y = yearFor(m, yearWord ? +yearWord[1] : undefined);
      if (range && validDate(y, m, +range[1]) && validDate(y, m, +range[2])) { start = iso(y, m, +range[1]); end = iso(y, m, +range[2]); }
      else if (single && validDate(y, m, +single[1])) start = iso(y, m, +single[1]);
      else if (after && validDate(y, m, +after[1])) start = iso(y, m, +after[1]);
    }
    // "… 20 oct to 22 oct": a second month mention gives the end date
    // ("oct 20 to oct 22" works the same way)
    if (start && !end) {
      const dm = [...t.matchAll(/(\d{1,2})\s+([a-z\u0980-\u09ff]+)/g)].map((x) => ({ at: x.index || 0, d: +x[1], m: monthOf(x[2]) }));
      const md = [...t.matchAll(/([a-z\u0980-\u09ff]+)\s+(\d{1,2})\b/g)].map((x) => ({ at: x.index || 0, d: +x[2], m: monthOf(x[1]) }));
      const all = [...dm, ...md].filter((x) => x.m).sort((a, b) => a.at - b.at)
        .filter((x, i, arr) => i === 0 || Math.abs(x.at - arr[i - 1].at) > 4);
      if (all.length > 1) { const x = all[1]; const y = yearFor(x.m!); if (validDate(y, x.m!, x.d)) end = iso(y, x.m!, x.d); }
    }
  }

  // aj / kal / porshu
  if (!start) {
    if (/\s(porshu|porshudin|পরশু)\s/.test(t)) start = addDays(today, 2);
    else if (/\s(kal|kalke|agamikal|agami kal|আগামীকাল|কাল|কালকে|tomorrow)\s/.test(t)) start = addDays(today, 1);
    else if (/\s(aj|ajke|আজ|আজকে|today)\s/.test(t)) start = today;
  }

  // "3 din" / "৩ দিন" / "3 days"
  const n = /(\d{1,2})\s*(?:din|দিন|days?|দিনের)/.exec(t);
  if (start && !end && n && +n[1] > 1 && +n[1] <= 60) end = addDays(start, +n[1] - 1);
  if (start && (!end || end < start)) end = start;

  const leave_type = /sick|অসুস্থ|asustho|osustho|জ্বর|jor\b|doctor|ডাক্তার|হাসপাতাল|hospital/.test(t) ? "sick"
    : /without pay|বিনা বেতন|lwp/.test(t) ? "without_pay"
    : /earn|অর্জিত/.test(t) ? "custom_earn_leave" : "";
  const is_half_day = /half ?day|হাফ|অর্ধ|অর্ধেক/.test(t);

  // Purpose: the dates and request words taken out, then "<reason> niye /
  // er jonno / karone …" or "… for / because <reason>".
  const MONTH_RX = "(?:jan\\w*|feb\\w*|mar\\w*|apr\\w*|may|jun\\w*|jul\\w*|aug\\w*|sep\\w*|oct\\w*|nov\\w*|dec\\w*|জানুয়ারি|ফেব্রুয়ারি|মার্চ|এপ্রিল|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর)";
  const base = toAsciiDigits(String(text || ""))
    .replace(/\d{4}-\d{1,2}-\d{1,2}/g, " ")
    .replace(/\d{1,2}\/\d{1,2}(?:\/\d{2,4})?/g, " ")
    .replace(new RegExp(`\\d{1,2}\\s*(?:-|–|to|theke|থেকে|hote|হতে)\\s*\\d{1,2}\\s*${MONTH_RX}`, "gi"), " ")
    .replace(new RegExp(`\\d{1,2}\\s*${MONTH_RX}`, "gi"), " ")
    .replace(new RegExp(`${MONTH_RX}\\s*\\d{1,2}`, "gi"), " ")
    .replace(/\d{1,2}\s*(?:din|দিন|days?|দিনের)/gi, " ")
    .replace(/[,।]/g, " ")
    .replace(/\s+/g, " ");
  const pre = /^(.{3,90}?)\s*(?:niye|নিয়ে|er jonno|এর জন্য|jonno|জন্য|karone|কারণে)(?:\s|$)/i.exec(base);
  const post = /(?:\bfor|because of|because|karon|কারণ)\s+(.{3,90}?)\s*$/i.exec(base);
  const FILLER = new Set(["leave", "application", "appliation", "aplication", "chuti", "chhuti", "ছুটি", "ছুটির", "dao", "দাও", "kore", "করে", "apply", "koro", "করো", "lagbe", "লাগবে",
    "chai", "চাই", "nibo", "নেব", "নিব", "half", "day", "হাফ", "kal", "কাল", "কালকে", "kalke", "আগামীকাল", "agamikal", "porshu", "পরশু", "aj", "আজ", "ajke", "theke", "থেকে", "to",
    "on", "from", "ekti", "ekta", "একটি", "একটা", "amar", "আমার", "er", "এর", "sick", "casual", "please", "plz", "ta", "টা", "tarikh", "তারিখ", "i", "need", "want", "take", "a",
    "an", "the", "for", "my", "den", "দিন", "diye", "দিয়ে", "sir"]);
  const words = ((pre && pre[1]) || (post && post[1]) || "").split(" ").filter((w) => w && !FILLER.has(w.toLowerCase()));
  let purpose = words.join(" ").trim();
  if (purpose) purpose = purpose.charAt(0).toUpperCase() + purpose.slice(1);

  return { start_date: start, end_date: end, leave_type, is_half_day, purpose };
}

// Clock times in free text: "10:30", "10.30", "10 ta", "৩টায়", "3pm",
// "bikel 3 tay" (afternoon/evening/night words make it PM). Each with where
// it was found, so "in 9:10 out 6" can tell In from Out.
export function parseClockTimes(text: string): { at: number; hm: string }[] {
  const t = ` ${toAsciiDigits(String(text || "").toLowerCase())} `;
  const out: { at: number; hm: string }[] = [];
  const rx = /(?:^|[^\d:.])(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|ta|টা|tay|টায়|tar|টার|baje|বাজে|o'?clock)?(?![\d])/g;
  for (const m of t.matchAll(rx)) {
    const h0 = +m[1];
    const min = m[2] ? +m[2] : 0;
    if (!m[2] && !m[3]) continue; // a bare number is a date or a count, not a time
    if (h0 > 23 || min > 59) continue;
    const at = (m.index || 0) + m[0].indexOf(m[1]);
    const near = t.slice(Math.max(0, at - 14), at);
    let h = h0;
    const pm = /p\.?m/.test(m[3] || "") || /(bikel|bikal|বিকাল|বিকেল|sondha|shondha|সন্ধ্যা|rat|raat|রাত|evening|night)\s*$/.test(near);
    const noon = /(dupur|দুপুর|noon)\s*$/.test(near);
    if ((pm && h < 12) || (noon && h <= 4)) h += 12;
    if (/a\.?m/.test(m[3] || "") && h === 12) h = 0;
    out.push({ at, hm: `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}` });
  }
  return out;
}

// "kal sokal 10 tay office theke gulshan jabo client meeting er jonno 2 ghonta"
// -> a Book a Ride draft. Only fills the card; the person checks it.
export function parseRideRequest(text: string, today: string) {
  const raw = String(text || "");
  const t = ` ${toAsciiDigits(raw.toLowerCase()).replace(/[,।]/g, " ").replace(/\s+/g, " ")} `;
  const date = parseLeaveRequest(raw, today).start_date || today;
  const time = parseClockTimes(raw)[0]?.hm || "";
  let hours = 0;
  const hm = /(\d+(?:\.\d+)?)\s*(?:ghonta|ghonta|ghanta|ঘণ্টা|ঘন্টা|hours?|hrs?|h)\b/.exec(t);
  const mm = /(\d{1,3})\s*(?:min|mins|minutes?|minit|মিনিট)\b/.exec(t);
  if (hm) hours = +hm[1];
  else if (mm) hours = Math.round((+mm[1] / 60) * 100) / 100;
  else if (/half ?day|হাফ ডে|অর্ধেক দিন|ordhek din/.test(t)) hours = 4;
  else if (/full ?day|sara ?din|সারা দিন|সারাদিন|puro din|পুরো দিন/.test(t)) hours = 8;
  const self_drive = /nije (?:chalabo|chalai|drive)|self ?drive|নিজে চালা|i(?:'ll| will) drive|nijei chalabo/.test(t);
  // Places: "A theke B (jabo)" / "from A to B" / "B jabo" / "to B".
  const STOP = new Set(["jabo", "যাব", "যাবো", "jete", "যেতে", "jaite", "porjonto", "পর্যন্ত", "er", "এর", "jonno", "জন্য", "lagbe", "লাগবে", "gari", "গাড়ি", "car", "ride",
    "book", "বুক", "koro", "করো", "kore", "করে", "dao", "দাও", "chai", "চাই", "at", "kal", "কাল", "aj", "আজ", "sokal", "সকাল", "bikel", "বিকেল", "dupur", "দুপুর", "rat", "রাত",
    "on", "for", "please", "plz", "ekta", "একটা", "and", "ar", "আর", "e", "te", "তে", "এ", "theke", "থেকে", "from", "to"]);
  const cleanPlace = (words: string[]) => {
    const keep = words.filter((w) => w && !STOP.has(w) && !/^\d/.test(w) && !monthOf(w) && !/^(ta|টা|tay|টায়|am|pm|ghonta|ঘণ্টা|hours?|min|half|full|day)$/.test(w));
    const v = keep.slice(0, 4).join(" ").trim();
    return v ? v.replace(/(^|\s)\S/g, (x) => x.toUpperCase()) : "";
  };
  const words = toAsciiDigits(raw).replace(/[,।]/g, " ").split(/\s+/).filter(Boolean);
  const low = words.map((w) => w.toLowerCase());
  let pickup = "";
  let destination = "";
  const from = low.findIndex((w) => w === "from");
  const to = low.findIndex((w, i) => w === "to" && i > from);
  const theke = low.findIndex((w) => w === "theke" || w === "থেকে");
  if (from >= 0 && to > from) {
    pickup = cleanPlace(low.slice(from + 1, to));
    destination = cleanPlace(low.slice(to + 1, to + 5));
  } else if (theke > 0) {
    pickup = cleanPlace(low.slice(Math.max(0, theke - 3), theke).filter((w) => !/^\d/.test(w)));
    destination = cleanPlace(low.slice(theke + 1, theke + 5).join(" ").split(/\s(?:jabo|যাব|যাবো|jete|যেতে|porjonto|পর্যন্ত|er|এর|e|te|তে)\s/)[0].split(" "));
  }
  if (!destination) {
    const j = low.findIndex((w) => ["jabo", "যাব", "যাবো", "jete", "যেতে"].includes(w));
    // "banani jabo", "gulshane jabo": the place words right before "jabo"
    // (request words like "lagbe" dropped first, then a trailing "-e/-te").
    if (j > 0) {
      const before = low.slice(Math.max(0, j - 3), j).filter((w) => !STOP.has(w) && !/^\d/.test(w) && !monthOf(w)).slice(-2);
      destination = cleanPlace(before.map((w) => (w.length > 5 ? w.replace(/(te|তে)$/, "").replace(/([a-z]{4,})e$/, "$1") : w)));
    }
    const toOnly = low.findIndex((w) => w === "to");
    if (!destination && toOnly >= 0) destination = cleanPlace(low.slice(toOnly + 1, toOnly + 4));
  }
  const pre = /^(.{3,80}?)\s*(?:er jonno|এর জন্য|jonno|জন্য|kaje|কাজে)(?:\s|$)/i.exec(raw.replace(/[,।]/g, " "));
  const post = /(?:\bfor|purpose|udde?shyo|উদ্দেশ্য)\s*[:\-]?\s+(.{3,80}?)\s*$/i.exec(raw);
  let purpose = ((pre && pre[1].split(/\s(?:theke|থেকে|jabo|যাব|tay|টায়|ta|টা)\s/).pop()) || (post && post[1]) || "").trim();
  if (purpose && /^\d/.test(purpose)) purpose = "";
  return { ride_date: date, start_time: time, estimated_duration_hours: hours || 1, pickup_location: pickup, destination, purpose, self_drive };
}

// "gotokal check in dite bhule gechi 9:10 e ashchi 6 tay ber hoyechi" -> a
// Correct Attendance draft. "kal" here means yesterday (a correction is
// never for a day still to come).
export function parseCorrectionRequest(text: string, today: string) {
  const raw = String(text || "");
  const t = ` ${toAsciiDigits(raw.toLowerCase())} `;
  const words = ` ${toAsciiDigits(raw.toLowerCase()).replace(/[,।!?]/g, " ")} `;
  let date = parseLeaveRequest(raw, today).start_date || "";
  if (/\s(gotokal|গতকাল|yesterday)\s/.test(words) || (date && date > today && /\s(kal|kalke|কাল|কালকে)\s/.test(words))) date = addDays(today, -1);
  if (!date || date > today) date = /\s(aj|ajke|আজ|আজকে|today)\s/.test(words) || !date ? today : addDays(today, -1);
  const times = parseClockTimes(raw);
  // Each time goes with the nearer In / Out word, before or after it
  // ("in 9:15", "9:10 e ashchi", "6 tay ber hoyechi").
  // Every spelling of "came in" / "went out" (also after spelling fixes:
  // ashchi / ashche / esechi / eshechilam, ber hoyechi / beriye / chole gechi).
  const IN = /(\bin\b|ইন|check ?in|ঢুক|dhuk|entry|enter|এসেছি|এসেছিলাম|এসে|আসছি|আসি|প্রবেশ|arrive|\b(?:ashchi|ashche|aschi|asche|asci|ashi|ashlam|aslam|ashchilam|eshechi|esechi|esheche|eseche|eshechilam|esechilam|eshe|ese|pouchechi|pouchaichi)\b|পৌঁছ)/g;
  const OUT = /(\bout\b|আউট|check ?out|বের|\bber\b|\bberi\w*|chole|চলে|left\b|bahir|বাহির)/g;
  const posOf = (rx: RegExp) => [...t.matchAll(rx)].map((m) => m.index || 0);
  const inAt = posOf(IN);
  const outAt = posOf(OUT);
  const dist = (list: number[], at: number) => Math.min(Infinity, ...list.map((p) => Math.abs(p - at)));
  let check_in = "";
  let check_out = "";
  for (const x of times) {
    const di = dist(inAt, x.at);
    const dout = dist(outAt, x.at);
    if (Math.min(di, dout) > 30) continue;
    if (dout < di && !check_out) check_out = x.hm;
    else if (di <= dout && !check_in) check_in = x.hm;
  }
  // "9:10 e ashchi, 6 tay ber": an Out before the In with no am/pm said is the evening.
  if (check_in && check_out && check_out < check_in && +check_out.slice(0, 2) < 12 && +check_out.slice(0, 2) + 12 > +check_in.slice(0, 2)) {
    check_out = `${String(+check_out.slice(0, 2) + 12).padStart(2, "0")}${check_out.slice(2)}`;
  }
  if (!check_in && !check_out && times.length) {
    check_in = times[0].hm;
    if (times[1]) check_out = times[1].hm;
  }
  const why = /(?:karon|কারণ|because|reason)\s*[:\-]?\s+(.{3,150})$/i.exec(raw)?.[1] ||
    (/(bhule|ভুলে|forgot|vule|mone chilo na|মনে ছিল না|network|নেটওয়ার্ক|gps|phone|ফোন|charge|চার্জ)/i.test(raw) ? raw.trim() : "");
  return { attendance_date: date, check_in, check_out, remarks: why.slice(0, 250) };
}

// "client er office e jacchi movement check in koro" / "pouche gechi
// movement check out" -> which way and the purpose in their words.
export function parseMovementRequest(text: string) {
  const raw = String(text || "").trim();
  const t = ` ${raw.toLowerCase().replace(/[,।!?]/g, " ").replace(/\s+/g, " ")} `;
  const out = /(check ?out|চেক আউট|pouch|পৌঁছ|reached|kaj shesh|কাজ শেষ|fir(?:e|i)chi|ফিরে|ফিরছি|firlam|back to office|end|শেষ)/.test(t);
  const action = out ? "check_out" : /(check ?in|চেক ইন|start|শুরু|shuru|jacchi|যাচ্ছি|jabo|যাব|going|ber hocchi|বের হচ্ছি)/.test(t) ? "check_in" : "";
  // The clause with "jacchi / যাচ্ছি / going" (else the words after
  // "purpose / for / jonno"), minus the request words. Word by word: \b
  // doesn't see Bangla letters.
  const VERB = /(jacchi|যাচ্ছি|jabo|যাব|যাবো|jete hobe|যেতে হবে|going to|going|যাচ্ছিলাম)/i;
  const clauses = raw.split(/[,।;]/).map((x) => x.trim()).filter(Boolean);
  const post = /(?:purpose|uddeshyo|উদ্দেশ্য|\bfor\b|jonno|জন্য)\s*[:\-]?\s+(.{3,120})$/i.exec(raw);
  const pick = clauses.find((x) => VERB.test(x)) || (post && post[1]) || "";
  const FILL = new Set(["movement", "মুভমেন্ট", "claim", "ক্লেইম", "ক্লেম", "koro", "করো", "kore", "করে", "dao", "দাও", "please", "plz", "start", "ekta", "একটা", "a", "an", "the",
    "amar", "আমার", "ami", "আমি", "now", "ekhon", "এখন", "e", "te", "তে", "এ", "jacchi", "যাচ্ছি", "jabo", "যাব", "যাবো", "going", "to", "hobe", "হবে", "jete", "যেতে", "i'm", "im", "am", "for"]);
  let purpose = pick
    .replace(/check ?in|check ?out|চেক ইন|চেক আউট/gi, " ")
    .split(/\s+/)
    .filter((w) => w && !FILL.has(w.toLowerCase()))
    .join(" ")
    .trim();
  if (purpose) purpose = purpose.charAt(0).toUpperCase() + purpose.slice(1);
  return { action, purpose: action === "check_out" ? "" : purpose.slice(0, 255) };
}

// Attendance questions with conditions, for the Report Builder:
// "aj 9:05 er pore ke ke asche", "6 tar age ke ber hoye geche", "ei mase 3
// bar er beshi late kara", "check out den nai kara", "8 ghontar kom kaj",
// "department wise ei maser late". Returns the builder's arguments (empty
// when the question has no condition the builder adds anything for).
export function parseAttendanceQuestion(text: string) {
  const raw = String(text || "");
  const t = ` ${toAsciiDigits(raw.toLowerCase()).replace(/[,।!?]/g, " ").replace(/\s+/g, " ")} `;
  const out: Record<string, any> = {};
  const OUTW = /(ber|বের|out|আউট|chole|চলে|left|leave kor|gese|geche|গেছে|beriye|বেরিয়ে|bahir)/;
  const INW = /(asche|asc?he|esheche|eseche|এসেছে|আসছে|aschhe|in\b|ইন|dhuk|ঢুক|came|arrive|reached|pouch)/;
  for (const x of parseClockTimes(raw)) {
    const after = t.slice(x.at, x.at + 28);
    const around = t.slice(Math.max(0, x.at - 26), x.at + 30);
    const isAfter = /(por|pore|পরে|pare|after|beyond|late)/.test(after) && !/(age|আগে|before)/.test(after.split(/(por|pore|পরে|after)/)[0]);
    const isBefore = /(age|আগে|before|er age|এর আগে)/.test(after);
    const isOut = OUTW.test(around) && !(INW.test(around) && !OUTW.test(after));
    // "6 tar age ber hoyeche": a leaving time of 1–8 o'clock without
    // "sokal / am" is in the evening.
    let hmv = x.hm;
    const h = Number(hmv.slice(0, 2));
    if (isOut && h >= 1 && h <= 8 && !/(sokal|সকাল|\bam\b|a\.m)/.test(around)) hmv = `${String(h + 12).padStart(2, "0")}${hmv.slice(2)}`;
    if (isOut) out[isAfter ? "out_after" : "out_before"] = hmv;
    else if (isBefore) out.in_before = x.hm;
    else out.in_after = x.hm;
  }
  if (/(onek deri|অনেক দেরি|extreme)/.test(t)) out.late = "extreme";
  else if (/(\blate\b|deri|দেরি|লেট)/.test(t) && !out.in_after) out.late = "any";
  if (/(absent|অনুপস্থিত|anupasthit|asheni|আসেনি|ase nai)/.test(t)) out.status = "absent";
  else if (/(chuti|ছুটি|on leave|leave e)/.test(t)) out.status = "leave";
  if (/(check ?out (?:den|dey|dei)? ?(?:ni|nai|nai)|out (?:den|dey) ?n[ai]|check-?out দেয়নি|আউট দেয়নি|missing (?:out|check ?out)|forgot to check out|check out kore ni)/.test(t)) out.missing_out = true;
  const hrs = /(\d+(?:\.\d+)?)\s*(?:ghontar|ghonta|ঘণ্টার|ঘণ্টা|hours?|hrs?)\s*(kom|কম|less|under|er kom|beshi|বেশি|more|over)/.exec(t);
  if (hrs) out[/kom|কম|less|under/.test(hrs[2]) ? "max_hours" : "min_hours"] = Number(hrs[1]);
  if (/(overtime|ওভারটাইম|\bot\b)/.test(t)) out.overtime = true;
  if (/(early leave|agei ber|আগেই বের|তাড়াতাড়ি বের|taratari ber|left early)/.test(t)) out.early_leave = true;
  const n = /(\d+)\s*(?:bar|বার|times?|din|দিন|dine)\s*(?:er|এর)?\s*(?:beshi|বেশি|or more|\+|ba tar beshi|বা তার বেশি)/.exec(t) || /(?:more than|at least|kompokkhe)\s*(\d+)/.exec(t);
  if (n) {
    out.view = "summary";
    out.group_by = "employee";
    out.min_count = Number(n[1]);
  }
  if (/(department wise|department onujayi|department hisabe|ডিপার্টমেন্ট অনুযায়ী|বিভাগ অনুযায়ী|বিভাগভিত্তিক|by department)/.test(t)) { out.view = "summary"; out.group_by = "department"; }
  else if (/(employee wise|কর্মী অনুযায়ী|kar koto|কার কত|per person|by employee)/.test(t)) { out.view = "summary"; out.group_by = "employee"; }
  else if (/(din wise|date wise|দিনভিত্তিক|প্রতিদিন|daily|by date|dine dine)/.test(t)) { out.view = "summary"; out.group_by = "date"; }
  // "Sales department-er late" (not "late department wise": that groups).
  const dept = /([a-z&]{2,}|[ঀ-৿]{2,})\s+(?:department|dept|বিভাগ|বিভাগের|ডিপার্টমেন্ট)(?!\s*(?:wise|onujayi|hisabe|অনুযায়ী|ভিত্তিক))/.exec(t)?.[1];
  const NOT_DEPT = /^(wise|onujayi|hisabe|sob|সব|kon|কোন|er|এর|late|লেট|deri|দেরি|absent|leave|chuti|ছুটি|ajker|আজকের|maser|মাসের|report|ei|এই|all|every|each|protiti|প্রতিটি)$/;
  if (dept && !NOT_DEPT.test(dept)) out.department = dept;
  return out;
}

// "Rahim er chuti koto" -> "rahim": the word(s) right before a separate
// "er" / "-এর" / "এর" ("ajker" and "মাসের" are not names).
const NOT_NAMES = new Set(["amar", "আমার", "ei", "এই", "e", "এ", "ajker", "maser", "masher", "মাসের", "gotomaser", "গত", "tomar", "তোমার", "apnar", "আপনার", "kar", "কার", "sobar", "সবার", "team", "office", "company"]);
const nameBefore = (t: string) => {
  const m = /([a-z.]{2,}(?:\s+[a-z.]{2,})?)\s+er\s/.exec(t) || /([\u0980-\u09ff]{2,}(?:\s+[\u0980-\u09ff]{2,})?)(?:-এর|\s+এর)\s/.exec(t);
  // "attendance er obostha": a word the assistant knows as a topic isn't a name.
  // "october er hajira": a month is not a name either.
  const words = (m?.[1] || "").split(/\s+/).filter((w) => w && !NOT_NAMES.has(w) && !topicWords().has(w) && !monthOf(w));
  return words.slice(-1)[0] || "";
};

// "Sales department er target" / "Rahim er task": the department or person
// asked about, if any.
const ORG_WORDS = new Set(["department", "dept", "বিভাগ", "বিভাগের", "team", "টিম", "company", "সবার", "sobar", "performance", "review", "appraisal", "rating", "task", "target", "document", "vehicle", "gari", "ride", "bochor", "বছর", "বছরের", "mas", "mash", "month", "year", "week", "saptah"]);
const subjectBefore = (t: string) => {
  const d = /([a-z.&]{2,})\s+(?:department|dept)\b/.exec(t) || /([\u0980-\u09ff]{2,})\s+(?:বিভাগ|department)/.exec(t);
  if (d && !NOT_NAMES.has(d[1]) && !ORG_WORDS.has(d[1])) return d[1];
  const n = nameBefore(t);
  return ORG_WORDS.has(n) ? "" : n;
};

// "pending_with" on a requisition: a name, a list of names or { name }.
const pendingWith = (x: any): string | null => {
  const p = x?.pending_with;
  if (!p) return null;
  if (typeof p === "string") return p;
  if (Array.isArray(p)) return p.map((v) => (typeof v === "string" ? v : v?.name || v?.user_name)).filter(Boolean).join(" / ") || null;
  return p.name || p.user_name || null;
};

// Where a pending leave application waits: its Reliever first, then the
// Approval Chain layer (label from the template step) and who approves it.
function leaveStage(l: any): { key: string; bn: string; en: string } {
  if (l.reliever_status === "pending" && l.reliever_id && !l.current_step) {
    const who = String(l.reliever_name || l.approver_name || "").replace(/ \(Reliever\)$/, "");
    return { key: "reliever", bn: `Reliever-এর কাছে${who ? ` (${who})` : ""}`, en: `Reliever${who ? ` (${who})` : ""}` };
  }
  const layer = l.current_step_label || (l.current_step ? `Step ${l.current_step}` : "Approver");
  const of = l.current_step && l.total_steps ? ` ${l.current_step}/${l.total_steps}` : "";
  const who = l.approver_name ? ` — ${l.approver_name}` : "";
  return { key: `${layer}|${of}|${who}`, bn: `${layer} ধাপে${of ? ` (${bn(of.trim())})` : ""}${who}`, en: `${layer}${of}${who}` };
}
function groupByStage(rows: any[]) {
  const m = new Map<string, { bn: string; en: string; items: any[] }>();
  for (const l of rows) {
    const s = leaveStage(l);
    if (!m.has(s.key)) m.set(s.key, { bn: s.bn, en: s.en, items: [] });
    m.get(s.key)!.items.push(l);
  }
  return [...m.values()].sort((a, b) => b.items.length - a.items.length);
}
const monthEndOf = (isoDate: string) => {
  const [y, m] = isoDate.split("-").map(Number);
  return iso(y, m, new Date(Date.UTC(y, m, 0)).getUTCDate());
};

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
        actions: [{ label: "Leave Application খুলুন", nav: "self:leaveApplication" }],
        report: report("My Leave Applications", "My-Leave-Applications", ["Leave Type", "From", "To", "Days", "Status"],
          [...rows].sort((a, b) => String(b.start_date).localeCompare(String(a.start_date))).map((x) => [x.leave_type_label || x.leave_type, enDate(x.start_date), enDate(x.end_date || x.start_date), Number(x.day_count) || 0, String(x.status || "")]),
          [["Employee", c.name]])
      };
    }
  },
  {
    name: "my_attendance_summary",
    description: "The asking employee's own attendance for a salary month: present, absent, leave and late days. Optional month_year: the SALARY month's 'YYYY-MM' (default: the salary month today falls in; with a 26th start, '2026-11' = 26 Oct – 25 Nov).",
    params: { month_year: { type: "string", description: "Month as YYYY-MM; omit for the current month." } },
    run: async (c, args) => {
      const ym = /^\d{4}-\d{2}$/.test(String(args?.month_year || "")) ? String(args.month_year) : "";
      const r = await callApi(c.req, `/api/my-attendance-summary${ym ? `?month_year=${ym}` : ""}`);
      if (!r.ok) return fail(r.status);
      const s = r.body || {};
      if (s.linked === false) {
        const note = notLinked(c, "হাজিরা");
        // Someone who reads attendance reports most likely wants everyone's:
        // the same (salary) month for the whole company, by Department.
        if (!hasMod(c, "attendance_reports")) return note;
        const sm = /^\d{4}-\d{2}$/.test(String(s.month_year || "")) ? String(s.month_year) : ym || salaryMonthOf(c, c.today);
        const p = salaryPeriod(c, sm);
        const all = await TOOLS.find((x) => x.name === "attendance_custom_report")!.run(c, {
          from: p.start, to: p.end > c.today ? c.today : p.end, view: "summary", group_by: "department", salary_month: sm
        });
        if (!all.ok) return note;
        return { ...all, text: `${note.text}\n\nনিচে **পুরো কোম্পানির** হাজিরা:\n${all.text}`, data: { linked: false, company: all.data }, actions: [...(note.actions || []), ...(all.actions || [])] };
      }
      const text =
        `${salaryMonthStartsLater(c) ? "বেতনের মাস " : ""}${bnMonth(String(s.month_year || ym))}-এর হাজিরা (${bnDate(s.period_start)} – ${bnDate(s.period_end)}):\n` +
        `• উপস্থিত: **${bn(s.present_days ?? 0)} দিন**\n• ছুটি: ${bn(s.leave_days ?? 0)} দিন\n• অনুপস্থিত: ${bn(s.absent_days ?? 0)} দিন\n` +
        `• দেরি (late): **${bn(s.late_count ?? 0)} বার**${Number(s.late_deduction_days) ? ` — এর জন্য ${bn(s.late_deduction_days)} দিন কাটা যেতে পারে` : ""}\n` +
        `• এখন পর্যন্ত কর্মদিবস: ${bn(s.working_days_so_far ?? 0)} / ${bn(s.working_days ?? 0)}`;
      return { ok: true, text, data: s };
    }
  },
  {
    name: "my_late_days",
    description: "The asking employee's OWN late dates between two dates (YYYY-MM-DD), default the current month. Not for questions about other employees — use late_on_date for that.",
    params: { from: { type: "string", description: "Start date YYYY-MM-DD" }, to: { type: "string", description: "End date YYYY-MM-DD" } },
    run: async (c, args) => {
      // Default: the salary month so far.
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.from || "")) ? String(args.from) : salaryPeriod(c, salaryMonthOf(c, c.today)).start;
      const to = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.to || "")) ? String(args.to) : c.today;
      const r = await callApi(c.req, `/api/my-late-days?from=${from}&to=${to}`);
      if (!r.ok) return fail(r.status);
      if (r.body?.linked === false) return notLinked(c, "দেরির হিসাব");
      // { days: { 'YYYY-MM-DD': 'delay' | 'extreme' } }
      const days = Object.entries((r.body?.days || {}) as Record<string, string>).sort(([a], [b]) => a.localeCompare(b));
      if (!days.length) return { ok: true, text: `${bnDate(from)} থেকে ${bnDate(to)} পর্যন্ত আপনার কোনো দেরি নেই। 👍`, data: { from, to, days: [] } };
      const extreme = days.filter(([, k]) => k === "extreme").length;
      const lines = days.slice(0, 12).map(([d, k]) => `• ${bnDate(d)}${k === "extreme" ? " — অনেক দেরি" : ""}`).join("\n");
      return {
        ok: true,
        text: `${bnDate(from)} – ${bnDate(to)}: **${bn(days.length)} দিন দেরি**${extreme ? ` (এর মধ্যে ${bn(extreme)} দিন অনেক দেরি)` : ""}\n${lines}${days.length > 12 ? `\n…আরও ${bn(days.length - 12)} দিন` : ""}`,
        data: { from, to, late_days: days.map(([d, k]) => ({ date: d, kind: k === "extreme" ? "extreme_late" : "late" })) },
        report: report("My Late Days", `My-Late-Days-${from}-to-${to}`, ["Date", "Late"], days.map(([d, k]) => [enDate(d), k === "extreme" ? "Extreme late" : "Late"]),
          [["Employee", c.name], ["Period", `${enDate(from)} - ${enDate(to)}`], ["Late days", String(days.length)]])
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
      if (b.linked === false) return notLinked(c, "loan / advance-এর হিসাব");
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
  {
    name: "prepare_leave_application",
    description:
      "Fill in (do NOT submit) a leave application for the asking employee. The app shows it as an editable card and the employee submits it themselves. " +
      "Use when they ask to apply for / take leave. Resolve relative dates against today. leave_type: casual | sick | without_pay | a custom key, or omit to let them pick.",
    params: {
      start_date: { type: "string", description: "First day of leave, YYYY-MM-DD" },
      end_date: { type: "string", description: "Last day of leave, YYYY-MM-DD (same as start for one day)" },
      leave_type: { type: "string", description: "casual, sick, without_pay or a custom leave key; omit if not stated" },
      purpose: { type: "string", description: "Reason in the employee's words, short" },
      is_half_day: { type: "boolean", description: "true for a half day" }
    },
    available: (c) => isSuper(c) || c.flags.can_view_leave_application,
    run: async (c, args) => {
      const [cats, pols, rels, bal] = await Promise.all([
        callApi(c.req, "/api/leave-categories"),
        callApi(c.req, "/api/leave-policies"),
        callApi(c.req, "/api/leave-applications/relievers"),
        callApi(c.req, "/api/leave-balances/mine")
      ]);
      if (!rels.ok && rels.status === 403) return NO_ACCESS;
      const policy = new Map<string, boolean>((Array.isArray(pols.body) ? pols.body : []).map((p: any) => [String(p.category_key), !!p.reliever_required]));
      const b = Array.isArray(bal.body) ? bal.body[0] : null;
      const types = [
        { value: "casual", label: "Casual Leave", balance: b ? Number(b.casual_leave) : null },
        { value: "sick", label: "Sick Leave", balance: b ? Number(b.sick_leave) : null },
        { value: "without_pay", label: "Leave Without Pay", balance: null },
        ...(Array.isArray(cats.body) ? cats.body : []).map((x: any) => ({
          value: String(x.key), label: String(x.label),
          balance: b ? Number((b.custom_leaves || []).find((y: any) => y.key === x.key)?.balance ?? 0) : null
        }))
      ].map((x) => ({ ...x, reliever_required: policy.has(x.value) ? policy.get(x.value)! : true }));
      const isDate = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
      const start = isDate(args?.start_date) ? String(args.start_date) : "";
      const end = isDate(args?.end_date) && String(args.end_date) >= start ? String(args.end_date) : start;
      const leaveType = types.some((x) => x.value === args?.leave_type) ? String(args.leave_type) : "casual";
      const draft: LeaveDraft = {
        kind: "leave_application",
        leave_type: leaveType,
        start_date: start,
        end_date: end,
        is_half_day: !!args?.is_half_day,
        purpose: String(args?.purpose || "").slice(0, 300),
        today: c.today,
        types,
        relievers: (Array.isArray(rels.body) ? rels.body : []).filter((r: any) => Number(r.id) !== c.userId).map((r: any) => ({ id: Number(r.id), name: String(r.name) }))
      };
      const missing = [!start && "তারিখ", !draft.purpose && "কারণ"].filter(Boolean);
      const text = `ছুটির আবেদনের খসড়া তৈরি করেছি${start ? ` — ${bnDate(start)}${end !== start ? ` থেকে ${bnDate(end)}` : ""}` : ""}। ` +
        (missing.length ? `${missing.join(" আর ")} দিয়ে দিন, ` : "") + "নিচে সব দেখে **জমা দিন** চাপুন। আপনি না চাপলে কিছু জমা হবে না।";
      return { ok: true, text, draft, data: { drafted: true, submitted: false, leave_type: leaveType, start_date: start, end_date: end, purpose: draft.purpose, note: "Shown to the user as a form; they must review it and press Submit themselves." } };
    }
  },
  {
    name: "prepare_ride_booking",
    description:
      "Fill in (do NOT submit) a Book a Ride request (an office car) for the asking employee. The app shows it as an editable card and the employee submits it themselves. " +
      "Use when they ask to book / need a car or ride. Resolve relative dates against today. start_time 24-hour HH:MM.",
    params: {
      pickup_location: { type: "string", description: "Where from, as they said it (e.g. 'Head Office')" },
      destination: { type: "string", description: "Where to" },
      ride_date: { type: "string", description: "YYYY-MM-DD" },
      start_time: { type: "string", description: "HH:MM, 24-hour" },
      estimated_duration_hours: { type: "number", description: "How long they need the car, in hours (0.25 to 240); omit if not said" },
      purpose: { type: "string", description: "Why, short, in their words" },
      self_drive: { type: "boolean", description: "true if they will drive themselves" }
    },
    run: async (c, args) => {
      const isDate = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
      const date = isDate(args?.ride_date) && String(args.ride_date) >= c.today ? String(args.ride_date) : c.today;
      const time = /^\d{1,2}:\d{2}$/.test(String(args?.start_time || "")) ? String(args.start_time).padStart(5, "0") : "";
      const hours = Number(args?.estimated_duration_hours);
      let selfNote: string | null = null;
      let selfDrive = !!args?.self_drive;
      if (selfDrive) {
        const chk = await callApi(c.req, `/api/vehicles/self-drive-check?ride_date=${date}`);
        if (chk.ok && chk.body && !chk.body.allowed) {
          selfDrive = false;
          selfNote = String(chk.body.reason || "Self-drive isn't allowed for this ride.");
        }
      }
      const draft: RideDraft = {
        kind: "ride_booking",
        purpose: String(args?.purpose || "").slice(0, 300),
        pickup_location: String(args?.pickup_location || "").slice(0, 200),
        destination: String(args?.destination || "").slice(0, 200),
        ride_date: date,
        start_time: time,
        estimated_duration_hours: Number.isFinite(hours) && hours > 0 ? Math.min(240, hours) : 1,
        self_drive: selfDrive,
        self_drive_note: selfNote,
        today: c.today
      };
      const missing = [!draft.pickup_location && "কোথা থেকে", !draft.destination && "কোথায়", !time && "সময়", !draft.purpose && "উদ্দেশ্য"].filter(Boolean);
      const text = `গাড়ির requisition-এর খসড়া তৈরি করেছি — ${bnDate(date)}${time ? `, ${bn(time)}` : ""}${draft.destination ? `, ${draft.destination}` : ""}। ` +
        (missing.length ? `${missing.join(", ")} দিয়ে দিন, ` : "") + "নিচে সব দেখে **Book করুন** চাপুন। আপনি না চাপলে কিছু জমা হবে না।";
      return { ok: true, text, draft, data: { drafted: true, submitted: false, ...draft, note: "Shown to the user as a form; they must review it and press Book themselves." } };
    }
  },
  {
    name: "prepare_attendance_correction",
    description:
      "Fill in (do NOT submit) a Timesheet attendance correction (Correct Attendance: set a day's In / Out time, e.g. forgot to check in) for the asking employee. " +
      "The app shows an editable card; the employee submits it. attendance_date YYYY-MM-DD, never in the future ('kal' about a past punch means yesterday). Times 24-hour HH:MM.",
    params: {
      attendance_date: { type: "string", description: "The day to correct, YYYY-MM-DD" },
      check_in: { type: "string", description: "In time HH:MM, 24-hour; omit if not said" },
      check_out: { type: "string", description: "Out time HH:MM, 24-hour; omit if not said" },
      remarks: { type: "string", description: "Why, short, in their words" }
    },
    available: (c) => isSuper(c) || (c.flags.can_use_attendance && c.flags.can_view_timesheet),
    run: async (c, args) => {
      const isDate = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
      const date = isDate(args?.attendance_date) && String(args.attendance_date) <= c.today ? String(args.attendance_date) : c.today;
      const [mine, projects, me] = await Promise.all([callApi(c.req, "/api/attendance/mine"), callApi(c.req, "/api/projects/all"), callApi(c.req, "/api/auth/me")]);
      if (!mine.ok && mine.status === 403) return NO_ACCESS;
      const hhmm = (v: any) => /(\d{2}):(\d{2})/.exec(String(v || ""))?.slice(1, 3).join(":") || "";
      const day = (Array.isArray(mine.body) ? mine.body : []).filter((r: any) => String(r.attendance_date).slice(0, 10) === date);
      const all = Array.isArray(projects.body) ? projects.body : [];
      const pinned = Number(me.body?.user?.attendance_project_id ?? me.body?.attendance_project_id) || 0;
      const nameOf = (id: number) => all.find((p: any) => Number(p.id) === id)?.project_name || `Project #${id}`;
      const options = pinned
        ? [{ project_id: pinned, name: nameOf(pinned), check_in: hhmm(day[0]?.check_in_at), check_out: hhmm(day[0]?.check_out_at) }]
        : day.length
          ? day.filter((r: any) => Number(r.project_id) > 0).map((r: any) => ({ project_id: Number(r.project_id), name: r.project_name || nameOf(Number(r.project_id)), check_in: hhmm(r.check_in_at), check_out: hhmm(r.check_out_at) }))
          : [];
      const fallback = options.length ? options : all.slice(0, 200).map((p: any) => ({ project_id: Number(p.id), name: String(p.project_name), check_in: "", check_out: "" }));
      const draft: CorrectionDraft = {
        kind: "attendance_correction",
        attendance_date: date,
        check_in: /^\d{1,2}:\d{2}$/.test(String(args?.check_in || "")) ? String(args.check_in).padStart(5, "0") : fallback[0]?.check_in || "",
        check_out: /^\d{1,2}:\d{2}$/.test(String(args?.check_out || "")) ? String(args.check_out).padStart(5, "0") : fallback[0]?.check_out || "",
        remarks: String(args?.remarks || "").slice(0, 250),
        options: fallback,
        today: c.today
      };
      const onRecord = day[0] ? `রেকর্ডে আছে ইন ${bn(hhmm(day[0].check_in_at) || "—")}, আউট ${bn(hhmm(day[0].check_out_at) || "—")}। ` : "ওই দিনের কোনো হাজিরা রেকর্ডে নেই। ";
      const text = `${bnDate(date)}-এর হাজিরা ঠিক করার খসড়া তৈরি করেছি। ${onRecord}নিচে ইন / আউট সময় আর কারণ দেখে **Submit করুন** চাপুন — এটা অনুমোদনের জন্য যাবে; আপনি না চাপলে কিছু জমা হবে না।`;
      return { ok: true, text, draft, data: { drafted: true, submitted: false, attendance_date: date, check_in: draft.check_in, check_out: draft.check_out, on_record: day.map((r: any) => ({ project: r.project_name, in: hhmm(r.check_in_at), out: hhmm(r.check_out_at) })), note: "Shown to the user as a form; they must review it and press Submit themselves." } };
    }
  },
  {
    name: "prepare_movement_claim",
    description:
      "Movement Claim (GPS travel record for office work): prepare (do NOT submit) a Check In with a purpose when they are heading out (client visit, bank, site…), " +
      "or a Check Out of their open claim when they have reached / finished. The card takes the phone's location when the employee presses its button. " +
      "action: check_in | check_out (omit to decide from whether a claim is open).",
    params: {
      action: { type: "string", description: "check_in or check_out" },
      purpose: { type: "string", description: "Where / why they are going, short, their words (check_in)" },
      remarks: { type: "string", description: "Optional note" }
    },
    available: (c) => isSuper(c) || c.flags.can_view_movement_claims,
    run: async (c, args) => {
      const st = await callApi(c.req, "/api/claims/status");
      if (!st.ok && st.status === 403) return NO_ACCESS;
      const open = st.ok && st.body && st.body.id ? st.body : null;
      const want = args?.action === "check_out" || args?.action === "check_in" ? String(args.action) : open ? "check_out" : "check_in";
      const remarks = String(args?.remarks || "").slice(0, 300);
      const nav = [{ label: "Movement Claim খুলুন", nav: "claims:movementClaims" }];
      if (want === "check_out" && !open) {
        return { ok: true, text: "আপনার কোনো Movement Claim খোলা নেই — আগে Check In করতে হবে। কোথায় যাচ্ছেন বললে Check In-এর কার্ড দিয়ে দেব।", data: { open_claim: null }, actions: nav };
      }
      if (open) {
        const since = String(open.check_in_at || "");
        const draft: MovementDraft = { kind: "movement_claim", mode: "check_out", purpose: String(open.purpose || ""), remarks, claim_id: Number(open.id), since };
        const pre = want === "check_in" ? "আগের Movement Claim এখনো খোলা — নতুনটা শুরু করার আগে সেটার Check Out করতে হবে। " : "";
        return {
          ok: true,
          text: `${pre}খোলা Claim: **${draft.purpose}** (Check In ${bnDate(since.slice(0, 10))} ${bn(since.slice(11, 16))})। পৌঁছে বা কাজ শেষে নিচে **Check Out** চাপুন — তখনকার লোকেশন নেওয়া হবে।`,
          draft,
          data: { drafted: true, submitted: false, mode: "check_out", open_claim: { purpose: draft.purpose, since }, note: "The card takes the phone's location when they press Check Out." }
        };
      }
      const draft: MovementDraft = { kind: "movement_claim", mode: "check_in", purpose: String(args?.purpose || "").slice(0, 255), remarks, claim_id: null, since: null };
      return {
        ok: true,
        text: `Movement Claim-এর Check In তৈরি${draft.purpose ? ` — **${draft.purpose}**` : ""}। ${draft.purpose ? "" : "কোথায় / কেন যাচ্ছেন লিখে দিন, "}বের হওয়ার সময় নিচে **Check In** চাপুন — তখনকার লোকেশন নেওয়া হবে। আপনি না চাপলে কিছু জমা হবে না।`,
        draft,
        data: { drafted: true, submitted: false, mode: "check_in", purpose: draft.purpose, note: "The card takes the phone's location when they press Check In." }
      };
    }
  },
  // ---- Reports (each through the report's own API with the asker's token,
  // so the asker sees exactly what that report page would show them) ----
  {
    name: "company_report",
    description:
      "Run one of the Reports & Insights reports (the API checks the module and Department scope): " +
      "attendance_summary (per person: working / present / absent / leave / late %), attendance_daily (day-by-day log), remote_attendance (GPS check-in/out with distance), " +
      "movement_claims, bill_claims, bill_claim_categories (bill claims by category), conveyance_bills, bill_disbursements (paid / unpaid bills), " +
      "leave_applications, leave_taken (leave days by type per person), asset_register, asset_assignments (handover history), asset_requisitions, vehicle_rides (ride history), vehicle_utilization. " +
      "from / to YYYY-MM-DD (default this month), optional department, employee (name or ID), status.",
    params: {
      report: { type: "string", description: "One of the report keys above" },
      from: { type: "string", description: "YYYY-MM-DD" },
      to: { type: "string", description: "YYYY-MM-DD" },
      department: { type: "string", description: "Department name (optional)" },
      employee: { type: "string", description: "Employee name or ID (optional)" },
      status: { type: "string", description: "Status filter (optional)" }
    },
    available: (c) => isSuper(c) || c.role === "admin" || c.modules.length > 0,
    run: async (c, args) => {
      const key = String(args?.report || "").trim();
      if (!REPORT_KEYS.includes(key)) return { ok: false, text: "কোন রিপোর্ট চান বুঝতে পারিনি — যেমন: হাজিরার সারাংশ, ছুটির ধরন অনুযায়ী, bill claim, disbursement, asset register, ride history।", data: { error: "unknown_report", reports: REPORT_KEYS } };
      const isDate = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
      const body = {
        key,
        from: isDate(args?.from) ? args.from : `${c.today.slice(0, 7)}-01`,
        to: isDate(args?.to) ? args.to : c.today,
        department: String(args?.department || ""),
        employee: String(args?.employee || ""),
        status: String(args?.status || "")
      };
      const r = await callApiPost(c.req, "/api/reports-insights/run", body);
      if (!r.ok) return r.status === 400 ? { ok: false, text: String(r.body?.error || "রিপোর্টটা চালানো গেল না।"), data: { error: r.body?.error } } : fail(r.status);
      const cols: { key: string; label: string }[] = r.body?.columns || [];
      const rows: any[] = r.body?.rows || [];
      const summary: { label: string; value: any }[] = r.body?.summary || [];
      const show = cols.slice(0, 5);
      const line = (x: any) => "• " + show.map((col) => x[col.key]).filter((v) => v !== null && v !== undefined && v !== "").map(String).join(" · ");
      const period = r.body?.from ? ` (${bnDate(r.body.from)} – ${bnDate(r.body.to)})` : "";
      const text =
        `**${r.body?.title || key}**${period}${body.department ? ` — ${body.department}` : ""}\n` +
        (summary.length ? summary.map((x) => `${x.label}: **${typeof x.value === "number" ? bn(x.value) : x.value}**`).join(" · ") + "\n" : "") +
        (rows.length ? rows.slice(0, 15).map(line).join("\n") + (rows.length > 15 ? `\n…আরও ${bn(rows.length - 15)}টি সারি (পুরোটা PDF / Excel-এ)` : "") : "এই সময়ে কিছু নেই।");
      return {
        ok: true,
        text,
        data: { report: key, from: r.body?.from, to: r.body?.to, summary, rows: rows.slice(0, 60), total_rows: rows.length },
        actions: [{ label: "Reports & Insights খুলুন", nav: "admin:reports_insights" }],
        report: report(String(r.body?.title || key), `${key}-${body.from}-${body.to}`, cols.map((x) => x.label), rows.map((x) => cols.map((col) => (x[col.key] === null || x[col.key] === undefined ? "" : typeof x[col.key] === "number" ? x[col.key] : String(x[col.key])))),
          [["Period", r.body?.from ? `${enDate(r.body.from)} – ${enDate(r.body.to)}` : "-"], ...(body.department ? [["Department", body.department] as [string, string]] : []), ...summary.map((x) => [x.label, String(x.value)] as [string, string])])
      };
    }
  },
  {
    name: "attendance_custom_report",
    description:
      "Attendance Report Builder: answer any attendance question with conditions, per person per day, over a period (from / to YYYY-MM-DD, default today; at most 92 days). " +
      "Conditions: in_after / in_before / out_before / out_after (HH:MM 24-hour), status (present | absent | leave | holiday | weekend), late (any | delay | extreme), " +
      "missing_out (true = checked in but no check-out), min_hours / max_hours (work hours), overtime (true), early_leave (true = left before shift / office end), office_end (HH:MM, default 18:00). " +
      "view detail (rows) or summary with group_by employee | department | designation | date | weekday; min_count with count_of (late | absent | leave | missing_out | early_leave | overtime_days | present) keeps only groups with at least that many — e.g. 'late 3+ times this month' = view summary, group_by employee, late any, min_count 3. department / employee narrow it.",
    params: {
      from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" },
      in_after: { type: "string", description: "HH:MM" }, in_before: { type: "string", description: "HH:MM" }, out_before: { type: "string", description: "HH:MM" }, out_after: { type: "string", description: "HH:MM" },
      status: { type: "string", description: "present | absent | leave | holiday | weekend" }, late: { type: "string", description: "any | delay | extreme" },
      missing_out: { type: "boolean", description: "Checked in, no check-out" }, min_hours: { type: "number", description: "Worked at least" }, max_hours: { type: "number", description: "Worked less than" },
      overtime: { type: "boolean", description: "Worked past the shift / office end" }, early_leave: { type: "boolean", description: "Left before the shift / office end" }, office_end: { type: "string", description: "HH:MM" },
      view: { type: "string", description: "detail | summary" }, group_by: { type: "string", description: "employee | department | designation | date | weekday" },
      min_count: { type: "number", description: "Only groups with at least this many (summary)" }, count_of: { type: "string", description: "What min_count counts" },
      department: { type: "string", description: "Department (optional)" }, employee: { type: "string", description: "Name or employee ID (optional)" }
    },
    available: (c) => hasMod(c, "attendance_reports"),
    run: async (c, args) => {
      const isDate = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
      const hm = (v: any) => (/^\d{1,2}:\d{2}$/.test(String(v || "")) ? String(v).padStart(5, "0") : "");
      // "3 bar er beshi late" with no period = this month so far.
      const from = isDate(args?.from) ? String(args.from) : Number(args?.min_count) > 0 ? `${c.today.slice(0, 7)}-01` : c.today;
      const to = isDate(args?.to) ? String(args.to) : isDate(args?.from) ? from : c.today;
      const conds: any[] = [];
      if (hm(args?.in_after)) conds.push({ field: "in_time", op: "after", value: hm(args.in_after) });
      if (hm(args?.in_before)) conds.push({ field: "in_time", op: "before", value: hm(args.in_before) });
      if (hm(args?.out_before)) conds.push({ field: "out_time", op: "before", value: hm(args.out_before) });
      if (hm(args?.out_after)) conds.push({ field: "out_time", op: "after", value: hm(args.out_after) });
      if (["present", "absent", "leave", "holiday", "weekend"].includes(String(args?.status))) conds.push({ field: "status", op: "in", value: [String(args.status)] });
      if (args?.late === "delay" || args?.late === "extreme") conds.push({ field: "late", op: "in", value: [String(args.late)] });
      else if (args?.late === "any") conds.push({ field: "late", op: "in", value: ["delay", "extreme"] });
      if (args?.missing_out === true) conds.push({ field: "missing_out", op: "is_true", value: true });
      if (Number(args?.min_hours) > 0) conds.push({ field: "work_hours", op: "gte", value: Number(args.min_hours) });
      if (Number(args?.max_hours) > 0) conds.push({ field: "work_hours", op: "lt", value: Number(args.max_hours) });
      if (args?.overtime === true) conds.push({ field: "overtime_minutes", op: "gt", value: 0 });
      if (args?.early_leave === true) conds.push({ field: "early_leave_minutes", op: "gt", value: 0 });
      const view = args?.view === "summary" || args?.min_count ? "summary" : "detail";
      const groupBy = ["employee", "department", "designation", "date", "weekday"].includes(String(args?.group_by)) ? String(args.group_by) : "employee";
      const countOf = ["late", "absent", "leave", "missing_out", "early_leave", "overtime_days", "present", "delay", "extreme"].includes(String(args?.count_of))
        ? String(args.count_of)
        : args?.late ? "late" : args?.status === "absent" ? "absent" : args?.status === "leave" ? "leave" : args?.missing_out ? "missing_out" : args?.early_leave ? "early_leave" : args?.overtime ? "overtime_days" : "days";
      const body = {
        from, to, conditions: conds, match: "all", view, group_by: groupBy,
        having: Number(args?.min_count) > 0 ? { metric: countOf, op: "gte", value: Number(args.min_count) } : null,
        sort: view === "summary" ? countOf : "",
        office_end: hm(args?.office_end) || "18:00",
        departments: [], employee: String(args?.employee || "")
      };
      const r = await callApiPost(c.req, "/api/attendance/report/custom", body);
      if (!r.ok) return r.status === 400 ? { ok: false, text: String(r.body?.error || ""), data: { error: r.body?.error } } : fail(r.status);
      const dq = String(args?.department || "").trim().toLowerCase();
      const sm = /^\d{4}-\d{2}$/.test(String(args?.salary_month || "")) ? String(args.salary_month) : "";
      const when = (sm && salaryMonthStartsLater(c) ? `বেতনের মাস ${bnMonth(sm)}, ` : "") + (from === to ? bnDate(from) : `${bnDate(from)} – ${bnDate(to)}`);
      const condText = [
        hm(args?.in_after) && `${bn(hm(args.in_after))}-এর পরে এসেছেন`, hm(args?.in_before) && `${bn(hm(args.in_before))}-এর আগে এসেছেন`,
        hm(args?.out_before) && `${bn(hm(args.out_before))}-এর আগে বের হয়েছেন`, hm(args?.out_after) && `${bn(hm(args.out_after))}-এর পরে বের হয়েছেন`,
        args?.status === "absent" && "অনুপস্থিত", args?.status === "leave" && "ছুটিতে", args?.status === "present" && "উপস্থিত",
        args?.late === "extreme" ? "অনেক দেরি" : args?.late === "delay" ? "দেরি" : args?.late === "any" ? "দেরি / অনেক দেরি" : "",
        args?.missing_out && "check-out দেননি", Number(args?.max_hours) > 0 && `${bn(args.max_hours)} ঘণ্টার কম কাজ`, Number(args?.min_hours) > 0 && `${bn(args.min_hours)} ঘণ্টা বা বেশি কাজ`,
        args?.overtime && "overtime", args?.early_leave && "আগেই বের হয়েছেন"
      ].filter(Boolean).join(", ");
      if (view === "summary") {
        const groups: any[] = (r.body?.groups || []).filter((g: any) => !dq || String(g.key || "").toLowerCase().includes(dq) || String(g.department || "").toLowerCase().includes(dq));
        const BY: Record<string, string> = { employee: "কর্মী", department: "Department", designation: "পদ", date: "দিন", weekday: "বার" };
        const text = `**হাজিরা — ${when}**${condText ? ` (${condText})` : ""}, ${BY[groupBy]} অনুযায়ী${body.having ? `, ${bn(body.having.value)} বা বেশি` : ""}: ${bn(groups.length)}টি\n` +
          groups.slice(0, 15).map((g) => `• **${g.key}**${g.department && groupBy === "employee" ? ` (${g.department})` : ""}: উপস্থিত ${bn(g.present)}, অনুপস্থিত ${bn(g.absent)}, ছুটি ${bn(g.leave)}, দেরি ${bn(g.late)}${g.extreme ? ` (অনেক ${bn(g.extreme)})` : ""}${g.missing_out ? `, check-out নেই ${bn(g.missing_out)}` : ""}${g.early_leave ? `, আগে বের ${bn(g.early_leave)}` : ""}${g.overtime_days ? `, overtime ${bn(g.overtime_days)} দিন (${bn(g.total_ot_hours)} ঘণ্টা)` : ""}${g.avg_in ? `, গড় ইন ${bn(g.avg_in)}` : ""}`).join("\n") +
          (groups.length > 15 ? `\n…আরও ${bn(groups.length - 15)}টি (পুরোটা PDF / Excel-এ)` : "") + (groups.length ? "" : "এই শর্তে কেউ নেই।");
        return {
          ok: true, text, data: { from, to, group_by: groupBy, groups: groups.slice(0, 40) },
          actions: [{ label: "Attendance Report Builder খুলুন", nav: "admin:attendance_reports#custom" }],
          report: report("Attendance Report", `Attendance-Report-${from}-${to}`, [BY[groupBy], ...(groupBy === "employee" ? ["Department"] : []), "Employees", "Days", "Present", "Absent", "Leave", "Late", "Extreme", "No check-out", "Left early", "Overtime days", "Avg in", "Avg out", "Avg hours", "OT hours", "Attendance %"],
            groups.map((g) => [g.key, ...(groupBy === "employee" ? [g.department || ""] : []), g.employees, g.days, g.present, g.absent, g.leave, g.late, g.extreme, g.missing_out, g.early_leave, g.overtime_days, g.avg_in || "", g.avg_out || "", g.avg_hours ?? "", g.total_ot_hours, g.attendance_pct ?? ""]),
            [["Period", `${enDate(from)} – ${enDate(to)}`], ...(condText ? [["Conditions", condText] as [string, string]] : [])])
        };
      }
      const rows: any[] = (r.body?.rows || []).filter((x: any) => !dq || String(x.department || "").toLowerCase().includes(dq));
      const line = (x: any) => `• **${x.employee_name}**${x.department ? ` — ${x.department}` : ""}${from !== to ? `, ${bnDate(x.date)}` : ""}: ${x.status === "present" ? `ইন ${bn(x.in_time || "—")}, আউট ${bn(x.out_time || "—")}${x.late !== "none" ? (x.late === "extreme" ? " · অনেক দেরি" : " · দেরি") : ""}` : x.status === "absent" ? "অনুপস্থিত" : x.status === "leave" ? `ছুটি${x.leave_type ? ` (${x.leave_type})` : ""}` : x.status}`;
      const text = `**হাজিরা — ${when}**${condText ? ` (${condText})` : ""}: ${bn(rows.length)}টি\n` + (rows.length ? rows.slice(0, 20).map(line).join("\n") + (rows.length > 20 ? `\n…আরও ${bn(rows.length - 20)}টি (পুরোটা PDF / Excel-এ)` : "") : "এই শর্তে কেউ নেই।");
      return {
        ok: true, text, data: { from, to, total: rows.length, rows: rows.slice(0, 50).map((x) => ({ date: x.date, name: x.employee_name, department: x.department, status: x.status, in: x.in_time, out: x.out_time, late: x.late, hours: x.work_hours })) },
        actions: [{ label: "Attendance Report Builder খুলুন", nav: "admin:attendance_reports#custom" }],
        report: report("Attendance Report", `Attendance-Report-${from}-${to}`, ["Date", "Name", "Employee ID", "Department", "Status", "In", "Out", "Hours", "Late", "Minutes late", "Left early (min)", "Overtime (min)", "No check-out"],
          rows.map((x) => [x.date, x.employee_name, x.employee_code, x.department, x.status, x.in_time || "", x.out_time || "", x.work_hours ?? "", x.late === "none" ? "" : x.late, x.late_minutes || "", x.early_leave_minutes || "", x.overtime_minutes || "", x.missing_out ? "Yes" : ""]),
          [["Period", `${enDate(from)} – ${enDate(to)}`], ...(condText ? [["Conditions", condText] as [string, string]] : [])])
      };
    }
  },
  {
    name: "attendance_department_summary",
    description: "Monthly Attendance Report -> Department Summary: per department Present / Absent / Leave / Delay / Extreme Delay and attendance %, for one day (date) or a whole month (month YYYY-MM, person-days).",
    params: { date: { type: "string", description: "YYYY-MM-DD for one day" }, month: { type: "string", description: "YYYY-MM for a whole month" } },
    available: (c) => hasMod(c, "attendance_reports"),
    run: async (c, args) => {
      const month = /^\d{4}-\d{2}$/.test(String(args?.month || "")) ? String(args.month) : "";
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.date || "")) ? String(args.date) : "";
      const q = month ? `mode=month&year=${month.slice(0, 4)}&month=${Number(month.slice(5, 7))}` : `mode=day&date=${date || c.today}`;
      const r = await callApi(c.req, `/api/attendance/report/department-summary?${q}`);
      if (!r.ok) return fail(r.status);
      const d: any[] = r.body?.departments || [];
      const t = r.body?.total || {};
      const when = month ? bnMonth(month) : bnDate(date || c.today);
      const pct = (v: any) => (v == null ? "—" : `${bn(v)}%`);
      const text = `**Department অনুযায়ী হাজিরা — ${when}**${month ? " (person-days)" : ""}\n` +
        d.map((x) => `• **${x.department}** (${bn(x.employees)} জন): উপস্থিত ${bn(x.present)}, অনুপস্থিত ${bn(x.absent)}, ছুটি ${bn(x.leave)}, দেরি ${bn(x.delay)}, অনেক দেরি ${bn(x.extreme)} — ${pct(x.attendance_pct)}`).join("\n") +
        `\nমোট: উপস্থিত ${bn(t.present || 0)}, অনুপস্থিত ${bn(t.absent || 0)}, ছুটি ${bn(t.leave || 0)}, দেরি ${bn(t.delay || 0)}, অনেক দেরি ${bn(t.extreme || 0)} — ${pct(t.attendance_pct)}`;
      return {
        ok: true, text, data: { when: month || date || c.today, departments: d, total: t },
        actions: [{ label: "Monthly Attendance Report খুলুন", nav: "admin:attendance_reports#dept" }],
        report: report("Department Attendance Summary", `Department-Attendance-${month || date || c.today}`, ["Department", "Employees", "Present", "Absent", "Leave", "Delay", "Extreme Delay", "Attendance %"],
          [...d.map((x) => [x.department, x.employees, x.present, x.absent, x.leave, x.delay, x.extreme, x.attendance_pct ?? ""]), ["All departments", t.employees, t.present, t.absent, t.leave, t.delay, t.extreme, t.attendance_pct ?? ""]],
          [[month ? "Month" : "Date", month || enDate(date || c.today)]])
      };
    }
  },
  {
    name: "payroll_salary_sheet",
    description: "Payroll -> Approval -> Salary sheet: every employee's salary for a month — gross, deductions, net, absent / late cuts, held, change from last month. month_year YYYY-MM (default this month). Optional name / department to narrow.",
    params: { month_year: { type: "string", description: "YYYY-MM" }, name: { type: "string", description: "Employee name / ID or department (optional)" } },
    available: (c) => hasMod(c, "payroll"),
    run: async (c, args) => {
      const month = /^\d{4}-\d{2}$/.test(String(args?.month_year || "")) ? String(args.month_year) : c.today.slice(0, 7);
      const r = await callApi(c.req, `/api/payroll/approval/${month}/salary-sheet`);
      if (!r.ok) return fail(r.status);
      const q = String(args?.name || "").trim().toLowerCase();
      const rows: any[] = (r.body?.rows || []).filter((x: any) => !q || [x.employee_name, x.employee_code, x.department, x.designation].some((v) => String(v || "").toLowerCase().includes(q)));
      if (!rows.length) return { ok: true, text: `${bnMonth(month)}-এর কোনো বেতন${q ? ` "${args.name}"-এর` : ""} পাওয়া যায়নি।`, data: { month, rows: [] } };
      const sum = (k: string) => rows.reduce((a, x) => a + (Number(x[k]) || 0), 0);
      const tk = (v: number) => `৳${bn(Math.round(v).toLocaleString("en-IN"))}`;
      const held = rows.filter((x) => x.status === "held");
      const cut = rows.filter((x) => x.absent_deduction > 0 || x.late_deduction > 0).sort((a, b) => b.absent_deduction + b.late_deduction - a.absent_deduction - a.late_deduction);
      const text = `**বেতন — ${bnMonth(month)}**${q ? ` (${args.name})` : ""}: ${bn(rows.length)} জন, Gross ${tk(sum("gross"))}, কর্তন ${tk(sum("total_deduction"))}, Net **${tk(sum("net"))}**` +
        (held.length ? `\nহোল্ডে: ${held.map((x) => x.employee_name).join(", ")}` : "") +
        (cut.length ? `\nঅনুপস্থিতি / দেরিতে কাটা সবচেয়ে বেশি:\n` + cut.slice(0, 8).map((x) => `• ${x.employee_name} — ${tk(x.absent_deduction + x.late_deduction)} (অনুপস্থিত ${bn(x.absent_days)}, LWP ${bn(x.lwp_days)}, late ${bn(x.late_count)})`).join("\n") : "") +
        (rows.length <= 10 ? "\n" + rows.map((x) => `• ${x.employee_name}: Gross ${tk(x.gross)}, Net ${tk(x.net)}`).join("\n") : "");
      return {
        ok: true, text, data: { month, count: rows.length, gross: sum("gross"), net: sum("net"), deductions: sum("total_deduction"), held: held.map((x) => x.employee_name), rows: rows.slice(0, 40).map((x) => ({ name: x.employee_name, department: x.department, gross: x.gross, deductions: x.total_deduction, net: x.net, last_net: x.last_net, status: x.status })) },
        actions: [{ label: "Payroll খুলুন", nav: "self:payroll" }],
        report: report("Salary Sheet", `Salary-Sheet-${month}`, ["Employee ID", "Name", "Department", "Working", "Present", "Absent", "Leave", "LWP", "Late", "Gross", "Absent / late cut", "Other deductions", "Total deduction", "Net", "Last month net", "Status"],
          rows.map((x) => [x.employee_code, x.employee_name, x.department, x.working_days, x.present_days, x.absent_days, x.leave_days, x.lwp_days, x.late_count, x.gross, x.absent_deduction + x.late_deduction, x.tax + x.pf + x.advance + x.other_deduction + x.extra_deduction, x.total_deduction, x.net, x.last_net ?? "", x.status]),
          [["Month", month]])
      };
    }
  },
  {
    name: "payroll_month_comparison",
    description: "Payroll -> Approval -> Month comparison: this month's salaries vs last month (or vs a month) — total difference, who is new, who left (with exit reason), and why each person's net changed. month_year YYYY-MM (default this month), vs YYYY-MM optional.",
    params: { month_year: { type: "string", description: "YYYY-MM" }, vs: { type: "string", description: "YYYY-MM to compare with (optional)" } },
    available: (c) => hasMod(c, "payroll"),
    run: async (c, args) => {
      const month = /^\d{4}-\d{2}$/.test(String(args?.month_year || "")) ? String(args.month_year) : c.today.slice(0, 7);
      const vs = /^\d{4}-\d{2}$/.test(String(args?.vs || "")) ? `?vs=${args.vs}` : "";
      const r = await callApi(c.req, `/api/payroll/approval/${month}/compare${vs}`);
      if (!r.ok) return r.status === 400 ? { ok: false, text: String(r.body?.error || ""), data: {} } : fail(r.status);
      const b = r.body;
      const tk = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : ""}৳${bn(Math.abs(Math.round(v)).toLocaleString("en-IN"))}`;
      const people: any[] = b.people || [];
      const nw = people.filter((x) => x.kind === "new");
      const left = people.filter((x) => x.kind === "left");
      const changed = people.filter((x) => x.kind === "changed");
      const text = `**বেতনের তুলনা — ${bnMonth(b.month_year)} বনাম ${bnMonth(b.previous_month)}**\n` +
        `Net ${tk(b.summary.last_net).replace("+", "")} → ${tk(b.summary.this_net).replace("+", "")}, পার্থক্য **${tk(b.summary.diff)}**${b.summary.diff_pct != null ? ` (${bn(b.summary.diff_pct)}%)` : ""}\n` +
        (b.bridge || []).map((x: any) => `• ${x.label}: ${tk(x.amount)}`).join("\n") +
        (nw.length ? `\nনতুন: ${nw.map((x) => `${x.employee_name} (${x.why})`).join("; ")}` : "") +
        (left.length ? `\nচলে গেছেন / বেতন হয়নি: ${left.map((x) => `${x.employee_name} (${x.why})`).join("; ")}` : "") +
        (changed.length ? `\nসবচেয়ে বেশি বদল:\n` + changed.slice(0, 6).map((x) => `• ${x.employee_name} ${tk(x.diff)} — ${x.reasons.filter((y: any) => y.effect).map((y: any) => `${y.label} ${tk(y.effect)}${y.note ? ` (${y.note})` : ""}`).join("; ")}`).join("\n") : "");
      return {
        ok: true, text, data: { month: b.month_year, vs: b.previous_month, summary: b.summary, bridge: b.bridge, new: nw.map((x) => ({ name: x.employee_name, why: x.why, net: x.this_net })), left: left.map((x) => ({ name: x.employee_name, why: x.why, last_net: x.last_net })), changed: changed.slice(0, 30).map((x) => ({ name: x.employee_name, diff: x.diff, reasons: x.reasons })) },
        actions: [{ label: "Payroll খুলুন", nav: "self:payroll" }],
        report: report("Payroll Month Comparison", `Payroll-Comparison-${b.month_year}-vs-${b.previous_month}`, ["Employee ID", "Name", "Department", "Type", `Net ${b.previous_month}`, `Net ${b.month_year}`, "Difference", "Why"],
          people.map((x) => [x.employee_code, x.employee_name, x.department, x.kind, x.last_net ?? "", x.this_net ?? "", x.diff, x.why || x.reasons.map((y: any) => `${y.label} ${y.effect || ""}${y.note ? ` (${y.note})` : ""}`).join("; ")]),
          [["Month", b.month_year], ["Compared with", b.previous_month], ["Difference", String(b.summary.diff)]])
      };
    }
  },
  {
    name: "employee_records_report",
    description:
      "HR Operations -> Employee Reports (ready-made lists): salary_register (needs Payroll too), loans_outstanding (Payroll too), training_summary, pending_documents, missing_documents_by_type, nominee_gaps, " +
      "education_levels, experience_bands, unverified_records, no_education, joined_from_company, probation_ending, birthdays_this_month, anniversaries_this_month, assets_with_employees, blood_group_directory, headcount_list, leave_summary, claims_summary, monthly_attendance.",
    params: { preset: { type: "string", description: "One of the list names above" }, department: { type: "string", description: "Department (optional)" } },
    available: (c) => hasMod(c, "hr_operations"),
    run: async (c, args) => {
      const key = String(args?.preset || "").trim();
      const p = HR_PRESETS[key];
      if (!p) return { ok: false, text: "কোন তালিকা চান বুঝতে পারিনি — যেমন salary register, pending documents, nominee, training, blood group directory।", data: { error: "unknown_preset", presets: Object.keys(HR_PRESETS) } };
      const r = await callApiPost(c.req, "/api/hr-ops/reports/run", { filters: [], match: "all", group_by: null, month: "current", year: "current", include_inactive: false, ...p.config });
      if (!r.ok) return fail(r.status);
      const cols: any[] = r.body?.columns || [];
      const dept = String(args?.department || "").trim().toLowerCase();
      const rows: any[] = (r.body?.rows || []).filter((x: any) => !dept || String(x.department || "").toLowerCase().includes(dept));
      const val = (v: any) => (Array.isArray(v) ? v.join(", ") : v === true ? "Yes" : v === false ? "No" : v ?? "");
      const groups: any[] = r.body?.groups || [];
      const text = `**${p.title}** — ${bn(rows.length)} জন${dept ? ` (${args.department})` : ""}\n` +
        (groups.length && !dept ? groups.slice(0, 12).map((g) => `• ${g.key}: ${bn(g.count)} জন`).join("\n") + "\n" : "") +
        rows.slice(0, 15).map((x) => "• " + cols.slice(0, 4).map((col) => val(x[col.key])).filter((v) => v !== "").join(" · ")).join("\n") +
        (rows.length > 15 ? `\n…আরও ${bn(rows.length - 15)} জন (পুরোটা PDF / Excel-এ)` : "") +
        (cols.some((col) => col.payroll) || !p.payroll ? "" : "\n(বেতনের কলামগুলো আপনার account-এ Payroll না থাকায় দেখানো হয়নি।)");
      return {
        ok: true, text, data: { preset: key, total: rows.length, groups: groups.slice(0, 20), rows: rows.slice(0, 40).map((x) => Object.fromEntries(cols.map((col) => [col.label, val(x[col.key])]))) },
        actions: [{ label: "HR Operations → Reports খুলুন", nav: "hrops:reports" }],
        report: report(p.title, `${key}-${c.today}`, cols.map((col) => col.label), rows.map((x) => cols.map((col) => { const v = val(x[col.key]); return typeof v === "number" ? v : String(v); })))
      };
    }
  },
  {
    name: "mobile_bill_report",
    description: "Mobile Bill: the company's SIMs and bills for a month or range — total billed, over the limit (who, by how much), unpaid, SIM count by operator. from / to YYYY-MM (default this month).",
    params: { from: { type: "string", description: "YYYY-MM" }, to: { type: "string", description: "YYYY-MM" } },
    available: (c) => hasMod(c, "mobile_bill"),
    run: async (c, args) => {
      const to = /^\d{4}-\d{2}$/.test(String(args?.to || "")) ? String(args.to) : c.today.slice(0, 7);
      const from = /^\d{4}-\d{2}$/.test(String(args?.from || "")) ? String(args.from) : to;
      const r = await callApi(c.req, `/api/mobile-bill/report?from=${from}&to=${to}`);
      if (!r.ok) return fail(r.status);
      const sims: any[] = r.body?.sims || [];
      const bills: any[] = r.body?.bills || [];
      const simById = new Map<number, any>(sims.map((x) => [Number(x.id), x]));
      const over = bills.filter((b) => b.limit_amount > 0 && b.amount > b.limit_amount).sort((a, b) => b.amount - b.limit_amount - (a.amount - a.limit_amount));
      const tk = (v: number) => `৳${bn(Math.round(v).toLocaleString("en-IN"))}`;
      const who = (b: any) => simById.get(b.sim_id)?.employee?.name || simById.get(b.sim_id)?.phone_number || `SIM #${b.sim_id}`;
      const total = bills.reduce((a, b) => a + b.amount, 0);
      const text = `**Mobile Bill — ${bnMonth(from)}${from !== to ? ` থেকে ${bnMonth(to)}` : ""}**: SIM ${bn(sims.length)}টি, বিল ${bn(bills.length)}টি, মোট ${tk(total)}, অপরিশোধিত ${bn(bills.filter((b) => !b.paid).length)}টি` +
        (over.length ? `\nসীমার বেশি:\n` + over.slice(0, 10).map((b) => `• ${who(b)} (${b.month}) — ${tk(b.amount)}, সীমা ${tk(b.limit_amount)}, বেশি ${tk(b.amount - b.limit_amount)}`).join("\n") : "\nকেউ সীমার বেশি নয়।");
      return {
        ok: true, text, data: { from, to, sims: sims.length, bills: bills.length, total, over_limit: over.slice(0, 30).map((b) => ({ who: who(b), month: b.month, amount: b.amount, limit: b.limit_amount })) },
        actions: [{ label: "Mobile Bill খুলুন", nav: "admin:mobile_bill" }],
        report: report("Mobile Bill Report", `Mobile-Bill-${from}-${to}`, ["Month", "Phone", "Employee", "Department", "Operator", "Limit", "Bill", "Over limit", "Paid"],
          bills.map((b) => { const sm = simById.get(b.sim_id) || {}; return [b.month, sm.phone_number || "", sm.employee?.name || "", sm.employee?.department || "", sm.operator || "", b.limit_amount, b.amount, Math.max(0, b.amount - b.limit_amount), b.paid ? "Yes" : "No"]; }),
          [["From", from], ["To", to]])
      };
    }
  },
  {
    name: "tracking_overview",
    description: "Employee Tracking: who is sending their location now (live) and who isn't, with why (tracking off, no recent ping, standing still) — only the people this account may track.",
    available: (c) => hasMod(c, "tracking"),
    run: async (c) => {
      const r = await callApi(c.req, "/api/tracking/status");
      if (!r.ok) return fail(r.status);
      const emps: any[] = r.body?.employees || [];
      const on = emps.filter((x) => x.tracked);
      const off = emps.filter((x) => !x.tracked);
      const text = `**Employee Tracking — এখন**: ট্র্যাকিং-এ ${bn(on.length)} জন, নেই ${bn(off.length)} জন (গত ${bn(r.body?.live_minutes || 20)} মিনিটে লোকেশন)।` +
        (on.length ? "\nট্র্যাকিং-এ:\n" + on.slice(0, 15).map((x) => `• ${x.name}${x.department ? ` — ${x.department}` : ""}${x.minutes_ago != null ? `, ${bn(x.minutes_ago)} মিনিট আগে` : ""}${x.standing_still ? " · এক জায়গায় দাঁড়িয়ে" : ""}`).join("\n") : "") +
        (off.length ? "\nনেই:\n" + off.slice(0, 15).map((x) => `• ${x.name} — ${x.reason || "লোকেশন আসেনি"}`).join("\n") : "");
      return {
        ok: true, text, data: { tracked: on.length, not_tracked: off.length, people: emps.slice(0, 60).map((x) => ({ name: x.name, department: x.department, tracked: x.tracked, minutes_ago: x.minutes_ago, reason: x.reason })) },
        actions: [{ label: "Employee Tracking খুলুন", nav: "admin:tracking" }],
        report: report("Employee Tracking Status", `Tracking-${c.today}`, ["Name", "Employee ID", "Department", "Tracked now", "Minutes ago", "Standing still", "Why not"],
          emps.map((x) => [x.name, x.employee_id || "", x.department || "", x.tracked ? "Yes" : "No", x.minutes_ago ?? "", x.standing_still ? "Yes" : "", x.tracked ? "" : x.reason || ""]))
      };
    }
  },
  {
    name: "tracking_stay_report",
    description: "Employee Tracking -> Stay Report for one person: where they stayed and how long, between from and to (YYYY-MM-DD, default today), 09:00–18:00. name = the person.",
    params: { name: { type: "string", description: "Person's name or employee ID" }, from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" } },
    available: (c) => hasMod(c, "tracking"),
    run: async (c, args) => {
      const q = String(args?.name || "").trim().toLowerCase();
      if (!q) return { ok: false, text: "কার Stay Report চান? নাম লিখুন — যেমন \"Rahim-এর আজকের stay report\"।", data: { error: "need_name" } };
      const st = await callApi(c.req, "/api/tracking/status");
      if (!st.ok) return fail(st.status);
      const hit = (st.body?.employees || []).find((x: any) => [x.name, x.employee_id].some((v) => String(v || "").toLowerCase().includes(q)));
      if (!hit?.user_id) return { ok: true, text: `"${args.name}" নামে আপনার দেখার মধ্যে কাউকে পাওয়া যায়নি।`, data: { results: [] } };
      const isDate = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
      const from = isDate(args?.from) ? String(args.from) : c.today;
      const to = isDate(args?.to) ? String(args.to) : from;
      const r = await callApi(c.req, `/api/tracking/stay-report?user_id=${hit.user_id}&from=${from}&to=${to}`);
      if (!r.ok) return r.status === 400 ? { ok: false, text: String(r.body?.error || ""), data: {} } : fail(r.status);
      const stays: any[] = r.body?.stays || r.body?.rows || r.body?.days?.flatMap((d: any) => d.stays || []) || [];
      const place = (x: any) => x.place || x.address || x.label || (x.lat ? `${Number(x.lat).toFixed(4)}, ${Number(x.lng).toFixed(4)}` : "—");
      const mins = (x: any) => Number(x.minutes ?? x.duration_minutes ?? 0);
      const text = `**${hit.name}-এর Stay Report** (${bnDate(from)}${to !== from ? ` – ${bnDate(to)}` : ""}):\n` +
        (stays.length ? stays.slice(0, 15).map((x) => `• ${enTime(x.from || x.start || x.started_at)}–${enTime(x.to || x.end || x.ended_at)} ${place(x)}${mins(x) ? ` (${bn(mins(x))} মিনিট)` : ""}`).join("\n") : "এই সময়ে কোথাও থামার রেকর্ড নেই।");
      return {
        ok: true, text, data: { name: hit.name, from, to, stays: stays.slice(0, 40) },
        actions: [{ label: "Employee Tracking খুলুন", nav: "admin:tracking" }],
        report: report("Stay Report", `Stay-${hit.name}-${from}`, ["From", "To", "Place", "Minutes"], stays.map((x) => [String(x.from || x.start || x.started_at || ""), String(x.to || x.end || x.ended_at || ""), place(x), mins(x)]), [["Employee", hit.name], ["From", from], ["To", to]])
      };
    }
  },
  {
    name: "duty_roster_overview",
    description: "Duty Roster: who works which shift and who is Off, for a date range (from / to YYYY-MM-DD, default the next 7 days); name narrows to a person or department.",
    params: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" }, name: { type: "string", description: "Person or department (optional)" } },
    available: (c) => hasMod(c, "duty_roster"),
    run: async (c, args) => {
      const isDate = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
      const from = isDate(args?.from) ? String(args.from) : c.today;
      const to = isDate(args?.to) ? String(args.to) : addDays(from, 6);
      const [r, sh] = await Promise.all([callApi(c.req, `/api/roster?from=${from}&to=${to}`), callApi(c.req, "/api/roster/shifts")]);
      if (!r.ok) return fail(r.status);
      const shiftName = new Map<number, string>((Array.isArray(sh.body) ? sh.body : sh.body?.shifts || []).map((x: any) => [Number(x.id), `${x.name || x.title || "Shift"}${x.start_time ? ` ${enTime(x.start_time)}–${enTime(x.end_time)}` : ""}`]));
      const q = String(args?.name || "").trim().toLowerCase();
      const emps: any[] = (r.body?.employees || []).filter((e: any) => !q || [e.name, e.department, e.employee_code].some((v) => String(v || "").toLowerCase().includes(q)));
      const withRoster = emps.filter((e) => Object.keys(e.days || {}).length);
      const dates: string[] = [];
      for (let d = from; d <= to && dates.length < 31; d = addDays(d, 1)) dates.push(d);
      const cell = (e: any, d: string) => { const x = e.days?.[d]; return !x ? "" : x.is_off ? "Off" : shiftName.get(Number(x.shift_id)) || "Shift"; };
      const text = `**Duty Roster — ${bnDate(from)} থেকে ${bnDate(to)}**${q ? ` (${args.name})` : ""}: ${bn(withRoster.length)} জনের roster আছে, ${bn(emps.length - withRoster.length)} জনের নেই।\n` +
        withRoster.slice(0, 12).map((e) => `• ${e.name}: ` + dates.map((d) => cell(e, d)).map((v, i) => (v ? `${bn(dates[i].slice(8))}-${v}` : "")).filter(Boolean).join(", ")).join("\n");
      return {
        ok: true, text, data: { from, to, people: withRoster.slice(0, 40).map((e) => ({ name: e.name, department: e.department, days: Object.fromEntries(dates.map((d) => [d, cell(e, d)])) })) },
        actions: [{ label: "Duty Roster খুলুন", nav: "admin:duty_roster" }],
        report: report("Duty Roster", `Roster-${from}-${to}`, ["Name", "Department", ...dates], emps.map((e) => [e.name, e.department || "", ...dates.map((d) => cell(e, d))]), [["From", from], ["To", to]])
      };
    }
  },
  {
    name: "break_report",
    description: "Break Time report: breaks taken between from / to (YYYY-MM-DD, default today) — who took how many and how long, who went over the allowed minutes, who is on a break now.",
    params: { from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" } },
    available: (c) => hasMod(c, "break_time"),
    run: async (c, args) => {
      const isDate = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
      const from = isDate(args?.from) ? String(args.from) : c.today;
      const to = isDate(args?.to) ? String(args.to) : from;
      const r = await callApi(c.req, `/api/breaks/report?from=${from}&to=${to}`);
      if (!r.ok) return fail(r.status);
      const sum: any[] = r.body?.summary || [];
      const now: any[] = r.body?.on_break_now || [];
      const allowed = Number(r.body?.rules?.allowed_minutes) || 0;
      const name = (x: any) => x.name || x.employee_name || x.user_name || "—";
      const minsOf = (x: any) => Number(x.minutes ?? x.total_minutes ?? 0);
      const over = sum.filter((x) => x.over || (allowed && minsOf(x) > allowed));
      const text = `**Break — ${bnDate(from)}${to !== from ? ` – ${bnDate(to)}` : ""}**: ${bn(sum.length)} জন break নিয়েছেন${allowed ? `, অনুমতি ${bn(allowed)} মিনিট` : ""}।` +
        (now.length ? `\nএখন break-এ: ${now.map(name).join(", ")}` : "") +
        (over.length ? `\nসময়ের বেশি:\n` + over.slice(0, 10).map((x) => `• ${name(x)} — ${bn(minsOf(x))} মিনিট`).join("\n") : "") +
        (sum.length && !over.length ? "\nকেউ সময়ের বেশি নেননি।" : "");
      return {
        ok: true, text, data: { from, to, people: sum.slice(0, 40), on_break_now: now.map(name), allowed_minutes: allowed },
        actions: [{ label: "Break Time খুলুন", nav: "admin:break_time" }],
        report: report("Break Report", `Breaks-${from}-${to}`, ["Name", "Department", "Breaks", "Minutes", "Over"], sum.map((x) => [name(x), x.department || "", Number(x.count ?? x.breaks ?? 0), minsOf(x), x.over || (allowed && minsOf(x) > allowed) ? "Yes" : ""]), [["From", from], ["To", to]])
      };
    }
  },
  {
    name: "pepm_report",
    description:
      "PEPM reports: kind = mpr_entries (MPR entries: count, quantity / amount by project, latest), budget_submission (Budget Submission Status per project: submitted / not; budget = name, default the latest), dispatch (Dispatch Material rows sent / received). " +
      "from / to YYYY-MM-DD for mpr_entries (default this month).",
    params: { kind: { type: "string", description: "mpr_entries | budget_submission | dispatch" }, budget: { type: "string", description: "Budget name (budget_submission)" }, from: { type: "string", description: "YYYY-MM-DD" }, to: { type: "string", description: "YYYY-MM-DD" } },
    available: (c) => hasMod(c, "reports"),
    run: async (c, args) => {
      const kind = String(args?.kind || "mpr_entries");
      const nav = [{ label: "Reports খুলুন", nav: "admin:reports" }];
      if (kind === "budget_submission") {
        const bl = await callApi(c.req, "/api/budgets");
        const list: any[] = Array.isArray(bl.body) ? bl.body : [];
        const q = String(args?.budget || "").trim().toLowerCase();
        const b = (q && list.find((x) => String(x.budget_name || "").toLowerCase().includes(q))) || [...list].sort((a, b2) => Number(b2.id) - Number(a.id))[0];
        if (!b) return { ok: true, text: "কোনো Budget পাওয়া যায়নি।", data: { budgets: [] } };
        const r = await callApi(c.req, `/api/reports/budget-submission-status?budget_id=${b.id}`);
        if (!r.ok) return fail(r.status);
        const ps: any[] = r.body?.projects || [];
        const STATUS: Record<string, string> = { submitted: "জমা হয়েছে", not_submitted: "জমা হয়নি", partial: "আংশিক" };
        const text = `**Budget Submission — ${r.body?.budget?.budget_name || b.budget_name}**\n` + ps.map((p) => `• ${p.project_name}: ${STATUS[p.status] || p.status}${p.entry_count ? `, entry ${bn(p.entry_count)}` : ""}${(p.submitters || []).length ? ` (${p.submitters.map((x: any) => x.name || x).join(", ")})` : ""}`).join("\n");
        return { ok: true, text, data: { budget: b.budget_name, projects: ps }, actions: nav,
          report: report("Budget Submission Status", `Budget-Submission-${b.id}`, ["Project", "Status", "Items", "Jobs", "Entries", "Last entry"], ps.map((p) => [p.project_name, p.status, p.budget_item_count, p.job_count, p.entry_count, p.last_entry_at || ""]), [["Budget", String(r.body?.budget?.budget_name || b.budget_name)]]) };
      }
      if (kind === "dispatch") {
        const r = await callApi(c.req, "/api/mpr-dispatch/rows?view=all");
        if (!r.ok) return fail(r.status);
        const rows: any[] = r.body?.rows || [];
        const received = rows.filter((x) => x.received_at || x.status === "received");
        const text = `**Dispatch Material**${r.body?.all ? "" : " (শুধু আপনার)"}: মোট ${bn(rows.length)}টি সারি, গ্রহণ হয়েছে ${bn(received.length)}টি, বাকি ${bn(rows.length - received.length)}টি।` +
          (rows.length ? "\n" + rows.slice(0, 12).map((x) => `• ${x.mpr_no || x.mrf_no || ""} ${x.item_name || x.description || ""} — ${x.project_name || ""}${x.received_at ? " ✓" : ""}`).join("\n") : "");
        return { ok: true, text, data: { total: rows.length, received: received.length, rows: rows.slice(0, 40) }, actions: nav,
          report: report("Dispatch Material", `Dispatch-${c.today}`, ["MPR No", "Item", "Project", "Qty", "Sent", "Received"], rows.map((x) => [x.mpr_no || x.mrf_no || "", x.item_name || x.description || "", x.project_name || "", x.quantity ?? x.qty ?? "", x.dispatched_at || x.created_at || "", x.received_at || ""])) };
      }
      // MPR entries: the Reports page needs the Reports module and its
      // Read layer; the entries API itself also serves everyone their own and
      // every Admin all, so the Assistant checks the page's rule first.
      if (!(isSuper(c) || (c.modules.includes("reports") && (await layerOk(c, "reports", "read"))))) return NO_ACCESS;
      const r = await callApi(c.req, "/api/entries?scope=all");
      if (!r.ok) return fail(r.status);
      const isDate = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
      const from = isDate(args?.from) ? String(args.from) : `${c.today.slice(0, 7)}-01`;
      const to = isDate(args?.to) ? String(args.to) : c.today;
      const rows: any[] = (Array.isArray(r.body) ? r.body : []).filter((e: any) => { const d = String(e.entry_date || "").slice(0, 10); return d >= from && d <= to; });
      const byProject = new Map<string, number>();
      for (const e of rows) byProject.set(e.project_name || `Project #${e.project_id}`, (byProject.get(e.project_name || `Project #${e.project_id}`) || 0) + 1);
      const text = `**MPR Entries — ${bnDate(from)} থেকে ${bnDate(to)}**: মোট ${bn(rows.length)}টি\n` + [...byProject.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([p, n]) => `• ${p}: ${bn(n)}টি`).join("\n");
      return { ok: true, text, data: { from, to, total: rows.length, by_project: Object.fromEntries(byProject) }, actions: nav,
        report: report("MPR Entries", `MPR-Entries-${from}-${to}`, ["Date", "Project", "MPR No", "Item", "Qty", "Unit", "Entered by"], rows.map((e) => [String(e.entry_date || "").slice(0, 10), e.project_name || "", e.mpr_no || "", e.item_name || e.particulars || "", e.quantity ?? "", e.unit || "", e.user_name || e.created_by_name || ""]), [["From", from], ["To", to]]) };
    }
  },
  {
    name: "management_dashboard_overview",
    description: "Management Dashboard for a month (YYYY-MM, default this month): headcount, attendance %, late %, salary, people on leave, approvals waiting / stuck, targets, joiners / leavers, and what needs attention.",
    params: { month: { type: "string", description: "YYYY-MM" } },
    available: (c) => hasMod(c, "management_dashboard"),
    run: async (c, args) => {
      const month = /^\d{4}-\d{2}$/.test(String(args?.month || "")) ? String(args.month) : c.today.slice(0, 7);
      const r = await callApi(c.req, `/api/management-dashboard?month=${month}`);
      if (!r.ok) return fail(r.status);
      const k = r.body?.kpis || {};
      const att: any[] = r.body?.attention || [];
      const tk = (v: number) => `৳${bn(Math.round(v || 0).toLocaleString("en-IN"))}`;
      const text = `**Management Dashboard — ${bnMonth(month)}**\n` +
        `• কর্মী: ${bn(k.headcount?.value ?? 0)}${k.headcount?.prev != null ? ` (আগের মাসে ${bn(k.headcount.prev)})` : ""}\n` +
        `• হাজিরা: ${bn(k.attendance?.value ?? 0)}%${k.attendance?.late_pct != null ? `, দেরি ${bn(k.attendance.late_pct)}%` : ""}\n` +
        `• বেতন: ${k.salary?.value ? tk(k.salary.value) : "এখনো চালানো হয়নি"}${k.salary?.prev ? ` (আগের মাসে ${tk(k.salary.prev)})` : ""}\n` +
        `• আজ ছুটিতে: ${bn(k.on_leave_today?.value ?? 0)}, কাল ${bn(k.on_leave_today?.tomorrow ?? 0)}, অপেক্ষমাণ ছুটির আবেদন ${bn(k.on_leave_today?.pending ?? 0)}\n` +
        `• অনুমোদনের অপেক্ষায়: ${bn(k.approvals?.waiting ?? 0)} (আটকে ${bn(k.approvals?.stuck ?? 0)})` +
        (k.targets?.value != null ? `\n• Target: ${bn(k.targets.value)}%` : "") +
        (att.length ? "\nনজর দরকার:\n" + att.slice(0, 6).map((x: any) => `• ${x.text || x.title || x.message || JSON.stringify(x)}`).join("\n") : "");
      return { ok: true, text, data: { month, kpis: k, attention: att.slice(0, 10) }, actions: [{ label: "Management Dashboard খুলুন", nav: "admin:management_dashboard" }] };
    }
  },
  {
    name: "grievance_overview",
    description: "Grievance & Disciplinary: complaints by status (open / under investigation / resolved), who raised against whom (as the module shows), and disciplinary actions — for an account that manages them.",
    available: (c) => hasMod(c, "grievance_disciplinary"),
    run: async (c) => {
      const [g, d] = await Promise.all([callApi(c.req, "/api/grievances"), callApi(c.req, "/api/disciplinary-actions")]);
      if (!g.ok) return fail(g.status);
      const gs: any[] = Array.isArray(g.body) ? g.body : [];
      const ds: any[] = d.ok && Array.isArray(d.body) ? d.body : [];
      const byStatus = new Map<string, number>();
      for (const x of gs) byStatus.set(String(x.status || "open"), (byStatus.get(String(x.status || "open")) || 0) + 1);
      const text = `**Grievance**: মোট ${bn(gs.length)}টি — ${[...byStatus.entries()].map(([s2, n]) => `${s2} ${bn(n)}`).join(", ") || "কিছু নেই"}\n` +
        gs.filter((x) => !["resolved", "closed", "rejected"].includes(String(x.status))).slice(0, 10).map((x) => `• #${x.id} ${x.subject || x.title || x.category || ""} — ${x.status}${x.raised_by_name ? `, ${x.raised_by_name}` : ""}`).join("\n") +
        `\n**Disciplinary action**: ${bn(ds.length)}টি` + (ds.length ? "\n" + ds.slice(0, 8).map((x) => `• ${x.employee_name || x.name || ""} — ${x.action_type || x.type || ""} (${String(x.action_date || x.created_at || "").slice(0, 10)})`).join("\n") : "");
      return { ok: true, text, data: { grievances: gs.length, by_status: Object.fromEntries(byStatus), disciplinary: ds.length }, actions: [{ label: "Grievance & Disciplinary খুলুন", nav: "admin:grievance_disciplinary" }],
        report: report("Grievances", `Grievances-${c.today}`, ["No", "Subject", "Category", "Status", "Raised by", "Against", "Date"], gs.map((x) => [x.id, x.subject || x.title || "", x.category || "", x.status || "", x.raised_by_name || "", x.against_name || x.respondent_name || "", String(x.created_at || "").slice(0, 10)])) };
    }
  },
  {
    name: "activity_log",
    description: "Logs: kind = payroll (Payroll Activity Log: who opened Payroll and what they did), entry_edits (PEPM entry edit history), office_punches (office device In / Out punches for a date, default today).",
    params: { kind: { type: "string", description: "payroll | entry_edits | office_punches" }, date: { type: "string", description: "YYYY-MM-DD (office_punches)" } },
    available: (c) => hasMod(c, "payroll") || hasMod(c, "editlog") || hasMod(c, "office_attendance"),
    run: async (c, args) => {
      const kind = String(args?.kind || "payroll");
      if (kind === "office_punches") {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.date || "")) ? String(args.date) : c.today;
        const r = await callApi(c.req, `/api/office-attendance?from=${date}&to=${date}`);
        if (!r.ok) return fail(r.status);
        const rows: any[] = Array.isArray(r.body) ? r.body : r.body?.rows || [];
        const text = `**Office device punches — ${bnDate(date)}**: ${bn(rows.length)}টি\n` + rows.slice(0, 15).map((x) => `• ${x.employee_name || x.name || x.device_user_pin || ""} — ইন ${enTime(x.check_in_at || x.first_in || x.punch_time)}${x.check_out_at || x.last_out ? `, আউট ${enTime(x.check_out_at || x.last_out)}` : ""}`).join("\n");
        return { ok: true, text, data: { date, rows: rows.slice(0, 40) }, actions: [{ label: "Office Attendance খুলুন", nav: "admin:office_attendance" }],
          report: report("Office Punches", `Office-Punches-${date}`, ["Name", "PIN", "In", "Out", "Device"], rows.map((x) => [x.employee_name || x.name || "", x.device_user_pin || x.pin || "", String(x.check_in_at || x.first_in || x.punch_time || ""), String(x.check_out_at || x.last_out || ""), x.device_name || ""]), [["Date", date]]) };
      }
      if (kind === "entry_edits") {
        const r = await callApi(c.req, "/api/entries/edit-history");
        if (!r.ok) return fail(r.status);
        const rows: any[] = Array.isArray(r.body) ? r.body : [];
        const text = `**Entry edit history**: ${bn(rows.length)}টি বদল\n` + rows.slice(0, 12).map((x) => `• ${String(x.edited_at || x.created_at || "").slice(0, 16)} — ${x.edited_by_name || x.user_name || ""}: ${x.field_name || x.field || ""} ${x.old_value ?? ""} → ${x.new_value ?? ""}`).join("\n");
        return { ok: true, text, data: { total: rows.length, rows: rows.slice(0, 40) }, actions: [{ label: "Edit Log খুলুন", nav: "admin:editlog" }],
          report: report("Entry Edit History", `Edit-History-${c.today}`, ["When", "By", "Entry", "Field", "Old", "New"], rows.map((x) => [String(x.edited_at || x.created_at || ""), x.edited_by_name || x.user_name || "", x.entry_id ?? "", x.field_name || x.field || "", String(x.old_value ?? ""), String(x.new_value ?? "")])) };
      }
      const r = await callApi(c.req, "/api/payroll/access-log");
      if (!r.ok) return fail(r.status);
      const rows: any[] = r.body?.rows || [];
      const text = `**Payroll Activity Log** (সর্বশেষ):\n` + rows.slice(0, 15).map((x) => `• ${String(x.created_at || "").slice(0, 16)} — ${x.user_name}: ${x.area}${x.detail ? ` (${x.detail})` : ""}`).join("\n");
      return { ok: true, text, data: { rows: rows.slice(0, 40).map((x) => ({ at: x.created_at, who: x.user_name, kind: x.kind, area: x.area, detail: x.detail })) }, actions: [{ label: "Payroll খুলুন", nav: "self:payroll" }],
        report: report("Payroll Activity Log", `Payroll-Log-${c.today}`, ["When", "Who", "Kind", "What", "Detail", "IP"], rows.map((x) => [String(x.created_at || ""), x.user_name || "", x.kind || "", x.area || "", x.detail || "", x.ip || ""])) };
    }
  },
  // ---- The asker's own things (each reads the asker's own API) ----
  {
    name: "my_pending_approvals",
    description: "Applications waiting for the asking user's own approval (as supervisor / approver / reliever / clearance approver): how many, whose, what, since when.",
    run: async (c) => {
      const r = await callApi(c.req, "/api/my-approvals");
      if (!r.ok) return fail(r.status);
      const rows: any[] = Array.isArray(r.body) ? r.body : [];
      if (!rows.length) return { ok: true, text: "এই মুহূর্তে আপনার অনুমোদনের অপেক্ষায় কিছু নেই। 👍", data: { pending: 0 }, actions: [{ label: "Approve Application খুলুন", nav: "self:approveApplications" }] };
      const KIND: Record<string, string> = {
        leave_application: "ছুটির আবেদন", leave_reliever: "ছুটি (Reliever হিসেবে)", leave_direct: "ছুটির আবেদন", claim: "Movement claim", user_claim: "Conveyance bill",
        attendance: "হাজিরা", attendance_correction: "হাজিরা সংশোধন", asset_requisition: "Asset requisition", vehicle_requisition: "গাড়ির requisition",
        mobile_limit_request: "Mobile limit", advance_request: "Loan / advance", exit_clearance: "Exit clearance", hr_action: "Personnel action"
      };
      const kinds = new Map<string, number>();
      for (const x of rows) kinds.set(KIND[x.source_type] || x.source_type, (kinds.get(KIND[x.source_type] || x.source_type) || 0) + 1);
      const age = (x: any) => Math.max(0, Math.round((Date.parse(c.today) - Date.parse(String(x.created_at || c.today).slice(0, 10))) / 86400000));
      const sorted = [...rows].sort((a, b) => age(b) - age(a));
      const text = `আপনার অনুমোদনের অপেক্ষায় **${bn(rows.length)}টি**: ` + [...kinds.entries()].map(([k, n]) => `${k} ${bn(n)}`).join(", ") + "\n" +
        sorted.slice(0, 8).map((x) => `• ${KIND[x.source_type] || x.source_type} — **${x.requested_by_name || "—"}**${x.source_label ? `: ${x.source_label}` : ""}${x.source_amount ? ` (${money(x.source_amount)})` : ""} · ${bn(age(x))} দিন ধরে`).join("\n") +
        (rows.length > 8 ? `\n…আরও ${bn(rows.length - 8)}টি` : "");
      return {
        ok: true, text,
        data: { pending: rows.length, by_kind: Object.fromEntries(kinds), items: sorted.slice(0, 30).map((x) => ({ kind: KIND[x.source_type] || x.source_type, from: x.requested_by_name, what: x.source_label, amount: x.source_amount, step: `${x.current_step}/${x.total_steps}`, waiting_days: age(x) })) },
        actions: [{ label: "Approve Application খুলুন", nav: "self:approveApplications" }],
        report: report("Waiting for My Approval", `My-Approvals-${c.today}`, ["Type", "From", "Detail", "Amount", "Step", "Waiting (days)"],
          sorted.map((x) => [KIND[x.source_type] ? x.source_type.replace(/_/g, " ") : x.source_type, x.requested_by_name || "", x.source_label || "", x.source_amount ?? "", `${x.current_step}/${x.total_steps}`, age(x)]), [["As of", enDate(c.today)], ["Approver", c.name]])
      };
    }
  },
  {
    name: "my_profile",
    description: "The asking employee's own job details: employee ID, designation, department, branch, supervisor — and, when their Service Book is turned on, joining date, length of service, job base, probation / confirmation dates.",
    run: async (c) => {
      const dir = await callApi(c.req, "/api/employee-directory");
      const me = (Array.isArray(dir.body) ? dir.body : []).find((e: any) => Number(e.user_id) === c.userId);
      const full = isSuper(c) || c.flags.can_view_service_book;
      const sb = full ? await callApi(c.req, "/api/hr-ops/my/service-book") : null;
      const e = sb?.ok ? sb.body?.employee : null;
      if (!me && !e) return notLinked(c, "Employee তথ্য");
      const months = Number(e?.service_length_months);
      const lines = [
        `• Employee ID: **${e?.employee_code || me?.employee_id || "—"}**`,
        `• পদবি: **${e?.designation || me?.designation || "—"}**${(e?.department || me?.department) ? ` · Department: ${e?.department || me?.department}` : ""}`,
        (e?.branch || me?.branch) ? `• Branch: ${e?.branch || me?.branch}` : "",
        `• Supervisor: **${e?.supervisor || me?.supervisor_name || "দেওয়া নেই"}**`,
        e?.joining_date ? `• যোগদান: ${bnDate(e.joining_date)}${Number.isFinite(months) ? ` — ${bn(Math.floor(months / 12))} বছর ${bn(months % 12)} মাস` : ""}` : "",
        e?.job_base ? `• চাকরির ধরন: ${e.job_base}` : "",
        e?.probation_end_date && !e?.confirmation_date ? `• Probation শেষ: ${bnDate(e.probation_end_date)}` : "",
        e?.confirmation_date ? `• Confirmation: ${bnDate(e.confirmation_date)}` : ""
      ].filter(Boolean);
      const note = !full ? "\n(যোগদানের তারিখ ও চাকরির ইতিহাস My Service Book-এ থাকে — সেটা আপনার account-এ চালু নেই।)" : "";
      return {
        ok: true,
        text: `**${c.name}**\n` + lines.join("\n") + note,
        data: { employee_id: e?.employee_code || me?.employee_id, designation: e?.designation || me?.designation, department: e?.department || me?.department, branch: e?.branch || me?.branch,
          supervisor: e?.supervisor || me?.supervisor_name || null, ...(full ? { joining_date: e?.joining_date || null, service_months: Number.isFinite(months) ? months : null, job_base: e?.job_base || null, probation_end_date: e?.probation_end_date || null, confirmation_date: e?.confirmation_date || null } : { service_book: "not_enabled" }) },
        actions: full ? [{ label: "My Service Book খুলুন", nav: "profile:service_book" }] : []
      };
    }
  },
  {
    name: "my_assets",
    description: "Assets the asking employee holds (and which still need their acknowledgement or are asked back), and their own asset requisitions with status.",
    run: async (c) => {
      const [held, reqs] = await Promise.all([callApi(c.req, "/api/assets/my"), callApi(c.req, "/api/assets/requisitions/my")]);
      if (!held.ok && !reqs.ok) return fail(held.status);
      const items: any[] = Array.isArray(held.body) ? held.body : [];
      const rq: any[] = (Array.isArray(reqs.body) ? reqs.body : []).filter((x: any) => !["fulfilled", "rejected", "cancelled", "closed"].includes(String(x.status)));
      const ack = items.filter((a) => !a.acknowledged_at);
      const back = items.filter((a) => a.return_requested_at);
      const text = (items.length
        ? `আপনার কাছে **${bn(items.length)}টি** asset:\n` + items.slice(0, 10).map((a) => `• ${a.name}${a.asset_tag ? ` (${a.asset_tag})` : ""}${Number(a.quantity) > 1 ? ` × ${bn(a.quantity)}` : ""} — ${bnDate(a.assigned_date)} থেকে${!a.acknowledged_at ? " · ⚠️ হাতে পাওয়ার স্বীকৃতি (Acknowledge) বাকি" : ""}${a.return_requested_at ? " · ফেরত চাওয়া হয়েছে" : ""}`).join("\n")
        : "আপনার নামে কোনো asset নেই।") +
        (rq.length ? `\nচলমান requisition ${bn(rq.length)}টি:\n` + rq.slice(0, 5).map((x: any) => `• ${x.asset_category || "Asset"} — ${st(String(x.status).replace("manager_approved", "approved"))}${pendingWith(x) ? ` (অপেক্ষায়: ${pendingWith(x)})` : ""}`).join("\n") : "");
      return { ok: true, text, data: { held: items.map((a) => ({ name: a.name, tag: a.asset_tag, since: a.assigned_date, acknowledged: !!a.acknowledged_at, return_requested: !!a.return_requested_at })), awaiting_ack: ack.length, asked_back: back.length, open_requisitions: rq.map((x: any) => ({ category: x.asset_category, status: x.status, waiting_on: pendingWith(x) })) }, actions: [{ label: "My Asset খুলুন", nav: "self:assetManagement" }] };
    }
  },
  {
    name: "my_rides",
    description: "The asking employee's own vehicle (ride) requisitions — upcoming / ongoing / pending ones with date, route, status, vehicle and driver.",
    run: async (c) => {
      const r = await callApi(c.req, "/api/vehicles/requisitions");
      if (!r.ok) return fail(r.status);
      const mine: any[] = (Array.isArray(r.body) ? r.body : []).filter((x: any) => Number(x.employee_user_id) === c.userId);
      const open = mine.filter((x) => !["completed", "rejected", "cancelled", "expired"].includes(String(x.status)));
      if (!mine.length) return { ok: true, text: "আপনার কোনো গাড়ির requisition নেই।", data: { rides: [] }, actions: [{ label: "Book a Ride খুলুন", nav: "self:vehicleManagement" }] };
      const line = (x: any) => `• ${bnDate(x.ride_date || x.created_at)}${x.start_time ? ` ${bn(enTime(" " + x.start_time))}` : ""}${x.pickup_location ? ` — ${x.pickup_location}${x.destination ? ` → ${x.destination}` : ""}` : ""}: **${st(x.status)}**${x.vehicle_no ? ` · গাড়ি ${x.vehicle_no}` : ""}${x.driver_name ? ` · চালক ${x.driver_name}${x.driver_mobile ? ` (${x.driver_mobile})` : ""}` : ""}${pendingWith(x) ? ` · অপেক্ষায়: ${pendingWith(x)}` : ""}`;
      return {
        ok: true,
        text: (open.length ? `চলমান / অপেক্ষমাণ ${bn(open.length)}টি:\n` + open.slice(0, 6).map(line).join("\n") : "এখন কোনো চলমান requisition নেই।") + `\n(মোট ${bn(mine.length)}টি requisition)`,
        data: { open: open.slice(0, 10).map((x) => ({ date: x.ride_date, time: x.start_time, from: x.pickup_location, to: x.destination, status: x.status, vehicle: x.vehicle_no || null, driver: x.driver_name || null, waiting_on: pendingWith(x) })), total: mine.length },
        actions: [{ label: "Book a Ride খুলুন", nav: "self:vehicleManagement" }]
      };
    }
  },
  {
    name: "my_letters",
    description: "The asking employee's letters from HR: letter / certificate requests and their status, letters waiting for their acknowledgement, and information or documents HR has asked them to submit.",
    run: async (c) => {
      const [l, i] = await Promise.all([callApi(c.req, "/api/hr-ops/my/letters"), callApi(c.req, "/api/hr-ops/my/info-requests")]);
      if (!l.ok && !i.ok) return fail(l.status);
      const reqs: any[] = (l.body?.requests || []).filter((x: any) => x.status === "pending" || x.status === "in_progress");
      const toAck: any[] = (l.body?.letters || []).filter((x: any) => x.requires_ack && !x.acknowledged_at && x.status !== "cancelled");
      const info: any[] = (i.body?.items || []).filter((x: any) => ["pending", "requested", "rejected", "returned"].includes(String(x.status)) || (!x.submitted_at && x.status !== "approved"));
      const parts: string[] = [];
      parts.push(reqs.length ? `চিঠির অনুরোধ অপেক্ষায় ${bn(reqs.length)}টি:\n` + reqs.map((x) => `• ${x.letter_label || x.letter_type} — ${bnDate(x.created_at)} থেকে`).join("\n") : "কোনো চিঠির অনুরোধ অপেক্ষায় নেই।");
      if (toAck.length) parts.push(`Acknowledge করা বাকি ${bn(toAck.length)}টি চিঠি:\n` + toAck.map((x) => `• ${x.letter_label || x.subject} (${x.ref_no || ""})`).join("\n"));
      if (info.length) parts.push(`HR আপনার কাছে চেয়েছে ${bn(info.length)}টি:\n` + info.slice(0, 8).map((x) => `• ${x.item_label}${x.due_date ? ` — শেষ তারিখ ${bnDate(x.due_date)}` : ""}${x.overdue ? " ⚠️" : ""}${x.status === "rejected" || x.status === "returned" ? " (ফেরত — আবার দিন)" : ""}`).join("\n"));
      return {
        ok: true, text: parts.join("\n\n"),
        data: { letter_requests: reqs.map((x) => ({ type: x.letter_label || x.letter_type, since: x.created_at, status: x.status })), to_acknowledge: toAck.map((x) => x.letter_label || x.subject), hr_asked_for: info.map((x) => ({ item: x.item_label, due: x.due_date, overdue: !!x.overdue, status: x.status })) },
        actions: [{ label: "My Letters খুলুন", nav: "self:myLetters" }]
      };
    }
  },
  {
    name: "my_targets_progress",
    description: "The asking employee's own monthly / yearly targets: progress %, tasks done, deadline, overdue ones, and targets waiting for approval.",
    available: (c) => isSuper(c) || c.flags.can_view_targets,
    run: async (c) => {
      const r = await callApi(c.req, "/api/targets/mine");
      if (!r.ok) return fail(r.status);
      const list: any[] = (Array.isArray(r.body) ? r.body : []).filter((t: any) => ["active", "pending", "draft"].includes(t.status));
      if (!list.length) return { ok: true, text: "আপনার কোনো চলমান target নেই।", data: { targets: [] }, actions: [{ label: "My Targets খুলুন", nav: "self:myTargets" }] };
      const line = (t: any) => `• **${t.title}** (${t.period_type === "yearly" ? "বার্ষিক" : "মাসিক"} ${t.period}) — **${bn(t.progress)}%**, task ${bn(t.completed_count)}/${bn(t.task_count)} শেষ, deadline ${bnDate(t.deadline)}${t.overdue ? " ⚠️ সময় পেরিয়েছে" : ""}${t.status === "pending" ? " · অনুমোদনের অপেক্ষায়" : t.status === "draft" ? " · খসড়া" : ""}`;
      return {
        ok: true, text: `আপনার target ${bn(list.length)}টি:\n` + list.slice(0, 8).map(line).join("\n"),
        data: { targets: list.map((t) => ({ title: t.title, period: t.period, type: t.period_type, progress: t.progress, done: t.completed_count, tasks: t.task_count, deadline: t.deadline, overdue: !!t.overdue, status: t.status })) },
        actions: [{ label: "My Targets খুলুন", nav: "self:myTargets" }]
      };
    }
  },
  {
    name: "my_mobile_sim",
    description: "The asking employee's own office SIM(s): monthly limit, latest bills against the limit, and their limit-raise requests.",
    available: (c) => isSuper(c) || c.flags.can_view_mobile_bill || c.modules.includes("mobile_bill"),
    run: async (c) => {
      const r = await callApi(c.req, "/api/mobile-bill/my");
      if (!r.ok) return fail(r.status);
      const sims: any[] = r.body?.sims || [];
      const reqs: any[] = (r.body?.requests || []).filter((x: any) => x.status === "pending");
      if (!sims.length) return { ok: true, text: "আপনার নামে কোনো অফিস SIM নেই।", data: { sims: [] }, actions: [{ label: "My Mobile SIM খুলুন", nav: "self:myMobileSim" }] };
      const text = sims.map((s) => {
        const b = (s.bills || [])[0];
        return `• **${s.phone_number}** (${s.operator || ""}) — limit ${money(s.limit_amount)}` + (b ? `\n  ${bnMonth(String(b.month))}-এর bill ${money(b.amount)}${Number(b.amount) > Number(b.limit_amount) ? ` — ⚠️ ${money(Number(b.amount) - Number(b.limit_amount))} বেশি (কাটা যেতে পারে)` : " — limit-এর মধ্যে"}` : "\n  এখনো কোনো bill আসেনি");
      }).join("\n") + (reqs.length ? `\nLimit বাড়ানোর অনুরোধ অপেক্ষায়: ${reqs.map((x) => `${money(x.current_limit)} → ${money(x.requested_limit)}`).join(", ")}` : "");
      return { ok: true, text, data: { sims: sims.map((s) => ({ phone: s.phone_number, limit: s.limit_amount, last_bills: (s.bills || []).slice(0, 3) })), pending_requests: reqs.map((x) => ({ from: x.current_limit, to: x.requested_limit })) }, actions: [{ label: "My Mobile SIM খুলুন", nav: "self:myMobileSim" }] };
    }
  },
  {
    name: "my_resignation",
    description: "The asking employee's own resignation / exit: status, last working day, which clearance items are done or still open (and with whom).",
    run: async (c) => {
      const r = await callApi(c.req, "/api/exit-requests");
      if (!r.ok) return fail(r.status);
      const mine: any[] = (Array.isArray(r.body) ? r.body : []).filter((x: any) => Number(x.user_id) === c.userId);
      const x = mine.find((e) => e.status !== "cancelled") || mine[0];
      if (!x) return { ok: true, text: "আপনার কোনো resignation / exit আবেদন নেই।", data: { exit: null }, actions: [{ label: "My Resignation খুলুন", nav: "self:resignation" }] };
      const items: any[] = x.clearance_items || [];
      const open = items.filter((i) => !Number(i.is_cleared));
      const STATUS: Record<string, string> = { pending: "HR-এর গ্রহণের অপেক্ষায়", clearance: "Clearance চলছে", settled: "Settle হয়েছে", cancelled: "বাতিল" };
      const text = `আপনার exit: **${STATUS[x.status] || st(x.status)}**${x.last_working_day ? ` · শেষ কর্মদিবস ${bnDate(x.last_working_day)}` : ""}` +
        (items.length ? `\nClearance ${bn(items.length - open.length)}/${bn(items.length)} শেষ` + (open.length ? ":\n" + open.map((i) => `• ${i.department} বাকি${i.approver_name ? ` — ${i.approver_name}` : ""}`).join("\n") : " ✔") : "");
      return { ok: true, text, data: { status: x.status, last_working_day: x.last_working_day, clearance_done: items.length - open.length, clearance_total: items.length, open: open.map((i) => ({ department: i.department, approver: i.approver_name || null })) }, actions: [{ label: "My Resignation খুলুন", nav: "self:resignation" }] };
    }
  },
  {
    name: "my_cases",
    description: "Status of grievances the asking employee raised, and disciplinary cases about them (only their own).",
    run: async (c) => {
      const r = await callApi(c.req, "/api/my-cases");
      if (!r.ok) return fail(r.status);
      const raised: any[] = r.body?.raised || [];
      const disc: any[] = r.body?.disciplinary || [];
      if (!raised.length && !disc.length) return { ok: true, text: "আপনার কোনো অভিযোগ বা disciplinary case নেই।", data: { raised: [], disciplinary: [] }, actions: [{ label: "Grievance খুলুন", nav: "self:myCases" }] };
      const text = (raised.length ? `আপনার অভিযোগ ${bn(raised.length)}টি:\n` + raised.slice(0, 6).map((g) => `• ${g.category || "অভিযোগ"}${g.description ? `: ${String(g.description).slice(0, 60)}` : ""} — **${st(g.status)}**${g.created_at ? ` (${bnDate(g.created_at)})` : ""}`).join("\n") : "") +
        (disc.length ? `${raised.length ? "\n" : ""}Disciplinary ${bn(disc.length)}টি:\n` + disc.slice(0, 6).map((d) => `• ${d.action_type || d.type || "Case"} — **${st(d.status)}**`).join("\n") : "");
      return { ok: true, text, data: { raised: raised.map((g) => ({ category: g.category, about: String(g.description || "").slice(0, 120), status: g.status })), disciplinary: disc.map((d) => ({ type: d.action_type || d.type, status: d.status })) }, actions: [{ label: "Grievance & Disciplinary খুলুন", nav: "self:myCases" }] };
    }
  },
  {
    name: "my_team_attendance",
    description: "For a site supervisor: today's attendance of the site teams they mark (present / late / absent / on leave / not yet marked).",
    run: async (c) => {
      const r = await callApi(c.req, "/api/site-attendance/my-teams");
      if (!r.ok) return fail(r.status);
      const teams: any[] = r.body?.teams || [];
      if (!teams.length) return { ok: true, text: "আপনি কোনো site টিমের হাজিরা নেন না।", data: { teams: [] } };
      const text = `${bnDate(r.body?.today || c.today)}-এর টিম হাজিরা:\n` + teams.map((t) => {
        const k = t.today?.counts || {};
        return `• **${t.name}**${t.project_name ? ` (${t.project_name})` : ""} — মোট ${bn(k.total ?? 0)}: উপস্থিত ${bn(k.present ?? 0)}, দেরি ${bn(k.late ?? 0)}, অনুপস্থিত ${bn(k.absent ?? 0)}, ছুটি ${bn(k.leave ?? 0)}${k.unmarked ? ` · ⚠️ ${bn(k.unmarked)} জনের হাজিরা এখনো দেওয়া হয়নি` : ""}`;
      }).join("\n");
      return { ok: true, text, data: { date: r.body?.today, teams: teams.map((t) => ({ team: t.name, project: t.project_name, ...(t.today?.counts || {}) })) }, actions: [{ label: "Team Attendance খুলুন", nav: "self:teamAttendance" }] };
    }
  },
  // ---- HR / Admin ----
  {
    name: "admin_pending_work",
    description: "HR/Admin: counts of items waiting in the organisation (leave applications, claims, bills to disburse, asset/vehicle requisitions, personnel actions…).",
    available: canDash,
    run: async (c) => {
      const r = await callApi(c.req, "/api/admin-dashboard/extras");
      if (!r.ok) return fail(r.status);
      const tasks: any[] = (r.body?.tasks || []).filter((t: any) => Number(t.count) > 0);
      if (!tasks.length) return { ok: true, text: "এই মুহূর্তে কিছুই অপেক্ষায় নেই। 👍", data: { pending: [] } };
      const actions = tasks.filter((t) => t.tab).slice(0, 3).map((t) => ({ label: `${t.label} খুলুন`, nav: t.tab === "hr_operations" ? "hrops:dashboard" : `admin:${t.tab}` }));
      return { ok: true, text: "যা অপেক্ষায় আছে:\n" + tasks.map((t) => `• ${t.label}: **${bn(t.count)}**`).join("\n"), data: { pending: tasks.map((t) => ({ item: t.label, count: t.count })) }, actions,
        report: report("Pending Work", `Pending-Work-${c.today}`, ["Item", "Waiting"], tasks.map((t) => [String(t.label), Number(t.count) || 0]), [["As of", enDate(c.today)]]) };
    }
  },
  {
    name: "hr_dashboard",
    description:
      "HR/Admin Dashboard details. section: summary (default) | birthdays (next 7 days) | probation (ending within 30 days) | contract (ending) | " +
      "documents_expiry (employee documents expiring) | alerts (all three) | personnel_actions (promotions/transfers etc. taking effect) | " +
      "document_requests (letter requests / information submitted, waiting for HR) | attendance_approvals (attendance approvals and corrections waiting).",
    params: { section: { type: "string", description: "One of the sections listed; omit for summary." } },
    available: canDash,
    run: async (c, args) => {
      const r = await callApi(c.req, "/api/admin-dashboard/extras");
      if (!r.ok) return fail(r.status);
      const x = r.body || {};
      const section = String(args?.section || "summary");
      const when = (d: number) => (d === 0 ? "আজ" : d > 0 ? `${bn(d)} দিন পরে` : `${bn(-d)} দিন আগে পেরিয়েছে`);
      const who = (p: any) => `${p.name}${p.employee_code ? ` (${p.employee_code})` : ""}${p.designation ? `, ${p.designation}` : ""}`;
      const list = (rows: any[], line: (p: any) => string, empty: string, max = 10) =>
        rows.length ? rows.slice(0, max).map((p) => `• ${line(p)}`).join("\n") + (rows.length > max ? `\n…আরও ${bn(rows.length - max)} জন` : "") : empty;
      const alerts: any[] = x.alerts || [];
      const byKind = (k: string) => alerts.filter((a) => a.kind === k);
      const dashAction: AssistantAction[] = [{ label: "Admin Dashboard খুলুন", nav: "admin:dashboard" }];
      let text = "";
      let data: any = {};
      let rep: AssistantReport | undefined;
      const asOf: [string, string][] = [["As of", enDate(x.today || c.today)]];
      switch (section) {
        case "birthdays":
          text = `সামনের ৭ দিনের জন্মদিন:\n` + list(x.birthdays || [], (b) => `${who(b)} — ${bnDate(b.date)} (${when(b.days_away)})${b.turning ? `, ${bn(b.turning)} বছর` : ""}`, "সামনের ৭ দিনে কারো জন্মদিন নেই।");
          data = { birthdays: (x.birthdays || []).map((b: any) => ({ name: b.name, date: b.date, days_away: b.days_away, turning: b.turning })) };
          rep = report("Birthdays - Next 7 Days", `Birthdays-${c.today}`, ["Name", "Employee ID", "Designation", "Birthday", "In (days)", "Turning"],
            (x.birthdays || []).map((b: any) => [b.name, b.employee_code || "", b.designation || "", enDate(b.date), Number(b.days_away) || 0, b.turning || ""]), asOf);
          break;
        case "probation":
        case "contract":
        case "documents_expiry":
        case "alerts": {
          const rows = section === "alerts" ? alerts : byKind(section === "documents_expiry" ? "document" : section);
          const title = section === "probation" ? "Probation শেষ হচ্ছে" : section === "contract" ? "Contract শেষ হচ্ছে" : section === "documents_expiry" ? "Document-এর মেয়াদ শেষ হচ্ছে" : "Probation / Contract / Document সতর্কতা";
          text = `${title} (৩০ দিনের মধ্যে):\n` + list(rows, (a) => `${who(a)} — ${a.label}: ${bnDate(a.date)} (${when(a.days)})`, "এই সময়ের মধ্যে কিছু নেই।");
          data = { items: rows.map((a: any) => ({ kind: a.kind, label: a.label, name: a.name, date: a.date, days: a.days })) };
          const enTitle = section === "probation" ? "Probation Ending" : section === "contract" ? "Contract Ending" : section === "documents_expiry" ? "Documents Expiring" : "Probation / Contract / Document Alerts";
          rep = report(`${enTitle} - Within 30 Days`, `${enTitle.replace(/ \/ /g, "-")}-${c.today}`, ["Name", "Employee ID", "Designation", "Item", "Date", "Days left"],
            rows.map((a: any) => [a.name, a.employee_code || "", a.designation || "", a.label, enDate(a.date), Number(a.days)]), asOf);
          break;
        }
        case "personnel_actions":
          text = "সামনে কার্যকর হবে এমন Personnel Action:\n" + list(x.status_effective || [], (a) => `${who(a)} — ${a.action}: ${bnDate(a.date)} (${st(a.status)})`, "সামনে কোনো Personnel Action নেই।");
          data = { actions: (x.status_effective || []).map((a: any) => ({ name: a.name, action: a.action, date: a.date, status: a.status })) };
          rep = report("Upcoming Personnel Actions", `Personnel-Actions-${c.today}`, ["Name", "Employee ID", "Action", "Effective Date", "Status"],
            (x.status_effective || []).map((a: any) => [a.name, a.employee_code || "", a.action, enDate(a.date), String(a.status || "")]), asOf);
          break;
        case "document_requests":
          text = "HR-এর কাছে অপেক্ষমাণ চিঠি / তথ্য:\n" + list(x.documents || [], (d) => `${who(d)} — ${d.kind}: ${d.detail}${d.date ? ` (${bnDate(d.date)})` : ""}`, "কোনো অনুরোধ অপেক্ষায় নেই।");
          data = { requests: (x.documents || []).map((d: any) => ({ name: d.name, kind: d.kind, detail: d.detail, date: d.date })) };
          rep = report("Letter / Information Requests Waiting for HR", `Document-Requests-${c.today}`, ["Name", "Employee ID", "Request", "Detail", "Date"],
            (x.documents || []).map((d: any) => [d.name, d.employee_code || "", d.kind, d.detail || "", enDate(d.date)]), asOf);
          break;
        case "attendance_approvals":
          text = `হাজিরা অনুমোদনের অপেক্ষায়: **${bn((x.attendance_approvals || []).length)}**\n` + list(x.attendance_approvals || [], (a) => `${who(a)}${a.date ? ` — ${bnDate(a.date)}` : ""}`, "", 6) +
            `\nহাজিরা সংশোধনের অনুরোধ: **${bn((x.attendance_corrections || []).length)}**\n` + list(x.attendance_corrections || [], (a) => `${who(a)}${a.date ? ` — ${bnDate(a.date)}` : ""}`, "", 6);
          data = { attendance_approvals: (x.attendance_approvals || []).length, corrections: (x.attendance_corrections || []).length };
          rep = report("Attendance Approvals & Corrections Waiting", `Attendance-Approvals-${c.today}`, ["Type", "Name", "Employee ID", "Date"], [
            ...(x.attendance_approvals || []).map((a: any) => ["Approval", a.name, a.employee_code || "", enDate(a.date)]),
            ...(x.attendance_corrections || []).map((a: any) => ["Correction", a.name, a.employee_code || "", enDate(a.date)])
          ], asOf);
          break;
        default: {
          const tasks: any[] = (x.tasks || []).filter((t: any) => Number(t.count) > 0);
          text = `**HR Dashboard — ${bnDate(x.today)}**\n` +
            (tasks.length ? "অপেক্ষমাণ: " + tasks.map((t) => `${t.label} ${bn(t.count)}`).join(", ") + "\n" : "অপেক্ষমাণ কিছু নেই।\n") +
            `• জন্মদিন (৭ দিনে): ${bn((x.birthdays || []).length)} জন\n` +
            `• Probation শেষ হচ্ছে: ${bn(byKind("probation").length)} · Contract শেষ: ${bn(byKind("contract").length)} · Document-এর মেয়াদ: ${bn(byKind("document").length)}\n` +
            `• সামনের Personnel Action: ${bn((x.status_effective || []).length)}\n` +
            `• HR-এর কাছে চিঠি/তথ্যের অনুরোধ: ${bn((x.documents || []).length)}\n` +
            `• হাজিরা অনুমোদন / সংশোধন: ${bn((x.attendance_approvals || []).length)} / ${bn((x.attendance_corrections || []).length)}\n` +
            "বিস্তারিত চাইলে জিজ্ঞেস করুন — যেমন \"কার probation শেষ হচ্ছে?\"";
          data = {
            today: x.today, pending: tasks.map((t) => ({ item: t.label, count: t.count })), birthdays: (x.birthdays || []).length,
            probation_ending: byKind("probation").length, contract_ending: byKind("contract").length, documents_expiring: byKind("document").length,
            personnel_actions_upcoming: (x.status_effective || []).length, document_requests: (x.documents || []).length,
            attendance_approvals: (x.attendance_approvals || []).length, attendance_corrections: (x.attendance_corrections || []).length
          };
        }
      }
      return { ok: true, text, data, actions: dashAction, report: rep };
    }
  },
  // ---- HR / Admin: other people (each needs that module's own access) ----
  {
    name: "employee_leave_balance",
    description: "HR (Leave Manage access): another employee's remaining leave balance by type. name = part of their name.",
    params: { name: { type: "string", description: "Employee name (or part of it)." } },
    available: (c) => isSuper(c) || c.flags.can_manage_leave,
    run: async (c, args) => {
      const q = String(args?.name || "").trim();
      if (q.length < 2) return { ok: false, text: "কার ছুটির হিসাব চান? নাম লিখুন — যেমন \"Rahim-এর ছুটি কত বাকি\"।" };
      const r = await callApi(c.req, `/api/leave-balances?limit=10&q=${encodeURIComponent(q)}`);
      if (!r.ok) return fail(r.status);
      const rows: any[] = r.body?.rows || [];
      if (!rows.length) return { ok: true, text: `"${q}" নামে কাউকে পাওয়া যায়নি।`, data: { results: [] } };
      const kinds = (b: any) => [
        { label: "Casual", days: Number(b.casual_leave) || 0 },
        { label: "Sick", days: Number(b.sick_leave) || 0 },
        ...((b.custom_leaves || []) as any[]).map((x) => ({ label: String(x.label), days: Number(x.balance) || 0 })),
        { label: "Without pay", days: Number(b.leave_without_pay) || 0 }
      ];
      const text = rows.slice(0, 5).map((b) => `**${b.user_name}**${b.department ? ` (${b.department})` : ""}: ` + kinds(b).map((k) => `${k.label} ${bn(k.days)}`).join(", ") + " দিন").join("\n");
      return { ok: true, text, data: { results: rows.slice(0, 5).map((b) => ({ name: b.user_name, department: b.department, balances: kinds(b) })) }, actions: [{ label: "Leave Manage খুলুন", nav: "self:leaveManagement" }] };
    }
  },
  {
    name: "employee_attendance",
    description: "HR (Monthly Attendance Report access): one employee's attendance — present, absent, leave, holiday days, and late days when the Late list is allowed. name = part of their name. A calendar month by default (month_year 'YYYY-MM', default this month); when the user asks for the SALARY month, pass from / to (the salary month's dates) and salary_month instead.",
    params: {
      name: { type: "string", description: "Employee name (or part of it)." },
      month_year: { type: "string", description: "Calendar month YYYY-MM; default this month." },
      from: { type: "string", description: "Salary month start YYYY-MM-DD (only for a salary month)." },
      to: { type: "string", description: "Salary month end YYYY-MM-DD." },
      salary_month: { type: "string", description: "The salary month's YYYY-MM (with from / to)." }
    },
    available: (c) => hasMod(c, "attendance_reports"),
    run: async (c, args) => {
      const q = String(args?.name || "").trim().toLowerCase();
      if (q.length < 2) return { ok: false, text: "কার হাজিরা চান? নাম লিখুন — যেমন \"Rahim-এর এ মাসের হাজিরা\"।" };
      const isDate = (v: any) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
      // A salary month (from / to) can span two calendar months: each one's
      // Monthly Attendance Report is read and only the days in range counted.
      const ranged = isDate(args?.from) && isDate(args?.to) && String(args.from) <= String(args.to);
      const ym = /^\d{4}-\d{2}$/.test(String(args?.month_year || "")) ? String(args.month_year) : c.today.slice(0, 7);
      const sm = /^\d{4}-\d{2}$/.test(String(args?.salary_month || "")) ? String(args.salary_month) : "";
      const lastDay = (m: string) => { const [y, mo] = m.split("-").map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}`; };
      const from = ranged ? String(args.from) : `${ym}-01`;
      const toFull = ranged ? String(args.to) : lastDay(ym);
      const to = toFull > c.today ? c.today : toFull;
      const months: string[] = [];
      for (let m = from.slice(0, 7); m <= to.slice(0, 7); m = monthShift(m, 1)) months.push(m);
      const people = new Map<number, { user_id: number; user_name: string; department: string; present: number; absent: number; leave: number; holiday: number }>();
      for (const m of months) {
        const [y, mo] = m.split("-").map(Number);
        const r = await callApi(c.req, `/api/attendance/report/monthly?year=${y}&month=${mo}`);
        if (!r.ok) return fail(r.status);
        for (const u of (r.body?.users || []).filter((x: any) => String(x.user_name || "").toLowerCase().includes(q))) {
          const k = people.get(Number(u.user_id)) || { user_id: Number(u.user_id), user_name: String(u.user_name), department: String(u.department || ""), present: 0, absent: 0, leave: 0, holiday: 0 };
          if (!ranged) {
            k.present += Number(u.present_days) || 0;
            k.absent += Number(u.absent_days) || 0;
            k.leave += Number(u.leave_days) || 0;
            k.holiday += Number(u.holiday_days) || 0;
          } else {
            for (const d of u.days || []) {
              if (!d?.date || d.date < from || d.date > to || d.future || d.before_joining) continue;
              if (d.present) k.present++;
              else if (d.day_type) k.holiday++;
              else if (d.leave_type) k.leave++;
              else k.absent++;
            }
          }
          people.set(k.user_id, k);
        }
      }
      const hits = [...people.values()].slice(0, 3);
      const label = ranged ? `${sm ? `বেতনের মাস ${bnMonth(sm)}, ` : ""}${bnDate(from)} – ${bnDate(to)}` : bnMonth(ym);
      if (!hits.length) return { ok: true, text: `${label}-এর রিপোর্টে "${args.name}" নামে কাউকে পাওয়া যায়নি (আপনার দেখার department-এর বাইরে হতে পারে)।`, data: { results: [] } };
      // Late days only through the Late list (its own layer).
      const lates = new Map<number, { delay: number; extreme: number }>();
      let lateAllowed = true;
      for (let d = from; d <= to && lateAllowed; d = addDays(d, 1)) {
        const lr = await callApi(c.req, `/api/attendance/report/late?date=${d}`);
        if (lr.status === 403) { lateAllowed = false; break; }
        for (const x of lr.body?.late || []) {
          const h = hits.find((u) => String(u.user_name) === String(x.name));
          if (!h) continue;
          const k = lates.get(h.user_id) || { delay: 0, extreme: 0 };
          if (x.kind === "extreme") k.extreme++; else k.delay++;
          lates.set(h.user_id, k);
        }
      }
      const text = `${label}-এর হাজিরা:\n` + hits.map((u) => {
        const l = lates.get(u.user_id);
        return `• **${u.user_name}**${u.department ? ` (${u.department})` : ""} — উপস্থিত ${bn(u.present)} দিন, অনুপস্থিত ${bn(u.absent)}, ছুটি ${bn(u.leave)}, ছুটির দিন ${bn(u.holiday)}` +
          (lateAllowed ? `, দেরি ${bn(l?.delay || 0)}${l?.extreme ? ` (অনেক দেরি ${bn(l.extreme)})` : ""}` : "");
      }).join("\n");
      return {
        ok: true, text,
        data: { from, to, ...(sm ? { salary_month: sm } : { month: ym }), results: hits.map((u) => ({ name: u.user_name, department: u.department, present: u.present, absent: u.absent, leave: u.leave, holidays: u.holiday, ...(lateAllowed ? { late: lates.get(u.user_id)?.delay || 0, extreme_late: lates.get(u.user_id)?.extreme || 0 } : {}) })) },
        actions: [{ label: "Monthly Attendance Report খুলুন", nav: "admin:attendance_reports" }]
      };
    }
  },
  {
    name: "stuck_applications",
    description: "HR / Admin Dashboard: applications that have sat at the same approval layer for N days or more (default 3) — which layer, who has to act, since when. Only the kinds whose module the account has.",
    params: { days: { type: "number", description: "Minimum days waiting at one layer; default 3." } },
    available: canDash,
    run: async (c, args) => {
      const days = Math.min(60, Math.max(1, Math.floor(Number(args?.days)) || 3));
      const r = await callApi(c.req, `/api/admin-dashboard/stuck?days=${days}`);
      if (!r.ok) return fail(r.status);
      const items: any[] = r.body?.items || [];
      if (!items.length) return { ok: true, text: `${bn(days)} দিনের বেশি কোনো আবেদন এক layer-এ আটকে নেই। 👍`, data: { total: 0 } };
      const text = `${bn(days)}+ দিন ধরে আটকে আছে **${bn(items.length)}টি** — ` + (r.body.by_kind || []).map((k: any) => `${k.label} ${bn(k.count)}`).join(", ") + "\n" +
        items.slice(0, 10).map((i) => `• ${i.label} — **${i.requester}**${i.detail ? ` (${String(i.detail).replace(/\d{4}-\d{2}-\d{2}/g, (d: string) => bnDate(d))})` : ""}: ${i.layer}${i.step && i.total_steps ? ` ${bn(i.step)}/${bn(i.total_steps)}` : ""} — ${i.approvers.join(" / ") || "approver নেই"}, ${bn(i.days_waiting)} দিন`).join("\n") +
        (items.length > 10 ? `\n…আরও ${bn(items.length - 10)}টি` : "");
      return {
        ok: true, text,
        data: { days, total: items.length, items: items.slice(0, 40).map((i) => ({ kind: i.label, from: i.requester, layer: i.layer, approvers: i.approvers, days_waiting: i.days_waiting, detail: i.detail })) },
        actions: [{ label: "Admin Dashboard খুলুন", nav: "admin:dashboard" }],
        report: report(`Applications Stuck ${days}+ Days`, `Stuck-${days}d-${c.today}`, ["Type", "Requested by", "Detail", "Layer", "Waiting with", "Since", "Days"],
          items.map((i) => [i.label, i.requester, i.detail || "", `${i.layer}${i.step && i.total_steps ? ` ${i.step}/${i.total_steps}` : ""}`, i.approvers.join(" / "), enDate(i.since), i.days_waiting]), [["As of", enDate(c.today)], ["Total", String(items.length)]])
      };
    }
  },
  {
    name: "exits_overview",
    description: "HR (Exit / Offboarding): exits in progress — who is leaving and when, last working day this week, past last day, clearance items still open and with whom, settlement not paid.",
    available: (c) => hasMod(c, "exit_offboarding"),
    run: async (c) => {
      const r = await callApi(c.req, "/api/exit-requests/pending");
      if (!r.ok) return fail(r.status);
      const s = r.body?.summary || {};
      const list: any[] = r.body?.exits || [];
      if (!list.length) return { ok: true, text: "এখন কোনো exit চলছে না।", data: { open: 0 }, actions: [{ label: "Exit / Offboarding খুলুন", nav: "admin:exit_offboarding" }] };
      const when = (d: any) => d === null || d === undefined ? "তারিখ নেই" : d < 0 ? `${bn(-d)} দিন আগে পেরিয়েছে` : d === 0 ? "আজ" : `${bn(d)} দিন পরে`;
      const text = `চলমান exit **${bn(s.open ?? list.length)}টি** — ৭ দিনের মধ্যে শেষ কর্মদিবস ${bn(s.leaving_7_days ?? 0)}, শেষ দিন পেরিয়েছে ${bn(s.past_last_day ?? 0)}, খোলা clearance ${bn(s.clearance_open ?? 0)}, settlement বাকি ${bn(s.settlement_unpaid ?? 0)}\n` +
        list.slice(0, 8).map((x) => `• **${x.name}**${x.department ? ` (${x.department})` : ""} — শেষ দিন ${x.last_working_day ? bnDate(x.last_working_day) : "—"} (${when(x.days_left)}) · clearance ${bn(x.clearance_done)}/${bn(x.clearance_total)}` +
          ((x.open_clearance || []).length ? ` · বাকি: ${(x.open_clearance as any[]).map((o) => `${o.department}${o.approver_name ? ` (${o.approver_name})` : ""}`).join(", ")}` : "")).join("\n");
      return {
        ok: true, text,
        data: { summary: s, exits: list.slice(0, 30).map((x) => ({ name: x.name, department: x.department, last_working_day: x.last_working_day, days_left: x.days_left, status: x.status, clearance: `${x.clearance_done}/${x.clearance_total}`, open_clearance: (x.open_clearance || []).map((o: any) => ({ department: o.department, approver: o.approver_name })), settlement: x.settlement_status })) },
        actions: [{ label: "Exit / Offboarding খুলুন", nav: "admin:exit_offboarding" }],
        report: report("Exits in Progress", `Exits-${c.today}`, ["Name", "Department", "Last Working Day", "Days Left", "Clearance", "Open Clearance", "Settlement"],
          list.map((x) => [x.name, x.department || "", enDate(x.last_working_day), x.days_left ?? "", `${x.clearance_done}/${x.clearance_total}`, (x.open_clearance || []).map((o: any) => o.department).join(", "), x.settlement_status || "not prepared"]), [["As of", enDate(c.today)]])
      };
    }
  },
  {
    name: "recruitment_overview",
    description: "HR (Recruitment): open job posts and vacancies, interviews today / this week (with time), offers awaiting reply, candidates per stage.",
    available: (c) => hasMod(c, "recruitment"),
    run: async (c) => {
      const [p, k] = await Promise.all([callApi(c.req, "/api/job-postings"), callApi(c.req, "/api/job-candidates")]);
      if (!p.ok) return fail(p.status);
      const posts: any[] = Array.isArray(p.body) ? p.body : [];
      const cands: any[] = Array.isArray(k.body) ? k.body : [];
      const open = posts.filter((x) => x.status === "open");
      const title = new Map<number, string>(posts.map((x) => [Number(x.id), x.title]));
      const week = addDays(c.today, 6);
      const iv = cands.filter((x) => x.status === "interview_scheduled" && x.interview_at && String(x.interview_at).slice(0, 10) >= c.today && String(x.interview_at).slice(0, 10) <= week)
        .sort((a, b) => String(a.interview_at).localeCompare(String(b.interview_at)));
      const today = iv.filter((x) => String(x.interview_at).slice(0, 10) === c.today);
      const offers = cands.filter((x) => x.status === "offered");
      const stage = (st2: string) => cands.filter((x) => x.status === st2).length;
      const text = `খোলা পদ **${bn(open.length)}টি** (${bn(open.reduce((t, x) => t + (Number(x.vacancy_count) || 1), 0))} জন লাগবে)` + (open.length ? `: ${open.slice(0, 6).map((x) => x.title).join(", ")}` : "") +
        `\nআজ interview ${bn(today.length)}টি, এই সপ্তাহে ${bn(iv.length)}টি` + (iv.length ? ":\n" + iv.slice(0, 8).map((x) => `• **${x.name}** — ${title.get(Number(x.posting_id)) || ""}, ${bnDate(x.interview_at)} ${bn(enTime(x.interview_at))}`).join("\n") : "") +
        `\nOffer-এর উত্তর বাকি ${bn(offers.length)}টি` + (offers.length ? `: ${offers.slice(0, 6).map((x) => `${x.name} (${title.get(Number(x.posting_id)) || ""})`).join(", ")}` : "") +
        `\nপ্রার্থী — Applied ${bn(stage("applied"))}, Shortlisted ${bn(stage("shortlisted"))}, Interview ${bn(stage("interview_scheduled") + stage("interviewed"))}, Offered ${bn(offers.length)}, Hired ${bn(stage("hired"))}`;
      return {
        ok: true, text,
        data: { open_posts: open.map((x) => ({ title: x.title, vacancies: x.vacancy_count, department: x.department })), interviews_this_week: iv.map((x) => ({ name: x.name, post: title.get(Number(x.posting_id)), at: x.interview_at })), offers_waiting: offers.map((x) => ({ name: x.name, post: title.get(Number(x.posting_id)) })) },
        actions: [{ label: "Recruitment খুলুন", nav: "admin:recruitment" }]
      };
    }
  },
  {
    name: "payroll_status",
    description: "Payroll: where a month's payroll stands (draft / submitted to Audit / approved / paid), how many salaries, total and unpaid net, whose salary is on hold. month_year 'YYYY-MM' (default this month).",
    params: { month_year: { type: "string", description: "YYYY-MM; default this month." } },
    available: (c) => hasMod(c, "payroll"),
    run: async (c, args) => {
      const ym = /^\d{4}-\d{2}$/.test(String(args?.month_year || "")) ? String(args.month_year) : c.today.slice(0, 7);
      const r = await callApi(c.req, `/api/payroll/approval/${ym}`);
      if (!r.ok) return fail(r.status);
      const b = r.body || {};
      const sm = b.summary || {};
      const STAGE: Record<string, string> = { draft: "তৈরি হচ্ছে (Draft) — Audit-এ পাঠানো হয়নি", submitted: "Audit-এর অনুমোদনের অপেক্ষায়", returned: "Audit ফেরত পাঠিয়েছে — ঠিক করে আবার পাঠাতে হবে", approved: "Audit অনুমোদন করেছে — Accounts-এর পরিশোধের অপেক্ষায়", paid: "পরিশোধ হয়ে গেছে" };
      const held: any[] = b.held || [];
      const text = !Number(sm.runs)
        ? `${bnMonth(ym)}-এর payroll এখনো তৈরি হয়নি।`
        : `${bnMonth(ym)}-এর payroll: **${STAGE[b.status] || b.status}**\n• বেতন ${bn(sm.runs)} জনের, মোট net ${money(sm.total_net)}\n• পরিশোধ বাকি ${money(sm.payable_net)} (${bn(sm.unpaid ?? 0)} জন), পরিশোধিত ${bn(sm.paid ?? 0)} জন` +
          (held.length ? `\n• বেতন hold-এ ${bn(held.length)} জন: ${held.slice(0, 8).map((h: any) => h.employee_name || h.name).filter(Boolean).join(", ")}` : sm.held ? `\n• বেতন hold-এ ${bn(sm.held)} জন` : "");
      return { ok: true, text, data: { month: ym, status: b.status, summary: sm, held: held.slice(0, 30).map((h: any) => h.employee_name || h.name) }, actions: [{ label: "Payroll খুলুন", nav: "admin:payroll" }] };
    }
  },
  {
    name: "asset_lookup",
    description: "Asset Management: who holds an asset (by tag / name / serial), what a person holds, or how many of a category are free. query = asset tag, asset name, category or a person's name.",
    params: { query: { type: "string", description: "Asset tag, name, category or a person's name." } },
    available: (c) => hasMod(c, "asset_management"),
    run: async (c, args) => {
      const q = String(args?.query || "").trim().toLowerCase();
      const r = await callApi(c.req, "/api/assets?with_holder=1");
      if (!r.ok) return fail(r.status);
      const all: any[] = Array.isArray(r.body) ? r.body : [];
      const free = all.filter((a) => a.status === "available");
      if (q.length < 2) {
        const byCat = new Map<string, { total: number; free: number }>();
        for (const a of all) { const k = a.category || "Other"; const v = byCat.get(k) || { total: 0, free: 0 }; v.total++; if (a.status === "available") v.free++; byCat.set(k, v); }
        return { ok: true, text: `মোট asset ${bn(all.length)}টি, খালি ${bn(free.length)}টি:\n` + [...byCat.entries()].map(([k, v]) => `• ${k}: ${bn(v.total)}টি, খালি ${bn(v.free)}`).join("\n"), data: { total: all.length, free: free.length, by_category: Object.fromEntries(byCat) }, actions: [{ label: "Asset Management খুলুন", nav: "admin:asset_management" }] };
      }
      // Every word must appear somewhere ("dell laptop" = a Dell in Laptops).
      const words = q.split(/\s+/).filter((w) => w.length > 1 && !["ta", "ti", "টা", "টি", "ekhon", "এখন"].includes(w));
      const hit = (a: any) => { const hay = [a.asset_tag, a.name, a.serial_number, a.category, a.holder_name].map((v) => String(v || "").toLowerCase()).join(" "); return words.every((w) => hay.includes(w)); };
      const rows = all.filter(hit);
      if (!rows.length) return { ok: true, text: `"${args.query}" দিয়ে কোনো asset পাওয়া যায়নি।`, data: { results: [] } };
      const STATUS: Record<string, string> = { available: "খালি", assigned: "দেওয়া আছে", maintenance: "মেরামতে", disposed: "বাতিল" };
      const text = rows.slice(0, 12).map((a) => `• **${a.name}**${a.asset_tag ? ` (${a.asset_tag})` : ""}${a.category ? ` · ${a.category}` : ""} — ${a.holder_name ? `**${a.holder_name}**-এর কাছে${a.assigned_date ? ` (${bnDate(a.assigned_date)} থেকে)` : ""}${a.acknowledged === false ? " · স্বীকৃতি বাকি" : ""}` : STATUS[a.status] || a.status}`).join("\n") +
        (rows.length > 12 ? `\n…আরও ${bn(rows.length - 12)}টি` : "");
      return {
        ok: true, text,
        data: { results: rows.slice(0, 40).map((a) => ({ name: a.name, tag: a.asset_tag, category: a.category, status: a.status, holder: a.holder_name, since: a.assigned_date })) },
        actions: [{ label: "Asset Management খুলুন", nav: "admin:asset_management" }],
        report: report("Assets", `Assets-${c.today}`, ["Asset", "Tag", "Category", "Serial", "Status", "Held by", "Since"],
          rows.map((a) => [a.name, a.asset_tag || "", a.category || "", a.serial_number || "", a.status, a.holder_name || "", enDate(a.assigned_date)]), [["Search", String(args.query)], ["As of", enDate(c.today)]])
      };
    }
  },
  {
    name: "target_progress",
    description: "Target Reports: target progress of the company by department — average %, fully done, overdue, waiting approval — or of one department / one person. month 'YYYY-MM' (default this month), or year 'YYYY' for the whole year; name = a department or a person.",
    params: { month: { type: "string", description: "YYYY-MM; default this month." }, year: { type: "string", description: "YYYY for the whole year instead of one month." }, name: { type: "string", description: "Department or person name (optional)." } },
    available: (c) => hasMod(c, "target_reports"),
    run: async (c, args) => {
      const year = /^\d{4}$/.test(String(args?.year || "")) ? String(args.year) : "";
      const month = year ? "" : /^\d{4}-\d{2}$/.test(String(args?.month || "")) ? String(args.month) : c.today.slice(0, 7);
      const r = await callApi(c.req, month ? `/api/target-reports?year=${month.slice(0, 4)}&period_type=monthly&month=${month}` : `/api/target-reports?year=${year}`);
      if (!r.ok) return fail(r.status);
      const b = r.body || {};
      const when = month ? bnMonth(month) : `${bn(year)} সাল`;
      const q = String(args?.name || "").trim().toLowerCase();
      const line = (x: any, label: string) => `• **${label}** — গড় ${bn(x.avg_progress ?? 0)}%, target ${bn(x.targets)}টি, পুরো শেষ ${bn(x.fully_done)}, সময় পেরিয়েছে ${bn(x.overdue)}, অনুমোদনের অপেক্ষায় ${bn(x.pending)} · task ${bn(x.completed_tasks)}/${bn(x.tasks)} শেষ${x.blocked_tasks ? `, আটকে ${bn(x.blocked_tasks)}` : ""}`;
      const nav = [{ label: "Target Reports খুলুন", nav: "admin:target_reports" }];
      if (q.length >= 2) {
        const depts = (b.by_department || []).filter((d: any) => String(d.department).toLowerCase().includes(q));
        const emps = depts.length ? [] : (b.by_employee || []).filter((e: any) => String(e.name).toLowerCase().includes(q));
        if (!depts.length && !emps.length) return { ok: true, text: `${when}-এ "${args.name}" নামে কোনো department বা কর্মীর target পাওয়া যায়নি।`, data: { results: [] }, actions: nav };
        const list = depts.length ? depts : emps;
        return {
          ok: true,
          text: `${when}-এর target:\n` + list.slice(0, 8).map((x: any) => line(x, depts.length ? x.department : `${x.name}${x.department ? ` (${x.department})` : ""}`)).join("\n"),
          data: { period: month || year, results: list.slice(0, 20) },
          actions: nav
        };
      }
      const s = b.summary || {};
      if (!Number(s.targets)) return { ok: true, text: `${when}-এ কোনো target নেই।`, data: { period: month || year, targets: 0 }, actions: nav };
      const rows: any[] = b.by_department || [];
      return {
        ok: true,
        text: `${when}-এর target: **${bn(s.targets)}টি** (${bn(s.people)} জন), গড় অগ্রগতি **${bn(s.avg_progress ?? 0)}%** — পুরো শেষ ${bn(s.fully_done)}, সময় পেরিয়েছে ${bn(s.overdue)}, অনুমোদনের অপেক্ষায় ${bn(s.pending)}\n\nDepartment অনুযায়ী:\n` +
          rows.map((d) => line(d, `${d.department} (${bn(d.people)} জন)`)).join("\n"),
        data: { period: month || year, summary: s, by_department: rows },
        actions: nav,
        report: report(`Target Progress by Department — ${month || year}`, `Target-Progress-${month || year}`, ["Department", "People", "Targets", "Avg Progress %", "Fully Done", "Overdue", "Waiting Approval", "Tasks", "Tasks Done", "Blocked Tasks"],
          rows.map((d) => [d.department, d.people, d.targets, d.avg_progress ?? 0, d.fully_done, d.overdue, d.pending, d.tasks, d.completed_tasks, d.blocked_tasks]),
          [["Period", month || year], ["Targets", String(s.targets)], ["Average progress", `${s.avg_progress ?? 0}%`]])
      };
    }
  },
  {
    name: "task_overview",
    description: "Task Management: the company's open tasks — how many open / in progress, overdue (with whom and since), due today and this week, by department or person. name = a department or a person (optional).",
    params: { name: { type: "string", description: "Department or person name (optional)." } },
    available: (c) => hasMod(c, "task_management"),
    run: async (c, args) => {
      const r = await callApi(c.req, "/api/tasks/all");
      if (!r.ok) return fail(r.status);
      const q = String(args?.name || "").trim().toLowerCase();
      const who = (t: any) => (t.assignees || []).map((a: any) => a.name).join(", ");
      let open: any[] = (Array.isArray(r.body) ? r.body : []).filter((t: any) => t.status === "open" || t.status === "in_progress");
      if (q.length >= 2) open = open.filter((t) => String(t.department || "").toLowerCase().includes(q) || (t.assignees || []).some((a: any) => String(a.name).toLowerCase().includes(q)));
      const nav = [{ label: "Task Management খুলুন", nav: "admin:task_management" }];
      const scope = q.length >= 2 ? `${String(args.name).trim().replace(/^\w/, (x) => x.toUpperCase())}-এর ` : "";
      if (!open.length) return { ok: true, text: `${scope}কোনো খোলা task নেই। 👍`, data: { open: 0 }, actions: nav };
      const due = (t: any) => ymd(t.due_date);
      const overdue = open.filter((t) => t.overdue).sort((a, b) => String(due(a)).localeCompare(String(due(b))));
      const today = open.filter((t) => !t.overdue && due(t) === c.today);
      const week = open.filter((t) => !t.overdue && due(t) && due(t)! > c.today && due(t)! <= addDays(c.today, 7));
      const line = (t: any) => `• **${t.title}** — ${who(t) || "কাউকে দেওয়া হয়নি"}${t.department ? ` (${t.department})` : ""}${due(t) ? `, শেষ তারিখ ${bnDate(due(t))}` : ""}${t.status === "in_progress" ? " · চলছে" : ""}`;
      const byDept = new Map<string, { open: number; overdue: number }>();
      for (const t of open) { const k = t.department || "—"; const v = byDept.get(k) || { open: 0, overdue: 0 }; v.open++; if (t.overdue) v.overdue++; byDept.set(k, v); }
      const text = `${scope}খোলা task **${bn(open.length)}টি** — চলছে ${bn(open.filter((t) => t.status === "in_progress").length)}, সময় পেরিয়েছে **${bn(overdue.length)}**, আজ শেষ তারিখ ${bn(today.length)}, ৭ দিনের মধ্যে ${bn(week.length)}` +
        (overdue.length ? "\n\nসময় পেরিয়েছে:\n" + overdue.slice(0, 8).map(line).join("\n") + (overdue.length > 8 ? `\n…আরও ${bn(overdue.length - 8)}টি` : "") : "") +
        (today.length ? "\n\nআজ শেষ তারিখ:\n" + today.slice(0, 6).map(line).join("\n") : "") +
        (week.length ? "\n\n৭ দিনের মধ্যে শেষ তারিখ:\n" + week.slice(0, 6).map(line).join("\n") : "") +
        (q.length < 2 && byDept.size > 1 ? "\n\nDepartment অনুযায়ী: " + [...byDept.entries()].map(([k, v]) => `${k} ${bn(v.open)}${v.overdue ? ` (দেরি ${bn(v.overdue)})` : ""}`).join(", ") : "");
      return {
        ok: true, text,
        data: { open: open.length, overdue: overdue.map((t) => ({ title: t.title, assignees: who(t), department: t.department, due: due(t) })).slice(0, 30), due_today: today.map((t) => t.title), due_this_week: week.map((t) => ({ title: t.title, due: due(t), assignees: who(t) })).slice(0, 30), by_department: Object.fromEntries(byDept) },
        actions: nav,
        report: report("Open Tasks", `Open-Tasks-${c.today}`, ["Task", "Assigned to", "Department", "Priority", "Due", "Status", "Given by"],
          open.map((t) => [t.title, who(t), t.department || "", t.priority || "", enDate(due(t)), t.overdue ? "Overdue" : t.status === "in_progress" ? "In progress" : "Open", t.created_by_name || ""]),
          [["As of", enDate(c.today)], ...(q.length >= 2 ? [["Filter", String(args.name)] as [string, string]] : []), ["Open", String(open.length)], ["Overdue", String(overdue.length)]])
      };
    }
  },
  {
    name: "performance_overview",
    description: "Performance Management: the active appraisal cycle — reviews pending / submitted / acknowledged, average rating, goals; or one person's goals and review. name = a person (optional).",
    params: { name: { type: "string", description: "Person name (optional)." } },
    available: (c) => hasMod(c, "performance_management"),
    run: async (c, args) => {
      const cy = await callApi(c.req, "/api/performance-cycles");
      if (!cy.ok) return fail(cy.status);
      const cycles: any[] = Array.isArray(cy.body) ? cy.body : [];
      const nav = [{ label: "Performance খুলুন", nav: "admin:performance_management" }];
      const cycle = cycles.find((x) => x.status === "active") || [...cycles].filter((x) => x.status !== "draft").sort((a, b) => String(b.period_end).localeCompare(String(a.period_end)))[0];
      if (!cycle) return { ok: true, text: cycles.length ? "কোনো চালু appraisal cycle নেই (শুধু খসড়া আছে)।" : "এখনো কোনো appraisal cycle তৈরি হয়নি।", data: { cycles: cycles.length }, actions: nav };
      const [g, rv] = await Promise.all([callApi(c.req, `/api/performance-goals?cycle_id=${cycle.id}`), callApi(c.req, `/api/performance-reviews?cycle_id=${cycle.id}`)]);
      if (!rv.ok) return fail(rv.status);
      let goals: any[] = (Array.isArray(g.body) ? g.body : []).filter((x: any) => Number(x.cycle_id) === Number(cycle.id));
      let reviews: any[] = Array.isArray(rv.body) ? rv.body : [];
      const q = String(args?.name || "").trim().toLowerCase();
      if (q.length >= 2) {
        goals = goals.filter((x) => String(x.user_name || "").toLowerCase().includes(q));
        reviews = reviews.filter((x) => String(x.user_name || "").toLowerCase().includes(q));
        if (!goals.length && !reviews.length) return { ok: true, text: `"${cycle.name}" cycle-এ "${args.name}" নামে কারো goal বা review নেই।`, data: { results: [] }, actions: nav };
      }
      const rated = reviews.filter((x) => x.overall_rating !== null && x.overall_rating !== undefined);
      const avg = rated.length ? Math.round((rated.reduce((t, x) => t + Number(x.overall_rating), 0) / rated.length) * 10) / 10 : null;
      const st = (s: string) => reviews.filter((x) => x.status === s);
      const head = `**${cycle.name}** (${bnDate(cycle.period_start)} – ${bnDate(cycle.period_end)}${cycle.status === "closed" ? ", বন্ধ" : ""})`;
      const STATUS: Record<string, string> = { pending: "জমা বাকি", submitted: "জমা হয়েছে, স্বীকৃতি বাকি", acknowledged: "স্বীকৃত" };
      const text = q.length >= 2
        ? `${head}:\n` + reviews.slice(0, 5).map((x) => `• **${x.user_name}** — review ${STATUS[x.status] || x.status}${x.overall_rating !== null && x.overall_rating !== undefined ? `, rating ${bn(x.overall_rating)}` : ""}${x.reviewer_name ? ` (reviewer ${x.reviewer_name})` : ""}`).join("\n") +
          (goals.length ? "\nGoal:\n" + goals.slice(0, 8).map((x) => `• ${x.title}${x.user_name ? ` — ${x.user_name}` : ""} (weight ${bn(x.weight)}${x.self_rating !== null ? `, নিজের rating ${bn(x.self_rating)}` : ""}${x.manager_rating !== null ? `, manager ${bn(x.manager_rating)}` : ""})${x.status === "completed" ? " ✓" : ""}`).join("\n") : "")
        : `${head}: review **${bn(reviews.length)}টি** — জমা বাকি ${bn(st("pending").length)}, জমা হয়েছে ${bn(st("submitted").length)}, স্বীকৃত ${bn(st("acknowledged").length)}` +
          (avg !== null ? `, গড় rating **${bn(avg)}**` : "") + `\nGoal ${bn(goals.length)}টি (${bn(new Set(goals.map((x) => x.user_id)).size)} জনের), শেষ ${bn(goals.filter((x) => x.status === "completed").length)}` +
          (st("pending").length ? `\nজমা বাকি: ${st("pending").slice(0, 10).map((x) => `${x.user_name}${x.reviewer_name ? ` (${x.reviewer_name})` : ""}`).join(", ")}` : "");
      return {
        ok: true, text,
        data: { cycle: { name: cycle.name, from: cycle.period_start, to: cycle.period_end, status: cycle.status }, average_rating: avg, reviews: reviews.slice(0, 40).map((x) => ({ name: x.user_name, reviewer: x.reviewer_name, rating: x.overall_rating, status: x.status })), goals: goals.length },
        actions: nav,
        report: report(`Performance Reviews — ${cycle.name}`, `Performance-${String(cycle.name).replace(/[^\w-]+/g, "-")}`, ["Employee", "Reviewer", "Rating", "Status", "Goals", "Goals Done"],
          reviews.map((x) => { const gs = goals.filter((y) => Number(y.user_id) === Number(x.user_id)); return [x.user_name || "", x.reviewer_name || "", x.overall_rating ?? "", x.status, gs.length, gs.filter((y) => y.status === "completed").length]; }),
          [["Cycle", `${cycle.name} (${enDate(cycle.period_start)} – ${enDate(cycle.period_end)})`], ...(avg !== null ? [["Average rating", String(avg)] as [string, string]] : [])])
      };
    }
  },
  {
    name: "document_vault_overview",
    description: "Document Vault (managers): employee documents expiring soon (within `days`, default 60) or already expired, documents waiting for a signature, or one person's documents. name = a person (optional).",
    params: { name: { type: "string", description: "Person name (optional)." }, days: { type: "number", description: "Look-ahead for expiry; default 60." } },
    available: (c) => hasMod(c, "document_vault"),
    run: async (c, args) => {
      // The list returns only the asker's own files to a non-manager; the
      // people picker is manager-only, so it is the gate here.
      const gate = await callApi(c.req, "/api/employee-documents/people");
      if (!gate.ok) return fail(gate.status);
      const r = await callApi(c.req, "/api/employee-documents");
      if (!r.ok) return fail(r.status);
      const all: any[] = Array.isArray(r.body) ? r.body : [];
      const nav = [{ label: "Document Vault খুলুন", nav: "admin:document_vault" }];
      const exp = (d: any) => ymd(d.expiry_date);
      const q = String(args?.name || "").trim().toLowerCase();
      if (q.length >= 2) {
        const mine = all.filter((d) => String(d.user_name || "").toLowerCase().includes(q));
        if (!mine.length) return { ok: true, text: `"${args.name}" নামে কারো document নেই।`, data: { results: [] }, actions: nav };
        return {
          ok: true,
          text: `"${args.name}"-এর document ${bn(mine.length)}টি:\n` + mine.slice(0, 12).map((d) => `• **${d.doc_type}** — ${d.user_name}${exp(d) ? `, মেয়াদ ${bnDate(exp(d))}${exp(d)! < c.today ? " ⚠️ শেষ" : ""}` : ""}${d.requires_signature ? (d.is_signed ? " · সই হয়েছে" : " · সই বাকি") : ""}`).join("\n"),
          data: { results: mine.slice(0, 30).map((d) => ({ name: d.user_name, type: d.doc_type, file: d.file_name, expiry: exp(d), needs_signature: !!d.requires_signature, signed: !!d.is_signed })) },
          actions: nav
        };
      }
      const days = Math.min(365, Math.max(1, Math.floor(Number(args?.days)) || 60));
      const until = addDays(c.today, days);
      const expired = all.filter((d) => exp(d) && exp(d)! < c.today).sort((a, b) => String(exp(a)).localeCompare(String(exp(b))));
      const soon = all.filter((d) => exp(d) && exp(d)! >= c.today && exp(d)! <= until).sort((a, b) => String(exp(a)).localeCompare(String(exp(b))));
      const unsigned = all.filter((d) => d.requires_signature && !d.is_signed);
      const line = (d: any) => `• **${d.user_name}** — ${d.doc_type}${exp(d) ? `, ${bnDate(exp(d))}` : ""}`;
      const text = `মোট document ${bn(all.length)}টি — মেয়াদ শেষ **${bn(expired.length)}**, ${bn(days)} দিনের মধ্যে শেষ হবে **${bn(soon.length)}**, সই বাকি ${bn(unsigned.length)}` +
        (expired.length ? "\n\nমেয়াদ শেষ:\n" + expired.slice(0, 8).map(line).join("\n") : "") +
        (soon.length ? `\n\n${bn(days)} দিনের মধ্যে:\n` + soon.slice(0, 10).map(line).join("\n") : "") +
        (unsigned.length ? "\n\nসই বাকি: " + unsigned.slice(0, 8).map((d) => `${d.user_name} (${d.doc_type})`).join(", ") : "");
      const listed = [...expired, ...soon, ...unsigned.filter((d) => !expired.includes(d) && !soon.includes(d))];
      return {
        ok: true, text,
        data: { total: all.length, expired: expired.map((d) => ({ name: d.user_name, type: d.doc_type, expiry: exp(d) })).slice(0, 30), expiring: soon.map((d) => ({ name: d.user_name, type: d.doc_type, expiry: exp(d) })).slice(0, 30), unsigned: unsigned.map((d) => ({ name: d.user_name, type: d.doc_type })).slice(0, 30) },
        actions: nav,
        report: report("Documents — Expiry & Signature", `Documents-${c.today}`, ["Employee", "Document", "File", "Expiry", "State", "Signature"],
          listed.map((d) => [d.user_name || "", d.doc_type, d.file_name, enDate(exp(d)), exp(d) && exp(d)! < c.today ? "Expired" : exp(d) && exp(d)! <= until ? `Expires within ${days} days` : "", d.requires_signature ? (d.is_signed ? "Signed" : "Waiting") : ""]),
          [["As of", enDate(c.today)], ["Expired", String(expired.length)], [`Expiring in ${days} days`, String(soon.length)]])
      };
    }
  },
  {
    name: "vehicle_overview",
    description: "Vehicle Management: the fleet by status (free / on a ride / in maintenance), today's rides, rides under way, and ride requests waiting for approval (with whom) or for a vehicle.",
    available: (c) => hasMod(c, "vehicle_management"),
    run: async (c) => {
      const v = await callApi(c.req, "/api/vehicles");
      if (!v.ok) return fail(v.status);
      const r = await callApi(c.req, "/api/vehicles/requisitions");
      if (!r.ok) return fail(r.status);
      const fleet: any[] = Array.isArray(v.body) ? v.body : [];
      const rides: any[] = Array.isArray(r.body) ? r.body : [];
      const nav = [{ label: "Vehicle Management খুলুন", nav: "admin:vehicle_management" }];
      const st = (s: string) => fleet.filter((x) => x.status === s);
      const day = (x: any) => ymd(x.ride_date);
      const ongoing = rides.filter((x) => x.status === "ongoing");
      const todays = rides.filter((x) => day(x) === c.today && ["approved", "ongoing", "completed"].includes(x.status));
      const pending = rides.filter((x) => x.status === "pending");
      const unassigned = rides.filter((x) => x.status === "approved" && !x.assigned_vehicle_id);
      const ride = (x: any) => `• **${x.employee_name || "—"}** — ${x.pickup_location || "?"} → ${x.destination || "?"}${day(x) !== c.today ? `, ${bnDate(day(x))}` : ""}${x.start_time ? ` ${bn(String(x.start_time).slice(0, 5))}` : ""}${x.vehicle_no ? ` · ${x.vehicle_no}` : ""}${x.driver_name ? ` (${x.driver_name})` : ""}`;
      const text = `গাড়ি **${bn(fleet.length)}টি** — খালি ${bn(st("available").length)}, ride-এ ${bn(st("on_ride").length)}, মেরামতে ${bn(st("maintenance").length)}` +
        (st("available").length ? ` (খালি: ${st("available").slice(0, 6).map((x) => x.vehicle_no).join(", ")})` : "") +
        `\nএখন চলছে ${bn(ongoing.length)}টি ride, আজকের ride ${bn(todays.length)}টি` + (ongoing.length ? ":\n" + ongoing.slice(0, 6).map(ride).join("\n") : "") +
        `\nঅনুমোদনের অপেক্ষায় ${bn(pending.length)}টি` + (pending.length ? ":\n" + pending.slice(0, 8).map((x) => `${ride(x)} — ${pendingWith(x) ? `অপেক্ষা ${pendingWith(x)}-এর কাছে` : "approver ঠিক হয়নি"}`).join("\n") : "") +
        (unassigned.length ? `\nঅনুমোদিত কিন্তু গাড়ি দেওয়া বাকি ${bn(unassigned.length)}টি: ${unassigned.slice(0, 6).map((x) => x.employee_name).join(", ")}` : "");
      const listed = [...ongoing, ...pending, ...unassigned, ...todays.filter((x) => !ongoing.includes(x))];
      return {
        ok: true, text,
        data: { fleet: { total: fleet.length, available: st("available").map((x) => x.vehicle_no), on_ride: st("on_ride").length, maintenance: st("maintenance").length }, ongoing: ongoing.map((x) => ({ who: x.employee_name, from: x.pickup_location, to: x.destination, vehicle: x.vehicle_no, driver: x.driver_name })), today: todays.length, pending: pending.map((x) => ({ who: x.employee_name, date: day(x), to: x.destination, waiting_with: pendingWith(x) })), approved_no_vehicle: unassigned.map((x) => x.employee_name) },
        actions: nav,
        report: report("Rides", `Rides-${c.today}`, ["Requested by", "Date", "Time", "From", "To", "Status", "Vehicle", "Driver", "Waiting with"],
          listed.map((x) => [x.employee_name || "", enDate(day(x)), x.start_time ? String(x.start_time).slice(0, 5) : "", x.pickup_location || "", x.destination || "", x.status, x.vehicle_no || "", x.driver_name || "", pendingWith(x) || ""]),
          [["As of", enDate(c.today)], ["Vehicles", String(fleet.length)], ["Available", String(st("available").length)]])
      };
    }
  },
  {
    name: "daily_hr_report",
    description:
      "Today's HR report in one answer (\"ajker HR report\", daily report): headcount, attendance (present / absent), who came late, who is on leave, " +
      "pending and stuck approvals, exits, onboarding, interviews and the dashboard's coming dates. Each part only when this account may see it. " +
      "Optional date YYYY-MM-DD for the attendance / late / leave parts (default today).",
    params: { date: { type: "string", description: "YYYY-MM-DD; default today." } },
    available: (c) => DAILY_PARTS.some((p) => toolAvailable(TOOLS.find((t) => t.name === p.tool)!, c)),
    run: async (c, args) => {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.date || "")) ? String(args.date) : c.today;
      // Every part is the same tool the person could ask on its own, so the
      // same module checks (and the APIs' own 403s) decide what is in it.
      const parts = await Promise.all(
        DAILY_PARTS.map(async (p) => {
          const tool = TOOLS.find((t) => t.name === p.tool)!;
          if (!toolAvailable(tool, c)) return null;
          try {
            const r = await tool.run(c, p.args(date));
            return r.ok ? { p, r } : null;
          } catch {
            return null;
          }
        })
      );
      const got = parts.filter((x): x is { p: (typeof DAILY_PARTS)[number]; r: ToolResult } => !!x && !!x.r.text && !(x.p.skipEmpty && x.p.skipEmpty(x.r)));
      if (!got.length) return NO_ACCESS;
      const body = got.map(({ p, r }) => {
        // Lines whose every figure is 0 ("জন্মদিন (৭ দিনে): ০ জন") say nothing.
        const allZero = (l: string) => { const n = toAsciiDigits(l).replace(/\(\d+ দিনে\)/g, "").match(/\d+/g); return !!n && n.every((x) => x === "0"); };
        const lines = r.text.split("\n").filter((l) => l.trim() && !/^বিস্তারিত চাইলে|^\*\*HR Dashboard/.test(l) && !(p.dropPending && /^অপেক্ষমাণ:/.test(l)) && !(p.dropZeros && allZero(l)));
        if (!lines.length) return `**${p.title}**\nনতুন কিছু নেই।`;
        return `**${p.title}**\n` + lines.slice(0, 9).join("\n") + (lines.length > 9 ? "\n…" : "");
      });
      const rows: (string | number | null)[][] = [];
      for (const { p, r } of got) {
        if (!r.report) continue;
        // The PDF font has no Bangla, so the report is in English: the
        // part's English name, and each value with its column's name.
        const cols = r.report.columns;
        for (const row of r.report.rows) {
          const [, first, ...rest] = row;
          const detail = rest
            .map((v, i) => (v === null || v === undefined || v === "" ? "" : rest.length === 1 ? String(v) : `${cols[i + 2]}: ${v}`))
            .filter(Boolean)
            .join(" · ");
          rows.push([p.en, first === null || first === undefined ? "" : String(first), detail]);
        }
      }
      const seen = new Set<string>();
      const actions = got.flatMap(({ r }) => r.actions || []).filter((a) => (seen.has(a.nav) ? false : (seen.add(a.nav), true))).slice(0, 4);
      return {
        ok: true,
        text: `📋 **HR রিপোর্ট — ${bnDate(date)}**\n\n` + body.join("\n\n") +
          (DAILY_PARTS.some((p) => !toolAvailable(TOOLS.find((t) => t.name === p.tool)!, c)) ? "\n\n_আপনার account-এ যে অংশগুলো দেখার অনুমতি আছে, শুধু সেগুলো দেখানো হয়েছে।_" : ""),
        data: { date, parts: got.map(({ p, r }) => ({ part: p.title, facts: r.data })) },
        actions,
        report: rows.length ? report(`Daily HR Report — ${enDate(date)}`, `HR-Report-${date}`, ["Section", "Name / Item", "Detail"], rows, [["Date", enDate(date)], ["Sections", got.map(({ p }) => p.en).join(", ")]]) : undefined
      };
    }
  },
  {
    name: "on_leave",
    description: "HR: who is on approved leave on a date (default today), and whose leave on that date is still pending. Optional date YYYY-MM-DD.",
    params: { date: { type: "string", description: "YYYY-MM-DD; omit for today." } },
    available: (c) => hasMod(c, "leave_applications"),
    run: async (c, args) => {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.date || "")) ? String(args.date) : c.today;
      const r = await callApi(c.req, `/api/leave-applications/report?since=${addDays(date, -90)}&slim=1`);
      if (!r.ok) return fail(r.status);
      const rows: any[] = (Array.isArray(r.body) ? r.body : r.body?.rows || []).filter((l: any) => String(l.start_date).slice(0, 10) <= date && String(l.end_date).slice(0, 10) >= date);
      const approved = rows.filter((l) => l.status === "approved");
      const pending = rows.filter((l) => l.status === "pending");
      const line = (l: any) => `${l.user_name} — ${l.leave_type_label || l.leave_type} (${bnDate(l.start_date)}${l.end_date !== l.start_date ? ` – ${bnDate(l.end_date)}` : ""})`;
      const text = `${bnDate(date)}-এ ছুটিতে: **${bn(approved.length)} জন**` + (approved.length ? "\n" + approved.slice(0, 15).map((l) => `• ${line(l)}`).join("\n") : "") +
        (pending.length ? `\nঅনুমোদনের অপেক্ষায় (${bn(pending.length)}):\n` + pending.slice(0, 10).map((l) => `• ${line(l)}`).join("\n") : "");
      return { ok: true, text, data: { date, on_leave: approved.map((l) => ({ name: l.user_name, type: l.leave_type_label || l.leave_type, from: l.start_date, to: l.end_date })), pending: pending.map((l) => ({ name: l.user_name, from: l.start_date, to: l.end_date })) }, actions: [{ label: "Leave Applications খুলুন", nav: "admin:leave_applications" }],
        report: report("On Leave", `On-Leave-${date}`, ["Name", "Leave Type", "From", "To", "Status"],
          [...approved, ...pending].map((l) => [l.user_name, l.leave_type_label || l.leave_type, enDate(l.start_date), enDate(l.end_date), l.status === "approved" ? "Approved" : "Pending approval"]),
          [["Date", enDate(date)], ["On leave", String(approved.length)], ["Pending", String(pending.length)]]) };
    }
  },
  {
    name: "upcoming_leaves",
    description:
      "HR: leave applications (approved and pending) for coming days — who applied, which dates, how many — and for the pending ones which approval layer they wait at. " +
      "from / to YYYY-MM-DD; default from tomorrow to the end of this month.",
    params: { from: { type: "string", description: "YYYY-MM-DD; default tomorrow." }, to: { type: "string", description: "YYYY-MM-DD; default the last day of this month." } },
    available: (c) => hasMod(c, "leave_applications"),
    run: async (c, args) => {
      const tomorrow = addDays(c.today, 1);
      const from = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.from || "")) ? String(args.from) : tomorrow;
      let to = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.to || "")) ? String(args.to) : monthEndOf(from);
      if (!args?.to && to < addDays(from, 6)) to = addDays(from, 6); // last days of a month: show the coming week
      if (to < from) to = from;
      const r = await callApi(c.req, `/api/leave-applications/report?since=${from}`);
      if (!r.ok) return fail(r.status);
      const rows: any[] = (Array.isArray(r.body) ? r.body : r.body?.rows || [])
        .filter((l: any) => ["approved", "pending"].includes(l.status) && ymd(l.start_date)! <= to && ymd(l.end_date)! >= from)
        .sort((a: any, b: any) => String(a.start_date).localeCompare(String(b.start_date)));
      const pending = rows.filter((l) => l.status === "pending");
      const people = new Set(rows.map((l) => l.user_id)).size;
      const range = `${bnDate(from)} – ${bnDate(to)}`;
      if (!rows.length) return { ok: true, text: `${range}: কোনো ছুটির আবেদন নেই।`, data: { from, to, applications: [] }, actions: [{ label: "Leave Applications খুলুন", nav: "admin:leave_applications" }] };
      const dates = (l: any) => `${bnDate(l.start_date)}${ymd(l.end_date) !== ymd(l.start_date) ? ` – ${bnDate(l.end_date)}` : ""}`;
      const line = (l: any) => `• **${l.user_name}**${l.department ? ` (${l.department})` : ""} — ${l.leave_type_label || l.leave_type}, ${dates(l)} (${bn(l.day_count)} দিন): ` +
        (l.status === "approved" ? "অনুমোদিত" : `অপেক্ষমাণ — ${leaveStage(l).bn}`);
      const groups = groupByStage(pending);
      const text = `${range}: ছুটির আবেদন **${bn(rows.length)}টি** (${bn(people)} জন) — অনুমোদিত ${bn(rows.length - pending.length)}, অপেক্ষমাণ ${bn(pending.length)}\n` +
        rows.slice(0, 15).map(line).join("\n") + (rows.length > 15 ? `\n…আরও ${bn(rows.length - 15)}টি` : "") +
        (groups.length ? "\n\nঅপেক্ষমাণগুলো যেখানে আটকে আছে:\n" + groups.map((g) => `• ${g.bn}: **${bn(g.items.length)}টি** (${g.items.slice(0, 4).map((l: any) => l.user_name).join(", ")}${g.items.length > 4 ? "…" : ""})`).join("\n") : "");
      return {
        ok: true,
        text,
        data: {
          from, to, total: rows.length, people, approved: rows.length - pending.length, pending: pending.length,
          applications: rows.slice(0, 60).map((l) => ({ name: l.user_name, department: l.department, type: l.leave_type_label || l.leave_type, from: ymd(l.start_date), to: ymd(l.end_date), days: l.day_count, status: l.status, waiting_at: l.status === "pending" ? leaveStage(l).en : null })),
          pending_by_layer: groups.map((g) => ({ layer: g.en, count: g.items.length }))
        },
        actions: [{ label: "Leave Applications খুলুন", nav: "admin:leave_applications" }],
        report: report("Leave Applications", `Leave-${from}-to-${to}`, ["Name", "Department", "Leave Type", "From", "To", "Days", "Status", "Waiting At"],
          rows.map((l) => [l.user_name, l.department || "", l.leave_type_label || l.leave_type, enDate(l.start_date), enDate(l.end_date), Number(l.day_count) || 0, l.status === "approved" ? "Approved" : "Pending", l.status === "pending" ? leaveStage(l).en : ""]),
          [["Period", `${enDate(from)} - ${enDate(to)}`], ["Applications", String(rows.length)], ["Employees", String(people)], ["Approved", String(rows.length - pending.length)], ["Pending", String(pending.length)]])
      };
    }
  },
  {
    name: "leave_pending_layers",
    description: "HR: every pending leave application grouped by the approval layer it is stuck at (Reliever, Supervisor, HR… with the approver's name) and how many days it has been waiting.",
    available: (c) => hasMod(c, "leave_applications"),
    run: async (c) => {
      const r = await callApi(c.req, `/api/leave-applications/report?since=${c.today}`);
      if (!r.ok) return fail(r.status);
      const pending: any[] = (Array.isArray(r.body) ? r.body : r.body?.rows || []).filter((l: any) => l.status === "pending")
        .sort((a: any, b: any) => String(a.created_at).localeCompare(String(b.created_at)));
      if (!pending.length) return { ok: true, text: "এখন কোনো ছুটির আবেদন অনুমোদনের অপেক্ষায় নেই। 👍", data: { pending: 0 }, actions: [{ label: "Leave Applications খুলুন", nav: "admin:leave_applications" }] };
      const waited = (l: any) => Math.max(0, Math.round((Date.parse(c.today) - Date.parse(String(l.created_at || l.apply_date || c.today).slice(0, 10))) / 86400000));
      const groups = groupByStage(pending);
      const text = `অনুমোদনের অপেক্ষায় মোট **${bn(pending.length)}টি** ছুটির আবেদন:\n` +
        groups.map((g) => `**${g.bn}** — ${bn(g.items.length)}টি\n` + g.items.slice(0, 6).map((l: any) =>
          `  • ${l.user_name} — ${bnDate(l.start_date)}${ymd(l.end_date) !== ymd(l.start_date) ? ` – ${bnDate(l.end_date)}` : ""} (${bn(l.day_count)} দিন), ${bn(waited(l))} দিন ধরে অপেক্ষায়`).join("\n") +
          (g.items.length > 6 ? `\n  …আরও ${bn(g.items.length - 6)}টি` : "")).join("\n");
      return {
        ok: true,
        text,
        data: { pending: pending.length, by_layer: groups.map((g) => ({ layer: g.en, count: g.items.length, applications: g.items.slice(0, 20).map((l: any) => ({ name: l.user_name, from: ymd(l.start_date), to: ymd(l.end_date), days: l.day_count, waiting_days: waited(l) })) })) },
        actions: [{ label: "Leave Applications খুলুন", nav: "admin:leave_applications" }],
        report: report("Pending Leave Applications by Approval Layer", `Pending-Leave-${c.today}`, ["Waiting At", "Name", "Department", "Leave Type", "From", "To", "Days", "Waiting (days)"],
          groups.flatMap((g) => g.items.map((l: any) => [g.en, l.user_name, l.department || "", l.leave_type_label || l.leave_type, enDate(l.start_date), enDate(l.end_date), Number(l.day_count) || 0, waited(l)])),
          [["As of", enDate(c.today)], ["Pending", String(pending.length)]])
      };
    }
  },
  {
    name: "request_human_support",
    description: "When the user wants to talk to a real person (HR / admin / support), or you can't help them: offer a button that connects them to a live support agent. Doesn't connect by itself.",
    run: async () => ({
      ok: true,
      text: "একজন মানুষের সাথে কথা বলতে নিচের বোতাম চাপুন। Superadmin বা support-এর কেউ যোগ দিলে এখানেই সরাসরি কথা বলতে পারবেন।",
      data: { offered: true, note: "A button 'মানুষের সাথে কথা বলুন' is shown; the user presses it to join the live queue." },
      actions: [{ label: "মানুষের সাথে কথা বলুন", nav: "support:request" }]
    })
  },
  {
    name: "active_notices",
    description: "Notices currently posted for this account (company announcements).",
    run: async (c) => {
      const r = await callApi(c.req, "/api/notices/active");
      if (!r.ok) return fail(r.status);
      const rows: any[] = Array.isArray(r.body) ? r.body : [];
      const plain = (h: any) => String(h || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
      if (!rows.length) return { ok: true, text: "এখন আপনার জন্য কোনো নতুন নোটিশ নেই।", data: { notices: [] } };
      return {
        ok: true,
        text: "চালু নোটিশ:\n" + rows.slice(0, 5).map((n) => `• **${n.title}**${plain(n.content_html) ? ` — ${plain(n.content_html).slice(0, 160)}` : ""}`).join("\n"),
        data: { notices: rows.slice(0, 10).map((n) => ({ title: n.title, text: plain(n.content_html).slice(0, 500), posted: n.created_at })) }
      };
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
      return { ok: true, text, data: { date, present: present.length, absent: absent.length, on_holiday: off.length, absent_names: absent.slice(0, 30).map((x) => x.user_name), holiday: b.holiday_title || null }, actions: [{ label: "Monthly Attendance Report খুলুন", nav: "admin:attendance_reports" }],
        report: report("Daily Attendance", `Attendance-${date}`, ["Name", "Department", "Status", "Check In", "Check Out"], [
          ...absent.map((x) => [x.user_name, x.department || "", "Absent", "", ""]),
          ...present.map((x) => [x.user_name, x.department || "", "Present", enTime(x.check_in_at), enTime(x.check_out_at)]),
          ...off.map((x) => [x.user_name, x.department || "", "Holiday / weekend", "", ""])
        ], [["Date", enDate(date) + (b.holiday_title ? ` (${b.holiday_title})` : "")], ["Present", String(present.length)], ["Absent", String(absent.length)], ["On holiday", String(off.length)]]) };
    }
  },
  {
    name: "late_on_date",
    description: "HR: which employees came late (Delay / Extreme Delay) on a date, default today, with their first check-in time. Optional date YYYY-MM-DD.",
    params: { date: { type: "string", description: "YYYY-MM-DD; omit for today." } },
    available: (c) => hasMod(c, "attendance_reports"),
    run: async (c, args) => {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.date || "")) ? String(args.date) : c.today;
      const r = await callApi(c.req, `/api/attendance/report/late?date=${date}`);
      if (!r.ok) return fail(r.status);
      const late: any[] = r.body?.late || [];
      const extreme = late.filter((x) => x.kind === "extreme");
      const line = (x: any) => `• **${x.name}**${x.employee_code ? ` (${x.employee_code})` : ""}${x.department ? ` — ${x.department}` : ""}${enTime(x.first_in) ? `, এসেছেন ${bn(enTime(x.first_in))}` : ""}${x.kind === "extreme" ? " · অনেক দেরি" : ""}`;
      const text = late.length
        ? `${bnDate(date)}-এ দেরিতে এসেছেন **${bn(late.length)} জন**${extreme.length ? ` (এর মধ্যে অনেক দেরি ${bn(extreme.length)} জন)` : ""}${r.body?.shift_start ? ` — অফিস শুরু ${bn(enTime(r.body.shift_start))}` : ""}:\n` +
          late.slice(0, 20).map(line).join("\n") + (late.length > 20 ? `\n…আরও ${bn(late.length - 20)} জন` : "")
        : `${bnDate(date)}-এ কেউ দেরিতে আসেননি। 👍`;
      return {
        ok: true,
        text,
        data: { date, shift_start: r.body?.shift_start || null, late: late.slice(0, 60).map((x) => ({ name: x.name, employee_id: x.employee_code, department: x.department, first_in: enTime(x.first_in) || null, kind: x.kind === "extreme" ? "extreme_late" : "late" })) },
        actions: [{ label: "Monthly Attendance Report খুলুন", nav: "admin:attendance_reports" }],
        report: report("Late Arrivals", `Late-${date}`, ["Name", "Employee ID", "Designation", "Department", "First In", "Late"],
          late.map((x) => [x.name, x.employee_code || "", x.designation || "", x.department || "", enTime(x.first_in), x.kind === "extreme" ? "Extreme late" : "Late"]),
          [["Date", enDate(date)], ...(r.body?.shift_start ? [["Shift starts", enTime(r.body.shift_start)] as [string, string]] : []), ["Late", String(late.length)], ["Extreme late", String(extreme.length)]])
      };
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
      return { ok: true, text, data: { total: list.length, complete: complete.length, in_progress: inProg.length, not_started: notStarted.length, with_overdue: overdue.length, people: list.slice(0, 40).map((j) => ({ name: j.name, done: j.done, total: j.total, overdue: j.overdue, pending: (j.pending || []).map((p: any) => p.label) })) }, actions: [{ label: "Onboarding খুলুন", nav: "hrops:onboarding" }],
        report: report("Onboarding Status", `Onboarding-${c.today}`, ["Name", "Done", "Total", "Overdue", "Pending items"],
          list.map((j) => [j.name, Number(j.done) || 0, Number(j.total) || 0, Number(j.overdue) || 0, (j.pending || []).map((p: any) => p.label).join(", ")]),
          [["As of", enDate(c.today)], ["Complete", String(complete.length)], ["In progress", String(inProg.length)], ["Not started", String(notStarted.length)]]) };
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
      return { ok: true, text, data: { total: b.headcount_total, by_department: deps, open_positions: b.open_positions, pending_exits: b.pending_exits, open_grievances: b.open_grievances }, actions: [{ label: "HR Analytics খুলুন", nav: "admin:hr_analytics" }],
        report: report("Headcount by Department", `Headcount-${c.today}`, ["Department", "Headcount"], (b.headcount_by_department || []).map((d: any) => [d.department, Number(d.count) || 0]),
          [["As of", enDate(c.today)], ["Total", String(b.headcount_total ?? 0)], ["Open positions", String(b.open_positions ?? 0)], ["Exits in progress", String(b.pending_exits ?? 0)]]) };
    }
  },
  {
    name: "employee_breakdown",
    description:
      "HR: active employees counted by religion, gender, blood group or marital status (from their Employee records). " +
      "field = religion | gender | blood_group | marital_status. value = count only that one (e.g. Hindu, Muslim, Female, B+, Married); " +
      "leave it out for the whole breakdown. Optional department name filter.",
    params: {
      field: { type: "string", description: "religion | gender | blood_group | marital_status" },
      value: { type: "string", description: "Optional: the one value to count, e.g. Hindu, Female, B+, Married." },
      department: { type: "string", description: "Optional department name to filter by." }
    },
    available: (c) => hasMod(c, "employees"),
    run: async (c, args) => {
      const f = BREAKDOWN_FIELDS.find((x) => x.key === String(args?.field || "").toLowerCase()) || BREAKDOWN_FIELDS[0];
      const dept = String(args?.department || "").trim().toLowerCase();
      const r = await callApi(c.req, "/api/employees");
      if (!r.ok) return fail(r.status);
      const all: any[] = (Array.isArray(r.body) ? r.body : []).filter((e: any) => e.is_active);
      const scoped = dept ? all.filter((e) => String(e.department || "").toLowerCase().includes(dept)) : all;
      // Free-text values are folded into one name each ("Hinduism" / "hindu" / "হিন্দু").
      const groups = new Map<string, number>();
      let blank = 0;
      for (const e of scoped) {
        const k = breakdownKey(f, e[f.key]);
        if (!k) blank++;
        else groups.set(k, (groups.get(k) || 0) + 1);
      }
      const list = [...groups.entries()].sort((a, b) => b[1] - a[1]);
      const want = args?.value ? breakdownKey(f, args.value) : null;
      const where = dept ? ` (${args.department} বিভাগে)` : "";
      const lines = list.map(([k, n]) => `• ${breakdownLabel(f, k)}: ${bn(n)} জন`).join("\n");
      const blankNote = blank ? `\n${f.bn} লেখা নেই: ${bn(blank)} জন — তাঁদের এখানে গোনা হয়নি।` : "";
      const text = want
        ? `${breakdownLabel(f, want)} কর্মী${where}: **${bn(groups.get(want) || 0)} জন** — মোট ${bn(scoped.length)} জন active কর্মীর মধ্যে।` +
          (list.length ? `\n\n${f.bn} অনুযায়ী সবাই:\n${lines}` : "") + blankNote
        : `${f.bn} অনুযায়ী active কর্মী${where} (মোট ${bn(scoped.length)} জন):\n${lines || "• কারো রেকর্ডে লেখা নেই"}${blankNote}`;
      return {
        ok: true,
        text,
        data: { field: f.key, value: want, count: want ? groups.get(want) || 0 : undefined, total: scoped.length, blank, groups: Object.fromEntries(list) },
        actions: [{ label: "Employees খুলুন", nav: "admin:employees" }],
        report: report(`Employees by ${f.en}`, `Employees-by-${f.key}-${c.today}`, [f.en, "Employees"], [...list.map(([k, n]) => [k, n]), ...(blank ? [["(not recorded)", blank]] : [])],
          [["As of", enDate(c.today)], ["Active employees", String(scoped.length)], ...(dept ? [["Department", String(args.department)]] as [string, string][] : [])])
      };
    }
  },
  {
    name: "service_length",
    description:
      "HR: active employees by length of service, from their joining date. years = the number of years (default 10). " +
      "mode: at_least (default — completed at least that many years) | exact (completed exactly that many whole years) | " +
      "this_year (complete that many years during the current calendar year — work anniversaries). Optional department name filter.",
    params: {
      years: { type: "number", description: "Number of years of service, e.g. 5 or 10. Default 10." },
      mode: { type: "string", description: "at_least | exact | this_year. Default at_least." },
      department: { type: "string", description: "Optional department name to filter by." }
    },
    available: (c) => hasMod(c, "employees"),
    run: async (c, args) => {
      const years = Math.min(60, Math.max(1, Math.floor(Number(args?.years)) || 10));
      const mode = ["exact", "this_year"].includes(String(args?.mode)) ? String(args.mode) : "at_least";
      const dept = String(args?.department || "").trim().toLowerCase();
      const r = await callApi(c.req, "/api/employees");
      if (!r.ok) return fail(r.status);
      const [ty, tm, td] = c.today.split("-").map(Number);
      // Whole years (and the months after them) from the joining date to today.
      const served = (j: string) => {
        const [y, m, d] = j.split("-").map(Number);
        let months = (ty - y) * 12 + (tm - m) - (td < d ? 1 : 0);
        if (months < 0) months = 0;
        return { y: Math.floor(months / 12), m: months % 12 };
      };
      const all: any[] = (Array.isArray(r.body) ? r.body : []).filter((e: any) => e.is_active);
      const scoped = dept ? all.filter((e) => String(e.department || "").toLowerCase().includes(dept)) : all;
      const dated = scoped
        .map((e) => ({ e, j: ymd(e.joining_date) }))
        .filter((x): x is { e: any; j: string } => !!x.j && x.j <= c.today)
        .map((x) => ({ ...x, s: served(x.j), anniversary: `${Number(x.j.slice(0, 4)) + years}${x.j.slice(4)}` }));
      const hits = (mode === "this_year"
        ? dated.filter((x) => x.anniversary.slice(0, 4) === String(ty))
        : mode === "exact"
          ? dated.filter((x) => x.s.y === years)
          : dated.filter((x) => x.s.y >= years)
      ).sort((a, b) => (a.j < b.j ? -1 : a.j > b.j ? 1 : 0));
      const missing = scoped.length - dated.length;
      const len = (s: { y: number; m: number }) => `${bn(s.y)} বছর${s.m ? ` ${bn(s.m)} মাস` : ""}`;
      const who = (e: any) => `**${e.name}**${e.employee_id ? ` (${e.employee_id})` : ""}${e.designation ? `, ${e.designation}` : ""}${e.department ? ` — ${e.department}` : ""}`;
      const title = mode === "this_year"
        ? `${bn(ty)} সালে ${bn(years)} বছর পূর্ণ হচ্ছে`
        : mode === "exact" ? `ঠিক ${bn(years)} বছর পূর্ণ হয়েছে` : `${bn(years)} বছর বা তার বেশি সময় ধরে আছেন`;
      const line = (x: any) => mode === "this_year"
        ? `• ${who(x.e)} — যোগদান ${bnDate(x.j)}, ${bnDate(x.anniversary)}-এ ${bn(years)} বছর${x.anniversary <= c.today ? " (পূর্ণ হয়ে গেছে)" : ""}`
        : `• ${who(x.e)} — যোগদান ${bnDate(x.j)}, ${len(x.s)}`;
      const max = 25;
      // The few who are close to the mark, so "nobody yet" still says something.
      const soon = mode === "at_least"
        ? dated.filter((x) => x.s.y === years - 1).sort((a, b) => (a.j < b.j ? -1 : 1)).slice(0, 5)
        : [];
      const text = `${title}${dept ? ` (${args.department})` : ""}: **${bn(hits.length)} জন**` +
        (hits.length ? "\n" + hits.slice(0, max).map(line).join("\n") + (hits.length > max ? `\n…আরও ${bn(hits.length - max)} জন` : "") : "") +
        (!hits.length && soon.length ? `\nশিগগিরই ${bn(years)} বছর হবে:\n` + soon.map((x) => `• ${who(x.e)} — ${bnDate(x.anniversary)}`).join("\n") : "") +
        (missing > 0 ? `\n(${bn(missing)} জন active কর্মীর Joining Date দেওয়া নেই, তাই তাঁরা হিসাবে আসেননি।)` : "");
      return {
        ok: true,
        text,
        data: {
          years, mode, today: c.today, count: hits.length, without_joining_date: missing,
          employees: hits.slice(0, 60).map((x) => ({ name: x.e.name, employee_id: x.e.employee_id, designation: x.e.designation, department: x.e.department, joining_date: x.j, years: x.s.y, months: x.s.m, anniversary: x.anniversary })),
          close_to_mark: soon.map((x) => ({ name: x.e.name, anniversary: x.anniversary }))
        },
        actions: [{ label: "Employees খুলুন", nav: "admin:employees" }],
        report: report(
          mode === "this_year" ? `${years}-Year Service Anniversaries in ${ty}` : mode === "exact" ? `Employees with Exactly ${years} Years of Service` : `Employees with ${years}+ Years of Service`,
          `Service-${years}-years-${mode}-${c.today}`,
          ["Name", "Employee ID", "Designation", "Department", "Joining Date", "Service", ...(mode === "this_year" ? [`${years} Years On`] : [])],
          hits.map((x) => [x.e.name, x.e.employee_id || "", x.e.designation || "", x.e.department || "", enDate(x.j), `${x.s.y} yr${x.s.m ? ` ${x.s.m} mo` : ""}`, ...(mode === "this_year" ? [enDate(x.anniversary)] : [])]),
          [["As of", enDate(c.today)], ...(dept ? [["Department", String(args.department)] as [string, string]] : []), ["Employees", String(hits.length)],
            ...(missing > 0 ? [["Not counted (no joining date)", String(missing)] as [string, string]] : [])]
        )
      };
    }
  },
  {
    name: "app_help",
    description: "How to do something in the CredenceHR app (apply leave, claim a bill, request an asset, change password, add employee, run payroll…). Returns the steps and the page to open.",
    params: { topic: { type: "string", description: "What the user wants to do, in their words." } },
    run: async (c, args) => {
      const hits = matchHelp(c, String(args?.topic || ""), 4);
      const blocked = hits.length ? [] : matchHelp(c, String(args?.topic || ""), 1, true);
      if (blocked.length) return { ok: false, text: `"${blocked[0].title}" আপনার account-এ চালু নেই। দরকার হলে HR / Superadmin-কে বলুন।`, data: { error: "no_access", page: blocked[0].title } };
      if (!hits.length) return { ok: true, text: "এ বিষয়ে আমার কাছে নির্দিষ্ট নির্দেশনা নেই।", data: { error: "no_guide", topics: HELP.filter((h) => !h.can || h.can(c)).map((h) => h.title) } };
      return { ok: true, text: hits.map((h) => `**${h.title}:** ${h.steps}`).join("\n\n"), data: { steps: hits.map((h) => ({ title: h.title, steps: h.steps })) }, actions: hits.flatMap(helpAction) };
    }
  }
];

const toolAvailable = (t: Tool, c: Ctx) => !t.available || t.available(c);

// The parts of the daily HR report (daily_hr_report), in order. Parts that
// only matter when something is there are left out when empty.
const DAILY_PARTS: { tool: string; title: string; en: string; args: (date: string) => any; skipEmpty?: (r: ToolResult) => boolean; dropPending?: boolean; dropZeros?: boolean }[] = [
  { tool: "headcount", title: "লোকবল", en: "Headcount", args: () => ({}) },
  { tool: "attendance_on_date", title: "হাজিরা", en: "Attendance", args: (date) => ({ date }) },
  { tool: "late_on_date", title: "দেরিতে এসেছেন", en: "Late", args: (date) => ({ date }) },
  { tool: "on_leave", title: "ছুটিতে", en: "On Leave", args: (date) => ({ date }) },
  { tool: "admin_pending_work", title: "অপেক্ষমাণ অনুমোদন", en: "Pending Approvals", args: () => ({}) },
  { tool: "stuck_applications", title: "৩+ দিন আটকে আছে", en: "Stuck 3+ Days", args: () => ({ days: 3 }), skipEmpty: (r) => !r.data?.total },
  { tool: "exits_overview", title: "Exit / Offboarding", en: "Exit / Offboarding", args: () => ({}), skipEmpty: (r) => !r.data?.exits?.length },
  { tool: "onboarding_overview", title: "Onboarding", en: "Onboarding", args: () => ({}) },
  { tool: "recruitment_overview", title: "Recruitment", en: "Recruitment", args: () => ({}), dropZeros: true,
    skipEmpty: (r) => !r.data?.open_posts?.length && !r.data?.interviews_this_week?.length && !r.data?.offers_waiting?.length },
  { tool: "hr_dashboard", title: "সামনে যা আছে", en: "Coming Up", args: () => ({ section: "summary" }), dropPending: true, dropZeros: true }
];

// ---------------------------------------------------------------------------
// Local engine
// ---------------------------------------------------------------------------
const norm = (s: string) => ` ${String(s || "").toLowerCase().replace(/[?!.,।]+/g, " ").replace(/\s+/g, " ").trim()} `;
const hasAny = (t: string, keys: string[]) => keys.some((k) => t.includes(k));

// Employee fields the Assistant counts by (employee_breakdown). Each is free
// text on the Employee record, so the usual spellings fold into one name.
interface BreakdownField { key: string; bn: string; en: string; values: { name: string; bn: string; words: string[] }[] }
const BREAKDOWN_FIELDS: BreakdownField[] = [
  { key: "religion", bn: "ধর্ম", en: "Religion", values: [
    { name: "Islam", bn: "মুসলিম", words: ["islam", "muslim", "মুসলিম", "মুসলমান", "ইসলাম"] },
    { name: "Hinduism", bn: "হিন্দু", words: ["hindu", "hinduism", "sanatan", "sanatan dharma", "হিন্দু", "সনাতন"] },
    { name: "Buddhism", bn: "বৌদ্ধ", words: ["buddhist", "buddhism", "buddha", "বৌদ্ধ"] },
    { name: "Christianity", bn: "খ্রিস্টান", words: ["christian", "christianity", "খ্রিস্টান", "খ্রিষ্টান"] }
  ] },
  { key: "gender", bn: "লিঙ্গ", en: "Gender", values: [
    { name: "Male", bn: "পুরুষ", words: ["male", "man", "m", "পুরুষ"] },
    { name: "Female", bn: "নারী", words: ["female", "woman", "f", "মহিলা", "নারী"] }
  ] },
  { key: "blood_group", bn: "রক্তের গ্রুপ", en: "Blood Group", values: [] },
  { key: "marital_status", bn: "বৈবাহিক অবস্থা", en: "Marital Status", values: [
    { name: "Married", bn: "বিবাহিত", words: ["married", "বিবাহিত"] },
    { name: "Unmarried", bn: "অবিবাহিত", words: ["unmarried", "single", "অবিবাহিত"] }
  ] }
];
// "b positive" / "B (+ve)" / "b+" -> "B+".
const bloodKey = (v: string) => {
  const m = /^(ab|a|b|o)\s*\(?\s*(\+|-|pos\w*|neg\w*|\+ve|-ve)?/i.exec(v.trim());
  if (!m) return null;
  const sign = !m[2] ? "" : /^(\+|pos)/i.test(m[2]) ? "+" : "-";
  return m[1].toUpperCase() + sign;
};
function breakdownKey(f: BreakdownField, raw: unknown): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;
  if (f.key === "blood_group") return bloodKey(v) || v.toUpperCase();
  const low = v.toLowerCase();
  const hit = f.values.find((x) => x.words.includes(low) || x.name.toLowerCase() === low);
  return hit ? hit.name : v.replace(/\b\w/g, (ch) => ch.toUpperCase());
}
const breakdownLabel = (f: BreakdownField, key: string) => {
  const hit = f.values.find((x) => x.name === key);
  return hit ? `${hit.bn} (${key})` : key;
};
// Which field and value a question is about ("hindu employee koto jon").
function breakdownArgs(t: string) {
  for (const f of BREAKDOWN_FIELDS) {
    for (const v of f.values) if (v.words.some((w) => w.length > 2 && new RegExp(`(^|[^a-zঀ-৿])${w}`).test(t))) return { field: f.key, value: v.name };
  }
  if (hasAny(t, ["blood", "রক্ত"])) {
    const b = /\b(ab|a|b|o)\s*(\+|-|positive|negative|pos|neg)/i.exec(t);
    return { field: "blood_group", value: b ? bloodKey(b[0]) : undefined };
  }
  if (hasAny(t, ["gender", "লিঙ্গ"])) return { field: "gender" };
  if (hasAny(t, ["marital", "বৈবাহিক", "বিয়ে"])) return { field: "marital_status" };
  return { field: "religion" };
}

// How well a how-to entry matches: a key found as written counts in full; a
// key of several words that are all there with other words between them
// ("department kivabe add korbo" for "department add") counts a little less.
const helpKeyScore = (h: HelpEntry, t: string) =>
  h.keys.reduce((sc, k) => {
    if (t.includes(k)) return sc + k.length;
    const parts = k.split(" ").filter((w) => w.length > 1);
    return parts.length > 1 && parts.every((w) => t.includes(w)) ? sc + Math.round(k.length * 0.6) : sc;
  }, 0);

// blocked = true finds only the pages this account can NOT open (to say so).
function matchHelp(c: Ctx, text: string, limit: number, blocked = false): HelpEntry[] {
  const t = norm(text);
  return HELP.filter((h) => (!h.can || h.can(c)) !== blocked)
    .map((h) => ({ h, score: helpKeyScore(h, t) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.h);
}

const HOW = ["ki kore", "কী করে", "কি করে", "kivabe", "kibhabe", "kivabe", "kemne", "kothay", "kotha", "কিভাবে", "কীভাবে", "কেমনে", "কোথায়", "how ", "where ", "how do", "how to", "নিয়ম", "niyom", "process", "প্রক্রিয়া", "দিতে চাই", "করতে চাই", "korte chai", "dite chai"];

interface Intent { tool: string; keys: string[]; args?: (t: string, c: Ctx) => any }

const THIS_MONTH = ["this month", "ei mas", "ei mash", "এই মাস", "চলতি মাস", "ei month", "e mase", "e mashe"];
// "Salary month" / "my salary month" — the salary month we are in now.
const SALARY_MONTH = ["salary month", "salary mas", "salary mash", "বেতনের মাস", "বেতন মাস", "beton er mas", "beton er mash", "betoner mas", "payroll month", "স্যালারি মাস", "স্যালারি মান্থ"];
const LAST_MONTH = ["last month", "gotomash", "gotomas", "goto mash", "goto mas", "গত মাস", "আগের মাস", "previous month", "ager mas", "ager mash"];

// "gotomas", "ei bochor", "october", "aj" -> a period for the report tools
// (nothing said = the tool's own default, this month).
const periodOf = (t: string, c: Ctx): { from?: string; to?: string; month?: string; date?: string; month_year?: string } => {
  const ym = c.today.slice(0, 7);
  const lastDay = (m: string) => { const [y, mo] = m.split("-").map(Number); return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, "0")}`; };
  if (hasAny(t, LAST_MONTH)) { const m = monthShift(ym, -1); return { from: `${m}-01`, to: lastDay(m), month: m, month_year: m }; }
  if (hasAny(t, ["this year", "ei bochor", "ei bochhor", "এই বছর", "এ বছর", "e bochor", "চলতি বছর"])) return { from: `${ym.slice(0, 4)}-01-01`, to: c.today };
  if (hasAny(t, [" aj ", " ajke ", " আজ ", " আজকে ", " today "])) return { from: c.today, to: c.today, date: c.today };
  if (hasAny(t, ["gotokal", "গতকাল", "yesterday"])) { const d = addDays(c.today, -1); return { from: d, to: d, date: d }; }
  // Week = Saturday to Friday (the office week here).
  const weekStart = addDays(c.today, -((new Date(`${c.today}T00:00:00Z`).getUTCDay() + 1) % 7));
  if (hasAny(t, ["last week", "goto soptah", "gotosoptah", "goto saptah", "গত সপ্তাহ", "ager soptah", "আগের সপ্তাহ"])) return { from: addDays(weekStart, -7), to: addDays(weekStart, -1) };
  if (hasAny(t, ["this week", "ei soptah", "ei saptah", "এই সপ্তাহ", "চলতি সপ্তাহ", "ei week"])) return { from: weekStart, to: c.today };
  if (hasAny(t, THIS_MONTH)) return { from: `${ym}-01`, to: c.today, month: ym, month_year: ym };
  // "28 october" / "october 28" / "২৮ অক্টোবর" -> that one day.
  const words = toAsciiDigits(t).trim().split(" ");
  for (let i = 0; i < words.length; i++) {
    const m = monthOf(words[i].replace(/(er|এর|-এর|e|তে)$/, ""));
    if (!m) continue;
    const dm = /^(\d{1,2})(?:st|nd|rd|th|ই|শে|তারিখ)?$/.exec(words[i - 1] || "") || /^(\d{1,2})(?:st|nd|rd|th|ই|শে|তারিখ)?$/.exec(words[i + 1] || "");
    const dd = dm ? Number(dm[1]) : 0;
    if (dd >= 1 && dd <= 31) {
      const [ty, tm] = ym.split("-").map(Number);
      const mm = `${m > tm ? ty - 1 : ty}-${String(m).padStart(2, "0")}`;
      const d = `${mm}-${String(dd).padStart(2, "0")}`;
      if (d <= lastDay(mm)) return { from: d, to: d, date: d, month: mm, month_year: mm };
    }
  }
  for (const w of t.trim().split(" ")) {
    const m = monthOf(w.replace(/(er|এর|-এর|e|তে)$/, ""));
    if (m) {
      const [ty, tm] = ym.split("-").map(Number);
      const y = m > tm ? ty - 1 : ty;
      const mm = `${y}-${String(m).padStart(2, "0")}`;
      return { from: `${mm}-01`, to: mm === ym ? c.today : lastDay(mm), month: mm, month_year: mm };
    }
  }
  return {};
};
// For Gemini: which dates the salary months cover (only when they don't
// follow the calendar).
const salaryMonthNote = (c: Ctx) => {
  if (!salaryMonthStartsLater(c)) return "";
  const cur = salaryMonthOf(c, c.today);
  const p = salaryPeriod(c, cur);
  const prev = monthShift(cur, -1);
  const q = salaryPeriod(c, prev);
  return (
    `Salary months don't follow the calendar here: the current salary month ${cur} runs ${p.start} to ${p.end}; the previous one, ${prev}, ran ${q.start} to ${q.end}. ` +
    `The asker's OWN attendance (my_attendance_summary, my_late_days) always counts by salary month: "this month" / "last month" there mean these salary months (month_year = the salary month's YYYY-MM; my_late_days gets these from / to). ` +
    `Reports on OTHER people (employee_attendance, attendance_custom_report) count calendar months as the report pages do — use these salary-month dates there only when the user says "salary month" / "বেতনের মাস" (employee_attendance: from, to, salary_month). Say the dates in the answer.\n`
  );
};

// Attendance questions and SALARY months (Payroll -> Salary month setting).
//   own — the asker's own attendance: a month is always a salary month, as
//         My Attendance has always counted it.
//   hr  — reports on others (Monthly Attendance, Report Builder): a month is
//         the calendar month, as the report pages count it, unless the
//         question says "salary month" — then Payroll's dates.
// "this month" = the salary month today is in, "last month" the one before,
// "october" = the October salary month. A day, a week or a year stays as
// periodOf reads it.
const salaryAskedIn = (t: string, c: Ctx) => !!c.salaryAsked || hasAny(t, SALARY_MONTH);
const attPeriodOf = (t: string, c: Ctx, scope: "own" | "hr" = "own"): { from?: string; to?: string; month?: string; date?: string; month_year?: string; salary_month?: string } => {
  if (scope === "hr" && !salaryAskedIn(t, c)) return periodOf(t, c);
  const cur = salaryMonthOf(c, c.today);
  const whole = (ym: string) => {
    const p = salaryPeriod(c, ym);
    return { from: p.start, to: p.end > c.today ? c.today : p.end, month: ym, month_year: ym, salary_month: ym };
  };
  if (hasAny(t, LAST_MONTH) || /(goto|gato|last|previous|ager|আগের|গত)\s*(salary|স্যালারি|বেতন|beton|payroll)/.test(t)) return whole(monthShift(cur, -1));
  if (hasAny(t, THIS_MONTH)) return whole(cur);
  const p = periodOf(t, c);
  if (p.month && !p.date) return whole(p.month);
  if (salaryAskedIn(t, c)) return whole(cur);
  return p;
};

// One intent per ready-made report, so a question goes straight to it.
const reportIntent = (report: string, keys: string[]): Intent => ({ tool: "company_report", keys, args: (t, c) => ({ report, ...periodOf(t, c) }) });
const presetIntent = (preset: string, keys: string[]): Intent => ({ tool: "employee_records_report", keys, args: () => ({ preset }) });

const INTENTS: Intent[] = [
  reportIntent("leave_taken", ["leave taken", "leave by type", "ছুটির ধরন অনুযায়ী", "কে কত ছুটি নিয়েছে", "ke koto chuti niyeche", "kar koto chuti nise", "kon dhoroner chuti"]),
  reportIntent("bill_disbursements", ["disbursement", "ডিসবার্স", "bill payment report", "koto taka deya baki", "কত টাকা দেওয়া বাকি", "bill paid"]),
  reportIntent("bill_claim_categories", ["category wise claim", "claim by category", "ক্যাটাগরি অনুযায়ী claim", "category onujayi bill"]),
  reportIntent("bill_claims", ["bill claim report", "বিল ক্লেইম রিপোর্ট", "conveyance claim report", "sobar bill claim", "কোম্পানির bill claim"]),
  reportIntent("conveyance_bills", ["conveyance bill list", "conveyance bill report", "কনভেয়েন্স বিলের তালিকা"]),
  reportIntent("movement_claims", ["movement claim report", "sobar movement", "মুভমেন্ট রিপোর্ট", "movement report"]),
  reportIntent("asset_register", ["asset register", "asset list", "সব asset", "অ্যাসেট রেজিস্টার", "company r asset"]),
  reportIntent("asset_assignments", ["asset handover", "asset hostantor", "হস্তান্তরের ইতিহাস", "handover history"]),
  reportIntent("asset_requisitions", ["asset requisition report", "asset er abedon", "অ্যাসেটের আবেদন"]),
  reportIntent("vehicle_rides", ["ride history", "গাড়ির ইতিহাস", "ride report", "koyta ride hoyeche", "কয়টা ride"]),
  reportIntent("vehicle_utilization", ["vehicle utilization", "gari koto cholse", "গাড়ি কত চলেছে", "utilization"]),
  reportIntent("attendance_summary", ["attendance summary", "hajira summary", "মাসের হাজিরা রিপোর্ট", "attendance report sobar"]),
  reportIntent("remote_attendance", ["remote attendance report", "gps attendance", "remote check in report"]),
  reportIntent("leave_applications", ["leave application report", "ছুটির আবেদনের রিপোর্ট"]),
  { tool: "attendance_custom_report", keys: ["er pore ke ke asche", "এর পরে কে কে এসেছে", "er age ke ber", "এর আগে কে বের", "check out den nai", "চেক আউট দেয়নি", "ghontar kom kaj", "ঘণ্টার কম কাজ", "bar er beshi late", "বারের বেশি দেরি", "custom attendance report", "attendance report builder"],
    args: (t, c) => ({ ...parseAttendanceQuestion(t), ...attPeriodOf(t, c, "hr") }) },
  { tool: "attendance_department_summary", keys: ["department summary", "department wise attendance", "department onujayi hajira", "বিভাগ অনুযায়ী হাজিরা", "department e koto absent", "department wise absent", "ডিপার্টমেন্ট অনুযায়ী"],
    args: (t, c) => { const p = periodOf(t, c); return p.date ? { date: p.date } : p.month ? { month: p.month } : hasAny(t, ["mas", "month", "মাস"]) ? { month: c.today.slice(0, 7) } : {}; } },
  { tool: "payroll_month_comparison", keys: ["salary comparison", "beton er tulona", "বেতনের তুলনা", "salary difference", "beton keno barlo", "ager maser sathe beton", "বেতন কেন বাড়ল", "বেতন কেন কমল", "payroll comparison"], args: (t, c) => ({ month_year: periodOf(t, c).month_year }) },
  { tool: "payroll_salary_sheet", keys: ["salary sheet", "বেতনের শীট", "salary list", "beton koto gese", "বেতন কত গেছে", "kar koto beton", "কার কত বেতন"], args: (t, c) => ({ month_year: periodOf(t, c).month_year }) },
  presetIntent("salary_register", ["salary register", "বেতন রেজিস্টার"]),
  presetIntent("loans_outstanding", ["loan outstanding", "কার কত লোন বাকি", "loan baki sobar", "sobar loan"]),
  presetIntent("training_summary", ["training summary", "ট্রেনিং রিপোর্ট", "training report"]),
  presetIntent("pending_documents", ["pending document", "কাগজ বাকি", "document missing", "documents pending"]),
  presetIntent("missing_documents_by_type", ["missing document by type", "কোন কাগজ বাকি"]),
  presetIntent("nominee_gaps", ["nominee", "নমিনি", "emergency contact nai"]),
  presetIntent("education_levels", ["education level", "শিক্ষাগত যোগ্যতা", "education report"]),
  presetIntent("experience_bands", ["experience band", "অভিজ্ঞতা অনুযায়ী", "experience report"]),
  presetIntent("unverified_records", ["not verified", "verify hoyni", "যাচাই হয়নি"]),
  presetIntent("joined_from_company", ["ager company", "আগের কোম্পানি", "previous company"]),
  presetIntent("probation_ending", ["probation ending", "probation shesh", "প্রবেশন শেষ"]),
  presetIntent("blood_group_directory", ["blood group list", "রক্তের গ্রুপের তালিকা", "blood group directory", "kar blood group"]),
  presetIntent("assets_with_employees", ["assets with employees", "kar kache asset", "কার কাছে asset"]),
  { tool: "mobile_bill_report", keys: ["mobile bill report", "মোবাইল বিলের রিপোর্ট", "sim bill report", "limit er beshi", "সীমার বেশি বিল", "mobile bill koto"], args: (t, c) => { const p = periodOf(t, c); return p.month ? { from: p.month, to: p.month } : {}; } },
  { tool: "tracking_overview", keys: ["tracking e ke ache", "কে ট্র্যাকিং", "tracking status", "location pathacche", "লোকেশন পাঠাচ্ছে", "ke track e"] },
  { tool: "tracking_stay_report", keys: ["stay report", "কোথায় ছিল", "kothay chilo"], args: (t, c) => ({ name: nameBefore(t), ...periodOf(t, c) }) },
  { tool: "duty_roster_overview", keys: ["duty roster", "রোস্টার", "kar kon shift", "কার কোন শিফট", "shift ke"], args: (t, c) => periodOf(t, c) },
  { tool: "break_report", keys: ["break report", "ব্রেক রিপোর্ট", "ke break e", "কে ব্রেকে", "break niyeche"], args: (t, c) => periodOf(t, c) },
  { tool: "pepm_report", keys: ["mpr entry", "এমপিআর", "mpr report"], args: (t, c) => ({ kind: "mpr_entries", ...periodOf(t, c) }) },
  { tool: "pepm_report", keys: ["budget submission", "বাজেট জমা", "budget submit"], args: () => ({ kind: "budget_submission" }) },
  { tool: "pepm_report", keys: ["dispatch", "ডিসপ্যাচ"], args: () => ({ kind: "dispatch" }) },
  { tool: "management_dashboard_overview", keys: ["management dashboard", "ম্যানেজমেন্ট ড্যাশবোর্ড", "company overview", "কোম্পানির অবস্থা", "companyr obostha"], args: (t, c) => ({ month: periodOf(t, c).month }) },
  { tool: "grievance_overview", keys: ["grievance", "অভিযোগ", "disciplinary", "শাস্তিমূলক"] },
  { tool: "activity_log", keys: ["payroll log", "payroll e ke dhukeche", "payroll activity"], args: () => ({ kind: "payroll" }) },
  { tool: "activity_log", keys: ["edit log", "edit history", "এডিট লগ"], args: () => ({ kind: "entry_edits" }) },
  { tool: "activity_log", keys: ["device punch", "office punch", "মেশিনের পাঞ্চ", "punch log"], args: (t, c) => ({ kind: "office_punches", date: periodOf(t, c).date }) },
  // Forms the Assistant fills (cards the person submits) — in INTENTS so a
  // wording Gemini answered with them is learned: the local engine then fills
  // the same card with its own reading of the question.
  { tool: "prepare_movement_claim", keys: ["movement check in", "movement check out", "movement claim start", "মুভমেন্ট চেক ইন", "মুভমেন্ট চেক আউট"], args: (t) => parseMovementRequest(t) },
  { tool: "prepare_ride_booking", keys: ["book a ride", "gari book", "car book", "গাড়ি বুক", "gari lagbe", "গাড়ি লাগবে", "car lagbe", "ride book"], args: (t, c) => parseRideRequest(t, c.today) },
  { tool: "prepare_attendance_correction", keys: ["timesheet edit", "attendance correction", "hajira thik", "হাজিরা ঠিক", "check in dite bhule", "চেক ইন দিতে ভুলে", "punch dite bhule"], args: (t, c) => parseCorrectionRequest(t, c.today) },
  { tool: "my_leave_balance", keys: ["leave balance", "balance", "ব্যালেন্স", "chuti koto", "chuti baki", "koto chuti", "ছুটি কত", "কত ছুটি", "ছুটি বাকি", "বাকি ছুটি", "leave baki", "leave koto", "leave left", "how many leave", "কয় দিন ছুটি", "koydin chuti"] },
  { tool: "my_leave_applications", keys: ["leave status", "amar leave", "আমার ছুটির আবেদন", "আবেদনের অবস্থা", "application status", "approve hoyeche", "অনুমোদন হয়েছে", "approved hoise", "leave ki holo", "ছুটির কী হল", "ছুটির কি হলো", "my leave", "leave application"] },
  { tool: "my_late_days", keys: ["kon din late", "কোন দিন দেরি", "কোন কোন দিন", "late days", "which days late", "late er din", "দেরির দিন", "কবে দেরি", "kobe late"],
    args: (t, c) => { const p = attPeriodOf(t, c); return p.from ? { from: p.from, to: p.to } : {}; } },
  { tool: "my_attendance_summary", keys: ["attendance", "হাজিরা", "hajira", "present", "উপস্থিত", "absent", "অনুপস্থিত", "late", "দেরি", "লেট", "deri", "এটেন্ডেন্স", "অ্যাটেনডেন্স"],
    args: (t, c) => { const p = attPeriodOf(t, c); return p.month ? { month_year: p.month } : {}; } },
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
  { tool: "employee_leave_balance", keys: [" er chuti koto", " er leave balance", "এর ছুটি কত", "-এর ছুটি কত", " er koto chuti", "এর কত ছুটি", " er chuti baki", "এর ছুটি বাকি"],
    args: (t) => ({ name: nameBefore(t) }) },
  { tool: "employee_attendance", keys: [" er hajira", "এর হাজিরা", "-এর হাজিরা", " er attendance", "এর attendance", " er present", "koydin absent", "কয়দিন অনুপস্থিত", " er late", "এর দেরি"],
    args: (t, c) => {
      // "Nasrin er salary month er hajira": Payroll's dates; else the calendar month.
      const p = attPeriodOf(t, c, "hr");
      return p.salary_month ? { name: nameBefore(t), from: p.from, to: p.to, salary_month: p.salary_month } : { name: nameBefore(t), month_year: p.month || (hasAny(t, LAST_MONTH) ? monthShift(c.today.slice(0, 7), -1) : undefined) };
    } },
  { tool: "stuck_applications", keys: ["atke ache", "আটকে আছে", "stuck", "din dhore pending", "দিন ধরে পেন্ডিং", "din dhore pore", "অনেকদিন পড়ে", "onekdin pending", "3 din", "৩ দিন"],
    args: (t) => { const n = /(\d{1,2})\s*(?:din|দিন|days?)/.exec(toAsciiDigits(t))?.[1]; return { days: n ? Number(n) : 3 }; } },
  { tool: "exits_overview", keys: ["ke ke chole jacche", "কে কে চলে যাচ্ছে", "exit list", "exit koyta", "কয়টা exit", "offboarding", "অফবোর্ডিং", "resign koreche", "রিজাইন করেছে", "kar clearance", "কার clearance", "settlement baki", "সেটেলমেন্ট বাকি", "last working day ke"] },
  { tool: "recruitment_overview", keys: ["recruitment", "রিক্রুটমেন্ট", "interview", "ইন্টারভিউ", "khola pod", "খোলা পদ", "open position", "vacancy", "শূন্য পদ", "offer", "অফার", "candidate", "প্রার্থী", "job posting"] },
  { tool: "payroll_status", keys: ["payroll", "পে-রোল", "পেরোল", "salary kobe", "বেতন কবে", "beton kobe", "salary hold", "বেতন hold", "salary paid", "বেতন দেওয়া", "audit e ache", "salary sheet"],
    args: (t, c) => (hasAny(t, LAST_MONTH) ? { month_year: monthShift(c.today.slice(0, 7), -1) } : {}) },
  { tool: "asset_lookup", keys: ["kar kache", "কার কাছে", "asset koyta", "কয়টা asset", "asset khali", "খালি asset", "laptop koyta", "কয়টা laptop", "asset list", "who has", "কার নামে"],
    args: (t) => { const m = /(\S{2,30})\s+(?:kar kache|কার কাছে|কার নামে)/.exec(t) || /(?:who has|kar kache|কার কাছে)\s+(?!ache|আছে)(\S{2,30})/.exec(t); return { query: m ? m[1].replace(/[?]/g, "").trim() : "" }; } },
  { tool: "my_pending_approvals", keys: ["approve korar jonno", "approve er jonno", "amar kache approve", "অনুমোদনের জন্য কিছু", "অনুমোদন করার জন্য", "approve korte hobe ki", "amar kache approval", "amar approval", "আমার কাছে কয়টা", "আমার অনুমোদনের", "আমার কাছে অনুমোদন", "approval koyta", "koyta approval", "কয়টা approval", "pending approval amar", "amar kache pending", "আমার কাছে পেন্ডিং", "approve korte hobe", "approve বাকি", "approve baki", "waiting for my approval", "my approvals", "my pending approvals"] },
  { tool: "my_profile", keys: ["amar supervisor", "আমার supervisor", "আমার সুপারভাইজার", "amar boss", "my supervisor", "amar joining", "আমার যোগদান", "joining date", "যোগদানের তারিখ", "amar designation", "আমার পদবি", "amar podobi", "amar employee id", "আমার employee id", "আমার আইডি", "amar department", "আমার department", "my profile", "আমার প্রোফাইল", "amar profile", "koto bochor chakri", "কত বছর চাকরি", "amar confirmation", "probation kobe sesh"] },
  { tool: "my_assets", keys: ["amar asset", "আমার asset", "আমার অ্যাসেট", "amar kache ki asset", "আমার কাছে কী", "my asset", "laptop amar", "acknowledge asset", "asset acknowledge", "asset requisition status", "requisition koi", "asset er obostha"] },
  { tool: "my_rides", keys: ["amar ride", "আমার ride", "amar gari", "আমার গাড়ি", "gari booking", "গাড়ির বুকিং", "ride status", "my ride", "vehicle requisition status", "gari kobe", "গাড়ি কবে", "driver ke", "ড্রাইভার কে"] },
  { tool: "my_letters", keys: ["amar letter", "আমার চিঠি", "letter request status", "certificate request", "সার্টিফিকেট", "certificate kobe", "letter kobe", "chithi", "acknowledge letter", "hr ki cheyeche", "HR কী চেয়েছে", "hr amar kache", "info request", "document joma", "কী জমা দিতে হবে", "ki joma dite hobe"] },
  { tool: "my_targets_progress", keys: ["amar target", "আমার target", "আমার টার্গেট", "target koto", "target progress", "টার্গেট কত", "my target", "target deadline", "target koto percent"] },
  { tool: "my_mobile_sim", keys: ["amar sim", "আমার সিম", "mobile bill", "মোবাইল বিল", "amar bill limit", "sim limit", "phone bill", "ফোন বিল", "bill limit"] },
  { tool: "my_resignation", keys: ["amar resignation", "আমার resignation", "resignation status", "রিজাইন", "পদত্যাগ", "clearance koi", "clearance status", "ক্লিয়ারেন্স", "last working day", "শেষ কর্মদিবস", "amar exit"] },
  { tool: "my_cases", keys: ["amar complaint", "আমার অভিযোগ", "grievance status", "abhijog", "obhijog", "complaint status", "disciplinary", "শোকজ", "show cause"] },
  { tool: "my_team_attendance", keys: ["team attendance", "টিম হাজিরা", "amar team", "আমার টিম", "site attendance", "muster", "মাস্টার", "team er hajira", "টিমের হাজিরা"] },
  { tool: "upcoming_leaves", keys: ["ke ke leave application", "kara leave application", "leave application koreche", "leave application korche", "leave apply koreche", "ছুটির আবেদন করেছে", "ছুটির আবেদন করেছেন", "কে কে ছুটির আবেদন", "কারা ছুটির আবেদন",
      "koyta leave application", "কয়টা ছুটির আবেদন", "কতগুলো ছুটির আবেদন", "koyta leave", "কয়টা ছুটি", "upcoming leave", "samner leave", "সামনের ছুটির আবেদন", "next days leave", "next few days leave", "kal theke", "কাল থেকে", "ei month e leave", "এই মাসে ছুটি", "ei mase leave"],
    args: (t, c) => {
      const d = [...t.matchAll(/(\d{4}-\d{2}-\d{2})/g)].map((m) => m[1]);
      if (d.length) return { from: d[0], to: d[1] || undefined };
      if (hasAny(t, ["next week", "ei saptah", "এই সপ্তাহ", "সামনের সপ্তাহ", "7 din", "৭ দিন"])) return { from: addDays(c.today, 1), to: addDays(c.today, 7) };
      return {};
    } },
  { tool: "leave_pending_layers", keys: ["kon layer", "কোন লেয়ার", "কোন layer", "layer e atke", "লেয়ারে আটকে", "atke ache", "আটকে আছে", "atke ase", "kon step", "kon dhape", "কোন ধাপে", "কার কাছে আটকে", "kar kache atke", "kar kache pending", "stuck", "pending leave", "অপেক্ষমাণ ছুটি", "leave pending", "ছুটি পেন্ডিং"] },
  { tool: "late_on_date", keys: ["ke ke late", "kara late", "ke late", "কে কে দেরি", "কারা দেরি", "কে দেরি", "কে কে লেট", "কারা লেট", "late koreche", "late korse", "late eseche", "late ashche", "দেরিতে এসেছে", "দেরি করেছে", "লেট করেছে", "late list", "লেট লিস্ট", "দেরির তালিকা", "who came late", "who is late", "late today", "ajke late", "ajk late", "আজ দেরি", "আজকে দেরি", "আজ লেট"],
    args: (t, c) => {
      const d = /(\d{4}-\d{2}-\d{2})/.exec(t)?.[1];
      if (d) return { date: d };
      if (hasAny(t, ["gotokal", "গতকাল", "yesterday"])) return { date: addDays(c.today, -1) };
      return {};
    } },
  { tool: "hr_dashboard", keys: ["dashboard", "ড্যাশবোর্ড", "সারসংক্ষেপ", "summary", "overview", "ওভারভিউ"], args: () => ({ section: "summary" }) },
  { tool: "hr_dashboard", keys: ["birthday", "জন্মদিন", "jonmodin", "jonmo din"], args: () => ({ section: "birthdays" }) },
  { tool: "hr_dashboard", keys: ["probation", "প্রবেশন", "প্রবেশনারি", "confirmation", "কনফার্মেশন"], args: () => ({ section: "probation" }) },
  { tool: "hr_dashboard", keys: ["contract", "চুক্তি", "কন্ট্রাক্ট"], args: () => ({ section: "contract" }) },
  { tool: "hr_dashboard", keys: ["expire", "expiry", "মেয়াদ শেষ", "মেয়াদোত্তীর্ণ", "ডকুমেন্টের মেয়াদ", "document er meyad", "meyad sesh"], args: () => ({ section: "documents_expiry" }) },
  { tool: "hr_dashboard", keys: ["promotion", "পদোন্নতি", "transfer", "বদলি", "personnel action", "কার্যকর হবে", "status effective", "effective"], args: () => ({ section: "personnel_actions" }) },
  { tool: "hr_dashboard", keys: ["document request", "letter request", "certificate request", "চিঠির অনুরোধ", "তথ্য জমা", "info request"], args: () => ({ section: "document_requests" }) },
  { tool: "hr_dashboard", keys: ["attendance approval", "attendance correction", "হাজিরা সংশোধন", "হাজিরা অনুমোদন", "correction"], args: () => ({ section: "attendance_approvals" }) },
  { tool: "on_leave", keys: ["ke ke chutite", "কে কে ছুটিতে", "ছুটিতে আছে", "ছুটিতে কে", "কারা ছুটিতে", "on leave", "chutite ache", "chutite ke", "leave e ache", "leave a ache"],
    args: (t, c) => (hasAny(t, ["kal", "কাল", "tomorrow", "আগামীকাল"]) ? { date: addDays(c.today, 1) } : {}) },
  { tool: "active_notices", keys: ["notice", "নোটিশ", "ঘোষণা", "announcement"] },
  { tool: "onboarding_overview", keys: ["onboarding", "অনবোর্ডিং", "joiner", "নতুন যোগদান", "id card", "আইডি কার্ড", "business card", "বিজনেস কার্ড"] },
  { tool: "service_length", keys: ["bochor hoiche", "bochor hoyeche", "bochor hoise", "bochor holo", "bochor purno", "বছর হয়েছে", "বছর হলো", "বছর হল", "বছর পূর্ণ", "বছর ধরে", "bochor dhore",
      "years of service", "year of service", "service length", "length of service", "years in company", "service year", "চাকরির মেয়াদ", "chakrir meyad", "চাকরির বয়স",
      "work anniversary", "job anniversary", "service anniversary", "বর্ষপূর্তি"],
    args: (t) => {
      const a = toAsciiDigits(t);
      const n = /(\d{1,2})\s*(?:\+\s*)?(?:bochor|বছর|years?|yrs?)/.exec(a)?.[1];
      const mode = hasAny(a, ["anniversary", "বর্ষপূর্তি", "ei bochor", "এই বছর", "this year", "e bochor", "এ বছর"]) ? "this_year"
        : hasAny(a, ["thik", "ঠিক", "exactly"]) ? "exact" : "at_least";
      return { years: n ? Number(n) : 10, mode };
    } },
  { tool: "target_progress", keys: ["department target", "department er target", "department wise target", "dept target", "বিভাগের target", "department-এর target", "target report", "টার্গেট রিপোর্ট", "sobar target", "সবার target", "সবার টার্গেট", "company target", "কোম্পানির target", "team target", "kar target koto", "কার target কত", "target achievement"],
    args: (t, c) => ({ name: subjectBefore(t), ...(hasAny(t, LAST_MONTH) ? { month: monthShift(c.today.slice(0, 7), -1) } : hasAny(t, ["ei bochor", "এই বছর", "this year", "puro bochor", "পুরো বছর", "yearly", "বার্ষিক"]) ? { year: c.today.slice(0, 4) } : {}) }) },
  { tool: "task_overview", keys: ["overdue task", "task overdue", "task er deadline", "sobar task", "সবার task", "সবার টাস্ক", "company task", "khola task", "খোলা task", "open task", "task koyta", "কয়টা task", "koyta task", "task report", "টাস্ক রিপোর্ট", "department er task", "department-এর task", " er task", "এর task", "-এর task", "এর টাস্ক", "kar task baki", "কার task বাকি", "ke ke task", "task kar kache", "pending task"],
    args: (t) => ({ name: subjectBefore(t) }) },
  { tool: "performance_overview", keys: ["performance", "পারফরম্যান্স", "appraisal", "অ্যাপ্রেইজাল", "review cycle", "performance review", "rating koto", "রেটিং", "kpi", "goal setting", "evaluation", "মূল্যায়ন"],
    args: (t) => ({ name: subjectBefore(t) }) },
  { tool: "document_vault_overview", keys: ["document vault", "ডকুমেন্ট ভল্ট", "document expire", "kar document", "কার document", "কার ডকুমেন্ট", "sign baki", "সই বাকি", "signature baki", "unsigned document", "passport expire", "পাসপোর্টের মেয়াদ", "er document", "এর document", "-এর ডকুমেন্ট"],
    args: (t) => { const n = /(\d{1,3})\s*(?:din|দিন|days?)/.exec(toAsciiDigits(t))?.[1]; return { name: subjectBefore(t), days: n ? Number(n) : undefined }; } },
  { tool: "vehicle_overview", keys: ["vehicle", "ভেহিকেল", "gari koyta", "কয়টা গাড়ি", "gari khali", "খালি গাড়ি", "kon gari", "কোন গাড়ি", "ride request", "ajker ride", "আজকের ride", "fleet", "driver koi", "গাড়ি কোথায়", "gari kothay", "sobar ride", "ride pending"] },
  { tool: "daily_hr_report", keys: ["hr report", "hr রিপোর্ট", "এইচআর রিপোর্ট", "hr-এর রিপোর্ট", "daily report", "daily hr", "dainik report", "দৈনিক রিপোর্ট", "ajker report", "আজকের রিপোর্ট", "ajker hr", "আজকের hr", "আজকের এইচআর", "today's report", "todays report", "today report", "today's hr", "din er report", "দিনের রিপোর্ট", "ajker summary", "আজকের সারসংক্ষেপ", "ajker update", "আজকের আপডেট"],
    args: (t, c) => { const d = /(\d{4}-\d{2}-\d{2})/.exec(t)?.[1]; return d ? { date: d } : hasAny(t, ["gotokal", "গতকাল", "yesterday", "kalker", "কালকের"]) ? { date: addDays(c.today, -1) } : {}; } },
  { tool: "employee_breakdown", keys: ["religion", "ধর্ম", "dhormo", "hindu", "হিন্দু", "muslim", "মুসলিম", "মুসলমান", "buddhist", "বৌদ্ধ", "christian", "খ্রিস্টান", "খ্রিষ্টান",
      "hindu employee", "muslim employee", "হিন্দু কর্মী", "মুসলিম কর্মী", "female employee", "male employee", "মহিলা কর্মী", "নারী কর্মী", "পুরুষ কর্মী", "gender wise", "লিঙ্গ",
      "blood group", "রক্তের গ্রুপ", "married employee", "unmarried employee", "বিবাহিত", "অবিবাহিত", "marital"],
    args: (t) => breakdownArgs(t) },
  { tool: "headcount", keys: ["headcount", "হেডকাউন্ট", "মোট কর্মী", "কতজন কর্মী", "koto jon employee", "kotojon employee", "total employee", "how many employee", "কর্মী সংখ্যা"] }
];

const OWN_TOOL: Record<string, string> = { employee_attendance: "my_attendance_summary", late_on_date: "my_late_days", task_overview: "my_tasks", target_progress: "my_targets_progress", vehicle_overview: "my_rides" };

const GREET = ["hi", "hello", "hey", "salam", "assalam", "হাই", "হ্যালো", "সালাম", "আসসালাম", "kemon acho", "kemon achen", "কেমন আছ", "good morning", "শুভ সকাল",
  "ki khobor", "কী খবর", "কি খবর", "ki obostha apnar", "valo achen", "ভালো আছেন", "how are you"];
const THANKS = ["thanks", "thank you", "ধন্যবাদ", "dhonnobad", "thx", "অনেক ধন্যবাদ"];

function suggestionsFor(c: Ctx): string[] {
  const s = ["আমার ছুটি কত বাকি?", "এই মাসে কয়দিন দেরি করেছি?", ...(canNav(c, "self:leaveApplication") ? ["ছুটির আবেদন কীভাবে করব?"] : ["Password কীভাবে বদলাব?"]), "সামনের ছুটির দিন কবে?"];
  if (canDash(c)) s.unshift("HR Dashboard-এর সারসংক্ষেপ দাও", "কী কী অপেক্ষায় আছে?");
  if (hasMod(c, "attendance_reports")) s.unshift("আজ কে কে অনুপস্থিত?");
  if (hasMod(c, "hr_operations")) s.push("Onboarding-এ কার কী বাকি?");
  return s.slice(0, 7);
}

// "I want a human" — checked before everything else ("kotha" would otherwise
// read as "kothay", a how-to question).
const HUMAN_WORDS = ["human", "manush", "মানুষ", "agent", "এজেন্ট", "live chat", "লাইভ চ্যাট", "real person", "admin er sathe", "admin-এর সাথে", "অ্যাডমিনের সাথে",
  "superadmin er sathe", "সুপারঅ্যাডমিন", "support", "সাপোর্ট", "কারো সাথে কথা", "karo sathe kotha", "kotha bolte chai", "কথা বলতে চাই", "talk to someone", "hr er sathe kotha", "এইচআর-এর সাথে কথা", "hr-এর সাথে কথা"];

const LEAVE_WORDS = ["leave", "ছুটি", "chuti", "chhuti", "ছুটির"];
const APPLY_WORDS = ["kore dao", "kore den", "করে দাও", "করে দিন", "দিয়ে দাও", "diye dao", "apply", "অ্যাপ্লাই", "এপ্লাই", "lagbe", "লাগবে", "chai", "চাই", "nibo", "নেব", "নিব", "nite chai", "dao", "দাও"];
const HOLIDAY_WORDS = ["ছুটির দিন", "holiday", "সরকারি ছুটি", "chutir din"];

// Asking for an office car ("gari lagbe", "book a ride", "car book koro") —
// not asking about one already booked ("gari kothay", "ride status").
const RIDE_WORDS = ["gari", "gaari", "গাড়ি", "গাড়ী", "car", "ride", "রাইড", "vehicle", "ভেহিকেল", "microbus", "মাইক্রো"];
const RIDE_ASK = ["book", "বুক", "lagbe", "লাগবে", "chai", "চাই", "dorkar", "দরকার", "nibo", "নেব", "nite", "নিতে", "need", "want", "requisition", "রিকুইজিশন", "jabo", "যাব", "যাবো", "pathao", "পাঠাও"];
const RIDE_STATUS = ["status", "স্ট্যাটাস", "kothay", "কোথায়", "ki holo", "কী হল", "কি হলো", "approve", "অনুমোদন", "koyta", "কয়টা", "list", "তালিকা", "cancel", "বাতিল", "driver ke", "কে চালাবে"];
// An attendance question the Report Builder answers: a clock time with
// came / left, no check-out, work hours, overtime, early leave, "N times",
// or attendance by department / person / day. Plain "aj ke absent" /
// "aj ke late" keep their own answers.
const wantsAttendanceQuery = (t: string, raw: string) => {
  const att = /(asche|asc?he|এসেছে|আসছে|eseche|esheche|ber|বের|out|আউট|in time|ইন টাইম|attendance|হাজিরা|hajira|late|দেরি|deri|লেট|absent|অনুপস্থিত|check ?out|check ?in|overtime|ওভারটাইম|ghonta|ঘণ্টা|hours?|chole|চলে|left|came|arrive|ঢুক|dhuk)/.test(t);
  if (!att) return false;
  const p = parseAttendanceQuestion(raw);
  // "goto maser kara late / absent chilo": who, over a month — a list of
  // people (a single day stays with the day's own late / absent answers).
  const who = hasAny(t, ["kara", "কারা", "ke ke", "কে কে", "kon kon", "কোন কোন", "who "]);
  const overMonth = hasAny(t, LAST_MONTH) || hasAny(t, THIS_MONTH) || hasAny(t, SALARY_MONTH);
  return !!(p.in_after || p.in_before || p.out_before || p.out_after || p.missing_out || p.min_hours || p.max_hours || p.overtime || p.early_leave || p.min_count || p.group_by || (p.department && (p.status || p.late)) || (who && overMonth && (p.late || p.status)));
};
// Starting / ending a Movement Claim ("movement check in koro", "client
// visit e jacchi movement", "pouche gechi movement check out") — not asking
// about past claims ("movement claim koto", "kototi").
const wantsMovement = (t: string) =>
  hasAny(t, ["movement", "মুভমেন্ট"]) &&
  hasAny(t, ["check in", "checkin", "check out", "checkout", "চেক ইন", "চেক আউট", "start", "শুরু", "shuru", "jacchi", "যাচ্ছি", "jabo", "যাব", "pouch", "পৌঁছ", "kaj shesh", "কাজ শেষ", "end", "koro", "করো", "dao", "দাও", "kore", "করে"]) &&
  !hasAny(t, ["koto", "কত", "kototi", "কতটি", "koyta", "কয়টা", "list", "তালিকা", "history", "ki holo", "কী হল", "status", "total", "মোট", "km", "কিলো", "kivabe", "কিভাবে", "কীভাবে", "report", "রিপোর্ট", "sobar", "সবার"]);
const wantsRide = (t: string) => hasAny(t, RIDE_WORDS) && hasAny(t, RIDE_ASK) && !hasAny(t, RIDE_STATUS);
// Correcting a day's In / Out ("check in dite bhule gechi", "timesheet edit",
// "hajira thik kore dao") — not asking what the timesheet shows.
const CORRECTION_WORDS = ["timesheet", "টাইমশিট", "correction", "কারেকশন", "correct attendance", "attendance thik", "hajira thik", "হাজিরা ঠিক", "attendance edit", "edit attendance",
  "in time", "out time", "ইন টাইম", "আউট টাইম", "check in", "checkin", "check out", "checkout", "চেক ইন", "চেক আউট", "punch", "পাঞ্চ"];
const CORRECTION_ASK = ["thik", "ঠিক", "correct", "edit", "এডিট", "bhule", "ভুলে", "vule", "forgot", "missed", "miss", "dite pari nai", "দিতে পারিনি", "korte pari nai", "করতে পারিনি",
  "bosao", "বসাও", "add", "dao", "দাও", "kore dao", "করে দাও", "change", "বদল", "update", "lagbe", "লাগবে"];
const wantsCorrection = (t: string) => hasAny(t, CORRECTION_WORDS) && hasAny(t, CORRECTION_ASK) && !hasAny(t, ["status", "স্ট্যাটাস", "ki holo", "কী হল", "approve hoyeche", "অনুমোদন হয়েছে"]);

// The keyword engine: an answer when the question matches something, else null.
async function matchLocal(c: Ctx, message: string): Promise<Answer | null> {
  const t = norm(message);
  const asksHow = hasAny(t, HOW);

  if (hasAny(t, HUMAN_WORDS)) {
    const r = await TOOLS.find((x) => x.name === "request_human_support")!.run(c, {});
    return { reply: r.text, actions: r.actions || [] };
  }

  // "aj 9:05 er pore ke ke asche", "6 tar age ke ber hoye geche", "ei mase
  // 3 bar er beshi late kara" -> the Attendance Report Builder.
  if (wantsAttendanceQuery(t, message) && !asksHow) {
    const tool = TOOLS.find((x) => x.name === "attendance_custom_report")!;
    if (!toolAvailable(tool, c)) return { reply: NO_ACCESS.text, actions: [] };
    const r = await tool.run(c, { ...parseAttendanceQuestion(message), ...attPeriodOf(t, c, "hr") });
    return { reply: r.text, actions: allowedActions(c, r.actions || []), report: r.report };
  }
  // "client visit e jacchi movement check in koro" -> a Movement Claim card
  if (wantsMovement(t) && !asksHow) {
    const tool = TOOLS.find((x) => x.name === "prepare_movement_claim")!;
    if (!toolAvailable(tool, c)) return { reply: "Movement Claim আপনার account-এ চালু নেই। দরকার হলে HR / Superadmin-কে বলুন — তাঁরা Module Access থেকে চালু করে দিতে পারবেন।", actions: [] };
    const r = await tool.run(c, parseMovementRequest(message));
    return { reply: r.text, actions: allowedActions(c, r.actions || []), draft: r.draft };
  }
  // "kal 10 tay gulshan jabo gari lagbe" -> a Book a Ride draft card
  if (wantsRide(t) && !asksHow) {
    const r = await TOOLS.find((x) => x.name === "prepare_ride_booking")!.run(c, parseRideRequest(message, c.today));
    return { reply: r.text, actions: [], draft: r.draft };
  }
  // "gotokal check in dite bhule gechi 9:10 e ashchi" -> a Correct Attendance draft card
  if (wantsCorrection(t) && !asksHow) {
    const tool = TOOLS.find((x) => x.name === "prepare_attendance_correction")!;
    if (!toolAvailable(tool, c)) return { reply: "Timesheet / হাজিরা ঠিক করা আপনার account-এ চালু নেই। দরকার হলে HR / Superadmin-কে বলুন — তাঁরা Module Access থেকে চালু করে দিতে পারবেন।", actions: [] };
    const r = await tool.run(c, parseCorrectionRequest(message, c.today));
    return { reply: r.text, actions: [], draft: r.draft };
  }

  // "20 oct family problem niye leave application kore dao" -> a draft card
  if (hasAny(t, LEAVE_WORDS) && !hasAny(t, HOLIDAY_WORDS) && !asksHow) {
    const parsed = parseLeaveRequest(message, c.today);
    const asksStatus = hasAny(t, ["balance", "ব্যালেন্স", "baki", "বাকি", "koto", "কত", "status", "অবস্থা", "ki holo", "কী হল", "কি হলো", "কী হলো", "jante", "জানতে",
      "ছুটিতে", "chutite", "on leave", "leave e ache", "ke ke", "কে কে", "kara", "কারা", "report", "রিপোর্ট",
      "koyta", "কয়টা", "কতগুলো", "koreche", "korche", "করেছে", "করেছেন", "layer", "লেয়ার", "atke", "আটকে", "pending", "পেন্ডিং", "kon", "কোন"]);
    const wantsApply = !asksStatus && (hasAny(t, APPLY_WORDS) || !!parsed.start_date);
    if (wantsApply) {
      const tool = TOOLS.find((x) => x.name === "prepare_leave_application")!;
      if (!toolAvailable(tool, c)) return { reply: "ছুটির আবেদন আপনার account-এ চালু নেই। দরকার হলে HR / Superadmin-কে বলুন — তাঁরা Module Access থেকে চালু করে দিতে পারবেন।", actions: [] };
      const r = await tool.run(c, { ...parsed, leave_type: parsed.leave_type || undefined });
      return { reply: r.text, actions: [], draft: r.draft };
    }
  }

  // "find X" / "X-এর নম্বর"
  const find = /(?:find|search|khujo|khuje dao|খুঁজ\S*)\s+(.{2,40})/.exec(t)?.[1] ||
    /\s(.{2,30}?)\s*(?:er|এর|-এর|'s)\s*(?:number|nombor|নম্বর|নাম্বার|phone|ফোন|mobile|মোবাইল|email|ইমেইল|designation|পদবি)/.exec(t)?.[1];
  if (find && !asksHow) {
    const r = await TOOLS.find((x) => x.name === "find_colleague")!.run(c, { query: find.replace(/\s+(er|এর|ke|কে)$/, "").trim() });
    return { reply: r.text, actions: r.actions || [] };
  }

  // "<name> er ... hajira / chuti": about that person, not the asker.
  const other = !asksHow && !hasAny(t, [" amar ", "আমার", " ami ", "আমি "]) ? nameBefore(t) : "";
  if (other) {
    const kind = hasAny(t, ["hajira", "হাজিরা", "attendance", "present", "absent", "অনুপস্থিত", "late", "দেরি", "লেট"]) ? "employee_attendance"
      : hasAny(t, ["chuti", "ছুটি", "leave", "balance", "ব্যালেন্স"]) ? "employee_leave_balance" : null;
    if (kind) {
      const tool = TOOLS.find((x) => x.name === kind)!;
      if (!toolAvailable(tool, c)) return { reply: NO_ACCESS.text, actions: [] };
      // The same period rules as the intent (calendar month; Payroll's dates
      // when "salary month" is said).
      const intent = INTENTS.find((i) => i.tool === kind);
      const args = kind === "employee_attendance" && intent?.args ? { ...intent.args(t, c), name: other } : { name: other, month_year: hasAny(t, LAST_MONTH) ? monthShift(c.today.slice(0, 7), -1) : undefined };
      const r = await tool.run(c, args);
      return { reply: r.text, actions: allowedActions(c, r.actions || []), report: r.report };
    }
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

  // A how-to entry that matches more of the question than the best data
  // question ("leave balance set korbo" is about setting, not reading, it).
  const helpScore = Math.max(0, ...HELP.map((h) => helpKeyScore(h, t)));
  // …unless it asks where something stands ("ki holo", "status", "koi").
  const asksState = hasAny(t, ["ki holo", "ki hoise", "ki hoyeche", "কী হল", "কি হলো", "কী হলো", "কি হল", "obostha", "অবস্থা", "status", " koi ", " কই ", "kothay ache", "কোথায় আছে", "koto ", "কত ", "kobe", "কবে"]);
  const helpWins = (help.length || blockedHelp.length) && helpScore > (scored[0]?.score || 0) && !asksState;
  if (scored.length && !(asksHow && (help.length || blockedHelp.length)) && !helpWins) {
    // "amar / ami … late" is about the asker's own days, not everyone's
    // (the same for tasks, targets and rides).
    const own = OWN_TOOL[scored[0].i.tool];
    // "october er hajira" names a month, not a person: the asker's own.
    const noName = scored[0].i.tool === "employee_attendance" && !nameBefore(t);
    const intent = own && (noName || hasAny(t, [" amar ", " ami ", "আমার", "আমি", " my ", " i "]))
      ? INTENTS.find((i) => i.tool === own)!
      : scored[0].i;
    const tool = TOOLS.find((x) => x.name === intent.tool)!;
    if (!toolAvailable(tool, c)) return { reply: NO_ACCESS.text, actions: [] };
    // Form tools read the question as typed ("9.10" is a time, not "9 10").
    const r = await tool.run(c, intent.args ? intent.args(intent.tool.startsWith("prepare_") ? message : t, c) : {});
    return { reply: r.text, actions: allowedActions(c, r.actions || []), report: r.report, draft: r.draft };
  }
  if (help.length) {
    return { reply: help.map((h) => `**${h.title}:** ${h.steps}`).join("\n\n"), actions: help.flatMap(helpAction) };
  }
  if (blockedHelp.length) return blockedHelpAnswer(blockedHelp[0]);
  return null;
}

const blockedHelpAnswer = (h: HelpEntry): Answer => ({
  reply: `"${h.title}" আপনার account-এ চালু নেই। দরকার হলে HR / Superadmin-কে বলুন — তাঁরা Module Access থেকে চালু করে দিতে পারবেন।`,
  actions: []
});

// Keyword match, then the same with misspelt words corrected.
async function matchWithSpelling(c: Ctx, message: string): Promise<Answer | null> {
  // A form request is read as typed (spelling fixes would change the
  // reason / place words that go into the card).
  const asTyped = norm(message);
  if (wantsMovement(asTyped) || wantsRide(asTyped) || wantsCorrection(asTyped)) {
    const r = await matchLocal(c, message);
    if (r) return r;
  }
  const fixed = fixSpelling(message);
  if (fixed !== norm(message)) {
    const r = await matchLocal(c, fixed);
    if (r) return r;
  }
  return matchLocal(c, message);
}

// Runs what a learned / similar question was answered with — through the
// same access checks as everything else: a tool this account can't use is
// "no access", a page it can't open is "not turned on for your account".
const learnedUsable = (c: Ctx, l: LearnedRow) => {
  if (l.help_id) {
    const h = HELP.find((x) => x.id === l.help_id);
    return !!h && (!h.can || h.can(c));
  }
  const tool = TOOLS.find((x) => x.name === l.tool);
  return !!tool && toolAvailable(tool, c);
};

async function answerLearned(c: Ctx, message: string, hit: LearnedRow): Promise<Answer> {
  const t = norm(message);
  if (hit.help_id) {
    const h = HELP.find((x) => x.id === hit.help_id);
    if (!h) return { reply: "", actions: [] };
    if (h.can && !h.can(c)) return blockedHelpAnswer(h);
    return { reply: `**${h.title}:** ${h.steps}`, actions: helpAction(h) };
  }
  const tool = TOOLS.find((x) => x.name === hit.tool);
  if (!tool) return { reply: "", actions: [] };
  if (!toolAvailable(tool, c)) return { reply: NO_ACCESS.text, actions: [] };
  const intent = INTENTS.find((i) => i.tool === tool.name);
  const r = await tool.run(c, { ...(intent?.args ? intent.args(message, c) : {}), ...(hit.args || {}) });
  return { reply: r.text, actions: allowedActions(c, r.actions || []), report: r.report, draft: r.draft };
}

async function localAnswer(c: Ctx, message: string, history: { role: string; text: string }[] = []): Promise<Answer> {
  // "amar salary month er attendance" is about attendance in the salary
  // month we are in, not about Payroll: read it as "ei maser attendance"
  // (attPeriodOf turns "ei mas" into the salary month's dates).
  if (hasAny(norm(message), SALARY_MONTH) && /(attendance|hajira|হাজিরা|present|absent|late|deri|দেরি|লেট|উপস্থিত|অনুপস্থিত|এটেন্ডেন্স|অ্যাটেনডেন্স|in time|out time|check ?in|check ?out|চেক ইন|চেক আউট|overtime|ওভারটাইম|ghonta|ঘণ্টা|asche|এসেছে|ber hoy|বের)/i.test(message)) {
    // "goto / last / আগের salary month" -> the salary month before.
    message = message
      .replace(/(goto|gato|last|previous|ager|আগের|গত)?\s*(salary|স্যালারি|বেতনের|বেতন|beton\s*er|betoner|payroll)\s*(month|mash|mas|মাস|মান্থ)(\s*(er|এর))?/gi, (_m, prev) => (prev ? " gotomaser " : " ei maser "))
      .replace(/\s+/g, " ")
      .trim();
    c = { ...c, salaryAsked: true };
  }
  const t = norm(message);
  // A question that is (nearly) one Gemini answered, or a built-in example,
  // goes the way it went then — when this account may use that answer.
  const strong = closestLearned(message, 0.7) || closestLearned(fixSpelling(message), 0.7);
  if (strong && learnedUsable(c, strong)) {
    const r = await answerLearned(c, message, strong);
    if (r.reply) return r;
  }
  const matched = await matchWithSpelling(c, message);
  if (matched) return matched;
  if (hasAny(t, THANKS)) return { reply: "আপনাকেও ধন্যবাদ! আর কিছু লাগলে জিজ্ঞেস করুন। 🙂", actions: [] };
  if (hasAny(t, GREET) && t.trim().split(" ").length <= 4) {
    return { reply: `আসসালামু আলাইকুম, ${c.name.split(" ")[0]}! আমি Credence Assistant। আপনার ছুটি, হাজিরা, claim, loan বা app-এর কোন কাজ কোথায় — জিজ্ঞেস করুন।`, actions: [] };
  }
  // A question Gemini answered before (this or a close wording of it).
  const hit = closestLearned(message) || closestLearned(fixSpelling(message));
  if (hit) {
    const r = await answerLearned(c, message, hit);
    if (r.reply) return r;
  }
  // A short follow-up ("ar gotomaser?", "rahim er?") read together with the
  // previous question.
  const prev = [...history].reverse().find((m) => m.role !== "assistant")?.text;
  const known = fixSpelling(message).trim().split(" ").some((w) => knownWords().has(w)) || /\s(er|এর)\s|-এর/.test(t);
  if (prev && known && t.trim().split(" ").length <= 4) {
    // The new words first, so a new name ("ar karim er?") wins over the old one.
    const both = await matchWithSpelling(c, `${message} ${prev}`);
    if (both) return both;
  }
  if (hasAny(t, GREET)) {
    return { reply: `আসসালামু আলাইকুম, ${c.name.split(" ")[0]}! আমি Credence Assistant। আপনার ছুটি, হাজিরা, claim, loan বা app-এর কোন কাজ কোথায় — জিজ্ঞেস করুন।`, actions: [] };
  }
  return {
    reply: "দুঃখিত, প্রশ্নটা বুঝতে পারিনি। এভাবে জিজ্ঞেস করে দেখুন:\n" + suggestionsFor(c).map((s) => `• ${s}`).join("\n") + "\n\nঅথবা একজন মানুষের সাথে সরাসরি কথা বলুন।",
    actions: [{ label: "মানুষের সাথে কথা বলুন", nav: "support:request" }]
  };
}

// ---------------------------------------------------------------------------
// Learning — so the local engine keeps answering when Gemini can't (its free
// quota used up, no key, Google unreachable).
//   - Every question Gemini answers with ONE tool or ONE how-to entry is kept
//     (assistant_learned: the question and which tool / entry — never the
//     answer itself, which belongs to the asker). Later the local engine runs
//     that same tool for whoever asks a similar question, with that person's
//     own access — so nothing is ever shown that the asker couldn't open.
//   - Misspellings ("atendance", "balence", "hajra") are corrected against
//     every word the engine knows before giving up.
// ---------------------------------------------------------------------------
const LEARNABLE = new Set(INTENTS.map((i) => i.tool));
const LEARN_ARG_KEYS = new Set(["section", "field", "mode", "report", "preset", "kind"]);
interface LearnedRow { question: string; tool: string | null; help_id: string | null; args: Record<string, any> | null; grams: Set<string> }
// Built-in examples: questions worded the way people actually ask, each
// with what answers it ("help:<id>" = a how-to entry). Known from the start,
// before Gemini has taught anything; what Gemini teaches is added on top.
const TRAINING: [string, string, Record<string, any>?][] = [
  ["e bochor ke koto casual leave niyeche", "company_report", { report: "leave_taken" }], ["এই মাসে কত টাকার bill দেওয়া বাকি", "company_report", { report: "bill_disbursements" }],
  ["kon gari koto cholse ei mase", "company_report", { report: "vehicle_utilization" }], ["asset register dekhao", "company_report", { report: "asset_register" }],
  ["aj 9:05 er pore ke ke asche", "attendance_custom_report"], ["আজ ৬টার আগে কে কে বের হয়ে গেছে", "attendance_custom_report"], ["ei mase 3 bar er beshi late kara korse", "attendance_custom_report"],
  ["gotokal check out den nai kara", "attendance_custom_report"], ["who came after 9:15 today", "attendance_custom_report"], ["ei soptahe 8 ghontar kom kaj korse ke", "attendance_custom_report"],
  ["department wise ajker hajira", "attendance_department_summary"], ["ei mase kon department e beshi absent", "attendance_department_summary"],
  ["gotomaser sathe beton er parthokko", "payroll_month_comparison"], ["এ মাসে বেতন কেন বেড়েছে", "payroll_month_comparison"], ["salary sheet dekhao", "payroll_salary_sheet"],
  ["kar kar document jama dewa baki", "employee_records_report", { preset: "pending_documents" }], ["blood group onujayi talika", "employee_records_report", { preset: "blood_group_directory" }],
  ["mobile bill e ke limit er beshi korse", "mobile_bill_report"], ["ekhon ke ke tracking e ache", "tracking_overview"], ["ajke ke break e", "break_report"],
  ["management dashboard er summary dao", "management_dashboard_overview"], ["kon project budget submit koreni", "pepm_report", { kind: "budget_submission" }],
  ["client visit e jacchi movement check in koro", "prepare_movement_claim"], ["movement claim check in kore dao", "prepare_movement_claim"], ["মুভমেন্ট চেক ইন করো ব্যাংকে যাচ্ছি", "prepare_movement_claim"],
  ["pouche gechi movement check out koro", "prepare_movement_claim"], ["movement claim shesh koro", "prepare_movement_claim"], ["start a movement claim for site visit", "prepare_movement_claim"],
  ["kal sokal 10 tay office theke gulshan jabo gari lagbe", "prepare_ride_booking"], ["ekta gari book kore dao", "prepare_ride_booking"], ["আমার একটা গাড়ি লাগবে", "prepare_ride_booking"],
  ["book a car for tomorrow 3pm", "prepare_ride_booking"], ["client meeting e jete hobe car dorkar", "prepare_ride_booking"], ["গাড়ি বুক করে দাও", "prepare_ride_booking"],
  ["gotokal check in dite bhule gechi", "prepare_attendance_correction"], ["amar timesheet edit kore dao", "prepare_attendance_correction"], ["হাজিরা ঠিক করে দাও", "prepare_attendance_correction"],
  ["out time bosano hoyni", "prepare_attendance_correction"], ["i forgot to check out yesterday", "prepare_attendance_correction"], ["punch dite pari nai attendance correction lagbe", "prepare_attendance_correction"],
  ["amar koydin chuti ache", "my_leave_balance"], ["ar koto din leave nite parbo", "my_leave_balance"], ["আমি আর কয়দিন ছুটি নিতে পারব", "my_leave_balance"],
  ["casual leave koyta ache", "my_leave_balance"], ["sick leave baki ache koto", "my_leave_balance"], ["how many days off do i have", "my_leave_balance"],
  ["amar dorkhaster ki obostha", "my_leave_applications"], ["chutir abedon approve hoyeche ki", "my_leave_applications"], ["আমার ছুটি মঞ্জুর হয়েছে কি", "my_leave_applications"],
  ["is my leave approved", "my_leave_applications"], ["leave reject hoise keno", "my_leave_applications"],
  ["ei mase koydin office e aschi", "my_attendance_summary"], ["এই মাসে কয়দিন অফিসে এসেছি", "my_attendance_summary"], ["amar in time out time", "my_attendance_summary"],
  ["koydin deri te aschi", "my_attendance_summary"], ["how many days was i late this month", "my_attendance_summary"], ["amar absent koto din", "my_attendance_summary"],
  ["amar salary month er attendance report", "my_attendance_summary"], ["বেতনের মাসের হাজিরা", "my_attendance_summary"], ["beton er maser hajira koto", "my_attendance_summary"], ["october er hajira", "my_attendance_summary"],
  ["kon kon din late hoyeche", "my_late_days"], ["কোন দিনগুলোতে দেরি হয়েছে", "my_late_days"], ["which dates was i late", "my_late_days"],
  ["amar taka kobe pabo bill er", "my_claims"], ["আমার বিলের টাকা কবে পাব", "my_claims"], ["claim er taka paid hoise", "my_claims"], ["my claim status", "my_claims"],
  ["amar loan koto baki", "my_loans"], ["আমার লোনের কিস্তি কত", "my_loans"], ["advance er taka koto kete nibe", "my_loans"], ["how much loan is left", "my_loans"],
  ["amar kaj ki ki baki ache", "my_tasks"], ["আমাকে কী কী কাজ দেওয়া হয়েছে", "my_tasks"], ["what tasks are assigned to me", "my_tasks"],
  ["samne kobe chuti", "upcoming_holidays"], ["eid er chuti kobe theke", "upcoming_holidays"], ["সামনে সরকারি ছুটি কবে", "upcoming_holidays"], ["next public holiday", "upcoming_holidays"],
  ["amar kache koyta file approve er jonno ache", "my_pending_approvals"], ["আমাকে কী কী অনুমোদন করতে হবে", "my_pending_approvals"], ["what is waiting for my approval", "my_pending_approvals"],
  ["amar boss ke", "my_profile"], ["আমার রিপোর্টিং কে", "my_profile"], ["ami kobe join korechi", "my_profile"], ["who is my reporting manager", "my_profile"], ["amar id number koto", "my_profile"],
  ["amar nam e ki ki jinish ache", "my_assets"], ["আমার নামে কী কী জিনিস আছে", "my_assets"], ["what assets do i have", "my_assets"],
  ["gari booking dewa ache ki", "my_rides"], ["আমার গাড়ির রিকুইজিশন", "my_rides"], ["is my car booked", "my_rides"],
  ["salary certificate er request ki holo", "my_letters"], ["আমার চিঠি এসেছে কি", "my_letters"],
  ["amar target koto hoise", "my_targets_progress"], ["আমার লক্ষ্য কতদূর", "my_targets_progress"], ["how far is my target", "my_targets_progress"],
  ["amar sim er limit koto", "my_mobile_sim"], ["এই মাসের ফোন বিল কত", "my_mobile_sim"],
  ["amar chakri chharar abedon er ki obostha", "my_resignation"], ["আমার পদত্যাগের অবস্থা", "my_resignation"],
  ["amar dewa obhijog er ki holo", "my_cases"], ["আমার অভিযোগের কী হলো", "my_cases"],
  ["ajke office e ke ke ase nai", "attendance_on_date"], ["আজ কারা আসেনি", "attendance_on_date"], ["who did not come today", "attendance_on_date"], ["ajke kotojon present", "attendance_on_date"],
  ["ajke kara deri kore aise", "late_on_date"], ["আজ কারা দেরি করে এসেছে", "late_on_date"], ["who came late today", "late_on_date"],
  ["ajke ke ke chutite", "on_leave"], ["আজ কে কে ছুটিতে আছে", "on_leave"], ["who is on leave today", "on_leave"],
  ["samne kar kar chuti ache", "upcoming_leaves"], ["সামনে কার কার ছুটি", "upcoming_leaves"], ["upcoming leave list", "upcoming_leaves"],
  ["kon leave kar kache atke ache", "leave_pending_layers"], ["ছুটির আবেদন কার কাছে আটকে আছে", "leave_pending_layers"],
  ["onek din dhore pending ache ki ki", "stuck_applications"], ["অনেকদিন ধরে কী কী পড়ে আছে", "stuck_applications"],
  ["mot koto jon kaj kore", "headcount"], ["কোম্পানিতে মোট কতজন কাজ করে", "headcount"], ["total staff koto", "headcount"], ["how many people work here", "headcount"],
  ["meye staff koto jon", "employee_breakdown", { field: "gender" }], ["কতজন মহিলা কর্মী", "employee_breakdown", { field: "gender" }],
  ["kar kar blood group o positive", "employee_breakdown", { field: "blood_group" }],
  ["ajker hr er update dao", "daily_hr_report"], ["আজকের এইচআর আপডেট", "daily_hr_report"], ["give me today's hr summary", "daily_hr_report"],
  ["ei mase kar jonmodin", "hr_dashboard", { section: "birthdays" }], ["এই মাসে কার জন্মদিন", "hr_dashboard", { section: "birthdays" }], ["whose birthday is this month", "hr_dashboard", { section: "birthdays" }],
  ["kar probation sesh hocche", "hr_dashboard", { section: "probation" }], ["কার প্রবেশন শেষ হচ্ছে", "hr_dashboard", { section: "probation" }],
  ["kar contract er meyad sesh", "hr_dashboard", { section: "contract" }], ["কার চুক্তির মেয়াদ শেষ", "hr_dashboard", { section: "contract" }],
  ["kon kon document er meyad sesh hobe", "hr_dashboard", { section: "documents_expiry" }],
  ["salary ki deya hoise ei mase", "payroll_status"], ["এই মাসের বেতন দেওয়া হয়েছে কি", "payroll_status"], ["is this month's salary paid", "payroll_status"],
  ["ke ke chakri chere dicche", "exits_overview"], ["কারা চাকরি ছেড়ে যাচ্ছে", "exits_overview"],
  ["koyta pod khali ache", "recruitment_overview"], ["কয়টা পদে লোক নেওয়া হচ্ছে", "recruitment_overview"], ["how many open positions", "recruitment_overview"],
  ["notun joiner der ki baki", "onboarding_overview"], ["নতুন যোগদানকারীদের কী বাকি", "onboarding_overview"],
  ["ki ki notice ache", "active_notices"], ["নতুন কোনো নোটিশ আছে", "active_notices"], ["any new announcement", "active_notices"],
  ["10 bochor dhore ke ke kaj korche", "service_length"], ["কে কে ৫ বছর পূর্ণ করেছে", "service_length"],
  ["kon gari khali ache", "vehicle_overview"], ["কোন গাড়ি ফাঁকা", "vehicle_overview"],
  ["sobar target er obostha", "target_progress"], ["department er target koto hoise", "target_progress"],
  ["kar kaj deadline par hoye geche", "task_overview"], ["কার কাজ সময় পেরিয়ে গেছে", "task_overview"],
  ["appraisal er obostha", "performance_overview"], ["মূল্যায়ন কতদূর", "performance_overview"],
  ["ki ki kaj pending ache admin er", "admin_pending_work"], ["আমার টেবিলে কী কী বাকি", "admin_pending_work"],
  ["chuti nite chaile ki korte hobe", "help:leave_apply"], ["ছুটি নিতে হলে কী করব", "help:leave_apply"], ["how can i take leave", "help:leave_apply"],
  ["bill kemne jomadibo", "help:conveyance"], ["যাতায়াতের খরচ কীভাবে দাবি করব", "help:conveyance"], ["how to claim travel cost", "help:conveyance"],
  ["field e jaoar somoy ki korbo", "help:movement_claim"], ["বাইরে কাজে গেলে চেক ইন কীভাবে", "help:movement_claim"],
  ["laptop lagbe ki korbo", "help:asset"], ["নতুন ল্যাপটপ চাইব কীভাবে", "help:asset"], ["how do i request a laptop", "help:asset"],
  ["gari lagbe kivabe chaibo", "help:vehicle"], ["অফিসের গাড়ি কীভাবে নেব", "help:vehicle"],
  ["chakri charte chai ki korte hobe", "help:resignation"], ["চাকরি ছাড়তে চাইলে কী করব", "help:resignation"], ["how do i resign", "help:resignation"],
  ["experience certificate kivabe pabo", "help:letters"], ["অভিজ্ঞতার সনদ কীভাবে পাব", "help:letters"],
  ["taka dhar nite chai", "help:loan"], ["অগ্রিম টাকা নিতে চাই", "help:loan"], ["how to apply for salary advance", "help:loan"],
  ["password bhule gechi ki korbo", "help:password"], ["পাসওয়ার্ড বদলাব কীভাবে", "help:password"], ["how to change my photo", "help:password"],
  ["kono somossa nalish dibo kivabe", "help:grievance"], ["অভিযোগ জানাব কীভাবে", "help:grievance"],
  ["karo number kivabe pabo", "help:directory"], ["সহকর্মীর ফোন নম্বর কোথায় পাব", "help:directory"],
  ["onnoder abedon approve kothay kori", "help:approve"], ["অন্যের আবেদন কোথায় অনুমোদন করব", "help:approve"],
  ["payslip kothay pabo", "help:payslip"], ["বেতনের স্লিপ কোথায়", "help:payslip"],
  ["notun staff kivabe add korbo", "help:add_employee"], ["নতুন কর্মী যোগ করব কীভাবে", "help:add_employee"], ["how to add a new employee", "help:add_employee"],
  ["kauke permission dibo kivabe", "help:module_access"], ["কাউকে অনুমতি দেব কীভাবে", "help:module_access"],
  ["notun login khulbo kivabe", "help:users_admin"], ["নতুন লগইন কীভাবে খুলব", "help:users_admin"],
  ["salary toiri kivabe kori", "help:payroll"], ["বেতন শিট কীভাবে বানাব", "help:payroll"],
  ["chutir din add korbo kivabe", "help:holidays"], ["নতুন ছুটির দিন কীভাবে যোগ করব", "help:holidays"],
  ["notice kivabe dibo", "help:notice"], ["নোটিশ কীভাবে দেব", "help:notice"],
  ["promotion kivabe dibo", "help:hr_actions"], ["পদোন্নতি কীভাবে দেব", "help:hr_actions"], ["how to transfer an employee", "help:hr_actions"],
  ["manush er sathe kotha bolbo", "request_human_support"]
];
let learned: LearnedRow[] = [];
let learnedLoadedAt = 0;
let learnedQuery: QueryDB | null = null;

const gramsOf = (s: string) => {
  const x = norm(s).replace(/\s+/g, "");
  const g = new Set<string>();
  for (let i = 0; i + 3 <= x.length; i++) g.add(x.slice(i, i + 3));
  return g;
};
const similarity = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const g of a) if (b.has(g)) both++;
  return both / (a.size + b.size - both);
};

async function loadLearned(force = false) {
  if (!learnedQuery || (!force && Date.now() - learnedLoadedAt < 10 * 60_000)) return;
  learnedLoadedAt = Date.now();
  const rows: any[] = (await learnedQuery("/*unscoped*/ SELECT question, tool, help_id, args FROM assistant_learned ORDER BY hits DESC, id DESC LIMIT 5000").catch(() => [])) || [];
  learned = [
    ...rows.map((r) => {
      let args: any = null;
      try { args = r.args ? JSON.parse(r.args) : null; } catch { args = null; }
      return { question: String(r.question), tool: r.tool || null, help_id: r.help_id || null, args, grams: gramsOf(String(r.question)) };
    }),
    ...TRAINED
  ];
}
const TRAINED: LearnedRow[] = TRAINING.map(([q, to, args]) => ({
  question: norm(q).trim(),
  tool: to.startsWith("help:") ? null : to,
  help_id: to.startsWith("help:") ? to.slice(5) : null,
  args: args || null,
  grams: gramsOf(q)
}));

function closestLearned(message: string, min = 0.55): LearnedRow | null {
  const q = norm(message).trim();
  if (q.length < 4) return null;
  const exact = learned.find((l) => l.question === q);
  if (exact) return exact;
  const g = gramsOf(message);
  let best: LearnedRow | null = null;
  let score = 0;
  for (const l of learned) {
    const s = similarity(g, l.grams);
    if (s > score) [best, score] = [l, s];
  }
  return score >= min ? best : null;
}

async function remember(message: string, learn: NonNullable<Answer["learn"]>) {
  const q = norm(message).trim();
  if (!learnedQuery || q.length < 4 || q.length > 300) return;
  await learnedQuery(
    `/*unscoped*/ INSERT INTO assistant_learned (question, tool, help_id, args) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE tool = VALUES(tool), help_id = VALUES(help_id), args = VALUES(args), hits = hits + 1`,
    [q, learn.tool || null, learn.help || null, learn.args ? JSON.stringify(learn.args) : null]
  ).catch(() => {});
  const known = learned.find((l) => l.question === q);
  const row = { question: q, tool: learn.tool || null, help_id: learn.help || null, args: learn.args || null, grams: gramsOf(q) };
  if (known) Object.assign(known, row);
  else learned.unshift(row);
}

// Spelling: each unknown word (4+ letters) becomes the closest known word,
// one letter off for short words, two for long ones.
let vocab: Set<string> | null = null;
let topics: Set<string> | null = null;
const wordsOf = (keys: string[], into: Set<string>) => keys.forEach((k) => norm(k).trim().split(" ").forEach((w) => w.length >= 4 && !/^[a-z]{1,3}$/.test(w) && into.add(w)));
// Words of the topics themselves (attendance, balance, হাজিরা…) — never a person's name.
function topicWords() {
  if (topics) return topics;
  topics = new Set<string>();
  for (const i of INTENTS) wordsOf(i.keys, topics);
  for (const h of HELP) wordsOf(h.keys, topics);
  for (const w of ["kaj", "koto", "kobe", "dibo", "korbo", "pabo", "chuti", "leave", "ache", "nai"]) topics.delete(w);
  for (const w of [...NOT_NAMES, ...ORG_WORDS]) topics.add(w);
  return topics;
}
function knownWords() {
  if (vocab) return vocab;
  vocab = new Set<string>();
  for (const i of INTENTS) wordsOf(i.keys, vocab);
  for (const h of HELP) wordsOf(h.keys, vocab);
  for (const [q] of TRAINING) wordsOf([q], vocab);
  wordsOf([...HOW, ...LAST_MONTH, ...LEAVE_WORDS, ...APPLY_WORDS, ...HOLIDAY_WORDS, ...HUMAN_WORDS, ...THANKS, ...GREET], vocab);
  // The words the leave-request reader looks for (kalke, porshu, months, sick…)
  // stay as written: "correcting" them would lose the dates.
  for (const w of String(parseLeaveRequest).toLowerCase().match(/[a-z]{3,}|[\u0980-\u09ff]{2,}/g) || []) vocab.add(w);
  return vocab;
}
function editDistance(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
function fixSpelling(message: string): string {
  const words = knownWords();
  const out = norm(message).trim().split(" ").map((w) => {
    if (w.length < 4 || words.has(w) || /\d/.test(w)) return w;
    const max = w.length >= 7 ? 2 : 1;
    let best = w;
    let bestD = max + 1;
    for (const k of words) {
      if (Math.abs(k.length - w.length) > max) continue;
      const d = editDistance(w, k, max);
      if (d < bestD) [best, bestD] = [k, d];
    }
    return best;
  });
  return norm(out.join(" "));
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
// Several API keys (each from its own Google Cloud project, so each has its
// own quota) may be given: GEMINI_API_KEYS="key1,key2,key3" (GEMINI_API_KEY
// may also hold a comma-separated list). One key is used at a time; when its
// quota is used up (429 / RESOURCE_EXHAUSTED) it rests — 15 minutes at
// first, doubling up to 6 hours while it stays used up — and the next key
// takes over at once, inside the same question. Only when every key is used
// up does the local engine answer on its own (no 20 s wait per question).
// One good answer resets a key.
interface GeminiKey { label: string; ai: GoogleGenAI; pausedUntil: number; pauseMs: number }
let geminiKeys: GeminiKey[] | null = null;
let currentKey = 0;
const keyPool = (): GeminiKey[] => {
  if (!geminiKeys) {
    const raw = [process.env.GEMINI_API_KEYS, process.env.GEMINI_API_KEY, process.env.GOOGLE_API_KEY].filter(Boolean).join(",");
    const keys = [...new Set(raw.split(/[,\s]+/).map((k) => k.trim()).filter(Boolean))];
    geminiKeys = keys.map((key, i) => ({ label: `key ${i + 1} (…${key.slice(-4)})`, ai: new GoogleGenAI({ apiKey: key }), pausedUntil: 0, pauseMs: 0 }));
    if (keys.length > 1) console.log(`AI Assistant: ${keys.length} Gemini API keys — the next one takes over when one's quota is used up`);
  }
  return geminiKeys;
};
// The key in use (the first one not resting); null when no key is set.
const geminiClient = (): GoogleGenAI | null => {
  const pool = keyPool();
  if (!pool.length) return null;
  for (let i = 0; i < pool.length; i++) {
    const idx = (currentKey + i) % pool.length;
    if (Date.now() >= pool[idx].pausedUntil) {
      if (idx !== currentKey) console.log(`AI Assistant: now using Gemini ${pool[idx].label}`);
      currentKey = idx;
      return pool[idx].ai;
    }
  }
  return pool[currentKey].ai;
};
const keyOf = (ai?: GoogleGenAI | null) => keyPool().find((k) => k.ai === ai) || keyPool()[currentKey];

// Every key used up: Gemini is not asked again until one has rested.
const QUOTA = /\b429\b|RESOURCE_EXHAUSTED|quota|rate limit/i;
const geminiPaused = () => keyPool().length > 0 && keyPool().every((k) => Date.now() < k.pausedUntil);
// This key's quota is used up: it rests, the next one takes over. Returns
// true when another key is still available.
function pauseGemini(ai?: GoogleGenAI | null): boolean {
  const k = keyOf(ai);
  if (!k) return false;
  k.pauseMs = Math.min(6 * 60 * 60_000, k.pauseMs ? k.pauseMs * 2 : 15 * 60_000);
  k.pausedUntil = Date.now() + k.pauseMs;
  const more = !geminiPaused();
  console.warn(`AI Assistant: Gemini ${k.label} quota used up — resting ${Math.round(k.pauseMs / 60_000)} min${more ? ", switching to the next key" : "; every key used up, answering locally"}`);
  if (more) geminiClient();
  return more;
}
function geminiWorked(ai?: GoogleGenAI | null) {
  const k = keyOf(ai);
  if (!k) return;
  k.pauseMs = 0;
  k.pausedUntil = 0;
}

// Tries the models with the key in use; a key whose quota is used up hands
// over to the next key for the same request.
async function generateWithFallback(_ai: GoogleGenAI, req: { contents: Content[]; config: Record<string, any> }) {
  for (let n = 0; n < Math.max(1, keyPool().length); n++) {
    const ai = geminiClient();
    if (!ai) break;
    try {
      const resp = await generateWithModels(ai, req);
      geminiWorked(ai);
      return resp;
    } catch (err: any) {
      if (err?.quotaExhausted) {
        err.alreadyPaused = true;
        if (pauseGemini(ai)) continue;
      }
      throw err;
    }
  }
  const e: any = new Error("every Gemini key is used up");
  e.quotaExhausted = true;
  e.alreadyPaused = true;
  throw e;
}

async function generateWithModels(ai: GoogleGenAI, req: { contents: Content[]; config: Record<string, any> }) {
  let lastErr: any = null;
  let allQuota = true;
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
      if (!QUOTA.test(msg)) allQuota = false;
      // A bad key or a malformed request won't get better on another model.
      if (/API_KEY|PERMISSION_DENIED|INVALID_ARGUMENT|\b40[013]\b/.test(msg) && !/\b(404|429|503)\b/.test(msg)) throw err;
      console.warn(`AI Assistant: ${GEMINI_MODELS[idx]} unavailable (${msg.slice(0, 120)}), trying the next model`);
    }
  }
  const e: any = lastErr || new Error("no Gemini model available");
  if (allQuota && lastErr) e.quotaExhausted = true;
  throw e;
}

async function geminiAnswer(c: Ctx, history: { role: string; text: string }[], message: string): Promise<Answer> {
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
    salaryMonthNote(c) +
    `Rules:\n` +
    `- Reply in the user's language; default to Bangla. Banglish questions get Bangla answers. Be short and friendly; use bullet lines for lists.\n` +
    `- For any fact about the user, colleagues, attendance, leave, claims, loans, tasks, holidays or HR figures, call a tool. Never guess or invent numbers, names or dates.\n` +
    `- When a tool says linked: false (the login has no Employee record): if can_link_self is true (a Superadmin / Employees manager) say how to link it themselves (Admin Panel → Employees → their row → "Link Existing"; add an Employee record first if there is none) — never tell them to ask HR; and if the tool also gave company figures, give those. Write only Bangla or English — no other script.\n` +
    `- If a tool returns error "no_access", say politely that their account doesn't have permission and they can ask HR / Superadmin.\n` +
    `- You can only read and guide, with these exceptions that fill a form card in the chat (never submit anything): apply for leave -> prepare_leave_application ("জমা দিন"); book an office car / ride -> prepare_ride_booking ("Book করুন"); correct a day's In / Out time on the Timesheet (forgot to check in / out, wrong time) -> prepare_attendance_correction ("Submit করুন"); start / end a Movement Claim (heading out for office work, reached / finished) -> prepare_movement_claim ("Check In" / "Check Out" — the card takes the phone's location then). The employee reviews the card and presses its button. Never say it was applied, booked or submitted — say the draft is ready below to check and submit. Ask for nothing extra first: missing fields can be filled in the card.\n` +
    `- You cannot approve, edit, cancel or delete anything — tell them which page to open (the app shows a button for it).\n` +
    `- If they want a real person, or you can't help, call request_human_support (it shows a button; never claim someone is connected).\n` +
    `- For any "how do I… / where is…" question ALWAYS call app_help first and give only the steps it returns — never describe menus or buttons from your own knowledge. If it returns no_access, say that page isn't turned on for their account and HR / Superadmin can enable it. If it returns no_guide, say you don't have the exact steps for that and offer request_human_support — never claim the page is turned off or that they lack access unless a tool returned no_access. When app_help returns several entries, answer with the one that fits the question best and keep its steps, order and button names as written (you may translate into the user's language) — don't merge entries into a process of your own or add steps that aren't there.\n` +
    (isSuper(c) ? `- This user is a Superadmin: every page and module is open to them. Never tell them something isn't enabled for their account.\n` : "") +
    `- Write Bangla only in Bangla script (no Arabic, Hindi or other scripts mixed in); English words like page names may stay in English.\n` +
    `- Don't answer questions unrelated to work / this app beyond a brief polite line.\n` +
    `- This account can open ONLY these pages: ${HELP.filter((h) => !h.can || h.can(c)).map((h) => h.title).join(", ")}${c.modules.length ? `; Admin Panel modules: ${c.modules.join(", ")}` : isSuper(c) ? "; every Admin Panel module (Superadmin)" : ""}. ` +
    `Never explain, describe or give figures from any other page, menu or module — say briefly that it isn't turned on for *your account* (the user's) and HR / Superadmin can enable it in Module Access. Don't list the pages they can open unless they ask what they can use.`;
  const contents: Content[] = [
    ...history.slice(-10).map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.text || "").slice(0, 2000) }] })),
    { role: "user", parts: [{ text: message }] }
  ];
  const actions: AssistantAction[] = [];
  let draft: AssistantDraft | undefined;
  let rep: AssistantReport | undefined;
  // How-to answers are given exactly as written in HELP (menu paths and
  // button names must not be paraphrased): when app_help is all Gemini
  // used, its best entries are the reply.
  let helpOnly = true;
  let helpSteps: { title: string; steps: string }[] = [];
  const usedTools = new Set<string>();
  const toolArgs: Record<string, any> = {};
  let toolFailed = false;
  const learnOf = (): Answer["learn"] => {
    if (helpOnly && helpSteps.length) {
      const h = HELP.find((x) => x.title === helpSteps[0].title);
      return h ? { help: h.id } : undefined;
    }
    const names = [...usedTools].filter((n) => n !== "app_help");
    if (names.length !== 1 || toolFailed || !LEARNABLE.has(names[0])) return undefined;
    // Only the kind of answer is kept (a section, a field), never a name or a date.
    const args = Object.fromEntries(Object.entries(toolArgs[names[0]] || {}).filter(([k, v]) => LEARN_ARG_KEYS.has(k) && typeof v === "string" && v.length <= 40));
    return { tool: names[0], ...(Object.keys(args).length ? { args } : {}) };
  };
  for (let round = 0; round < 4; round++) {
    const resp = await generateWithFallback(ai, {
      contents,
      config: { systemInstruction: system, tools: [{ functionDeclarations: declarations }], temperature: 0.2 }
    });
    const calls = resp.functionCalls || [];
    if (!calls.length) {
      const text = (resp.text || "").trim();
      if (helpOnly && helpSteps.length) return { reply: helpSteps.slice(0, 3).map((h) => `**${h.title}:** ${h.steps}`).join("\n\n"), actions, draft, report: rep, learn: learnOf() };
      if (!text) throw new Error("empty reply");
      return { reply: text, actions, draft, report: rep, learn: learnOf() };
    }
    contents.push(resp.candidates?.[0]?.content || { role: "model", parts: calls.map((fc) => ({ functionCall: fc })) });
    const parts = [];
    for (const fc of calls) {
      const tool = tools.find((t) => t.name === fc.name);
      const out: ToolResult = tool ? await tool.run(c, fc.args || {}) : { ok: false, text: "", data: { error: "unknown_tool" } };
      usedTools.add(String(fc.name));
      toolArgs[String(fc.name)] = fc.args || {};
      if (!out.ok) toolFailed = true;
      for (const a of out.actions || []) actions.push(a);
      if (out.draft) draft = out.draft;
      if (out.report) rep = out.report;
      if (fc.name === "app_help") {
        for (const h of out.ok && Array.isArray(out.data?.steps) ? out.data.steps : []) if (!helpSteps.some((x) => x.title === h.title)) helpSteps.push(h);
      }
      else helpOnly = false;
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
  layerCheck = deps.hasModuleLayer;
  learnedQuery = queryDB;
  void queryDB(`/*unscoped*/ CREATE TABLE IF NOT EXISTS assistant_learned (
      id INT AUTO_INCREMENT PRIMARY KEY,
      question VARCHAR(300) NOT NULL,
      tool VARCHAR(64) NULL,
      help_id VARCHAR(64) NULL,
      args VARCHAR(255) NULL,
      hits INT NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_assistant_learned_q (question(190))
    )`)
    .then(() => loadLearned(true))
    .catch((err: any) => console.warn("⚠️ assistant_learned: " + (err?.message || err)));

  // Per-account switch (Module Access -> "AI Assistant"), ON by default.
  const loadCtx = async (req: any): Promise<Ctx | null> => {
    const u = req.user;
    if (!u || u.onb) return null;
    const rows: any[] = (await queryDB(`SELECT name, role, can_use_ai_assistant, can_export_assistant_reports, can_use_chat, ${SELF_FLAGS.join(", ")} FROM users WHERE id = ?`, [u.id]).catch(() => [])) || [];
    const row = rows[0];
    if (!row) return null;
    if (row.role !== "superadmin" && !Number(row.can_use_ai_assistant ?? 1)) return null;
    const flags: Record<string, boolean> = {};
    for (const f of SELF_FLAGS) flags[f] = !!Number(row[f] || 0);
    // Chat is on unless turned off (users.can_use_chat).
    flags.can_use_chat = Number(row.can_use_chat ?? 1) !== 0;
    const modules = row.role === "superadmin" ? [] : await getAdminModules(u.id).catch(() => []);
    const salaryStarts = ((await queryDB("SELECT start_day, effective_month FROM salary_month_settings ORDER BY effective_month ASC, id ASC").catch(() => [])) || []).map((s: any) => ({
      start_day: Number(s.start_day) || 1,
      effective_month: String(s.effective_month || "").slice(0, 7)
    }));
    return { req, userId: u.id, name: String(row.name || ""), role: String(row.role || ""), modules, flags, today: todayInDhaka(),
      canExport: row.role === "superadmin" || !!Number(row.can_export_assistant_reports || 0), salaryStarts };
  };

  const recent = new Map<number, number[]>();
  const limited = (userId: number) => {
    const now = Date.now();
    const list = (recent.get(userId) || []).filter((t) => now - t < 5 * 60_000);
    list.push(now);
    recent.set(userId, list);
    return list.length > 30;
  };

  // Voice (Module Access -> "AI Assistant — voice", users.can_use_assistant_voice,
  // off by default; Superadmin always). Needs Gemini: the recording is sent to
  // Google to be written down and is never stored here.
  const voiceAllowed = async (c: Ctx) => {
    if (c.role === "superadmin") return true;
    const rows: any[] = (await queryDB("SELECT can_use_assistant_voice FROM users WHERE id = ?", [c.userId]).catch(() => [])) || [];
    return !!rows[0] && Number(rows[0].can_use_assistant_voice || 0) === 1;
  };

  app.get("/api/assistant/status", authenticateToken, async (req: any, res: any) => {
    const c = await loadCtx(req);
    if (!c) return res.status(403).json({ error: "AI Assistant isn't turned on for your account." });
    const voice = !!geminiClient() && (await voiceAllowed(c));
    res.json({ enabled: true, engine: geminiClient() && !geminiPaused() ? "gemini" : "local", suggestions: suggestionsFor(c), voice });
  });

  // How to switch "thinking" off differs by model family: Gemini 3 takes
  // thinkingLevel MINIMAL, Gemini 2.5 thinkingBudget 0, some take neither
  // (they answer 400 INVALID_ARGUMENT). Each model's working one is kept.
  const THINK_OFF: (Record<string, any> | null)[] = [{ thinkingLevel: "MINIMAL" }, { thinkingBudget: 0 }, null];
  const thinkOffFor = new Map<string, number>();

  // POST /api/assistant/transcribe { audio_base64, mime_type } -> { text }:
  // a spoken question (WAV from the page, at most ~1 minute) written down as
  // it was said — Bangla in Bangla script, English in English.
  app.post("/api/assistant/transcribe", authenticateToken, async (req: any, res: any) => {
    const c = await loadCtx(req);
    if (!c) return res.status(403).json({ error: "AI Assistant isn't turned on for your account." });
    if (!(await voiceAllowed(c))) return res.status(403).json({ error: "Voice isn't turned on for your account." });
    if (!geminiClient()) return res.status(503).json({ error: "ভয়েস এখন চালু নেই — লিখে প্রশ্ন করুন।" });
    if (limited(c.userId)) return res.status(429).json({ error: "একটু বেশি প্রশ্ন হয়ে গেছে — কয়েক মিনিট পর আবার চেষ্টা করুন।" });
    const data = typeof req.body?.audio_base64 === "string" ? req.body.audio_base64 : "";
    const mime = String(req.body?.mime_type || "audio/wav");
    if (!data) return res.status(400).json({ error: "No recording." });
    if (!/^audio\/(wav|x-wav|mp3|mpeg|aac|ogg|flac|webm|mp4)/.test(mime)) return res.status(400).json({ error: "Unsupported recording." });
    if (Buffer.byteLength(data, "base64") > 4 * 1024 * 1024) return res.status(400).json({ error: "রেকর্ডিং অনেক লম্বা — এক মিনিটের মধ্যে বলুন।" });
    const bytes = Buffer.byteLength(data, "base64");
    // A 16 kHz mono WAV is 32 000 bytes a second (other formats: unknown).
    const secs = /wav/.test(mime) ? Math.round(Math.max(0, bytes - 44) / 32000) : null;
    if (secs !== null && secs < 1) return res.status(400).json({ error: "কিছু শোনা যায়নি — মাইক চেপে আবার বলুন।" });
    const t0 = Date.now();
    const deadline = t0 + 28000;
    const prompt =
      "Transcribe this short recording: a question to an HR app assistant. " +
      "Bangla in Bangla script, English words in English, Banglish as it is spoken. " +
      "Reply with only the words that were said, once — no notes, quotes or repetition. If nothing is said, reply with nothing.";
    // Fast models first. Each try is short, the reply is capped (a model that
    // starts repeating itself on noise or silence would otherwise run until
    // the deadline), and "thinking" is off — writing down speech needs none.
    const models = (process.env.GEMINI_TRANSCRIBE_MODEL || "gemini-flash-lite-latest,gemini-flash-latest").split(",").map((m) => m.trim()).filter(Boolean);
    const why: string[] = [];
    let quota = 0;
    let allQuota = false;
    // A key whose quota is used up hands over to the next key (time allowing).
    for (let kn = 0; kn < Math.max(1, keyPool().length); kn++) {
      const ai = geminiClient()!;
      const whyStart = why.length;
      quota = 0;
      for (const model of models) {
        const firstTry = thinkOffFor.get(model) ?? 0;
        for (let ti = firstTry; ti < THINK_OFF.length; ti++) {
          const left = deadline - Date.now();
          if (left < 3000) break;
          const think = THINK_OFF[ti];
          try {
            const resp: any = await ai.models.generateContent({
              model,
              contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime.split(";")[0], data } }, { text: prompt }] }],
              config: {
                temperature: 0,
                maxOutputTokens: 300,
                ...(think ? { thinkingConfig: think } : {}),
                httpOptions: { timeout: Math.min(14000, left) }
              } as any
            });
            thinkOffFor.set(model, ti);
            let text = String(resp?.text || "").replace(/\s+/g, " ").trim();
            // A reply that repeats one phrase over and over: keep it once.
            const rep = /^(.{4,80}?)(?:\s*\1){2,}/.exec(text);
            if (rep) text = rep[1].trim();
            geminiWorked(ai);
            console.log(
              `AI Assistant: transcribed ${Math.round(bytes / 1024)} KB ${mime}${secs !== null ? ` (${secs} s)` : ""} with ${model}` +
                ` (${think ? JSON.stringify(think) : "default thinking"}) in ${Date.now() - t0} ms`
            );
            return res.json({ text: text.slice(0, 1000) });
          } catch (err: any) {
            const msg = String(err?.message || err).slice(0, 160);
            // This model doesn't take that way of turning thinking off: the next way.
            if (ti < THINK_OFF.length - 1 && /INVALID_ARGUMENT|\b400\b/.test(msg) && !/API key/i.test(msg)) continue;
            if (QUOTA.test(msg)) quota++;
            why.push(`${model}${think ? ` ${JSON.stringify(think)}` : ""}: ${msg}`);
            break;
          }
        }
      }
      allQuota = quota > 0 && quota === why.length - whyStart;
      if (allQuota && pauseGemini(ai) && deadline - Date.now() > 5000) continue;
      break;
    }
    console.warn(
      `AI Assistant: transcribe failed after ${Date.now() - t0} ms (${Math.round(bytes / 1024)} KB ${mime}${secs !== null ? `, ${secs} s` : ""}) — ${why.join(" | ") || "no time left"}`
    );
    if (allQuota) {
      return res.status(503).json({ error: "এখন ভয়েস ব্যস্ত (Gemini-র সীমা শেষ) — কিছুক্ষণ পর চেষ্টা করুন বা লিখে প্রশ্ন করুন।" });
    }
    if (Date.now() >= deadline - 3000) return res.status(504).json({ error: "উত্তর আসতে বেশি সময় লাগছে — আবার বলুন বা লিখে প্রশ্ন করুন।" });
    res.status(502).json({ error: "কথাটা বোঝা গেল না — আবার বলুন বা লিখে প্রশ্ন করুন।" });
  });

  // POST /api/assistant/speak { text } -> audio/wav: the answer read out by
  // Gemini's voice — used only when the device has no Bangla voice of its own.
  // Which voice (TTS) models this key can use: GEMINI_TTS_MODEL first, then
  // every model Google lists whose name has "tts" (flash before pro), looked
  // up once an hour — Google renames these, so names aren't guessed. The one
  // that last worked is tried first; a piece read in the last 10 minutes is
  // sent again at once.
  const TTS_FROM_ENV = (process.env.GEMINI_TTS_MODEL || "").split(",").map((m) => m.trim()).filter(Boolean);
  const TTS_GUESS = ["gemini-2.5-flash-preview-tts", "gemini-2.5-flash-tts", "gemini-2.5-pro-preview-tts"];
  let ttsModels: string[] = [];
  let ttsListedAt = 0;
  let preferredTtsModel = "";
  const ttsModelList = async (ai: GoogleGenAI): Promise<string[]> => {
    if (ttsModels.length && Date.now() - ttsListedAt < 60 * 60_000) return ttsModels;
    const found: string[] = [];
    try {
      const pager: any = await (ai.models as any).list({ config: { pageSize: 200 } });
      for await (const m of pager) {
        const name = String(m?.name || "").replace(/^models\//, "");
        const actions: string[] = m?.supportedActions || [];
        if (/tts/i.test(name) && (!actions.length || actions.includes("generateContent"))) found.push(name);
      }
    } catch (err: any) {
      console.warn("AI Assistant: could not list Gemini models:", String(err?.message || err).slice(0, 160));
    }
    const rank = (n: string) => (/flash/.test(n) ? 0 : 1) + (/preview/.test(n) ? 0.1 : 0);
    found.sort((a, b) => rank(a) - rank(b) || b.localeCompare(a));
    ttsModels = [...new Set([...TTS_FROM_ENV, ...found, ...(found.length ? [] : TTS_GUESS)])];
    ttsListedAt = Date.now();
    console.log(`AI Assistant: voice models available: ${ttsModels.join(", ") || "none"}`);
    return ttsModels;
  };
  const ttsCache = new Map<string, { at: number; wav: Buffer }>();
  // The voices a person may pick in the Assistant (src/lib/assistantVoice.ts
  // shows the same list); anything else falls back to GEMINI_TTS_VOICE.
  const TTS_VOICES = new Set(["Kore", "Aoede", "Leda", "Despina", "Callirrhoe", "Sulafat", "Achernar", "Vindemiatrix", "Zephyr", "Puck", "Achird", "Charon", "Algieba", "Umbriel", "Sadachbia"]);
  app.post("/api/assistant/speak", authenticateToken, async (req: any, res: any) => {
    const c = await loadCtx(req);
    if (!c) return res.status(403).json({ error: "AI Assistant isn't turned on for your account." });
    if (!(await voiceAllowed(c))) return res.status(403).json({ error: "Voice isn't turned on for your account." });
    const ai = geminiClient();
    if (!ai) return res.status(503).json({ error: "Voice is not available." });
    const text = String(req.body?.text || "").replace(/[*_#`>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
    if (!text) return res.status(400).json({ error: "Nothing to read." });
    const voiceName = TTS_VOICES.has(String(req.body?.voice || "")) ? String(req.body.voice) : process.env.GEMINI_TTS_VOICE || "Kore";
    const cacheKey = `${voiceName}|${text}`;
    const hit = ttsCache.get(cacheKey);
    if (hit && Date.now() - hit.at < 10 * 60_000) {
      res.setHeader("Content-Type", "audio/wav");
      res.setHeader("Cache-Control", "no-store");
      return res.send(hit.wav);
    }
    const list = await ttsModelList(ai);
    const order = preferredTtsModel && list.includes(preferredTtsModel) ? [preferredTtsModel, ...list.filter((m) => m !== preferredTtsModel)] : list;
    const why: string[] = [];
    const t0 = Date.now();
    // The voice models' quota is separate from the chat's: a key whose voice
    // quota is used up just hands this piece to the next key (no rest).
    const pool = keyPool();
    const keysInOrder = [...pool.slice(currentKey), ...pool.slice(0, currentKey)];
    for (const key of keysInOrder) {
      const ai = key.ai;
      const whyStart = why.length;
      let quota = 0;
      for (const model of order.slice(0, 4)) {
        if (Date.now() - t0 > 40000) break;
        try {
          const resp: any = await ai.models.generateContent({
            model,
            contents: [{ role: "user", parts: [{ text }] }],
            config: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
              httpOptions: { timeout: 30000 }
            } as any
          });
          const part = resp?.candidates?.[0]?.content?.parts?.find((p: any) => p?.inlineData?.data);
          if (!part) throw new Error("no audio in the reply");
          const pcm = Buffer.from(part.inlineData.data, "base64");
          const rate = Number(/rate=(\d+)/.exec(String(part.inlineData.mimeType || ""))?.[1]) || 24000;
          // 16-bit mono PCM -> WAV.
          const head = Buffer.alloc(44);
          head.write("RIFF", 0);
          head.writeUInt32LE(36 + pcm.length, 4);
          head.write("WAVE", 8);
          head.write("fmt ", 12);
          head.writeUInt32LE(16, 16);
          head.writeUInt16LE(1, 20);
          head.writeUInt16LE(1, 22);
          head.writeUInt32LE(rate, 24);
          head.writeUInt32LE(rate * 2, 28);
          head.writeUInt16LE(2, 32);
          head.writeUInt16LE(16, 34);
          head.write("data", 36);
          head.writeUInt32LE(pcm.length, 40);
          const wav = Buffer.concat([head, pcm]);
          if (preferredTtsModel !== model) console.log(`AI Assistant: reading aloud with ${model} (${Date.now() - t0} ms)`);
          preferredTtsModel = model;
          ttsCache.set(cacheKey, { at: Date.now(), wav });
          if (ttsCache.size > 80) ttsCache.delete(ttsCache.keys().next().value as string);
          res.setHeader("Content-Type", "audio/wav");
          res.setHeader("Cache-Control", "no-store");
          return res.send(wav);
        } catch (err: any) {
          const msg = String(err?.message || err).slice(0, 200);
          why.push(`${key.label} ${model}: ${msg}`);
          if (QUOTA.test(msg)) quota++;
          if (/API key/i.test(msg)) break;
        }
      }
      if (!(quota > 0 && quota === why.length - whyStart) || Date.now() - t0 > 40000) break;
    }
    console.warn(`AI Assistant: speak failed after ${Date.now() - t0} ms (${text.length} chars) — ${why.join(" | ") || "no voice model"}`);
    // Google may have renamed the models: list them again on the next try.
    ttsListedAt = 0;
    res.status(502).json({ error: "Could not read the answer aloud." });
  });

  app.post("/api/assistant/chat", authenticateToken, async (req: any, res: any) => {
    const c = await loadCtx(req);
    if (!c) return res.status(403).json({ error: "AI Assistant isn't turned on for your account." });
    const message = String(req.body?.message || "").trim().slice(0, 1000);
    if (!message) return res.status(400).json({ error: "Message is required." });
    if (limited(c.userId)) return res.status(429).json({ error: "একটু বেশি প্রশ্ন হয়ে গেছে — কয়েক মিনিট পর আবার চেষ্টা করুন।" });
    const history = Array.isArray(req.body?.history) ? req.body.history.filter((m: any) => m && typeof m.text === "string") : [];
    let engine: "gemini" | "local" = "local";
    let out: Answer;
    void loadLearned();
    try {
      if (geminiClient() && !geminiPaused()) {
        out = await Promise.race([
          geminiAnswer(c, history, message),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 45000))
        ]);
        engine = "gemini";
        geminiWorked();
        if (out.learn) void remember(message, out.learn);
      } else {
        out = await localAnswer(c, message, history);
      }
    } catch (err: any) {
      if (err?.quotaExhausted) { if (!err.alreadyPaused) pauseGemini(); }
      else console.warn("AI Assistant: Gemini failed, using local answer:", err?.message || err);
      out = await localAnswer(c, message, history);
    }
    const seen = new Set<string>();
    const actions = allowedActions(c, out.actions).filter((a) => (seen.has(a.nav) ? false : (seen.add(a.nav), true))).slice(0, 3);
    // The full table goes only to accounts allowed to download it, and only
    // when there's something in it.
    const rep = c.canExport && out.report && out.report.rows.length ? { ...out.report, rows: out.report.rows.slice(0, 5000) } : null;
    res.json({ reply: cleanReply(out.reply), actions, engine, draft: out.draft || null, report: rep });
  });
}

// Gemini now and then slips a word of another script into a Bangla answer
// ("record-의"): the Korean possessive becomes "-এর", anything else in
// Korean / Japanese / Chinese / Cyrillic / Arabic script is dropped.
function cleanReply(text: string): string {
  return String(text || "")
    .replace(/-?의/g, "-এর")
    .replace(/[\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\u0400-\u04FF\u0600-\u06FF]+/g, "")
    .replace(/[ \t]{2,}/g, " ");
}
