import React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn, useOverflow } from '@/lib/utils';
import { Button } from './primitives';

export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'md', variant = 'modal', className }: { open: boolean; onOpenChange: (o: boolean) => void; title: React.ReactNode; description?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'; variant?: 'modal' | 'drawer'; className?: string }) {
  const widths = { sm: 'sm:max-w-md', md: 'sm:max-w-2xl', lg: 'sm:max-w-4xl', xl: 'sm:max-w-6xl' };
  const drawer = variant === 'drawer';
  // Every dialog here opens from state, not a Radix trigger, so Radix has nowhere to put focus back when it closes.
  useReturnFocus(open);
  const titleId = React.useId();
  // A body longer than the dialog takes a Tab stop, so its end can be read with the keyboard (WCAG 2.1.1).
  const [body, overflows] = useOverflow<HTMLDivElement>('y');
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-deep/55 backdrop-blur-[3px] data-[state=open]:animate-fade-in" />
        <DialogPrimitive.Content aria-labelledby={titleId} aria-describedby={description ? undefined : ''} className={cn(
          'fixed z-50 flex flex-col overflow-hidden bg-surface shadow-modal focus:outline-none',
          drawer
            ? 'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl data-[state=open]:animate-slide-up sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[min(46vw,600px)] sm:rounded-none sm:rounded-l-2xl sm:data-[state=open]:animate-slide-in-right'
            : cn('inset-x-0 bottom-0 max-h-[92dvh] rounded-t-2xl data-[state=open]:animate-slide-up sm:inset-auto sm:left-1/2 sm:top-1/2 sm:max-h-[88vh] sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:data-[state=open]:animate-modal-in', widths[size]),
          className
        )}>
          <header className="flex items-start justify-between gap-4 px-5 pb-2 pt-4">
            <div className="min-w-0">
              <DialogPrimitive.Title id={titleId} className="text-lg font-semibold tracking-[-0.015em] text-ink">{title}</DialogPrimitive.Title>
              {description && <DialogPrimitive.Description className="mt-1 text-sm leading-relaxed text-ink-3">{description}</DialogPrimitive.Description>}
            </div>
            <DialogPrimitive.Close className="-mr-1.5 -mt-0.5 rounded-lg p-1.5 text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink" aria-label="Close"><X className="h-4 w-4" /></DialogPrimitive.Close>
          </header>
          <div ref={body} className="min-h-0 flex-1 overflow-y-auto px-5 py-3 [overscroll-behavior:contain]" tabIndex={overflows ? 0 : undefined}>{children}</div>
          {footer && <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2/60 px-5 pb-[max(.875rem,env(safe-area-inset-bottom))] pt-3.5 max-[420px]:[&>*]:flex-1 max-[420px]:[&>*]:justify-center">{footer}</footer>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Focus back where it was when a dialog opened by state, not by a trigger, closes. With no trigger, the dialog's own return
 * of focus leaves it nowhere (on the page body), even inside a form that is still open. The element is noted before the
 * dialog takes focus (a layout effect runs before its content mounts), and focused again once the dialog has finished
 * closing, only if nothing else has taken focus and it is still on the page.
 */
export function useReturnFocus(open: boolean) {
  // The cleanup gives focus back, so it runs whether the dialog closes or its owner unmounts it while open (a dialog
  // rendered only while it has something to show, like DutyDialog with no mode, never sees open turn false).
  React.useLayoutEffect(() => {
    if (!open) return;
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (!back) return;
      requestAnimationFrame(() => window.setTimeout(() => {
        // Only when focus went nowhere: a dialog opened next, or a page that moved focus itself, keeps it.
        if (back.isConnected && (document.activeElement === document.body || !document.activeElement)) back.focus({ preventScroll: true });
      }, 0));
    };
  }, [open]);
}

export function ConfirmDialog({ open, onOpenChange, title, body, confirmLabel = 'Delete', onConfirm, danger = true, loading }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; body: React.ReactNode; confirmLabel?: string; onConfirm: () => void | Promise<void>; danger?: boolean; loading?: boolean }) {
  useReturnFocus(open);
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
