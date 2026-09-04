import React, { useId, useState } from 'react';
import { cn } from '@/lib/utils';

/** Small, theme-aware SVG charts. No runtime dependency; colors come from CSS variables. */

export interface Point { label: string; value: number; secondary?: number }

export function AreaChart({ data, height = 220, format = (v) => String(v), secondaryLabel, className, ariaLabel }: { data: Point[]; height?: number; format?: (v: number) => string; secondaryLabel?: string; className?: string; ariaLabel: string }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const width = 600;
  const pad = { l: 8, r: 8, t: 16, b: 26 };
  const innerW = width - pad.l - pad.r; const innerH = height - pad.t - pad.b;
  const max = Math.max(1, ...data.map((d) => d.value));
  const maxS = Math.max(1, ...data.map((d) => d.secondary || 0));
  const x = (i: number) => pad.l + (data.length > 1 ? (i / (data.length - 1)) * innerW : innerW / 2);
  const y = (v: number) => pad.t + innerH - (v / max) * innerH;
  const yS = (v: number) => pad.t + innerH - (v / maxS) * innerH;
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join(' ');
  const area = data.length ? `${line} L${x(data.length - 1).toFixed(1)},${(pad.t + innerH).toFixed(1)} L${x(0).toFixed(1)},${(pad.t + innerH).toFixed(1)} Z` : '';
  const lineS = data.some((d) => d.secondary != null) ? data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yS(d.secondary || 0).toFixed(1)}`).join(' ') : null;
  const ticks = [...new Set([0, Math.round(max / 2), max])].map((v) => ({ v, y: y(v) }));
  const step = Math.max(1, Math.ceil(data.length / 6));
  const showLabel = (i: number) => i === data.length - 1 || (i % step === 0 && data.length - 1 - i >= step / 2);
  return (
    <figure className={cn('relative w-full', className)} aria-label={ariaLabel}>
      <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label={ariaLabel} preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)} onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); const px = ((e.clientX - r.left) / r.width) * width; let best = 0; let bd = Infinity; data.forEach((_, i) => { const d = Math.abs(x(i) - px); if (d < bd) { bd = d; best = i; } }); setHover(best); }}>
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="rgb(var(--accent))" stopOpacity="0.28" /><stop offset="100%" stopColor="rgb(var(--accent))" stopOpacity="0.02" /></linearGradient>
        </defs>
        {ticks.map((t) => <g key={t.v}><line x1={pad.l} x2={width - pad.r} y1={t.y} y2={t.y} stroke="rgb(var(--line))" strokeDasharray="2 4" /><text x={pad.l} y={t.y - 4} fontSize="10" fill="rgb(var(--ink-3))">{format(t.v)}</text></g>)}
        {area && <path d={area} fill={`url(#${id}-fill)`} />}
        {line && <path d={line} fill="none" stroke="rgb(var(--accent))" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
        {lineS && <path d={lineS} fill="none" stroke="rgb(var(--ink-3))" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
        {data.map((d, i) => showLabel(i) && <text key={d.label} x={x(i)} y={height - 8} fontSize="10" textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'} fill="rgb(var(--ink-3))">{d.label}</text>)}
        {hover != null && data[hover] && <g><line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + innerH} stroke="rgb(var(--line-strong))" /><circle cx={x(hover)} cy={y(data[hover].value)} r="4.5" fill="rgb(var(--accent))" stroke="rgb(var(--surface))" strokeWidth="2" /></g>}
      </svg>
      {hover != null && data[hover] && (
        <div className="pointer-events-none absolute top-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs shadow-pop" style={{ left: `${Math.min(88, Math.max(0, (x(hover) / width) * 100))}%` }}>
          <p className="font-semibold text-ink">{data[hover].label}</p>
          <p className="text-ink-2">{format(data[hover].value)}</p>
          {data[hover].secondary != null && secondaryLabel && <p className="text-ink-3">{secondaryLabel}: {data[hover].secondary}</p>}
        </div>
      )}
    </figure>
  );
}

export function BarList({ items, format = (v) => String(v), colorFor, className, max: maxProp }: { items: Array<{ label: string; value: number; hint?: string; to?: string }>; format?: (v: number) => string; colorFor?: (label: string) => string | undefined; className?: string; max?: number }) {
  const max = maxProp ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className={cn('space-y-2', className)}>
      {items.map((it) => (
        <li key={it.label} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="flex min-w-0 items-center gap-2 truncate text-ink">{colorFor && <span className="badge-dot" style={{ backgroundColor: colorFor(it.label) }} />}<span className="truncate">{it.label}</span>{it.hint && <span className="truncate text-xs text-ink-3">{it.hint}</span>}</span>
            <span className="fig shrink-0 text-ink-2">{format(it.value)}</span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full" style={{ width: `${Math.max(2, (it.value / max) * 100)}%`, backgroundColor: colorFor?.(it.label) || 'rgb(var(--accent))' }} /></div>
        </li>
      ))}
    </ul>
  );
}

export function Donut({ segments, size = 120, thickness = 14, centerLabel, centerValue, className }: { segments: Array<{ label: string; value: number; color: string }>; size?: number; thickness?: number; centerLabel?: string; centerValue?: string; className?: string }) {
  const total = segments.reduce((n, s) => n + s.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const live = segments.filter((s) => s.value > 0);
  const offsets = live.reduce<number[]>((acc, s, i) => { acc.push(i === 0 ? 0 : acc[i - 1] + (live[i - 1].value / total) * c); return acc; }, []);
  return (
    <div className={cn('flex items-center gap-4', className)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={segments.map((s) => `${s.label} ${Math.round((s.value / total) * 100)}%`).join(', ')}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgb(var(--surface-3))" strokeWidth={thickness} />
        {live.map((s, i) => {
          const len = (s.value / total) * c;
          return <circle key={s.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={thickness} strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offsets[i]} transform={`rotate(-90 ${size / 2} ${size / 2})`} />;
        })}
        {centerValue && <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central" fontSize={size / 6} fontWeight="600" fill="rgb(var(--ink))">{centerValue}</text>}
        {centerLabel && <text x="50%" y={size / 2 + size / 7} textAnchor="middle" fontSize={size / 12} fill="rgb(var(--ink-3))">{centerLabel}</text>}
      </svg>
      <ul className="min-w-0 space-y-1 text-xs">
        {segments.map((s) => <li key={s.label} className="flex items-center gap-2 text-ink-2"><span className="badge-dot" style={{ backgroundColor: s.color }} /><span className="truncate">{s.label}</span><span className="fig ml-auto text-ink-3">{Math.round((s.value / total) * 100)}%</span></li>)}
      </ul>
    </div>
  );
}

export function Sparkline({ values, className, height = 28, width = 90 }: { values: number[]; className?: string; height?: number; width?: number }) {
  if (!values.length) return null;
  const max = Math.max(1, ...values);
  const x = (i: number) => (values.length > 1 ? (i / (values.length - 1)) * width : width / 2);
  const y = (v: number) => height - 2 - (v / max) * (height - 4);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={className} aria-hidden><path d={d} fill="none" stroke="rgb(var(--accent))" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

export function Heatmap({ counts, weeks = 18, className, onSelect }: { counts: Record<string, number>; weeks?: number; className?: string; onSelect?: (day: string) => void }) {
  const today = new Date();
  const start = new Date(today); start.setDate(today.getDate() - (weeks * 7 - 1) - today.getDay());
  const days: string[] = [];
  for (let i = 0; i < weeks * 7 + today.getDay() + 1; i += 1) { const d = new Date(start); d.setDate(start.getDate() + i); if (d > today) break; days.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); }
  const max = Math.max(1, ...Object.values(counts));
  return (
    <div className={cn('grid grid-flow-col gap-[3px]', className)} style={{ gridTemplateRows: 'repeat(7, minmax(0, 1fr))' }} role="group" aria-label="Activity by day">
      {days.map((day) => {
        const n = counts[day] || 0;
        const level = n === 0 ? 0 : Math.ceil((n / max) * 4);
        return <button key={day} type="button" title={`${day}: ${n}`} onClick={() => onSelect?.(day)} className="h-3 w-3 rounded-[3px] transition-transform hover:scale-125" style={{ backgroundColor: level === 0 ? 'rgb(var(--surface-3))' : `rgb(var(--accent) / ${0.25 + level * 0.19})` }} aria-label={`${day}: ${n} entries`} />;
      })}
    </div>
  );
}
