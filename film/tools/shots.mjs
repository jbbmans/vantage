import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, openDemo, openInstance, settle, still, take, collectTakes } from './capture.mjs';

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

// The films the demo cannot show run against a fresh accounts-mode instance (tools/instance.ts).
const INSTANCE = process.env.VANTAGE_FILM_INSTANCE_URL || 'http://localhost:8799';
const H = { 'x-vantage-client': '1' };
const OWNER = { username: 'morgan.diaz', password: 'harbor-quartz-lantern-4471' };
const OWNER_SETUP = { ...OWNER, first_name: 'Morgan', last_name: 'Diaz', rank_id: 'SSgt', mos: '3451', email: 'morgan.diaz@example.mil', unit_name: 'G-8 Budget Execution (synthetic)', unit_short_name: 'G-8 BE' };
const COMMAND = 'G-8-BE';
const TEAM = { name: 'Alpha Team (synthetic)', short_name: 'Alpha', id: 'ALPHA' };
const MARINE_PASSWORD = 'cobalt-orbit-velvet-anchor-927';

async function ensureInstance(request) {
  const status = await (await request.get(`${INSTANCE}/api/auth/setup`)).json();
  if (status.needsSetup) {
    const r = await request.post(`${INSTANCE}/api/auth/setup`, { data: OWNER_SETUP, headers: H });
    if (!r.ok()) throw new Error(`film instance setup: ${r.status()} ${await r.text()}`);
  }
}

async function ensureTeam(page) {
  const org = await (await page.request.get('/api/me/org')).json();
  if (!(org.units || []).some((u) => u.id === TEAM.id)) {
    const r = await page.request.post('/api/org/units', { data: { name: TEAM.name, short_name: TEAM.short_name, parent_id: COMMAND }, headers: H });
    if (!r.ok()) throw new Error(`film team: ${r.status()} ${await r.text()}`);
  }
}

/** Owner-console changes ask for the password again; answer on camera when they do. */
async function sudoIfAsked(tk, page) {
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  try { await dialog.waitFor({ state: 'visible', timeout: 1500 }); } catch { return false; }
  await tk.focus(dialog, { zoom: 1.35, ease: 0.6, pad: 20 });
  await tk.type(dialog.getByLabel('Current password'), OWNER.password, { cps: 40 });
  await tk.click(dialog.getByRole('button', { name: 'Confirm' }), { travel: 0.4, after: 0.2 });
  return true;
}

