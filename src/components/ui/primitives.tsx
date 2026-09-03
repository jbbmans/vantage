import React, { forwardRef, useId } from 'react';
import { Slot } from '@radix-ui/react-slot';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const VARIANTS = {
  primary: 'bg-accent text-accent-ink border-accent hover:brightness-110 shadow-card font-semibold',
  default: 'bg-surface text-ink border-line hover:border-line-strong hover:bg-surface-2',
  soft: 'bg-accent-soft text-accent border-transparent hover:brightness-95',
  ghost: 'bg-transparent border-transparent text-ink-2 hover:text-ink hover:bg-surface-2',
  danger: 'bg-transparent border-line text-bad hover:bg-bad/10 hover:border-bad/50',
  outline: 'bg-transparent border-line-strong text-ink hover:bg-surface-2',
} as const;
const SIZES = { xs: 'h-7 px-2 text-xs gap-1', sm: 'h-8 px-2.5 text-sm gap-1.5', md: 'h-9 px-3.5 text-sm gap-2', lg: 'h-11 px-5 text-md gap-2', icon: 'h-9 w-9 justify-center', 'icon-sm': 'h-8 w-8 justify-center', 'icon-xs': 'h-7 w-7 justify-center' } as const;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: keyof typeof VARIANTS; size?: keyof typeof SIZES; asChild?: boolean; loading?: boolean }
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ className, variant = 'default', size = 'md', asChild = false, loading = false, children, disabled, ...props }, ref) {
  const Comp: any = asChild ? Slot : 'button';
  return (
    <Comp ref={ref} type={asChild ? undefined : (props.type || 'button')} disabled={disabled || loading}
      className={cn('tap inline-flex shrink-0 items-center rounded-md border font-medium transition-[color,background-color,border-color,box-shadow,transform,filter] duration-150 active:scale-[0.985] disabled:pointer-events-none disabled:opacity-45', VARIANTS[variant], SIZES[size], className)} {...props}>
      {loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      {children}
    </Comp>
  );
});

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn('field h-9', className)} {...props} />;
});
export const NumberInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function NumberInput({ className, ...props }, ref) {
  return <input ref={ref} type="text" inputMode="decimal" className={cn('field fig h-9', className)} {...props} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, rows = 3, ...props }, ref) {
  return <textarea ref={ref} rows={rows} className={cn('field resize-y leading-relaxed', className)} {...props} />;
});

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
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-xs font-semibold text-ink-2"><span id={labelId}>{label}</span>{required && <span className="ml-0.5 text-bad" aria-hidden>*</span>}</span>
        {hint && <span id={hintId} className="truncate text-2xs text-ink-3">{hint}</span>}
      </div>
      {children.type === React.Fragment
        ? React.cloneElement(children, {}, ...(React.Children.map(children.props.children as React.ReactNode, (child: React.ReactNode, i: number) => (i === 0 && React.isValidElement(child) ? React.cloneElement(child as React.ReactElement<any>, extra) : child)) || []))
        : React.cloneElement(children, extra)}
      {error && <p id={errorId} className="mt-1 text-xs leading-snug text-bad" role="alert">{error}</p>}
    </div>
  );
}

