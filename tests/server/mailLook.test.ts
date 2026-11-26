import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DARK_CLASSES, LAYOUT_CLASSES, MAIL_PALETTE, layout } from '../../server/services/mailLayout.ts';
import { MAIL_SAMPLES, SAMPLE_MARKING } from './mailSamples.ts';
import { startApp, enroll, type TestApp } from './helpers.ts';
import { MAIL_KINDS } from '../../server/services/email.ts';

// The one look every message wears (ADR-0048): dress blues, nothing fetched when it opens, and as readable in a dark
// inbox as in a light one.

type Rgb = [number, number, number];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const linear = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const contrast = (a: string, b: string) => { const [x, y] = [luminance(rgb(a)), luminance(rgb(b))]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const KINDS = Object.keys(MAIL_SAMPLES);
/** Every opening tag in a message, with its attributes. */
const tags = (html: string) => [...html.matchAll(/<([a-z][a-z0-9]*)\b([^>]*)>/gi)].map((m) => ({ name: m[1].toLowerCase(), attrs: m[2] }));
const classesOf = (attrs: string) => (attrs.match(/\bclass="([^"]*)"/)?.[1] || '').split(/\s+/).filter(Boolean);
/** The HTML with the <style> block and the Outlook conditionals left out, so only what a reader's client lays out is checked. */
const body = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, '').replace(/<!--\[if mso\]>[\s\S]*?<!\[endif\]-->/g, '');

test('the seven messages are the seven kinds the mailer knows', () => {
  assert.deepEqual([...KINDS].sort(), [...MAIL_KINDS].sort());
  assert.equal(KINDS.length, 7);
});

/** The masthead, which stands on the frame's navy in both schemes: everything from its cell to the end of the piping. */
const MASTHEAD = /<tr><td class="v-pad" bgcolor="#0C1930"[\s\S]*?<\/table><\/td><\/tr>/;
/** The rules inside the dark-mode media query, and none after it. */
const mediaBlock = (html: string) => html.match(/@media \(prefers-color-scheme: dark\) \{\n([\s\S]*?)\n {2}\}\n/)?.[1] ?? '';

