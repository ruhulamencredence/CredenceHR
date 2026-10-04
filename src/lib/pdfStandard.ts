/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The company's standard report PDF (the layout of the Bill Disbursement /
// Claim Report): logo top-left, the company's name and address centred, a
// rule, the report title, "Label: value" lines on the left, then a plain grid
// table (light grey header, thin borders, bold Total row) and page numbers.
//
// The name, address and logo are the active company's (Admin Panel ->
// Companies); without a logo the Credence logo is used.
//
//   const co = await loadPdfCompany(token);
//   const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
//   const y = drawStandardHeader(doc, co, 'Claim Report', [['Employee Name', 'X'], ...]);
//   autoTable(doc, { ...standardTable(y), head, body, foot });
//   finalizePdfPageNumbers(doc);

import type jsPDFType from 'jspdf';
import credenceLogo from '../assets/credence-logo.png';
import { apiUrl } from './api';
import { getActiveCompanyId } from './company';
import { loadImageElement } from './pdfLetterhead';

export interface PdfCompany {
  name: string;
  address: string | null;
  logo: HTMLImageElement | null;
}

export async function loadPdfCompany(token: string): Promise<PdfCompany> {
  let name = 'Credence Housing Limited';
  let address: string | null = null;
  let logo: HTMLImageElement | null = null;
  try {
    const res = await fetch(apiUrl('/api/companies/mine'), { headers: { Authorization: `Bearer ${token}` } });
    const d = res.ok ? await res.json() : null;
    const id = d?.active_company_id || getActiveCompanyId();
    const c = (d?.companies || []).find((x: any) => Number(x.id) === Number(id)) || d?.companies?.[0];
    if (c) {
      name = c.name || name;
      address = c.address || null;
      if (c.has_logo) {
        const lr = await fetch(apiUrl(`/api/companies/${c.id}/logo`), { headers: { Authorization: `Bearer ${token}` } });
        if (lr.ok) {
          const url = URL.createObjectURL(await lr.blob());
          logo = await loadImageElement(url).catch(() => null);
        }
      }
    }
  } catch {
    // offline / no access — the defaults below
  }
  if (!logo) logo = await loadImageElement(credenceLogo).catch(() => null);
  return { name, address, logo };
}

const MARGIN = 8;

// Draws the header on the current page; returns the Y the table starts at.
export function drawStandardHeader(doc: jsPDFType, co: PdfCompany, title: string, details: [string, string][] = []): number {
  const pageWidth = doc.internal.pageSize.getWidth();
  if (co.logo) {
    const w = 32;
    const h = Math.min(14, (co.logo.height / co.logo.width) * w);
    doc.addImage(co.logo, 'PNG', MARGIN + 2, 9, (co.logo.width / co.logo.height) * h, h);
  }
  doc.setTextColor(40, 40, 40);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(co.name, pageWidth / 2, 13, { align: 'center' });
  let y = 13;
  if (co.address) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    const lines = co.address
      .split(/\n/)
      .flatMap((l) => doc.splitTextToSize(l.trim(), 85) as string[])
      .filter(Boolean)
      .slice(0, 3);
    for (const l of lines) {
      y += 4;
      doc.text(l, pageWidth / 2, y, { align: 'center' });
    }
  }
  y = Math.max(y + 5, 25);
  doc.setDrawColor(150, 150, 150);
  doc.setLineWidth(0.25);
  doc.line(MARGIN, y, pageWidth - MARGIN, y);

  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(title, pageWidth / 2, y, { align: 'center' });

  y += 7;
  doc.setFontSize(7.5);
  for (const [label, value] of details) {
    doc.setFont('helvetica', 'bold');
    doc.text(`${label}:`, MARGIN, y);
    const labelWidth = doc.getTextWidth(`${label}:`);
    doc.setFont('helvetica', 'normal');
    doc.text(value || '-', MARGIN + labelWidth + 1.2, y);
    y += 3.6;
  }
  return y + 2;
}

// autoTable options for the plain grid table; spread them in and add
// head/body/foot/columnStyles.
export function standardTable(startY: number) {
  return {
    startY,
    margin: { top: 12, left: MARGIN, right: MARGIN, bottom: 14 },
    theme: 'grid' as const,
    styles: { font: 'helvetica', fontSize: 7, cellPadding: 1.6, textColor: [40, 40, 40] as [number, number, number], lineColor: [215, 215, 215] as [number, number, number], lineWidth: 0.1, valign: 'middle' as const },
    headStyles: { fillColor: [246, 246, 246] as [number, number, number], textColor: [40, 40, 40] as [number, number, number], fontStyle: 'bold' as const, halign: 'center' as const },
    // Totals are amounts, so right-aligned; give the "Total" label cell
    // styles: { halign: 'left' }.
    footStyles: { fillColor: [255, 255, 255] as [number, number, number], textColor: [20, 20, 20] as [number, number, number], fontStyle: 'bold' as const, halign: 'right' as const },
    showFoot: 'lastPage' as const
  };
}

// 420 -> "420.00"; empty/zero shown as "-" when asked.
export const pdfMoney = (n: number | null | undefined, dashZero = false) =>
  n == null || (dashZero && !Number(n)) ? '-' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
