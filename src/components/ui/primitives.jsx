import React, { forwardRef } from 'react';
import { Slot } from '@radix-ui/react-slot';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

const VARIANTS = {
  primary: 'bg-signal text-signal-ink hover:bg-signal/90 border-signal font-medium shadow-token-xs',
  default: 'bg-panel-2 text-text border-rule hover:border-rule-strong hover:bg-panel-2/70',
  ghost: 'bg-transparent border-transparent text-text-2 hover:text-text hover:bg-panel-2',
  danger: 'bg-transparent border-rule text-redline hover:bg-redline/10 hover:border-redline/50',
  outline: 'bg-transparent border-rule-strong text-text hover:bg-panel-2',
};

const SIZES = {
  sm: 'h-7 px-2 text-xs gap-1.5',
  md: 'h-8 px-3 text-base gap-2',
  lg: 'h-10 px-4 text-md gap-2',
  icon: 'h-8 w-8 justify-center',
  'icon-sm': 'h-7 w-7 justify-center',
};

export const Button = forwardRef(function Button(
  { className, variant = 'default', size = 'md', asChild = false, ...props },
  ref
) {
  const Comp = asChild ? Slot : 'button';
  return (
    <Comp
      ref={ref}
      className={cn(
        'tap-target inline-flex shrink-0 items-center rounded border transition-[color,background-color,border-color,transform,box-shadow] duration-150',
        'focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2',
        'hover:-translate-y-px active:translate-y-0 active:scale-[0.98]',
        'disabled:pointer-events-none disabled:opacity-40',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...props}
    />
  );
});

export const Input = forwardRef(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn('field h-8', className)} {...props} />;
});

export const NumberInput = forwardRef(function NumberInput({ className, ...props }, ref) {
  return <input ref={ref} type="text" inputMode="decimal" className={cn('field fig h-8', className)} {...props} />;
});

export const Textarea = forwardRef(function Textarea({ className, rows = 3, ...props }, ref) {
  return <textarea ref={ref} rows={rows} className={cn('field resize-y leading-relaxed', className)} {...props} />;
});

export function Label({ className, children, hint, ...props }) {
  return (
    <label className={cn('mb-1 flex items-baseline gap-2', className)} {...props}>
      <span className="eyebrow">{children}</span>
      {hint && <span className="text-2xs text-text-3">{hint}</span>}
    </label>
  );
}

export function Field({ label, hint, error, children, className }) {
  const uid = React.useId();
  const labelId = `${uid}-label`;
  const errorId = `${uid}-error`;
  let control = children;
  if (React.Children.count(children) === 1 && React.isValidElement(children)) {
    const extra = {};
    if (!children.props['aria-label'] && !children.props['aria-labelledby']) {
      extra['aria-labelledby'] = labelId;
    }
    if (error) {

      extra['aria-invalid'] = true;
      extra['aria-describedby'] = [children.props['aria-describedby'], errorId].filter(Boolean).join(' ');
    }
    if (Object.keys(extra).length) control = React.cloneElement(children, extra);
  }
  return (
    <div className={className}>
      <Label id={labelId} hint={hint}>{label}</Label>
      {control}
      {error && <p id={errorId} className="mt-1 text-2xs leading-snug text-redline">{error}</p>}
    </div>
  );
}

