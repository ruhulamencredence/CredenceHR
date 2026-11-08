/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR linkage — Recruitment -> Onboarding -> Appointment Letter, Exit dues
// from other modules, and HR reminders. Tests.
//
//   npm run test:hr-linkage
//
// Unit tests (always run): reminder steps, retirement dates, lead-day
// parsing and the settlement's added-dues record.
//
// Integration tests run against a live server and change its data (they
// make a job posting, joiners, Employees, a SIM, a loan and an exit), so
// point them at a TEST database only. Same settings as
// tests/onboarding.test.ts:
//   ONB_TEST_BASE / ONB_TEST_WORKSPACE / ONB_TEST_ADMIN_EMAIL /
//   ONB_TEST_ADMIN_PASSWORD   the server and a Superadmin login
//   ONB_TEST_HR_EMAIL / ONB_TEST_HR_PASSWORD   optional plain account for the
//                            permission tests (its Module Access is put back)
//   ONB_TEST_SERVER_TEST_MODE=1  server started with NODE_ENV=test — needed
//                            for the reminder tests, which run the job on
//                            demand as if it were another day
// Without a reachable server the integration tests are skipped.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { parseLeadDays, reminderStep, retirementDate, daysBetween, enabledKinds } from "../HrRemindersRoutes";
import { parseAddedDues } from "../ExitOffboardingRoutes";

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

describe("reminder lead days", () => {
  test("parsed largest first", () => assert.deepEqual(parseLeadDays("7, 30,0,15"), [30, 15, 7, 0]));
  test("duplicates and junk dropped", () => assert.deepEqual(parseLeadDays("30,30,abc,-5,400,7"), [30, 7]));
  test("empty falls back to the default", () => assert.deepEqual(parseLeadDays(""), [30, 15, 7, 0]));
});

describe("reminder step", () => {
  const leads = [30, 15, 7, 0];
  const cases: [number, number | null][] = [
    [45, null], // not yet
    [31, null],
    [30, 30],
    [20, 30], // first run 20 days before: the 30-day step, once
    [15, 15],
    [8, 15],
    [7, 7],
    [1, 7],
    [0, 0],
    [-3, 0], // overdue: the on-the-day step
    [-30, 0],
    [-31, null] // overdue too long
  ];
  for (const [days, step] of cases) test(`${days} days away -> ${step}`, () => assert.equal(reminderStep(days, leads), step));
  test("a late first run sends only the latest step", () => assert.equal(reminderStep(5, leads), 7));
});

describe("retirement date", () => {
  test("birthday + age", () => assert.equal(retirementDate("1966-10-21", 60), "2026-10-21"));
  test("29 February -> 28 February", () => assert.equal(retirementDate("1968-02-29", 59), "2027-02-28"));
  test("no date of birth -> none", () => assert.equal(retirementDate(null, 60), null));
  test("days between", () => assert.equal(daysBetween("2026-10-11", "2026-10-18"), 7));
});

describe("reminder kinds setting", () => {
  test("only the listed kinds", () => assert.deepEqual(enabledKinds({ reminder_kinds: "contract,increment" }), ["contract", "increment"]));
  test("unset means all", () => assert.equal(enabledKinds({}).length, 5));
});

describe("settlement added dues", () => {
  test("reads the stored list", () => assert.deepEqual(parseAddedDues('[{"key":"loan:1","label":"x","amount":5}]').map((d) => d.key), ["loan:1"]));
  test("bad JSON reads as empty", () => assert.deepEqual(parseAddedDues("{oops"), []));
  test("rows without a key are dropped", () => assert.deepEqual(parseAddedDues([{ amount: 1 }, { key: "loan:2" }]).length, 1));
});

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

const BASE = process.env.ONB_TEST_BASE || "http://localhost:4899";
const WORKSPACE = process.env.ONB_TEST_WORKSPACE || "credence";
const ADMIN = { email: process.env.ONB_TEST_ADMIN_EMAIL || "admin@yourcompany.com", password: process.env.ONB_TEST_ADMIN_PASSWORD || "ChangeThisPassword123" };
const HR = process.env.ONB_TEST_HR_EMAIL ? { email: process.env.ONB_TEST_HR_EMAIL, password: process.env.ONB_TEST_HR_PASSWORD || "" } : null;
const SERVER_TEST_MODE = process.env.ONB_TEST_SERVER_TEST_MODE === "1";
const RUN = Date.now().toString(36);

