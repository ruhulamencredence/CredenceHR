/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared header for every "Export PDF" in the app — the company's standard
// report header (pdfStandard.ts): logo + company name and address, report
// title, the active filters as "Label: value" lines, and a page-number
// footer. Import drawPdfLetterhead + finalizePdfPageNumbers wherever a PDF is
// built with jsPDF/jspdf-autotable so every export looks the same.
//
// Usage:
//   const logoImg = await loadImageElement(credenceLogo);
//   const doc = new jsPDF({ orientation: 'landscape' });
//   const contentStartY = drawPdfLetterhead(doc, logoImg, {
//     reportTitle: 'Job Entry Details Report',
//     filters: [['Department', 'Internal Audit'], ['Status', 'Active']],
//   });
//   autoTable(doc, { startY: contentStartY, margin: { top: contentStartY }, ... });
//   finalizePdfPageNumbers(doc);
//   doc.save('report.pdf');

import type jsPDFType from 'jspdf';
import { cachedPdfCompany, drawStandardHeader } from './pdfStandard';

export interface PdfLetterheadOptions {
  reportTitle: string;
  /** Label/value pairs listed under the title (the active filters, or a voucher/payslip's details) — omit or pass [] for none. */
  filters?: [string, string][];
  /** No longer drawn — the standard header lists the details as "Label: value" lines without a heading. Kept so existing callers compile. */
  filtersLabel?: string;
}

// Preloads an <img> so jsPDF's addImage (which needs actual pixel data, not just
// a URL) can draw it — pass the imported asset path (e.g. `import logo from
// '../assets/credence-logo.png'`) in.
export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// "23-08-2026 02:19 PM" — used for the footer's "Printed on ..." line.
export function printedOnTimestamp(): string {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${day}-${month}-${year} ${String(hours).padStart(2, '0')}:${minutes} ${ampm}`;
}

// Draws the company's standard report header (pdfStandard.ts — the
// active company's logo, name and address, a rule, the title, then
// "Label: value" lines for the filters) at the top of the CURRENT page, and
// returns the Y position content should start at. Every report PDF uses this
// one header. `logoImg` is only the fallback when the company isn't loaded.
// Call again inside autoTable's `didDrawPage` to repeat it on every page.
export function drawPdfLetterhead(
  doc: jsPDFType,
  logoImg: HTMLImageElement,
  options: PdfLetterheadOptions
): number {
  const co = cachedPdfCompany() || { name: 'Credence Housing Limited', address: null, logo: logoImg };
  return drawStandardHeader(doc, co.logo ? co : { ...co, logo: logoImg }, options.reportTitle, options.filters || []);
}

// Call once, after the document is fully built (table drawn, all pages exist) —
// stamps "Printed on ..." (bottom-left) and "Page X of Y" (bottom-right) onto
// every page, since the total page count is only known at this point.
export function finalizePdfPageNumbers(doc: jsPDFType): void {
  const pageCount = doc.getNumberOfPages();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const stamp = `Printed on ${printedOnTimestamp()}`;

  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text(stamp, 14, pageHeight - 8);
    doc.text(`Page ${i} of ${pageCount}`, pageWidth - 14, pageHeight - 8, { align: 'right' });
  }
}
