// F17 S3: "New on scrap.tf (<Bank>): <name>" notifications after an import of a bank page
// (notifyNewBankFlips over the real bank stock cache and an in-memory repo). Pins the gates
// (notifications.enabled, newOnScraptf, inputKinds 'import', minConfidence, minProfitScrap), the
// per bank and SKU dedupe for 30 min persisted in repo meta (so a restart notifies nothing twice),
// at most 3 then one summary, and silence on a first save or an older page imported late. Pages
// the user saved only (R10); nothing touches scrap.tf or any network.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { BANK_STOCK_NOTIFY_META_KEY, createBankStock, createNewFlipNotifier, notifyNewBankFlips, type BankStock } from '../../src/service/domain/bankStock';
import type { MarketEval } from '../../src/service/domain/market';
import { BANK_STOCK_NOTIFY_DEDUP_MS, bankStockNewFlipNotice, bankStockSpecialKey } from '../../src/shared/bankStock';
import { maxCostFor } from '../../src/shared/ceiling';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { PushContract } from '../../src/shared/rpc';
import type { BankStockStored, DeepPartial, KeyPriceState, ScraptfBank, Settings, UnixMs } from '../../src/shared/types';
import { recordingLogger } from './helpers';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY: KeyPriceState = { valueScrap: 600, source: 'bptf', observedAt: NOW, stale: false, quotes: [], scraptfFromList: null };

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function s(sku: string, costScrap: number, over: Partial<BankStockStored> = {}): BankStockStored {
  return { sku, specialKey: '', name: `Hat ${sku}`, costKeys: 0, costScrap, stock: 1, assetId: null, ...over };
}

function save(repo: Repo, bank: ScraptfBank, at: UnixMs, rows: readonly BankStockStored[]): number {
  const id = repo.createImportBatch({ fileName: `${bank}.html`, pageKind: bank === 'list' ? 'items-list' : 'buy', fileMtime: at, importedAt: at, itemCount: rows.length, bank });
  repo.insertBankStock(id, bank, rows);
  return id;
}

function entry(revenueScrap: number, settings: Settings, confidence: number): MarketEval {
  const o = {
    listingId: `l-${revenueScrap}`,
    steamid: '76561198000000002',
    userName: 'KeyBot',
    keys: 0,
    metalScrap: revenueScrap,
    valueScrap: revenueScrap,
    isBot: true,
    online: true,
    lastEventAt: NOW - MIN,
    bumpedAt: null,
    details: '',
    flags: [],
    eligible: true,
  };
  return {
    bestScrap: revenueScrap,
    consScrap: revenueScrap,
    instantScrap: revenueScrap,
    revenueScrap,
    revenueOrder: o,
    bestOrder: o,
    buyerCount: 2,
    eligibleCount: 2,
    maxCostScrap: maxCostFor(revenueScrap, settings.profit),
    confidence,
    confidenceLevel: confidence >= 70 ? 'high' : confidence >= 45 ? 'medium' : 'low',
    flags: [],
    lastOrderChangeAt: NOW - MIN,
    referenced: true,
  };
}

interface Harness {
  repo: Repo;
  stock: BankStock;
  entries: Map<string, MarketEval>;
  settings: { current: Settings };
  sent: PushContract['notify'][];
  log: ReturnType<typeof recordingLogger>;
  /** One import's notifications, as core runs them after refreshing the stock. */
  run(bank: ScraptfBank, batchId: number, now?: UnixMs): number;
  restart(): void;
  set(base: string, revenue: number, confidence?: number): void;
}

function setup(patch: DeepPartial<Settings> = {}, repo: Repo = openRepo(':memory:')): Harness {
  repos.push(repo);
  const entries = new Map<string, MarketEval>();
  const settings = { current: mergeSettings(DEFAULT_SETTINGS, patch) };
  const sent: PushContract['notify'][] = [];
  const log = recordingLogger();
  const make = () =>
    createBankStock({
      clock: { now: () => NOW },
      log,
      repo,
      market: { entryFor: (base) => entries.get(base) ?? null },
      keyPrice: () => KEY,
      settings: () => settings.current,
      categoryOf: () => 'hats',
    });
  const h: Harness = {
    repo,
    stock: make(),
    entries,
    settings,
    sent,
    log,
    run(bank, batchId, now = NOW) {
      h.stock.refresh();
      return notifyNewBankFlips({ log, repo, stock: h.stock, settings: () => settings.current, keyPrice: () => KEY, notify: (n) => sent.push(n) }, { bank, batchId }, now);
    },
    restart() {
      h.stock = make();
    },
    set: (base, revenue, confidence = 70) => entries.set(base, entry(revenue, settings.current, confidence)),
  };
  return h;
}

