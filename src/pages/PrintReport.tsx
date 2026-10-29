import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, Printer } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '@/components/ui/primitives';
import ReportDocumentView from '@/components/ReportDocumentView';
import * as api from '@/lib/api';
import { REPORT_PARAM_KEYS, printsWide } from '../../shared/reportCatalog';

/**
 * A report laid out for paper (ADR-0020), outside the app's frame: no menu, header or footer, and the two buttons above
 * it never print. Opening it asks the server for the report to print, which records the print in the audit trail.
 */
export default function PrintReport() {
  const [search] = useSearchParams();
  const params = useMemo(() => {
    const out: Record<string, string> = {};
    for (const k of ['type', ...REPORT_PARAM_KEYS]) { const v = search.get(k); if (v) out[k] = v; }
    return out;
  }, [search]);
  const autoprint = search.get('autoprint') === '1';
  const { data: doc, error, isPending } = useQuery({ queryKey: ['report-center', 'print', params], queryFn: () => api.runReport(params, 'print'), staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false });
  const printed = useRef(false);
  useEffect(() => {
    if (doc) document.title = `${doc.title}: ${doc.about} · Vantage`;
    if (doc && autoprint && !printed.current) { printed.current = true; window.setTimeout(() => window.print(), 150); }
  }, [doc, autoprint]);
  // Opened from the library in its own tab, it has nowhere to go back to: Back opens the library there.
  const back = () => { if (window.history.length > 1) window.history.back(); else window.location.assign('/reports/library'); };

  return (
    <div className="report-print-page">
      <div className="report-print-bar no-print" role="toolbar" aria-label="Print">
        <Button size="sm" variant="ghost" onClick={back}><ArrowLeft className="h-4 w-4" aria-hidden />Back</Button>
        <p className="min-w-0 flex-1 text-xs text-ink-3">{doc && printsWide(doc) ? 'Laid out for Letter paper, landscape for its wide table. If the print dialog shows it upright, choose landscape there.' : 'Laid out for Letter paper.'}</p>
        <Button size="sm" variant="primary" onClick={() => window.print()} disabled={!doc}><Printer className="h-4 w-4" aria-hidden />Print</Button>
      </div>
      <main id="main" className="report-print-sheet">
        {isPending ? <div aria-busy="true"><h1 className="sr-only">Preparing the report</h1><Skeleton className="h-10 w-72" /><Skeleton className="mt-4 h-64" /></div>
          : error || !doc ? <><h1 className="sr-only">Report not available</h1><EmptyState title="Could not prepare the report" description={api.errorText(error)} /></>
            : <ReportDocumentView doc={doc} variant="print" />}
      </main>
    </div>
  );
}
