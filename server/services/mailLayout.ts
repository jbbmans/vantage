/**
 * The one look every Vantage email shares: dress blues, as the app wears it (docs/design/DESIGN_SYSTEM.md, ADR-0048).
 * Mail clients are not browsers: Outlook lays out with Word, Gmail drops <style> in some views, Apple Mail and
 * Outlook.com switch to dark on their own. So the structure is tables, every style that matters is inline, the button
 * survives without VML, every coloured element names its colour by a class the dark rules map, nothing is loaded from
 * anywhere (the wordmark is text), and a plain-text part says everything the HTML does.
 */

export interface MailContent {
  title: string;
  intro: string;
  /** A short label above the title: what kind of message this is. */
  eyebrow?: string;
  /** The line an inbox shows beside the subject. Defaults to the start of the intro. */
  preheader?: string;
  cta?: { label: string; url: string };
  /** Facts the reader needs to keep, shown as a labelled card: a username, the sign-in page. */
  details?: Array<{ label: string; value: string; mono?: boolean }>;
  /** Up to four headline figures. */
  stats?: Array<{ label: string; value: string; tone?: 'good' | 'warn' | 'bad' }>;
  sections?: Array<{ heading: string; lines: string[] }>;
  /** A highlighted aside under the button: when a link expires, what to do if this was unexpected. */
  note?: string;
  footer?: string;
  /** The deployment's public URL, for the footer link. */
  origin?: string;
  /**
   * The handling line the deployment prints on its reports (runtime.reportMarking, ADR-0020), above the masthead and
   * under the footer. Vantage never decides a marking itself; a message that carries none leaves it out.
   */
  marking?: string;
}

/**
 * The app's dress-blues tokens (src/styles/index.css), light and dark. The masthead stands on the coat's navy in both
 * schemes, as the app's frame does. Every text colour here is held to 4.5:1 on the grounds it sits on, in both schemes,
 * by tests/server/mailLook.test.ts.
 */
export const MAIL_PALETTE = {
  light: {
    paper: '#F5F4F0', card: '#FFFFFF', panel: '#F1F0EB', line: '#E0DED6',
    ink: '#0B162C', ink2: '#323D54', ink3: '#565F70',
    accent: '#1C4EB2', accentInk: '#FFFFFF', good: '#156E4E', warn: '#8A4F05', bad: '#B2122A',
  },
  dark: {
    paper: '#0A101C', card: '#10192A', panel: '#162136', line: '#24324C',
    ink: '#ECEFF5', ink2: '#B8C2D6', ink3: '#8E9AB2',
    accent: '#8CACFF', accentInk: '#060C1A', good: '#6ECDA5', warn: '#E8BA66', bad: '#FF868C',
  },
  frame: { ground: '#0C1930', ink: '#FFFFFF', gold: '#DEB248', scarlet: '#BA0C2F' },
} as const;

type Scheme = { [K in keyof typeof MAIL_PALETTE.light]: string };

/**
 * What each class becomes in dark mode. A colour is a text rule and a ground is a background or border rule, because
 * Outlook.com marks the two apart ([data-ogsc] for text it recoloured, [data-ogsb] for grounds). Order matters: the
 * note's gold rule comes after the panel's border.
 */
const DARK_RULES: ReadonlyArray<{ cls: string; kind: 'text' | 'ground'; css: (d: Scheme) => string }> = [
  { cls: 'v-bg', kind: 'ground', css: (d) => `background-color:${d.paper}` },
  { cls: 'v-card', kind: 'ground', css: (d) => `background-color:${d.card};border-color:${d.line}` },
  { cls: 'v-panel', kind: 'ground', css: (d) => `background-color:${d.panel};border-color:${d.line}` },
  { cls: 'v-note', kind: 'ground', css: () => `border-left-color:${MAIL_PALETTE.frame.gold}` },
  { cls: 'v-rule', kind: 'ground', css: (d) => `border-color:${d.line}` },
  { cls: 'v-btn-cell', kind: 'ground', css: (d) => `background-color:${d.accent}` },
  { cls: 'v-ink', kind: 'text', css: (d) => `color:${d.ink}` },
  { cls: 'v-ink2', kind: 'text', css: (d) => `color:${d.ink2}` },
  { cls: 'v-ink3', kind: 'text', css: (d) => `color:${d.ink3}` },
  { cls: 'v-good', kind: 'text', css: (d) => `color:${d.good}` },
  { cls: 'v-warn', kind: 'text', css: (d) => `color:${d.warn}` },
  { cls: 'v-bad', kind: 'text', css: (d) => `color:${d.bad}` },
  { cls: 'v-link', kind: 'text', css: (d) => `color:${d.accent}` },
  { cls: 'v-btn', kind: 'text', css: (d) => `color:${d.accentInk}` },
];

