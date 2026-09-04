/**
 * The analysis as a working paper: cover block, executive summary, trend, composition, concentration, consistency,
 * coverage, goals, career, narrative and bullets, and a full entry ledger as the appendix. Drawn with pdfkit primitives
 * so it needs no browser; every table repeats its header across page breaks and every page carries a running footer.
 */
import PDFDocument from 'pdfkit';
import type { AnalysisReport } from './analytics.ts';
import type { Narrative } from '../../shared/narrative.ts';
import type { PackageGroup } from '../../shared/bullets.ts';
import { formatDollars, formatDollarsExact, formatNumber } from '../../shared/metrics.ts';
import type { Movement } from '../../shared/delta.ts';
import { drawMark } from '../lib/pdfMark.ts';

const INK = '#111827'; const INK2 = '#4b5563'; const MUTED = '#6b7280'; const RULE = '#d1d5db'; const SOFT = '#f3f4f6'; const ACCENT = '#9f1d22';

interface Col { label: string; width: number; align?: 'left' | 'right'; key: string }

export interface AnalysisPdfInput { report: AnalysisReport; narrative?: Narrative; pkg?: PackageGroup[]; classification?: string }

export function renderAnalysisPdf(input: AnalysisPdfInput): Promise<Buffer> {
  const { report: r } = input;
  const money = (n: number) => formatDollarsExact(n, r.metricsConfig.currency_symbol);
  const moneyShort = (n: number) => formatDollars(n, r.metricsConfig.currency_symbol);
  const fmt = (n: number, kind: 'number' | 'money' | 'percent' | 'hours') => (kind === 'money' ? money(n) : kind === 'percent' ? `${formatNumber(n)}%` : kind === 'hours' ? `${formatNumber(n)} h` : formatNumber(n));
  const delta = (m: Movement, kind: 'number' | 'money' | 'percent' | 'hours' = 'number') => {
    const sign = m.diff > 0 ? '+' : m.diff < 0 ? '-' : '';
    const abs = Math.abs(m.diff);
    const p = m.pct == null ? (m.isNew ? 'new' : 'n/a') : `${m.pct > 0 ? '+' : ''}${m.pct}%`;
    return `${sign}${kind === 'money' ? moneyShort(abs) : kind === 'percent' ? `${formatNumber(abs)} pt` : formatNumber(abs)} (${p})`;
  };

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 60, bottom: 60, left: 54, right: 54 }, bufferPages: true, info: { Title: `Performance analysis · ${r.subject} · ${r.label}`, Author: 'Vantage', Subject: r.subject } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    const left = doc.page.margins.left; const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom;
    const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };

    const h1 = (n: string, t: string) => { ensure(60); doc.moveDown(0.8); doc.font('Helvetica-Bold').fontSize(8).fillColor(ACCENT).text(n.toUpperCase(), { characterSpacing: 1.5 }); doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(t); doc.moveDown(0.3); };
    const h2 = (t: string) => { ensure(40); doc.moveDown(0.5); doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(t); doc.moveDown(0.15); };
    const p = (t: string, color = INK2, size = 9.5) => { doc.font('Helvetica').fontSize(size).fillColor(color).text(t, { lineGap: 2 }); };
    const rule = () => { doc.moveDown(0.3); doc.strokeColor(RULE).lineWidth(0.6).moveTo(left, doc.y).lineTo(left + width, doc.y).stroke(); doc.moveDown(0.5); };

    const fit = (text: string, w: number) => {
      if (doc.widthOfString(text) <= w) return text;
      let t = text;
      while (t.length > 1 && doc.widthOfString(`${t}…`) > w) t = t.slice(0, -1);
      return `${t.trimEnd()}…`;
    };
    function table(cols: Col[], rows: Array<Record<string, unknown>>, opts: { zebra?: boolean; size?: number; emptyText?: string } = {}) {
      const size = opts.size ?? 8.5; const rowH = size + 7;
      const total = cols.reduce((n, c) => n + c.width, 0);
      const scaled = cols.map((c) => ({ ...c, width: (c.width / total) * width }));
      const header = () => {
        ensure(rowH * 2);
        let x = left; const y = doc.y;
        doc.rect(left, y, width, rowH).fill(SOFT);
        for (const c of scaled) { doc.font('Helvetica-Bold').fontSize(size - 0.5).fillColor(INK2); doc.text(fit(c.label.toUpperCase(), c.width - 8), x + 4, y + 3.5, { width: c.width - 8, align: c.align || 'left', lineBreak: false, characterSpacing: 0.4 }); x += c.width; }
        doc.y = y + rowH;
      };
      if (!rows.length) { p(opts.emptyText || 'Nothing in this period.', MUTED, 9); doc.x = left; return; }
      header();
      rows.forEach((row, i) => {
        if (doc.y + rowH > bottom()) { doc.addPage(); header(); }
        let x = left; const y = doc.y;
        if (opts.zebra && i % 2 === 1) doc.rect(left, y, width, rowH).fill('#fafafa');
        for (const c of scaled) { const v = row[c.key]; doc.font('Helvetica').fontSize(size).fillColor(INK); doc.text(fit(v == null || v === '' ? '—' : String(v), c.width - 8), x + 4, y + 3.5, { width: c.width - 8, align: c.align || 'left', lineBreak: false }); x += c.width; }
        doc.y = y + rowH;
      });
      doc.x = left; doc.moveDown(0.4);
    }

    function bars(series: Array<{ label: string; value: number }>, opts: { height?: number; format?: (v: number) => string; color?: string }) {
      const height = opts.height ?? 90; const format = opts.format ?? ((v: number) => formatNumber(v));
      ensure(height + 30);
      const top = doc.y; const max = Math.max(1, ...series.map((s) => s.value));
      const gap = 6; const bw = Math.min(64, Math.max(4, (width - gap * (series.length - 1)) / Math.max(1, series.length)));
      series.forEach((s, i) => {
        const x = left + i * (bw + gap); const h = (s.value / max) * (height - 18); const y = top + (height - 18) - h;
        doc.rect(x, y, bw, Math.max(h, s.value ? 1 : 0)).fill(opts.color || ACCENT);
        if (s.value) doc.font('Helvetica').fontSize(6.5).fillColor(INK2).text(format(s.value), x - 4, y - 8, { width: bw + 8, align: 'center', lineBreak: false });
        doc.font('Helvetica').fontSize(6.5).fillColor(MUTED).text(s.label, x - 4, top + height - 14, { width: bw + 8, align: 'center', lineBreak: false });
      });
      doc.strokeColor(RULE).lineWidth(0.5).moveTo(left, top + height - 18).lineTo(left + width, top + height - 18).stroke();
      doc.x = left; doc.y = top + height + 4;
    }

    // ---- Cover block
    drawMark(doc, left + width - 40, doc.y - 6, 40);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text('VANTAGE  ·  PERFORMANCE ANALYSIS', left, doc.y, { characterSpacing: 2, width: width - 56 });
    doc.moveDown(0.3);
    doc.font('Helvetica-Bold').fontSize(22).fillColor(INK).text(r.subject || 'Performance record');
    doc.moveDown(0.1);
    p(`${r.unit ? `${r.unit.short_name || r.unit.name}  ·  ` : ''}${r.person?.mos ? `MOS ${r.person.mos}  ·  ` : ''}${r.track.toUpperCase()} track`, INK2, 10);
    p(`Period ${r.period.label} (${r.period.from} to ${r.period.to})  ·  compared with ${r.prior.from} to ${r.prior.to}  ·  generated ${r.generatedAt}`, MUTED, 8.5);
    rule();

    // ---- 1 Executive summary
    h1('1', 'Executive summary');
    for (const s of r.summary) { doc.font('Helvetica').fontSize(9.5).fillColor(INK).text(`•  ${s}`, { lineGap: 2, paragraphGap: 2 }); }
    doc.moveDown(0.4);
    table([
      { key: 'label', label: 'Metric', width: 34 }, { key: 'value', label: 'Current', width: 18, align: 'right' }, { key: 'prior', label: 'Prior period', width: 18, align: 'right' }, { key: 'delta', label: 'Change', width: 30, align: 'right' },
    ], r.kpis.map((k) => ({ label: k.label, value: fmt(k.value, k.format), prior: fmt(k.prior, k.format), delta: delta(k.movement, k.format) })), { zebra: true });
    if (r.runRate.projectedEntries != null) p(`Pace: ${Math.round((r.runRate.elapsedFraction || 0) * 100)}% of the period elapsed; ${r.runRate.entriesPerWeek} entries and ${moneyShort(r.runRate.valuePerWeek)} per week (prior ${r.runRate.priorEntriesPerWeek} and ${moneyShort(r.runRate.priorValuePerWeek)}). Straight-line projection: ${formatNumber(r.runRate.projectedEntries)} entries${r.runRate.projectedValue ? ` and ${moneyShort(r.runRate.projectedValue)}` : ''} by period end.`, INK2, 9);
    else p(`Run rate: ${r.runRate.entriesPerWeek} entries and ${moneyShort(r.runRate.valuePerWeek)} per week over ${r.runRate.weeks} weeks (prior period ${r.runRate.priorEntriesPerWeek} and ${moneyShort(r.runRate.priorValuePerWeek)}).`, INK2, 9);

    // ---- 2 Trend
    h1('2', 'Activity trend');
    if (r.monthly.length > 1) {
      h2('Entries per month');
      bars(r.monthly.map((m) => ({ label: m.label, value: m.entries })), { height: 90 });
      if (r.monthly.some((m) => m.value)) { h2(`Headline ${r.metricsConfig.currency_label.toLowerCase()} per month`); bars(r.monthly.map((m) => ({ label: m.label, value: m.value })), { height: 90, format: moneyShort, color: '#374151' }); }
    }
    table([
      { key: 'label', label: 'Month', width: 18 }, { key: 'entries', label: 'Entries', width: 14, align: 'right' }, { key: 'value', label: r.metricsConfig.currency_label, width: 22, align: 'right' }, { key: 'quantity', label: 'Actions', width: 16, align: 'right' }, { key: 'withOutcome', label: 'With outcome', width: 18, align: 'right' },
    ], r.monthly.map((m) => ({ label: m.label, entries: m.entries, value: money(m.value), quantity: formatNumber(m.quantity), withOutcome: `${m.withOutcome} (${m.entries ? Math.round((m.withOutcome / m.entries) * 100) : 0}%)` })), { zebra: true });

    // ---- 3 Composition
    h1('3', 'Composition');
    h2(`By ${r.track === 'fitrep' ? 'FITREP section' : 'JEPES area'}`);
    table([{ key: 'name', label: 'Area', width: 34 }, { key: 'entries', label: 'Entries', width: 12, align: 'right' }, { key: 'share', label: 'Share', width: 12, align: 'right' }, { key: 'value', label: r.metricsConfig.currency_label, width: 18, align: 'right' }, { key: 'outcome', label: 'Outcome', width: 12, align: 'right' }, { key: 'delta', label: 'vs prior', width: 12, align: 'right' }],
      r.byArea.map((a) => ({ name: a.name, entries: a.entries, share: `${a.share}%`, value: money(a.value), outcome: `${a.outcomeRate}%`, delta: delta(a.movement) })), { zebra: true });
    h2('By category');
    table([{ key: 'name', label: 'Category', width: 34 }, { key: 'entries', label: 'Entries', width: 12, align: 'right' }, { key: 'share', label: 'Share', width: 12, align: 'right' }, { key: 'value', label: r.metricsConfig.currency_label, width: 18, align: 'right' }, { key: 'quantity', label: 'Actions', width: 12, align: 'right' }, { key: 'delta', label: 'vs prior', width: 12, align: 'right' }],
      r.byCategory.filter((c) => c.entries || c.priorEntries).map((c) => ({ name: c.name, entries: c.entries, share: `${c.share}%`, value: money(c.value), quantity: formatNumber(c.quantity), delta: delta(c.movement) })), { zebra: true });
    h2(`${r.metricsConfig.currency_label} by value type`);
    table([{ key: 'label', label: 'Type', width: 24 }, { key: 'headline', label: 'Headline', width: 12 }, { key: 'entries', label: 'Entries', width: 10, align: 'right' }, { key: 'amount', label: 'Amount', width: 22, align: 'right' }, { key: 'share', label: 'Share', width: 10, align: 'right' }, { key: 'delta', label: 'vs prior', width: 22, align: 'right' }],
      r.byValueType.map((t) => ({ label: t.label, headline: t.summable ? 'yes' : 'separate', entries: t.entries, amount: money(t.amount), share: `${t.share}%`, delta: delta(t.movement, 'money') })), { zebra: true, emptyText: `No ${r.metricsConfig.currency_label.toLowerCase()} recorded in this period.` });
    if (r.bySystem.length || r.byOrganization.length || r.byUnitLabel.length) {
      h2('Systems, organizations, and units of work');
      table([{ key: 'kind', label: 'Kind', width: 14 }, { key: 'name', label: 'Name', width: 40 }, { key: 'entries', label: 'Entries', width: 12, align: 'right' }, { key: 'value', label: r.metricsConfig.currency_label, width: 18, align: 'right' }, { key: 'quantity', label: 'Actions', width: 16, align: 'right' }],
        [...r.bySystem.map((s) => ({ kind: 'System', name: s.name, entries: s.entries, value: money(s.value), quantity: formatNumber(s.quantity) })), ...r.byOrganization.map((s) => ({ kind: 'Organization', name: s.name, entries: s.entries, value: money(s.value), quantity: formatNumber(s.quantity) })), ...r.byUnitLabel.map((u) => ({ kind: 'Unit of work', name: u.unit, entries: u.entries, value: '', quantity: `${formatNumber(u.total)} (${delta(u.movement)})` }))], { zebra: true });
    }

    // ---- 4 Concentration and consistency
    h1('4', 'Concentration and consistency');
    p(`${r.concentration.entriesWithValue} entries carry headline ${r.metricsConfig.currency_label.toLowerCase()}. The largest is ${r.concentration.largestValueShare}% of the total and the top three are ${r.concentration.top3ValueShare}%; concentration index ${formatNumber(r.concentration.hhi)} (10,000 = a single entry).`, INK2, 9);
    h2(`Largest entries by ${r.metricsConfig.currency_label.toLowerCase()}`);
    table([{ key: 'date', label: 'Date', width: 12 }, { key: 'title', label: 'Entry', width: 46 }, { key: 'value_type', label: 'Type', width: 14 }, { key: 'value', label: 'Amount', width: 16, align: 'right' }, { key: 'share', label: 'Share', width: 12, align: 'right' }],
      r.concentration.topByValue.map((e) => ({ date: e.date, title: e.title, value_type: e.value_type, value: money(e.value || 0), share: `${r.kpis[1].value ? Math.round(((e.value || 0) / r.kpis[1].value) * 100) : 0}%` })), { zebra: true });
    h2('Largest entries by actions counted');
    table([{ key: 'date', label: 'Date', width: 12 }, { key: 'title', label: 'Entry', width: 52 }, { key: 'quantity', label: 'Count', width: 16, align: 'right' }, { key: 'unit_label', label: 'Unit', width: 20 }],
      r.concentration.topByQuantity.map((e) => ({ date: e.date, title: e.title, quantity: formatNumber(e.quantity || 0), unit_label: e.unit_label })), { zebra: true });
    h2('Logging cadence');
    table([{ key: 'k', label: 'Measure', width: 50 }, { key: 'v', label: 'Value', width: 50, align: 'right' }], [
      { k: 'Active days (days with at least one entry)', v: `${r.consistency.activeDays} of ${r.consistency.spanDays}` },
      { k: 'Entries per active day', v: r.consistency.entriesPerActiveDay },
      { k: 'Weeks with no entry', v: `${r.consistency.zeroWeeks} of ${r.consistency.weeks}` },
      { k: 'Longest gap without an entry', v: `${r.consistency.longestGapDays} days` },
      { k: 'Mean entries per week (standard deviation)', v: `${r.consistency.meanPerWeek} (${r.consistency.stdevPerWeek})` },
      { k: 'Busiest week', v: r.consistency.busiestWeek ? `week of ${r.consistency.busiestWeek.week}: ${r.consistency.busiestWeek.entries} entries` : '—' },
    ]);

    // ---- 5 Coverage and data quality
    h1('5', 'Coverage and data quality');
    table([{ key: 'label', label: 'Field', width: 50 }, { key: 'count', label: 'Entries', width: 20, align: 'right' }, { key: 'pct', label: 'Coverage', width: 30, align: 'right' }], r.coverage.fields.map((f) => ({ label: f.label, count: f.count, pct: `${f.pct}%` })), { zebra: true });
    p(`Average completeness ${r.coverage.avgStrength} of 5 (${r.coverage.strengthDistribution.map((s) => `${s.count} at ${s.strength}`).join(', ')}).${r.coverage.emptyAreas.length ? ` No entries under ${r.coverage.emptyAreas.join(', ')}.` : ''}${r.coverage.unusedCategories.length ? ` Unused categories: ${r.coverage.unusedCategories.join(', ')}.` : ''}${r.coverage.planned ? ` ${r.coverage.planned} planned entries are excluded from every figure above.` : ''}`, INK2, 9);
    if (r.quality.length) { h2('Open issues'); for (const q of r.quality) p(`•  ${q.count} ${q.label}: ${q.detail}`, INK2, 9); }

    // ---- 6 Goals
    h1('6', 'Goals');
    p(`${r.goals.total} goals in scope: ${r.goals.active} active, ${r.goals.achieved} achieved, ${r.goals.missed} missed, ${r.goals.paused} paused. Attainment on closed goals ${r.goals.attainment}%.`, INK2, 9);
    table([{ key: 'title', label: 'Goal', width: 44 }, { key: 'status', label: 'Status', width: 14 }, { key: 'progress', label: 'Progress', width: 26, align: 'right' }, { key: 'period_end', label: 'Due', width: 16 }],
      r.goals.items.map((g) => ({ title: g.title, status: g.status, progress: `${formatNumber(g.current)} / ${formatNumber(g.target)}${g.unit_label ? ` ${g.unit_label}` : ''} (${g.pct}%)`, period_end: g.period_end })), { zebra: true, emptyText: 'No goals in this period.' });

    // ---- 7 Career
    h1('7', 'Career record');
    p(`${formatNumber(r.career.trainingHours)} training hours (prior ${formatNumber(r.career.priorTrainingHours)})${r.career.hoursByType.length ? `: ${r.career.hoursByType.map((t) => `${t.type} ${formatNumber(t.hours)} h`).join(', ')}` : ''}. ${r.career.awards.length} awards (prior ${r.career.priorAwards})${r.career.awardsByStatus.length ? `: ${r.career.awardsByStatus.map((a) => `${a.count} ${a.status}`).join(', ')}` : ''}. ${r.career.counselings.count} counselings${r.career.counselings.lastDate ? `, last on ${r.career.counselings.lastDate}` : ''}${r.career.counselings.avgIntervalDays ? `, every ${r.career.counselings.avgIntervalDays} days on average` : ''}${r.career.counselings.unacknowledged ? `, ${r.career.counselings.unacknowledged} not acknowledged` : ''}.`, INK2, 9);
    if (r.career.trainings.length) { h2('Training'); table([{ key: 'date', label: 'Date', width: 14 }, { key: 'title', label: 'Title', width: 50 }, { key: 'type', label: 'Type', width: 16 }, { key: 'hours', label: 'Hours', width: 10, align: 'right' }, { key: 'status', label: 'Status', width: 10 }], r.career.trainings.map((t) => ({ date: t.date, title: t.title, type: t.type, hours: t.hours == null ? '' : formatNumber(t.hours), status: t.status })), { zebra: true }); }
    if (r.career.awards.length) { h2('Awards and recognition'); table([{ key: 'date', label: 'Date', width: 14 }, { key: 'name', label: 'Award', width: 56 }, { key: 'type', label: 'Type', width: 16 }, { key: 'status', label: 'Status', width: 14 }], r.career.awards.map((a) => ({ date: a.date, name: a.name, type: a.type, status: a.status })), { zebra: true }); }

    // ---- 8 Narrative and bullets
    if (input.narrative || input.pkg) {
      h1('8', `${r.track === 'fitrep' ? 'FITREP' : 'JEPES'} narrative and bullet package`);
      if (input.narrative?.text) { doc.font('Courier').fontSize(9).fillColor(INK).text(input.narrative.text, { lineGap: 2 }); p(`${input.narrative.length} of ${input.narrative.limit} characters.`, MUTED, 8); }
      for (const g of input.pkg || []) { if (!g.count) continue; h2(`${g.area} (${g.count})`); if (g.rollup) p(g.rollup, INK2, 9); for (const b of g.bullets) doc.font('Helvetica').fontSize(9).fillColor(INK).text(`•  ${b.text}`, { lineGap: 1.5, paragraphGap: 1.5 }); }
    }

    // ---- Appendix
    h1('Appendix A', 'Entry ledger');
    p(`Every completed entry in ${r.period.label}, newest first. Completeness scores 1 to 5.`, MUTED, 8.5);
    table([{ key: 'date', label: 'Date', width: 12 }, { key: 'title', label: 'Entry', width: 30 }, { key: 'area', label: 'Area', width: 15 }, { key: 'category', label: 'Category', width: 13 }, { key: 'qty', label: 'Count', width: 11, align: 'right' }, { key: 'value', label: r.metricsConfig.currency_label, width: 12, align: 'right' }, { key: 'result', label: 'Outcome', width: 20 }, { key: 'strength', label: 'Score', width: 7, align: 'right' }],
      r.appendix.map((e) => ({ date: e.date, title: e.title, area: e.area, category: e.category, qty: e.quantity == null ? '' : `${formatNumber(e.quantity)}${e.unit_label ? ` ${e.unit_label}` : ''}`, value: e.value == null ? '' : `${moneyShort(e.value)}${e.value_type ? ` ${e.value_type[0]}` : ''}`, result: e.result, strength: e.strength })), { zebra: true, size: 7.5, emptyText: 'No entries in this period.' });

    // ---- Footer on every page
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0; // footer text sits inside the margin; without this pdfkit would open a new page for it
      const y = doc.page.height - 40;
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
      doc.text(`${input.classification || 'Working paper'}  ·  ${r.subject}  ·  ${r.period.label}`, left, y, { width: width * 0.7, lineBreak: false });
      doc.text(`Page ${i - range.start + 1} of ${range.count}`, left + width * 0.7, y, { width: width * 0.3, align: 'right', lineBreak: false });
      doc.text('Source-backed analysis prepared in Vantage. Every figure traces to a logged record. Official evaluations are written and recorded by the chain of command on MOL.', left, y + 10, { width, lineBreak: false, ellipsis: true });
    }
    doc.end();
  });
}
