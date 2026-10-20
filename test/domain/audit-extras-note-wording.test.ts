// Audit livecheck-3: a plain check priced from the user's only stored copy with extras says so
// (CHECK_EXTRAS_NOTE), and the disabled Bought it says why. Strange parts or a name or description tag
// count as extras as much as paint and spells (isOtherCopy), so neither text may call that copy
// "painted or spelled" when it is neither. Real schema, repo, list cache and market index; no network.

import { afterEach, describe, expect, it } from 'vitest';
import { checkActions, checkBoughtInput, checkPriceLine } from '../../src/renderer/checkModel';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { selectKeyPrice } from '../../src/service/domain/keyprice';
import { createLiveCheck } from '../../src/service/domain/liveCheck';
import { createMarketIndex } from '../../src/service/domain/market';
import { createScraptfListCache, type ScraptfListCache } from '../../src/service/domain/scraptfList';
import { CHECK_EXTRAS_NOTE, checkPriceIsOtherCopy } from '../../src/shared/check';
import type { CheckResult, SpecialAttrs } from '../../src/shared/types';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { FakeClock, FakeTimers, MIN, T0, makeDeps, noNetwork, silentLogger, special, testSettings } from './helpers';

const PAINT = 3100495;

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

async function setup(): Promise<{ repo: Repo; check(text: string): CheckResult; now(): number }> {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
  const clock = new FakeClock();
  const timers = new FakeTimers(clock);
  const settings = testSettings();
  let list!: ScraptfListCache;
  const keyPrice = () => selectKeyPrice(repo.keyQuotes(), settings, clock.now(), list.keyRow());
  list = createScraptfListCache({ repo, log: silentLogger, keyPrice });
  const schema = createSchemaService(schemaDeps(schemaRoute(), { repo }));
  await schema.init();
  const market = createMarketIndex({
    ...makeDeps(repo, clock, () => settings),
    http: noNetwork,
    schema,
    timers,
    keyPrice,
    onChanged: () => undefined,
    folderWatchActive: () => false,
    scraptfList: list,
  });
  market.start();
  await timers.advance(0);
  const lc = createLiveCheck({ repo, schema, log: silentLogger, settings: () => settings, keyPrice, market, scraptfList: list });
  return { repo, check: (text) => lc.check(text, 'manual', clock.now()), now: () => clock.now() };
}

function storeOnly(repo: Repo, sku: string, name: string, extras: Partial<SpecialAttrs>): void {
  repo.upsertScrapPrice({ sku, name, costKeys: 0, costScrap: 30, source: 'import', observedAt: T0 - MIN, special: special(extras) });
}

describe('the extras note names the extras a copy can have', () => {
  it('a copy with strange parts only: the note and Bought it say parts, not "painted or spelled"', async () => {
    const h = await setup();
    storeOnly(h.repo, '205;11', 'Strange Rocket Launcher', { parts: ['Kills While Explosive-Jumping'] });
    const r = h.check('Strange Rocket Launcher');
    expect(r).toMatchObject({ status: 'item', sku: '205;11', reason: CHECK_EXTRAS_NOTE });
    expect(checkPriceIsOtherCopy(r)).toBe(true);
    expect(r.reason).not.toMatch(/painted or spelled/);
    expect(r.reason).toMatch(/parts/);
    const bought = checkActions(r).bought;
    expect(bought.enabled).toBe(false);
    expect(bought.title).toMatch(/parts/);
    expect(bought.title).not.toMatch(/painted or spelled/);
    expect(checkPriceLine(r, h.now()).title).toContain(CHECK_EXTRAS_NOTE);
  });

  it('a name-tagged copy only: the note and Bought it say tag', async () => {
    const h = await setup();
    storeOnly(h.repo, '378;6', 'Team Captain', { customName: true });
    const r = h.check('Team Captain');
    expect(r).toMatchObject({ sku: '378;6', reason: CHECK_EXTRAS_NOTE });
    expect(r.reason).toMatch(/tag/);
    expect(r.reason).not.toMatch(/painted or spelled/);
    expect(checkActions(r).bought.title).toMatch(/tag/);
    expect(checkActions(r).bought.title).not.toMatch(/painted or spelled/);
  });

  it('a painted copy only is still noted, and still never recorded as a buy', async () => {
    const h = await setup();
    storeOnly(h.repo, '378;6', 'Team Captain', { paint: PAINT });
    const r = h.check('Team Captain');
    expect(r.reason).toBe(CHECK_EXTRAS_NOTE);
    expect(r.reason).toMatch(/paint/);
    expect(checkBoughtInput(r)).toBeNull();
  });
});