for (const kind of KINDS) {
  test(`${kind}: nothing is fetched when it opens, and it reads as a document`, () => {
    const { html, text, subject } = MAIL_SAMPLES[kind];
    assert.ok(subject.length > 0 && !/[\r\n]/.test(subject), 'a one-line subject');
    // No image, background, stylesheet, font or frame from anywhere, the deployment included.
    for (const pattern of [/<img\b/i, /\bsrc\s*=/i, /\bbackground\s*=/i, /url\(/i, /<link\b/i, /@import/i, /<iframe\b/i, /<object\b/i, /<embed\b/i, /<video\b/i, /<audio\b/i, /@font-face/i]) {
      assert.doesNotMatch(html, pattern, `${kind} has ${pattern}`);
    }
    // Only links the reader chooses to follow go anywhere.
    for (const href of [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])) assert.match(href, /^https:\/\/vantage\.example\.mil(?:\/|$)/, `${kind} links to ${href}`);
    assert.match(html, /<html lang="en" dir="ltr"/);
    assert.match(html, /<meta name="color-scheme" content="light dark">/);
    assert.match(html, /<div role="article" aria-roledescription="email" aria-label="[^"]+"/);
    assert.equal(html.match(/<h1\b/g)?.length, 1, 'the title is the one heading at the top');
    assert.match(html, />Vantage<\/p>/, 'the wordmark is text');
    // Layout tables say they are layout; the one data table is the details, with a header on each row.
    const data = [...body(html).matchAll(/<table\b(?![^>]*role="presentation")[^>]*>([\s\S]*?)<\/table>/g)];
    assert.equal(data.length, html.includes('<th scope="row"') ? 1 : 0, `${kind}: the details are the only data table`);
    for (const [, inner] of data) {
      assert.doesNotMatch(inner, /<table\b/, 'a data table holds no layout table');
      const rows = inner.match(/<tr>/g)?.length ?? 0;
      assert.equal(inner.match(/<th scope="row"/g)?.length ?? 0, rows, `${kind}: every row of the details has its header`);
    }
    for (const th of [...html.matchAll(/<th\b[^>]*>/g)]) assert.match(th[0], /scope="row"/);
    // The preheader and the button's arrow are not read aloud.
    assert.match(html, /<div aria-hidden="true" style="display:none/);
    if (/class="v-btn"/.test(html)) assert.match(html, /<span aria-hidden="true">&nbsp;&rarr;<\/span><\/a>/);
    // The plain text is the whole message too.
    assert.match(text, /^(?:CUI\/\/PRVCY\n\n)?VANTAGE · /);
    assert.match(text, /\n-- \n/);
  });

  test(`${kind}: every coloured element is mapped for dark mode`, () => {
    const { html } = MAIL_SAMPLES[kind];
    const known = new Set([...DARK_CLASSES, ...LAYOUT_CLASSES]);
    const textClasses = new Set(['v-ink', 'v-ink2', 'v-ink3', 'v-good', 'v-warn', 'v-bad', 'v-link', 'v-btn']);
    const groundClasses = new Set(['v-bg', 'v-card', 'v-panel', 'v-btn-cell']);
    const borderClasses = new Set(['v-card', 'v-panel', 'v-rule', 'v-note']);
    // What stands on the masthead keeps the frame's colours in both schemes, as the app's frame does; it is checked
    // apart, and everything else must name its colour by a class.
    const masthead = body(html).match(MASTHEAD)?.[0] ?? '';
    assert.ok(masthead.includes('<h1'), `${kind}: the masthead holds the title`);
    const frame = new Set(Object.values(MAIL_PALETTE.frame).map((c) => c.toLowerCase()));
    for (const t of tags(masthead)) {
      const style = t.attrs.match(/\bstyle="([^"]*)"/)?.[1] || '';
      for (const m of style.matchAll(/(?:^|;)(?:color|background-color):(#[0-9a-f]{6})/gi)) assert.ok(frame.has(m[1].toLowerCase()), `${kind}: the masthead uses ${m[1]}, not a frame colour`);
    }
    for (const t of tags(body(html).replace(MASTHEAD, ''))) {
      const classes = classesOf(t.attrs);
      for (const c of classes) assert.ok(known.has(c), `${kind}: ${c} has no rule`);
      const style = t.attrs.match(/\bstyle="([^"]*)"/)?.[1] || '';
      if (/display:none/.test(style)) continue;
      const color = style.match(/(?:^|;)color:(#[0-9a-f]{6})/i)?.[1];
      if (color) assert.ok(classes.some((c) => textClasses.has(c)), `${kind}: <${t.name}> sets color ${color} with no class for dark mode`);
      const ground = style.match(/background-color:(#[0-9a-f]{6})/i)?.[1];
      // The short gold rule over a figure is the frame's gold in both schemes, as the piping is.
      if (ground && ground.toLowerCase() !== MAIL_PALETTE.frame.gold.toLowerCase()) assert.ok(classes.some((c) => groundClasses.has(c)), `${kind}: <${t.name}> sets background ${ground} with no class for dark mode`);
      const border = style.match(/border(?:-(?:top|right|bottom|left))?:\d+px solid (#[0-9a-f]{6})/i)?.[1];
      // The note's gold rule is the frame's gold in both schemes, and v-note says so.
      if (border) assert.ok(classes.some((c) => borderClasses.has(c)), `${kind}: <${t.name}> sets border ${border} with no class for dark mode`);
    }
    // Each rule is in the media query and again for Outlook.com's dark mode.
    const media = mediaBlock(html);
    assert.ok(media, `${kind} has the dark media query`);
    for (const cls of DARK_CLASSES) {
      assert.match(media, new RegExp(`^ {4}\\.${cls} \\{`, 'm'), `${cls} in the media query`);
      assert.match(html, new RegExp(`\\[data-og(?:sc|sb)\\] \\.${cls} \\{`), `${cls} for Outlook.com`);
    }
  });
}

test('a toned figure keeps its tone in dark mode: it names the tone, never the ink', () => {
  const { html } = MAIL_SAMPLES.digest;
  const L = MAIL_PALETTE.light;
  assert.match(html, new RegExp(`<p class="v-bad" style="[^"]*color:${L.bad}">2</p>`), 'the overdue count is red');
  assert.match(html, new RegExp(`<p class="v-warn" style="[^"]*color:${L.warn}">3</p>`), 'the due-soon count is amber');
  assert.match(html, new RegExp(`<p class="v-good" style="[^"]*color:${L.good}">\\$1\\.2M</p>`), 'the impact is green');
  assert.match(html, /<p class="v-ink" style="[^"]*">4<\/p>/, 'an untoned figure is ink');
  for (const tone of ['good', 'warn', 'bad'] as const) {
    assert.match(mediaBlock(html), new RegExp(`\\.v-${tone} \\{ color:${MAIL_PALETTE.dark[tone]} !important; \\}`));
  }
  // The old fault: the ink's dark rule painted every figure white, whatever its tone.
  assert.doesNotMatch(html, /class="v-ink" style="[^"]*color:#(?:156E4E|8A4F05|B2122A)/i);
});

test('every colour pair reads at 4.5:1 or better, light and dark', () => {
  const pairs = (s: (typeof MAIL_PALETTE)['light' | 'dark']) => [
    ...(['ink', 'ink2', 'ink3'] as const).flatMap((ink) => (['paper', 'card', 'panel'] as const).map((ground) => [ink, s[ink], ground, s[ground]] as const)),
    ...(['good', 'warn', 'bad'] as const).flatMap((tone) => (['card', 'panel'] as const).map((ground) => [tone, s[tone], ground, s[ground]] as const)),
    ['accent', s.accent, 'card', s.card], ['accent', s.accent, 'panel', s.panel], ['accentInk', s.accentInk, 'accent', s.accent],
  ] as const;
  for (const scheme of ['light', 'dark'] as const) {
    for (const [fg, a, bg, b] of pairs(MAIL_PALETTE[scheme])) {
      const ratio = contrast(a, b);
      assert.ok(ratio >= 4.5, `${scheme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
  const F = MAIL_PALETTE.frame;
  for (const [name, color] of [['white', F.ink], ['gold', F.gold]] as const) {
    assert.ok(contrast(color, F.ground) >= 4.5, `${name} on the masthead navy is ${contrast(color, F.ground).toFixed(2)}:1`);
  }
});

test('the handling marking stands above the masthead and under the footer, in both parts, and only when given', () => {
  for (const kind of ['team_message', 'digest']) {
    const { html, text } = MAIL_SAMPLES[kind];
    const shown = body(html).split(SAMPLE_MARKING).length - 1;
    assert.equal(shown, 2, `${kind} shows the marking twice`);
    assert.ok(body(html).indexOf(SAMPLE_MARKING) < body(html).indexOf('<h1'), `${kind}: the marking comes before the title`);
    assert.ok(body(html).lastIndexOf(SAMPLE_MARKING) > body(html).indexOf('Vantage &middot;'), `${kind}: and after the footer`);
    assert.ok(text.startsWith(`${SAMPLE_MARKING}\n`) && text.endsWith(`\n${SAMPLE_MARKING}`), `${kind}: the plain text too`);
  }
  for (const kind of ['reset', 'email_change', 'invite', 'test', 'sign_in']) assert.doesNotMatch(MAIL_SAMPLES[kind].html + MAIL_SAMPLES[kind].text, /CUI/);
  // A blank marking is no marking.
  assert.match(layout({ title: 't', intro: 'i', marking: '  ' }).text, /^VANTAGE\n/);
});

test('the plain text says everything the HTML does', () => {
  const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&middot;/g, '·').replace(/&nbsp;/g, ' ').replace(/&rarr;/g, '→').replace(/&amp;/g, '&');
  for (const kind of KINDS) {
    const { html, text } = MAIL_SAMPLES[kind];
    const shown = body(html).replace(/<head>[\s\S]*?<\/head>/, '').replace(/<div aria-hidden="true" style="display:none[\s\S]*?<\/div>/, '').replace(/<span aria-hidden="true">[\s\S]*?<\/span>/g, '');
    const words = [...shown.replace(/<br>/g, '\n').matchAll(/>([^<>]+)</g)].map((m) => unescape(m[1]).trim()).filter((w) => w && !/^[\s·]*$/.test(w));
    const plain = text.replace(/\s+/g, ' ').toLowerCase();
    for (const w of words) {
      // The masthead and the footer line say the same in other words: VANTAGE, and the full address beside the host.
      if (['Vantage', 'Vantage ·', 'Or paste this into your browser:', 'vantage.example.mil'].includes(w)) continue;
      for (const line of w.split(/\n/)) assert.ok(plain.includes(line.replace(/\s+/g, ' ').toLowerCase().trim()), `${kind}: "${line}" is in the HTML only`);
    }
  }
});

let app: TestApp;
let op: { token: string; id: string; unitId: string };
before(async () => { app = await startApp(); op = await app.setupOperator(); });
after(() => app.close());

/** The new look's fingerprints, in a message as a route or service actually sent it. */
function inTheLook(kind: string) {
  const mail = [...app.ctx.mailer.outbox].reverse().find((m) => m.kind === kind);
  assert.ok(mail, `a ${kind} message was sent`);
  assert.match(mail.html, /aria-roledescription="email"/, `${kind} wears the layout`);
  assert.match(mail.html, /#0C1930/, `${kind} has the navy masthead`);
  assert.doesNotMatch(mail.html, /<img\b|url\(|<link\b/i, `${kind} fetches nothing`);
  assert.match(mail.text, /\n-- \n/);
  return mail;
}

test('each of the seven, sent through its own route or service, arrives in the one look', async () => {
  const csv = ['Rank,First Name,Last Name,L2 Command,Fire Team,Username,Email,Temporary Password,Role', 'Sgt,Dana,Price,Test Command,Alpha Cell,dana.price,dana.price@example.mil,,Marine'].join('\n');
  const imported = await app.call('POST', '/api/orgs/G8/accounts/import?apply=1', { token: op.token, raw: Buffer.from(csv), headers: { 'content-type': 'text/csv', 'x-vantage-filename': 'roster.csv' } });
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  const dana = (app.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get('dana.price') as { id: string }).id;
  const member = await app.register('looktester', { email: 'look.tester@example.mil' });
  await enroll(app, op.token, 'G8', member.id);

  const calls: Array<[string, string, unknown, string?]> = [
    ['reset', '/api/auth/forgot', { identifier: 'boletz' }],
    ['email_change', '/api/me/email/verify', { email: 'boletz.new@example.mil' }, op.token],
    ['invite', '/api/org/units/G8/invites', { email: 'invitee@example.mil', first_name: 'Ira', last_name: 'Vance' }, op.token],
    ['test', '/api/platform/email/test', {}, op.token],
    ['sign_in', '/api/orgs/G8/accounts/sign-in-details', { userIds: [dana] }, op.token],
    ['team_message', '/api/org/units/G8/message', { subject: 'Close-out Friday', body: 'Bring the binder.' }, op.token],
    ['digest', '/api/me/digest/send-now', {}, op.token],
  ];
  for (const [kind, path, payload, token] of calls) {
    const res = await app.call('POST', path, { token, body: payload });
    assert.ok(res.status < 300, `${kind}: ${res.status} ${JSON.stringify(res.body)}`);
    inTheLook(kind);
  }
  // The deployment's handling line, the Vantage Administrators' setting, on the two that carry one.
  const marking = app.ctx.runtime.reportMarking || 'Working paper';
  for (const kind of ['team_message', 'digest']) assert.ok(inTheLook(kind).text.startsWith(`${marking}\n`), `${kind} carries the marking`);
  assert.ok(!inTheLook('reset').text.startsWith(marking), 'a reset link carries none');
});
