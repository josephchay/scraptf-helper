// scrap.tf banks (F15): one summary per scrap.tf page the user saves (the seven
// bank pages and the /items price list), for 'scraptf.banks' and the banks page.
// Built in memory from what is already local: the import batches (ImportBatch.bank),
// the prices (ScrapPrice.bank), the stored opportunities, the Live market index and
// the saved list. It adds no network traffic and never contacts scrap.tf (R1);
// pages arrive only through the user's own saves (R10).
//
// Four parts, each cached until what it reads changes (invalidate's scope):
// - saves (batches + prices: each bank's newest save, its pages, the price -> bank map), 'all';
// - flips (the profitable opportunities on imported prices, through that map), 'all' and 'flips';
// - lookFor (the Live market's "Not checked" rows per bank), 'all' and 'market';
// - the /items list card (F14's cache), keyed on the cache's own version; while the list holds no
//   rows, the list's batches from the saves part.
// Everything is read once per rebuild, never per row, and only when summary() asks. F17's "What's
// new" per card comes from the bank stock cache (in memory) on every summary(), not from a part, and
// from 0.7.1 (UX-2b) so do a bank page's flips (its stock page's Flips chip); only the All items card,
// and a bank with no stock save, count the profitable opportunities on its prices.

import { BANK_STOCK_MAX_LIMIT } from '../../shared/bankStock';
import { BANK_LOOK_FOR, NO_BANK_FLIPS, bankFlips, bankLookFor, bankStockFlips, type BankFlips, type BankLookFor } from '../../shared/banks';
import { SCRAPTF_BANKS, isScraptfBank, type ScraptfBankInfo } from '../../shared/links';
import { batchItemCounts, mergeBankNewestSaves, scraptfBankSaves, wholeLookNewestSaves } from '../../shared/market';
import type {
  Category,
  Opportunity,
  ScrapPrice,
  ScraptfBank,
  ScraptfBankSummary,
  ScraptfBankWhatsNew,
  ScraptfBanksResult,
  Settings,
  UnixMs,
} from '../../shared/types';
import type { Clock, Logger, Repo } from '../contracts';
import { realTimers, type TimerApi } from '../net/ratelimit';
import type { BankStock } from './bankStock';
import { COVERAGE_BATCHES, type MarketIndex } from './market';
import type { ScraptfListCache } from './scraptfList';

/** 'scraptf.banksChanged' is pushed at most this often (spec S4). */
export const BANKS_PUSH_MS = 2_000;

/**
 * What changed. 'all': an import, a price, rule or list write (drops every cached part). 'flips': the
 * stored opportunities (the engine). 'market': a Live market change (lookFor and unchecked only).
 * 'switches': importEnabled or watchActive, which summary() reads live (nothing cached to drop).
 * Every scope tells the listeners, throttled.
 */
export type BanksInvalidation = 'all' | 'flips' | 'market' | 'switches';

export interface BanksSummaryDeps {
  clock: Clock;
  log: Logger;
  /**
   * Read once per rebuild, never per row: the newest batches (with their bank), the prices (bank joined)
   * and the profitable opportunities on imported prices (filtered in SQL: the rest can never be a flip).
   * 0.7.1 (DM-7, CQ-3): bankNewestSaves dates each bank over every batch, as the coverage strip does
   * (optional so older stand-ins still work: then only the newest COVERAGE_BATCHES date a bank).
   * DC-2: bankStockSaves(bank, 1) is each bank page's newest whole look, which dates and counts its card
   * (wholeLookNewestSaves; optional the same way).
   */
  repo: Pick<Repo, 'listImportBatches' | 'listScrapPrices' | 'queryOpportunities'> & Partial<Pick<Repo, 'bankNewestSaves' | 'bankStockSaves'>>;
  /** The Live market index, in memory: lookFor and unchecked come from its "Not checked" rows. */
  market: Pick<MarketIndex, 'uncheckedBy'>;
  /** F14's saved /items list, for the 'list' card (the same data as 'scraptf.listStatus'). */
  scraptfList: Pick<ScraptfListCache, 'summary' | 'all' | 'version'>;
  settings(): Settings;
  /** The folder watch as it runs (core's ctx.folderWatch). */
  folderWatch(): { active: boolean; error: string | null };
  /**
   * A SKU's category as the Live market files it (marketCategoryOf). Only for a batch from before 0.3
   * that recorded neither a bank nor its categories; without it such a batch counts for no bank.
   */
  categoryOf?(sku: string): Category;
  /**
   * F17: each bank's "What's new" (BankStock.whatsNew: the change counts since its session baseline,
   * verdicts from the live book). Read on every summary(), outside the cached parts, so it follows the
   * market without its own invalidation. Omitted: whatsNew is null on every card. 0.7.1 (UX-2b): list,
   * when given, gives each bank page's card its flips: the stock page's Flips chip and its most profitable
   * rows, so the card and the page agree; a bank with no stock save keeps the opportunity count.
   */
  bankStock?: Pick<BankStock, 'whatsNew'> & Partial<Pick<BankStock, 'list'>>;
  /** Injected in tests; defaults to unref'd real timers. */
  timers?: TimerApi;
}

