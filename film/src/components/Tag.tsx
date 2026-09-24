import { useCurrentFrame } from 'remotion';
import { p } from '../lib/motion';
import { FONT } from '../theme';

/** Honest in every product shot: the data is invented. */
export function SyntheticTag({ at = 0, out }: { at?: number; out?: number }) {
  const f = useCurrentFrame();
  const o = p(f, at, at + 20) * (out != null ? 1 - p(f, out - 12, out) : 1);
  return (
    <div style={{ position: 'absolute', right: 56, bottom: 44, fontFamily: FONT, fontSize: 16, letterSpacing: '0.08em', color: 'rgba(201,213,232,0.55)', opacity: o, display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: 'rgba(63,208,189,0.8)' }} />Synthetic demo data
    </div>
  );
}
