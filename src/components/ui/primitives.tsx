import React, { forwardRef, useId } from 'react';
import { Slot } from '@radix-ui/react-slot';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const VARIANTS = {
  primary: 'bg-accent text-accent-ink border-transparent shadow-[inset_0_1px_0_rgb(255_255_255/.18),0_1px_2px_rgb(var(--accent)/.3),0_6px_16px_-8px_rgb(var(--accent)/.55)] hover:brightness-[1.07]',
  default: 'bg-surface text-ink border-transparent shadow-[0_0_0_1px_rgb(var(--line-strong)),0_1px_2px_rgb(var(--shadow-rgb)/.05)] hover:bg-surface-2 hover:shadow-[0_0_0_1px_rgb(var(--ink-3)/.45),0_1px_2px_rgb(var(--shadow-rgb)/.05)]',
  soft: 'bg-surface-2 text-ink-2 border-transparent hover:bg-surface-3 hover:text-ink',
  ghost: 'bg-transparent border-transparent text-ink-2 hover:text-ink hover:bg-surface-2',
  danger: 'bg-surface border-transparent text-bad shadow-[0_0_0_1px_rgb(var(--line-strong))] hover:bg-bad/[.07] hover:shadow-[0_0_0_1px_rgb(var(--bad)/.45)]',
  outline: 'bg-transparent border-ink-3/40 text-ink hover:bg-surface-2',
} as const;
const SIZES = { xs: 'h-6 px-2 text-xs gap-1 rounded-md', sm: 'h-7 px-2.5 text-xs gap-1.5 rounded-lg', md: 'h-9 px-3.5 text-base gap-2 rounded-[9px]', lg: 'h-11 px-5 text-md gap-2 rounded-[11px]', icon: 'h-9 w-9 justify-center rounded-[9px]', 'icon-sm': 'h-7 w-7 justify-center rounded-lg', 'icon-xs': 'h-6 w-6 justify-center rounded-md' } as const;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES; asChild?: boolean; loading?: boolean }
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant = 'default', size = 'md', asChild = false, loading = false, children, disabled, ...props }, ref) {
  const Comp: any = asChild ? Slot : 'button';
  return (
    <Comp ref={ref} type={asChild ? undefined : (props.type || 'button')} disabled={disabled || loading}
      className={cn('tap inline-flex shrink-0 items-center justify-center border font-medium leading-none tracking-[-0.005em] transition-[background-color,border-color,box-shadow,filter,transform] duration-150 disabled:pointer-events-none disabled:opacity-45', VARIANTS[variant], SIZES[size], className)} {...props}>
      {asChild ? children : <>{loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}{children}</>}
    </Comp>
  );
});

const finePointer = () => typeof window === 'undefined' || !window.matchMedia?.('(pointer: coarse)').matches;
export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, autoFocus, ...props }, ref) {
  return <input ref={ref} autoFocus={autoFocus && finePointer()} className={cn('field h-9 py-0', className)} {...props} />;
});
export const NumberInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function NumberInput({ className, ...props }, ref) {
  return <input ref={ref} type="text" inputMode="decimal" className={cn('field fig h-9 py-0', className)} {...props} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, rows = 3, autoFocus, ...props }, ref) {
  return <textarea ref={ref} rows={rows} autoFocus={autoFocus && finePointer()} className={cn('field resize-y leading-relaxed', className)} {...props} />;
});

const CONTROL_TYPES = new Set(['input', 'select', 'textarea']);

function applyToControl(node: React.ReactElement<any>, extra: Record<string, unknown>): React.ReactNode {
  if (typeof node.type === 'string' && !CONTROL_TYPES.has(node.type)) {
    const kids = React.Children.toArray(node.props.children);
    let done = false;
    const next = kids.map((child) => {
      if (done || !React.isValidElement(child)) return child;
      const applied = applyToControl(child as React.ReactElement<any>, extra);
      if (applied !== child) done = true;
      return applied;
    });
    return done ? React.cloneElement(node, {}, ...next) : node;
  }
  if (node.type === React.Fragment) {
    const kids = React.Children.toArray(node.props.children);
    let done = false;
    const next = kids.map((child) => {
      if (done || !React.isValidElement(child)) return child;
      const applied = applyToControl(child as React.ReactElement<any>, extra);
      if (applied !== child) done = true;
      return applied;
    });
    return React.cloneElement(node, {}, ...next);
  }
  // A control, or a component we trust to forward these through to one.
  return React.cloneElement(node, extra);
}