export interface SelectOption { value: string; label: string; disabled?: boolean }
export function Select({ value, onValueChange, options, placeholder = 'Select…', className, disabled, ...rest }: { value?: string | null; onValueChange: (v: string) => void; options: Array<SelectOption | string>; placeholder?: string; className?: string; disabled?: boolean; 'aria-label'?: string; 'aria-labelledby'?: string; id?: string }) {
  return (
    <SelectPrimitive.Root value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger {...rest} aria-label={rest['aria-label'] ?? (rest['aria-labelledby'] ? undefined : placeholder)} className={cn('field flex h-9 items-center justify-between gap-2 text-left data-[placeholder]:text-ink-3', className)}>
        <span className="truncate"><SelectPrimitive.Value placeholder={placeholder} /></span>
        <SelectPrimitive.Icon><ChevronDown className="h-4 w-4 shrink-0 text-ink-3" /></SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content position="popper" sideOffset={4} className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-line bg-surface shadow-pop animate-scale-in">
          <SelectPrimitive.Viewport className="p-1">
            {options.map((opt) => {
              const o = typeof opt === 'string' ? { value: opt, label: opt } : opt;
              return (
                <SelectPrimitive.Item key={o.value} value={o.value} disabled={o.disabled} className="relative flex cursor-pointer select-none items-center rounded px-2.5 py-1.5 pr-8 text-sm text-ink-2 outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink data-[disabled]:opacity-40">
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

const TONES = { neutral: 'border-line text-ink-2 bg-surface', accent: 'border-accent/30 bg-accent-soft text-accent', good: 'border-good/30 bg-good/10 text-good', warn: 'border-warn/30 bg-warn/10 text-warn', bad: 'border-bad/30 bg-bad/10 text-bad', info: 'border-info/30 bg-info/10 text-info' } as const;
export type Tone = keyof typeof TONES;
export function Badge({ tone = 'neutral', className, children, ...props }: { tone?: Tone; className?: string; children: React.ReactNode } & React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('chip', TONES[tone], className)} {...props}>{children}</span>;
}
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
        <TooltipPrimitive.Content side={side} sideOffset={6} className="z-50 max-w-xs rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-ink-2 shadow-pop animate-scale-in">{content}</TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function Panel({ title, subtitle, action, children, className, bodyClassName, id, padded = true }: { title?: React.ReactNode; subtitle?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string; id?: string; padded?: boolean }) {
  return (
    <section id={id} className={cn('card min-w-0 scroll-mt-24', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 truncate text-xs text-ink-3">{subtitle}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
        </header>
      )}
      <div className={cn('card-body', padded && 'p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function EmptyState({ icon: Icon, title, description, action, className }: { icon?: React.ComponentType<{ className?: string }>; title: string; description?: React.ReactNode; action?: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-4 py-10 text-center', className)}>
      {Icon && <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-surface-2 text-ink-3"><Icon className="h-5 w-5" /></div>}
      <p className="text-base font-medium text-ink">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm leading-relaxed text-ink-3">{description}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone, to, icon: Icon }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: 'accent' | 'good' | 'warn' | 'bad'; to?: string; icon?: React.ComponentType<{ className?: string }> }) {
  const body = (
    <div className="card card-hover flex h-full min-w-0 flex-col justify-between p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-ink-3">{label}</p>
        {Icon && <Icon className="h-4 w-4 text-ink-3" />}
      </div>
      <p className={cn('stat-value mt-2', tone === 'accent' && 'text-accent', tone === 'good' && 'text-good', tone === 'warn' && 'text-warn', tone === 'bad' && 'text-bad')}>{value}</p>
      {hint && <p className="mt-1 truncate text-xs text-ink-3">{hint}</p>}
    </div>
  );
  return to ? <a href={to} onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent('vantage:navigate', { detail: to })); }} className="block h-full rounded-lg focus-visible:ring-2">{body}</a> : body;
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
    <div role="tablist" aria-label={label} className={cn('inline-flex rounded-md border border-line bg-surface-2 p-0.5', className)}>
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button key={o.value} ref={(el) => { refs.current[i] = el; }} type="button" role="tab" aria-selected={active} aria-label={o.ariaLabel} tabIndex={active ? 0 : -1}
            onClick={() => onChange(o.value)} onKeyDown={(e) => { if (move(i, e.key)) e.preventDefault(); }}
            className={cn('rounded-[5px] font-medium transition-colors', size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm', active ? 'bg-surface text-ink shadow-card' : 'text-ink-3 hover:text-ink')}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, className }: { value: T; onChange: (v: T) => void; tabs: Array<{ value: T; label: React.ReactNode; count?: number }>; className?: string }) {
  return (
    <div role="tablist" className={cn('flex gap-1 overflow-x-auto border-b border-line', className)}>
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button key={t.value} type="button" role="tab" aria-selected={active} onClick={() => onChange(t.value)}
            className={cn('-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors', active ? 'border-accent text-ink' : 'border-transparent text-ink-3 hover:text-ink')}>
            {t.label}{t.count != null && <span className={cn('fig rounded-full px-1.5 text-2xs', active ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-ink-3')}>{t.count}</span>}
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
      <div className={cn('h-full rounded-full transition-[width]', tone === 'accent' && 'bg-accent', tone === 'good' && 'bg-good', tone === 'warn' && 'bg-warn', tone === 'bad' && 'bg-bad')} style={{ width: `${pct}%` }} />
    </div>
  );
}

export const Skeleton = ({ className }: { className?: string }) => <div className={cn('skeleton rounded-md', className)} aria-hidden />;
export const Kbd = ({ children }: { children: React.ReactNode }) => <kbd className="kbd">{children}</kbd>;

export function PageHeader({ eyebrow, title, lede, children }: { eyebrow?: string; title: React.ReactNode; lede?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-1.5">{eyebrow}</p>}
        <h1 className="page-title">{title}</h1>
        {lede && <p className="page-lede">{lede}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode; description?: React.ReactNode; disabled?: boolean }) {
  return (
    <label className={cn('flex cursor-pointer items-start justify-between gap-4 rounded-md px-1 py-2', disabled && 'cursor-not-allowed opacity-50')}>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">{label}</span>
        {description && <span className="mt-0.5 block text-xs leading-relaxed text-ink-3">{description}</span>}
      </span>
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors', checked ? 'border-accent bg-accent' : 'border-line-strong bg-surface-3')}>
        <span className={cn('absolute top-0.5 h-[18px] w-[18px] rounded-full bg-white shadow transition-[left]', checked ? 'left-[22px]' : 'left-0.5')} />
      </button>
    </label>
  );
}
