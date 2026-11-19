import PDFDocument from 'pdfkit';
import { pdfText } from './pdfReport.ts';
import {
  WORKSHEET_COLUMNS, amendmentLine, dayOf, documentBand, signatureNotes,
  type CounselingDocument, type WorksheetBox, type WorksheetSection,
} from '../../shared/counseling.ts';

/**
 * A counseling as the COUNSELING WORKSHEET Marines use (ADR-0033, replacing ADR-0027's look-alike), drawn box for box
 * from the copy in use: the title, the references line, black section bars with upright bold white type, the
 * labelled administrative boxes on the form's eight columns, the billet title, the four narrative sections and the two
 * certification rows. Built from the structured document the server makes from the stored record, never from the
 * screen, and never stored.
 *
 * Every box Vantage has a value for is printed in Courier, as the form is typed. Every box it leaves blank is a PDF form
 * field to type into after downloading (an EDIPI not on its person's profile, date of rank, billet MOS, the period's
 * start, the signature dates, and an empty narrative section), and each signature line is a signature field. No field
 * carries a script, because a PDF with JavaScript in it is refused by many mail and file filters.
 *
 * The form keeps to one page: long narrative sets smaller, down to 7 point, and past that the section runs on to the next
 * page under its bar, marked continued. The handling line is at the top and foot of every page. A last page says what
 * Vantage knows that the form has no box for (a draft or replaced revision, its amendments, a Marine's own notes), only
 * when there is such a thing to say.
 */

const INK = '#000000'; const MUTED = '#4b5563'; const ALERT = '#b91c1c';
const PAGE = { width: 612, height: 792 };
const LEFT = 36;
const WIDTH = PAGE.width - LEFT * 2;
/** Points per unit of the measured form: its eight columns span the printable width. */
const K = WIDTH / WORKSHEET_COLUMNS.reduce((n, c) => n + c, 0);
const EDGES = WORKSHEET_COLUMNS.reduce<number[]>((xs, c) => [...xs, xs[xs.length - 1] + c * K], [LEFT]);
const xOf = (col: number) => EDGES[col];
const wOf = (cols: [number, number]) => EDGES[cols[1]] - EDGES[cols[0]];
/** The form's heights, measured with its columns. */
const H = {
  bar: 17 * K, label: 26.5 * K, valueTall: 37 * K, valueShort: 24 * K, billet: 23 * K, sigLabel: 13 * K, sigBox: 24 * K,
  sections: { accomplishments: 135 * K, evaluation: 175 * K, tasks: 101 * K, comments: 100 * K } as Record<WorksheetSection['key'], number>,
};
const TOP = 30;
const BOTTOM = PAGE.height - 42;
const FORM_TOP = TOP + 38;
const VALUE_SIZE = 10;
const NARRATIVE_SIZES = [9, 8, 7] as const;
const PAD = 4;

/** Courier is monospaced: a line holds a fixed number of characters at a size, so narrative wraps exactly. */
const charsPerLine = (size: number, width: number) => Math.max(10, Math.floor(width / (size * 0.6)));
const lineHeight = (size: number) => size * 1.22;
export function wrapCourier(text: string, max: number): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.replace(/\s+$/, '');
    if (!line) { out.push(''); continue; }
    while (line.length > max) {
      const cut = line.lastIndexOf(' ', max);
      const at = cut > max * 0.4 ? cut : max;
      out.push(line.slice(0, at).replace(/\s+$/, ''));
      line = line.slice(at).replace(/^\s+/, '');
    }
    out.push(line);
  }
  return out;
}
/** A section's lines: each part's label on a line of its own, and a blank line between parts. */
function sectionLines(section: WorksheetSection, size: number): string[] {
  const max = charsPerLine(size, WIDTH - PAD * 2 - 4);
  return section.parts.flatMap((p, i) => [...(i ? [''] : []), ...(p.label ? [`${p.label.toUpperCase()}:`] : []), ...wrapCourier(p.text, max)]);
}
/** A section's box: as tall as the form has it, or, when the form must give room to a long section, as its text needs. */
const sectionHeight = (key: WorksheetSection['key'], lines: number, size: number, tight = false) =>
  Math.max(tight ? Math.min(H.sections[key], lineHeight(size) * 4 + PAD * 2 + 2) : H.sections[key], lines * lineHeight(size) + PAD * 2 + 2);

