import PDFDocument from 'pdfkit';
import { drawMark } from './pdfMark.ts';
import { pdfText } from './pdfReport.ts';
import { documentBand, type CounselingDocument } from '../../shared/counseling.ts';

/**
 * A counseling's worksheet as a printed PDF (Task 20, ADR-0027), in the layout of NAVMC 2795 Appendix A: Figure A-1 for
 * a Lance Corporal and below, Figure A-2 for a Corporal and above. Drawn from the structured document the server builds
 * from the stored record, never from the screen, and never stored: the record is the source, this is one way to read it.
 *
 * The frame is the report PDF's (ADR-0020): Letter, the standard fonts through pdfText, the Vantage mark, and the
 * handling line at the top and foot of every page with its number. Long text runs on to the next page rather than being
 * cut, because a counseling's words are the point of it. The SSN block both figures print is left out on purpose.
 */

const INK = '#111827'; const INK2 = '#4b5563'; const MUTED = '#6b7280'; const RULE = '#9ca3af'; const SOFT = '#f3f4f6'; const ACCENT = '#9f1d22';

export function renderCounselingPdf(form: CounselingDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER', layout: 'portrait', margins: { top: 64, bottom: 64, left: 50, right: 50 }, bufferPages: true,
      info: {
        // Who it is about stays out of the file's properties; it is in the worksheet, under its handling line.
        Title: pdfText(`Counseling worksheet · ${form.type_label}${form.date ? ` · ${form.date}` : ''}`), Author: 'Vantage',
        Subject: pdfText(`NAVMC 2795 layout, ${form.worksheet.figure}`), Keywords: 'counseling',
        // Fixed, so the same revision draws the same file.
        CreationDate: new Date(form.finalized.at || '2000-01-01T00:00:00.000Z'),
      },
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
    const s = form.particulars.subject;
    const counselor = form.particulars.counselor;
    const person = (p: { name: string; rank: string | null } | null) => (p ? `${p.rank ? `${p.rank} ` : ''}${p.name}` : '');

    // ——— What it is ———
    drawMark(doc, left + width - 38, doc.y - 4, 38);
    text("VANTAGE  ·  USER'S GUIDE TO COUNSELING (NAVMC 2795)", 'Helvetica-Bold', 8, MUTED, { characterSpacing: 1.4, width: width - 56 });
    doc.moveDown(0.3);
    text(form.worksheet.caption, 'Helvetica-Bold', 15, INK, { width: width - 56 });
    text(`${form.worksheet.figure} layout. Not an official form.`, 'Helvetica', 9, INK2, { width: width - 56 });
    doc.moveDown(0.5);

    const band = documentBand(form);
    if (band) {
      const y = doc.y;
      doc.rect(left, y, width, 20).fill(form.stage === 'final' && form.revision === form.current_revision ? SOFT : '#fde8e8');
      doc.font('Helvetica-Bold').fontSize(9).fillColor(ACCENT).text(pdfText(band), left + 8, y + 6, { width: width - 16, lineBreak: false, ellipsis: true });
      doc.y = y + 26;
    }

    // ——— The header blocks: labelled boxes, as the worksheet has them ———
    type Field = { label: string; value: string; span: number };
    const grid = (rows: Field[][]) => {
      for (const row of rows) {
        const total = row.reduce((n, f) => n + f.span, 0);
        doc.font('Helvetica').fontSize(9.5);
        const widths = row.map((f) => (width * f.span) / total);
        const heights = row.map((f, i) => doc.heightOfString(pdfText(f.value || ' '), { width: widths[i] - 10, lineGap: 1.2 }));
        const h = Math.max(...heights) + 22;
        ensure(h);
        const y = doc.y;
        let x = left;
        row.forEach((f, i) => {
          doc.lineWidth(0.6).strokeColor(RULE).rect(x, y, widths[i], h).stroke();
          doc.font('Helvetica-Bold').fontSize(6.8).fillColor(INK2).text(pdfText(f.label), x + 5, y + 4, { width: widths[i] - 10, lineBreak: false, ellipsis: true });
          doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(pdfText(f.value || ' '), x + 5, y + 14, { width: widths[i] - 10, lineGap: 1.2 });
          x += widths[i];
        });
        doc.y = y + h;
      }
      doc.x = left;
    };
    const kind = form.session_kind;
    const box = (on: boolean) => (on ? '[X]' : '[  ]');
    const grade = [s.rank, s.grade ? `(${s.grade})` : ''].filter(Boolean).join(' ');
    if (form.worksheet.key === 'A-1') {
      grid([
        [{ label: 'Name:', value: s.name, span: 3 }, { label: 'Date:', value: form.date ?? '', span: 1 }],
        [{ label: 'Grade:', value: grade, span: 1 }, { label: 'MOS:', value: s.mos ?? '', span: 1 }, { label: 'Billet:', value: s.billet ?? '', span: 2 }],
      ]);
    } else {
      grid([
        [{ label: 'Grade', value: grade, span: 1 }, { label: 'Name:', value: s.name, span: 2 }, { label: 'MOS', value: s.mos ?? '', span: 1 }],
        [{ label: 'Billet', value: s.billet ?? '', span: 2 }, { label: 'Date', value: form.date ?? '', span: 1 }, { label: 'ICS / Follow-on', value: `${box(kind === 'ics')} ICS   ${box(kind === 'follow_on')} Follow-on`, span: 1 }],
      ]);
    }
    grid([[
      { label: 'Unit (Vantage)', value: s.unit ?? '', span: 2 },
      { label: 'Type of session (Vantage)', value: `${form.type_label}${kind === 'event' ? ' (event-related, NAVMC 2795 para 2001.4)' : ''}`, span: 2 },
    ]]);
    text('The SSN block on the worksheet is left out: Vantage does not record or print an SSN.', 'Helvetica-Oblique', 7.5, MUTED);
    doc.moveDown(0.6);

    // ——— What was discussed and set: each block runs on to the next page when it is long ———
    for (const block of form.blocks) {
      ensure(48);
      const y = doc.y;
      doc.rect(left, y, width, 16).fill(SOFT);
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK).text(pdfText(block.label), left + 6, y + 4.5, { width: width - 12, lineBreak: false, ellipsis: true });
      doc.y = y + 21;
      if (!block.parts.length) text('Nothing recorded.', 'Helvetica-Oblique', 9, MUTED);
      for (const p of block.parts) {
        if (p.label) { text(p.label, 'Helvetica-Bold', 8.5, INK2); doc.moveDown(0.1); }
        text(p.text, 'Helvetica', 10, INK, { lineGap: 2, paragraphGap: 2 });
        doc.moveDown(0.3);
      }
      doc.lineWidth(0.6).strokeColor(RULE).moveTo(left, doc.y).lineTo(left + width, doc.y).stroke();
      doc.moveDown(0.8);
    }

    // ——— The two signature lines the worksheet has, and the next session ———
    ensure(130);
    const sigY = doc.y + 26;
    const half = (width - 24) / 2;
    const signature = (x: number, label: string, name: string, note: string) => {
      doc.lineWidth(0.8).strokeColor(INK).moveTo(x, sigY).lineTo(x + half, sigY).stroke();
      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(pdfText(label), x, sigY + 4, { width: half, lineBreak: false });
      doc.font('Helvetica').fontSize(9).fillColor(INK).text(pdfText(name || ' '), x, sigY + 15, { width: half, lineBreak: false, ellipsis: true });
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(pdfText(note), x, sigY + 28, { width: half, lineGap: 1 });
    };
    const ack = form.own_notes ? 'The Marine’s own notes: nothing to acknowledge in Vantage.'
      : form.acknowledgement.at ? `Acknowledged in Vantage on ${form.acknowledgement.at.slice(0, 10)}: confirms the Marine read it, not that they agree.`
        : form.stage === 'final' ? 'Not yet acknowledged in Vantage.' : 'Acknowledged once it is final.';
    const fin = form.own_notes ? 'Recorded by the Marine. No counselor finalized it in Vantage.'
      : form.finalized.at ? `Finalized in Vantage on ${form.finalized.at.slice(0, 10)}${form.finalized.by ? ` by ${form.finalized.by}` : ''}.`
        : form.stage === 'final' ? 'Recorded in Vantage before finalization was kept.' : 'Not yet finalized.';
    signature(left, 'Marine Counseled', person({ name: s.name, rank: s.rank }), ack);
    signature(left + half + 24, 'Marine Performing Counseling', person(counselor), fin);
    doc.y = sigY + 58;
    doc.x = left;
    grid([[{ label: 'Target Date for Next Session', value: form.follow_up_date ?? '', span: 1 }]]);

    // ——— Its amendments, newest first: what changed, by whom, when and why ———
    if (form.amendments.length) {
      ensure(60);
      doc.moveDown(0.8);
      text(`Amendment history (${form.amendments_total})`, 'Helvetica-Bold', 10, INK);
      doc.moveDown(0.2);
      for (const a of form.amendments) {
        ensure(34);
        text(`Revision ${a.revision}  ·  ${a.at.slice(0, 10)}${a.by ? `  ·  ${a.by}` : ''}  ·  changed ${a.changed.join(', ') || 'nothing'}${a.acknowledged_at ? `  ·  replaced text the Marine acknowledged on ${a.acknowledged_at.slice(0, 10)}` : ''}`, 'Helvetica-Bold', 8, INK2);
        text(`Why: ${a.reason}`, 'Helvetica', 8.5, INK, { paragraphGap: 3 });
      }
      if (form.amendments_total > form.amendments.length) text(`${form.amendments_total - form.amendments.length} earlier amendments are in the record's history.`, 'Helvetica-Oblique', 8, MUTED);
    }

    // ——— Where this comes from, and how to handle it ———
    ensure(50);
    doc.moveDown(0.8);
    for (const note of [...form.notices, form.source]) text(`•  ${note}`, 'Helvetica', 7.5, INK2, { paragraphGap: 1.5 });

    // ——— The handling line at the top and foot of every page, with its number ———
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const margins = { ...doc.page.margins };
      doc.page.margins.top = 0; doc.page.margins.bottom = 0;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(pdfText(form.marking), left, 30, { width, align: 'center', lineBreak: false, ellipsis: true });
      const y = doc.page.height - 46;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK).text(pdfText(form.marking), left, y, { width, align: 'center', lineBreak: false, ellipsis: true });
      doc.font('Helvetica').fontSize(7).fillColor(MUTED);
      doc.text(pdfText(`${form.worksheet.figure}  ·  record ${form.id.slice(0, 8)}  ·  revision ${form.revision}${band ? `  ·  ${band}` : ''}`), left, y + 12, { width: width * 0.75, lineBreak: false, ellipsis: true });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + width * 0.75, y + 12, { width: width * 0.25, align: 'right', lineBreak: false });
      doc.text(pdfText(`Generated ${form.generated.on} by ${form.generated.by} in Vantage, from the structured counseling record.`), left, y + 21, { width, lineBreak: false, ellipsis: true });
      doc.page.margins.top = margins.top; doc.page.margins.bottom = margins.bottom;
    }
    doc.end();
  });
}