type Res = { code: number; body: any };
const call = async (method: string, path: string, token?: string, body?: any): Promise<Res> => {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { code: r.status, body: await r.json().catch(() => null) };
};
const login = (identifier: string, password: string) => call("POST", "/api/auth/login", undefined, { identifier, password, workspace: WORKSPACE });

let reachable = false;
let admin: { token: string; user: any };
let seq = 0;
const tagOf = () => `${RUN}${++seq}`;
const digitsOf = (tag: string) => String(parseInt(tag, 36)).slice(-8).padStart(8, "0");

// Fills in and submits a joiner's details (they were opened by HR already).
async function submit(created: { login_id: string; password: string }, tag: string) {
  const token = (await login(created.login_id, created.password)).body.token;
  const me = await call("GET", "/api/onboarding/me", token);
  const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
  for (const d of me.body.required_documents) await call("POST", "/api/onboarding/me/documents", token, { doc_type: d, file_name: `${d}.pdf`, file_mime: "application/pdf", file_base64: pdf });
  const digits = digitsOf(tag);
  const s = await call("POST", "/api/onboarding/me/submit", token, {
    personal: {
      gender: "Female",
      date_of_birth: "1996-06-06",
      nid_ssn: `66${digits}`,
      mobile: `018${digits}`,
      present_address: "Dhaka",
      permanent_address: "Rajshahi",
      personal_email: `link.${tag}@test.invalid`
    },
    contacts: [{ name: `Mother ${tag}`, relation: "Mother", phone: `019${digits}` }],
    nominees: [{ name: `Mother ${tag}`, relation: "Mother", nominee_percent: 100 }]
  });
  assert.equal(s.code, 200, JSON.stringify(s.body));
}

// A brand-new approved Employee (with a login) made through onboarding.
async function newEmployee(): Promise<{ employeeId: number; userId: number; code: string; name: string }> {
  const tag = tagOf();
  const name = `Link Test ${tag}`;
  const c = await call("POST", "/api/hr-ops/joiner-onboarding", admin.token, { name, designation: "Officer", joining_date: "2026-11-01" });
  assert.equal(c.code, 201, JSON.stringify(c.body));
  await submit(c.body, tag);
  const a = await call("POST", `/api/hr-ops/joiner-onboarding/${c.body.id}/approve`, admin.token);
  assert.equal(a.code, 200, JSON.stringify(a.body));
  const emp = ((await call("GET", "/api/employees", admin.token)).body || []).find((e: any) => Number(e.id) === Number(a.body.employee_id));
  return { employeeId: Number(a.body.employee_id), userId: Number(emp?.user_id), code: a.body.employee_code, name };
}

before(async () => {
  try {
    const l = await login(ADMIN.email, ADMIN.password);
    reachable = l.code === 200 && !!l.body?.token;
    if (reachable) admin = l.body;
  } catch {
    reachable = false;
  }
  if (!reachable) console.log(`(integration tests skipped — no server / Superadmin login at ${BASE})`);
});

