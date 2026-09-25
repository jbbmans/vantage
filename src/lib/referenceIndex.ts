import { GLOSSARY, METHOD_LIST, NORMAL_LIST, UMT_ERRORS, INVOICE_HOLDS, DAI_RESPONSIBILITIES } from '../../shared/fmra';

export interface ReferenceHit { id: string; title: string; subtitle: string; to: string }

const entries: Array<ReferenceHit & { text: string }> = [
  ...NORMAL_LIST.map((c) => ({ id: `ref-cond-${c.key}`, title: `${c.abbr} — ${c.name}`, subtitle: c.whatIsOpen, to: `/reference?tab=conditions#${c.key}`, text: `${c.abbr} ${c.name} ${c.whatIsOpen} ${c.causes.map((x) => x.label).join(' ')}` })),
  ...METHOD_LIST.map((m) => ({ id: `ref-method-${m.key}`, title: m.name, subtitle: m.use, to: `/reference?tab=methods&method=${m.key}`, text: `${m.name} ${m.short} ${m.use} ${m.systems.join(' ')} ${m.tool} ${[...m.ksd.request, ...m.ksd.receipt, ...m.ksd.payment].join(' ')}` })),
  ...UMT_ERRORS.map((e) => ({ id: `ref-umt-${e.key}`, title: `UMT: ${e.label}`, subtitle: `${e.correction} (${e.route})`, to: '/reference?tab=abnormal#umt', text: `UMT unmatched ${e.label} ${e.correction} ${e.route}` })),
  ...INVOICE_HOLDS.causes.map((h) => ({ id: `ref-hold-${h.key}`, title: `Hold: ${h.label}`, subtitle: h.correction, to: '/reference?tab=abnormal#holds', text: `invoice hold ${h.label} ${h.correction}` })),
  ...DAI_RESPONSIBILITIES.map((r) => ({ id: `ref-role-${r.key}`, title: r.name, subtitle: r.capability, to: '/reference?tab=roles', text: `${r.name} ${r.capability} ${r.typical}` })),
  ...GLOSSARY.map((t, i) => ({ id: `ref-term-${i}`, title: t.term, subtitle: t.meaning, to: `/reference?tab=glossary&q=${encodeURIComponent(t.term.split(' ')[0])}`, text: `${t.term} ${t.meaning}` })),
];

export function searchReference(query: string, limit = 6): ReferenceHit[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  return entries
    .map((e) => {
      const hay = e.text.toLowerCase();
      const title = e.title.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return null;
      const score = words.reduce((s, w) => s + (title.startsWith(w) ? 4 : title.includes(w) ? 2 : 1), 0);
      return { e, score };
    })
    .filter(Boolean)
    .sort((a, b) => b!.score - a!.score)
    .slice(0, limit)
    .map((x) => ({ id: x!.e.id, title: x!.e.title, subtitle: x!.e.subtitle, to: x!.e.to }));
}
