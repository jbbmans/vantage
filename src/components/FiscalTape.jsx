import React, { useMemo, useState } from 'react';
import { eachDayOfInterval, format, differenceInCalendarDays } from 'date-fns';
import { fiscalYearRange, dailyCounts, dayKey, formatDTG } from '@/lib/metrics';
import { cn } from '@/lib/utils';

export default function FiscalTape({ activities = [], asOf = new Date(), onSelectDay, className }) {
  const [hover, setHover] = useState(null);

  const { days, counts, max, range, todayIndex, quarters } = useMemo(() => {
    const r = fiscalYearRange(asOf);
    const d = eachDayOfInterval({ start: r.start, end: r.end });
    const c = dailyCounts(activities, r);
    const m = Math.max(1, ...Object.values(c));
    const ti = differenceInCalendarDays(asOf, r.start);

    const q = [];
    for (let i = 0; i < 4; i++) {
      const startMonth = new Date(r.start.getFullYear(), r.start.getMonth() + i * 3, 1);
      q.push({
        index: differenceInCalendarDays(startMonth, r.start),
        label: `Q${i + 1}`,
        month: format(startMonth, 'MMM').toUpperCase(),
      });
    }
    return { days: d, counts: c, max: m, range: r, todayIndex: ti, quarters: q };
  }, [activities, asOf]);

  const total = days.length;
  const pct = (i) => (i / total) * 100;

  const level = (n) => (!n ? 0 : Math.min(4, Math.ceil((n / max) * 4)));
  const FILLS = ['var(--tape-0)', 'var(--tape-1)', 'var(--tape-2)', 'var(--tape-3)', 'var(--tape-4)'];

  const activeDays = Object.values(counts).filter(Boolean).length;
  const logged = Object.values(counts).reduce((s, n) => s + n, 0);
  const elapsed = Math.max(1, todayIndex + 1);

  return (
    <div
      className={cn('relative select-none', className)}
      style={{
        '--tape-0': 'rgb(var(--rule) / .55)',
        '--tape-1': 'rgb(var(--signal) / .3)',
        '--tape-2': 'rgb(var(--signal) / .52)',
        '--tape-3': 'rgb(var(--signal) / .76)',
        '--tape-4': 'rgb(var(--signal))',
      }}
    >

      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-baseline gap-2">
          <span className="eyebrow">Fiscal Tape</span>
          <span className="fig text-2xs text-text-3">
            {format(range.start, 'dd MMM yy').toUpperCase()} — {format(range.end, 'dd MMM yy').toUpperCase()}
          </span>
        </div>
        <div className="fig flex items-center gap-3 text-2xs text-text-3">
          <span>
            <span className="text-text">{logged}</span> logged
          </span>
          <span>
            <span className="text-text">{activeDays}</span>/{elapsed} days active
          </span>
          <span>
            <span className="text-text">{Math.round((activeDays / elapsed) * 100)}%</span> coverage
          </span>
        </div>
      </div>

      <div className="relative h-tape rounded border border-rule bg-panel">
        <svg
          viewBox={`0 0 ${total} 40`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          role="img"
          aria-label={`Activity across ${range.label}: ${logged} activities on ${activeDays} days`}
        >
          {days.map((d, i) => {
            const n = counts[dayKey(d)] || 0;
            const lv = level(n);
            const future = i > todayIndex;
            const h = n ? 6 + (lv / 4) * 28 : 3;
            return (
              <rect
                key={i}
                x={i + 0.15}
                y={(40 - h) / 2}
                width={0.7}
                height={h}
                fill={future ? 'rgb(var(--rule) / .3)' : FILLS[lv]}
                onMouseEnter={() => setHover({ i, d, n })}
                onMouseLeave={() => setHover(null)}
                onClick={() => onSelectDay?.(d)}
                style={{ cursor: onSelectDay ? 'pointer' : 'default' }}
              />
            );
          })}

          {quarters.slice(1).map((q) => (
            <rect key={q.label} x={q.index} y={0} width={0.5} height={40} fill="rgb(var(--rule-strong))" />
          ))}
        </svg>

        {todayIndex >= 0 && todayIndex < total && (
          <div
            className="pointer-events-none absolute top-0 h-full"
            style={{ left: `${pct(todayIndex + 0.5)}%` }}
          >
            <div className="absolute -left-px h-full w-0.5 bg-signal" />
            <div
              className="absolute -left-[3px] -top-[3px] h-0 w-0 animate-blink border-x-[4px] border-t-[5px] border-x-transparent"
              style={{ borderTopColor: 'rgb(var(--signal))' }}
            />
          </div>
        )}

        {hover && (
          <div
            className="pointer-events-none absolute -top-8 z-10 -translate-x-1/2 whitespace-nowrap rounded border border-rule-strong bg-panel px-1.5 py-0.5 shadow-[var(--shadow)]"
            style={{ left: `${Math.min(94, Math.max(6, pct(hover.i + 0.5)))}%` }}
          >
            <span className="fig text-2xs text-text">
              {formatDTG(hover.d)} · {hover.n || 'nothing'}
              {hover.n ? (hover.n === 1 ? ' activity' : ' activities') : ''}
            </span>
          </div>
        )}
      </div>

      <div className="relative mt-1 h-3">
        {quarters.map((q, i) => {
          const isCurrent = todayIndex >= q.index && (i === 3 || todayIndex < quarters[i + 1].index);
          return (
            <span
              key={q.label}
              className={cn(
                'fig absolute text-2xs tracking-widest',
                isCurrent ? 'text-signal' : 'text-text-3'
              )}
              style={{ left: `${pct(q.index)}%` }}
            >
              {q.label} <span className="text-text-3">{q.month}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function TapeStrip({ activities = [], className }) {
  const { days, counts, max, todayIndex } = useMemo(() => {
    const r = fiscalYearRange(new Date());
    const d = eachDayOfInterval({ start: r.start, end: r.end });
    const c = dailyCounts(activities, r);
    return {
      days: d,
      counts: c,
      max: Math.max(1, ...Object.values(c)),
      todayIndex: differenceInCalendarDays(new Date(), r.start),
    };
  }, [activities]);

  return (
    <svg viewBox={`0 0 ${days.length} 10`} preserveAspectRatio="none" className={cn('h-2.5 w-full', className)} aria-hidden>
      {days.map((d, i) => {
        const n = counts[dayKey(d)] || 0;
        if (i > todayIndex) return null;
        const h = n ? 3 + Math.min(7, (n / max) * 7) : 1;
        return (
          <rect
            key={i}
            x={i + 0.2}
            y={(10 - h) / 2}
            width={0.6}
            height={h}
            fill={n ? 'rgb(var(--signal) / .8)' : 'rgb(var(--rule))'}
          />
        );
      })}
    </svg>
  );
}
