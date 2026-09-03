import React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './primitives';

export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'md', variant = 'modal', className }: { open: boolean; onOpenChange: (o: boolean) => void; title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'; variant?: 'modal' | 'drawer'; className?: string }) {
  const widths = { sm: 'sm:max-w-md', md: 'sm:max-w-2xl', lg: 'sm:max-w-4xl', xl: 'sm:max-w-6xl' };
  const drawer = variant === 'drawer';
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content aria-describedby={description ? undefined : ''} className={cn(
          'fixed z-50 flex flex-col overflow-hidden bg-surface shadow-modal focus:outline-none',
          drawer
            ? 'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-xl border border-line data-[state=open]:animate-slide-up sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[min(48vw,600px)] sm:rounded-none sm:border-y-0 sm:border-r-0 sm:data-[state=open]:animate-slide-in-right'
            : cn('inset-x-0 bottom-0 max-h-[92dvh] rounded-t-xl border border-line data-[state=open]:animate-slide-up sm:inset-auto sm:left-1/2 sm:top-1/2 sm:max-h-[88vh] sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:data-[state=open]:animate-scale-in', widths[size]),
          className
        )}>
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 pb-3 pt-4">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-md font-semibold text-ink">{title}</DialogPrimitive.Title>
              {description && <DialogPrimitive.Description className="mt-0.5 text-xs leading-relaxed text-ink-3">{description}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close className="-mr-1 -mt-1 rounded-md p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink" aria-label="Close"><X className="h-4 w-4" /></DialogPrimitive.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2/60 px-5 pb-[max(.75rem,env(safe-area-inset-bottom))] pt-3 max-[420px]:[&>*]:flex-1 max-[420px]:[&>*]:justify-center">{footer}</footer>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function ConfirmDialog({ open, onOpenChange, title, body, confirmLabel = 'Delete', onConfirm, danger = true, loading }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; body: React.ReactNode; confirmLabel?: string; onConfirm: () => void | Promise<void>; danger?: boolean; loading?: boolean }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={title} size="sm" footer={
      <>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={async () => { await onConfirm(); onOpenChange(false); }}>{confirmLabel}</Button>
      </>
    }>
      <div className="text-sm leading-relaxed text-ink-2">{body}</div>
    </Dialog>
  );
}
