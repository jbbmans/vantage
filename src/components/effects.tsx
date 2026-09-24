import { m, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

/**
 * Decorative effects for the premium layer (src/styles/premium.css). Every one is aria-hidden or
 * keeps its text in the accessibility tree unchanged, and every one is still under reduced motion.
 */

/** The fixed field of light, dots and grain behind the whole signed-in app. */
export function Ambient() {
  return (
    <div className="ambient no-print" aria-hidden>
      <div className="ambient-grid" />
      <div className="ambient-grain" />
    </div>
  );
}

/**
 * Light travelling around the border of the thing to do next. Place inside a positioned element
 * with a border radius; it follows the radius and never takes pointer events.
 */
export function BorderBeam({ className }: { className?: string }) {
  return (
    <>
      <span className={cn('beam-glow', className)} aria-hidden />
      <span className={cn('beam', className)} aria-hidden />
    </>
  );
}

/**
 * A heading whose words arrive out of a soft blur, one after another. Screen readers get the
 * whole phrase once, from aria-label; the animated words are hidden from them. With reduced motion
 * requested it is plain text.
 */
export function BlurText({ text, className, as: Tag = 'h1', delay = 0 }: { text: string; className?: string; as?: 'h1' | 'h2' | 'p' | 'span'; delay?: number }) {
  const reduce = useReducedMotion();
  if (reduce) return <Tag className={className}>{text}</Tag>;
  const words = text.split(' ');
  return (
    <Tag className={className} aria-label={text}>
      <span aria-hidden>
        {words.map((word, i) => (
          <m.span
            key={`${word}-${i}`}
            className="inline-block whitespace-pre"
            initial={{ opacity: 0, y: 12, filter: 'blur(10px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 0.55, delay: delay + i * 0.08, ease: [0.16, 1, 0.3, 1] }}
          >
            {word}{i < words.length - 1 ? ' ' : ''}
          </m.span>
        ))}
      </span>
    </Tag>
  );
}

/** A small live dot. `live` makes it breathe; the colour comes from the surrounding text. */
export function StatusDot({ live = false, className }: { live?: boolean; className?: string }) {
  return <span className={cn('status-dot', className)} data-live={live ? '' : undefined} aria-hidden />;
}
