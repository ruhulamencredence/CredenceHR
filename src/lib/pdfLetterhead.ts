/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared letterhead for every "Export PDF" in the app (Job Entry Details today,
// any future report tomorrow) — logo + company block, report title, an optional
// "Filtered By" box listing whatever filters were active, and a page-number
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

export interface PdfLetterheadOptions {
  reportTitle: string;
  /** Label/value pairs shown in the "Filtered By" box — omit or pass [] to hide it entirely. */
  filters?: [string, string][];
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

// Draws the logo + company header + report title + (optional) "Filtered By" box
// at the top of the CURRENT page, and returns the Y position content should
// start at. Call again inside autoTable's `didDrawPage` if you want the same
// header repeated on every page of a multi-page table.
export function drawPdfLetterhead(
  doc: jsPDFType,
  logoImg: HTMLImageElement,
  options: PdfLetterheadOptions
): number {
  const pageWidth = doc.internal.pageSize.getWidth();
  const filters = options.filters || [];

  // Logo, top-left. Keeps the source image's aspect ratio.
  const logoWidth = 32;
  const logoHeight = (logoImg.height / logoImg.width) * logoWidth;
  doc.addImage(logoImg, 'PNG', 14, 8, logoWidth, logoHeight);

  // Company block, centered.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(30, 41, 59);
  doc.text('Credence', pageWidth / 2, 13, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(100, 116, 139);
  doc.text('Monthly Budget Optimization', pageWidth / 2, 18.5, { align: 'center' });

  // Separator line under the letterhead.
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.3);
  doc.line(14, 23, pageWidth - 14, 23);

  // Report title.
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12.5);
  doc.setTextColor(15, 23, 42);
  doc.text(options.reportTitle, pageWidth / 2, 30, { align: 'center' });

  let y = 34;

  if (filters.length > 0) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(71, 85, 105);
    doc.text('Filtered By:', 14, y);
    y += 2.5;

    const boxX = 14;
    const boxY = y;
    const boxWidth = pageWidth - 28;
    const colWidth = boxWidth / 2;
    const rowHeight = 6.5;
    const rowCount = Math.ceil(filters.length / 2);
    const boxHeight = rowHeight * rowCount;

    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.25);
    doc.rect(boxX, boxY, boxWidth, boxHeight);
    // Vertical divider between the two columns.
    doc.line(boxX + colWidth, boxY, boxX + colWidth, boxY + boxHeight);
    // Horizontal dividers between rows.
    for (let r = 1; r < rowCount; r++) {
      doc.line(boxX, boxY + r * rowHeight, boxX + boxWidth, boxY + r * rowHeight);
    }

    filters.forEach(([label, value], i) => {
      const row = Math.floor(i / 2);
      const col = i % 2;
      const cellX = boxX + col * colWidth;
      const cellY = boxY + row * rowHeight + rowHeight / 2 + 1.3;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(51, 65, 85);
      doc.text(label, cellX + 3, cellY);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(234, 88, 12);
      doc.text(value || '—', cellX + colWidth / 2 + 2, cellY);
    });

    y = boxY + boxHeight + 6;
  }

  return y;
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
