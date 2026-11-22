import { lastDays, type WindowKeys } from './periodParams.ts';

/**
 * The windows the pages that read so many days offer (ADR-0039): each keeps its own choices, words, address key and
 * default, so the links they always had still open on the same days. Custom dates sit after them in the picker.
 */
export interface WindowChoice extends WindowKeys { options: ReadonlyArray<{ value: string; label: string }> }

function windowChoice(key: string, options: ReadonlyArray<{ value: string; label: string }>, fallback: string): WindowChoice {
  return { key, options, presets: options.map((o) => o.value), fallback };
}

/** The Unit dashboard's window, `?days=`: "Last year" is 365 days ending today. */
export const DASHBOARD_WINDOW = windowChoice('days', [
  { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: '180', label: 'Last 180 days' }, { value: '365', label: 'Last year' },
], '90');

/** Workload's window, `?window=`. */
export const WORKLOAD_WINDOW = windowChoice('window', [{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }], '30');

/** Your record's reporting window, `?window=`: 12 months is 365 days ending today. */
export const RECORD_WINDOW = windowChoice('window', [{ value: '30', label: '30 days' }, { value: '90', label: '90 days' }, { value: '365', label: '12 months' }], '90');

/** The days Custom dates starts from: the window chosen before it. */
export const windowSeed = (choice: WindowChoice) => (previous: string) => lastDays(choice.presets.includes(previous) ? previous : choice.fallback);