export interface BanksSummary {
  /** One ScraptfBankSummary per SCRAPTF_BANKS entry, in that order. Cached until invalidate(). Never throws. */
  summary(now: UnixMs): ScraptfBanksResult;
  /** Something the summary reads changed; listeners hear of it at most once per BANKS_PUSH_MS. */
  invalidate(what?: BanksInvalidation): void;
  /** Called (throttled) after invalidate(); core pushes 'scraptf.banksChanged'. Returns an unsubscribe function. */
  onChanged(cb: () => void): () => void;
  /** Drops a pending notification (service stop). */
  stop(): void;
}

/** A never-saved bank. */
export function emptyBankSummary(bank: ScraptfBankInfo): ScraptfBankSummary {
  return {
    bank: bank.bank,
    label: bank.label,
    url: bank.url,
    lastSavedAt: null,
    pages: 0,
    items: 0,
    inStock: 0,
    flips: 0,
    flipProfitScrap: 0,
    top: [],
    unchecked: 0,
    lookFor: [],
    // F17: BankStock.whatsNew(bank), read live in summary(); null for a bank with fewer than 2 saves.
    whatsNew: null,
  };
}

/** The saved state of one bank's card. */
type SavedState = Pick<ScraptfBankSummary, 'lastSavedAt' | 'pages' | 'items' | 'inStock'>;

const NEVER_SAVED: Readonly<SavedState> = Object.freeze({ lastSavedAt: null, pages: 0, items: 0, inStock: 0 });
const NOTHING_TO_LOOK_FOR: Readonly<BankLookFor> = Object.freeze({ unchecked: 0, lookFor: [] });

/** 0.7.4 (F36): uncheckedBy's grouping for the cards: the bank page the row's scrap.tf button opens. */
export const lookForBank = (_category: Category, bank: Exclude<ScraptfBank, 'list'>): Exclude<ScraptfBank, 'list'> => bank;

interface Saves {
  /** Imported price id -> the bank of its page. */
  priceBank: Map<number, ScraptfBank>;
  /** Per bank, from its batches and prices. 'list' only stands in while the saved list holds no rows (listCard). */
  perBank: Map<ScraptfBank, SavedState>;
}

const PRICE_REF = /^price:(\d+)$/;

/**
 * The bank of the imported price an opportunity is built on ('price:<id>'), or null (a typed price,
 * a rule, a price gone since, or a page counting for no bank).
 */
export function opportunityBank(o: Pick<Opportunity, 'inputKind' | 'inputRef'>, priceBank: ReadonlyMap<number, ScraptfBank>): ScraptfBank | null {
  if (o.inputKind !== 'import' || typeof o.inputRef !== 'string') return null;
  const m = PRICE_REF.exec(o.inputRef);
  return m ? (priceBank.get(Number(m[1])) ?? null) : null;
}

/** A part read once and kept until invalidated; a failed read is logged once per failure streak and not kept. */
interface Part<T> {
  value: T | null;
  /** The last good value: shown while a read fails (better than "never saved" everywhere). */
  last: T | null;
  failing: boolean;
}

function part<T>(): Part<T> {
  return { value: null, last: null, failing: false };
}

