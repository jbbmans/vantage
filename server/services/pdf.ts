import PDFDocument from 'pdfkit';
import type { PackageGroup } from '../../shared/bullets.ts';
import type { Narrative } from '../../shared/narrative.ts';
import type { Metrics } from '../../shared/metrics.ts';
import { formatDollarsExact, formatNumber } from '../../shared/metrics.ts';

export interface ReportPdfInput {
  title: string; subject: string; unitLine: string; period: string; track: string; generatedAt: string;
  narrative: Narrative; pkg: PackageGroup[]; metrics: Metrics; counts: { activities: number; awards: number; trainingHours: number };
  awards?: Array<{ name: string; date: string | null; status: string }>;
  trainings?: Array<{ title: string; date: string | null; hours: number | null }>;
}

const INK = '#111827';
const MUTED = '#6b7280';
const RULE = '#d1d5db';

export function renderReportPdf(input: ReportPdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 54, bottom: 54, left: 54, right: 54 }, info: { Title: input.title, Author: 'Vantage', Subject: input.subject } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const rule = () => { doc.moveDown(0.4); doc.strokeColor(RULE).lineWidth(0.6).moveTo(doc.x, doc.y).lineTo(doc.x + width, doc.y).stroke(); doc.moveDown(0.6); };
    const h2 = (t: string) => { doc.moveDown(0.6); doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(t.toUpperCase(), { characterSpacing: 0.8 }); doc.moveDown(0.25); };
    const body = (t: string, opts: PDFKit.Mixins.TextOptions = {}) => doc.font('Helvetica').fontSize(10).fillColor(INK).text(t, { lineGap: 2.2, ...opts });
    const meta = (t: string) => doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(t);

    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('VANTAGE', { characterSpacing: 2 });
    doc.moveDown(0.2);
    doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(input.title);
    doc.moveDown(0.15);
    body(`${input.subject}${input.unitLine ? `  ·  ${input.unitLine}` : ''}`);
    meta(`${input.period}  ·  ${input.track.toUpperCase()} track  ·  Generated ${input.generatedAt}`);
    rule();

    h2('Summary');
    const m = input.metrics;
    const stats: Array<[string, string]> = [
      ['Activities', formatNumber(input.counts.activities)],
      ['Headline dollar impact', formatDollarsExact(m.totalDollars)],
      ['Reviewed (excluded)', formatDollarsExact(m.reviewedDollars)],
      ['Units processed', formatNumber(m.totalQuantity)],
      ['Entries with outcome', `${input.counts.activities ? Math.round((m.withOutcome / input.counts.activities) * 100) : 0}%`],
      ['Awards in period', formatNumber(input.counts.awards)],
      ['Training hours', formatNumber(input.counts.trainingHours)],
    ];
    const colW = width / 2;
    const startY = doc.y;
    stats.forEach(([label, value], i) => {
      const col = i % 2; const row = Math.floor(i / 2);
      const x = doc.page.margins.left + col * colW; const y = startY + row * 16;
      doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(label, x, y, { width: colW * 0.6, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(9).fillColor(INK).text(value, x + colW * 0.6, y, { width: colW * 0.4 - 8, align: 'right', lineBreak: false });
    });
    doc.x = doc.page.margins.left;
    doc.y = startY + Math.ceil(stats.length / 2) * 16 + 4;

    h2(`${input.track === 'fitrep' ? 'FITREP' : 'JEPES'} narrative input`);
    if (input.narrative.text) {
      body(input.narrative.text, { align: 'left' });
      doc.moveDown(0.2);
      meta(`${input.narrative.length} of ${input.narrative.limit} characters${input.narrative.omitted ? ` · ${input.narrative.omitted} supporting facts withheld for length` : ''}`);
    } else body('No activities were logged in this period.');

    h2('Accomplishments by area');
    for (const group of input.pkg) {
      if (!group.count) continue;
      doc.moveDown(0.3);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(`${group.area}  (${group.count})`);
      if (group.rollup) { doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(MUTED).text(group.rollup, { lineGap: 1.5 }); doc.moveDown(0.15); }
      for (const b of group.bullets) body(`•  ${b.text}`, { indent: 0, paragraphGap: 2 });
      if (group.withheld) meta(`…and ${group.withheld} more not shown at the current limit.`);
    }

    if (input.awards?.length || input.trainings?.length) {
      h2('Career record in period');
      for (const a of input.awards || []) body(`•  ${a.name} (${a.status.replace('_', ' ')}${a.date ? `, ${a.date}` : ''})`);
      for (const t of input.trainings || []) body(`•  ${t.title}${t.hours ? `, ${formatNumber(t.hours)} h` : ''}${t.date ? `, ${t.date}` : ''}`);
    }

    doc.moveDown(1);
    rule();
    meta('Source-backed input prepared in Vantage. Every figure traces to a logged record. Official evaluations are written and recorded by the chain of command on MOL.');
    doc.end();
  });
}