/** Classes the dark rules map, for the test that every coloured element is covered. */
export const DARK_CLASSES: readonly string[] = DARK_RULES.map((r) => r.cls);
/** Classes that only lay out (the phone width), with no colour to map. */
export const LAYOUT_CLASSES: readonly string[] = ['v-shell', 'v-pad', 'v-title', 'v-stat', 'v-cta'];

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";
/** The app's book serif, from what is already on the reader's machine: nothing is fetched. */
const SERIF = "'Iowan Old Style',Charter,'Bitstream Charter','Sitka Text',Cambria,Georgia,'Times New Roman',serif";
const MONO = "'SFMono-Regular',Menlo,Consolas,'Liberation Mono',monospace";
const DEFAULT_FOOTER = 'Sent by Vantage. Records stay on the deployment server.';

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Blank lines separate paragraphs; a single line break stays a line break. */
function paragraphs(text: string, style: string) {
  return text.trim().split(/\r?\n\s*\r?\n/).map((p) => `<p class="v-ink2" style="${style}">${escapeHtml(p.trim()).replace(/\r?\n/g, '<br>')}</p>`).join('');
}

function hostOf(origin?: string) {
  try { return origin ? new URL(origin).host : null; } catch { return null; }
}

/** A rule a few pixels high that Outlook does not pad out to a line of text. */
function bar(color: string, height: number, width?: number) {
  const w = width ? ` width="${width}"` : '';
  return `<td${w} height="${height}" bgcolor="${color}" style="${width ? `width:${width}px;` : ''}height:${height}px;line-height:${height}px;font-size:${height}px;mso-line-height-rule:exactly;background-color:${color}">&nbsp;</td>`;
}

function darkCss() {
  const d = MAIL_PALETTE.dark;
  const rule = (prefix: string, r: (typeof DARK_RULES)[number]) => `${prefix}.${r.cls} { ${r.css(d).split(';').map((p) => `${p} !important`).join('; ')}; }`;
  return [
    '  @media (prefers-color-scheme: dark) {',
    ...DARK_RULES.map((r) => `    ${rule('', r)}`),
    '  }',
    // Outlook.com's own dark mode rewrites colours and marks what it touched; these put the palette's back.
    ...DARK_RULES.map((r) => `  ${rule(r.kind === 'text' ? '[data-ogsc] ' : '[data-ogsb] ', r)}`),
  ].join('\n');
}

function text(m: MailContent) {
  const out: string[] = [];
  const marking = m.marking?.trim();
  if (marking) out.push(marking, '');
  out.push(m.eyebrow ? `VANTAGE · ${m.eyebrow.toUpperCase()}` : 'VANTAGE', '', m.title, '', m.intro.trim(), '');
  if (m.stats?.length) out.push(...m.stats.map((s) => `${s.label}: ${s.value}`), '');
  if (m.details?.length) out.push(...m.details.map((d) => `${d.label}: ${d.value}`), '');
  for (const s of (m.sections || []).filter((x) => x.lines.length)) out.push(s.heading.toUpperCase(), ...s.lines.map((l) => `- ${l}`), '');
  if (m.cta) out.push(`${m.cta.label}: ${m.cta.url}`, '');
  if (m.note) out.push(m.note, '');
  // "-- " with its space is the signature line mail readers recognise and fold away.
  out.push('-- ', m.footer || DEFAULT_FOOTER);
  if (hostOf(m.origin)) out.push(`Vantage · ${m.origin}`);
  if (marking) out.push('', marking);
  return out.join('\n');
}