export function createBanksSummary(deps: BanksSummaryDeps): BanksSummary {
  const { clock, log, repo } = deps;
  const timers = deps.timers ?? realTimers;
  const listeners = new Set<() => void>();
  let timer: unknown = null;
  let lastNotifiedAt: UnixMs | null = null;
  let stopped = false;

  const saves = part<Saves>();
  const flips = part<Map<ScraptfBank, BankFlips>>();
  const looks = part<Map<ScraptfBank, BankLookFor>>();
  // Keyed on the list cache's version, which grows on every list or key price change.
  const list = part<SavedState>();
  let listVersion: number | null = null;

  function read<T>(p: Part<T>, what: string, fallback: T, fn: () => T): T {
    if (p.value !== null) return p.value;
    try {
      const v = fn();
      p.value = v;
      p.last = v;
      p.failing = false;
      return v;
    } catch (err) {
      if (!p.failing) log.warn(`scrap.tf banks could not read ${what}`, { error: String(err) });
      p.failing = true;
      return p.last ?? fallback;
    }
  }

  function readSaves(): Saves {
    const batches = repo.listImportBatches(COVERAGE_BATCHES);
    const prices = repo.listScrapPrices();
    // Only a batch from before 0.3 with no bank asks for the categories of the rows carrying its id.
    let rowsOf: Map<number, string[]> | null = null;
    const categoriesOf = (id: number): Category[] => {
      const categoryOf = deps.categoryOf;
      if (!categoryOf) return [];
      if (rowsOf === null) {
        rowsOf = new Map();
        for (const p of prices) {
          if (p.source !== 'import' || typeof p.importBatch !== 'number') continue;
          const skus = rowsOf.get(p.importBatch);
          if (skus) skus.push(p.sku);
          else rowsOf.set(p.importBatch, [p.sku]);
        }
      }
      const out: Category[] = [];
      for (const sku of rowsOf.get(id) ?? []) {
        try {
          out.push(categoryOf(sku));
        } catch {
          // an unreadable SKU counts for no bank
        }
      }
      return out;
    };
    const saves = scraptfBankSaves(batches, categoriesOf);
    const bankOf = saves.bankOf;
    // DM-7: dated over every batch, not only the newest 500 (the coverage strip reads the same query).
    const extra = typeof repo.bankNewestSaves === 'function' ? repo.bankNewestSaves() : null;
    // DC-2: and a bank page by its newest whole look, as its stock page: never a partial or unsettled one.
    const stockSaves = typeof repo.bankStockSaves === 'function' ? repo.bankStockSaves.bind(repo) : null;
    const wholeLookOf = stockSaves ? (bank: ScraptfBank) => stockSaves(bank, 1)[0] : null;
    const newest = wholeLookNewestSaves(mergeBankNewestSaves(saves.newest, extra), wholeLookOf, batchItemCounts(batches, extra));

    // Per bank: the saved pages behind its rows today (ScraptfBankSummary.pages: its current data, as
    // F14 counts the list's pages; not every save, which a page re-saved all day would inflate) and its
    // newest row; per page, the rows it holds today and how many of them are known sold out.
    const known = new Map<ScraptfBank, { pages: Set<number>; newestRow: ScrapPrice | null }>();
    const knownOf = (bank: ScraptfBank) => {
      let k = known.get(bank);
      if (!k) known.set(bank, (k = { pages: new Set(), newestRow: null }));
      return k;
    };
    const held = new Map<number, { rows: number; soldOut: number }>();
    const priceBank = new Map<number, ScraptfBank>();
    for (const p of prices) {
      if (p.source !== 'import') continue;
      // The batch's bank (recorded, else the majority rule); a batch older than the batches read still
      // names its recorded bank through the repo's join.
      const batchBank = typeof p.importBatch === 'number' ? bankOf.get(p.importBatch) : undefined;
      const bank = batchBank ?? (isScraptfBank(p.bank) ? p.bank : null);
      if (bank === null) continue;
      priceBank.set(p.id, bank);
      const k = knownOf(bank);
      if (typeof p.importBatch === 'number') {
        k.pages.add(p.importBatch);
        let h = held.get(p.importBatch);
        if (!h) held.set(p.importBatch, (h = { rows: 0, soldOut: 0 }));
        h.rows++;
        if (typeof p.stock === 'number' && p.stock <= 0) h.soldOut++;
      }
      const n = k.newestRow;
      if (Number.isFinite(p.observedAt) && (n === null || p.observedAt > n.observedAt || (p.observedAt === n.observedAt && p.id > n.id))) k.newestRow = p;
    }

    const perBank = new Map<ScraptfBank, SavedState>();
    for (const info of SCRAPTF_BANKS) {
      const save = newest.get(info.bank);
      const k = known.get(info.bank);
      if (!save && !k) continue;
      const pages = k?.pages.size ?? 0;
      if (save) {
        // The newest save is one of them even when it stored nothing: the list's, or a whole look whose
        // cards were all sold out (a page saved without its cards stores no stock save and is never `newest`, F18 S3).
        const withNewest = pages + (k?.pages.has(save.id) ? 0 : 1);
        // The newest save, as the coverage strip counts it (its itemCount, fixed at import: later saves
        // re-tag the rows it shares). Rows left from older saves are not on it: sold since, or moved.
        // An import stores only cards on sale (none in stock is skipped), so only a row of this page
        // known to show 0 is not in stock.
        const soldOut = held.get(save.id)?.soldOut ?? 0;
        perBank.set(info.bank, { lastSavedAt: save.at, pages: withNewest, items: save.items, inStock: Math.max(0, save.items - soldOut) });
        continue;
      }
      // Saved only before the batches read, or since then only without its cards (F18 S3): dated and
      // counted by the rows its newest page still holds, the prices still in use.
      const row = k?.newestRow ?? null;
      const h = row && typeof row.importBatch === 'number' ? held.get(row.importBatch) : undefined;
      perBank.set(info.bank, { lastSavedAt: row?.observedAt ?? null, pages, items: h?.rows ?? 0, inStock: h ? h.rows - h.soldOut : 0 });
    }
    return { priceBank, perBank };
  }

  function readFlips(s: Saves): Map<ScraptfBank, BankFlips> {
    // Filtered in SQL, so only rows that can be a flip are parsed; bankFlips applies the same test.
    const rows = repo.queryOpportunities({ status: ['profitable'], inputKinds: ['import'] });
    return bankFlips(rows, (o) => opportunityBank(o, s.priceBank));
  }

  function readLookFor(now: UnixMs): Map<ScraptfBank, BankLookFor> {
    // 0.7.4 (F36): grouped by the page each row's scrap.tf button opens, not by category alone.
    const groups = deps.market.uncheckedBy(lookForBank, BANK_LOOK_FOR, now);
    const out = new Map<ScraptfBank, BankLookFor>();
    for (const info of SCRAPTF_BANKS) {
      // The /items list sells everything and is no bank of a category: nothing to look for there.
      if (info.bank === 'list' || info.categories.length === 0) continue;
      const g = groups.get(info.bank);
      if (!g) continue;
      // bankLookFor cuts and orders the few rows the index returned; the count is the group's own.
      out.set(info.bank, { unchecked: g.count, lookFor: bankLookFor(g.rows, info.categories, info.bank).lookFor });
    }
    return out;
  }

  /**
   * The list card's saved state: F14's saved list, like 'scraptf.listStatus'. While the list holds no rows
   * (purged after 30 days, or /items pages imported by 0.3, before the list existed) the prices those pages
   * wrote can still be flips, so the card reads the list's own batches instead: never "Never saved" above
   * "Flips from your price list".
   */
  function listCard(listed: SavedState, s: Saves): SavedState {
    return listed.items > 0 ? listed : (s.perBank.get('list') ?? listed);
  }

  function readList(): SavedState {
    const s = deps.scraptfList.summary();
    // The same figures as 'scraptf.listStatus' (F14); in stock: rows showing stock above 0.
    const inStock = s.items > 0 ? deps.scraptfList.all().filter((r) => typeof r.stock === 'number' && r.stock > 0).length : 0;
    return { lastSavedAt: s.newestAt, pages: s.batches, items: s.items, inStock };
  }

  function listState(): SavedState {
    let ver: number | null = null;
    try {
      ver = deps.scraptfList.version();
    } catch {
      ver = null;
    }
    if (ver === null || ver !== listVersion) list.value = null;
    const v = read(list, 'the saved price list', NEVER_SAVED, readList);
    listVersion = list.value !== null ? ver : null;
    return v;
  }

  function switches(): Pick<ScraptfBanksResult, 'importEnabled' | 'watchActive'> {
    // Read live: the watch dies or comes back (core's retry) without any other change.
    let importEnabled = false;
    try {
      const s = deps.settings();
      importEnabled = s.import.enabled && s.import.acknowledgedAt !== null;
    } catch {
      importEnabled = false;
    }
    let watchActive = false;
    if (importEnabled) {
      try {
        watchActive = deps.folderWatch().active === true;
      } catch {
        watchActive = false;
      }
    }
    return { importEnabled, watchActive };
  }

  /** F17: a bank's "What's new", copied; a failed read is logged once per failure streak and shows none. */
  let whatsNewFailing = false;
  function whatsNewOf(bank: ScraptfBank): ScraptfBankWhatsNew | null {
    const stock = deps.bankStock;
    if (!stock) return null;
    try {
      const w = stock.whatsNew(bank);
      whatsNewFailing = false;
      return w ? { ...w } : null;
    } catch (err) {
      if (!whatsNewFailing) log.warn("scrap.tf banks could not read what's new", { error: String(err) });
      whatsNewFailing = true;
      return null;
    }
  }

  /**
   * UX-2b: a bank page's card flips as its stock page counts them (the Flips chip: on sale on the shown
   * saves, verdict flip; most profit first). Null: no stock save of the bank (a page saved before 0.6, or
   * pruned), a list-less stand-in, or a failed read: the opportunity count stands then. Live, like whatsNew.
   */
  let stockFlipsFailing = false;
  function stockFlipsOf(bank: ScraptfBank, now: UnixMs): BankFlips | null {
    const list = deps.bankStock?.list;
    if (!list || bank === 'list') return null;
    try {
      const r = list({ bank, filter: 'flips', sort: 'profit', dir: 'desc', limit: BANK_STOCK_MAX_LIMIT }, now);
      stockFlipsFailing = false;
      return r.savedAt === null ? null : bankStockFlips(r.rows, r.counts.flips);
    } catch (err) {
      if (!stockFlipsFailing) log.warn('scrap.tf banks could not read the stock page flips', { error: String(err) });
      stockFlipsFailing = true;
      return null;
    }
  }

  function notify(): void {
    timer = null;
    if (stopped) return;
    lastNotifiedAt = clock.now();
    for (const cb of listeners) {
      try {
        cb();
      } catch (err) {
        log.warn('scrap.tf banks listener failed', { error: String(err) });
      }
    }
  }

  return {
    summary(now) {
      const s = read<Saves>(saves, 'the saved pages', { priceBank: new Map(), perBank: new Map() }, readSaves);
      // Flips map through the saves' price -> bank map: while that read fails they are not rebuilt
      // (an empty map would be kept as "no flips"); the last good ones show.
      const noFlips = new Map<ScraptfBank, BankFlips>();
      const f = saves.value !== null ? read(flips, 'the opportunities', noFlips, () => readFlips(s)) : (flips.value ?? flips.last ?? noFlips);
      const l = read(looks, 'the Live market', new Map<ScraptfBank, BankLookFor>(), () => readLookFor(now));
      const listed = listState();
      const banks = SCRAPTF_BANKS.map((info): ScraptfBankSummary => {
        const saved = info.bank === 'list' ? listCard(listed, s) : (s.perBank.get(info.bank) ?? NEVER_SAVED);
        // UX-2b: a bank page counts what its stock page shows; only the All items card keeps the price rule.
        const flip = stockFlipsOf(info.bank, now) ?? f.get(info.bank) ?? NO_BANK_FLIPS;
        const look = l.get(info.bank) ?? NOTHING_TO_LOOK_FOR;
        // Copies: the cached parts serve every later call until invalidated.
        return {
          ...emptyBankSummary(info),
          ...saved,
          flips: flip.flips,
          flipProfitScrap: flip.flipProfitScrap,
          top: flip.top.map((t) => ({ ...t })),
          unchecked: look.unchecked,
          lookFor: look.lookFor.map((x) => ({ ...x })),
          // Live, not cached: new flips follow the market, which only invalidates 'market'.
          whatsNew: whatsNewOf(info.bank),
        };
      });
      return { banks, ...switches(), generatedAt: now };
    },

    invalidate(what = 'all') {
      // Dropped at once, so a read before the push is already fresh.
      if (what === 'all') {
        saves.value = null;
        list.value = null;
      }
      // Flips map opportunities through the price -> bank map, so a price change drops them too.
      if (what === 'all' || what === 'flips') flips.value = null;
      // Price writes move the market's verdicts (a price of yours makes a row checked) without a market push.
      if (what === 'all' || what === 'market') looks.value = null;
      // Trailing throttle: every change inside the window is told once, at its end.
      if (stopped || timer !== null) return;
      const wait = lastNotifiedAt === null ? 0 : Math.max(0, lastNotifiedAt + BANKS_PUSH_MS - clock.now());
      timer = timers.setTimeout(notify, wait);
    },

    onChanged(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    stop() {
      stopped = true;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}