describe("Recruitment -> Onboarding -> Appointment Letter (live server)", () => {
  test("a hired candidate's onboarding takes the posting's designation and links the Employee", async (t) => {
    if (!reachable) return t.skip("no server");
    const tag = tagOf();
    const p = await call("POST", "/api/job-postings", admin.token, { title: `Posting ${tag}`, designation: `Designation ${tag}` });
    assert.equal(p.code, 201);
    const c = await call("POST", "/api/job-candidates", admin.token, { posting_id: p.body.id, name: `Candidate ${tag}`, email: `cand.${tag}@test.invalid` });
    assert.equal(c.code, 201);
    assert.equal((await call("PUT", `/api/job-candidates/${c.body.id}`, admin.token, { status: "hired" })).code, 200);

    const hired = (await call("GET", "/api/hr-ops/joiner-onboarding/hired-candidates", admin.token)).body;
    assert.ok(hired.some((h: any) => h.id === c.body.id && h.designation === `Designation ${tag}`));

    const o = await call("POST", "/api/hr-ops/joiner-onboarding", admin.token, { candidate_id: c.body.id, joining_date: "2026-11-01" });
    assert.equal(o.code, 201, JSON.stringify(o.body));
    const detail = (await call("GET", `/api/hr-ops/joiner-onboarding/${o.body.id}`, admin.token)).body;
    assert.equal(detail.designation, `Designation ${tag}`);
    assert.equal(detail.posting_title, `Posting ${tag}`);
    assert.equal((await call("GET", "/api/hr-ops/joiner-onboarding/by-candidate", admin.token)).body[c.body.id]?.status, "draft");

    // While the onboarding is open the candidate stays Hired.
    assert.equal((await call("PUT", `/api/job-candidates/${c.body.id}`, admin.token, { status: "offered" })).code, 409);

    await submit(o.body, tag);
    const a = await call("POST", `/api/hr-ops/joiner-onboarding/${o.body.id}/approve`, admin.token);
    assert.equal(a.code, 200, JSON.stringify(a.body));
    assert.equal(typeof a.body.appointment_letter?.template_exists, "boolean");
    const linked = (await call("GET", "/api/hr-ops/joiner-onboarding/by-candidate", admin.token)).body[c.body.id];
    assert.equal(linked.status, "approved");
    assert.equal(linked.employee_code, a.body.employee_code);
    assert.equal((await call("PUT", `/api/job-candidates/${c.body.id}`, admin.token, { status: "rejected" })).code, 409);

    // The drawer offers the Appointment Letter until it is issued.
    const before = (await call("GET", `/api/hr-ops/joiner-onboarding/${o.body.id}`, admin.token)).body;
    assert.equal(before.employee_code, a.body.employee_code);
    assert.equal(before.appointment_letter, null);
    if (before.appointment_template) {
      const l = await call("POST", "/api/hr-ops/letters", admin.token, { employee_id: a.body.employee_id, letter_type: "appointment" });
      assert.equal(l.code, 200, JSON.stringify(l.body));
      const after = (await call("GET", `/api/hr-ops/joiner-onboarding/${o.body.id}`, admin.token)).body;
      assert.equal(after.appointment_letter?.ref_no, l.body.ref_no);
    }
  });

  test("cancelling the onboarding frees the candidate's status", async (t) => {
    if (!reachable) return t.skip("no server");
    const tag = tagOf();
    const p = await call("POST", "/api/job-postings", admin.token, { title: `Posting ${tag}` });
    const c = await call("POST", "/api/job-candidates", admin.token, { posting_id: p.body.id, name: `Candidate ${tag}` });
    await call("PUT", `/api/job-candidates/${c.body.id}`, admin.token, { status: "hired" });
    const o = await call("POST", "/api/hr-ops/joiner-onboarding", admin.token, { candidate_id: c.body.id, joining_date: "2026-11-01" });
    assert.equal(o.code, 201);
    assert.equal((await call("POST", `/api/hr-ops/joiner-onboarding/${o.body.id}/cancel`, admin.token)).code, 200);
    assert.equal((await call("PUT", `/api/job-candidates/${c.body.id}`, admin.token, { status: "offered" })).code, 200);
  });
});

