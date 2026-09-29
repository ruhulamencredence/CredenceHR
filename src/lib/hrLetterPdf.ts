/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Official letter PDF for HR Operations (Appointment, Promotion, Increment,
// Salary Certificate…) — A4 portrait on the company letterhead: logo +
// company block, Ref No. and Date, Subject, the letter body (paragraphs are
// separated by blank lines), and the signatory block. Used by the Admin
// Panel's letter register and by the Employee's own "My Letters" page, so a
// letter prints identically from both.

import jsPDF from 'jspdf';
import { loadImageElement } from './pdfLetterhead';
import credenceLogo from '../assets/credence-logo.png';

export interface LetterPdfCompany {
  name: string;
  address?: string;
  signatory_name?: string;
  signatory_designation?: string;
}

export interface LetterPdfInput {
  company: LetterPdfCompany;
  ref_no: string;
  letter_date: string | null; // YYYY-MM-DD
  subject: string;
  body: string;
  // "DRAFT" watermark for a preview that hasn't been issued yet.
  draft?: boolean;
  // Shown under the signature when the Employee has acknowledged it.
  acknowledged_at?: string | null;
  employee_name?: string;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const longDate = (d: string | null | undefined) => {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  if (!y || !m || !day) return String(d);
  return `${String(day).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`;
};

export async function buildLetterPdf(input: LetterPdfInput): Promise<jsPDF> {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const left = 22;
  const right = pageWidth - 22;
  const width = right - left;
  let logo: HTMLImageElement | null = null;
  try {
    logo = await loadImageElement(credenceLogo);
  } catch {
    logo = null;
  }

  const drawHeader = () => {
    if (logo) {
      const w = 34;
      doc.addImage(logo, 'PNG', left, 12, w, (logo.height / logo.width) * w);
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(30, 41, 59);
    doc.text(input.company.name || '', right, 17, { align: 'right' });
    if (input.company.address) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(100, 116, 139);
      doc.text(input.company.address, right, 22, { align: 'right' });
    }
    doc.setDrawColor(124, 58, 237);
    doc.setLineWidth(0.6);
    doc.line(left, 28, right, 28);
    if (input.draft) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(70);
      doc.setTextColor(241, 245, 249);
      doc.text('DRAFT', pageWidth / 2, pageHeight / 2, { align: 'center', angle: 35 });
    }
  };
  const drawFooter = (page: number, total: number) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(148, 163, 184);
    doc.setDrawColor(226, 232, 240);
    doc.setLineWidth(0.3);
    doc.line(left, pageHeight - 16, right, pageHeight - 16);
    doc.text(`Ref: ${input.ref_no}`, left, pageHeight - 11);
    doc.text(`Page ${page} of ${total}`, right, pageHeight - 11, { align: 'right' });
  };

  drawHeader();
  let y = 38;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(30, 41, 59);
  doc.text(`Ref: ${input.ref_no}`, left, y);
  doc.text(`Date: ${longDate(input.letter_date)}`, right, y, { align: 'right' });
  y += 11;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  const subjectLines = doc.splitTextToSize(`Subject: ${input.subject}`, width);
  doc.text(subjectLines, left, y);
  y += subjectLines.length * 5.6 + 4;

  const lineH = 5.3;
  const bottom = pageHeight - 24;
  const ensure = (needed: number) => {
    if (y + needed > bottom) {
      doc.addPage();
      drawHeader();
      y = 38;
    }
  };
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(30, 41, 59);
  const paragraphs = String(input.body || '').replace(/\r/g, '').split(/\n\s*\n/);
  for (const para of paragraphs) {
    const rawLines = para.split('\n');
    for (const raw of rawLines) {
      const centered = /^TO WHOM IT MAY CONCERN$/i.test(raw.trim());
      if (centered) {
        ensure(lineH);
        doc.setFont('helvetica', 'bold');
        doc.text(raw.trim(), pageWidth / 2, y, { align: 'center' });
        doc.setFont('helvetica', 'normal');
        y += lineH;
        continue;
      }
      const lines = doc.splitTextToSize(raw, width);
      for (const line of lines) {
        ensure(lineH);
        doc.text(line, left, y);
        y += lineH;
      }
    }
    y += 3;
  }

  ensure(38);
  y += 4;
  doc.text('Sincerely,', left, y);
  y += 20;
  doc.setDrawColor(148, 163, 184);
  doc.setLineWidth(0.3);
  doc.line(left, y, left + 55, y);
  y += 5;
  doc.setFont('helvetica', 'bold');
  doc.text(input.company.signatory_name || 'Authorised Signatory', left, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  if (input.company.signatory_designation) {
    doc.text(input.company.signatory_designation, left, y);
    y += 4.8;
  }
  doc.text(input.company.name || '', left, y);
  if (input.acknowledged_at) {
    y += 10;
    ensure(8);
    doc.setFontSize(8.5);
    doc.setTextColor(5, 150, 105);
    doc.text(
      `Acknowledged${input.employee_name ? ' by ' + input.employee_name : ''} on ${longDate(String(input.acknowledged_at).slice(0, 10))} via CredenceHR.`,
      left,
      y
    );
  }

  const total = doc.getNumberOfPages();
  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    drawFooter(i, total);
  }
  return doc;
}

export const letterFileName = (ref: string, employeeName?: string) =>
  `${(employeeName || 'Letter').replace(/\s+/g, '_')}_${ref.replace(/[^\w-]+/g, '-')}.pdf`;
