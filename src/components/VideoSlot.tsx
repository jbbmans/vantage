import { Play, Video as VideoIcon } from 'lucide-react';
import type { VideoSlot as Slot } from '@/config/videos';
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
        {slot.src && !slot.captions && (
          <p className="mt-2 text-xs text-warn">Captions have not been added to this video yet.</p>
        )}
      </figcaption>
    </figure>
  );
}

/** The compact form, for a row of links beside written instructions. */
export function VideoLink({ slot }: { slot: Slot }) {
  return (
    <a
      href={`/help#video-${slot.id}`}
      className={cn(
        'inline-flex items-center gap-2 rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-surface-2',
        slot.src ? 'text-accent' : 'text-ink-3',
      )}
    >
      <Play className="h-3 w-3" aria-hidden />
      {slot.title}
      {!slot.src && <span className="text-ink-3">· not recorded yet</span>}
    </a>
  );
}
