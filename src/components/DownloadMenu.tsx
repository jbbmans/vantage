import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/primitives';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/Menu';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import * as api from '@/lib/api';

export interface DownloadChoice { label: string; url: string; fallback: string; hint?: string }

/** One Download button with its formats: a record on its own page, or one category of records (ADR-0019). */
export default function DownloadMenu({ choices, label = 'Download', size = 'md', variant = 'default' }: { choices: DownloadChoice[]; label?: string; size?: 'xs' | 'sm' | 'md'; variant?: 'default' | 'ghost' }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // The whole of a person's data asks for their password again, as it always has; one record of theirs does not.
  const run = async (c: DownloadChoice) => {
    setBusy(true);
    try { const name = await withSudo(() => api.downloadFile(c.url, c.fallback)); toast.success(`Downloaded ${name}.`); }
    catch (e) { toast.error(api.errorText(e)); }
    finally { setBusy(false); }
  };
  return (
    <Menu>
      <MenuTrigger asChild><Button size={size} variant={variant} loading={busy}><Download className="h-4 w-4" />{label}</Button></MenuTrigger>
      <MenuContent>
        {choices.map((c) => <MenuItem key={c.url} onSelect={() => run(c)}><span className="flex flex-col"><span>{c.label}</span>{c.hint && <span className="text-2xs text-ink-3">{c.hint}</span>}</span></MenuItem>)}
      </MenuContent>
    </Menu>
  );
}

/** The formats one record downloads in: itself, a spreadsheet row that imports back, and with its files. */
export const recordDownloads = (table: string, id: string, files: boolean): DownloadChoice[] => [
  { label: 'As a Vantage file (JSON)', url: api.recordExportUrl(table, id, 'json'), fallback: `vantage-${table}.json`, hint: 'Imports back into Vantage' },
  { label: 'As a spreadsheet row (CSV)', url: api.recordExportUrl(table, id, 'csv'), fallback: `vantage-${table}.csv` },
  ...(files ? [{ label: 'With its files (ZIP)', url: api.recordExportUrl(table, id, 'zip'), fallback: `vantage-${table}.zip` }] : []),
];

/** One category of the person's own records, in the formats a spreadsheet opens. */
export const categoryDownloads = (section: string): DownloadChoice[] => [
  { label: 'As a spreadsheet (CSV)', url: api.myExportUrl('csv', [section]), fallback: `vantage-${section}.csv`, hint: 'Edit it and import it back' },
  { label: 'As an Excel workbook', url: api.myExportUrl('xlsx', [section]), fallback: `vantage-${section}.xlsx` },
  { label: 'As a Vantage file (JSON)', url: api.myExportUrl('json', [section]), fallback: `vantage-${section}.json` },
];
