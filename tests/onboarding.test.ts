/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// New Joiner Onboarding (OnboardingSelfServiceRoutes.ts) — tests.
//
//   npm run test:onboarding
//
// Unit tests (always run): the restricted-token path allowlist and the form
// checks.
//
// Integration tests run against a live server and change its data, so point
// them at a TEST database only:
//   ONB_TEST_BASE            server address (default http://localhost:4899)
//   ONB_TEST_WORKSPACE       workspace typed at sign-in (default credence)
//   ONB_TEST_ADMIN_EMAIL /   a Superadmin login (defaults: the .env.example
//   ONB_TEST_ADMIN_PASSWORD  seed account)
//   ONB_TEST_HR_EMAIL /      optional: a plain User / Admin account; the tests
//   ONB_TEST_HR_PASSWORD     give it HR Operations + layers and put its own
//                            Module Access back afterwards
//   ONB_TEST_SERVER_TEST_MODE=1  the server runs with NODE_ENV=test, so the
//                            rollback tests may make Approve fail part-way
// Without a reachable server the integration tests are skipped.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { onboardingPathAllowed, onboardingMissing, cleanOnboardingData, parseOnboardingData } from "../OnboardingSelfServiceRoutes";

// ---------------------------------------------------------------------------
// Unit: the restricted token
// ---------------------------------------------------------------------------

describe("onboardingPathAllowed", () => {
  const ME = 42;
  const allowed: [string, string][] = [
    ["GET", "/api/onboarding/me"],
    ["PUT", "/api/onboarding/me"],
    ["POST", "/api/onboarding/me/submit"],
    ["POST", "/api/onboarding/me/documents"],
    ["GET", "/api/onboarding/me/documents/7"],
    ["DELETE", "/api/onboarding/me/documents/7"],
    ["GET", "/api/onboarding/me?x=1"],
    ["GET", "/api/onboarding/me/"],
    ["GET", "/api/auth/me"],
    ["POST", "/api/auth/logout"],
    ["PUT", "/api/profile/password"],
    ["GET", "/api/profile/photo"],
    ["POST", "/api/profile/photo"],
    ["GET", `/api/profile/photo/${ME}`]
  ];
  for (const [m, p] of allowed) test(`allows ${m} ${p}`, () => assert.equal(onboardingPathAllowed(m, p, ME), true));

  const refused: [string, string][] = [
    ["GET", "/api/employees"],
    ["GET", "/api/users"],
    ["GET", "/api/alerts"],
    ["GET", "/api/hr-ops/meta"],
    ["GET", "/api/hr-ops/joiner-onboarding"],
    ["POST", "/api/hr-ops/joiner-onboarding/1/approve"],
    ["GET", "/api/profile/personal-data"],
    ["PUT", "/api/profile/username"],
    ["GET", "/api/profile/photo/43"],
    ["GET", "/api/profile/photo/42abc"],
    ["DELETE", "/api/profile/photo"],
    ["GET", "/api/auth/logout"],
    ["POST", "/api/auth/me"],
    ["PUT", "/api/profile/password/../../users"],
    ["GET", "/api/onboarding/me/../../employees"],
    ["GET", "/api/onboarding/me/%2e%2e/%2e%2e/employees"],
    ["GET", "/api/onboarding/me%2f..%2f..%2femployees"],
    ["GET", "/api/onboarding/me//documents"],
    ["GET", "/api/onboarding/me\\..\\employees"],
    ["GET", "/api/onboarding/me;/employees"],
    ["GET", "/api/onboarding/me/%00"],
    ["GET", "/api/onboarding/me/%E0%A4%A"],
    ["GET", "/API/onboarding/me"],
    ["GET", "/api/Onboarding/me"],
    ["GET", "/api/onboarding/mex"],
    ["GET", "/api/onboarding/mine"],
    ["GET", "/api/onboarding"],
    ["PATCH", "/api/onboarding/me"],
    ["GET", "/"],
    ["GET", ""]
  ];
  for (const [m, p] of refused) test(`refuses ${m} ${p || "(empty)"}`, () => assert.equal(onboardingPathAllowed(m, p, ME), false));

  test("own photo needs the account id", () => assert.equal(onboardingPathAllowed("GET", `/api/profile/photo/${ME}`), false));
});

// ---------------------------------------------------------------------------
// Unit: the form
// ---------------------------------------------------------------------------