export function renderCounselingPdf(form: CounselingDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'LETTER', layout: 'portrait', margins: { top: 0, bottom: 0, left: LEFT, right: LEFT }, bufferPages: true,
      info: {
        // Who it is about stays out of the file's properties; it is in the worksheet, under its handling line.
        Title: pdfText(`Counseling worksheet · ${form.type_label}${form.date ? ` · ${form.date}` : ''}`), Author: 'Vantage',
        Subject: 'COUNSELING WORKSHEET (NAVMC 2795)', Keywords: 'counseling',
        // Fixed, so the same revision draws the same file.
        CreationDate: new Date(form.finalized.at || '2000-01-01T00:00:00.000Z'),
      },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));

    // The form's fields are typed in Courier at a fixed size: the form's default ("fit the box") would draw a typed EDIPI
    // as tall as its box. PDFKit writes each field the moment it is made, so what it has no option for (the longest
    // value, the tooltip, the size, a signature field's type) is merged into the field as it is built.
    doc.font('Courier').fontSize(VALUE_SIZE);
    doc.initForm();
    const fontId = () => (doc as unknown as { _font: { id: string } })._font.id;
    const internals = doc as unknown as { _fieldDict: (name: string, type: string | null, options: Record<string, unknown>) => Record<string, unknown> };
    const baseFieldDict = internals._fieldDict.bind(doc);
    internals._fieldDict = (name, type, options) => Object.assign(baseFieldDict(name, type, options), (options.raw as Record<string, unknown> | undefined) ?? {});
    const field = (name: string, x: number, y: number, w: number, h: number, opts: { tooltip: string; maxLength?: number; multiline?: boolean; size?: number }) => {
      doc.font('Courier');
      const raw: Record<string, unknown> = { TU: new String(pdfText(opts.tooltip)), DA: new String(`/${fontId()} ${opts.size ?? VALUE_SIZE} Tf 0 g`) };
      if (opts.maxLength) raw.MaxLen = opts.maxLength;
      doc.formText(name, x, y, w, h, { value: '', multiline: Boolean(opts.multiline), raw });
    };
    const signatureField = (name: string, x: number, y: number, w: number, h: number, tooltip: string) => {
      doc.formAnnotation(name, null as unknown as string, x, y, w, h, { raw: { FT: 'Sig', TU: new String(pdfText(tooltip)) } });
    };

    const rule = (x1: number, y1: number, x2: number, y2: number) => doc.lineWidth(0.75).strokeColor(INK).moveTo(x1, y1).lineTo(x2, y2).stroke();
    const sides = (y1: number, y2: number) => { rule(LEFT, y1, LEFT, y2); rule(LEFT + WIDTH, y1, LEFT + WIDTH, y2); };
    const label = (t: string, x: number, y: number, w: number, size = 7) =>
      doc.font('Helvetica').fontSize(size).fillColor(INK).text(pdfText(t), x, y, { width: w, lineBreak: false, ellipsis: true });
    const value = (t: string, x: number, y: number, w: number) =>
      doc.font('Courier').fontSize(VALUE_SIZE).fillColor(INK).text(pdfText(t), x, y, { width: w, lineBreak: false, ellipsis: true });
    /** A black section bar, its heading in upright bold white type, not italic. */
    const bar = (y: number, heading: string, note?: string) => {
      const top = y + (H.bar - 9.5) / 2 + 0.8;
      doc.rect(LEFT, y, WIDTH, H.bar).fill(INK);
      doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#ffffff').text(pdfText(heading), LEFT + 5, top, { lineBreak: false });
      // The note sits on the heading's baseline, smaller.
      const after = LEFT + 5 + doc.widthOfString(pdfText(heading)) + 3;
      if (note) doc.font('Helvetica').fontSize(6.5).text(pdfText(note), after, top + 2.2, { lineBreak: false });
      doc.fillColor(INK);
      return y + H.bar;
    };

    // One administrative row: its labels, then its boxes on the form's columns
    const adminRow = (y: number, boxes: WorksheetBox[], valueHeight: number) => {
      sides(y, y + H.label + valueHeight);
      for (const b of boxes) {
        const x = xOf(b.cols[0]) + 3;
        if (b.label.length > 1) label(b.label[0], x, y + 2.2, wOf([b.cols[0], 8]) - 4);
        label(b.label[b.label.length - 1], x, y + H.label - 9, wOf(b.cols) - 4);
      }
      const top = y + H.label;
      rule(LEFT, top, LEFT + WIDTH, top);
      for (const b of boxes.slice(1)) rule(xOf(b.cols[0]), top, xOf(b.cols[0]), top + valueHeight);
      for (const b of boxes) {
        const x = xOf(b.cols[0]); const w = wOf(b.cols);
        if (b.fill) field(b.fill.field, x + 1.5, top + 1.5, w - 3, Math.min(valueHeight - 3, 16), { tooltip: b.fill.tooltip, maxLength: b.fill.maxLength });
        else value(b.value, x + 3, top + 6, w - 6);
      }
      const end = top + valueHeight;
      rule(LEFT, end, LEFT + WIDTH, end);
      return end;
    };

    // The narrative's size: the largest at which the whole form keeps to one page with its boxes as the form has
    // them; else the largest at which it does once short sections give their spare room to long ones; else 9 point,
    // running on to the next page
    const sections = form.worksheet.sections;
    const fixed = H.bar + H.label * 3 + H.valueTall * 2 + H.valueShort + H.bar + H.billet + sections.length * H.bar + H.bar + 2 * (H.sigLabel + H.sigBox);
    const fits = ([size, tight]: readonly [number, boolean]) =>
      FORM_TOP + fixed + sections.reduce((n, s) => n + sectionHeight(s.key, sectionLines(s, size).length, size, tight), 0) <= BOTTOM;
    const [size, tight] = [...NARRATIVE_SIZES.map((n) => [n, false] as const), ...NARRATIVE_SIZES.map((n) => [n, true] as const)].find(fits) ?? [NARRATIVE_SIZES[0], false];

    // Title, a band when this is not the final current text, and the references line
    const band = documentBand(form);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text(form.worksheet.title, LEFT, TOP + 2, { width: WIDTH, align: 'center', lineBreak: false });
    if (band) doc.font('Helvetica-Bold').fontSize(7.5).fillColor(ALERT).text(pdfText(band), LEFT, TOP + 20, { width: WIDTH, align: 'right', lineBreak: false, ellipsis: true });
    label(form.worksheet.references, LEFT + 1, FORM_TOP - 9.5, WIDTH * 0.7, 7);

    let y = bar(FORM_TOP, form.worksheet.admin.heading);
    y = adminRow(y, form.worksheet.admin.rows[0], H.valueTall);
    y = adminRow(y, form.worksheet.admin.rows[1], H.valueShort);
    y = adminRow(y, form.worksheet.admin.rows[2], H.valueTall);
    y = bar(y, form.worksheet.billet.heading, form.worksheet.billet.note);
    const billet = form.worksheet.billet.box;
    sides(y, y + H.billet);
    if (billet.fill) field(billet.fill.field, LEFT + 1.5, y + 1.5, WIDTH - 3, H.billet - 3, { tooltip: billet.fill.tooltip });
    else value(billet.value, LEFT + 4, y + (H.billet - VALUE_SIZE) / 2 + 1, WIDTH - 8);
    y += H.billet;
    rule(LEFT, y, LEFT + WIDTH, y);

    // C to F: each section's text under its bar, running on to the next page when it must
    const drawLines = (lines: string[], top: number) => {
      doc.font('Courier').fontSize(size).fillColor(INK);
      lines.forEach((l, n) => { if (l) doc.text(pdfText(l), LEFT + PAD + 2, top + PAD + 1 + n * lineHeight(size), { lineBreak: false }); });
    };
    for (const section of sections) {
      let lines = sectionLines(section, size);
      let heading = section.heading;
      let height = sectionHeight(section.key, lines.length, size, tight);
      while (y + H.bar + height > BOTTOM) {
        const room = Math.floor((BOTTOM - y - H.bar - PAD * 2 - 2) / lineHeight(size));
        if (room < 3) { doc.addPage(); y = FORM_TOP; continue; }
        y = bar(y, heading);
        sides(y, BOTTOM);
        drawLines(lines.slice(0, room), y);
        rule(LEFT, BOTTOM, LEFT + WIDTH, BOTTOM);
        lines = lines.slice(room);
        heading = `${section.heading} (CONTINUED)`;
        height = Math.max(H.sections[section.key] / 2, lines.length * lineHeight(size) + PAD * 2 + 2);
        doc.addPage(); y = FORM_TOP;
      }
      y = bar(y, heading);
      sides(y, y + height);
      if (!section.parts.length) field(`section_${section.key}`, LEFT + 1.5, y + 1.5, WIDTH - 3, height - 3, { tooltip: `${section.heading}: nothing recorded in Vantage. Type here, or write on the printed copy.`, multiline: true, size: 9 });
      else drawLines(lines, y);
      y += height;
      rule(LEFT, y, LEFT + WIDTH, y);
    }

    // G. Certification: two signature lines, each with its date
    if (y + H.bar + 2 * (H.sigLabel + H.sigBox) > BOTTOM) { doc.addPage(); y = FORM_TOP; }
    y = bar(y, form.worksheet.certification.heading);
    for (const row of form.worksheet.certification.rows) {
      sides(y, y + H.sigLabel + H.sigBox);
      label(row.label, LEFT + 4, y + 2.3, xOf(5) - LEFT - 8, 6.8);
      label(row.date.label[0], xOf(5) + 3, y + 2.3, wOf([5, 8]) - 6, 6.8);
      y += H.sigLabel;
      rule(LEFT, y, LEFT + WIDTH, y);
      rule(xOf(5), y, xOf(5), y + H.sigBox);
      signatureField(row.key, LEFT + 1.5, y + 1.5, xOf(5) - LEFT - 3, H.sigBox - 3, `${row.label}: sign here (a CAC digital signature, or by hand on the printed copy).`);
      if (row.date.fill) field(row.date.fill.field, xOf(5) + 1.5, y + 1.5, wOf([5, 8]) - 3, H.sigBox - 3, { tooltip: row.date.fill.tooltip, maxLength: row.date.fill.maxLength });
      else value(row.date.value, xOf(5) + 3, y + 6, wOf([5, 8]) - 6);
      y += H.sigBox;
      rule(LEFT, y, LEFT + WIDTH, y);
    }

    // What the form has no box for, on a page of its own, only when there is something to say. A printed EDIPI is:
    // the copy then holds PII, and its last page says so (ADR-0033)
    if (band || form.amendments.length || form.own_notes || (form.particulars_as_of === 'now' && form.stage === 'final') || form.edipi.reported || form.edipi.senior) {
      const notes = signatureNotes(form);
      doc.addPage();
      let at = TOP + 6;
      const para = (t: string, font: string, sz: number, color = INK, gap = 3) => {
        if (at > BOTTOM - 30) { doc.addPage(); at = TOP + 6; }
        doc.font(font).fontSize(sz).fillColor(color).text(pdfText(t), LEFT, at, { width: WIDTH, lineGap: 1.4 });
        at = doc.y + gap;
      };
      para('About this counseling worksheet', 'Helvetica-Bold', 12, INK, 6);
      if (band) para(band, 'Helvetica-Bold', 9, ALERT, 6);
      para(`Marine reported on: ${notes.subject}`, 'Helvetica', 9);
      para(`Marine performing counseling: ${notes.counselor}`, 'Helvetica', 9, INK, 8);
      if (form.amendments.length) {
        para(`Amendment history (${form.amendments_total})`, 'Helvetica-Bold', 10, INK, 4);
        for (const a of form.amendments) {
          para(amendmentLine(a, form.generated.zone).replace(/ · /g, '  ·  '), 'Helvetica-Bold', 8, MUTED, 1);
          para(`Why: ${a.reason}`, 'Helvetica', 8.5, INK, 4);
        }
        if (form.amendments_total > form.amendments.length) para(`${form.amendments_total - form.amendments.length} earlier amendments are in the record's history.`, 'Helvetica', 8, MUTED, 6);
      }
      for (const note of [...form.notices, form.source]) para(`•  ${note}`, 'Helvetica', 8, MUTED, 2);
    }

    // The handling line at the top and foot of every page, and where the page comes from
    const range = doc.bufferedPageRange();
    const zone = form.generated.zone;
    const status = [
      form.finalized.at ? `finalized ${dayOf(form.finalized.at, zone)}${form.finalized.by ? ` by ${form.finalized.by}` : ''}` : null,
      form.acknowledgement.at ? `acknowledged ${dayOf(form.acknowledgement.at, zone)}` : null,
    ].filter(Boolean).join('  ·  ');
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK).text(pdfText(form.marking), LEFT, 14, { width: WIDTH, align: 'center', lineBreak: false, ellipsis: true });
      const foot = PAGE.height - 34;
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK).text(pdfText(form.marking), LEFT, foot, { width: WIDTH, align: 'center', lineBreak: false, ellipsis: true });
      doc.font('Helvetica').fontSize(6.3).fillColor(MUTED);
      doc.text(pdfText(`Vantage record ${form.id.slice(0, 8)}  ·  revision ${form.revision}${status ? `  ·  ${status}` : ''}  ·  generated ${form.generated.on} by ${form.generated.by}`), LEFT, foot + 11, { width: WIDTH * 0.82, lineBreak: false, ellipsis: true });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, LEFT + WIDTH * 0.82, foot + 11, { width: WIDTH * 0.18, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