describe("Exit dues (live server)", () => {
  test("a SIM and an unadded loan block payment; the loan is added once", async (t) => {
    if (!reachable) return t.skip("no server");
    const emp = await newEmployee();
    const digits = digitsOf(`${RUN}x`);
    const sim = await call("POST", "/api/mobile-bill/sims", admin.token, { phone_number: `017${digits}`, operator: "GP", employee_id: emp.employeeId, limit_source: "custom", limit_amount: 500 });
    assert.equal(sim.code, 201, JSON.stringify(sim.body));
    const loan = await call("POST", "/api/payroll/advances", admin.token, { employee_id: emp.employeeId, total_amount: 12000, monthly_installment: 2000, reason: "Test loan" });
    assert.equal(loan.code, 200, JSON.stringify(loan.body));
    const ex = await call("POST", "/api/exit-requests", admin.token, { user_id: emp.userId, exit_type: "resignation", last_working_day: "2026-12-31" });
    assert.equal(ex.code, 201);
    const exitId = ex.body.id;
    try {
      const dues = (await call("GET", `/api/exit-requests/${exitId}/dues`, admin.token)).body.items;
      const loanKey = `loan:${loan.body.id}`;
      assert.ok(dues.some((d: any) => d.kind === "sim" && d.blocking));
      assert.ok(dues.some((d: any) => d.key === loanKey && d.blocking && d.amount === 12000));

      // Adding needs the settlement draft first.
      assert.equal((await call("POST", `/api/exit-requests/${exitId}/settlement/add-dues`, admin.token, { keys: [loanKey] })).code, 404);
      const st = (await call("GET", `/api/exit-requests/${exitId}/settlement`, admin.token)).body;

      // Clearance first: while the exit is still Pending and no department
      // has cleared it, it can't be paid — every department is named.
      const items: any[] = ex.body.clearance_items || [];
      assert.ok(items.length > 0);
      const kinds = (r: any) => r.body.blocking.map((d: any) => d.kind);
      const paid0 = await call("PUT", `/api/exit-requests/${exitId}/settlement`, admin.token, { ...st, gratuity_amount: 20000, status: "paid" });
      assert.equal(paid0.code, 409);
      assert.ok(kinds(paid0).includes("status"), JSON.stringify(paid0.body));
      assert.equal(kinds(paid0).filter((k: string) => k === "clearance").length, items.length);
      assert.equal((await call("PUT", `/api/exit-requests/${exitId}/status`, admin.token, { status: "settled" })).code, 409);

      // In Clearance with all but one department cleared: still refused,
      // and the one left is the one named.
      assert.equal((await call("PUT", `/api/exit-requests/${exitId}/status`, admin.token, { status: "clearance" })).code, 200);
      const last = items[items.length - 1];
      for (const item of items.slice(0, -1)) {
        assert.equal((await call("PUT", `/api/exit-clearance-items/${item.id}`, admin.token, { is_cleared: true, remarks: "Cleared" })).code, 200);
      }
      const paidOne = await call("PUT", `/api/exit-requests/${exitId}/settlement`, admin.token, { ...st, gratuity_amount: 20000, status: "paid" });
      assert.equal(paidOne.code, 409);
      assert.ok(!kinds(paidOne).includes("status"));
      const left = paidOne.body.blocking.filter((d: any) => d.kind === "clearance");
      assert.equal(left.length, 1);
      assert.equal(left[0].key, `clearance:${last.id}`);
      assert.equal((await call("PUT", `/api/exit-requests/${exitId}/status`, admin.token, { status: "settled" })).code, 409);
      assert.equal((await call("PUT", `/api/exit-clearance-items/${last.id}`, admin.token, { is_cleared: true, remarks: "Cleared" })).code, 200);

      const paid1 = await call("PUT", `/api/exit-requests/${exitId}/settlement`, admin.token, { ...st, gratuity_amount: 20000, status: "paid" });
      assert.equal(paid1.code, 409);
      assert.ok(paid1.body.blocking.some((d: any) => d.kind === "sim"));
      assert.ok(paid1.body.blocking.some((d: any) => d.key === loanKey));
      assert.equal((await call("PUT", `/api/exit-requests/${exitId}/status`, admin.token, { status: "settled" })).code, 409);

      const add = await call("POST", `/api/exit-requests/${exitId}/settlement/add-dues`, admin.token, { keys: [loanKey] });
      assert.equal(add.code, 200, JSON.stringify(add.body));
      assert.equal(add.body.outstanding_dues, 12000);
      assert.equal((await call("POST", `/api/exit-requests/${exitId}/settlement/add-dues`, admin.token, { keys: [loanKey] })).code, 409);

      // The SIM still blocks; once it's gone the settlement can be paid.
      const paid2 = await call("PUT", `/api/exit-requests/${exitId}/settlement`, admin.token, { gratuity_amount: 20000, outstanding_dues: 12000, status: "paid" });
      assert.equal(paid2.code, 409);
      assert.deepEqual(
        paid2.body.blocking.map((d: any) => d.kind),
        ["sim"]
      );
      assert.equal((await call("DELETE", `/api/mobile-bill/sims/${sim.body.id}`, admin.token)).code, 200);
      const paid3 = await call("PUT", `/api/exit-requests/${exitId}/settlement`, admin.token, { gratuity_amount: 20000, outstanding_dues: 12000, status: "paid" });
      assert.equal(paid3.code, 200, JSON.stringify(paid3.body));
      assert.equal(paid3.body.net_payable, 8000);
      assert.equal((await call("POST", `/api/exit-requests/${exitId}/settlement/add-dues`, admin.token, { keys: [loanKey] })).code, 409);
    } finally {
      await call("DELETE", `/api/mobile-bill/sims/${sim.body.id}`, admin.token).catch(() => {});
      await call("DELETE", `/api/payroll/advances/${loan.body.id}`, admin.token).catch(() => {});
    }
  });
});