async function setupFilm(browser) {
  const F = 'setup';
  const { context, page } = await openInstance(browser, INSTANCE);
  const status = await (await page.request.get('/api/auth/setup')).json();
  if (!status.needsSetup) throw new Error('the setup film needs a fresh instance: restart tools/instance.ts');
  await page.goto('/', { waitUntil: 'networkidle' });
  {
    const c = cue(F, 'su-first');
    const tk = take(page, F, 'su-first');
    await tk.start();
    const card = page.locator('.auth-card');
    await tk.focus(card, { zoom: 1.2, ease: 0.8, pad: 10 });
    await tk.type(page.getByLabel('First name'), 'Morgan', { cps: 26 });
    await tk.type(page.getByLabel('Last name'), 'Diaz', { cps: 26 });
    await tk.click(page.getByRole('combobox', { name: 'Rank' }), { travel: 0.35, after: 0.05 });
    await tk.click(page.getByRole('option', { name: /^SSgt/ }), { travel: 0.35, after: 0.05 });
    await tk.type(page.getByLabel('Username'), 'morgan.diaz', { cps: 30 });
    await tk.type(page.getByLabel('Password', { exact: true }), OWNER.password, { cps: 48 });
    await tk.type(page.getByLabel('First unit'), OWNER_SETUP.unit_name, { cps: 40 });
    await tk.type(page.getByLabel('Short name'), OWNER_SETUP.unit_short_name, { cps: 26 });
    await tk.click(page.getByRole('button', { name: 'Create owner account' }), { travel: 0.4, after: 0 });
    await page.waitForURL((u) => !u.pathname.startsWith('/login') && !u.pathname.startsWith('/setup'));
    tk.cut();
    tk.wide({ ease: 0.01 });
    await tk.capture(600);
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'su-console');
    const tk = take(page, F, 'su-console');
    await tk.start();
    await tk.click(page.getByRole('link', { name: 'Owner console' }), { travel: 0.6, after: 0 });
    tk.cut();
    await tk.capture(500);
    await tk.focus(page.getByRole('heading', { level: 1 }).locator('xpath=..'), { zoom: 1.45, ease: 0.8, pad: 30 });
    tk.until(c.at('settings') - 0.5);
    await tk.focus(page.getByRole('tablist').first(), { zoom: 1.5, ease: 0.8, pad: 20 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'su-settings');
    const tk = take(page, F, 'su-settings');
    await tk.start();
    tk.wide({ ease: 0.5 });
    await tk.click(page.getByRole('tab', { name: 'Settings' }), { travel: 0.5, after: 0.1 });
    const switches = page.locator('section, .card').filter({ has: page.getByText('Self-registration', { exact: true }) }).last();
    await tk.focus(switches, { zoom: 1.4, ease: 0.8, pad: 10 });
    tk.until(c.at('register') - 0.6);
    await tk.click(switches.getByRole('switch').first(), { travel: 0.45, after: 0.15 });
    await tk.click(switches.getByRole('button', { name: 'Save' }), { travel: 0.45, after: 0.1 });
    await sudoIfAsked(tk, page);
    await tk.capture(400);
    await tk.focus(switches, { zoom: 1.4, ease: 0.7, pad: 10 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'su-units');
    const tk = take(page, F, 'su-units');
    await tk.start();
    await tk.goto('/team?tab=units');
    await tk.click(page.getByRole('button', { name: 'New unit' }), { travel: 0.5, after: 0.1 });
    const dialog = page.getByRole('dialog', { name: 'New unit' });
    await tk.focus(dialog, { zoom: 1.35, ease: 0.6, pad: 20 });
    await tk.type(dialog.getByLabel('Name'), TEAM.name, { cps: 34 });
    await tk.type(dialog.getByLabel('Short name'), TEAM.short_name, { cps: 26 });
    await tk.point(dialog.getByText('Parent unit', { exact: true }), { travel: 0.4 });
    tk.hold(0.3);
    await tk.click(dialog.getByRole('button', { name: 'Save' }), { travel: 0.4, after: 0.1 });
    await sudoIfAsked(tk, page);
    await tk.capture(500);
    tk.wide({ ease: 0.7 });
    tk.until(c.at('flows') - 0.4);
    await tk.focus(page.locator('main').getByText(TEAM.short_name, { exact: true }).first().locator('xpath=ancestor::*[self::li or self::tr or contains(@class,"card")][1]'), { zoom: 1.5, ease: 0.8, pad: 40 }).catch(() => undefined);
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'su-people');
    const tk = take(page, F, 'su-people');
    await tk.start();
    await tk.goto('/team?tab=invites');
    const form = page.getByLabel('First name').locator('xpath=ancestor::section[1]');
    await tk.focus(form, { zoom: 1.3, ease: 0.7, pad: 10 });
    await tk.type(page.getByLabel('First name'), 'Sam', { cps: 24 });
    await tk.type(page.getByLabel('Last name'), 'Patel', { cps: 24 });
    await tk.click(page.getByRole('button', { name: 'Create link' }), { travel: 0.45, after: 0.1 });
    await tk.focus(page.locator('[data-invite-url]').locator('xpath=..'), { zoom: 1.7, ease: 0.7, pad: 30 });
    tk.until(c.at('roster') - 0.9);
    await tk.goto('/operator?tab=users');
    await tk.focus(page.getByRole('button', { name: 'Import accounts' }), { zoom: 2.0, ease: 0.8, pad: 90 });
    await tk.point(page.getByRole('button', { name: 'Import accounts' }), { travel: 0.5 });
    await tk.finish(c.dur);
  }
  await context.close();
}