export function Field({ label, hint, error, children, className, required }: { label: React.ReactNode; hint?: React.ReactNode; error?: string | null; children: React.ReactElement<any>; className?: string; required?: boolean }) {
  const uid = useId();
  const labelId = `${uid}-label`; const errorId = `${uid}-error`; const hintId = `${uid}-hint`;
  const extra: Record<string, unknown> = {};
  if (!children.props['aria-label'] && !children.props['aria-labelledby']) extra['aria-labelledby'] = labelId;
  const described = [children.props['aria-describedby'], hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  if (described) extra['aria-describedby'] = described;
  if (error) extra['aria-invalid'] = true;
  return (
    <div className={cn('min-w-0', className)}>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span className="text-base font-medium text-ink"><span id={labelId}>{label}</span>{required && <span className="ml-1 text-accent" aria-hidden>*</span>}</span>
        {hint && <span id={hintId} className="text-xs leading-snug text-ink-3">{hint}</span>}
      </div>
      {applyToControl(children, extra)}
      {error && <p id={errorId} className="mt-1 text-xs leading-snug text-bad" role="alert">{error}</p>}
    </div>
  );
}

export interface SelectOption { value: string; label: string; disabled?: boolean }
export function Select({ value, onValueChange, options, placeholder = 'Select…', className, disabled, ...rest }: { value?: string | null; onValueChange: (v: string) => void; options: Array<SelectOption | string>; placeholder?: string; className?: string; disabled?: boolean; 'aria-label'?: string; 'aria-labelledby'?: string; id?: string }) {
  return (
    <SelectPrimitive.Root value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger {...rest} aria-label={rest['aria-label'] ?? (rest['aria-labelledby'] ? undefined : placeholder)} className={cn('field flex h-9 items-center justify-between gap-2 py-0 text-left data-[placeholder]:text-ink-3', className)}>
        <span className="truncate"><SelectPrimitive.Value placeholder={placeholder} /></span>
        <SelectPrimitive.Icon><ChevronDown className="h-4 w-4 shrink-0 text-ink-3" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={6} className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-xl bg-surface shadow-pop animate-scale-in">
          <SelectPrimitive.Viewport className="p-1.5">
            {options.map((opt) => {
              const o = typeof opt === 'string' ? { value: opt, label: opt } : opt;
              return (
                <SelectPrimitive.Item key={o.value} value={o.value} disabled={o.disabled} className="relative flex cursor-pointer select-none items-center rounded-lg px-2.5 py-[7px] pr-8 text-base text-ink-2 outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink data-[state=checked]:text-ink data-[disabled]:opacity-40">
                  <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="absolute right-2"><Check className="h-3.5 w-3.5 text-accent" /></SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              );
            })}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

const TONES = { neutral: 'bg-surface-2 text-ink-2 ring-1 ring-inset ring-line', accent: 'bg-accent-soft text-accent ring-1 ring-inset ring-accent/15', good: 'bg-good/10 text-good ring-1 ring-inset ring-good/20', warn: 'bg-warn/10 text-warn ring-1 ring-inset ring-warn/20', bad: 'bg-bad/10 text-bad ring-1 ring-inset ring-bad/20', info: 'bg-info/10 text-info ring-1 ring-inset ring-info/20' } as const;
export type Tone = keyof typeof TONES;
export function Badge({ tone = 'neutral', className, children, ...props }: { tone?: Tone; className?: string; children: React.ReactNode } & React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('chip', TONES[tone], className)} {...props}>{children}</span>;
}
export const RoleBadge = ({ color, children, className }: { color?: string | null; children: React.ReactNode; className?: string }) => (
  <Badge className={cn('gap-1.5 pl-1.5', className)}><Dot color={color || '#6b7a8f'} />{children}</Badge>
);
export const Dot = ({ color, className }: { color?: string; className?: string }) => <span className={cn('badge-dot', className)} style={{ backgroundColor: color }} aria-hidden />;

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={250} skipDelayDuration={300}>{children}</TooltipPrimitive.Provider>;
}
export function Tooltip({ content, children, side = 'top' }: { content: React.ReactNode; children: React.ReactElement; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!content) return children;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} sideOffset={7} className="z-50 max-w-xs rounded-lg bg-deep px-2.5 py-1.5 text-xs leading-snug text-white shadow-pop ring-1 ring-white/10 animate-scale-in">{content}</TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function Panel({ title, subtitle, action, children, className, bodyClassName, id, padded = true }: { title?: React.ReactNode; subtitle?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string; id?: string; padded?: boolean }) {
  return (
    <section id={id} className={cn('card min-w-0 scroll-mt-24', className)}>
      {(title || action) && (
        <header className="panel-head flex items-center justify-between gap-3 px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="truncate text-md font-semibold tracking-[-0.012em] text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs leading-relaxed text-ink-3">{subtitle}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
        </header>
      )}
      <div className={cn('card-body', padded && 'p-5', bodyClassName)}>{children}</div>
    </section>
  );
}

export function EmptyState({ icon: Icon, title, description, action, className }: { icon?: React.ComponentType<{ className?: string }>; title: string; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-4 py-12 text-center', className)}>
      {Icon && <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-[13px] bg-surface-2 text-ink-3 shadow-[inset_0_0_0_1px_rgb(var(--line))]"><Icon className="h-[18px] w-[18px]" /></div>}
      <p className="text-lg font-semibold tracking-[-0.015em] text-ink">{title}</p>
      {description && <p className="mt-1.5 max-w-sm text-base leading-relaxed text-ink-3">{description}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone, to, icon: Icon }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'accent' | 'good' | 'warn' | 'bad'; to?: string; icon?: React.ComponentType<{ className?: string }> }) {
  const body = (
    <div className="card card-hover flex h-full min-w-0 flex-col justify-between p-5">
      <div className="flex items-start justify-between gap-2">
        <p className="truncate text-sm font-medium text-ink-2">{label}</p>
        {Icon && <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-surface-2 text-ink-3"><Icon className="h-3.5 w-3.5 shrink-0" /></span>}
      </div>
      <p className={cn('stat-value mt-5', tone === 'accent' && 'text-accent', tone === 'good' && 'text-good', tone === 'warn' && 'text-warn', tone === 'bad' && 'text-bad')}>{value}</p>
      {hint && <p className="mt-1.5 truncate text-xs text-ink-3">{hint}</p>}
    </div>
  );
  return to ? <a href={to} onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent('vantage:navigate', { detail: to })); }} className="block h-full">{body}</a> : body;
}

