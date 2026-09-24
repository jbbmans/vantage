import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { rand } from '../lib/motion';

const NOISE = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>',
)}")`;

/**
 * The lens: film grain that moves every frame, and a vignette that holds the eye to the middle.
 * Laid over everything, last, the way a grade is.
 */
export function Finish({ grain = 0.055, vignette = 0.55 }: { grain?: number; vignette?: number }) {
  const f = useCurrentFrame();
  const ox = Math.floor(rand(f + 1) * 512);
  const oy = Math.floor(rand(f + 7) * 512);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <AbsoluteFill style={{ background: `radial-gradient(ellipse 75% 70% at 50% 48%, transparent 55%, rgba(0,0,0,${vignette}) 100%)` }} />
      {/* Overlay gives the grain its texture in the light; a faint normal-blend layer carries it into the
          dark, where overlay does nothing, and dithers the gradients there so they do not band. */}
      {grain > 0 && <AbsoluteFill style={{ backgroundImage: NOISE, backgroundPosition: `${ox}px ${oy}px`, opacity: grain, mixBlendMode: 'overlay' }} />}
      {grain > 0 && <AbsoluteFill style={{ backgroundImage: NOISE, backgroundPosition: `${(ox + 211) % 512}px ${(oy + 97) % 512}px`, opacity: grain * 1.1 }} />}
    </AbsoluteFill>
  );
}
