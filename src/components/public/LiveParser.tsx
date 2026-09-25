import { useEffect, useMemo, useRef, useState } from 'react';
import { parseQuickLog } from '../../../shared/quickLog';

const EXAMPLES = [
  'Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday',
  'Processed 12 MIPRs with zero returns last week',
  'Recovered $9,400 in expiring year funds before the deadline',
  'Trained 2 junior Marines on DAI reconciliation',
];

function useTypewriter(text: string, active: boolean, speed = 38) {
  const [shown, setShown] = useState('');
  useEffect(() => {
    if (!active) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(text);
      return;
    }
    setShown('');
    let i = 0;
    const tick = window.setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) window.clearInterval(tick);
    }, speed);
    return () => window.clearInterval(tick);
  }, [text, active, speed]);
  return shown;
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="parse-chip">
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

export default function LiveParser() {
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const [example, setExample] = useState(0);
  const box = useRef<HTMLTextAreaElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const [demoing, setDemoing] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el || touched) return;
    if (!('IntersectionObserver' in window)) { setDemoing(true); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setDemoing(true); io.disconnect(); }
    }, { threshold: 0.4 });
    io.observe(el);
    return () => io.disconnect();
  }, [touched]);

  const typed = useTypewriter(EXAMPLES[example], demoing && !touched);
  const value = touched ? text : typed;
  const parsed = useMemo(() => parseQuickLog(value), [value]);
  const hasSomething = value.trim().length > 2;

  const pickExample = (i: number) => {
    setExample(i);
    setTouched(true);
    setText(EXAMPLES[i]);
    box.current?.focus();
  };

  return (
    <div className="live-parser" ref={host}>
      <div className="live-parser-head">
        <span className="live-parser-dot" aria-hidden />
        <strong>Try it — this is the real parser</strong>
        <span>nothing is sent anywhere</span>
      </div>

      <label className="live-parser-label" htmlFor="live-parser-input">What did you do?</label>
      <textarea
        id="live-parser-input"
        ref={box}
        className="live-parser-input"
        rows={2}
        value={value}
        spellCheck={false}
        placeholder="Reconciled 30 ULOs totaling $1,118.38 in DAI yesterday"
        onChange={(e) => { setTouched(true); setText(e.target.value); }}
        onFocus={() => { if (!touched) { setTouched(true); setText(typed); } }}
      />

      <div className="live-parser-out" aria-live={touched ? 'polite' : 'off'}>
        {hasSomething ? (
          <>
            {parsed.quantities.slice(0, 2).map((q) => (
              <Chip key={`${q.value}-${q.unit}`} label="how many" value={`${q.value.toLocaleString()} ${q.unit}`} />
            ))}
            {parsed.dollar_amount != null && (
              <Chip label={parsed.dollar_type || 'value'} value={`$${parsed.dollar_amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
            )}
            {parsed.system && <Chip label="system" value={parsed.system} />}
            <Chip label="when" value={parsed.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} />
            <Chip label="category" value={parsed.category} />
            <Chip label="evaluation area" value={parsed.eval_area} />
          </>
        ) : (
          <p className="live-parser-hint">Write it the way you would say it out loud.</p>
        )}
      </div>

      <div className="live-parser-examples">
        <span>Or try:</span>
        {EXAMPLES.map((ex, i) => (
          <button key={ex} type="button" onClick={() => pickExample(i)} className={i === example && touched ? 'on' : undefined}>
            {ex.split(' ').slice(0, 3).join(' ')}…
          </button>
        ))}
      </div>
    </div>
  );
}
