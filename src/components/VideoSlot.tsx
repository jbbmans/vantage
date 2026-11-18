import { Video as VideoIcon } from 'lucide-react';
import { olderThanLook, type VideoSlot as Slot } from '@/config/videos';
import { formatDate } from '../../shared/metrics';
import { cn } from '@/lib/utils';

export default function VideoSlotCard({ slot, className }: { slot: Slot; className?: string }) {
  const headingId = `video-${slot.id}-title`;

  return (
    <figure id={`video-${slot.id}`} className={cn('overflow-hidden rounded-lg border border-line bg-surface', className)}>
      <div className="relative aspect-video w-full bg-surface-2">
        {slot.src ? (
          <video
            className="h-full w-full object-cover"
            controls
            preload="none"
            poster={slot.poster}
            aria-labelledby={headingId}
          >
            <source src={slot.src} />
            {slot.captions && <track kind="captions" src={slot.captions} srcLang="en" label="English" default={slot.voiced === false} />}
            Your browser cannot play this video. <a href={slot.src}>Download it instead.</a>
          </video>
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full border border-line-strong bg-surface text-ink-3">
              <VideoIcon className="h-5 w-5" aria-hidden />
            </span>
            <span className="text-xs font-medium uppercase tracking-[0.12em] text-ink-3">Not recorded yet</span>
          </div>
        )}
      </div>

      <figcaption className="border-t border-line p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 id={headingId} className="text-md font-semibold text-ink">{slot.title}</h3>
          <span className="shrink-0 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-2xs font-medium text-ink-3">
            {slot.src ? slot.length : `~${slot.length}`}
          </span>
        </div>
        <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{slot.description}</p>
        {olderThanLook(slot) && (
          <p className="mt-2 text-xs text-ink-3">Recorded {formatDate(slot.published!, 'd MMMM yyyy')}, before the current look, so some screens differ from yours. The tutorials follow this build.</p>
        )}
        {slot.src && slot.transcript?.length ? (
          <details className="mt-2 text-xs leading-relaxed text-ink-2">
            <summary className="cursor-pointer font-medium text-ink">What the film says</summary>
            <ol className="mt-1.5 list-decimal space-y-1 pl-5">
              {slot.transcript.map((line, i) => <li key={i}>{line}</li>)}
            </ol>
          </details>
        ) : null}
        {slot.src && !slot.captions && !slot.textOnly && (
          <p className="mt-2 text-xs text-warn">Captions have not been added to this video yet.</p>
        )}
      </figcaption>
    </figure>
  );
}