describe("form checks", () => {
  const full = () =>
    cleanOnboardingData({
      personal: {
        gender: "Female",
        date_of_birth: "1998-04-02",
        nid_ssn: "1990123",
        mobile: "01811222333",
        present_address: "Dhaka",
        permanent_address: "Cumilla",
        personal_email: "a@b.co"
      },
      contacts: [{ name: "Father", relation: "Father", phone: "0191" }],
      nominees: [{ name: "Father", relation: "Father", nominee_percent: 100 }]
    });
  const required = ["NID", "Photograph"];

  test("complete form with documents passes", () => assert.deepEqual(onboardingMissing(full(), ["NID card", "Photograph"], required), []));
  test("unknown fields are dropped", () => {
    const d = cleanOnboardingData({ personal: { gender: "Male", is_active: 1, role: "superadmin" } });
    assert.equal("is_active" in d.personal, false);
    assert.equal("role" in d.personal, false);
  });
  test("bad JSON reads as empty", () => assert.deepEqual(parseOnboardingData("{oops").contacts, []));
  test("missing required fields are listed", () => {
    const d = full();
    d.personal.nid_ssn = null;
    d.personal.mobile = null;
    const m = onboardingMissing(d, ["NID", "Photograph"], required);
    assert.ok(m.includes("NID"));
    assert.ok(m.includes("Mobile"));
  });
  test("an emergency contact needs a phone", () => {
    const d = full();
    d.contacts = [{ ...d.contacts[0], phone: null }];
    assert.ok(onboardingMissing(d, ["NID", "Photograph"], required).some((x) => /emergency contact/.test(x)));
  });
  test("a nominee is required", () => {
    const d = full();
    d.nominees = [];
    assert.ok(onboardingMissing(d, ["NID", "Photograph"], required).includes("A nominee"));
  });
  test("nominee shares must add up to 100", () => {
    const d = cleanOnboardingData({ ...full(), nominees: [{ name: "A", nominee_percent: 60 }, { name: "B", nominee_percent: 30 }] });
    assert.ok(onboardingMissing(d, ["NID", "Photograph"], required).some((x) => /100/.test(x)));
  });
  test("missing documents are listed", () => assert.deepEqual(onboardingMissing(full(), ["NID"], required), ["Document: Photograph"]));
  test("an invalid personal email is refused", () => {
    const d = full();
    d.personal.personal_email = "not-an-email";
    assert.ok(onboardingMissing(d, ["NID", "Photograph"], required).some((x) => /email/i.test(x)));
  });
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
const call = async (method: string, path: string, token?: string, body?: any, headers: Record<string, string> = {}): Promise<Res> => {
  const r = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { code: r.status, body: await r.json().catch(() => null) };
};
const login = (identifier: string, password: string) => call("POST", "/api/auth/login", undefined, { identifier, password, workspace: WORKSPACE });

let reachable = false;
let admin: { token: string; user: any };
let seq = 0;

// A joiner whose details are complete and submitted.
async function submittedJoiner(hrToken: string, personal: Record<string, string> = {}) {
  seq++;
  const tag = `${RUN}${seq}`;
  const c = await call("POST", "/api/hr-ops/joiner-onboarding", hrToken, { name: `Test Joiner ${tag}`, designation: "Engineer", joining_date: "2026-11-01" });
  assert.equal(c.code, 201, JSON.stringify(c.body));
  const l = await login(c.body.login_id, c.body.password);
  assert.equal(l.code, 200);
  const token = l.body.token;
  const me = await call("GET", "/api/onboarding/me", token);
  const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
  for (const d of me.body.required_documents)
    assert.equal((await call("POST", "/api/onboarding/me/documents", token, { doc_type: d, file_name: `${d}.pdf`, file_mime: "application/pdf", file_base64: pdf })).code, 200);
  const digits = String(parseInt(tag, 36)).slice(-8).padStart(8, "0");
  const data = {
    personal: {
      gender: "Male",
      date_of_birth: "1995-05-05",
      nid_ssn: `77${digits}`,
      mobile: `017${digits}`,
      present_address: "Dhaka",
      permanent_address: "Khulna",
      personal_email: `joiner.${tag}@test.invalid`,
      ...personal
    },
    contacts: [{ name: `Father ${tag}`, relation: "Father", phone: `019${digits}` }],
    nominees: [{ name: `Father ${tag}`, relation: "Father", nominee_percent: 100 }]
  };
  const s = await call("POST", "/api/onboarding/me/submit", token, data);
  assert.equal(s.code, 200, JSON.stringify(s.body));
  return { id: c.body.id as number, loginId: c.body.login_id as string, password: c.body.password as string, token, data, name: `Test Joiner ${tag}` };
}
const employeesNamed = async (name: string) => ((await call("GET", "/api/employees", admin.token)).body || []).filter((e: any) => e.name === name);

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

describe("restricted onboarding token (live server)", () => {
  let joiner: { token: string; userId: number };
  before(async () => {
    if (!reachable) return;
    const c = await call("POST", "/api/hr-ops/joiner-onboarding", admin.token, { name: `Token Test ${RUN}`, joining_date: "2026-11-01" });
    const l = await login(c.body.login_id, c.body.password);
    joiner = { token: l.body.token, userId: l.body.user.id };
  });

  const blocked: [string, string][] = [
    ["GET", "/api/employees"],
    ["GET", "/api/users"],
    ["GET", "/api/alerts"],
    ["GET", "/api/attendance"],
    ["GET", "/api/claims"],
    ["GET", "/api/departments"],
    ["GET", "/api/budgets"],
    ["GET", "/api/devices"],
    ["GET", "/api/job-postings"],
    ["GET", "/api/leave-policies"],
    ["GET", "/api/my-loans"],
    ["GET", "/api/assets/my"],
    ["GET", "/api/calls/ice-servers"],
    ["GET", "/api/chat/directory"],
    ["GET", "/api/chat/rooms"],
    ["GET", "/api/employee-directory"],
    ["GET", "/api/calendar-attendance"],
    ["GET", "/api/companies/assignments"],
    ["GET", "/api/companies/next-employee-code"],
    ["GET", "/api/hr-ops/meta"],
    ["GET", "/api/hr-ops/employees"],
    ["GET", "/api/hr-ops/letters"],
    ["GET", "/api/hr-ops/my/letters"],
    ["GET", "/api/hr-ops/my/service-book"],
    ["GET", "/api/hr-ops/my/info-requests"],
    ["GET", "/api/hr-ops/joiner-onboarding"],
    ["GET", "/api/hr-ops/joiner-onboarding/access"],
    ["POST", "/api/hr-ops/joiner-onboarding"],
    ["POST", "/api/hr-ops/joiner-onboarding/1/approve"],
    ["GET", "/api/hr-analytics/summary"],
    ["GET", "/api/mobile-bill/my"],
    ["GET", "/api/mobile-bill/access"],
    ["GET", "/api/bill-claim-policy/mine"],
    ["GET", "/api/web-push/key"],
    ["GET", "/api/entries/recycle"],
    ["GET", "/api/profile/personal-data"],
    ["PUT", "/api/profile/personal-data"],
    ["PUT", "/api/profile/username"],
    ["GET", "/api/profile/photo/1"],
    ["POST", "/api/users"],
    ["PUT", "/api/users/1/module-permissions"],
    ["GET", "/API/employees"],
    ["GET", "/api/Employees"],
    ["GET", "/api/employees/"]
  ];
  for (const [m, p] of blocked)
    test(`403 on ${m} ${p}`, async (t) => {
      if (!reachable) return t.skip("no server");
      const r = await call(m, p, joiner.token, m === "GET" ? undefined : {});
      assert.equal(r.code, 403, `${m} ${p} -> ${r.code}`);
      assert.equal(r.body?.code, "ONBOARDING_ONLY");
    });

  test("its own endpoints work", async (t) => {
    if (!reachable) return t.skip("no server");
    assert.equal((await call("GET", "/api/onboarding/me", joiner.token)).code, 200);
    assert.equal((await call("GET", "/api/auth/me", joiner.token)).code, 200);
  });

  test("a cancelled login can't sign in or use its token", async (t) => {
    if (!reachable) return t.skip("no server");
    const c = await call("POST", "/api/hr-ops/joiner-onboarding", admin.token, { name: `Cancel Test ${RUN}`, joining_date: "2026-11-01" });
    const l = await login(c.body.login_id, c.body.password);
    assert.equal((await call("POST", `/api/hr-ops/joiner-onboarding/${c.body.id}/cancel`, admin.token, {})).code, 200);
    assert.equal((await login(c.body.login_id, c.body.password)).code, 403);
    assert.equal((await call("GET", "/api/onboarding/me", l.body.token)).code, 401);
  });
});

describe("approve (live server)", () => {
  test("duplicate NID / mobile / email are refused and named", async (t) => {
    if (!reachable) return t.skip("no server");
    const first = await submittedJoiner(admin.token);
    assert.equal((await call("POST", `/api/hr-ops/joiner-onboarding/${first.id}/approve`, admin.token)).code, 200);
    const second = await submittedJoiner(admin.token, {
      nid_ssn: first.data.personal.nid_ssn,
      mobile: first.data.personal.mobile,
      personal_email: first.data.personal.personal_email
    });
    const preview = await call("GET", `/api/hr-ops/joiner-onboarding/${second.id}`, admin.token);
    assert.deepEqual(new Set(preview.body.duplicates.map((d: any) => d.field)), new Set(["NID", "Mobile", "Email"]));
    const r = await call("POST", `/api/hr-ops/joiner-onboarding/${second.id}/approve`, admin.token);
    assert.equal(r.code, 409);
    assert.ok(r.body.duplicates.every((d: any) => d.match.includes(first.name)), JSON.stringify(r.body.duplicates));
    assert.equal((await employeesNamed(second.name)).length, 0);
    // The approved one doesn't clash with itself.
    assert.equal((await call("GET", `/api/hr-ops/joiner-onboarding/${first.id}`, admin.token)).body.duplicates.length, 0);
  });

  test("approving twice, or twice at once, creates one Employee", async (t) => {
    if (!reachable) return t.skip("no server");
    const j = await submittedJoiner(admin.token);
    const [a, b] = await Promise.all([1, 2].map(() => call("POST", `/api/hr-ops/joiner-onboarding/${j.id}/approve`, admin.token)));
    assert.equal(a.code, 200);
    assert.equal(b.code, 200);
    assert.equal([a, b].filter((r) => r.body.already_approved).length, 1);
    const again = await call("POST", `/api/hr-ops/joiner-onboarding/${j.id}/approve`, admin.token);
    assert.equal(again.body.already_approved, true);
    const emps = await employeesNamed(j.name);
    assert.equal(emps.length, 1);
    const code = (a.body.employee_code || b.body.employee_code) as string;
    assert.equal(emps[0].employee_id, code);
    // The same login now signs in with the Employee ID and is a full account.
    assert.equal((await login(j.loginId, j.password)).code, 400);
    const l = await login(code, j.password);
    assert.equal(l.code, 200);
    assert.equal(l.body.user.is_onboarding, false);
    assert.equal(l.body.user.must_change_password, true);
    assert.equal((await call("GET", "/api/alerts", l.body.token)).code, 200);
    assert.equal((await call("GET", "/api/onboarding/me", j.token)).code, 401);
  });

  for (const step of [2, 4, 6, 8, 10])
    test(`a failure after step ${step} rolls everything back`, async (t) => {
      if (!reachable) return t.skip("no server");
      if (!SERVER_TEST_MODE) return t.skip("server not in NODE_ENV=test (set ONB_TEST_SERVER_TEST_MODE=1)");
      const j = await submittedJoiner(admin.token);
      const before = await call("GET", `/api/hr-ops/joiner-onboarding/${j.id}`, admin.token);
      const r = await call("POST", `/api/hr-ops/joiner-onboarding/${j.id}/approve`, admin.token, undefined, { "X-Onboarding-Test-Fail-After": String(step) });
      assert.equal(r.code, 500, JSON.stringify(r.body));
      const afterFail = await call("GET", `/api/hr-ops/joiner-onboarding/${j.id}`, admin.token);
      assert.equal(afterFail.body.status, "submitted");
      assert.equal(afterFail.body.employee_id, null);
      assert.equal(afterFail.body.documents.length, before.body.documents.length);
      assert.equal((await employeesNamed(j.name)).length, 0);
      // The temporary login is untouched: same ID, still onboarding.
      const l = await login(j.loginId, j.password);
      assert.equal(l.code, 200);
      assert.equal(l.body.user.is_onboarding, true);
      // And a normal approval afterwards works, once.
      const ok = await call("POST", `/api/hr-ops/joiner-onboarding/${j.id}/approve`, admin.token);
      assert.equal(ok.code, 200, JSON.stringify(ok.body));
      assert.equal((await employeesNamed(j.name)).length, 1);
    });
});

describe("permissions (live server)", () => {
  let hr: { token: string; user: any } | null = null;
  let savedModules: string[] = [];
  let savedLayers: string[] = [];
  const setLayers = async (layers: string[]) => {
    assert.equal((await call("PUT", `/api/users/${hr!.user.id}/module-permission-layers`, admin.token, { module: "hr_operations", layers })).code, 200);
    // Layers are read fresh on each request; sign in again for a clean token.
    hr = (await login(HR!.email, HR!.password)).body;
  };
  before(async () => {
    if (!reachable || !HR) return;
    hr = (await login(HR.email, HR.password)).body;
    savedModules = (await call("GET", `/api/users/${hr!.user.id}/module-permissions`, admin.token)).body?.modules || [];
    savedLayers = (await call("GET", `/api/users/${hr!.user.id}/module-permission-layers?module=hr_operations`, admin.token)).body?.layers || [];
    await call("PUT", `/api/users/${hr!.user.id}/module-permissions`, admin.token, { modules: Array.from(new Set([...savedModules, "hr_operations"])) });
  });
  after(async () => {
    if (!reachable || !HR || !hr) return;
    await call("PUT", `/api/users/${hr.user.id}/module-permission-layers`, admin.token, { module: "hr_operations", layers: savedLayers });
    await call("PUT", `/api/users/${hr.user.id}/module-permissions`, admin.token, { modules: savedModules });
  });

  test("HR Operations alone gives no onboarding access", async (t) => {
    if (!reachable || !HR) return t.skip("set ONB_TEST_HR_EMAIL / ONB_TEST_HR_PASSWORD");
    await setLayers([]);
    assert.deepEqual((await call("GET", "/api/hr-ops/joiner-onboarding/access", hr!.token)).body, {
      onboarding_create: false,
      onboarding_review: false,
      onboarding_approve: false
    });
    for (const [m, p] of [
      ["GET", "/api/hr-ops/joiner-onboarding"],
      ["POST", "/api/hr-ops/joiner-onboarding"],
      ["GET", "/api/hr-ops/joiner-onboarding/hired-candidates"],
      ["GET", "/api/hr-ops/joiner-onboarding/1"],
      ["POST", "/api/hr-ops/joiner-onboarding/1/approve"],
      ["POST", "/api/hr-ops/joiner-onboarding/1/reject"],
      ["POST", "/api/hr-ops/joiner-onboarding/1/cancel"],
      ["POST", "/api/hr-ops/joiner-onboarding/1/reset-password"]
    ])
      assert.equal((await call(m, p, hr!.token, m === "GET" ? undefined : {})).code, 403, `${m} ${p}`);
    // The rest of HR Operations is unchanged.
    assert.equal((await call("GET", "/api/hr-ops/meta", hr!.token)).code, 200);
  });

  test("the person who opened an application can't approve it", async (t) => {
    if (!reachable || !HR) return t.skip("set ONB_TEST_HR_EMAIL / ONB_TEST_HR_PASSWORD");
    await setLayers(["read", "onboarding_create", "onboarding_review", "onboarding_approve"]);
    const j = await submittedJoiner(hr!.token);
    const own = await call("POST", `/api/hr-ops/joiner-onboarding/${j.id}/approve`, hr!.token);
    assert.equal(own.code, 403);
    assert.equal((await employeesNamed(j.name)).length, 0);
    // A Superadmin may.
    assert.equal((await call("POST", `/api/hr-ops/joiner-onboarding/${j.id}/approve`, admin.token)).code, 200);
  });

  test("review without approve can send back but not approve", async (t) => {
    if (!reachable || !HR) return t.skip("set ONB_TEST_HR_EMAIL / ONB_TEST_HR_PASSWORD");
    await setLayers(["read", "onboarding_review"]);
    const j = await submittedJoiner(admin.token);
    assert.equal((await call("POST", `/api/hr-ops/joiner-onboarding/${j.id}/approve`, hr!.token)).code, 403);
    assert.equal((await call("POST", `/api/hr-ops/joiner-onboarding/${j.id}/reject`, hr!.token, { reason: "Fix your address" })).code, 200);
    assert.equal((await call("GET", "/api/onboarding/me", j.token)).body.status, "rejected");
  });
});
