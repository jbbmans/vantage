import { cn } from '@/lib/utils';
import { formatCell, isRightAligned, printsWide, type ReportChart, type ReportDocument, type ReportFigure, type ReportTable, type ReportColumn } from '../../shared/reportCatalog';

/**
 * One report document, drawn as the PDF draws it (ADR-0020): what it is, about whom, for what period, with which
 * filters, then its figures, charts and tables, and what the figures rest on. The library shows it on screen and the
 * print page prints it. Printed, each table's header repeats on every page it reaches, a row never splits across pages,
 * and the handling line heads and foots every page.
 */
export default function ReportDocumentView({ doc, variant = 'screen' }: { doc: ReportDocument; variant?: 'screen' | 'print' }) {
  const Title = variant === 'print' ? 'h1' : 'h2';
  const Heading = variant === 'print' ? 'h2' : 'h3';
  const fmt = (f: ReportFigure) => formatCell(f.value, f.kind, doc.currency);
  const body = (
    <>
      <header className="report-cover">
        <p className="eyebrow">Vantage · {doc.title}</p>
        <Title id="report-title" className="report-title">{doc.title}</Title>
        <p className="report-about">{doc.about}</p>
        <dl className="report-facts">
          {doc.unit ? <div><dt>Unit</dt><dd>{doc.unit}</dd></div> : null}
          {doc.period ? <div><dt>Period</dt><dd>{doc.period.label}{doc.period.from && doc.period.to ? ` (${doc.period.from} to ${doc.period.to})` : ''}</dd></div> : null}
          <div><dt>Generated</dt><dd>{doc.generated.on} by {doc.generated.by}</dd></div>
        </dl>
        {doc.filters.length ? (
          <div className="report-filters">
            <p className="report-filters-head">Filters</p>
            <dl>{doc.filters.map((f) => <div key={`${f.label}:${f.value}`}><dt>{f.label}</dt><dd>{f.value}</dd></div>)}</dl>
          </div>
        ) : null}
      </header>

      {doc.summary.length ? <Figures list={doc.summary} fmt={fmt} label="Summary" /> : null}

      {doc.sections.map((s) => (
        <section key={s.id} className="report-section" aria-labelledby={`report-${s.id}`}>
          <Heading id={`report-${s.id}`} className="report-heading">{s.heading}</Heading>
          {s.lede ? <p className="report-lede">{s.lede}</p> : null}
          {s.figures?.length ? <Figures list={s.figures} fmt={fmt} label={s.heading} /> : null}
          {s.chart ? <Bars chart={s.chart} currency={doc.currency} /> : null}
          {s.tables.map((t) => <Table key={t.id} table={t} currency={doc.currency} />)}
          {s.notes?.length ? <ul className="report-notes">{s.notes.map((n) => <li key={n}>{n}</li>)}</ul> : null}
        </section>
      ))}

      {doc.notes.length ? (
        <section className="report-section report-about-figures" aria-labelledby="report-about-figures">
          <Heading id="report-about-figures" className="report-heading">About these figures</Heading>
          <ul className="report-notes">{doc.notes.map((n) => <li key={n}>{n}</li>)}</ul>
        </section>
      ) : null}
    </>
  );

  if (variant === 'screen') {
    return (
      <article className="report-doc report-screen" aria-labelledby="report-title">
        <p className="report-marking">{doc.marking}</p>
        {body}
        <p className="report-marking report-marking-foot">{doc.marking}</p>
      </article>
    );
  }
  // A table's header and footer repeat on every printed page it reaches: the frame carries the handling line and the
  // report's name to each page. It lays the page out and holds no data, so it is presentational.
  const running = <p className="report-running"><span>{doc.marking}</span><span>{doc.title} · {doc.about}</span></p>;
  // Wider than the PDF prints portrait, it prints landscape here too.
  const wide = printsWide(doc);
  return (
    <article className={cn('report-doc report-print', wide && 'report-wide')} aria-labelledby="report-title">
      <table className="report-frame" role="presentation">
        <thead><tr><td>{running}</td></tr></thead>
        <tfoot><tr><td><p className="report-running report-running-foot"><span>{doc.marking}</span><span>Generated {doc.generated.on} by {doc.generated.by} in Vantage</span></p></td></tr></tfoot>
        <tbody><tr><td>{body}</td></tr></tbody>
      </table>
    </article>
  );
}

function Figures({ list, fmt, label }: { list: ReportFigure[]; fmt: (f: ReportFigure) => string; label: string }) {
  return (
    <dl className="report-figures" aria-label={label}>
      {list.map((f) => (
        <div key={f.label}>
          <dt>{f.label}</dt>
          <dd className="fig">{fmt(f)}</dd>
          {f.hint ? <dd className="report-hint">{f.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/** Bars with their labels and figures in words: the table beneath holds the same numbers in full. */
function Bars({ chart, currency }: { chart: ReportChart; currency: string }) {
  const bars = chart.bars.slice(0, 30);
  if (bars.length < 2 || !bars.some((b) => b.value)) return null;
  const max = Math.max(...bars.map((b) => Math.abs(b.value)), 1);
  return (
    <figure className="report-chart">
      <figcaption className="report-chart-title">{chart.title}</figcaption>
      <ul>
        {bars.map((b) => (
          <li key={b.label}>
            <span className="report-bar-label">{b.label}</span>
            <span className="report-bar-track" aria-hidden><span className="report-bar" style={{ width: `${b.value ? Math.max(1, (Math.abs(b.value) / max) * 100) : 0}%` }} /></span>
            <span className="report-bar-value fig">{formatCell(b.value, chart.kind, currency)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function Table({ table, currency }: { table: ReportTable; currency: string }) {
  const total = table.columns.reduce((n, c) => n + (c.width || 10), 0);
  return (
    <div className="report-table">
      {table.note ? <p className="report-table-note">{table.note}</p> : null}
      {!table.rows.length ? (
        <><p className="report-table-title">{table.title}</p><p className="report-empty">{table.empty}</p></>
      ) : (
        // A wide table scrolls inside itself on a narrow screen, and the keyboard can reach it to scroll it.
        <div className="report-table-scroll" tabIndex={0} role="region" aria-label={table.title}>
          <table>
            <caption>{table.title}</caption>
            <colgroup>{table.columns.map((c) => <col key={c.key} style={{ width: `${((c.width || 10) / total) * 100}%` }} />)}</colgroup>
            <thead><tr>{table.columns.map((c) => <th key={c.key} scope="col" className={cn(isRightAligned(c.kind) && 'num', c.kind === 'date' && 'date')}>{c.label}</th>)}</tr></thead>
            <tbody>
              {table.rows.map((r, i) => (
                <tr key={i}>{table.columns.map((c) => { const text = formatCell(r[c.key], c.kind, currency); return <td key={c.key} className={cellClass(c, text)}>{text}</td>; })}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {table.total > table.rows.length ? <p className="report-table-note">The first {table.rows.length} of {table.total} rows. Narrow the filters for the rest.</p> : null}
    </div>
  );
}

/**
 * A figure or a date stays on one line and a word is never split; a run of text with no space in it long enough to
 * push the table off the page (a reference, a link) may break anywhere, so nothing is cut off at the page's edge.
 */
const cellClass = (c: ReportColumn, text: string) => cn(isRightAligned(c.kind) && 'num fig', c.kind === 'date' && 'date', /\S{32,}/.test(text) && 'long');
