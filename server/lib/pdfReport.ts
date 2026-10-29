import PDFDocument from 'pdfkit';
import { drawMark } from './pdfMark.ts';
import { LANDSCAPE_COLUMNS, formatCell, isRightAligned, printsWide, type ReportChart, type ReportDocument, type ReportFigure, type ReportTable } from '../../shared/reportCatalog.ts';

/**
 * A report document as a printed PDF (ADR-0020): the cover block with what it is, whom it is about, the unit, the period,
 * when and by whom it was made and every filter that shaped it; then its sections, each table's header repeated after a
 * page break, every cell wrapped rather than cut, and the handling line at the top and foot of every page with the page
 * number. Drawn from the document itself, never from the screen. The palette and the mark are the analysis PDF's.
 */

const INK = '#111827'; const INK2 = '#4b5563'; const MUTED = '#6b7280'; const RULE = '#d1d5db'; const SOFT = '#f3f4f6'; const ACCENT = '#9f1d22';

/** The standard PDF fonts read WinAnsi: Latin-1 and the punctuation Windows adds to it. Anything else prints as '?'. */
const WIN_ANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
export const pdfText = (text: string) => text.replace(/[\r\t]/g, ' ').replace(/[^\n\x20-\x7e\xa0-\xff]/gu, (ch) => (WIN_ANSI_EXTRA.has(ch) ? ch : '?'));

/** A table wider than this many columns turns the document to landscape, so no column is too narrow to read. */
const PAD = 3.5;
/** A cell longer than this is shortened in print so a row always fits a page; the CSV and the workbook hold it whole. */
const MAX_CELL = 600;

