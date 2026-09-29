/**
 * The one look every Vantage email shares. Mail clients are not browsers: Outlook lays out with Word, Gmail
 * drops <style> in some views, and most block images until asked. So the structure is tables, every style that
 * matters is inline, the button survives without VML, the mark is a PNG with the wordmark beside it in live
 * text, and a plain-text part says everything the HTML does.
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
  /** The deployment's public URL, for the mark and the footer link. */
  origin?: string;
}

const C = {
  canvas: '#EEF2F7', card: '#FFFFFF', line: '#E3E8EF', panel: '#F5F7FA',
  ink: '#0A1B33', ink2: '#3A4C65', ink3: '#5C6C82',
  navy: '#0B2D5B', teal: '#14B8A6', tealInk: '#0F766E', blue: '#2563EB', button: '#1D4ED8',
  noteBg: '#ECFDF9', noteLine: '#99E6DA',
  good: '#157352', warn: '#9A5A06', bad: '#B42826',
};
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Helvetica,Arial,sans-serif";
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

function text(m: MailContent) {
  const out: string[] = [];
  out.push(m.eyebrow ? `VANTAGE · ${m.eyebrow.toUpperCase()}` : 'VANTAGE', '', m.title, '', m.intro.trim(), '');
  if (m.stats?.length) out.push(...m.stats.map((s) => `${s.label}: ${s.value}`), '');
  if (m.details?.length) out.push(...m.details.map((d) => `${d.label}: ${d.value}`), '');
  for (const s of (m.sections || []).filter((x) => x.lines.length)) out.push(s.heading.toUpperCase(), ...s.lines.map((l) => `- ${l}`), '');
  if (m.cta) out.push(`${m.cta.label}: ${m.cta.url}`, '');
  if (m.note) out.push(m.note, '');
  out.push('--', m.footer || DEFAULT_FOOTER);
  const host = hostOf(m.origin);
  if (host) out.push(`Vantage · ${m.origin}`);
  return out.join('\n');
}

