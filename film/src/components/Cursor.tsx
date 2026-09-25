export function Pointer({ x, y, size, press, opacity }: { x: number; y: number; size: number; press: number; opacity: number }) {
  if (opacity <= 0.001) return null;
  const s = size * (1 - press * 0.12);
  return (
    <svg width={s} height={s * 1.25} viewBox="0 0 24 30" style={{ position: 'absolute', left: x - s * 0.12, top: y - s * 0.06, opacity, overflow: 'visible', filter: 'drop-shadow(0 3px 5px rgba(3,10,25,0.35)) drop-shadow(0 1px 1px rgba(3,10,25,0.4))' }}>
      <path d="M2.5 1.8 L2.5 23.4 L8.3 18.1 L12.1 27 L15.9 25.3 L12.2 16.6 L20 16.3 Z" fill="#0b1426" stroke="#ffffff" strokeWidth="1.9" strokeLinejoin="round" />
    </svg>
  );
}

export function Ripple({ x, y, k, size }: { x: number; y: number; k: number; size: number }) {
  const r = size * (0.3 + k * 1.1);
  return (
    <div style={{ position: 'absolute', left: x - r, top: y - r, width: r * 2, height: r * 2, borderRadius: '50%', border: `${Math.max(1.5, size * 0.07)}px solid rgba(47,107,255,${0.55 * (1 - k)})`, background: `rgba(47,107,255,${0.12 * (1 - k)})` }} />
  );
}

/** A keycap, for "press N". */
export function Keycap({ label, k, pressed }: { label: string; k: number; pressed: boolean }) {
  const inT = Math.min(1, k / 0.15);
  const outT = k > 0.8 ? (k - 0.8) / 0.2 : 0;
  const o = inT * (1 - outT);
  return (
    <div style={{ position: 'absolute', left: '50%', bottom: 70, transform: `translate(-50%, ${(1 - inT) * 18 + (pressed ? 4 : 0)}px) scale(${pressed ? 0.96 : 1})`, opacity: o, display: 'flex', alignItems: 'center', gap: 16, fontFamily: "'Geist', sans-serif" }}>
      <div style={{ minWidth: 76, height: 76, padding: '0 22px', borderRadius: 18, background: 'linear-gradient(180deg, #ffffff, #e9edf5)', boxShadow: pressed ? '0 2px 0 #b9c2d3, 0 8px 18px -6px rgba(3,10,25,.5)' : '0 6px 0 #b9c2d3, 0 18px 34px -10px rgba(3,10,25,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 38, fontWeight: 600, color: '#0b1426', letterSpacing: '-0.02em' }}>
        {label.length === 1 ? label.toUpperCase() : label}
      </div>
    </div>
  );
}