export function renderReportDocumentPdf(report: ReportDocument): Promise<Buffer> {
  const wide = printsWide(report);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER', layout: wide ? 'landscape' : 'portrait', margins: { top: 64, bottom: 64, left: 50, right: 50 }, bufferPages: true,
      info: { Title: pdfText(`${report.title} · ${report.about}`), Author: 'Vantage', Subject: pdfText(report.about), Keywords: report.type },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };
    const text = (t: string, font: string, size: number, color: string, opts: PDFKit.Mixins.TextOptions = {}) => {
      doc.font(font).fontSize(size).fillColor(color).text(pdfText(t), left, doc.y, { width, lineGap: 1.6, ...opts });
    };
    const rule = () => { doc.moveDown(0.35); doc.strokeColor(RULE).lineWidth(0.6).moveTo(left, doc.y).lineTo(left + width, doc.y).stroke(); doc.moveDown(0.5); };
    const fmt = (v: ReportFigure['value'], kind?: ReportFigure['kind']) => formatCell(v, kind, report.currency);
    let shortened = false;
    const cellText = (v: string) => { if (v.length <= MAX_CELL) return v; shortened = true; return `${v.slice(0, MAX_CELL - 1).trimEnd()}…`; };

    // ——— Cover block ———
    drawMark(doc, left + width - 38, doc.y - 4, 38);
    text(`VANTAGE  ·  ${report.title.toUpperCase()}`, 'Helvetica-Bold', 8, MUTED, { characterSpacing: 1.6, width: width - 56 });
    doc.moveDown(0.3);
    text(report.title, 'Helvetica-Bold', 20, INK, { width: width - 56 });
    text(report.about, 'Helvetica', 11, INK2, { width: width - 56 });
    const lines = [
      report.unit ? `Unit: ${report.unit}` : null,
      report.period ? `Period: ${report.period.label}${report.period.from && report.period.to ? ` (${report.period.from} to ${report.period.to})` : ''}` : null,
      `Generated ${report.generated.on} by ${report.generated.by}`,
    ].filter(Boolean) as string[];
    doc.moveDown(0.2);
    for (const l of lines) text(l, 'Helvetica', 8.5, MUTED);

    if (report.filters.length) {
      doc.moveDown(0.5);
      const colW = width / 2;
      const boxH = Math.ceil(report.filters.length / 2) * 13 + 22;
      ensure(boxH);
      const top = doc.y;
      doc.rect(left, top, width, boxH).fill(SOFT);
      doc.font('Helvetica-Bold').fontSize(7).fillColor(INK2).text('FILTERS', left + 8, top + 6, { characterSpacing: 1.2, lineBreak: false });
      report.filters.forEach((f, i) => {
        const x = left + 8 + (i % 2) * colW; const y = top + 18 + Math.floor(i / 2) * 13;
        doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(pdfText(`${f.label}:`), x, y, { width: colW * 0.36, lineBreak: false, ellipsis: true });
        doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(pdfText(f.value), x + colW * 0.36, y, { width: colW * 0.64 - 16, lineBreak: false, ellipsis: true });
      });
      doc.x = left; doc.y = top + boxH;
    }
    rule();

    // ——— Figures in a grid ———
    const figures = (list: ReportFigure[]) => {
      if (!list.length) return;
      const cols = wide ? 4 : 3; const colW = width / cols; const rowH = 30;
      for (let i = 0; i < list.length; i += cols) {
        ensure(rowH);
        const y = doc.y;
        list.slice(i, i + cols).forEach((f, j) => {
          const x = left + j * colW;
          doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(pdfText(f.label), x, y, { width: colW - 10, lineBreak: false, ellipsis: true });
          doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(pdfText(fmt(f.value, f.kind)), x, y + 10, { width: colW - 10, lineBreak: false, ellipsis: true });
        });
        doc.x = left; doc.y = y + rowH;
      }
      doc.moveDown(0.2);
    };

    // ——— Horizontal bars, each with its label and its figure; the table below holds the same numbers in full ———
    const chart = (c: ReportChart) => {
      const bars = c.bars.slice(0, 30);
      if (bars.length < 2 || !bars.some((b) => b.value)) return;
      const labelW = width * 0.32; const valueW = width * 0.16; const barW = width - labelW - valueW - 12; const rowH = 13;
      ensure(rowH * Math.min(bars.length, 6) + 24);
      text(c.title, 'Helvetica-Bold', 9, INK);
      doc.moveDown(0.2);
      const max = Math.max(...bars.map((b) => Math.abs(b.value)), 1);
      for (const b of bars) {
        ensure(rowH);
        const y = doc.y;
        doc.font('Helvetica').fontSize(7.5).fillColor(INK2).text(pdfText(b.label), left, y + 2, { width: labelW - 6, lineBreak: false, ellipsis: true });
        const w = Math.max(b.value ? 1 : 0, (Math.abs(b.value) / max) * barW);
        if (w) doc.rect(left + labelW, y + 2.5, w, rowH - 5).fill(ACCENT);
        doc.font('Helvetica').fontSize(7.5).fillColor(INK).text(pdfText(fmt(b.value, c.kind)), left + labelW + barW + 6, y + 2, { width: valueW + 6, align: 'right', lineBreak: false });
        doc.x = left; doc.y = y + rowH;
      }
      doc.moveDown(0.5);
    };

    // ——— Tables: wrapped cells, the header again on every page the table reaches ———
    const table = (t: ReportTable) => {
      // The title, the header and a first row together, so a title never ends a page on its own.
      ensure(72);
      text(t.title, 'Helvetica-Bold', 9.5, INK);
      if (t.note) text(t.note, 'Helvetica', 8, MUTED);
      doc.moveDown(0.15);
      if (!t.rows.length) { text(t.empty, 'Helvetica', 8.5, MUTED); doc.moveDown(0.5); return; }
      const size = t.columns.length > LANDSCAPE_COLUMNS ? 7 : 7.8;
      const total = t.columns.reduce((n, c) => n + (c.width || 10), 0);
      const cols = t.columns.map((c) => ({ ...c, w: ((c.width || 10) / total) * width }));
      const cellHeight = (value: string, w: number, bold = false) => doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).heightOfString(value, { width: w - PAD * 2, lineGap: 0.8 });
      const header = (continued: boolean) => {
        if (continued) { text(`${t.title} (continued)`, 'Helvetica-Oblique', 7.5, MUTED); doc.moveDown(0.1); }
        const labels = cols.map((c) => pdfText(c.label.toUpperCase()));
        const h = Math.max(...cols.map((c, i) => cellHeight(labels[i], c.w, true))) + PAD * 2;
        const y = doc.y;
        doc.rect(left, y, width, h).fill(SOFT);
        let x = left;
        cols.forEach((c, i) => {
          doc.font('Helvetica-Bold').fontSize(size).fillColor(INK2).text(labels[i], x + PAD, y + PAD, { width: c.w - PAD * 2, align: isRightAligned(c.kind) ? 'right' : 'left', lineGap: 0.8 });
          x += c.w;
        });
        doc.x = left; doc.y = y + h;
      };
      ensure(40);
      header(false);
      t.rows.forEach((row, n) => {
        const cells = cols.map((c) => pdfText(cellText(formatCell(row[c.key], c.kind, report.currency))));
        const h = Math.max(...cols.map((c, i) => cellHeight(cells[i], c.w))) + PAD * 2;
        if (doc.y + h > bottom()) { doc.addPage(); header(true); }
        const y = doc.y;
        if (n % 2 === 1) doc.rect(left, y, width, h).fill('#fafafa');
        let x = left;
        cols.forEach((c, i) => {
          doc.font('Helvetica').fontSize(size).fillColor(INK).text(cells[i], x + PAD, y + PAD, { width: c.w - PAD * 2, align: isRightAligned(c.kind) ? 'right' : 'left', lineGap: 0.8 });
          x += c.w;
        });
        doc.strokeColor('#eceff3').lineWidth(0.4).moveTo(left, y + h).lineTo(left + width, y + h).stroke();
        doc.x = left; doc.y = y + h;
      });
      if (t.total > t.rows.length) { doc.moveDown(0.2); text(`The first ${t.rows.length} of ${t.total} rows. Narrow the filters for the rest.`, 'Helvetica-Oblique', 7.5, MUTED); }
      doc.moveDown(0.6);
    };

    // ——— Summary, sections, notes ———
    if (report.summary.length) {
      text('SUMMARY', 'Helvetica-Bold', 8, ACCENT, { characterSpacing: 1.4 });
      doc.moveDown(0.25);
      figures(report.summary);
    }
    for (const section of report.sections) {
      ensure(90);
      doc.moveDown(0.5);
      text(section.heading, 'Helvetica-Bold', 13, INK);
      if (section.lede) text(section.lede, 'Helvetica', 8.8, INK2);
      doc.moveDown(0.3);
      if (section.figures?.length) figures(section.figures);
      if (section.chart) chart(section.chart);
      for (const t of section.tables) table(t);
      for (const note of section.notes || []) text(`•  ${note}`, 'Helvetica', 8, INK2);
    }
    const notes = [...report.notes, ...(shortened ? [`A cell longer than ${MAX_CELL} characters is shortened here; the CSV and the workbook hold it whole.`] : [])];
    if (notes.length) {
      ensure(60);
      doc.moveDown(0.6);
      text('About these figures', 'Helvetica-Bold', 10, INK);
      doc.moveDown(0.15);
      for (const note of notes) text(`•  ${note}`, 'Helvetica', 8, INK2, { paragraphGap: 1.5 });
    }

    // ——— The handling line at the top and foot of every page, with its number ———
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const margins = { ...doc.page.margins };
      doc.page.margins.top = 0; doc.page.margins.bottom = 0;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(pdfText(report.marking), left, 30, { width, align: 'center', lineBreak: false, ellipsis: true });
      const y = doc.page.height - 46;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(pdfText(report.marking), left, y, { width, align: 'center', lineBreak: false, ellipsis: true });
      doc.font('Helvetica').fontSize(7).fillColor(MUTED);
      doc.text(pdfText(`${report.title}  ·  ${report.about}${report.period ? `  ·  ${report.period.label}` : ''}`), left, y + 12, { width: width * 0.75, lineBreak: false, ellipsis: true });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + width * 0.75, y + 12, { width: width * 0.25, align: 'right', lineBreak: false });
      doc.text(pdfText(`Generated ${report.generated.on} by ${report.generated.by} in Vantage. Every figure is drawn from the records it names.`), left, y + 21, { width, lineBreak: false, ellipsis: true });
      doc.page.margins.top = margins.top; doc.page.margins.bottom = margins.bottom;
    }
    doc.end();
  });
}
