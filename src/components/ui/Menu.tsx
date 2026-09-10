import React from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;
export function MenuContent({ children, align = 'end', className }: { children: React.ReactNode; align?: 'start' | 'end' | 'center'; className?: string }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content align={align} sideOffset={6} className={cn('z-50 min-w-[200px] rounded-md border border-line bg-surface p-1 shadow-pop animate-scale-in', className)}>{children}</DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}
export function MenuItem({ children, onSelect, danger, icon: Icon, disabled }: { children: React.ReactNode; onSelect?: () => void; danger?: boolean; icon?: React.ComponentType<{ className?: string }>; disabled?: boolean }) {
  return (
    <DropdownMenu.Item disabled={disabled} onSelect={onSelect} className={cn('flex cursor-pointer select-none items-center gap-2 rounded px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-40', danger ? 'text-bad' : 'text-ink-2 data-[highlighted]:text-ink')}>
      {Icon && <Icon className="h-4 w-4" />}{children}
    </DropdownMenu.Item>
  );
}
export const MenuSeparator = () => <DropdownMenu.Separator className="my-1 h-px bg-line" />;
export const MenuLabel = ({ children }: { children: React.ReactNode }) => <DropdownMenu.Label className="px-2.5 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">{children}</DropdownMenu.Label>;