function html(m: MailContent) {
  const host = hostOf(m.origin);
  const secureOrigin = m.origin && /^https:\/\//i.test(m.origin) ? m.origin.replace(/\/+$/, '') : null;
  const preheader = (m.preheader || m.intro).replace(/\s+/g, ' ').trim().slice(0, 140);
  const toneColor = { good: C.good, warn: C.warn, bad: C.bad } as const;

  const mark = secureOrigin
    ? `<td valign="middle" style="padding-right:12px"><img src="${escapeHtml(secureOrigin)}/brand/email-mark.png" width="36" height="36" alt="" style="display:block;width:36px;height:36px;border:0"></td>`
    : '';
  const header = `<tr><td class="v-pad" bgcolor="${C.navy}" style="background:${C.navy};border-radius:16px 16px 0 0;padding:22px 40px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>${mark}
      <td valign="middle" style="font-family:${SANS};font-size:15px;line-height:20px;font-weight:700;letter-spacing:4px;color:#FFFFFF">VANTAGE</td>
    </tr></table></td></tr>
    <tr><td style="font-size:0;line-height:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td width="62%" height="4" bgcolor="${C.teal}" style="background:${C.teal};height:4px;font-size:0;line-height:0">&nbsp;</td>
      <td width="38%" height="4" bgcolor="${C.blue}" style="background:${C.blue};height:4px;font-size:0;line-height:0">&nbsp;</td>
    </tr></table></td></tr>`;

  const eyebrow = m.eyebrow ? `<p class="v-teal" style="margin:0 0 10px;font-family:${SANS};font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${C.tealInk}">${escapeHtml(m.eyebrow)}</p>` : '';
  const title = `<h1 class="v-ink v-title" style="margin:0 0 16px;font-family:${SANS};font-size:26px;line-height:32px;font-weight:700;letter-spacing:-0.3px;color:${C.ink}">${escapeHtml(m.title)}</h1>`;
  const intro = paragraphs(m.intro, `margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:26px;color:${C.ink2}`);

  const stats = m.stats?.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 8px"><tr>${m.stats.slice(0, 4).map((s, i) => `
    <td class="v-stat" valign="top" width="${Math.floor(100 / Math.min(4, m.stats!.length))}%" style="padding:${i ? '0 0 0 8px' : '0'}">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="v-panel" style="background:${C.panel};border:1px solid ${C.line};border-radius:12px;padding:14px 16px">
        <p class="v-ink" style="margin:0;font-family:${SANS};font-size:24px;line-height:30px;font-weight:700;color:${s.tone ? toneColor[s.tone] : C.ink}">${escapeHtml(s.value)}</p>
        <p class="v-ink3" style="margin:2px 0 0;font-family:${SANS};font-size:12px;line-height:16px;color:${C.ink3}">${escapeHtml(s.label)}</p>
      </td></tr></table>
    </td>`).join('')}</tr></table>` : '';

  const details = m.details?.length ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 8px"><tr><td class="v-panel" style="background:${C.panel};border:1px solid ${C.line};border-radius:12px;padding:6px 20px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${m.details.map((d, i) => `<tr>
      <td class="v-ink3 v-rule" valign="top" width="34%" style="padding:12px 12px 12px 0;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${SANS};font-size:13px;line-height:20px;color:${C.ink3}">${escapeHtml(d.label)}</td>
      <td class="v-ink v-rule" valign="top" style="padding:12px 0;${i ? `border-top:1px solid ${C.line};` : ''}font-family:${d.mono ? MONO : SANS};font-size:${d.mono ? 15 : 14}px;line-height:20px;font-weight:600;color:${C.ink};word-break:break-all">${escapeHtml(d.value)}</td>
    </tr>`).join('')}</table>
  </td></tr></table>` : '';

  const sections = (m.sections || []).filter((s) => s.lines.length).map((s) => `
    <p class="v-ink3" style="margin:24px 0 8px;font-family:${SANS};font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${C.ink3}">${escapeHtml(s.heading)}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${s.lines.map((l) => `<tr>
      <td valign="top" width="18" style="padding:9px 0 0;font-size:0;line-height:0"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="6" height="6" bgcolor="${C.teal}" style="width:6px;height:6px;background:${C.teal};border-radius:3px;font-size:0;line-height:0">&nbsp;</td></tr></table></td>
      <td class="v-ink2" valign="top" style="padding:0 0 8px;font-family:${SANS};font-size:15px;line-height:23px;color:${C.ink2}">${escapeHtml(l)}</td>
    </tr>`).join('')}</table>`).join('');

  const cta = m.cta ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="v-btn" style="margin:28px 0 12px"><tr>
      <td align="center" bgcolor="${C.button}" style="background:${C.button};border-radius:10px;mso-padding-alt:15px 30px">
        <a href="${escapeHtml(m.cta.url)}" target="_blank" style="display:inline-block;padding:15px 30px;font-family:${SANS};font-size:16px;line-height:20px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:10px;mso-padding-alt:0">${escapeHtml(m.cta.label)}&nbsp;&rarr;</a>
      </td></tr></table>
    <p class="v-ink3" style="margin:0 0 4px;font-family:${SANS};font-size:12px;line-height:18px;color:${C.ink3}">Or paste this into your browser:</p>
    <p style="margin:0;font-family:${MONO};font-size:12px;line-height:18px;word-break:break-all"><a class="v-link" href="${escapeHtml(m.cta.url)}" target="_blank" style="color:${C.button};text-decoration:underline">${escapeHtml(m.cta.url)}</a></p>` : '';

  const note = m.note ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0"><tr>
      <td class="v-note" style="background:${C.noteBg};border:1px solid ${C.noteLine};border-left:4px solid ${C.teal};border-radius:10px;padding:14px 18px;font-family:${SANS};font-size:14px;line-height:22px;color:${C.ink2}"><span class="v-ink2">${escapeHtml(m.note).replace(/\r?\n/g, '<br>')}</span></td>
    </tr></table>` : '';

  const footer = `<tr><td class="v-pad" align="center" style="padding:24px 40px 8px;font-family:${SANS};font-size:12px;line-height:19px;color:${C.ink3}">
      <p class="v-ink3" style="margin:0 0 6px;color:${C.ink3}">${escapeHtml(m.footer || DEFAULT_FOOTER)}</p>
      ${host ? `<p style="margin:0"><a href="${escapeHtml(m.origin!)}" target="_blank" style="color:${C.ink3};text-decoration:none;font-weight:600">Vantage</a><span class="v-ink3" style="color:${C.ink3}"> &middot; </span><a href="${escapeHtml(m.origin!)}" target="_blank" style="color:${C.ink3};text-decoration:underline">${escapeHtml(host)}</a></p>` : ''}
    </td></tr>`;

  return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
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
  img { -ms-interpolation-mode: bicubic; }
  a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
  @media only screen and (max-width: 620px) {
    .v-shell { width: 100% !important; }
    .v-pad { padding-left: 24px !important; padding-right: 24px !important; }
    .v-title { font-size: 23px !important; line-height: 29px !important; }
    .v-stat { display: inline-block !important; width: 50% !important; box-sizing: border-box !important; padding: 0 4px 8px 0 !important; }
    .v-btn { width: 100% !important; }
    .v-btn a { display: block !important; }
  }
  @media (prefers-color-scheme: dark) {
    .v-bg { background: #0B1320 !important; }
    .v-card { background: #111C2E !important; border-color: #253752 !important; }
    .v-panel { background: #17253B !important; border-color: #253752 !important; }
    .v-rule { border-color: #253752 !important; }
    .v-note { background: #0E2A2B !important; border-color: #1F5F58 !important; border-left-color: #2DD4BF !important; }
    .v-ink { color: #EAF0F8 !important; }
    .v-ink2 { color: #B4C4DA !important; }
    .v-ink3 { color: #8C9EB8 !important; }
    .v-teal { color: #2DD4BF !important; }
    .v-link { color: #8AB4FF !important; }
  }
</style>
</head>
<body class="v-bg" style="margin:0;padding:0;background:${C.canvas}">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.canvas}">${escapeHtml(preheader)}${'&#847;&zwnj;&nbsp;'.repeat(40)}</div>
<table role="presentation" class="v-bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${C.canvas}" style="background:${C.canvas}">
  <tr><td align="center" style="padding:32px 12px 40px">
    <!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <table role="presentation" class="v-shell" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px">
      ${header}
      <tr><td class="v-card v-pad" bgcolor="${C.card}" style="background:${C.card};border:1px solid ${C.line};border-top:0;border-radius:0 0 16px 16px;padding:36px 40px 36px">
        ${eyebrow}${title}${intro}${stats}${details}${sections}${cta}${note}
      </td></tr>
      ${footer}
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr>
</table>
</body>
</html>`;
}

export function layout(m: MailContent) {
  return { text: text(m), html: html(m) };
}