/**
 * Hats saved 2 h ago, then 5 min ago with five new hats (all flips: +190, +150, +110, +70, +30 at the
 * default settings) and one restocked at a cost above its buyers (new, not a flip). Returns the batches.
 */
function seed(h: Harness): { prev: number; newest: number } {
  const prev = save(h.repo, 'hats', NOW - 2 * HOUR, [s('100;6', 50), s('106;6', 40, { stock: 0 })]);
  const newest = save(h.repo, 'hats', NOW - 5 * MIN, [
    s('100;6', 50),
    s('101;6', 10, { name: 'Ghastly Gibus' }),
    s('102;6', 10),
    s('103;6', 10),
    s('104;6', 10),
    s('105;6', 10),
    s('106;6', 40, { stock: 1 }),
  ]);
  h.set('100;6', 400); // unchanged: never notified
  h.set('101;6', 200);
  h.set('102;6', 160);
  h.set('103;6', 120);
  h.set('104;6', 80);
  h.set('105;6', 40);
  h.set('106;6', 30); // new but over
  return { prev, newest };
}

describe('New on scrap.tf notifications (S3)', () => {
  it('notifies the three most profitable new flips, then one summary', () => {
    const h = setup();
    const { newest } = seed(h);
    expect(h.run('hats', newest)).toBe(4);
    expect(h.sent.slice(0, 3).map((n) => [n.title, n.sku])).toEqual([
      ['New on scrap.tf (Hats): Ghastly Gibus', '101;6'],
      ['New on scrap.tf (Hats): Hat 102;6', '102;6'],
      ['New on scrap.tf (Hats): Hat 103;6', '103;6'],
    ]);
    // "<cost>, sells for <revenue> to <buyer>, +<profit>", as the shared text says it.
    expect(h.sent[0]!.body).toBe('1.11 ref, sells for 22.22 ref to KeyBot, +21.11 ref');
    const gibus = h.stock.newFlips('hats', newest)[0]!;
    expect(h.sent[0]).toEqual({ ...bankStockNewFlipNotice('Hats', gibus, KEY.valueScrap), sku: '101;6' });
    expect(h.sent[3]).toMatchObject({ title: '+2 more new flips on scrap.tf/buy/hats', sku: null });
  });

  it('sends no summary for three or fewer', () => {
    const h = setup();
    const { newest } = seed(h);
    h.entries.delete('104;6');
    h.entries.delete('105;6');
    expect(h.run('hats', newest)).toBe(3);
    expect(h.sent.map((n) => n.sku)).toEqual(['101;6', '102;6', '103;6']);
  });

  it('notifies nothing on a first save of a bank, nor for an older page imported late', () => {
    const h = setup();
    const first = save(h.repo, 'stranges', NOW - 5 * MIN, [s('200;11', 10)]);
    h.set('200;11', 300);
    expect(h.run('stranges', first)).toBe(0);
    const { prev } = seed(h);
    // An older hats save is not the bank's newest: its "new" rows are not new on scrap.tf today.
    expect(h.run('hats', prev)).toBe(0);
    expect(h.sent).toEqual([]);
  });

  it.each<[string, DeepPartial<Settings>]>([
    ['notifications are off', { notifications: { enabled: false } }],
    ['the New on scrap.tf switch is off', { notifications: { newOnScraptf: false } }],
    ["saved pages ('import') may not notify", { notifications: { inputKinds: ['user', 'rule'] } }],
  ])('notifies nothing when %s', (_why, patch) => {
    const h = setup(patch);
    const { newest } = seed(h);
    expect(h.run('hats', newest)).toBe(0);
    expect(h.sent).toEqual([]);
    // Nothing recorded either: switching on later and saving again still notifies.
    expect(h.repo.getMeta(BANK_STOCK_NOTIFY_META_KEY)).toBeNull();
  });

  it('respects the minimum confidence and profit of a notification', () => {
    const h = setup({ notifications: { minConfidence: 60, minProfitScrap: 100 } });
    const { newest } = seed(h);
    h.set('102;6', 160, 50); // +150 but its buyers score 50
    expect(h.run('hats', newest)).toBe(2);
    // 101 (+190) passes; 102 is below the confidence; 103 (+110) passes; 104 (+70) and 105 (+30) are below the profit.
    expect(h.sent.map((n) => n.sku)).toEqual(['101;6', '103;6']);
  });

  it('dedupes per bank and SKU for 30 min, across a restart, and expires by age', () => {
    const h = setup();
    const { newest } = seed(h);
    expect(h.run('hats', newest)).toBe(4);
    h.sent.length = 0;
    // The same save imported again (or the folder watch catching up): nothing new to say.
    expect(h.run('hats', newest, NOW + 10 * MIN)).toBe(0);
    // A restart: the dedupe lives in repo meta, not in memory.
    h.restart();
    expect(h.run('hats', newest, NOW + 20 * MIN)).toBe(0);
    const stored = JSON.parse(h.repo.getMeta(BANK_STOCK_NOTIFY_META_KEY)!) as Record<string, number>;
    expect(Object.keys(stored).sort()).toEqual(['hats|101;6', 'hats|102;6', 'hats|103;6', 'hats|104;6', 'hats|105;6']);
    expect(Object.values(stored).every((t) => t === NOW)).toBe(true);
    // The same item new on another bank is another notification (0.7.4: a list row proven to price its copy).
    const listPrev = save(h.repo, 'list', NOW - HOUR, [s('100;6', 50, { craft: 'craftable' })]);
    const listNew = save(h.repo, 'list', NOW - MIN, [s('100;6', 50, { craft: 'craftable' }), s('101;6', 12, { name: 'Ghastly Gibus', craft: 'craftable' })]);
    expect(listPrev).toBeLessThan(listNew);
    expect(h.run('list', listNew, NOW + 20 * MIN)).toBe(1);
    expect(h.sent[0]).toMatchObject({ title: 'New on scrap.tf (All items): Ghastly Gibus', sku: '101;6' });
    // Past the window the hats save notifies again, and the expired entries are dropped from meta.
    h.sent.length = 0;
    expect(h.run('hats', newest, NOW + BANK_STOCK_NOTIFY_DEDUP_MS)).toBe(4);
    const after = JSON.parse(h.repo.getMeta(BANK_STOCK_NOTIFY_META_KEY)!) as Record<string, number>;
    expect(after['hats|101;6']).toBe(NOW + BANK_STOCK_NOTIFY_DEDUP_MS);
    expect(after['list|101;6']).toBe(NOW + 20 * MIN);
  });

  it('counts a painted and a clean copy new on the same save as one notification', () => {
    const h = setup();
    save(h.repo, 'hats', NOW - HOUR, [s('100;6', 50)]);
    const id = save(h.repo, 'hats', NOW - MIN, [s('100;6', 50), s('101;6', 10), s('101;6', 30, { specialKey: bankStockSpecialKey({ paint: 15185211 }) })]);
    h.set('101;6', 200);
    expect(h.stock.newFlips('hats', id).map((r) => [r.sku, r.hasExtras, r.profitScrap])).toEqual([
      ['101;6', false, 190],
      ['101;6', true, 170],
    ]);
    expect(h.run('hats', id)).toBe(1);
    // The most profitable copy is the one told about (the clean one, +190).
    expect(h.sent[0]!.body).toContain('+21.11 ref');
  });

  it('starts afresh from an unreadable history, and never throws when the push fails', () => {
    const h = setup();
    const { newest } = seed(h);
    h.repo.setMeta(BANK_STOCK_NOTIFY_META_KEY, '{not json');
    expect(h.run('hats', newest)).toBe(4);
    expect(h.log.lines.some((l) => l.level === 'warn' && /notification history/.test(l.msg))).toBe(true);
    h.repo.setMeta(BANK_STOCK_NOTIFY_META_KEY, '');
    const failing = notifyNewBankFlips(
      {
        log: h.log,
        repo: h.repo,
        stock: h.stock,
        settings: () => h.settings.current,
        keyPrice: () => KEY,
        notify: () => {
          throw new Error('main is gone');
        },
      },
      { bank: 'hats', batchId: newest },
      NOW,
    );
    expect(failing).toBe(0);
  });
});

