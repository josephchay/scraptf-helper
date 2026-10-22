// 0.9 (#13): parser evidence, report-first. scrap.tf's own price-drop wording on a card (2018 /buy/hats markup: "This
// item will decrease in price shortly.", "… off original price" / "(original price of …)") is a typed row flag and a
// report code, never an unparsed modifier; a countdown in a card's own text and a "recently traded" section are counted
// for the report only; and a bank page whose own visible text says its bank is not trading is no "saved without its
// cards" page. No real save has confirmed any of this wording, so nothing here changes a price, a timing or an alert.
// Synthetic pages and the synthetic fixtures; nothing is fetched.

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Engine, Logger, Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { parseScrapTfHtml } from '../../src/service/import';
import { clearImportReports, importReports } from '../../src/service/import/reports';
import { importSavedPage, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { BANK_UNAVAILABLE_WARNING, IMPORT_REPORT_NOTICES_MAX, PRICE_COUNTDOWN, PRICE_MARKDOWN, RECENT_SECTION, importWarningCode } from '../../src/shared/importCodes';
import type { ImportReport, ParsedScrapItem } from '../../src/shared/types';
import { createStubSchema } from './schemaStub';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const FIXTURES = fileURLToPath(new URL('../fixtures/import/', import.meta.url));
const SECRET = 'my-page-secret-7731';
const NOTICE = 'Hat Banking is temporarily disabled';

const repos: Repo[] = [];
beforeEach(() => clearImportReports());
afterEach(() => {
  while (repos.length) repos.pop()!.close();
  clearImportReports();
});

/** importReport.test.ts's setup(): an in-memory repo and the real importSavedPage. */
function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const settings = mergeSettings(DEFAULT_SETTINGS, { import: { enabled: true, acknowledgedAt: NOW - 3_600_000 } });
  const quiet = () => undefined;
  const log: Logger = { debug: quiet, info: quiet, warn: quiet, error: quiet };
  const ctx = {
    clock: { now: () => NOW },
    log,
    repo,
    schema: createStubSchema(),
    engine: { keyPrice: () => ({ valueScrap: 600 }), markDirty: quiet } as unknown as Engine,
    settings: () => settings,
    push: quiet,
    pricesChanged: quiet,
    scraptfListChanged: quiet,
    scraptfHistory: { onImport: () => 0 },
    bankStockChanged: quiet,
  } as unknown as HandlerContext;
  return { ctx, repo };
}

