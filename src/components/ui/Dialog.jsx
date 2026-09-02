import React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export const DialogRoot = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function Dialog({ open, onOpenChange, title, description, children, footer, size = 'md', variant = 'modal', className }) {
  const widths = { sm: 'max-w-md', md: 'max-w-2xl', lg: 'max-w-4xl', xl: 'max-w-6xl' };
  const isDrawer = variant === 'drawer';
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-nav/55 backdrop-blur-[2px] data-[state=open]:animate-scale-in" />
        <DialogPrimitive.Content
          className={cn(
            'fixed z-50 flex flex-col overflow-hidden border border-rule-strong bg-panel shadow-[var(--shadow)]',
            isDrawer
              ? 'inset-y-0 right-0 h-dvh w-full max-w-[560px] border-y-0 border-r-0 pb-[env(safe-area-inset-bottom)] sm:w-[min(46vw,560px)] data-[state=open]:animate-slide-in-right'
              : cn('left-1/2 top-1/2 max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg sm:max-h-[88vh] sm:w-[calc(100vw-2rem)] data-[state=open]:animate-scale-in', widths[size]),
            className
          )}
        >
          <header className="flex items-start justify-between gap-4 border-b border-rule px-4 pb-3 pt-[max(.75rem,env(safe-area-inset-top))]">
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-md font-semibold tracking-tight text-text">
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="mt-0.5 text-xs leading-relaxed text-text-3">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close className="-mr-1 -mt-1 rounded p-1 text-text-3 transition-colors hover:bg-panel-2 hover:text-text">
              <X className="h-4 w-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>

          {footer && (
            <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-rule bg-panel-2/40 px-4 pb-[max(.625rem,env(safe-area-inset-bottom))] pt-2.5 max-[420px]:[&>*]:flex-1 max-[420px]:[&>*]:justify-center">
              {footer}
            </footer>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function ConfirmDialog({ open, onOpenChange, title, body, confirmLabel = 'Delete', onConfirm }) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <button
            onClick={() => onOpenChange(false)}
            className="h-8 rounded border border-rule px-3 text-base text-text-2 hover:text-text"
          >
            Cancel
          </button>
          <button
            onClick={() => { onConfirm(); onOpenChange(false); }}
            className="h-8 rounded border border-redline/50 bg-redline/10 px-3 text-base font-medium text-redline hover:bg-redline/20"
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="text-base leading-relaxed text-text-2">{body}</p>
    </Dialog>
  );
}
