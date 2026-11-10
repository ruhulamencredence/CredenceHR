// Every Admin Panel module at phone width: screenshot + overflow / table / tab facts.
import pw from '/opt/node-tools/node_modules/playwright/index.js';
import fs from 'node:fs';
const { chromium } = pw;
const B = 'http://localhost:3200';
const OUT = process.env.OUT;
const TABS = ["dashboard", "reports_insights", "data_import", "projects", "branches", "mprs", "imports", "reports", "users", "employees", "departments", "attendance", "attendance_reports", "leave_applications", "office_attendance", "tracking", "recycle", "editlog", "notices", "claims", "approvals", "bill_claim", "bill_claim_policy", "disbursement", "holidays", "asset_management", "vehicle_management", "permanent_delete_log", "companies", "devices", "active_users", "exit_offboarding", "performance_management", "recruitment", "grievance_disciplinary", "hr_analytics", "management_dashboard", "document_vault", "hr_operations", "task_management", "mobile_bill", "target_reports", "mail_admin", "duty_roster", "break_time", "user_feedback"];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
await ctx.addInitScript(() => { for (let i = 0; i < 500; i++) localStorage.setItem(`credence_webpush_snooze_${i}`, String(Date.now() + 9e9)); localStorage.setItem('feedback_never', '1'); });
const p = await ctx.newPage();
await p.goto(B + '/', { waitUntil: 'domcontentloaded' });
const ws = p.getByLabel('Workspace code');
if (await ws.isVisible({ timeout: 30000 }).catch(() => false)) { await ws.fill('credence'); await p.getByRole('button', { name: 'Next' }).click(); }
await p.getByPlaceholder(/Employee ID/).fill('admin@credence.test');
await p.getByPlaceholder('••••••••').fill('ProbePass123');
await p.getByRole('button', { name: 'Sign in' }).click();
await p.waitForTimeout(7000);
const dismiss = async () => { for (const n of ["Don't ask again", 'Get started']) { const l = p.getByRole('button', { name: n }); if (await l.isVisible().catch(() => false)) { await l.click().catch(() => {}); await p.waitForTimeout(400); } } };
await dismiss();
const facts = [];
for (const t of TABS) {
  await p.goto(`${B}/admin/${t.replace(/_/g, '-')}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4500);
  await dismiss();
  const f = await p.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const main = document.querySelector('main') || document.body;
    const tables = [...main.querySelectorAll('table')].filter((x) => x.offsetParent);
    const wideTables = tables.filter((x) => x.scrollWidth > vw).length;
    const overflowPage = document.documentElement.scrollWidth > vw + 1;
    const tabsBtns = [...main.querySelectorAll('[role=tab], button')].filter((b) => b.offsetParent && b.getBoundingClientRect().top < 400).length;
    const smallText = [...main.querySelectorAll('*')].filter((e) => e.offsetParent && e.children.length === 0 && (e.textContent || '').trim() && parseFloat(getComputedStyle(e).fontSize) < 11).length;
    const tinyTargets = [...main.querySelectorAll('button, a, select, input')].filter((e) => { const r = e.getBoundingClientRect(); return e.offsetParent && r.width > 0 && (r.height < 32); }).length;
    const h = document.querySelector('h1,h2');
    return { vw, overflowPage, tables: tables.length, wideTables, tabsBtns, smallText, tinyTargets, heading: h ? h.textContent.trim().slice(0, 60) : '', height: document.documentElement.scrollHeight };
  });
  facts.push({ tab: t, ...f });
  await p.screenshot({ path: `${OUT}/${t}.png` });
  console.log(t, JSON.stringify(f));
}
fs.writeFileSync(`${OUT}/facts.json`, JSON.stringify(facts, null, 1));
// Payroll (a self-service view) + Self Service references
for (const [name, ev] of [['payroll', 'payroll'], ['self_myLoans', 'myLoans'], ['self_leave', 'leave']]) {
  await p.goto(B + '/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(4000);
  await p.evaluate((d) => window.dispatchEvent(new CustomEvent('credence:open-self-service', { detail: d })), ev);
  await p.waitForTimeout(4500);
  await dismiss();
  await p.screenshot({ path: `${OUT}/${name}.png` });
}
await browser.close();