function html(m: MailContent) {
  const L = MAIL_PALETTE.light;
  const F = MAIL_PALETTE.frame;
  const host = hostOf(m.origin);
  const preheader = (m.preheader || m.intro).replace(/\s+/g, ' ').trim().slice(0, 140);
  const toneColor = { good: L.good, warn: L.warn, bad: L.bad } as const;
  const marking = m.marking?.trim();
  const markingRow = (padding: string) => marking
    ? `<tr><td class="v-ink3" align="center" style="padding:${padding};font-family:${SANS};font-size:11px;line-height:16px;font-weight:700;letter-spacing:1px;color:${L.ink3}">${escapeHtml(marking)}</td></tr>`
    : '';

  // The masthead: the wordmark, the eyebrow in gold and the title in the book serif on the coat's navy, and along its
  // foot the piping, a gold pinline over a scarlet stripe. The wordmark is text, so a blocked image never hides it.
  const masthead = `<tr><td class="v-pad" bgcolor="${F.ground}" style="background-color:${F.ground};border-radius:6px 6px 0 0;padding:22px 40px 26px">
      <p style="margin:0 0 22px;font-family:${SANS};font-size:13px;line-height:16px;font-weight:700;letter-spacing:4px;text-transform:uppercase;color:${F.ink}">Vantage</p>
      ${m.eyebrow ? `<p style="margin:0 0 10px;font-family:${SANS};font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${F.gold}">${escapeHtml(m.eyebrow)}</p>` : ''}
      <h1 class="v-title" style="margin:0;font-family:${SERIF};font-size:28px;line-height:34px;font-weight:400;letter-spacing:-0.2px;overflow-wrap:anywhere;word-break:break-word;color:${F.ink}">${escapeHtml(m.title)}</h1>
    </td></tr>
    <tr><td style="font-size:0;line-height:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>${bar(F.gold, 2)}</tr><tr>${bar(F.ground, 2)}</tr><tr>${bar(F.scarlet, 3)}</tr>
    </table></td></tr>`;

  const intro = paragraphs(m.intro, `margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:26px;color:${L.ink2}`);

  // A key figure sits under a short gold rule, the way a printed table marks its total. A toned figure names its tone's
  // class, not the ink's, so dark mode keeps the tone.
  const stats = m.stats?.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 8px"><tr>${m.stats.slice(0, 4).map((s, i) => `
    <td class="v-stat" valign="top" width="${Math.floor(100 / Math.min(4, m.stats!.length))}%" style="padding:${i ? '0 0 0 8px' : '0'}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="v-panel" bgcolor="${L.panel}" style="background-color:${L.panel};border:1px solid ${L.line};border-radius:4px;padding:14px 16px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${bar(F.gold, 2, 24)}</tr></table>
        <p class="${s.tone ? `v-${s.tone}` : 'v-ink'}" style="margin:10px 0 0;font-family:${SANS};font-size:24px;line-height:30px;font-weight:700;color:${s.tone ? toneColor[s.tone] : L.ink}">${escapeHtml(s.value)}</p>
        <p class="v-ink3" style="margin:2px 0 0;font-family:${SANS};font-size:12px;line-height:16px;color:${L.ink3}">${escapeHtml(s.label)}</p>
      </td></tr></table>
    </td>`).join('')}</tr></table>` : '';

  // The facts to keep are a table with a header on each row, so a screen reader says each label with its value.
  const details = m.details?.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 8px"><tr><td class="v-panel" bgcolor="${L.panel}" style="background-color:${L.panel};border:1px solid ${L.line};border-radius:4px;padding:4px 20px">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${m.details.map((d, i) => `<tr>
      <th scope="row" class="v-ink3 v-rule" align="left" valign="top" width="34%" style="padding:12px 12px 12px 0;${i ? `border-top:1px solid ${L.line};` : ''}font-family:${SANS};font-size:13px;line-height:20px;font-weight:400;text-align:left;color:${L.ink3}">${escapeHtml(d.label)}</th>
      <td class="v-ink v-rule" valign="top" style="padding:12px 0;${i ? `border-top:1px solid ${L.line};` : ''}font-family:${d.mono ? MONO : SANS};font-size:${d.mono ? 15 : 14}px;line-height:20px;font-weight:600;color:${L.ink};${d.mono ? 'word-break:break-all' : 'overflow-wrap:anywhere;word-break:break-word'}">${escapeHtml(d.value)}</td>
    </tr>`).join('')}</table>
  </td></tr></table>` : '';

  const sections = (m.sections || []).filter((s) => s.lines.length).map((s) => `
    <h2 class="v-ink3" style="margin:26px 0 8px;font-family:${SANS};font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${L.ink3}">${escapeHtml(s.heading)}</h2>
    <ul class="v-ink2" style="margin:0 0 0 22px;padding:0;list-style-type:square;color:${L.ink2}">${s.lines.map((l) => `
      <li class="v-ink2" style="margin:0 0 6px;padding:0 0 0 2px;font-family:${SANS};font-size:15px;line-height:23px;color:${L.ink2}">${escapeHtml(l)}</li>`).join('')}
    </ul>`).join('');

  const cta = m.cta ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="v-cta" style="margin:28px 0 12px"><tr>
      <td class="v-btn-cell" align="center" bgcolor="${L.accent}" style="background-color:${L.accent};border-radius:4px;mso-padding-alt:14px 28px">
        <a class="v-btn" href="${escapeHtml(m.cta.url)}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${SANS};font-size:16px;line-height:20px;font-weight:600;color:${L.accentInk};text-decoration:none;border-radius:4px;mso-padding-alt:0">${escapeHtml(m.cta.label)}<span aria-hidden="true">&nbsp;&rarr;</span></a>
      </td></tr></table>
    <p class="v-ink3" style="margin:0 0 4px;font-family:${SANS};font-size:12px;line-height:18px;color:${L.ink3}">Or paste this into your browser:</p>
    <p style="margin:0;font-family:${MONO};font-size:12px;line-height:18px;word-break:break-all"><a class="v-link" href="${escapeHtml(m.cta.url)}" target="_blank" style="color:${L.accent};text-decoration:underline">${escapeHtml(m.cta.url)}</a></p>` : '';

  const note = m.note ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0"><tr>
      <td class="v-panel v-note v-ink2" bgcolor="${L.panel}" style="background-color:${L.panel};border:1px solid ${L.line};border-left:3px solid ${F.gold};border-radius:4px;padding:14px 18px;font-family:${SANS};font-size:14px;line-height:22px;color:${L.ink2}"><span class="v-ink2" style="color:${L.ink2}">${escapeHtml(m.note).replace(/\r?\n/g, '<br>')}</span></td>
    </tr></table>` : '';

  const footer = `<tr><td class="v-pad" align="center" style="padding:24px 40px 8px">
      <p class="v-ink3" style="margin:0 0 6px;font-family:${SANS};font-size:12px;line-height:19px;color:${L.ink3}">${escapeHtml(m.footer || DEFAULT_FOOTER)}</p>
      ${host ? `<p class="v-ink3" style="margin:0;font-family:${SANS};font-size:12px;line-height:19px;font-weight:600;color:${L.ink3}">Vantage &middot; <a class="v-ink3" href="${escapeHtml(m.origin!)}" target="_blank" style="color:${L.ink3};font-weight:400;text-decoration:underline">${escapeHtml(host)}</a></p>` : ''}
    </td></tr>`;

  return `<!doctype html>
<html lang="en" dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,address=no,email=no,date=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escapeHtml(m.title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
  @media only screen and (max-width: 620px) {
    .v-shell { width: 100% !important; }
    .v-pad { padding-left: 24px !important; padding-right: 24px !important; }
    .v-title { font-size: 24px !important; line-height: 30px !important; }
    .v-stat { display: inline-block !important; width: 50% !important; box-sizing: border-box !important; padding: 0 4px 8px 0 !important; }
    .v-cta { width: 100% !important; }
    .v-cta a { display: block !important; }
  }
${darkCss()}
</style>
</head>
<body class="v-bg" style="margin:0;padding:0;word-spacing:normal;background-color:${L.paper}">
<div role="article" aria-roledescription="email" aria-label="${escapeHtml(m.title)}" lang="en" dir="ltr" class="v-bg" style="background-color:${L.paper}">
<div aria-hidden="true" style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${L.paper}">${escapeHtml(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>
<table role="presentation" class="v-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${L.paper}" style="background-color:${L.paper}">
  <tr><td align="center" style="padding:32px 12px 40px">
    <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <table role="presentation" class="v-shell" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
      ${markingRow('0 0 12px')}
      ${masthead}
      <tr><td class="v-card v-pad" bgcolor="${L.card}" style="background-color:${L.card};border:1px solid ${L.line};border-top:0;border-radius:0 0 6px 6px;padding:32px 40px 34px;overflow-wrap:anywhere;word-break:break-word">
        ${intro}${stats}${details}${sections}${cta}${note}
      </td></tr>
      ${footer}
      ${markingRow('12px 0 0')}
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr>
</table>
</div>
</body>
</html>`;
}

export function layout(m: MailContent) {
  return { text: text(m), html: html(m) };
}