async function governance(browser) {
  const F = 'governance';
  const { context: bootstrap } = { context: await browser.newContext() };
  await ensureInstance(bootstrap.request);
  await bootstrap.close();
  const { context, page } = await openInstance(browser, INSTANCE, OWNER);
  await page.goto('/operator?tab=retention', { waitUntil: 'networkidle' });
  {
    const c = cue(F, 'g-sched');
    const tk = take(page, F, 'g-sched');
    await tk.start();
    const panel = page.locator('section, .card').filter({ has: page.getByRole('heading', { name: 'Retention schedules' }) }).first();
    await tk.focus(panel, { zoom: 1.2, ease: 0.8, pad: 10 });
    tk.until(c.at('off') - 0.3);
    await tk.point(page.getByText('not set').first(), { travel: 0.45 });
    tk.until(c.at('one', { nth: 0 }) - 0.5);
    await tk.click(page.locator('tr', { hasText: 'Activities' }).getByRole('button', { name: 'Set' }), { travel: 0.5, after: 0.1 });
    const dialog = page.getByRole('dialog', { name: 'Retention for Activities' });
    await tk.focus(dialog, { zoom: 1.4, ease: 0.6, pad: 20 });
    tk.until(c.at('authority') - 1.0);
    await tk.type(dialog.getByLabel('Authority'), 'Unit records SOP 5210 (synthetic)', { cps: 48 });
    await tk.click(dialog.getByRole('switch'), { travel: 0.4, after: 0.1 });
    await tk.click(dialog.getByRole('button', { name: 'Save schedule' }), { travel: 0.4, after: 0.1 });
    await sudoIfAsked(tk, page);
    await tk.capture(400);
    tk.wide({ ease: 0.6 });
    await tk.focus(page.locator('tr', { hasText: 'Activities' }), { zoom: 1.6, ease: 0.7, pad: 30 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'g-preview');
    const tk = take(page, F, 'g-preview');
    await tk.start();
    await tk.click(page.getByRole('button', { name: 'See what is eligible' }), { travel: 0.45, after: 0.1 });
    await sudoIfAsked(tk, page);
    const would = page.getByRole('heading', { name: 'What disposition would do now' }).locator('xpath=ancestor::section[1]');
    await tk.reveal(would, { anchor: 0.3 });
    await tk.focus(would, { zoom: 1.35, ease: 0.7, pad: 10 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'g-hold');
    const tk = take(page, F, 'g-hold');
    await tk.start();
    await tk.click(page.getByRole('button', { name: 'Place a hold' }), { travel: 0.5, after: 0.1 });
    const dialog = page.getByRole('dialog', { name: 'Place a legal hold' });
    await tk.focus(dialog, { zoom: 1.4, ease: 0.6, pad: 20 });
    await tk.type(dialog.getByLabel('Reason'), 'IG inquiry 2026-14 (synthetic)', { cps: 30 });
    await tk.click(dialog.getByRole('button', { name: 'Place the hold' }), { travel: 0.4, after: 0.1 });
    await sudoIfAsked(tk, page);
    await tk.capture(500);
    await tk.scroll(0, 0.8);
    await tk.focus(page.getByText('An instance-wide legal hold is open').locator('xpath=ancestor::*[@role="alert"][1]'), { zoom: 1.5, ease: 0.8, pad: 30 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'g-inventory');
    const tk = take(page, F, 'g-inventory');
    await tk.start();
    tk.wide({ ease: 0.5 });
    await tk.click(page.getByRole('tab', { name: 'Privacy' }), { travel: 0.5, after: 0.1 });
    const stats = page.getByText('Tables holding personal data').locator('xpath=ancestor::div[contains(@class,"grid")][1]');
    await tk.focus(stats, { zoom: 1.25, ease: 0.8, pad: 10 });
    tk.until(c.at('live') - 0.3);
    const inventory = page.getByRole('heading', { name: 'Data inventory' }).locator('xpath=ancestor::section[1]');
    await tk.reveal(page.getByRole('cell', { name: 'users', exact: true }), { anchor: 0.3, seconds: 1.3 });
    await tk.click(page.getByRole('cell', { name: 'users', exact: true }), { travel: 0.5, after: 0.1 });
    await tk.focus(page.getByText(/password_hash · authentication/).locator('xpath=ancestor::tr[1]'), { zoom: 1.4, ease: 0.8, pad: 20 }).catch(() => tk.focus(inventory, { zoom: 1.2 }));
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'g-export');
    const tk = take(page, F, 'g-export');
    await tk.start();
    const exportButton = page.getByRole('button', { name: 'Export for the PIA' });
    await tk.reveal(exportButton, { anchor: 0.3 });
    await tk.focus(exportButton.locator('xpath=ancestor::section[1]'), { zoom: 1.3, ease: 0.7, pad: 10, dy: -120 });
    await tk.hover(exportButton, { travel: 0.5 });
    await tk.focus(exportButton, { zoom: 2.2, ease: 0.8, pad: 80 });
    await tk.finish(c.dur);
  }
  await context.close();
}

async function firstWeek(browser) {
  const F = 'first-week';
  const boot = await browser.newContext();
  await ensureInstance(boot.request);
  await boot.close();
  const owner = await openInstance(browser, INSTANCE, OWNER);
  await ensureTeam(owner.page);
  const invite = async (data) => {
    const r = await owner.page.request.post(`/api/org/units/${TEAM.id}/invites`, { data: { billet: 'Budget analyst', ...data }, headers: H });
    if (!r.ok()) throw new Error(`invite: ${r.status()} ${await r.text()}`);
    return (await r.json()).url;
  };
  // Teammates already aboard, off camera.
  for (const [first, last, rank, username] of [['Riley', 'Chen', 'Cpl', 'riley.chen'], ['Taylor', 'Nguyen', 'Cpl', 'taylor.nguyen']]) {
    const url = await invite({ first_name: first, last_name: last, rank_id: rank });
    const token = new URL(url).searchParams.get('token');
    const guest = await browser.newContext({ baseURL: INSTANCE });
    const r = await guest.request.post('/api/auth/invite/accept', { data: { token, username, password: MARINE_PASSWORD, first_name: first, last_name: last, rank_id: rank }, headers: H });
    if (!r.ok() && r.status() !== 409) throw new Error(`accept ${username}: ${r.status()} ${await r.text()}`);
    await guest.close();
  }
  const url = await invite({ first_name: 'Sam', last_name: 'Patel', rank_id: 'LCpl' });
  await owner.context.close();

  const { context, page } = await openInstance(browser, INSTANCE);
  await page.goto(url, { waitUntil: 'networkidle' });
  {
    const c = cue(F, 'fw-invite');
    const tk = take(page, F, 'fw-invite');
    await tk.start();
    const card = page.locator('.auth-card');
    await tk.focus(card, { zoom: 1.25, ease: 0.8, pad: 10 });
    tk.until(c.at('choose') - 0.5);
    await tk.type(page.getByLabel('Username'), 'sam.patel', { cps: 24 });
    await tk.type(page.getByLabel('Password', { exact: true }), MARINE_PASSWORD, { cps: 44 });
    await tk.click(page.getByRole('button', { name: 'Join and sign in' }), { travel: 0.45, after: 0 });
    await page.waitForURL((u) => !u.pathname.startsWith('/invite'));
    tk.cut();
    tk.wide({ ease: 0.01 });
    await tk.capture(700);
    await tk.finish(c.dur);
  }
  const list = page.getByRole('region', { name: 'Your first week' });
  {
    const c = cue(F, 'fw-list');
    const tk = take(page, F, 'fw-list');
    await tk.start();
    await tk.focus(list, { zoom: 1.2, ease: 0.8, pad: 10 });
    tk.until(c.at('ticks') - 0.4);
    await tk.point(list.locator('li').first(), { travel: 0.5 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'fw-secure');
    const tk = take(page, F, 'fw-secure');
    await tk.start();
    await tk.click(list.getByRole('link', { name: 'Secure' }), { travel: 0.5, after: 0 });
    tk.cut();
    tk.wide({ ease: 0.01 });
    await tk.capture(500);
    tk.until(c.at('passkey') - 0.4);
    await tk.focus(page.getByText('Passkeys', { exact: true }).locator('xpath=ancestor::section[1]'), { zoom: 1.45, ease: 0.8, pad: 10 });
    tk.until(c.at('authenticator') - 0.4);
    await tk.focus(page.getByText('Authenticator app', { exact: true }).locator('xpath=ancestor::section[1]'), { zoom: 1.45, ease: 0.8, pad: 10 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'fw-profile');
    const tk = take(page, F, 'fw-profile');
    await tk.start();
    await tk.goto('/settings?tab=profile');
    const identity = page.getByText('Identity', { exact: true }).locator('xpath=ancestor::section[1]');
    await tk.focus(identity, { zoom: 1.3, ease: 0.6, pad: 10 });
    await tk.type(page.getByLabel('MOS'), '3451', { cps: 20 });
    tk.until(c.at('rank', { nth: 0 }) - 0.2);
    await tk.focus(page.getByText('decides JEPES vs FITREP'), { zoom: 2.2, ease: 0.7, pad: 60 });
    tk.hold(0.6);
    tk.wide({ ease: 0.6 });
    await tk.click(identity.getByRole('button', { name: 'Save' }), { travel: 0.45, after: 0.1 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'fw-first');
    const tk = take(page, F, 'fw-first');
    await tk.start();
    await tk.goto('/');
    await tk.press('n', { after: 0.2 });
    const dialog = page.getByRole('dialog', { name: 'Log activity' });
    await tk.focus(dialog, { zoom: 1.25, ease: 0.7, pad: 12, dx: 60 });
    await tk.type(dialog.getByLabel('What did you do?'), 'Reconciled 12 ULOs in DAI for the Q4 review', { cps: 28 });
    await tk.click(dialog.getByRole('button', { name: 'Save activity' }), { travel: 0.45, after: 0.2 });
    tk.wide({ ease: 0.6 });
    await tk.capture(600);
    await tk.focus(list, { zoom: 1.2, ease: 0.8, pad: 10 }).catch(() => undefined);
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'fw-team');
    const tk = take(page, F, 'fw-team');
    await tk.start();
    await tk.click(list.getByRole('link', { name: 'Open' }), { travel: 0.5, after: 0 });
    tk.cut();
    tk.wide({ ease: 0.01 });
    await tk.capture(700);
    tk.until(c.at('command') - 0.5);
    await tk.click(page.getByTestId('view-switcher'), { travel: 0.5, after: 0.1 });
    await tk.focus(page.getByRole('listbox', { name: 'Views' }), { zoom: 1.7, ease: 0.7, pad: 30 });
    tk.until(c.at('goals') - 0.6);
    await tk.press('Escape', { show: false, after: 0.1 });
    await tk.focus(page.locator('main').getByText('Roster', { exact: true }).locator('xpath=ancestor::section[1]'), { zoom: 1.25, ease: 0.8, pad: 10 }).catch(() => undefined);
    await tk.finish(c.dur);
  }
  await context.close();
}

async function visibility(browser) {
  const F = 'visibility';
  const { context, page } = await openDemo(browser, BASE);
  // A leader opens this Marine's record first, off camera, so the access log has something true to show.
  const me = await (await page.request.get('/api/me')).json();
  await page.request.post('/api/demo/persona', { data: { persona: 'leader' }, headers: H });
  await page.goto(`/team/${me.user.id}`, { waitUntil: 'networkidle' });
  await page.request.post('/api/demo/persona', { data: { persona: 'marine' }, headers: H });
  await page.goto('/', { waitUntil: 'networkidle' });
  const dialog = page.getByRole('dialog', { name: 'Log activity' });
  {
    const c = cue(F, 'v-choose');
    const tk = take(page, F, 'v-choose');
    await tk.start();
    await tk.press('n', { after: 0.2 });
    await tk.focus(dialog, { zoom: 1.25, ease: 0.7, pad: 12, dx: 60 });
    await tk.type(dialog.getByLabel('What did you do?'), 'Briefed 14 Marines on the travel policy', { cps: 30 });
    tk.until(c.at('choose') - 0.6);
    await tk.click(dialog.getByRole('button', { name: /Organization, system, notes, visibility/ }), { travel: 0.45, after: 0.1 });
    const audience = dialog.getByRole('radio', { name: 'Only me' }).locator('xpath=ancestor::*[@role="radiogroup"][1]');
    await tk.reveal(audience);
    await tk.focus(audience, { zoom: 1.7, ease: 0.8, pad: 30 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'v-private');
    const tk = take(page, F, 'v-private');
    await tk.start();
    await tk.click(dialog.getByRole('radio', { name: 'Only me' }), { travel: 0.5, after: 0.2 });
    tk.until(c.at('owner') - 0.4);
    await tk.focus(dialog.getByRole('radio', { name: 'Only me' }), { zoom: 2.1, ease: 0.8, pad: 50 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'v-unit');
    const tk = take(page, F, 'v-unit');
    await tk.start();
    await tk.click(dialog.getByRole('radio', { name: /Share with unit/ }), { travel: 0.5, after: 0.2 });
    await tk.focus(dialog.getByRole('radio', { name: /Share with unit/ }), { zoom: 2.0, ease: 0.8, pad: 50 });
    tk.until(c.at('dashboard') - 0.6);
    await tk.click(dialog.getByRole('button', { name: 'Save activity' }), { travel: 0.45, after: 0.2 });
    tk.wide({ ease: 0.6 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'v-says');
    const tk = take(page, F, 'v-says');
    await tk.start();
    await tk.goto('/record?tab=entries');
    await tk.click(page.locator('main').getByText('Briefed 14 Marines on the travel policy').first(), { travel: 0.5, after: 0 });
    tk.cut();
    await tk.capture(500);
    const line = page.getByText(/^Shared with /).first();
    await tk.focus(line, { zoom: 2.0, ease: 0.8, pad: 60 });
    tk.until(c.at('plain') - 0.3);
    await tk.reveal(page.getByText(/Visible on the unit dashboard/), { anchor: 0.45 });
    await tk.focus(page.getByText(/Visible on the unit dashboard/).locator('xpath=ancestor::section[1]'), { zoom: 1.5, ease: 0.8, pad: 20 }).catch(() => undefined);
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'v-never');
    const tk = take(page, F, 'v-never');
    await tk.start();
    await tk.goto('/settings?tab=security');
    const looked = page.getByText('Who has looked at your record', { exact: true }).locator('xpath=ancestor::section[1]');
    await tk.reveal(looked, { anchor: 0.2 });
    tk.until(c.at('logged') - 1.2);
    await tk.focus(looked, { zoom: 1.4, ease: 0.8, pad: 10 });
    await tk.finish(c.dur);
  }
  await context.close();
}

async function importFilm(browser) {
  const F = 'import';
  const { context, page } = await openDemo(browser, BASE, { persona: 'leader' });
  const sheet = await (await page.request.get('/api/demo/sample.csv')).body();
  const file = { name: 'FY26-Q4-UMT-batch-2 (synthetic).csv', mimeType: 'text/csv', buffer: sheet };
  await page.goto('/work?tab=queue', { waitUntil: 'networkidle' });
  const dialog = page.getByRole('dialog');
  {
    const c = cue(F, 'i-bring');
    const tk = take(page, F, 'i-bring');
    await tk.start();
    await tk.click(page.getByRole('button', { name: 'Import a spreadsheet' }).first(), { travel: 0.55, after: 0.1 });
    await tk.focus(dialog, { zoom: 1.3, ease: 0.6, pad: 20 });
    tk.until(c.at('original') - 0.6);
    await tk.focus(dialog.getByText(/original file is kept unchanged/i), { zoom: 1.9, ease: 0.8, pad: 50 });
    tk.hold(0.4);
    await page.getByLabel('Spreadsheet to import').setInputFiles(file);
    await tk.capture(700);
    await tk.focus(dialog, { zoom: 1.3, ease: 0.7, pad: 20 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'i-map');
    const tk = take(page, F, 'i-map');
    await tk.start();
    await tk.click(dialog.getByRole('button', { name: 'Next' }), { travel: 0.45, after: 0.2 });
    await tk.focus(dialog, { zoom: 1.2, ease: 0.7, pad: 10 });
    tk.until(c.at('correct') - 0.4);
    await tk.point(dialog.getByLabel('Which column identifies each row'), { travel: 0.5 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'i-preview');
    const tk = take(page, F, 'i-preview');
    await tk.start();
    await tk.click(dialog.getByRole('button', { name: 'Preview' }), { travel: 0.45, after: 0.2 });
    await tk.focus(dialog, { zoom: 1.25, ease: 0.7, pad: 10 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'i-run');
    const tk = take(page, F, 'i-run');
    await tk.start();
    await tk.click(dialog.getByRole('button', { name: /^Import \d+ rows?/ }), { travel: 0.5, after: 0.2 });
    await tk.capture(900);
    await tk.focus(dialog.getByText(/new, \d+ updated/), { zoom: 1.8, ease: 0.7, pad: 60 });
    tk.until(c.at('queue') - 0.3);
    await tk.click(dialog.getByRole('button', { name: 'Open the queue' }), { travel: 0.45, after: 0 });
    tk.cut();
    tk.wide({ ease: 0.01 });
    await tk.capture(600);
    await tk.type(page.getByPlaceholder(/Identifier, title or reference/), 'SYN-26-P-0101', { cps: 34 });
    await tk.focus(page.locator('table').first(), { zoom: 1.2, ease: 0.7, pad: 10 });
    tk.until(c.at('traced') - 1.1);
    await tk.click(page.locator('tr', { hasText: 'SYN-26-P-0101' }).getByText('SYN-26-P-0101'), { travel: 0.45, after: 0 });
    tk.cut();
    await tk.capture(600);
    const origin = page.getByText(/The original file is kept unchanged\./).first();
    await tk.reveal(origin, { anchor: 0.4 });
    await tk.focus(origin, { zoom: 2.0, ease: 0.7, pad: 40 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'i-again');
    await page.goto('/work?tab=queue', { waitUntil: 'networkidle' });
    const tk = take(page, F, 'i-again');
    await tk.start();
    await tk.click(page.getByRole('button', { name: 'Import a spreadsheet' }).first(), { travel: 0.5, after: 0.1 });
    await page.getByLabel('Spreadsheet to import').setInputFiles(file);
    await tk.capture(600);
    await tk.click(dialog.getByRole('button', { name: 'Next' }), { travel: 0.4, after: 0.1 });
    await tk.click(dialog.getByRole('button', { name: 'Preview' }), { travel: 0.4, after: 0.2 });
    const same = dialog.getByText(/Everything in this file is already here, unchanged/);
    await tk.reveal(same);
    await tk.focus(same, { zoom: 1.8, ease: 0.8, pad: 50 });
    await tk.finish(c.dur);
  }
  await context.close();
}

async function analysisFilm(browser) {
  const F = 'analysis';
  const { context, page } = await openDemo(browser, BASE);
  await page.goto('/reports?tab=analysis', { waitUntil: 'networkidle' });
  {
    const c = cue(F, 'a-open');
    const tk = take(page, F, 'a-open');
    await tk.start();
    await tk.click(page.getByRole('tab', { name: 'Full analysis' }), { travel: 0.55, after: 0.2 });
    await tk.focus(page.getByRole('heading', { name: 'Executive summary' }).locator('xpath=ancestor::section[1]'), { zoom: 1.2, ease: 0.8, pad: 10, dy: -120 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'a-units');
    const tk = take(page, F, 'a-units');
    await tk.start();
    await tk.scroll(0, 0.8);
    const produced = page.getByText(/What the work produced/i).first().locator('xpath=following-sibling::*[1]');
    await tk.focus(produced, { zoom: 1.35, ease: 0.8, pad: 20 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'a-summary');
    const tk = take(page, F, 'a-summary');
    await tk.start();
    const summary = page.getByRole('heading', { name: 'Executive summary' }).locator('xpath=ancestor::section[1]');
    await tk.reveal(summary, { anchor: 0.08 });
    await tk.focus(summary.locator('ul').first(), { zoom: 1.5, ease: 0.8, pad: 20 });
    tk.until(c.at('gap') - 0.4);
    await tk.point(summary.getByText(/Longest gap/).first(), { travel: 0.5, scroll: false });
    tk.until(c.at('pace') - 0.4);
    await tk.point(summary.getByText(/At the current pace/).first(), { travel: 0.5, scroll: false });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'a-coverage');
    const tk = take(page, F, 'a-coverage');
    await tk.start();
    const coverage = page.getByRole('heading', { name: 'Coverage' }).locator('xpath=ancestor::section[1]');
    await tk.reveal(coverage, { anchor: 0.15, seconds: 1.4 });
    await tk.focus(coverage, { zoom: 1.35, ease: 0.8, pad: 10 });
    tk.until(c.at('strengthen') - 0.4);
    await tk.focus(page.getByRole('heading', { name: 'Data quality' }).locator('xpath=ancestor::section[1]'), { zoom: 1.4, ease: 0.8, pad: 10 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'a-behind');
    const tk = take(page, F, 'a-behind');
    await tk.start();
    await tk.goto('/');
    const card = page.locator('main').getByRole('button').filter({ hasText: /outcomes?/ }).first();
    await tk.reveal(card, { anchor: 0.35, seconds: 1.0 });
    await tk.focus(card, { zoom: 1.8, ease: 0.7, pad: 30 });
    await tk.click(card, { travel: 0.5, after: 0.2 });
    await tk.focus(page.getByRole('dialog'), { zoom: 1.3, ease: 0.7, pad: 20 });
    await tk.finish(c.dur);
  }
  await context.close();
}

async function counselingFilm(browser) {
  const F = 'counseling';
  const { context, page } = await openDemo(browser, BASE, { persona: 'leader' });
  await page.goto('/team?tab=roster', { waitUntil: 'networkidle' });
  await page.locator('tr', { hasText: 'Avery' }).getByRole('link', { name: 'Open' }).click();
  await settle(page, 500);
  const memberUrl = page.url();
  const summary = 'Strong first quarter: 30 ULOs reconciled with zero findings. Next, lead the Q1 UMT review.';
  {
    const c = cue(F, 'c-record');
    const tk = take(page, F, 'c-record');
    await tk.start();
    await tk.click(page.getByRole('button', { name: 'Record counseling' }), { travel: 0.55, after: 0.1 });
    const dialog = page.getByRole('dialog', { name: /Counsel Avery/ });
    await tk.focus(dialog, { zoom: 1.25, ease: 0.6, pad: 10 });
    await tk.type(dialog.getByLabel('Summary'), summary, { cps: 46 });
    tk.until(c.at('well') - 0.6);
    await tk.type(dialog.getByLabel('Strengths'), 'Accurate, fast, and documents every step.', { cps: 40 });
    tk.until(c.at('improve') - 0.4);
    await tk.type(dialog.getByLabel('Areas to improve'), 'Brief the section lead before month-end close.', { cps: 40 });
    tk.until(c.at('goals') - 0.4);
    await tk.type(dialog.getByLabel('Goals set'), 'Lead the Q1 UMT review.', { cps: 40 });
    await tk.finish(c.dur);
  }
  {
    const c = cue(F, 'c-save');
    const tk = take(page, F, 'c-save');
    await tk.start();
    const dialog = page.getByRole('dialog', { name: /Counsel Avery/ });
    await tk.click(dialog.getByRole('button', { name: 'Add counseling' }), { travel: 0.45, after: 0.2 });
    tk.wide({ ease: 0.6 });
    await tk.click(page.getByRole('tab', { name: /Counseling/ }), { travel: 0.5, after: 0.2 });
    await tk.focus(page.locator('main').getByText(summary.slice(0, 40), { exact: false }).first().locator('xpath=ancestor::*[self::li or self::tr or contains(@class,"card")][1]'), { zoom: 1.5, ease: 0.8, pad: 30 }).catch(() => undefined);
    await tk.finish(c.dur);
  }
  await page.request.post('/api/demo/persona', { data: { persona: 'marine' }, headers: H });
  await page.goto('/career?tab=counseling', { waitUntil: 'networkidle' });
  {
    const c = cue(F, 'c-ack');
    const tk = take(page, F, 'c-ack');
    await tk.start();
    const row = page.locator('tr', { hasText: summary.slice(0, 40) }).first();
    await tk.focus(row, { zoom: 1.5, ease: 0.7, pad: 30 });
    await tk.click(row.getByRole('button').first(), { travel: 0.5, after: 0.2 });
    const view = page.getByRole('dialog');
    await tk.focus(view, { zoom: 1.2, ease: 0.6, pad: 10 });
    tk.until(c.at('confirms') - 0.6);
    await tk.focus(view.getByText('Acknowledging confirms you read it, not that you agree.').locator('xpath=..'), { zoom: 1.7, ease: 0.7, pad: 30 });
    await tk.click(view.getByRole('button', { name: 'Acknowledge' }), { travel: 0.45, after: 0.2 });
    tk.wide({ ease: 0.6 });
    await tk.finish(c.dur);
  }
  await page.request.post('/api/demo/persona', { data: { persona: 'leader' }, headers: H });
  await page.goto(memberUrl, { waitUntil: 'networkidle' });
  {
    const c = cue(F, 'c-both');
    const tk = take(page, F, 'c-both');
    await tk.start();
    await tk.click(page.getByRole('tab', { name: /Counseling/ }), { travel: 0.5, after: 0.2 });
    const acknowledged = page.locator('main').getByText(/Acknowledged/).first();
    await tk.reveal(acknowledged);
    await tk.focus(acknowledged.locator('xpath=ancestor::*[self::li or self::tr or contains(@class,"card")][1]'), { zoom: 1.5, ease: 0.8, pad: 30 }).catch(() => undefined);
    await tk.finish(c.dur);
  }
  await context.close();
}

const FILMS = { hero, 'quick-log': quickLog, queue, 'reading-a-balance': balance, record, 'report-studio': studio, 'unit-dashboard': leading, setup: setupFilm, governance, 'first-week': firstWeek, visibility, import: importFilm, analysis: analysisFilm, counseling: counselingFilm };

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
