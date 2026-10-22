// 0.7.4 (audit F44): a number without a unit after a copied item name ("Team Captain 2", a name and a count
// copied from chat, "Strange Australium Minigun" then "21") was read as ref from every source, so the clipboard
// watcher popped up or notified "Flip: … scrap.tf 2.00 ref (copied)" for copies made in any app. scrap.tf writes
// every price with a unit: from the watcher such a number is no price and the item is checked alone, as a copy
// of its name would be; the hotkey and a typed check keep the ref reading with a fixed note. The text is never
// kept or quoted. Real schema fixture (test/fixtures/pricedb/schema-subset.json); nothing touches any network.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { flipNotification } from '../../src/main/liveCheck';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createLiveCheck, parseCheckText } from '../../src/service/domain/liveCheck';
import { createMarketIndex } from '../../src/service/domain/market';
import { createScraptfListCache, type ScraptfListCache } from '../../src/service/domain/scraptfList';
import { CHECK_BARE_REF_NOTE, checkPriceReadAsRef } from '../../src/shared/check';
import type { CheckResult, CheckSource } from '../../src/shared/types';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { FakeClock, FakeTimers, MIN, makeDeps, makeListing, noNetwork, silentLogger, testSettings } from './helpers';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(schemaDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

const parse = (t: string) => parseCheckText(t, (x) => schema.resolve(x));

async function setup() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const clock = new FakeClock();
  const now = clock.now();
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: now });
  // Team Captain buyers at 13.33 ref, and the user's own price of 1.33 ref (typed).
  repo.upsertListings([120, 119, 118].map((m, i) => makeListing({ id: `tc-${i}`, steamid: `TC${i}`, sku: '378;6', baseSku: '378;6', metalScrap: m, lastEventAt: now - MIN, userOnline: true })));
  repo.upsertScrapPrice({ sku: '378;6', name: 'Team Captain', costKeys: 0, costScrap: 12, source: 'user', observedAt: now - 10 * MIN });
  const timers = new FakeTimers(clock);
  const settings = testSettings();
  let list!: ScraptfListCache;
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now(), list.keyRow());
  list = createScraptfListCache({ repo, log: silentLogger, keyPrice });
  const real = createSchemaService(schemaDeps(schemaRoute(), { repo }));
  await real.init();
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings),
    http: noNetwork,
    schema: real,
    timers,
    keyPrice,
    onChanged: () => undefined,
    folderWatchActive: () => false,
    scraptfList: list,
  });
  market.start();
  await timers.advance(0);
  const lc = createLiveCheck({ repo, schema: real, log: silentLogger, settings: () => settings, keyPrice, market, scraptfList: list });
  return { now, check: (text: string, source: CheckSource): CheckResult => lc.check(text, source, now) };
}

describe('parseCheckText flags a bare whole number read as ref (real schema)', () => {
  it.each([
    ['Team Captain 2', true],
    ['Team Captain\t2', true],
    ['Team Captain\n2', true],
    ['Team Captain\t5\t3\t4/25', true],
    ['Team Captain 1.33', false],
    ['Team Captain, 1.33 ref', false],
    ['Team Captain 5 ref', false],
    ['Team Captain\n2 keys', false],
    ['Team Captain\t1 key, 6 refined\t1 key, 1 refined\t2/5', false],
    ['Team Captain', false],
  ])('%j: priceAmbiguous %s', (text, ambiguous) => {
    const r = parse(text);
    expect(r.ok, text).toBe(true);
    if (r.ok) expect(r.parsed.priceAmbiguous).toBe(ambiguous);
  });

  it('never flags a name that ends in a number and resolves whole', () => {
    expect(parse('Mann Co. Supply Crate Series #30')).toMatchObject({ ok: true, parsed: { form: 'name', price: null, priceAmbiguous: false } });
  });
});

describe('the Live check of a name followed by a bare number', () => {
  it('F44: from the watcher it is the item alone, never a copied "2.00 ref"', async () => {
    const h = await setup();
    const alone = h.check('Team Captain', 'watch');
    for (const text of ['Team Captain 2', 'Team Captain\t2', 'Team Captain\n2']) {
      const r = h.check(text, 'watch');
      // The user's own price, exactly as a copy of the name alone.
      expect(r, text).toMatchObject({ status: 'item', sku: '378;6', price: { source: 'typed', scrapRaw: 12 }, reason: null });
      expect({ ...r, id: 0 }).toEqual({ ...alone, id: 0 });
      expect(flipNotification(r)?.body ?? '').not.toContain('(copied)');
    }
    // A copied /items-like row keeps its stock and pays; only the unit-less price goes.
    const row = h.check('Team Captain\t5\t3\t4/25', 'watch');
    expect(row).toMatchObject({ status: 'item', price: { source: 'typed' }, stock: 4, stockLimit: 25 });
  });

  it('F44: the hotkey and a typed check keep it as ref, with the fixed note and no notification', async () => {
    const h = await setup();
    for (const source of ['hotkey', 'manual'] as const) {
      const r = h.check('Team Captain 2', source);
      expect(r, source).toMatchObject({ status: 'item', sku: '378;6', price: { keys: 0, scrapRaw: 18, source: 'clipboard' }, verdict: 'flip', reason: CHECK_BARE_REF_NOTE });
      expect(checkPriceReadAsRef(r)).toBe(true);
      expect(flipNotification(r)).toBeNull();
    }
    // The note never quotes the text.
    expect(CHECK_BARE_REF_NOTE).not.toMatch(/Team Captain|\b2\b/);
  });

  it('leaves a price with a unit or a decimal as it was, from every source', async () => {
    const h = await setup();
    for (const source of ['watch', 'hotkey', 'manual'] as const) {
      expect(h.check('Team Captain 5 ref', source), source).toMatchObject({ price: { scrapRaw: 45, source: 'clipboard' }, reason: null });
      expect(h.check('Team Captain 1.33', source), source).toMatchObject({ price: { scrapRaw: 12, source: 'clipboard' }, reason: null });
      expect(h.check('Team Captain\n2 keys', source), source).toMatchObject({ price: { keys: 2, scrapRaw: 0, source: 'clipboard' }, reason: null });
    }
    const watched = h.check('Team Captain, 1.33 ref', 'watch');
    expect(flipNotification(watched)?.body).toMatch(/^scrap\.tf 1\.33 ref \(copied\)/);
  });
});
