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
  canExport: boolean; // users.can_export_assistant_reports (Superadmin always)
}

interface ToolResult {
  ok: boolean;
  text: string; // ready-made Bangla answer (local engine)
  data?: any; // compact facts (Gemini engine)
  actions?: AssistantAction[];
  draft?: LeaveDraft;
  report?: AssistantReport;
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

interface Answer { reply: string; actions: AssistantAction[]; draft?: LeaveDraft; report?: AssistantReport }

const SELF_FLAGS = [
  "can_view_movement_claims", "can_view_conveyance_claims", "can_view_timesheet", "can_view_leave_application",
  "can_view_my_leave", "can_view_tasks", "can_view_mobile_bill", "can_view_loan_request", "can_view_targets", "can_manage_leave", "can_view_service_book"
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
    steps: "উপরের বারে Chat আইকন (💬) চাপুন। কাউকে খুঁজে মেসেজ পাঠান; Calls চালু থাকলে অডিও/ভিডিও কলও করা যায়।" },
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

// "Rahim er chuti koto" -> "rahim": the word(s) right before a separate
// "er" / "-এর" / "এর" ("ajker" and "মাসের" are not names).
const NOT_NAMES = new Set(["amar", "আমার", "ei", "এই", "e", "এ", "ajker", "maser", "masher", "মাসের", "gotomaser", "গত", "tomar", "তোমার", "apnar", "আপনার", "kar", "কার", "sobar", "সবার", "team", "office", "company"]);
const nameBefore = (t: string) => {
  const m = /([a-z.]{2,}(?:\s+[a-z.]{2,})?)\s+er\s/.exec(t) || /([\u0980-\u09ff]{2,}(?:\s+[\u0980-\u09ff]{2,})?)(?:-এর|\s+এর)\s/.exec(t);
  const words = (m?.[1] || "").split(/\s+/).filter((w) => w && !NOT_NAMES.has(w));
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
    description: "The asking employee's OWN late dates between two dates (YYYY-MM-DD), default the current month. Not for questions about other employees — use late_on_date for that.",
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
      if (!me && !e) return { ok: true, text: "আপনার login এখনো কোনো Employee record-এর সাথে যুক্ত নয়, তাই তথ্য দেখানো যাচ্ছে না। HR-কে জানান।", data: { linked: false } };
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
        actions: full ? [{ label: "My Service Book খুলুন", nav: "self:myLetters" }] : []
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
    description: "HR (Monthly Attendance Report access): one employee's attendance for a month — present, absent, holiday days, and late days when the Late list is allowed. name = part of their name; month_year 'YYYY-MM' (default this month).",
    params: { name: { type: "string", description: "Employee name (or part of it)." }, month_year: { type: "string", description: "YYYY-MM; default this month." } },
    available: (c) => hasMod(c, "attendance_reports"),
    run: async (c, args) => {
      const q = String(args?.name || "").trim().toLowerCase();
      if (q.length < 2) return { ok: false, text: "কার হাজিরা চান? নাম লিখুন — যেমন \"Rahim-এর এ মাসের হাজিরা\"।" };
      const ym = /^\d{4}-\d{2}$/.test(String(args?.month_year || "")) ? String(args.month_year) : c.today.slice(0, 7);
      const [y, m] = ym.split("-").map(Number);
      const r = await callApi(c.req, `/api/attendance/report/monthly?year=${y}&month=${m}`);
      if (!r.ok) return fail(r.status);
      const hits: any[] = (r.body?.users || []).filter((u: any) => String(u.user_name || "").toLowerCase().includes(q)).slice(0, 3);
      if (!hits.length) return { ok: true, text: `${bnMonth(ym)}-এর রিপোর্টে "${args.name}" নামে কাউকে পাওয়া যায়নি (আপনার দেখার department-এর বাইরে হতে পারে)।`, data: { results: [] } };
      // Late days only through the Late list (its own layer).
      const lates = new Map<number, { delay: number; extreme: number }>();
      const end = ym === c.today.slice(0, 7) ? c.today : `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
      let lateAllowed = true;
      for (let d = `${ym}-01`; d <= end && lateAllowed; d = addDays(d, 1)) {
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
      const text = `${bnMonth(ym)}-এর হাজিরা:\n` + hits.map((u) => {
        const l = lates.get(u.user_id);
        return `• **${u.user_name}**${u.department ? ` (${u.department})` : ""} — উপস্থিত ${bn(u.present_days)} দিন, অনুপস্থিত ${bn(u.absent_days)}, ছুটির দিন ${bn(u.holiday_days)}` +
          (lateAllowed ? `, দেরি ${bn(l?.delay || 0)}${l?.extreme ? ` (অনেক দেরি ${bn(l.extreme)})` : ""}` : "");
      }).join("\n");
      return {
        ok: true, text,
        data: { month: ym, results: hits.map((u) => ({ name: u.user_name, department: u.department, present: u.present_days, absent: u.absent_days, holidays: u.holiday_days, ...(lateAllowed ? { late: lates.get(u.user_id)?.delay || 0, extreme_late: lates.get(u.user_id)?.extreme || 0 } : {}) })) },
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
        for (const row of r.report.rows) {
          const [, first, ...rest] = row;
          rows.push([p.title, first === null || first === undefined ? "" : String(first), rest.filter((v) => v !== null && v !== undefined && v !== "").join(" · ")]);
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
        report: rows.length ? report(`Daily HR Report — ${enDate(date)}`, `HR-Report-${date}`, ["Section", "Name / Item", "Detail"], rows, [["Date", enDate(date)], ["Sections", got.map(({ p }) => p.title).join(", ")]]) : undefined
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
const DAILY_PARTS: { tool: string; title: string; args: (date: string) => any; skipEmpty?: (r: ToolResult) => boolean; dropPending?: boolean; dropZeros?: boolean }[] = [
  { tool: "headcount", title: "লোকবল", args: () => ({}) },
  { tool: "attendance_on_date", title: "হাজিরা", args: (date) => ({ date }) },
  { tool: "late_on_date", title: "দেরিতে এসেছেন", args: (date) => ({ date }) },
  { tool: "on_leave", title: "ছুটিতে", args: (date) => ({ date }) },
  { tool: "admin_pending_work", title: "অপেক্ষমাণ অনুমোদন", args: () => ({}) },
  { tool: "stuck_applications", title: "৩+ দিন আটকে আছে", args: () => ({ days: 3 }), skipEmpty: (r) => !r.data?.total },
  { tool: "exits_overview", title: "Exit / Offboarding", args: () => ({}), skipEmpty: (r) => !r.data?.exits?.length },
  { tool: "onboarding_overview", title: "Onboarding", args: () => ({}) },
  { tool: "recruitment_overview", title: "Recruitment", args: () => ({}), dropZeros: true,
    skipEmpty: (r) => !r.data?.open_posts?.length && !r.data?.interviews_this_week?.length && !r.data?.offers_waiting?.length },
  { tool: "hr_dashboard", title: "সামনে যা আছে", args: () => ({ section: "summary" }), dropPending: true, dropZeros: true }
];

// ---------------------------------------------------------------------------
// Local engine
// ---------------------------------------------------------------------------
const norm = (s: string) => ` ${String(s || "").toLowerCase().replace(/[?!.,।]+/g, " ").replace(/\s+/g, " ").trim()} `;
const hasAny = (t: string, keys: string[]) => keys.some((k) => t.includes(k));

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

const LAST_MONTH = ["last month", "gotomash", "gotomas", "goto mash", "goto mas", "গত মাস", "আগের মাস", "previous month", "ager mas", "ager mash"];

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
  { tool: "employee_leave_balance", keys: [" er chuti koto", " er leave balance", "এর ছুটি কত", "-এর ছুটি কত", " er koto chuti", "এর কত ছুটি", " er chuti baki", "এর ছুটি বাকি"],
    args: (t) => ({ name: nameBefore(t) }) },
  { tool: "employee_attendance", keys: [" er hajira", "এর হাজিরা", "-এর হাজিরা", " er attendance", "এর attendance", " er present", "koydin absent", "কয়দিন অনুপস্থিত", " er late", "এর দেরি"],
    args: (t, c) => ({ name: nameBefore(t), month_year: hasAny(t, LAST_MONTH) ? monthShift(c.today.slice(0, 7), -1) : undefined }) },
  { tool: "stuck_applications", keys: ["atke ache", "আটকে আছে", "stuck", "din dhore pending", "দিন ধরে পেন্ডিং", "din dhore pore", "অনেকদিন পড়ে", "onekdin pending", "3 din", "৩ দিন"],
    args: (t) => { const n = /(\d{1,2})\s*(?:din|দিন|days?)/.exec(toAsciiDigits(t))?.[1]; return { days: n ? Number(n) : 3 }; } },
  { tool: "exits_overview", keys: ["ke ke chole jacche", "কে কে চলে যাচ্ছে", "exit list", "exit koyta", "কয়টা exit", "offboarding", "অফবোর্ডিং", "resign koreche", "রিজাইন করেছে", "kar clearance", "কার clearance", "settlement baki", "সেটেলমেন্ট বাকি", "last working day ke"] },
  { tool: "recruitment_overview", keys: ["recruitment", "রিক্রুটমেন্ট", "interview", "ইন্টারভিউ", "khola pod", "খোলা পদ", "open position", "vacancy", "শূন্য পদ", "offer", "অফার", "candidate", "প্রার্থী", "job posting"] },
  { tool: "payroll_status", keys: ["payroll", "পে-রোল", "পেরোল", "salary kobe", "বেতন কবে", "beton kobe", "salary hold", "বেতন hold", "salary paid", "বেতন দেওয়া", "audit e ache", "salary sheet"],
    args: (t, c) => (hasAny(t, LAST_MONTH) ? { month_year: monthShift(c.today.slice(0, 7), -1) } : {}) },
  { tool: "asset_lookup", keys: ["kar kache", "কার কাছে", "asset koyta", "কয়টা asset", "asset khali", "খালি asset", "laptop koyta", "কয়টা laptop", "asset list", "who has", "কার নামে"],
    args: (t) => { const m = /(\S{2,30})\s+(?:kar kache|কার কাছে|কার নামে)/.exec(t) || /(?:who has|kar kache|কার কাছে)\s+(?!ache|আছে)(\S{2,30})/.exec(t); return { query: m ? m[1].replace(/[?]/g, "").trim() : "" }; } },
  { tool: "my_pending_approvals", keys: ["amar kache approval", "amar approval", "আমার কাছে কয়টা", "আমার অনুমোদনের", "আমার কাছে অনুমোদন", "approval koyta", "koyta approval", "কয়টা approval", "pending approval amar", "amar kache pending", "আমার কাছে পেন্ডিং", "approve korte hobe", "approve বাকি", "approve baki", "waiting for my approval", "my approvals", "my pending approvals"] },
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
  { tool: "headcount", keys: ["headcount", "হেডকাউন্ট", "মোট কর্মী", "কতজন কর্মী", "koto jon employee", "kotojon employee", "total employee", "how many employee", "কর্মী সংখ্যা"] }
];

const OWN_TOOL: Record<string, string> = { late_on_date: "my_late_days", task_overview: "my_tasks", target_progress: "my_targets_progress", vehicle_overview: "my_rides" };

const GREET = ["hi", "hello", "hey", "salam", "assalam", "হাই", "হ্যালো", "সালাম", "আসসালাম", "kemon acho", "কেমন আছ", "good morning", "শুভ সকাল"];
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

async function localAnswer(c: Ctx, message: string): Promise<Answer> {
  const t = norm(message);
  const asksHow = hasAny(t, HOW);

  if (hasAny(t, HUMAN_WORDS)) {
    const r = await TOOLS.find((x) => x.name === "request_human_support")!.run(c, {});
    return { reply: r.text, actions: r.actions || [] };
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
      const r = await tool.run(c, { name: other, month_year: hasAny(t, LAST_MONTH) ? monthShift(c.today.slice(0, 7), -1) : undefined });
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
    const intent = own && hasAny(t, [" amar ", " ami ", "আমার", "আমি", " my ", " i "])
      ? INTENTS.find((i) => i.tool === own)!
      : scored[0].i;
    const tool = TOOLS.find((x) => x.name === intent.tool)!;
    if (!toolAvailable(tool, c)) return { reply: NO_ACCESS.text, actions: [] };
    const r = await tool.run(c, intent.args ? intent.args(t, c) : {});
    return { reply: r.text, actions: allowedActions(c, r.actions || []), report: r.report };
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
    reply: "দুঃখিত, প্রশ্নটা বুঝতে পারিনি। এভাবে জিজ্ঞেস করে দেখুন:\n" + suggestionsFor(c).map((s) => `• ${s}`).join("\n") + "\n\nঅথবা একজন মানুষের সাথে সরাসরি কথা বলুন।",
    actions: [{ label: "মানুষের সাথে কথা বলুন", nav: "support:request" }]
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
    `Rules:\n` +
    `- Reply in the user's language; default to Bangla. Banglish questions get Bangla answers. Be short and friendly; use bullet lines for lists.\n` +
    `- For any fact about the user, colleagues, attendance, leave, claims, loans, tasks, holidays or HR figures, call a tool. Never guess or invent numbers, names or dates.\n` +
    `- If a tool returns error "no_access", say politely that their account doesn't have permission and they can ask HR / Superadmin.\n` +
    `- You can only read and guide, with ONE exception: when they ask to apply for leave, call prepare_leave_application. It only fills a form card in the chat; the employee reviews it and presses the card's "জমা দিন" button. Never say the leave was applied or submitted — say the draft is ready below to check and submit with "জমা দিন". Ask for nothing extra first: missing fields can be filled in the card.\n` +
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
  let draft: LeaveDraft | undefined;
  let rep: AssistantReport | undefined;
  // How-to answers are given exactly as written in HELP (menu paths and
  // button names must not be paraphrased): when app_help is all Gemini
  // used, its best entries are the reply.
  let helpOnly = true;
  let helpSteps: { title: string; steps: string }[] = [];
  for (let round = 0; round < 4; round++) {
    const resp = await generateWithFallback(ai, {
      contents,
      config: { systemInstruction: system, tools: [{ functionDeclarations: declarations }], temperature: 0.2 }
    });
    const calls = resp.functionCalls || [];
    if (!calls.length) {
      const text = (resp.text || "").trim();
      if (helpOnly && helpSteps.length) return { reply: helpSteps.slice(0, 3).map((h) => `**${h.title}:** ${h.steps}`).join("\n\n"), actions, draft, report: rep };
      if (!text) throw new Error("empty reply");
      return { reply: text, actions, draft, report: rep };
    }
    contents.push(resp.candidates?.[0]?.content || { role: "model", parts: calls.map((fc) => ({ functionCall: fc })) });
    const parts = [];
    for (const fc of calls) {
      const tool = tools.find((t) => t.name === fc.name);
      const out: ToolResult = tool ? await tool.run(c, fc.args || {}) : { ok: false, text: "", data: { error: "unknown_tool" } };
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

  // Per-account switch (Module Access -> "AI Assistant"), ON by default.
  const loadCtx = async (req: any): Promise<Ctx | null> => {
    const u = req.user;
    if (!u || u.onb) return null;
    const rows: any[] = (await queryDB(`SELECT name, role, can_use_ai_assistant, can_export_assistant_reports, ${SELF_FLAGS.join(", ")} FROM users WHERE id = ?`, [u.id]).catch(() => [])) || [];
    const row = rows[0];
    if (!row) return null;
    if (row.role !== "superadmin" && !Number(row.can_use_ai_assistant ?? 1)) return null;
    const flags: Record<string, boolean> = {};
    for (const f of SELF_FLAGS) flags[f] = !!Number(row[f] || 0);
    const modules = row.role === "superadmin" ? [] : await getAdminModules(u.id).catch(() => []);
    return { req, userId: u.id, name: String(row.name || ""), role: String(row.role || ""), modules, flags, today: todayInDhaka(),
      canExport: row.role === "superadmin" || !!Number(row.can_export_assistant_reports || 0) };
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
    let out: Answer;
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
    // The full table goes only to accounts allowed to download it, and only
    // when there's something in it.
    const rep = c.canExport && out.report && out.report.rows.length ? { ...out.report, rows: out.report.rows.slice(0, 5000) } : null;
    res.json({ reply: out.reply, actions, engine, draft: out.draft || null, report: rep });
  });
}