export function Select({ value, onValueChange, options = [], placeholder = 'Select…', className, disabled, ...rest }) {
  return (
    <SelectPrimitive.Root value={value ?? undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectPrimitive.Trigger
        {...rest}
        aria-label={rest['aria-label'] ?? (rest['aria-labelledby'] ? undefined : placeholder)}
        className={cn(
          'field flex h-8 items-center justify-between gap-2 text-left',
          'data-[placeholder]:text-text-3',
          className
        )}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-3" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className="z-50 max-h-72 min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded border border-rule-strong bg-panel shadow-[var(--shadow)] animate-scale-in"
        >
          <SelectPrimitive.Viewport className="p-1">
            {options.map((opt) => {
              const { value: v, label } = typeof opt === 'string' ? { value: opt, label: opt } : opt;
              return (
                <SelectPrimitive.Item
                  key={v}
                  value={v}
                  className="relative flex cursor-pointer select-none items-center rounded px-2 py-1.5 pr-7 text-base text-text-2 outline-none data-[highlighted]:bg-panel-2 data-[highlighted]:text-text"
                >
                  <SelectPrimitive.ItemText>{label}</SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="absolute right-2">
                    <Check className="h-3.5 w-3.5 text-signal" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              );
            })}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

const BADGE_TONES = {
  neutral: 'border-rule text-text-2',
  signal: 'border-signal/40 bg-signal/10 text-signal',
  ledger: 'border-ledger/40 bg-ledger/10 text-ledger',
  redline: 'border-redline/40 bg-redline/10 text-redline',
  info: 'border-info/40 bg-info/10 text-info',
};

export function Badge({ tone = 'neutral', className, children, ...props }) {
  return (
    <span className={cn('chip', BADGE_TONES[tone], className)} {...props}>
      {children}
    </span>
  );
}

export function Dot({ color, className }) {
  return (
    <span
      className={cn('inline-block h-2 w-2 shrink-0 rounded-[1px]', className)}
      style={{ backgroundColor: color }}
      aria-hidden
    />
  );
}

export function TooltipProvider({ children }) {
  return (
    <TooltipPrimitive.Provider delayDuration={200} skipDelayDuration={300}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export function Tooltip({ content, children, side = 'top', className }) {
  if (!content) return children;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            'z-50 max-w-xs rounded border border-rule-strong bg-panel px-2 py-1 text-xs text-text-2 shadow-[var(--shadow)] animate-scale-in',
            className
          )}
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function Panel({ title, subtitle, action, children, className, bodyClassName, id }) {
  return (
    <section id={id} className={cn('panel scroll-mt-24', className)}>
      {(title || action) && (
        <header className="flex items-center justify-between gap-3 border-b border-rule px-3 py-2">
          <div className="min-w-0">
            {title && <h2 className="eyebrow">{title}</h2>}
            {subtitle && <p className="mt-0.5 truncate text-xs text-text-3">{subtitle}</p>}
          </div>
          {action && <div className="flex shrink-0 items-center gap-1.5">{action}</div>}
        </header>
      )}
      <div className={cn('panel-body p-3', bodyClassName)}>{children}</div>
    </section>
  );
}

export function EmptyState({ icon: Icon, title, description, action, className }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-4 py-10 text-center', className)}>
      {Icon && (
        <div className="mb-3 flex h-9 w-9 items-center justify-center rounded border border-rule text-text-3">
          <Icon className="h-4 w-4" />
        </div>
      )}
      <p className="text-base font-medium text-text-2">{title}</p>
      {description && <p className="mt-1 max-w-xs text-xs leading-relaxed text-text-3">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-xl font-semibold tracking-tight text-text">{title}</h2>
        {subtitle && <p className="mt-0.5 text-sm text-text-3">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-1.5">{children}</div>}
    </div>
  );
}

export function Segmented({ value, onChange, options = [], className, size = 'md', label }) {

  const refs = React.useRef([]);
  const values = options.map((o) => (typeof o === 'string' ? o : o.value));

  const move = (from, key) => {
    let next = null;
    if (key === 'ArrowRight' || key === 'ArrowDown') next = (from + 1) % values.length;
    else if (key === 'ArrowLeft' || key === 'ArrowUp') next = (from - 1 + values.length) % values.length;
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = values.length - 1;
    if (next == null) return false;
    onChange(values[next]);
    refs.current[next]?.focus();
    return true;
  };

  return (
    <div
      className={cn('inline-flex rounded border border-rule bg-panel p-0.5', className)}
      role="tablist"
      aria-label={label}
    >
      {options.map((opt, i) => {
        const { value: v, label: text, ariaLabel } = typeof opt === 'string' ? { value: opt, label: opt } : opt;
        const active = v === value;
        return (
          <button
            key={v}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={ariaLabel || text}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(v)}
            onKeyDown={(e) => { if (move(i, e.key)) e.preventDefault(); }}
            className={cn(
              'rounded-sm font-mono uppercase tracking-wider transition-colors',
              'focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-signal',
              size === 'sm' ? 'px-2 py-0.5 text-2xs' : 'px-2.5 py-1 text-2xs',
              active ? 'bg-signal text-signal-ink' : 'text-text-3 hover:text-text'
            )}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}
