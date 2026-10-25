// QA: Bangla in Excel files — the app's exports (XLSX.write / writeFile) and
// the upload reader every import screen uses (src/lib/readWorkbook.ts), for .xlsx and for a UTF-8 .csv with and without the
// byte-order mark Excel puts on "CSV UTF-8".
// Usage: npx tsx qa-bangla-excel.mts <out.json>
import fs from 'fs';
import * as XLSX from 'xlsx';
import { readWorkbook } from '../../../../src/lib/readWorkbook';
const R: any[] = [];
const T = (id: string, ok: boolean, name: string, detail = '') => { R.push({ id, status: ok ? 'PASS' : 'FAIL', name, detail: String(detail).slice(0, 300) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${name}${!ok && detail ? '  — ' + detail : ''}`); };
const rows = [
  { Name: 'রহিম উদ্দিন চৌধুরী', Department: 'হিসাব ও অর্থ বিভাগ', Designation: 'সহকারী ব্যবস্থাপক', Salary: 50000 },
  { Name: 'ফারহানা আক্তার', Department: 'মানবসম্পদ', Designation: 'কর্মকর্তা', Salary: 42000 },
  { Name: 'Karim Uddin', Department: 'MIS', Designation: 'Officer', Salary: 38000 }
];
const same = (got: any) => JSON.stringify(got) === JSON.stringify(rows);
const readLikeImport = (bytes: Uint8Array, name: string) => {
  const wb = readWorkbook(bytes, { raw: /\.csv$/i.test(name) });
  return XLSX.utils.sheet_to_json<any>(wb.Sheets[wb.SheetNames[0]], { raw: true }).map((r) => ({ ...r, Salary: Number(r.Salary) }));
};

// 1. Export (.xlsx) and read back.
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'রিপোর্ট');
const xlsx = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
const back = readLikeImport(new Uint8Array(xlsx), 'report.xlsx');
T('XL-01', same(back), 'An .xlsx export with Bangla names reads back exactly', JSON.stringify(back[0]));
T('XL-02', XLSX.read(xlsx, { type: 'buffer' }).SheetNames[0] === 'রিপোর্ট', 'A Bangla sheet name survives');

// 2. CSV the way Excel saves "CSV UTF-8" (with BOM) and plain UTF-8 (no BOM).
const csv = XLSX.utils.sheet_to_csv(XLSX.utils.json_to_sheet(rows));
const withBom = new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv, 'utf8')]));
const noBom = new Uint8Array(Buffer.from(csv, 'utf8'));
const b1 = readLikeImport(withBom, 'staff.csv');
T('XL-03', same(b1), 'Data Import: a CSV saved by Excel as "CSV UTF-8" keeps the Bangla', JSON.stringify(b1[0]));
const b2 = readLikeImport(noBom, 'staff.csv');
T('XL-04', same(b2), 'Data Import: a UTF-8 CSV without a BOM (Google Sheets, LibreOffice) keeps the Bangla', JSON.stringify(b2[0]));

const phone = XLSX.utils.sheet_to_json<any>(readWorkbook(new Uint8Array(Buffer.from('Name,Phone\nরহিম,01711000000\n')), { raw: true }).Sheets.Sheet1, { raw: true })[0];
T('XL-05', phone?.Phone === '01711000000' && phone?.Name === 'রহিম', 'A CSV phone number keeps its leading 0', JSON.stringify(phone));

const sum = { PASS: R.filter((r) => r.status === 'PASS').length, FAIL: R.filter((r) => r.status === 'FAIL').length };
console.log('\nSUMMARY', JSON.stringify(sum));
fs.writeFileSync(process.argv[2] || 'qa-bangla-excel.json', JSON.stringify({ when: new Date().toISOString(), summary: sum, results: R }, null, 1));