describe('held until the Live market has built (createNewFlipNotifier, core’s S3)', () => {
  function notifier(h: Harness, built: { v: boolean | 'throws' }) {
    return createNewFlipNotifier({
      log: h.log,
      repo: h.repo,
      clock: { now: () => NOW },
      stock: h.stock,
      settings: () => h.settings.current,
      keyPrice: () => KEY,
      notify: (n) => h.sent.push(n),
      marketBuilt: () => {
        if (built.v === 'throws') throw new Error('stats failed');
        return built.v;
      },
    });
  }

  it('notifies at once once the market has built', () => {
    const h = setup();
    const { newest } = seed(h);
    h.stock.refresh();
    notifier(h, { v: true }).imported({ bank: 'hats', batchId: newest });
    expect(h.sent).toHaveLength(4);
  });

  it('holds an import made before the first build (the catch-up at start) and tells it after, once', () => {
    const h = setup();
    const { newest } = seed(h);
    h.stock.refresh();
    const built = { v: false as boolean | 'throws' };
    const n = notifier(h, built);
    n.imported({ bank: 'hats', batchId: newest });
    n.flush();
    expect(h.sent).toEqual([]);
    expect(n.held()).toBe(1);
    built.v = true;
    n.flush();
    expect(h.sent.map((x) => x.sku)).toEqual(['101;6', '102;6', '103;6', null]);
    expect(n.held()).toBe(0);
    n.flush();
    expect(h.sent).toHaveLength(4);
  });

  it('holds every import of a bank, and a save no longer the newest tells nothing', () => {
    const h = setup();
    const { prev, newest } = seed(h);
    h.stock.refresh();
    const built = { v: false as boolean | 'throws' };
    const n = notifier(h, built);
    n.imported({ bank: 'hats', batchId: prev });
    n.imported({ bank: 'hats', batchId: newest });
    n.imported({ bank: 'hats', batchId: newest });
    expect(n.held()).toBe(2);
    // A third save lands before the build: the held one is no longer the bank's newest.
    const third = save(h.repo, 'hats', NOW - MIN, [s('100;6', 50)]);
    h.stock.refresh();
    built.v = true;
    n.flush();
    expect(h.sent).toEqual([]);
    expect(third).toBeGreaterThan(newest);
  });

  // F17-C2: the hold kept the batch imported last, not the bank's newest save, so the newest save's new
  // flips were dropped when another page of the bank (or the same file) came in after it.
  it('still tells the newest save once when an older page of the bank is imported after it while held', () => {
    const h = setup();
    const { newest } = seed(h);
    h.stock.refresh();
    const built = { v: false as boolean | 'throws' };
    const n = notifier(h, built);
    n.imported({ bank: 'hats', batchId: newest });
    // An older hats page, picked on the Import page before the first build: a higher batch id, an older save.
    const older = save(h.repo, 'hats', NOW - 3 * HOUR, [s('100;6', 50)]);
    expect(older).toBeGreaterThan(newest);
    h.stock.refresh();
    n.imported({ bank: 'hats', batchId: older });
    built.v = true;
    n.flush();
    expect(h.sent.map((x) => x.sku)).toEqual(['101;6', '102;6', '103;6', null]);
    expect(n.held()).toBe(0);
  });

  it('still tells the newest save once when the same file is imported again while held', () => {
    const h = setup();
    const { newest } = seed(h);
    h.stock.refresh();
    const built = { v: false as boolean | 'throws' };
    const n = notifier(h, built);
    n.imported({ bank: 'hats', batchId: newest });
    // The Import page's picker on the file the folder watch took: same save time, a new batch.
    const again = save(h.repo, 'hats', NOW - 5 * MIN, h.repo.bankStockRows(newest));
    h.stock.refresh();
    n.imported({ bank: 'hats', batchId: again });
    built.v = true;
    n.flush();
    expect(h.sent.map((x) => x.sku)).toEqual(['101;6', '102;6', '103;6', null]);
    // The same order without a hold tells the same once, and nothing for the second import.
    const b = setup();
    const seeded = seed(b);
    b.stock.refresh();
    const live = notifier(b, { v: true });
    live.imported({ bank: 'hats', batchId: seeded.newest });
    const twice = save(b.repo, 'hats', NOW - 5 * MIN, b.repo.bankStockRows(seeded.newest));
    b.stock.refresh();
    live.imported({ bank: 'hats', batchId: twice });
    expect(b.sent).toHaveLength(4);
  });

  it('does not hold for ever when the market cannot say', () => {
    const h = setup();
    const { newest } = seed(h);
    h.stock.refresh();
    notifier(h, { v: 'throws' }).imported({ bank: 'hats', batchId: newest });
    expect(h.sent).toHaveLength(4);
  });
});

