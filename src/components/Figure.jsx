import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, TrendingDown, TrendingUp, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Count up to the value on mount. Short and once — this is a ledger, not a slot machine. */
function useRollup(target, enabled = true) {
  const [value, setValue] = useState(enabled ? 0 : target);
  const raf = useRef();
  useEffect(() => {
    if (!enabled || typeof target !== 'number' || !Number.isFinite(target)) {
      setValue(target);
      return;
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setValue(target);
      return;
    }
    const start = performance.now();
    const duration = 380;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(target * eased);
      if (t < 1) raf.current = requestAnimationFrame(tick);
      else setValue(target);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, enabled]);
  return value;
}

/**
 * The primary figure display. Label above, number below, delta beneath.
 * Figures are always monospaced so a column of them lines up on the decimal.
 */
export function Figure({
  label,
  value,
  raw,
  sub,
  delta,
  deltaLabel = 'vs prior',
  to,
  tone = 'default',
  size = 'md',
  formatFn,
  className,
}) {
  const animate = typeof raw === 'number' && Number.isFinite(raw);
  const animated = useRollup(animate ? raw : 0, animate);
  const display = animate && formatFn ? formatFn(animated) : value;

  const sizes = {
    sm: 'text-xl',
    md: 'text-2xl',
    lg: 'text-3xl',
  };
  const tones = {
    default: 'text-text',
    signal: 'text-signal',
    ledger: 'text-ledger',
    redline: 'text-redline',
  };

  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="eyebrow">{label}</span>
        {to && <ArrowUpRight className="h-3 w-3 shrink-0 text-text-3 transition-colors group-hover:text-signal" />}
      </div>
      <p className={cn('fig mt-1.5 font-medium leading-none', sizes[size], tones[tone])}>{display}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        {delta !== undefined && delta !== null && <Delta value={delta} label={deltaLabel} />}
        {sub && <span className="truncate text-xs text-text-3">{sub}</span>}
      </div>
    </>
  );

  const classes = cn(
    'group block min-w-0 border-r border-rule px-3.5 py-3 last:border-r-0 transition-colors',
    to && 'hover:bg-panel-2',
    className
  );

  return to ? (
    <Link to={to} className={classes}>
      {body}
    </Link>
  ) : (
    <div className={classes}>{body}</div>
  );
}

export function Delta({ value, label }) {
  if (value === null) {
    return (
      <span className="fig inline-flex items-center gap-1 text-2xs text-text-3">
        <Minus className="h-2.5 w-2.5" />
        new
      </span>
    );
  }
  const flat = value === 0;
  const up = value > 0;
  const Icon = flat ? Minus : up ? TrendingUp : TrendingDown;
  return (
    <span
      className={cn(
        'fig inline-flex items-center gap-1 text-2xs',
        flat ? 'text-text-3' : up ? 'text-ledger' : 'text-redline'
      )}
    >
      <Icon className="h-2.5 w-2.5" />
      {up && !flat ? '+' : ''}
      {value}%{label && <span className="text-text-3">{label}</span>}
    </span>
  );
}

/** A row of figures separated by hairlines rather than gaps between cards. */
export function FigureRow({ children, className }) {
  return (
    <div className={cn('panel grid grid-cols-2 rounded md:grid-cols-4', className)}>{children}</div>
  );
}

/** Inline sparkline. No axes, no grid, no tooltip — it is a texture, not a chart. */
export function Sparkline({ data = [], width = 120, height = 26, className, tone = 'signal' }) {
  if (!data.length) return null;
  const values = data.map((d) => (typeof d === 'number' ? d : d.count || 0));
  const max = Math.max(1, ...values);
  const step = width / Math.max(1, values.length - 1);
  const points = values.map((v, i) => [i * step, height - (v / max) * (height - 2) - 1]);
  const line = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const stroke = tone === 'signal' ? 'rgb(var(--signal))' : 'rgb(var(--ledger))';

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className={cn('overflow-visible', className)} preserveAspectRatio="none" aria-hidden>
      <path d={area} fill={stroke} opacity="0.1" />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.25" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      <circle cx={points.at(-1)[0]} cy={points.at(-1)[1]} r="1.75" fill={stroke} />
    </svg>
  );
}

/** Horizontal proportion bar used in every ranked breakdown. */
export function Bar({ value, max, color, label, figure, className }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={cn('group', className)}>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-text-2">{label}</span>
        <span className="fig shrink-0 text-text-3">{figure}</span>
      </div>
      <div className="mt-1 h-1 w-full overflow-hidden rounded-sm bg-rule/60">
        <div
          className="h-full rounded-sm transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%`, backgroundColor: color || 'rgb(var(--signal))' }}
        />
      </div>
    </div>
  );
}
