// QA: the server-made signed PDF (ESignRoutes.buildSignedPdf) with Bangla
// names, document name and signer names. Usage: npx tsx qa-bangla-esign.mts <out.pdf>
import fs from "fs";
import { PDFDocument } from "pdf-lib";
import { buildSignedPdf } from "../../../../ESignRoutes";
const out = process.argv[2] || "esign-bangla.pdf";
const src = await PDFDocument.create();
src.addPage([595, 842]);
const file = Buffer.from(await src.save());
try {
  const pdf = await buildSignedPdf({
    file, kind: "pdf", placement: "last_page", docType: "নিয়োগপত্র", fileName: "নিয়োগপত্র-রহিম.pdf",
    ownerName: "রহিম উদ্দিন চৌধুরী", requestedBy: "মানবসম্পদ বিভাগ", requestedAt: new Date(), originalSha256: "ab".repeat(32),
    verifyCode: "ABCD-1234", verifyUrl: "https://hr.example.com/verify/ABCD-1234",
    signers: [{ name: "ফারহানা আক্তার", label: "প্রধান, মানবসম্পদ", signed_name: "ফারহানা আক্তার", signed_at: new Date(), image: null, ip: "127.0.0.1" }],
    events: [{ at: new Date().toISOString(), label: "স্বাক্ষর", who: "ফারহানা আক্তার", ip: null, device: "Chrome", detail: null }]
  } as any);
  fs.writeFileSync(out, pdf);
  console.log("OK", out, pdf.length, "bytes");
} catch (e: any) {
  console.log("ERROR", e.message);
  process.exitCode = 1;
}