describe('a suspect margin is never notified (F5, as the engine)', () => {
  it('leaves out a huge margin with few buy orders and no usable reference', () => {
    const h = setup();
    const { newest } = seed(h);
    // 101;6: +190 on a 10 scrap cost (a margin of 19) from 2 orders and no PriceDB or community price.
    h.entries.set('101;6', { ...entry(200, h.settings.current, 70), referenced: false });
    expect(h.stock.newFlips('hats', newest).map((r) => r.sku)).toEqual(['102;6', '103;6', '104;6', '105;6']);
    expect(h.run('hats', newest)).toBe(4);
    expect(h.sent.map((n) => n.sku)).toEqual(['102;6', '103;6', '104;6', null]);
    expect(h.sent[3]!.title).toBe('+1 more new flip on scrap.tf/buy/hats');
    // Still on the stock page as a new flip: shown, just not toasted.
    expect(h.stock.list({ bank: 'hats', filter: 'new' }, NOW).rows.map((r) => r.sku)).toContain('101;6');
  });

  it.each<[string, Partial<MarketEval>, DeepPartial<Settings>]>([
    ['a usable reference checks the price', { referenced: true }, {}],
    ['three orders check each other', { referenced: false, eligibleCount: 3 }, {}],
    ['the guard is off', { referenced: false }, { profit: { suspectMargin: 0 } }],
    ['the margin is under the limit', { referenced: false }, { profit: { suspectMargin: 50 } }],
  ])('notifies it when %s', (_why, over, patch) => {
    const h = setup(patch);
    const { newest } = seed(h);
    h.entries.set('101;6', { ...entry(200, h.settings.current, 70), ...over });
    expect(h.stock.newFlips('hats', newest)[0]!.sku).toBe('101;6');
  });
});