export function Segmented<T extends string>({ value, onChange, options, className, label, size = 'md' }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: React.ReactNode; ariaLabel?: string }>; className?: string; label?: string; size?: 'sm' | 'md' }) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const move = (from: number, key: string) => {
    let next: number | null = null;
    if (key === 'ArrowRight' || key === 'ArrowDown') next = (from + 1) % options.length;
    else if (key === 'ArrowLeft' || key === 'ArrowUp') next = (from - 1 + options.length) % options.length;
    else if (key === 'Home') next = 0; else if (key === 'End') next = options.length - 1;
    if (next == null) return false;
    onChange(options[next].value); refs.current[next]?.focus();
    return true;
  };
  return (
    <div role="tablist" aria-label={label} className={cn('inline-flex max-w-full shrink-0 rounded-[10px] bg-surface-2 p-[3px] shadow-[inset_0_0_0_1px_rgb(var(--line))] scroll-x scroll-x-quiet', className)}>
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button key={o.value} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" aria-selected={active} aria-label={o.ariaLabel} tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)} onKeyDown={(e) => { if (move(i, e.key)) e.preventDefault(); }}
            className={cn('shrink-0 whitespace-nowrap rounded-[7px] font-medium transition-[color,background-color,box-shadow] duration-200', size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-base', active ? 'bg-surface text-ink shadow-[0_0_0_1px_rgb(var(--line)),0_1px_3px_rgb(var(--shadow-rgb)/.08)]' : 'text-ink-3 hover:text-ink')}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: React.ReactNode; count?: number }>; className?: string }) {
  const strip = React.useRef<HTMLDivElement | null>(null);
  const ink = React.useRef<HTMLSpanElement | null>(null);
  const [measured, setMeasured] = React.useState(false);
  React.useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    el?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [value]);
  React.useLayoutEffect(() => {
    const bar = strip.current;
    if (!bar) return;
    const place = () => {
      const el = bar.querySelector<HTMLElement>('[aria-selected="true"]');
      const line = ink.current;
      if (!el || !line) { setMeasured(false); return; }
      const first = !line.dataset.placed;
      if (first) line.style.transition = 'none';
      line.style.transform = `translateX(${el.offsetLeft}px) scaleX(${el.offsetWidth / 100})`;
      if (first) { void line.offsetWidth; line.style.transition = ''; line.dataset.placed = '1'; }
      setMeasured(true);
    };
    place();
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    watch?.observe(bar);
    bar.querySelectorAll('[role="tab"]').forEach((t) => watch?.observe(t));
    return () => watch?.disconnect();
  }, [value, tabs.length]);
  return (
    <div ref={strip} role="tablist" data-ink={measured || undefined} className={cn('tab-bar relative scroll-x scroll-x-canvas scroll-x-quiet', className)}>
      <span ref={ink} className="tab-ink" style={{ opacity: measured ? 1 : 0 }} aria-hidden />
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button key={t.value} type="button" role="tab" aria-selected={active} onClick={() => onChange(t.value)}
            className={cn('tab flex shrink-0 items-center gap-1.5 whitespace-nowrap', active && 'border-accent text-ink')}>
            {t.label}{t.count != null && <span className={cn('fig rounded-md px-1.5 py-0.5 text-2xs', active ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-3')}>{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

export function Progress({ value, max = 100, tone = 'accent', className, label = 'Progress' }: { value: number; max?: number; tone?: 'accent' | 'good' | 'warn' | 'bad'; className?: string; label?: string }) {
  const pct = max ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-3', className)} role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn('h-full rounded-full transition-[width] duration-700 [transition-timing-function:var(--ease-spring)]', tone === 'accent' && 'bg-accent', tone === 'good' && 'bg-good', tone === 'warn' && 'bg-warn', tone === 'bad' && 'bg-bad')} style={{ width: `${pct}%` }} />
    </div>
  );
}

export const Skeleton = ({ className }: { className?: string }) => <div className={cn('skeleton', className)} aria-hidden />;
export const Kbd = ({ children }: { children: React.ReactNode }) => <kbd className="kbd">{children}</kbd>;

export function PageHeader({ eyebrow, title, lede, children }: { eyebrow?: string; title: React.ReactNode; lede?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-8">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0 flex-1 basis-[22rem]">
          {eyebrow && <p className="eyebrow mb-3 flex items-center gap-2"><span className="h-px w-5 bg-accent" aria-hidden />{eyebrow}</p>}
          <h1 className="page-title">{title}</h1>
          {lede && <p className="page-lede">{lede}</p>}
        </div>
        {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
      </div>
    </div>
  );
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; description?: React.ReactNode; disabled?: boolean }) {
  return (
    <label className={cn('flex cursor-pointer items-start justify-between gap-4 rounded-md px-1 py-2', disabled && 'cursor-not-allowed opacity-50')}>
      <span className="min-w-0">
        <span className="block text-base font-medium text-ink">{label}</span>
        {description && <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">{description}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition-colors', checked ? 'border-accent bg-accent' : 'border-line-strong bg-surface-3')}>
        <span className={cn('absolute top-[2px] h-[14px] w-[14px] rounded-full shadow-card transition-[left] duration-150', checked ? 'left-[18px] bg-accent-ink' : 'left-[2px] bg-surface')} />
      </button>
    </label>
  );
}
