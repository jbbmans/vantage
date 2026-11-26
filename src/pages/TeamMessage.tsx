import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Download, Paperclip } from 'lucide-react';
import { PageHeader, Panel, Skeleton } from '@/components/ui/primitives';
import { QueryFailure } from '@/components/QueryFailure';
import * as api from '@/lib/api';
import { formatDate } from '../../shared/metrics';
import { formatStamp } from '@/lib/utils';
import { ATTACHMENT_TYPE_NAMES, formatFileSize } from '../../shared/attachments';
import type { TeamMessageDelivery, TeamMessageView } from '../../shared/teamMessages';

/** How the Marines a message went to were reached, in the order the sender reads them. */
const DELIVERY_WORDS: Array<[TeamMessageDelivery, string]> = [
  ['emailed', 'by email'], ['queued', 'waiting on their mail server'], ['pending', 'being sent'], ['failed', 'not delivered by email'],
  ['refused', 'not emailed (an address Vantage does not send to)'], ['app_only', 'in Vantage only'],
];

function deliverySummary(delivery: NonNullable<TeamMessageView['delivery']>): string {
  const total = Object.values(delivery).reduce((n, c) => n + c, 0);
  const parts = DELIVERY_WORDS.filter(([k]) => delivery[k]).map(([k, words]) => `${delivery[k]} ${words}`);
  return `Sent to ${total} ${total === 1 ? 'Marine' : 'Marines'}${parts.length ? `: ${parts.join(', ')}` : ''}. Everyone it went to has it in Vantage.`;
}

/**
 * A leader's message to a unit as Vantage keeps it (ADR-0049): what the email and the notice open. Only its sender and
 * the Marines it went to can open it, while they are members of its Unit Instance.
 */
export default function TeamMessage() {
  const { id = '' } = useParams();
  const message = useQuery({ queryKey: ['team-message', id], queryFn: () => api.teamMessage(id), retry: false });
  if (message.isPending) return <div className="space-y-4"><Skeleton className="h-28" /><Skeleton className="h-64" /></div>;
  if (message.isError) return <QueryFailure error={message.error} onRetry={() => void message.refetch()} what="This message" />;
  const m = message.data;
  return (
    <div className="space-y-6">
      <PageHeader eyebrow={`Message to ${m.unitLabel}`} title={m.subject} lede={`From ${m.senderName} to ${m.unitName} and every team beneath it, ${formatStamp(m.sentAt)}.`} />
      <p className="text-2xs font-semibold uppercase tracking-wide text-ink-3">{m.marking}</p>
      <Panel title="Message">
        <div className="whitespace-pre-wrap text-base leading-relaxed text-ink [overflow-wrap:anywhere]">{m.body}</div>
      </Panel>
      {m.files.length > 0 && (
        <Panel title={m.files.length === 1 ? 'Attached file' : `${m.files.length} attached files`} subtitle="Each was scanned for malware and found clean before it was sent.">
          <ul className="divide-y divide-line">
            {m.files.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <Paperclip className="h-4 w-4 shrink-0 text-ink-3" aria-hidden />
                <a href={api.teamMessageFileUrl(m.id, f.id)} className="link min-w-0 flex-1 text-sm [overflow-wrap:anywhere]" download>{f.name}</a>
                <span className="text-2xs text-ink-3">{ATTACHMENT_TYPE_NAMES[f.mime] ?? f.mime}, {formatFileSize(f.size)}</span>
                <a href={api.teamMessageFileUrl(m.id, f.id)} download className="inline-flex items-center gap-1 text-2xs font-medium text-accent hover:underline" aria-label={`Download ${f.name}`}><Download className="h-3.5 w-3.5" aria-hidden />Download</a>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {m.delivery && <p className="text-sm text-ink-2">{deliverySummary(m.delivery)}</p>}
      <p className="text-2xs leading-relaxed text-ink-3">Vantage keeps this message{m.files.length ? ' and its files' : ''} until {formatDate(m.keptUntil)}, unless a legal hold keeps it longer.</p>
      <Link to="/team" className="link inline-flex items-center gap-1 text-sm"><ArrowLeft className="h-4 w-4" aria-hidden />Back to Team</Link>
    </div>
  );
}