describe('what was told, for the engine (one toast per find)', () => {
  it('remembers every item a notification or the summary named, for 30 minutes', () => {
    const h = setup();
    const { newest } = seed(h);
    h.stock.refresh();
    const told: [string, number][] = [];
    const n = createNewFlipNotifier({
      log: h.log,
      repo: h.repo,
      clock: { now: () => NOW },
      stock: h.stock,
      settings: () => h.settings.current,
      keyPrice: () => KEY,
      notify: (x) => h.sent.push(x),
      marketBuilt: () => true,
      told: (base, at) => told.push([base, at]),
    });
    expect(n.toldRecently('101;6', NOW)).toBe(false);
    n.imported({ bank: 'hats', batchId: newest });
    // Three toasts and a summary of the other two: all five were told of.
    expect(h.sent).toHaveLength(4);
    expect(told).toEqual(['101;6', '102;6', '103;6', '104;6', '105;6'].map((s) => [s, NOW]));
    for (const sku of ['101;6', '105;6']) expect(n.toldRecently(sku, NOW + 29 * MIN)).toBe(true);
    // Unchanged (100;6) and new but over (106;6): never told.
    expect(n.toldRecently('100;6', NOW)).toBe(false);
    expect(n.toldRecently('106;6', NOW)).toBe(false);
    expect(n.toldRecently('101;6', NOW + BANK_STOCK_NOTIFY_DEDUP_MS)).toBe(false);
    expect(n.toldRecently('101;6', NOW - MIN)).toBe(false);
  });

  // F17-C3: the other way round. At start-up the engine toasts a held import's item first; the bank
  // notification then only records it, so one find makes one toast.
  it('records but does not toast an item the engine already toasted, and toasts the rest', () => {
    const h = setup();
    const { newest } = seed(h);
    h.stock.refresh();
    const built = { v: false };
    const n = createNewFlipNotifier({ log: h.log, repo: h.repo, clock: { now: () => NOW }, stock: h.stock, settings: () => h.settings.current, keyPrice: () => KEY, notify: (x) => h.sent.push(x), marketBuilt: () => built.v });
    n.imported({ bank: 'hats', batchId: newest });
    // The engine's "Profit:" toasts for 101 and 104, about a second after the import.
    n.toastedElsewhere('101;6', NOW - 1_000);
    n.toastedElsewhere('104;6', NOW - 1_000);
    built.v = true;
    n.flush();
    // 102, 103, 105: three toasts, no summary; 101 and 104 recorded in the dedupe all the same.
    expect(h.sent.map((x) => x.sku)).toEqual(['102;6', '103;6', '105;6']);
    const stored = JSON.parse(h.repo.getMeta(BANK_STOCK_NOTIFY_META_KEY)!) as Record<string, number>;
    expect(Object.keys(stored).sort()).toEqual(['hats|101;6', 'hats|102;6', 'hats|103;6', 'hats|104;6', 'hats|105;6']);
    // Only what this notifier toasted counts as told for the engine.
    expect(n.toldRecently('101;6', NOW)).toBe(false);
    expect(n.toldRecently('102;6', NOW)).toBe(true);
  });

  it('toasts an item the engine told of more than 30 minutes ago, and every item when nothing else told', () => {
    const h = setup();
    const { newest } = seed(h);
    h.stock.refresh();
    const n = createNewFlipNotifier({ log: h.log, repo: h.repo, clock: { now: () => NOW }, stock: h.stock, settings: () => h.settings.current, keyPrice: () => KEY, notify: (x) => h.sent.push(x), marketBuilt: () => true });
    n.toastedElsewhere('101;6', NOW - BANK_STOCK_NOTIFY_DEDUP_MS);
    n.imported({ bank: 'hats', batchId: newest });
    expect(h.sent.map((x) => x.sku)).toEqual(['101;6', '102;6', '103;6', null]);
  });

  it('toasts as before when the check fails (a second toast beats a lost one)', () => {
    const h = setup();
    const { newest } = seed(h);
    h.stock.refresh();
    const sent = notifyNewBankFlips(
      {
        log: h.log,
        repo: h.repo,
        stock: h.stock,
        settings: () => h.settings.current,
        keyPrice: () => KEY,
        notify: (x) => h.sent.push(x),
        toldBefore: () => {
          throw new Error('gone');
        },
      },
      { bank: 'hats', batchId: newest },
      NOW,
    );
    expect(sent).toBe(4);
    expect(h.log.lines.some((l) => l.level === 'warn' && /notification check failed/.test(l.msg))).toBe(true);
  });

  it('tells nothing when the notifications are off, so the engine still toasts', () => {
    const h = setup({ notifications: { newOnScraptf: false } });
    const { newest } = seed(h);
    h.stock.refresh();
    const n = createNewFlipNotifier({ log: h.log, repo: h.repo, clock: { now: () => NOW }, stock: h.stock, settings: () => h.settings.current, keyPrice: () => KEY, notify: (x) => h.sent.push(x), marketBuilt: () => true });
    n.imported({ bank: 'hats', batchId: newest });
    expect(h.sent).toEqual([]);
    expect(n.toldRecently('101;6', NOW)).toBe(false);
  });
});

describe('inputKinds as the engine reads it', () => {
  it('treats a missing list as every kind (the default), like notifyKinds', () => {
    const h = setup();
    const { newest } = seed(h);
    const broken = { ...h.settings.current, notifications: { ...h.settings.current.notifications, inputKinds: undefined as unknown as Settings['notifications']['inputKinds'] } };
    h.settings.current = broken;
    expect(h.run('hats', newest)).toBe(4);
  });
});