const attrs = (a: Record<string, string>) =>
  Object.entries(a)
    .map(([k, v]) => `${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
    .join(' ');

/** A Bill's Hat card at 1.66 ref; `content` its tooltip, `inner` extra children (its own text). */
function card(id: string, over: Record<string, string> = {}, inner = ''): string {
  return `<div ${attrs({ 'data-id': id, 'data-appid': '440', class: 'item hoverable quality6 app440', 'data-defindex': '126', 'data-title': "Bill's Hat", 'data-item-value': '15', ...over })}>
<div class="item-value-indicator">1.66 ref</div>
${inner}
</div>`;
}

/** An Unusual Le Sapeur without an effect: refused (no SKU). */
const REFUSED = card('9100000900', { class: 'item hoverable quality5 app440', 'data-defindex': '31540', 'data-title': 'Unusual Le Sapeur', 'data-item-value': '900' });

function page(body: string, slug = 'hats', head = ''): string {
  return `<!DOCTYPE html>
<!-- saved from url=(0025)https://scrap.tf/buy/${slug} -->
<html><head><title>Trading - TF2 - Scrap.TF</title>${head}</head>
<body id="pid-buy-${slug}"><p class="intro">${SECRET}</p>
${body}
</body></html>`;
}

function parse(html: string) {
  return parseScrapTfHtml(html, createStubSchema(), { diagnostics: true });
}

const codes = (i: ParsedScrapItem) => i.warnings.map(importWarningCode);

function importOne(html: string): ImportReport {
  const h = setup();
  importSavedPage(h.ctx, { html, fileName: 'page.html', mtimeMs: NOW - MIN });
  const [rep] = importReports();
  return rep!;
}

describe('0.9 (#13): price-drop wording on a card', () => {
  it('"This item will decrease in price shortly." in the tooltip: a price-markdown flag, never an unparsed modifier', () => {
    const html = page(`<div id="buy-container">${REFUSED}${card('9100000901', { 'data-content': 'Level 1<br/>This item will decrease in price shortly.' })}</div>`);
    const r = parse(html);
    const bill = r.items.find((i) => i.title.includes("Bill's Hat"))!;
    expect(bill.sku).toBe('126;6');
    expect(bill.markdown).toEqual(['soon']);
    expect(codes(bill)).toContain(PRICE_MARKDOWN);
    expect(codes(bill)).not.toContain('unparsed-modifier');
    expect(bill.warnings).toContain(`${PRICE_MARKDOWN}: scrap.tf says this item will decrease in price shortly`);
    // Still a price as usual.
    expect(bill.costScrap).toBe(15);
    expect(r.diagnostics!.counts).toMatchObject({ markdownSoon: 1, markdownOff: 0, countdownCards: 0, recentlyTraded: 0, recentCards: 0, bankNotices: 0 });

    const rep = importOne(html);
    // The refused card first, then the evidence card with its content line.
    expect(rep.items.map((i) => i.defindex)).toEqual([31540, 126]);
    expect(rep.items[1]!.contentLines).toContain('This item will decrease in price shortly.');
    expect(rep.items[1]!.warnings.some((w) => w.startsWith(`${PRICE_MARKDOWN}:`))).toBe(true);
    expect(rep.counts.markdownSoon).toBe(1);
    expect(rep).not.toHaveProperty('notices');
  });

  it('"0.22 ref off original price" + "(original price of 1.88 ref)": markdown off, quoting the original price', () => {
    const html = page(`<div id="buy-container">${card('9100000902', { 'data-content': '0.22 ref off original price<br/>(original price of 1.88 ref)' })}</div>`);
    const r = parse(html);
    const bill = r.items[0]!;
    expect(bill.markdown).toEqual(['off']);
    expect(codes(bill)).not.toContain('unparsed-modifier');
    expect(bill.warnings).toContain(`${PRICE_MARKDOWN}: scrap.tf shows it marked down from an original price of "1.88 ref"`);
    expect(r.diagnostics!.counts).toMatchObject({ markdownSoon: 0, markdownOff: 1 });
    expect(importOne(html).counts.markdownOff).toBe(1);
  });

  it('both forms in the card\'s own text (a child element) read the same; both together are off and soon', () => {
    const off = parse(page(`<div id="buy-container">${card('9100000903', {}, '<div class="price-drop">0.22 ref off original price (original price of 1.88 ref)</div>')}</div>`)).items[0]!;
    expect(off.markdown).toEqual(['off']);
    expect(off.warnings).toContain(`${PRICE_MARKDOWN}: scrap.tf shows it marked down from an original price of "1.88 ref"`);
    expect(off.costScrap).toBe(15);
    const soon = parse(page(`<div id="buy-container">${card('9100000904', {}, '<div>This item will decrease in price shortly.</div>')}</div>`)).items[0]!;
    expect(soon.markdown).toEqual(['soon']);
    const both = parse(page(`<div id="buy-container">${card('9100000905', { 'data-content': 'This item will decrease in price shortly.' }, '<div>0.22 ref off original price</div>')}</div>`));
    expect(both.items[0]!.markdown).toEqual(['off', 'soon']);
    expect(both.items[0]!.warnings).toContain(`${PRICE_MARKDOWN}: scrap.tf shows it marked down from its original price`);
    expect(both.diagnostics!.counts).toMatchObject({ markdownSoon: 1, markdownOff: 1 });
  });

  it("a quoted custom description using price-drop wording is the owner's words: customDesc, no markdown, nothing quoted in the report", () => {
    const OWNER = 'my mate Jonny Smith';
    const descs = [
      `''Bought at the original price of ${OWNER}''`,
      `''Got it 50% off original price from ${OWNER}''`,
      "''This item will decrease in price shortly.''",
      '"This item will decrease in price shortly."',
      `“Paid the original price of ${OWNER}”`,
    ];
    for (const d of descs) {
      const html = page(`<div id="buy-container">${card('9100000907', { 'data-content': `Level 5<br/>${d}` })}</div>`);
      const r = parse(html);
      const bill = r.items[0]!;
      expect(bill.sku, d).toBe('126;6');
      expect(bill.special.customDesc, d).toBe(true);
      expect(bill.markdown, d).toBeUndefined();
      expect(codes(bill), d).not.toContain(PRICE_MARKDOWN);
      expect(bill.warnings.join(' '), d).not.toContain(OWNER);
      expect(r.diagnostics!.counts, d).toMatchObject({ markdownSoon: 0, markdownOff: 0 });
      expect(JSON.stringify(r.diagnostics!.items), d).not.toContain(OWNER);
      const rep = importOne(html);
      expect(rep.counts, d).toMatchObject({ markdownSoon: 0, markdownOff: 0 });
      expect(JSON.stringify(rep), d).not.toContain(OWNER);
      expect(JSON.stringify(rep), d).not.toContain(PRICE_MARKDOWN);
    }
    // scrap.tf's own (unquoted) wording beside a description still reads as markdown.
    const both = parse(page(`<div id="buy-container">${card('9100000908', { 'data-content': "Level 5<br/>''Best hat ever''<br/>This item will decrease in price shortly." })}</div>`)).items[0]!;
    expect(both.special.customDesc).toBe(true);
    expect(both.markdown).toEqual(['soon']);
    // The control: a plain description.
    const plain = parse(page(`<div id="buy-container">${card('9100000909', { 'data-content': "Level 5<br/>''Best hat ever''" })}</div>`)).items[0]!;
    expect(plain.special.customDesc).toBe(true);
    expect(plain.markdown).toBeUndefined();
    expect(plain.warnings).toEqual([]);
  });

  it('keeps the evidence card\'s page-authored class tokens in the report', () => {
    const rep = importOne(page(`<div id="buy-container">${card('9100000906', { class: 'item hoverable quality6 app440 price-drop-soon', 'data-content': 'This item will decrease in price shortly.' })}</div>`));
    expect(rep.items[0]!.classTokens).toContain('price-drop-soon');
  });
});

describe('0.9 (#13): countdowns and "recently traded", report only', () => {
  it('a countdown in a card\'s own text: price-countdown and countdownCards, no markdown', () => {
    const html = page(`<div id="buy-container">${card('9100000910', {}, '<div class="timer">2:13:45</div>')}</div>`);
    const r = parse(html);
    const bill = r.items[0]!;
    expect(bill.warnings).toContain(`${PRICE_COUNTDOWN}: the card shows "2:13:45"`);
    expect(bill.markdown).toBeUndefined();
    expect(r.diagnostics!.counts).toMatchObject({ countdownCards: 1, markdownSoon: 0, markdownOff: 0 });
    expect(importOne(html).counts.countdownCards).toBe(1);
  });

  it('a stack count, a metal price or a key price is no countdown', () => {
    for (const inner of ['<span class="stack">x 3</span>', '<span>1.66 ref</span>', '<span>2 keys</span>', '<span>in 2 hats</span>']) {
      const r = parse(page(`<div id="buy-container">${card('9100000911', {}, inner)}</div>`));
      expect(codes(r.items[0]!), inner).not.toContain(PRICE_COUNTDOWN);
      expect(r.diagnostics!.counts.countdownCards, inner).toBe(0);
    }
  });

  it('a "Recently Traded" section: counted, its cards marked recent-section, and the phrase in the report notices', () => {
    const html = page(`<div id="buy-container">${card('9100000920')}</div><h3>Recently Traded</h3><div id="recent-items">${card('9100000921', { 'data-defindex': '378', 'data-title': 'Team Captain' })}</div>`);
    const r = parse(html);
    expect(r.diagnostics!.counts).toMatchObject({ recentlyTraded: 1, recentCards: 1 });
    const captain = r.items.find((i) => i.title.includes('Team Captain'))!;
    expect(captain.warnings).toContain(`${RECENT_SECTION}: the card sits in a part of the page whose id or class names "recent"`);
    expect(codes(r.items.find((i) => i.title.includes("Bill's Hat"))!)).not.toContain(RECENT_SECTION);
    expect(r.diagnostics!.notices).toContain('recently traded: "Recently Traded"');
    // Nothing else changes: both cards are prices as usual.
    expect(r.items.every((i) => i.sku !== null)).toBe(true);

    const rep = importOne(html);
    expect(rep.counts).toMatchObject({ recentlyTraded: 1, recentCards: 1 });
    expect(rep.notices).toContain('recently traded: "Recently Traded"');
    expect(rep.items.map((i) => i.defindex)).toEqual([378]);
  });

  it('a countdown inside a "recent" element outside the cards goes to the notices', () => {
    const r = parse(page(`<div id="buy-container">${card('9100000930')}</div><div class="recent-drops"><span>next drop in 45 minutes</span></div>`));
    expect(r.diagnostics!.notices).toEqual(['countdown in a "recent" section: "in 45 minutes"']);
    // Outside a "recent" element, a time is nobody's countdown.
    expect(parse(page(`<div id="buy-container">${card('9100000931')}</div><p>Open 10:30 to 18:00</p>`)).diagnostics!.notices).toEqual([]);
  });
});

describe('0.9 (#13): a page saying its bank is not trading', () => {
  const ALERT = `<div class="alert alert-danger"><strong>Hat Banking</strong> is temporarily disabled.</div>`;

  it('a hats page with only the notice: bank-unavailable, never no-cards-saved or no-items', () => {
    const html = page(ALERT);
    const r = parse(html);
    expect(r.warnings).toContain(BANK_UNAVAILABLE_WARNING);
    expect(r.warnings.map(importWarningCode)).not.toContain('no-cards-saved');
    expect(r.warnings.map(importWarningCode)).not.toContain('no-items');
    expect(r.bankNotice).toBe('unavailable');
    expect(r.bank).toBe('hats');

    const rep = importOne(html);
    expect(rep.counts.bankNotices).toBe(1);
    expect(rep.notices![0]).toBe(`bank notice: "${NOTICE}"`);
    // Nothing of the page but the matched phrase.
    expect(JSON.stringify(rep)).not.toContain(SECRET);
  });

  it('a notice that nothing shows is no notice: hidden, aria-hidden, a hiding class or style, noscript, script, template, title or a tooltip', () => {
    const hiddenForms = [
      `<div class="d-none">${NOTICE}.</div>`,
      `<div class="alert hidden">${NOTICE}.</div>`,
      `<div hidden>${NOTICE}.</div>`,
      `<div aria-hidden="true"><span>${NOTICE}.</span></div>`,
      `<div style="display: none">${NOTICE}.</div>`,
      `<div style="visibility:hidden">${NOTICE}.</div>`,
      `<noscript>${NOTICE}.</noscript>`,
      `<script>var s = "${NOTICE}";</script>`,
      `<template><div>${NOTICE}.</div></template>`,
      card('9100000940', { 'data-content': `${NOTICE}.` }),
      card('9100000941', {}, `<div>${NOTICE}.</div>`),
    ];
    for (const form of hiddenForms) {
      const r = parse(page(form));
      expect(r.diagnostics!.counts.bankNotices, form).toBe(0);
      expect(r.bankNotice, form).toBeUndefined();
      expect(r.warnings, form).not.toContain(BANK_UNAVAILABLE_WARNING);
    }
    // The page's title is never probed.
    const titled = `<!DOCTYPE html>\n<!-- saved from url=(0025)https://scrap.tf/buy/hats -->\n<html><head><title>${NOTICE}</title></head><body id="pid-buy-hats"></body></html>`;
    expect(parse(titled).diagnostics!.counts.bankNotices).toBe(0);
    expect(parse(titled).bankNotice).toBeUndefined();
  });

  it("another bank's notice is counted but is no notice of this page; a word-less one is", () => {
    const other = parse(page(ALERT, 'weapons'));
    expect(other.bank).toBe('weapons');
    expect(other.diagnostics!.counts.bankNotices).toBe(1);
    expect(other.warnings).not.toContain(BANK_UNAVAILABLE_WARNING);
    expect(other.bankNotice).toBeUndefined();
    // With no card, the weapons page is a page saved without its cards, as before.
    expect(other.warnings.map(importWarningCode)).toContain('no-cards-saved');

    const wordless = parse(page('<div class="alert">Banking is temporarily disabled.</div>', 'weapons'));
    expect(wordless.warnings).toContain(BANK_UNAVAILABLE_WARNING);
    expect(wordless.bankNotice).toBe('unavailable');
    expect(wordless.diagnostics!.notices).toEqual(['bank notice: "Banking is temporarily disabled"']);
  });

  it('a notice naming a category outside the bank list is counted but is no notice of any bank page (S3)', () => {
    const cards = `<div id="buy-container">${card('9100000960')}${card('9100000961', { 'data-defindex': '378', 'data-title': 'Team Captain' })}</div>`;
    const notOwn = (slug: string, alert: string) => {
      const r = parse(page(`<div class="alert alert-danger">${alert}</div>${cards}`, slug));
      expect(r.diagnostics!.counts.bankNotices, `${slug}: ${alert}`).toBe(1);
      expect(r.warnings, `${slug}: ${alert}`).not.toContain(BANK_UNAVAILABLE_WARNING);
      expect(r.bankNotice, `${slug}: ${alert}`).toBeUndefined();
    };
    const own = (slug: string, alert: string) => {
      const r = parse(page(`<div class="alert alert-danger">${alert}</div>${cards}`, slug));
      expect(r.warnings, `${slug}: ${alert}`).toContain(BANK_UNAVAILABLE_WARNING);
      expect(r.bankNotice, `${slug}: ${alert}`).toBe('unavailable');
    };
    for (const slug of ['hats', 'weapons', 'items']) {
      notOwn(slug, 'Card Banking is temporarily disabled.');
      notOwn(slug, 'Key Banking is temporarily disabled.');
      notOwn(slug, 'Card banking is currently disabled.');
      // Any other word right before "banking" names a category too, never "every bank".
      notOwn(slug, 'Promo Banking is temporarily disabled.');
      notOwn(slug, '<strong>Halloween</strong> banking is temporarily disabled.');
      notOwn(slug, 'constructor banking is temporarily disabled.');
    }
    // The items bank's own kinds are its notice; on another page they are not.
    own('items', 'Australium banking is temporarily disabled.');
    own('items', 'Taunt Banking is temporarily disabled.');
    notOwn('hats', 'Australium banking is temporarily disabled.');
    // "Unusual Hat banking" is the unusuals page's notice, never the hats page's.
    own('unusuals', 'Unusual Hat banking is temporarily disabled.');
    notOwn('hats', 'Unusual Hat banking is temporarily disabled.');
    // Word-less forms stay the page's own.
    own('hats', 'All banking is temporarily disabled.');
    own('hats', 'Sorry. Banking is temporarily disabled.');
    own('hats', '<strong>Note:</strong> Banking is temporarily disabled.');
    own('hats', 'Scrap.TF banking is temporarily disabled.');
  });

  it('an ordinary lead word before a bare "banking" names no category: the notice stays the page\'s own (recheck)', () => {
    const cards = `<div id="buy-container">${card('9100000980')}</div>`;
    const own = (slug: string, alert: string) => {
      const r = parse(page(`<div class="alert alert-danger">${alert}</div>${cards}`, slug));
      expect(r.diagnostics!.counts.bankNotices, `${slug}: ${alert}`).toBe(1);
      expect(r.warnings, `${slug}: ${alert}`).toContain(BANK_UNAVAILABLE_WARNING);
      expect(r.bankNotice, `${slug}: ${alert}`).toBe('unavailable');
    };
    for (const slug of ['hats', 'weapons', 'items']) {
      own(slug, 'Unfortunately banking is temporarily disabled.');
      own(slug, 'Currently banking is disabled.');
      own(slug, '<strong>Notice</strong> Banking is temporarily disabled.');
      own(slug, '<b>Warning</b> banking is temporarily disabled.');
      own(slug, 'Attention banking is temporarily disabled.');
      own(slug, 'Important banking is temporarily disabled.');
      own(slug, 'Update banking is temporarily disabled.');
      own(slug, 'Sorry banking is temporarily disabled.');
      own(slug, 'Please note banking is temporarily disabled.');
      own(slug, 'Due to Steam maintenance banking is temporarily disabled.');
      own(slug, 'Steam is having issues and banking is temporarily disabled.');
      own(slug, "Scrap.TF's banking is temporarily disabled.");
      own(slug, 'Scrap.TF’s banking is temporarily disabled.');
    }
  });

  it("a word in the block before a word-less notice is not the notice's category (a heading, a nav link)", () => {
    for (const before of ['<h1>Buy Weapons</h1>', '<nav><ul><li><a href="#">Keys</a></li><li><a href="#">Promo</a></li></ul></nav>', '<div>Stats</div>']) {
      const r = parse(page(`${before}<p>Banking is temporarily disabled.</p>`));
      expect(r.diagnostics!.counts.bankNotices, before).toBe(1);
      expect(r.warnings, before).toContain(BANK_UNAVAILABLE_WARNING);
      expect(r.bankNotice, before).toBe('unavailable');
      expect(r.diagnostics!.notices, before).toEqual(['bank notice: "Banking is temporarily disabled"']);
    }
    // Text right after a block's end (no element of its own) starts a new stretch too.
    const after = parse(page('<div><a href="#">Keys</a></div>Banking is temporarily disabled.'));
    expect(after.bankNotice).toBe('unavailable');
    // A card between them breaks the text as well.
    const carded = parse(page(`Promo<span class="item hoverable quality6 app440" data-defindex="126" data-title="Bill's Hat" data-item-value="15"></span>Banking is temporarily disabled.`));
    expect(carded.bankNotice).toBe('unavailable');
  });

  it('a hats save under a cards banner stores its bank stock save as usual', () => {
    const h = setup();
    const html = page(`<div class="alert alert-danger">Card Banking is temporarily disabled.</div><div id="buy-container">${card('9100000970')}</div>`);
    const res = importSavedPage(h.ctx, { html, fileName: 'page.html', mtimeMs: NOW - MIN });
    expect(res.stockSave).toBe('written');
    expect(h.repo.bankStockSaves('hats', 10)).toHaveLength(1);
  });

  it('a notice page that still shows cards keeps them as prices, with the notice warning', () => {
    const r = parse(page(`${ALERT}<div id="buy-container">${card('9100000950')}</div>`));
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.sku).toBe('126;6');
    expect(r.warnings).toContain(BANK_UNAVAILABLE_WARNING);
    expect(r.bankNotice).toBe('unavailable');
  });

  it('keeps at most IMPORT_REPORT_NOTICES_MAX notices', () => {
    const many = Array.from({ length: 8 }, (_, i) => `<p>Hat Banking is ${i % 2 ? 'currently' : 'temporarily'} offline.</p>`).join('');
    const r = parse(page(many));
    expect(r.diagnostics!.notices).toHaveLength(IMPORT_REPORT_NOTICES_MAX);
    expect(r.diagnostics!.counts.bankNotices).toBe(IMPORT_REPORT_NOTICES_MAX);
    expect(importOne(page(many)).notices).toHaveLength(IMPORT_REPORT_NOTICES_MAX);
  });
});

describe('0.9 (#13): the synthetic fixtures show none of it (F3)', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.html'));

  it('has fixtures to check', () => {
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  for (const f of files) {
    it(`${f}: no notice, no markdown, every evidence count 0`, () => {
      const r = parse(readFileSync(`${FIXTURES}${f}`, 'utf8'));
      expect(r.bankNotice).toBeUndefined();
      expect(r.warnings).not.toContain(BANK_UNAVAILABLE_WARNING);
      expect(r.diagnostics!.notices).toEqual([]);
      expect(r.diagnostics!.counts).toMatchObject({ markdownSoon: 0, markdownOff: 0, countdownCards: 0, recentlyTraded: 0, recentCards: 0, bankNotices: 0 });
      for (const i of r.items) {
        expect(i.markdown, i.title).toBeUndefined();
        for (const c of [PRICE_MARKDOWN, PRICE_COUNTDOWN, RECENT_SECTION]) expect(codes(i), `${i.title} ${c}`).not.toContain(c);
      }
    });
  }
});
