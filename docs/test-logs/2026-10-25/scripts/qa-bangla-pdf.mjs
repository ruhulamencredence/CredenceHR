// QA: Bangla in the app's PDFs and Excel files. Runs the app's own PDF code
// in the browser (dev server), saves each PDF, turns page 1 into a PNG
// (pdftoppm) for a person to look at, and checks the text is not lost.
// Usage: node qa-bangla-pdf.mjs <out-dir>
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
const req = createRequire(process.env.PLAYWRIGHT_FROM || '/usr/local/lib/node_modules_global/');
const { chromium } = req('playwright');
const BASE = process.env.BASE || 'http://localhost:3100';
const OUT = process.argv[2] || 'bangla-out';
fs.mkdirSync(OUT, { recursive: true });
const NAME = 'রহিম উদ্দিন চৌধুরী';
const b = await chromium.launch();
const p = await b.newPage();
await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(1500);
const made = await p.evaluate(async (NAME) => {
  const b64 = (buf) => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
  const out = {};
  // 1. Payslip
  const ps = await import('/src/lib/payslipPdf.ts');
  const rec = { id: 1, employee_id: 1, employee_name: NAME, employee_code: 'CHL-0101', designation: 'সহকারী ব্যবস্থাপক', department: 'হিসাব ও অর্থ বিভাগ', month_year: '2026-09', total_working_days: 26, present_days: 26, absent_days: 0, leave_days: 0, lwp_days: 0, overtime_hours: 0, basic_amount: 30000, allowances_total: 20000, overtime_amount: 0, bonus_amount: 0, gross_earned: 50000, absent_deduction: 0, tax_deduction: 500, pf_deduction: 1500, advance_deduction: 0, other_deduction: 0, total_deduction: 2000, net_salary: 48000, payment_status: 'paid', remarks: 'সেপ্টেম্বর মাসের বেতন' };
  out.payslip = b64((await ps.buildSinglePayslip(rec)).output('arraybuffer'));
  // 2. HR letter (subject + body in Bangla)
  const hl = await import('/src/lib/hrLetterPdf.ts');
  const letter = await hl.buildLetterPdf({ company: { name: 'Credence Housing Limited', address: 'Gulshan, Dhaka' }, ref_no: 'CHL/HR/2026/101', letter_date: '2026-10-25', subject: 'নিয়োগপত্র — সহকারী ব্যবস্থাপক', body: `জনাব ${NAME},\n\nআপনাকে ১ নভেম্বর ২০২৬ থেকে সহকারী ব্যবস্থাপক পদে নিয়োগ দেওয়া হলো। আপনার মাসিক বেতন ৫০,০০০ টাকা।\n\nশুভেচ্ছান্তে,\nমানবসম্পদ বিভাগ`, employee_name: NAME });
  out.letter = b64(letter.output('arraybuffer'));
  // 3. A report table (jspdf-autotable) with Bangla cells, via the app's jsPDF
  const { default: jsPDF } = await import('/src/lib/jspdf.ts');
  const { default: autoTable } = await import('/@id/jspdf-autotable');
  const d = new jsPDF();
  d.setFontSize(14); d.text('Monthly Leave Report — মাসিক ছুটির প্রতিবেদন', 14, 16);
  autoTable(d, { startY: 22, head: [['Employee / কর্মী', 'Department', 'Days']], body: [[NAME, 'হিসাব বিভাগ', '3'], ['Karim Uddin', 'MIS', '1'], ['ফারহানা আক্তার', 'মানবসম্পদ', '2']] });
  d.setFontSize(10); d.text(`Right aligned: ${NAME}`, 196, 80, { align: 'right' });
  out.report = b64(d.output('arraybuffer'));
  // 4. The same table with plain jsPDF (how it was before) for comparison
  const { default: Plain } = await import('/@id/jspdf');
  const q = new Plain();
  q.setFontSize(14); q.text('Monthly Leave Report — মাসিক ছুটির প্রতিবেদন', 14, 16);
  autoTable(q, { startY: 22, head: [['Employee / কর্মী', 'Department', 'Days']], body: [[NAME, 'হিসাব বিভাগ', '3']] });
  out.before = b64(q.output('arraybuffer'));
  return out;
}, NAME);
await b.close();
let fails = 0;
for (const [k, v] of Object.entries(made)) {
  const f = path.join(OUT, `${k}.pdf`);
  const buf = Buffer.from(v, 'base64');
  fs.writeFileSync(f, buf);
  try { execFileSync('pdftoppm', ['-png', '-r', '70', '-f', '1', '-l', '1', f, path.join(OUT, k)]); } catch { console.log('(no pdftoppm: PNG not made)'); }
  // The app's jsPDF draws Bangla as pictures; plain jsPDF (the "before") can't.
  const drawn = buf.includes('/Subtype /Image');
  const ok = k === 'before' ? !drawn : drawn;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} PDF-${k} ${k === 'before' ? 'plain jsPDF has no Bangla drawing (the old gibberish)' : 'Bangla is drawn into the PDF'} — ${f}, ${buf.length} bytes`);
}
console.log('\nSUMMARY', JSON.stringify({ PASS: Object.keys(made).length - fails, FAIL: fails }));
