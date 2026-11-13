import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Download, Printer } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/toast';
import { withSudo } from '@/components/SudoDialog';
import { CounselingWorksheet } from '@/components/Counseling';
import * as api from '@/lib/api';

/**
 * A counseling's worksheet laid out for paper (Task 20, ADR-0027), outside the app's frame, as a report's is (ADR-0020):
 * the preview of what prints, with Print and the PDF. Opening it asks the server for the worksheet to print, which
 * records the print in the audit trail. `?revision=N` reads an earlier text of an amended counseling.
 */
export default function PrintCounseling() {
  const { id = '' } = useParams();
  const [search] = useSearchParams();
  const toast = useToast();
  const revision = Number(search.get('revision')) || null;
  const autoprint = search.get('autoprint') === '1';
  const { data: doc, error, isPending } = useQuery({ queryKey: ['counseling-worksheet', id, 'print', revision], queryFn: () => api.counselingWorksheet(id, { revision, purpose: 'print' }), staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, retry: false });
  const [downloading, setDownloading] = useState(false);
  const printed = useRef(false);
  useEffect(() => {
    if (doc) document.title = `${doc.type_label} counseling${doc.date ? `, ${doc.date}` : ''} · Vantage`;
    if (doc && autoprint && !printed.current) { printed.current = true; window.setTimeout(() => window.print(), 150); }
  }, [doc, autoprint]);
  // Opened in its own tab, it has nowhere to go back to: Back opens the counseling there.
  const back = () => { if (window.history.length > 1) window.history.back(); else window.location.assign(`/career/counseling?open=${encodeURIComponent(id)}`); };
  const pdf = async () => {
    if (!doc) return;
    setDownloading(true);
    try { const name = await withSudo(() => api.downloadFile(api.counselingPdfUrl(id, revision), `vantage-counseling-${id.slice(0, 8)}-r${doc.revision}.pdf`)); toast.success(`Downloaded ${name}.`); }
    catch (e) { toast.error(api.errorText(e)); }
    finally { setDownloading(false); }
  };

  return (
    <div className="report-print-page">
      <div className="report-print-bar no-print" role="toolbar" aria-label="Print">
        <Button size="sm" variant="ghost" onClick={back}><ArrowLeft className="h-4 w-4" aria-hidden />Back</Button>
        <p className="min-w-0 flex-1 text-xs text-ink-3">Laid out for Letter paper.</p>
        <Button size="sm" onClick={pdf} loading={downloading} disabled={!doc}><Download className="h-4 w-4" aria-hidden />PDF</Button>
        <Button size="sm" variant="primary" onClick={() => window.print()} disabled={!doc}><Printer className="h-4 w-4" aria-hidden />Print</Button>
      </div>
      <main id="main" className="report-print-sheet cw-sheet">
        {isPending ? <div aria-busy="true"><h1 className="sr-only">Preparing the worksheet</h1><Skeleton className="h-10 w-72" /><Skeleton className="mt-4 h-64" /></div>
          : error || !doc ? <><h1 className="sr-only">Worksheet not available</h1><EmptyState title="Could not prepare the worksheet" description={api.errorText(error)} /></>
            : <CounselingWorksheet doc={doc} variant="print" />}
      </main>
    </div>
  );
}
