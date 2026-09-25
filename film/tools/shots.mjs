import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openDemo, settle, still, take, collectTakes } from './capture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.VANTAGE_DEMO_URL || 'http://localhost:8798';
const TL = JSON.parse(readFileSync(join(ROOT, 'src', 'generated', 'timelines.json'), 'utf8'));

function cue(filmId, sceneId) {
  const s = TL[filmId].scenes.find((x) => x.id === sceneId);
  if (!s) throw new Error(`no scene ${filmId}/${sceneId}`);
  const norm = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}$]/gu, '');
  return {
    dur: s.end - s.start,
    at(word, { nth = 0, end = false } = {}) {
      const all = s.lines.flatMap((l) => l.words);
      const hits = all.filter((w) => norm(w.word) === norm(word));
      const w = hits[nth];
      if (!w) throw new Error(`${filmId}/${sceneId}: the narration has no "${word}"`);
      return (end ? w.end : w.start) - s.start;
    },
  };
}

const role = (page, r, name, exact = true) => page.getByRole(r, { name, exact });
const itemId = async (page, ref) => (await (await page.request.get(`/api/work/items?q=${encodeURIComponent(ref)}`)).json()).items[0].id;

async function hero(browser) {
  const { context, page } = await openDemo(browser, BASE);
  // Stills: the product as it is, for the plates.
  await still(page, 'hero-today');
  await page.goto('/work', { waitUntil: 'networkidle' });
  await role(page, 'button', 'Open to claim').click();
  await settle(page);
  await still(page, 'hero-queue');

  // capture: a sentence becomes a record.
  {
    const c = cue('hero', 'capture');
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.keyboard.press('n');
    await settle(page, 300);
    const tk = take(page, 'hero', 'capture');
    await tk.start();
    tk.focus(page.getByRole('dialog', { name: 'Log activity' }), { zoom: 1.12, ease: 0.01, pad: 10 });
    await tk.focus(page.getByLabel('What did you do?'), { zoom: 1.75, ease: 0.8, pad: 30 });
    tk.hold(0.3);
    await tk.type(null, 'Reconciled 30 ULOs totaling $41,806.12 in SABRS yesterday', { cps: 21 });
    // "Vantage reads the numbers" — the camera moves to what it read.
    tk.until(c.at('reads') - 0.3);
    await tk.focus(page.getByLabel('Action amount').locator('xpath=ancestor::div[contains(@class,"grid")][1]'), { zoom: 1.4, ease: 1.1, pad: 30 });
    tk.until(c.at('shows') - 0.2);
    await tk.focus(page.getByText('Bullet preview', { exact: false }).locator('xpath=..'), { zoom: 1.55, ease: 1.0, pad: 24 });
    await tk.finish(c.dur);
  }
  await page.keyboard.press('Escape');

  // queue: one queue, and a claim.
  {
    const c = cue('hero', 'queue');
    await page.goto('/work', { waitUntil: 'networkidle' });
    await role(page, 'button', 'Open to claim').click();
    await settle(page);
    const tk = take(page, 'hero', 'queue');
    await tk.start();
    tk.focus(page.locator('table').first(), { zoom: 1.06, ease: 0.01, pad: 20 });
    tk.until(c.at('claim') - 0.7);
    const row = page.locator('tr', { hasText: 'SYN-26-P-0047' });
    await tk.focus(row, { zoom: 1.6, ease: 0.8, pad: 30 });
    await tk.click(row.getByRole('button', { name: 'Claim' }), { travel: 0.6, after: 0.2 });
    await tk.capture(400);
    await tk.finish(c.dur);
  }

  // Stills for the case, the history and the record.
  const umt = await itemId(page, 'SYN-26-P-0047');
  await workUmt(page, umt);
  await page.goto(`/work/items/${umt}`, { waitUntil: 'networkidle' });
  await still(page, 'hero-case-procedure', { selector: 'section:has(h2:text-is("Procedure")), aside section:has-text("Procedure")' }).catch(() => undefined);
  await still(page, 'hero-case', { fullPage: true });
  const ocmt = await itemId(page, 'SYN-26-OB-0103');
  await page.goto(`/work/items/${ocmt}`, { waitUntil: 'networkidle' });
  await still(page, 'hero-case-ocmt', { fullPage: true });
  await page.goto('/record', { waitUntil: 'networkidle' });
  await still(page, 'hero-record');
  await context.close();

  const lead = await openDemo(browser, BASE, { persona: 'leader' });
  await still(lead.page, 'hero-lead');
  await lead.context.close();
}