describe("HR reminders (live server)", () => {
  // The recipient is the plain HR account (Superadmins can't be given layers).
  let hr: { token: string; user: any } | null = null;
  let savedModules: string[] = [];
  let savedLayers: string[] = [];
  before(async () => {
    if (!reachable || !SERVER_TEST_MODE || !HR) return;
    hr = (await login(HR.email, HR.password)).body;
    savedModules = (await call("GET", `/api/users/${hr!.user.id}/module-permissions`, admin.token)).body?.modules || [];
    savedLayers = (await call("GET", `/api/users/${hr!.user.id}/module-permission-layers?module=hr_operations`, admin.token)).body?.layers || [];
    await call("PUT", `/api/users/${hr!.user.id}/module-permissions`, admin.token, { modules: Array.from(new Set([...savedModules, "hr_operations"])) });
    await call("PUT", `/api/users/${hr!.user.id}/module-permission-layers`, admin.token, { module: "hr_operations", layers: ["read", "reminders_receive"] });
    hr = (await login(HR.email, HR.password)).body;
  });
  after(async () => {
    if (!reachable || !SERVER_TEST_MODE || !hr) return;
    await call("PUT", `/api/users/${hr.user.id}/module-permission-layers`, admin.token, { module: "hr_operations", layers: savedLayers });
    await call("PUT", `/api/users/${hr.user.id}/module-permissions`, admin.token, { modules: savedModules });
  });

  test("the run hook exists only in test mode", async (t) => {
    if (!reachable) return t.skip("no server");
    const r = await call("POST", "/api/hr-ops/reminders/run", admin.token, {});
    assert.equal(r.code, SERVER_TEST_MODE ? 200 : 404);
  });

  test("a probation end is reminded once per step, and not while a confirmation is pending", async (t) => {
    if (!reachable) return t.skip("no server");
    if (!SERVER_TEST_MODE) return t.skip("set ONB_TEST_SERVER_TEST_MODE=1 (server with NODE_ENV=test)");
    if (!HR) return t.skip("set ONB_TEST_HR_EMAIL / ONB_TEST_HR_PASSWORD");
    const emp = await newEmployee();
    // Approval sets a default probation; find when it ends.
    const svc = (await call("GET", "/api/hr-ops/employees", admin.token)).body.find((e: any) => e.id === emp.employeeId);
    const end = String(svc?.probation_end_date || "").slice(0, 10);
    assert.match(end, /^\d{4}-\d{2}-\d{2}$/, "approval sets a probation end date");
    const dayBefore = (n: number) => {
      const d = new Date(`${end}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - n);
      return d.toISOString().slice(0, 10);
    };
    const mine = async () => ((await call("GET", "/api/alerts", hr!.token)).body || []).filter((a: any) => a.type === "hr_reminder" && String(a.message).includes(emp.code));

    await call("POST", "/api/hr-ops/reminders/run", admin.token, { today: dayBefore(40) });
    assert.equal((await mine()).length, 0, "40 days before: nothing yet");
    await call("POST", "/api/hr-ops/reminders/run", admin.token, { today: dayBefore(7) });
    const first = (await mine()).length;
    assert.equal(first, 1, "the 7-day reminder arrives, once");
    await call("POST", "/api/hr-ops/reminders/run", admin.token, { today: dayBefore(7) });
    await call("POST", "/api/hr-ops/reminders/run", admin.token, { today: dayBefore(6) });
    assert.equal((await mine()).length, 1, "the same step is not sent again");

    // A pending confirmation means HR is on it: no on-the-day reminder.
    const act = await call("POST", "/api/hr-ops/actions", admin.token, { employee_id: emp.employeeId, action_type: "confirmation", effective_date: end, to: {}, reason: "test" });
    assert.equal(act.code, 200, JSON.stringify(act.body));
    await call("POST", "/api/hr-ops/reminders/run", admin.token, { today: end });
    if (act.body.status === "pending") assert.equal((await mine()).length, 1, "nothing more while the confirmation is pending");
  });
});

describe("permissions (live server)", () => {
  let hr: { token: string; user: any } | null = null;
  let savedModules: string[] = [];
  const saved: Record<string, string[]> = {};
  const setLayers = async (module: string, layers: string[]) => {
    assert.equal((await call("PUT", `/api/users/${hr!.user.id}/module-permission-layers`, admin.token, { module, layers })).code, 200);
    hr = (await login(HR!.email, HR!.password)).body;
  };
  before(async () => {
    if (!reachable || !HR) return;
    hr = (await login(HR.email, HR.password)).body;
    savedModules = (await call("GET", `/api/users/${hr!.user.id}/module-permissions`, admin.token)).body?.modules || [];
    for (const m of ["hr_operations", "exit_offboarding"])
      saved[m] = (await call("GET", `/api/users/${hr!.user.id}/module-permission-layers?module=${m}`, admin.token)).body?.layers || [];
    await call("PUT", `/api/users/${hr!.user.id}/module-permissions`, admin.token, { modules: Array.from(new Set([...savedModules, "hr_operations", "exit_offboarding"])) });
  });
  after(async () => {
    if (!reachable || !HR || !hr) return;
    for (const m of Object.keys(saved)) await call("PUT", `/api/users/${hr.user.id}/module-permission-layers`, admin.token, { module: m, layers: saved[m] });
    await call("PUT", `/api/users/${hr.user.id}/module-permissions`, admin.token, { modules: savedModules });
  });

  test("the module alone opens neither the dues nor the reminders", async (t) => {
    if (!reachable || !HR) return t.skip("set ONB_TEST_HR_EMAIL / ONB_TEST_HR_PASSWORD");
    await setLayers("exit_offboarding", ["read"]);
    await setLayers("hr_operations", ["read"]);
    assert.deepEqual((await call("GET", "/api/exit-dues/access", hr!.token)).body, { exit_dues: false });
    assert.equal((await call("GET", "/api/exit-requests/1/dues", hr!.token)).code, 403);
    assert.equal((await call("POST", "/api/exit-requests/1/settlement/add-dues", hr!.token, { keys: ["loan:1"] })).code, 403);
    assert.deepEqual((await call("GET", "/api/hr-ops/reminders/access", hr!.token)).body, { reminders_receive: false });
    assert.equal((await call("GET", "/api/hr-ops/reminders/upcoming", hr!.token)).code, 403);
    assert.equal((await call("GET", "/api/hr-ops/joiner-onboarding/by-candidate", hr!.token)).code, 403);
    assert.notEqual((await call("POST", "/api/hr-ops/reminders/run", hr!.token, {})).code, 200);
  });

  test("ticking the layers opens them", async (t) => {
    if (!reachable || !HR) return t.skip("set ONB_TEST_HR_EMAIL / ONB_TEST_HR_PASSWORD");
    await setLayers("exit_offboarding", ["read", "exit_dues"]);
    await setLayers("hr_operations", ["read", "reminders_receive"]);
    assert.deepEqual((await call("GET", "/api/exit-dues/access", hr!.token)).body, { exit_dues: true });
    assert.deepEqual((await call("GET", "/api/hr-ops/reminders/access", hr!.token)).body, { reminders_receive: true });
    assert.equal((await call("GET", "/api/hr-ops/reminders/upcoming", hr!.token)).code, 200);
  });
});
