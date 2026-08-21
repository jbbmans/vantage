import React from 'react';
import { Dialog } from '@/components/ui/Dialog';
import { NAV } from '@/config/nav';

/**
 * Every shortcut the app listens for, in one place.
 *
 * The whole shell is built around not touching the mouse, and until now the
 * only way to learn that was to hover a nav item and notice a faint keycap.
 * A keyboard-first tool that hides its keyboard map is just a slow tool.
 */

const Keys = ({ combo }) => (
  <span className="flex shrink-0 items-center gap-1">
    {combo.split(' ').map((k, i) => (
      <kbd
        key={i}
        className="fig rounded border border-rule bg-panel-2 px-1.5 py-0.5 text-2xs uppercase text-text-2"
      >
        {k}
      </kbd>
    ))}
  </span>
);

const Row = ({ combo, label }) => (
  <div className="flex items-center justify-between gap-4 py-1.5">
    <span className="min-w-0 text-base text-text-2">{label}</span>
    <Keys combo={combo} />
  </div>
);

const Group = ({ title, children }) => (
  <div>
    <p className="eyebrow mb-1 border-b border-rule pb-1">{title}</p>
    {children}
  </div>
);

export default function ShortcutsDialog({ open, onOpenChange }) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard"
      description="Vantage is built to be driven without the mouse."
      size="md"
    >
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Group title="Anywhere">
          <Row combo="N" label="Log an activity" />
          <Row combo="⌘ K" label="Search and jump" />
          <Row combo="/" label="Search and jump" />
          <Row combo="?" label="This list" />
          <Row combo="Esc" label="Close what's open" />
        </Group>

        <Group title="Go to">
          {NAV.map((item) => (
            <Row key={item.to} combo={item.key} label={item.label} />
          ))}
        </Group>

        <Group title="In the log dialog">
          <Row combo="⌘ ↵" label="Save the entry" />
        </Group>

        <Group title="In search">
          <Row combo="↑ ↓" label="Move between results" />
          <Row combo="↵" label="Open the highlighted result" />
        </Group>
      </div>

      <p className="mt-4 border-t border-rule pt-3 text-xs leading-relaxed text-text-3">
        Navigation shortcuts are two-key sequences: tap <kbd className="fig text-text-2">G</kbd>, release, then the
        second key. They're ignored while you're typing in a field. The full operating procedure lives under{' '}
        <a href="/help" className="text-signal underline-offset-2 hover:underline">Help</a>.
      </p>
    </Dialog>
  );
}