async function workUmt(page, id, { claim = true, decide = true } = {}) {
  await page.goto(`/work/items/${id}`, { waitUntil: 'networkidle' });
  if (claim && await role(page, 'button', 'Claim').count()) { await role(page, 'button', 'Claim').click(); await settle(page); }
  await page.getByLabel('Current award amount').fill('91,250.00');
  await page.getByLabel('Invoice amount').fill('45,000.00');
  await role(page, 'button', '+ Add another').click();
  await page.getByLabel('Invoice 2').fill('44,725.00');
  await role(page, 'button', 'Record what you found').click();
  await settle(page);
  await page.getByLabel('Requisition funding available').fill('1,500.00');
  await role(page, 'button', 'Record what you found').click();
  await settle(page);
  await role(page, 'button', 'Calculate the candidate').click();
  await settle(page);
  if (!decide) return;
  await page.getByLabel('Amend the requisition first').check();
  await page.getByLabel('Why').fill('Requisition shows $1,500.00 available against a candidate increase of $2,775.00.');
  await role(page, 'button', 'Record the decision').click();
  await settle(page);
}

async function quickLog(browser) {
  const F = 'quick-log';
  const { context, page } = await openDemo(browser, BASE);
  await still(page, 'ql-bg');
  const dialog = page.getByRole('dialog', { name: 'Log activity' });
  {
    const c = cue(F, 'ql-open');
    const tk = take(page, F, 'ql-open');
    await tk.start();
    tk.until(c.at('press') - 0.1);
    await tk.press('n', { after: 0.2 });
    await tk.focus(dialog, { zoom: 1.28, ease: 0.9, pad: 12, dx: 60 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'ql-type');
    const tk = take(page, F, 'ql-type');
    await tk.start();
    await tk.focus(page.getByLabel('What did you do?'), { zoom: 1.8, ease: 0.8, pad: 30 });
    tk.hold(0.5);
    await tk.type(null, 'Reconciled 30 ULOs totaling $41,806.12 in SABRS yesterday', { cps: 16 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'ql-read');
    const tk = take(page, F, 'ql-read');
    await tk.start();
    const chips = dialog.getByText('dollar figure', { exact: true }).locator('xpath=ancestor::div[1]');
    await tk.focus(chips, { zoom: 1.85, ease: 0.9, pad: 20 });
    tk.until(c.at('count') - 0.1);
    await tk.focus(page.getByLabel('Action amount').locator('xpath=ancestor::div[contains(@class,"grid")][1]'), { zoom: 1.45, ease: 1.0, pad: 24 });
    await tk.point(page.getByLabel('Action amount'), { travel: 0.5, scroll: false });
    tk.until(c.at('dollar'));
    await tk.point(page.getByLabel('Transaction value'), { travel: 0.5, scroll: false });
    tk.until(c.at('kind'));
    await tk.point(page.getByText('Value type', { exact: true }), { travel: 0.5, scroll: false });
    tk.until(c.at('system'));
    await tk.focus(chips, { zoom: 1.85, ease: 0.8, pad: 20 });
    await tk.point(dialog.getByText('system: SABRS'), { travel: 0.5, scroll: false });
    tk.until(c.at('date'));
    await tk.point(dialog.getByText('date: yesterday'), { travel: 0.45, scroll: false });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'ql-save');
    const tk = take(page, F, 'ql-save');
    await tk.start();
    await tk.focus(page.getByLabel('Result'), { zoom: 1.5, ease: 0.7, pad: 60 });
    await tk.type(page.getByLabel('Result'), 'zero findings at the quarterly review', { cps: 22 });
    await tk.focus(page.getByText('Bullet preview', { exact: false }).locator('xpath=..'), { zoom: 1.45, ease: 0.7, pad: 24 });
    tk.until(c.at('save') - 0.55);
    await tk.click(dialog.getByRole('button', { name: 'Save activity' }), { travel: 0.5, after: 0.15 });
    tk.wide({ ease: 0.6 });
    await tk.goto('/record?tab=entries');
    await tk.focus(page.getByText('Reconciled 30 ULOs', { exact: false }).first().locator('xpath=ancestor::*[self::li or self::tr or self::a][1]'), { zoom: 1.5, ease: 0.9, pad: 30 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'ql-offline');
    await page.goto('/', { waitUntil: 'networkidle' });
    const tk = take(page, F, 'ql-offline');
    await tk.start();
    await context.setOffline(true);
    await tk.capture(600);
    await tk.focus(page.getByText('Offline', { exact: true }), { zoom: 1.6, ease: 0.6, pad: 80 });
    tk.until(c.at('waits') - 0.6);
    await tk.press('n', { after: 0.15 });
    await tk.focus(dialog, { zoom: 1.25, ease: 0.7, pad: 12, dx: 60 });
    await tk.type(null, 'Briefed 14 Marines on the travel policy', { cps: 26 });
    await tk.click(dialog.getByRole('button', { name: 'Queue offline' }), { travel: 0.45, after: 0.3 });
    tk.wide({ ease: 0.7 });
    tk.until(c.at('syncs') - 0.2);
    await context.setOffline(false);
    await page.waitForTimeout(1500);
    await tk.capture(300);
    await tk.focus(page.getByRole('status').filter({ hasText: /synced/ }), { zoom: 1.5, ease: 0.8, pad: 60 }).catch(() => undefined);
    await tk.finish(c.dur);
  }
  await context.close();
}

async function queue(browser) {
  const F = 'queue';
  const { context, page } = await openDemo(browser, BASE);
  await page.goto('/work', { waitUntil: 'networkidle' });
  await still(page, 'q-bg');
  {
    const c = cue(F, 'q-queue');
    const tk = take(page, F, 'q-queue');
    await tk.start();
    tk.until(c.at('queue') - 0.5);
    await tk.click(role(page, 'button', 'Open to claim'), { after: 0.2 });
    await tk.focus(page.locator('table').first(), { zoom: 1.12, ease: 1.0, pad: 20 });
    await tk.finish(c.dur);
  }
  let url;
  {
    const c = cue(F, 'q-claim');
    const tk = take(page, F, 'q-claim');
    await tk.start();
    const row = page.locator('tr', { hasText: 'SYN-26-P-0047' });
    await tk.focus(row, { zoom: 1.5, ease: 0.7, pad: 40 });
    await tk.click(row.getByText('SYN-26-P-0047'), { travel: 0.6, after: 0 });
    tk.cut();
    tk.wide({ ease: 0.01 });
    await tk.capture(300);
    url = page.url();
    tk.until(c.at('claim') - 0.4);
    await tk.focus(role(page, 'button', 'Claim').locator('xpath=ancestor::header[1] | ancestor::div[contains(@class,"flex")][2]').first(), { zoom: 1.3, ease: 0.7, pad: 40 });
    await tk.click(role(page, 'button', 'Claim'), { travel: 0.55, after: 0.1 });
    await tk.capture(300);
    tk.until(c.at('credit') - 0.3);
    await tk.focus(page.getByText(/It is on your assigned list now/).first(), { zoom: 1.5, ease: 0.8, pad: 50 }).catch(() => undefined);
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'q-step');
    const tk = take(page, F, 'q-step');
    await tk.start();
    tk.wide({ ease: 0.6 });
    const steps = page.getByText('applicable steps done', { exact: false }).locator('xpath=ancestor::section[1]');
    await tk.focus(steps, { zoom: 1.35, ease: 0.9, pad: 20 }).catch(() => undefined);
    tk.until(c.at('form') - 0.9);
    await tk.reveal(page.getByLabel('Current award amount'));
    await tk.focus(page.getByLabel('Current award amount').locator('xpath=ancestor::section[1]'), { zoom: 1.3, ease: 0.9, pad: 20 });
    await tk.type(page.getByLabel('Current award amount'), '91,250.00', { cps: 28 });
    await tk.type(page.getByLabel('Invoice amount'), '45,000.00', { cps: 28 });
    await tk.click(role(page, 'button', '+ Add another'), { travel: 0.4, after: 0.05 });
    await tk.type(page.getByLabel('Invoice 2'), '44,725.00', { cps: 28 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'q-calc');
    const tk = take(page, F, 'q-calc');
    await tk.start();
    await tk.click(role(page, 'button', 'Record what you found'), { travel: 0.45, after: 0.1 });
    await tk.type(page.getByLabel('Requisition funding available'), '1,500.00', { cps: 30 });
    await tk.click(role(page, 'button', 'Record what you found'), { travel: 0.4, after: 0.05 });
    tk.until(c.at('calculates') - 0.6);
    await tk.click(role(page, 'button', 'Calculate the candidate'), { travel: 0.5, after: 0.1 });
    const calc = page.locator('section', { hasText: 'Candidate calculation' }).first();
    await tk.reveal(calc, { anchor: 0.2 });
    await tk.focus(calc, { zoom: 1.3, ease: 0.9, pad: 20 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'q-decide');
    const tk = take(page, F, 'q-decide');
    await tk.start();
    await tk.reveal(page.getByLabel('Amend the requisition first'));
    await tk.focus(page.getByLabel('Amend the requisition first').locator('xpath=ancestor::section[1]'), { zoom: 1.3, ease: 0.7, pad: 20 });
    await tk.click(page.getByLabel('Amend the requisition first'), { travel: 0.5, after: 0.1 });
    await tk.type(page.getByLabel('Why'), 'Requisition shows $1,500.00 against +$2,775.00.', { cps: 34 });
    await tk.click(role(page, 'button', 'Record the decision'), { travel: 0.45, after: 0.1 });
    tk.until(c.at('evidence') - 0.7);
    const checklist = page.locator('section', { hasText: 'applicable steps done' }).first();
    await tk.click(checklist.getByText('Submit the modification'), { travel: 0.55, after: 0.1 });
    const gate = page.getByText('Submission waits on a PASSED check.', { exact: false }).first();
    await tk.reveal(gate, { anchor: 0.3 });
    await tk.focus(gate.locator('xpath=ancestor::section[1]'), { zoom: 1.4, ease: 0.8, pad: 10, dy: -40 });
    await tk.finish(c.dur);
    await still(page, 'hero-gate', { locator: gate.locator('xpath=ancestor::section[1]') });
    await still(page, 'hero-procedure', { locator: checklist });
  }
  await page.getByText('Back to the next step').click().catch(() => undefined);
  // Off camera: hand it to the section lead, who records the amendment.
  await page.getByRole('button', { name: 'Hand off' }).click();
  const dialog = page.getByRole('dialog', { name: 'Hand this off' });
  await dialog.getByRole('combobox', { name: 'To', exact: true }).click();
  await page.getByRole('option', { name: /Morgan Diaz/ }).click();
  await dialog.getByLabel('What they need to know').fill('Research and decision recorded. The requisition amendment is next.');
  await dialog.getByRole('button', { name: 'Hand off' }).click();
  await settle(page);
  await page.request.post('/api/demo/persona', { data: { persona: 'leader' }, headers: { 'x-vantage-client': '1' } });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByLabel('Reference').first().fill('SYN-REQ-AMD-1');
  await role(page, 'button', 'Record as submitted').click();
  await settle(page);
  await page.request.post('/api/demo/persona', { data: { persona: 'marine' }, headers: { 'x-vantage-client': '1' } });
  await page.goto(url, { waitUntil: 'networkidle' });
  await still(page, 'hero-history', { locator: page.locator('section', { has: page.getByRole('heading', { name: 'History' }) }) });
  await still(page, 'hero-who', { locator: page.locator('section', { hasText: 'Who worked this' }) });
  await still(page, 'hero-calc', { locator: page.locator('section', { hasText: 'Candidate calculation' }) });
  await page.goto(url, { waitUntil: 'networkidle' });
  {
    const c = cue(F, 'q-history');
    const tk = take(page, F, 'q-history');
    await tk.start();
    const history = page.locator('section', { has: page.getByRole('heading', { name: 'History' }) }).first();
    await tk.reveal(history, { anchor: 0.12, seconds: 1.3 });
    await tk.focus(history, { zoom: 1.2, ease: 0.9, pad: 10 });
    tk.until(c.at('history', { end: true }) - 0.2);
    await tk.focus(page.getByText(/History sealed/).last(), { zoom: 1.9, ease: 0.8, pad: 60 });
    tk.until(c.at('hand') - 0.3);
    const who = page.locator('section', { hasText: 'Who worked this' }).first();
    await tk.reveal(who, { anchor: 0.3 });
    await tk.focus(who, { zoom: 1.45, ease: 0.9, pad: 20 });
    await tk.finish(c.dur);
  }
  await context.close();
}

async function balance(browser) {
  const F = 'reading-a-balance';
  const { context, page } = await openDemo(browser, BASE);
  await page.goto('/reference?tab=conditions', { waitUntil: 'networkidle' });
  await still(page, 'b-bg');
  {
    const c = cue(F, 'b-ref');
    const tk = take(page, F, 'b-ref');
    await tk.start();
    await tk.focus(page.getByRole('heading', { level: 1 }), { zoom: 1.35, ease: 0.01, pad: 60 });
    tk.until(c.at('cited') - 0.9);
    const cite = page.locator('section', { hasText: 'OCMT' }).first();
    await tk.reveal(cite, { anchor: 0.15, seconds: 1.0 });
    await tk.focus(cite, { zoom: 1.3, ease: 0.9, pad: 10 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'b-enter');
    const tk = take(page, F, 'b-enter');
    await tk.start();
    await tk.click(page.getByRole('tab', { name: 'Diagnose' }).or(page.getByRole('button', { name: 'Diagnose', exact: true })), { travel: 0.45, after: 0.05 });
    tk.cut();
    await tk.scroll(0, 0.01);
    const figs = page.getByRole('region', { name: 'The figures' }).or(page.locator('section[aria-label="The figures"]'));
    await tk.focus(figs, { zoom: 1.45, ease: 0.6, pad: 10, dy: 60 });
    for (const [label, v] of [['Commitment', '50,000.00'], ['Obligation', '50,000.00'], ['Delivered', '30,000.00'], ['Paid', '30,000.00']]) {
      await tk.type(figs.getByLabel(label, { exact: true }), v, { cps: 44 });
    }
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'b-read');
    const tk = take(page, F, 'b-read');
    await tk.start();
    const reading = page.locator('section[aria-label="The reading"]');
    await tk.focus(reading, { zoom: 1.25, ease: 0.8, pad: 10 });
    tk.until(c.at('causes') - 0.3);
    await tk.scroll(380, 1.2);
    tk.until(c.at('act') - 0.4);
    await tk.scroll(760, 1.2);
    tk.until(c.at('prove') - 0.5);
    await tk.scroll(1120, 1.2);
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'b-dash');
    const tk = take(page, F, 'b-dash');
    await tk.start();
    await tk.scroll(0, 1.0);
    const figs = page.locator('section[aria-label="The figures"]');
    const paid = figs.getByText('Not shown', { exact: true }).nth(3);
    await tk.focus(figs, { zoom: 1.5, ease: 0.8, pad: 10, dy: 80 });
    tk.until(c.at('mark') - 0.5);
    await tk.click(paid, { travel: 0.5, after: 0.3 });
    await tk.focus(page.locator('section[aria-label="The reading"]'), { zoom: 1.2, ease: 0.9, pad: 10 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'b-case');
    const tk = take(page, F, 'b-case');
    await tk.start();
    const doc = page.getByLabel('Document number');
    await tk.reveal(doc, { anchor: 0.5 });
    await tk.focus(doc.locator('xpath=ancestor::div[contains(@class,"rounded-2xl")][1]'), { zoom: 1.45, ease: 0.7, pad: 20 });
    await tk.type(doc, 'M67854-26-RC-00112', { cps: 30 });
    await tk.click(role(page, 'button', 'Open the case', false), { travel: 0.45, after: 0 });
    await page.waitForURL(/\/work\/items\//);
    tk.cut();
    tk.wide({ ease: 0.01 });
    await tk.capture(500);
    tk.until(c.at('figures', { nth: 0 }) - 0.2);
    await tk.focus(page.getByText('What the figures show').locator('xpath=ancestor::section[1]'), { zoom: 1.35, ease: 0.9, pad: 10 });
    tk.until(c.at('labelled') - 0.2);
    const hist = page.locator('section', { has: page.getByRole('heading', { name: 'History' }) }).first();
    await tk.reveal(hist, { anchor: 0.15 });
    await tk.focus(hist, { zoom: 1.35, ease: 0.8, pad: 10, dy: -60 });
    await tk.finish(c.dur);
  }
  await context.close();
}

async function record(browser) {
  const F = 'record';
  const { context, page } = await openDemo(browser, BASE);
  const umt = await itemId(page, 'SYN-26-P-0047');
  await workUmt(page, umt);
  await page.goto('/record', { waitUntil: 'networkidle' });
  await still(page, 'r-bg');
  {
    const c = cue(F, 'r-three');
    const tk = take(page, F, 'r-three');
    await tk.start();
    tk.until(c.at('hold') - 0.4);
    await tk.focus(page.locator('section', { hasText: 'Assigned to you' }).first(), { zoom: 1.4, ease: 0.9, pad: 10 });
    tk.until(c.at('contributed') - 0.4);
    await tk.focus(page.getByText('What you contributed', { exact: true }).locator('xpath=ancestor::section[1]'), { zoom: 1.2, ease: 0.9, pad: 10 });
    tk.until(c.at('logged') - 0.4);
    await tk.focus(page.locator('section', { hasText: 'What you recorded yourself' }).first(), { zoom: 1.4, ease: 0.9, pad: 10 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'r-count');
    const tk = take(page, F, 'r-count');
    await tk.start();
    const card = page.getByText('Documents researched', { exact: true }).locator('xpath=ancestor::*[contains(@class,"card") or self::article][1]');
    await tk.focus(card, { zoom: 2.0, ease: 0.8, pad: 40 });
    tk.until(c.at('once', { nth: 0 }) - 0.6);
    await tk.hover(card.getByRole('button').first(), { travel: 0.5, after: 0.2 });
    await tk.focus(page.getByRole('tooltip').first(), { zoom: 1.7, ease: 0.8, pad: 60 }).catch(() => undefined);
    await tk.finish(c.dur);
  }
  await page.keyboard.press('Escape');
  {
    const c = cue(F, 'r-draft');
    await page.goto(`/work/items/${umt}`, { waitUntil: 'networkidle' });
    const tk = take(page, F, 'r-draft');
    await tk.start();
    tk.cut();
    const prep = role(page, 'button', 'Prepare a private draft from my work');
    await tk.reveal(prep, { anchor: 0.45 });
    await tk.focus(prep, { zoom: 1.6, ease: 0.8, pad: 90 });
    tk.until(c.at('prepare') - 0.6);
    await tk.click(prep, { travel: 0.5, after: 0 });
    await page.waitForURL(/tab=drafts/);
    tk.cut();
    tk.wide({ ease: 0.01 });
    await tk.capture(400);
    tk.until(c.at('own') - 0.8);
    await tk.focus(page.getByText(/Recorded current award amount/).first().locator('xpath=ancestor::*[contains(@class,"card")][1]'), { zoom: 1.35, ease: 0.9, pad: 20 }).catch(() => undefined);
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'r-keep');
    const tk = take(page, F, 'r-keep');
    await tk.start();
    await tk.click(role(page, 'button', 'Keep in my record'), { travel: 0.55, after: 0.1 });
    await tk.capture(300);
    tk.until(c.at('link') - 0.8);
    await tk.goto('/record?tab=entries');
    await tk.focus(page.locator('main').getByRole('link').filter({ hasText: /award|UMT|2-Way/i }).first().locator('xpath=ancestor::*[self::li or self::tr][1]'), { zoom: 1.5, ease: 0.9, pad: 30 }).catch(() => undefined);
    await tk.finish(c.dur);
  }
  await context.close();
}

async function studio(browser) {
  const F = 'report-studio';
  const { context, page } = await openDemo(browser, BASE);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const week = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
  for (const data of [
    { title: 'Reconciled 30 ULOs totaling $41,806.12 in SABRS', date: yesterday, quantity: 30, unit_label: 'ULOs', dollar_amount: 41806.12, dollar_type: 'reconciled', result: 'zero findings at the quarterly review', category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', system: 'SABRS', visibility: 'private' },
    { title: 'Cleared 12 unmatched transactions in DAI', date: week, quantity: 12, unit_label: 'UMTs', result: 'every one posted before month-end close', category: 'Fiscal & Financial', eval_area: 'MOS / Mission Accomplishment', system: 'DAI', visibility: 'private' },
  ]) {
    const res = await page.request.post('/api/records/activities', { data, headers: { 'x-vantage-client': '1' } });
    if (!res.ok()) throw new Error(`seed activity: ${res.status()} ${await res.text()}`);
  }
  await page.goto('/reports', { waitUntil: 'networkidle' });
  await still(page, 's-bg');
  {
    const c = cue(F, 's-intro');
    const tk = take(page, F, 's-intro');
    await tk.start();
    await tk.focus(page.getByRole('heading', { level: 1 }), { zoom: 1.4, ease: 0.01, pad: 60 });
    tk.until(c.at('turns') - 0.3);
    await tk.click(role(page, 'button', 'New report'), { travel: 0.6, after: 0.1 });
    const start = page.getByRole('dialog', { name: 'Start a report' });
    await tk.focus(start, { zoom: 1.45, ease: 0.7, pad: 20 });
    await tk.type(start.getByLabel('Title'), 'FY26 Q4 JEPES input', { cps: 20 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 's-period');
    const tk = take(page, F, 's-period');
    const start = page.getByRole('dialog', { name: 'Start a report' });
    await tk.start();
    await tk.point(start.getByText('Period', { exact: true }), { travel: 0.4 });
    tk.hold(0.3);
    await tk.click(start.getByRole('button', { name: 'Start' }), { travel: 0.45, after: 0 });
    tk.cut();
    tk.wide({ ease: 0.01 });
    await tk.capture(400);
    tk.until(c.at('entries') - 0.6);
    await tk.click(role(page, 'button', 'Choose'), { travel: 0.5, after: 0.1 });
    const picker = page.getByRole('dialog', { name: 'Choose the records this report cites' });
    await tk.focus(picker, { zoom: 1.2, ease: 0.6, pad: 10 });
    await tk.click(picker.getByText('Reconciled 30 ULOs totaling $41,806.12 in SABRS'), { travel: 0.35, after: 0.05 });
    await tk.click(picker.getByText('Cleared 12 unmatched transactions in DAI'), { travel: 0.3, after: 0.05 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 's-facts');
    const picker = page.getByRole('dialog', { name: 'Choose the records this report cites' });
    const tk = take(page, F, 's-facts');
    await tk.start();
    await tk.click(picker.getByRole('button', { name: /Use \d+ selected/ }), { travel: 0.4, after: 0.1 });
    tk.wide({ ease: 0.5 });
    const text = page.getByLabel('Mission accomplishment text');
    await tk.focus(text.locator('xpath=ancestor::section[1]'), { zoom: 1.3, ease: 0.7, pad: 10 });
    await tk.type(text, 'Reconciled 30 ULOs worth $41,806.12 and cleared 12 UMTs, with zero findings at review.', { cps: 30 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 's-save');
    const tk = take(page, F, 's-save');
    await tk.start();
    await tk.click(role(page, 'button', 'Save revision'), { travel: 0.5, after: 0.2 });
    await tk.capture(300);
    tk.until(c.at('locked') - 0.5);
    await tk.focus(page.getByText('Saved through revision 1.').first(), { zoom: 1.7, ease: 0.9, pad: 70 }).catch(() => undefined);
    await tk.finish(c.dur);
  }
  await still(page, 's-saved');
  await context.close();
}

async function leading(browser) {
  const F = 'unit-dashboard';
  const { context, page } = await openDemo(browser, BASE, { persona: 'leader' });
  await still(page, 'l-bg');
  {
    const c = cue(F, 'l-today');
    const tk = take(page, F, 'l-today');
    await tk.start();
    tk.until(c.at('section', { nth: 0 }) - 0.4);
    const cards = page.getByText('Unassigned', { exact: true }).locator('xpath=ancestor::div[contains(@class,"grid")][1]');
    await tk.focus(cards, { zoom: 1.12, ease: 0.9, pad: 20 });
    for (const [w, label] of [['unassigned', 'Unassigned'], ['overdue', 'Overdue'], ['blocked', 'Blocked'], ['waiting', 'Waiting']]) {
      tk.until(c.at(w) - 0.25);
      await tk.point(page.getByText(label, { exact: true }).first(), { travel: 0.4, scroll: false });
    }
    tk.until(c.at('what', { nth: 0 }) - 0.2);
    await tk.focus(page.getByText('Waiting', { exact: true }).first().locator('xpath=ancestor::*[contains(@class,"card") or self::a][1]'), { zoom: 1.9, ease: 0.8, pad: 30 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'l-proc');
    const tk = take(page, F, 'l-proc');
    await tk.start();
    const row = page.locator('section', { hasText: 'Open work by procedure' }).first();
    await tk.focus(row, { zoom: 1.2, ease: 0.8, pad: 10 });
    for (const w of ['commitments', 'orders', 'umts']) {
      tk.until(c.at(w) - 0.3);
      const label = { commitments: 'OCMT', orders: 'UDOU', umts: '2-WAY UMT' }[w];
      await tk.point(row.getByText(label, { exact: true }).first(), { travel: 0.4, scroll: false }).catch(() => undefined);
    }
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'l-work');
    const tk = take(page, F, 'l-work');
    await tk.start();
    tk.wide({ ease: 0.5 });
    await tk.click(page.getByRole('link', { name: 'Full workload' }), { travel: 0.55, after: 0 });
    tk.cut();
    await tk.capture(500);
    tk.until(c.at('holds') - 0.4);
    await tk.focus(page.locator('main section, main [class*="card"]').filter({ hasText: /held/ }).first(), { zoom: 1.3, ease: 0.9, pad: 10 }).catch(() => undefined);
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'l-limits');
    const tk = take(page, F, 'l-limits');
    await tk.start();
    const how = page.getByText('How to read these numbers', { exact: true });
    await tk.reveal(how, { anchor: 0.35 });
    await tk.click(how, { travel: 0.5, after: 0.1 });
    const limits = how.locator('xpath=ancestor::details[1]');
    await tk.reveal(limits, { anchor: 0.3 });
    await tk.focus(limits, { zoom: 1.45, ease: 0.9, pad: 30 });
    await tk.finish(c.dur);
  }
  await context.close();
}

const FILMS = { hero, 'quick-log': quickLog, queue, 'reading-a-balance': balance, record, 'report-studio': studio, 'unit-dashboard': leading };

if (import.meta.url === `file://${process.argv[1]}`) {
  const want = process.argv.slice(2);
  const browser = await launch();
  for (const [id, fn] of Object.entries(FILMS)) {
    if (want.length && !want.includes(id)) continue;
    const t0 = Date.now();
    await fn(browser);
    console.log(`shots: ${id} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  await browser.close();
  collectTakes();
}

export { FILMS, cue };
