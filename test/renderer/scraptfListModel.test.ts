// F14 scrap.tf price list in the dashboard: the pure helpers behind the shared
// "scrap.tf price list" card (status line and its freshness tone, the setup states,
// when the steps show), the Live market's "scrap.tf pays" and Stock cells, and the
// strip's "All items" chip. No network: the list is only what the user saved.

import { describe, expect, it } from 'vitest';
import { COVERAGE_TIP, coverageChip } from '../../src/renderer/marketModel';
import {
  ALL_ITEMS_TIP,
  LIST_BOUNDARY_NOTE,
  LIST_PICKUP_TEXT,
  LIST_POLL_MS,
  LIST_STARTING_POLL_MS,
  allItemsChip,
  chooseWatchFolder,
  importListRowsText,
  importToastText,
  listPaysCell,
  listPollMs,
  listSetupNote,
  listSetupState,
  listStatusLine,
  listStepsAutoOpen,
  listStepsDisabled,
  listStepsOpen,
  listStockCell,
  sanitizeStepsPref,
  stockText,
} from '../../src/renderer/scraptfListModel';
import { SCRAPTF_ITEMS_URL } from '../../src/shared/links';
import { SCRAPTF_LIST_FRESH_MS, scraptfListCoverage } from '../../src/shared/scraptfList';
import type { DeepPartial, MarketRow, ScraptfListStatus, Settings } from '../../src/shared/types';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const KEY = 568;

function status(over: Partial<ScraptfListStatus> = {}): ScraptfListStatus {
  return {
    items: 2341,
    newestAt: NOW - 3 * MIN,
    oldestAt: NOW - 3 * MIN,
    pages: 1,
    importEnabled: true,
    watchFolder: 'C:\\Users\\you\\Documents\\scrap.tf pages',
    watchActive: true,
    watchError: null,
    ...over,
  };
}

type ListRow = Pick<MarketRow, 'scraptfPaysScrap' | 'scraptfStock' | 'scraptfStockLimit' | 'scraptfFull' | 'scraptfListAt' | 'revenueScrap'>;

function row(over: Partial<ListRow> = {}): ListRow {
  return { scraptfPaysScrap: 50, scraptfStock: 3, scraptfStockLimit: 10, scraptfFull: false, scraptfListAt: NOW - 3 * MIN, revenueScrap: 80, ...over };
}

describe('copy', () => {
  it('states the boundary and what one save updates', () => {
    expect(LIST_BOUNDARY_NOTE).toBe('Flip Desk never loads scrap.tf on its own. Your browser does, and you choose when.');
    expect(LIST_PICKUP_TEXT).toBe('Flip Desk picks it up within seconds and updates prices, the Live market, Holdings and the key price.');
    // The card's own re-read is local IPC, and rare.
    expect(LIST_POLL_MS).toBeGreaterThanOrEqual(30_000);
  });
});

describe('status line', () => {
  it('reads "All scrap.tf items: 2,341 from your saved price list, saved 3 min ago"', () => {
    const l = listStatusLine(status(), NOW);
    expect(l.text).toBe('All scrap.tf items: 2,341 from your saved price list, saved 3 min ago');
    expect(l.tone).toBe('good');
    expect(l.detail).toBeNull();
    expect(l.title).toContain('2,341 items of scrap.tf/items.');
    expect(l.title).toContain('save the page again');
  });

  it('tones by the newest save: good up to 15 min, warn up to 2 h, muted after', () => {
    expect(listStatusLine(status({ newestAt: NOW - 15 * MIN }), NOW).tone).toBe('good');
    expect(listStatusLine(status({ newestAt: NOW - 15 * MIN - 1 }), NOW).tone).toBe('warn');
    expect(listStatusLine(status({ newestAt: NOW - 2 * HOUR }), NOW).tone).toBe('warn');
    expect(listStatusLine(status({ newestAt: NOW - 2 * HOUR - 1 }), NOW).tone).toBe('muted');
    expect(listStatusLine(status({ newestAt: NOW - 3 * 86_400_000 }), NOW)).toMatchObject({ tone: 'muted', text: 'All scrap.tf items: 2,341 from your saved price list, saved 3 d ago' });
  });

  it('says "Not saved yet" without a list, and waits for the first answer', () => {
    expect(listStatusLine(status({ items: 0, newestAt: null, oldestAt: null, pages: 0 }), NOW)).toMatchObject({ text: 'All scrap.tf items: Not saved yet', tone: 'muted', detail: null });
    // A count without a date (should not happen) is not shown as saved.
    expect(listStatusLine(status({ newestAt: null }), NOW).text).toBe('All scrap.tf items: Not saved yet');
    expect(listStatusLine(null, NOW)).toMatchObject({ text: 'All scrap.tf items: …', tone: 'muted' });
    expect(listStatusLine(undefined, NOW).text).toBe('All scrap.tf items: …');
  });

  it('reads a file time ahead of the clock as just now, and one item in the singular', () => {
    expect(listStatusLine(status({ newestAt: NOW + 2 * MIN, oldestAt: NOW + 2 * MIN }), NOW)).toMatchObject({ text: expect.stringMatching(/saved just now$/), tone: 'good' });
    expect(listStatusLine(status({ items: 1 }), NOW).title).toMatch(/^1 item of scrap\.tf\/items\./);
  });

  it('notes several saved pages and the oldest, only when there are several', () => {
    const l = listStatusLine(status({ pages: 3, oldestAt: NOW - 26 * HOUR }), NOW);
    expect(l.detail).toBe('3 saved pages, the oldest 1 d ago');
    expect(l.title).toContain('from 3 saved pages');
    expect(l.title).toContain('oldest');
    expect(listStatusLine(status({ pages: 1, oldestAt: NOW - 26 * HOUR }), NOW).detail).toBeNull();
  });
});

describe('setup states', () => {
  it('names the first thing to fix: import, then the folder, then the watch', () => {
    expect(listSetupState(status({ importEnabled: false, watchFolder: null, watchActive: false }))).toBe('import-off');
    expect(listSetupState(status({ watchFolder: null, watchActive: false }))).toBe('no-folder');
    expect(listSetupState(status({ watchActive: false, watchError: 'Folder not found' }))).toBe('watch-error');
    expect(listSetupState(status({ watchActive: false, watchError: null }))).toBe('watch-starting');
    expect(listSetupState(status())).toBe('ready');
  });

  it('links "Turn on Import first" from the Live market, and points up on the Import page', () => {
    expect(listSetupNote('import-off', 'market')).toMatchObject({ tone: 'warn', action: 'go-import', actionLabel: 'Turn on Import first' });
    const onImport = listSetupNote('import-off', 'import')!;
    expect(onImport.action).toBeNull();
    expect(onImport.text).toMatch(/^Turn on saved-page import above first/);
  });

  it('offers the folder dialog without a folder or after a watch error, and shows the error', () => {
    expect(listSetupNote('no-folder', 'market')).toMatchObject({ tone: 'info', action: 'pick-folder', actionLabel: 'Choose a watch folder' });
    expect(listSetupNote('watch-error', 'import', 'Folder not found')).toMatchObject({ tone: 'bad', text: 'Watch error: Folder not found.', action: 'pick-folder', actionLabel: 'Choose another folder' });
    expect(listSetupNote('watch-error', 'market', 'Watching the folder stopped after an error; trying again every minute.')!.text).toBe(
      'Watch error: Watching the folder stopped after an error; trying again every minute.',
    );
    expect(listSetupNote('watch-error', 'market', '  ')!.text).toBe('Watch error: the folder could not be watched.');
    expect(listSetupNote('watch-starting', 'market')).toMatchObject({ tone: 'muted', action: null });
    expect(listSetupNote('ready', 'market')).toBeNull();
  });

  it('speaks of every scrap.tf page on the banks page header (F15), with the same actions', () => {
    expect(listSetupNote('import-off', 'banks')).toEqual({
      tone: 'warn',
      text: 'Saved-page import is off, so the scrap.tf pages you save are not read.',
      action: 'go-import',
      actionLabel: 'Turn on Import first',
    });
    expect(listSetupNote('no-folder', 'banks')).toMatchObject({ tone: 'info', text: 'No watch folder yet. Choose one, then save the scrap.tf pages into it.', action: 'pick-folder' });
    expect(listSetupNote('no-folder', 'market')!.text).toBe('No watch folder yet. Choose one, then save scrap.tf/items into it.');
    expect(listSetupNote('watch-error', 'banks', 'Folder not found')).toEqual(listSetupNote('watch-error', 'market', 'Folder not found'));
    expect(listSetupNote('watch-starting', 'banks')).toEqual(listSetupNote('watch-starting', 'market'));
    expect(listSetupNote('ready', 'banks')).toBeNull();
  });

  it('re-reads soon while the watch is starting, else rarely (local IPC only)', () => {
    expect(listPollMs(status({ watchActive: false, watchError: null }))).toBe(LIST_STARTING_POLL_MS);
    expect(LIST_STARTING_POLL_MS).toBeLessThan(LIST_POLL_MS);
    expect(LIST_STARTING_POLL_MS).toBeGreaterThanOrEqual(1_000);
    for (const s of [status(), status({ importEnabled: false }), status({ watchFolder: null, watchActive: false }), status({ watchActive: false, watchError: 'Folder not found' })]) {
      expect(listPollMs(s)).toBe(LIST_POLL_MS);
    }
    expect(listPollMs(null)).toBe(LIST_POLL_MS);
  });

  it('disables the steps only while import is off', () => {
    expect(listStepsDisabled(status({ importEnabled: false }))).toBe(true);
    expect(listStepsDisabled(status())).toBe(false);
    expect(listStepsDisabled(null)).toBe(false);
  });
});

describe('steps', () => {
  it('always shows them on the Import page', () => {
    expect(listStepsOpen('import', false, false)).toBe(true);
    expect(listStepsOpen('import', null, null)).toBe(true);
  });

  it('opens them automatically until a list is saved and the watch runs', () => {
    expect(listStepsAutoOpen(status())).toBe(false);
    expect(listStepsAutoOpen(status({ items: 0, newestAt: null }))).toBe(true);
    expect(listStepsAutoOpen(status({ importEnabled: false }))).toBe(true);
    expect(listStepsAutoOpen(status({ watchFolder: null, watchActive: false }))).toBe(true);
    expect(listStepsAutoOpen(status({ watchActive: false, watchError: 'Folder not found' }))).toBe(true);
  });

  it('on the Live market follows the toggle, else the automatic choice', () => {
    expect(listStepsOpen('market', true, false)).toBe(true);
    expect(listStepsOpen('market', false, true)).toBe(false);
    expect(listStepsOpen('market', null, true)).toBe(true);
    expect(listStepsOpen('market', null, false)).toBe(false);
    // Unknown yet: closed, so a working setup does not flash open.
    expect(listStepsOpen('market', null, null)).toBe(false);
  });

  it('restores the persisted toggle defensively', () => {
    expect(sanitizeStepsPref(true)).toBe(true);
    expect(sanitizeStepsPref(false)).toBe(false);
    for (const junk of [null, undefined, 'true', 1, {}]) expect(sanitizeStepsPref(junk)).toBeNull();
  });

  it('saves a chosen watch folder through settings, and nothing when the dialog is cancelled', async () => {
    const saved: DeepPartial<Settings>[] = [];
    const save = async (p: DeepPartial<Settings>) => {
      saved.push(p);
      return { import: { watchFolder: 'D:\\saves' } } as Settings;
    };
    expect(await chooseWatchFolder(async () => ({ folder: 'D:\\saves' }), save)).toBe('D:\\saves');
    expect(saved).toEqual([{ import: { watchFolder: 'D:\\saves' } }]);
    expect(await chooseWatchFolder(async () => ({ folder: null }), save)).toBeNull();
    expect(saved).toHaveLength(1);
  });
});

describe('Live market cells', () => {
  it('shows what scrap.tf pays, from the saved list, with its stock in the tooltip', () => {
    const c = listPaysCell(row(), KEY, NOW);
    expect(c).toMatchObject({ scrap: 50, dim: false, full: false });
    expect(c.title).toMatch(/^scrap\.tf's bank pays 5\.55 ref for it, per your saved scrap\.tf\/items list \(saved 3 min ago\)\./);
    expect(c.title).toContain('Stock 3/10 (scrap.tf buys up to 10).');
    expect(c.title).not.toContain('more than');
  });

  it('says when scrap.tf pays more than the backpack.tf buyer', () => {
    expect(listPaysCell(row({ scraptfPaysScrap: 90, revenueScrap: 80 }), KEY, NOW).title).toContain('more than the backpack.tf buyer');
    expect(listPaysCell(row({ scraptfPaysScrap: 90, revenueScrap: null }), KEY, NOW).title).not.toContain('more than');
  });

  it('dims a full or day-old row: shown, but not what scrap.tf would pay now', () => {
    const full = listPaysCell(row({ scraptfStock: 10, scraptfFull: true }), KEY, NOW);
    expect(full).toMatchObject({ dim: true, full: true });
    expect(full.title).toContain('at its limit, so it will not buy more right now');
    const stale = listPaysCell(row({ scraptfListAt: NOW - SCRAPTF_LIST_FRESH_MS - 1 }), KEY, NOW);
    expect(stale).toMatchObject({ dim: true, full: false });
    expect(stale.title).toContain('over 24 h old');
    expect(listPaysCell(row({ scraptfListAt: NOW - SCRAPTF_LIST_FRESH_MS }), KEY, NOW).dim).toBe(false);
  });

  it('is empty off the list, and says so when the list showed no price we pay', () => {
    const off = listPaysCell(row({ scraptfListAt: null, scraptfPaysScrap: null }), KEY, NOW);
    expect(off).toMatchObject({ scrap: null, dim: false, full: false });
    expect(off.title).toMatch(/^Not on your saved scrap\.tf\/items list/);
    // A saved list that lacks the item is not told to save the list, only that it may not be traded.
    expect(off.title).toContain('scrap.tf may not trade it, or the list is not saved yet');
    const none = listPaysCell(row({ scraptfPaysScrap: null }), KEY, NOW);
    expect(none.scrap).toBeNull();
    expect(none.title).toContain('shows no "Price we pay"');
  });

  it('shows stock as n/limit, Full at the limit, and marks out of stock', () => {
    expect(stockText(3, 10)).toBe('3/10');
    expect(stockText(1200, null)).toBe('1,200');
    expect(stockText(null, 10)).toBeNull();
    expect(listStockCell(row(), NOW)).toMatchObject({ text: '3/10', full: false, out: false, dim: false });
    const full = listStockCell(row({ scraptfStock: 10, scraptfFull: true }), NOW);
    expect(full).toMatchObject({ text: '10/10', full: true, out: false });
    expect(full.title).toContain('You can still buy it there.');
    const out = listStockCell(row({ scraptfStock: 0 }), NOW);
    expect(out).toMatchObject({ text: '0/10', out: true, full: false });
    expect(out.title).toContain('out of stock, so you cannot buy it on scrap.tf right now. scrap.tf still buys it.');
    expect(out.title).toContain('stock changes between saves');
    expect(listStockCell(row({ scraptfListAt: NOW - 2 * SCRAPTF_LIST_FRESH_MS }), NOW).dim).toBe(true);
  });

  it('does not offer a full row as buyable when it is also out of stock (0/0)', () => {
    const none = listStockCell(row({ scraptfStock: 0, scraptfStockLimit: 0, scraptfFull: true }), NOW);
    expect(none).toMatchObject({ text: '0/0', full: true, out: true });
    expect(none.title).toContain('neither buys nor sells it right now');
    expect(none.title).not.toContain('You can still buy it there');
    expect(listPaysCell(row({ scraptfStock: 0, scraptfStockLimit: 0, scraptfFull: true }), KEY, NOW).title).not.toContain('You can still buy it there');
  });

  it('is a dash off the list or without a stock', () => {
    expect(listStockCell(row({ scraptfListAt: null }), NOW)).toMatchObject({ text: '—', full: false, out: false });
    expect(listStockCell(row({ scraptfStock: null, scraptfStockLimit: null }), NOW)).toMatchObject({ text: '—', out: false });
  });
});

describe('"All items" chip', () => {
  it('reads like a bank page chip, stands for scrap.tf/items only, and leads the strip', () => {
    const c = allItemsChip({ importEnabled: true, allItems: scraptfListCoverage({ items: 2341, newestAt: NOW - 4 * MIN }) }, NOW)!;
    expect(c).toMatchObject({ kind: 'list', bank: 'list', label: 'All items', status: 'saved 4 min ago · 2,341 items', tone: 'good', url: SCRAPTF_ITEMS_URL, title: ALL_ITEMS_TIP });
    // F15: a click opens the list's card on the scrap.tf banks page.
    expect(c.ariaLabel).toBe('All items: saved 4 min ago · 2,341 items. Opens the scrap.tf/items card on the scrap.tf banks page.');
    expect(ALL_ITEMS_TIP).not.toBe(COVERAGE_TIP);
    // A bank page chip says which kind it is too.
    expect(coverageChip({ label: 'Hats', url: 'https://scrap.tf/buy/hats', lastSavedAt: null, items: 0 }, NOW).kind).toBe('page');
  });

  it('opens the static address whatever the service sent, and says "never saved" without a list', () => {
    const c = allItemsChip({ importEnabled: true, allItems: { label: 'All items', url: 'https://example.com/x', lastSavedAt: null, items: 0 } }, NOW)!;
    expect(c).toMatchObject({ url: SCRAPTF_ITEMS_URL, status: 'never saved', tone: 'muted' });
  });

  it('hides with the strip while import is off', () => {
    expect(allItemsChip({ importEnabled: false, allItems: scraptfListCoverage({ items: 5, newestAt: NOW }) }, NOW)).toBeNull();
    expect(allItemsChip(null, NOW)).toBeNull();
  });
});

describe('Import result for a saved scrap.tf/items page', () => {
  const list = { pageKind: 'items-list' as const, stored: 10, parsed: 13, fileName: 'items.html' };

  it('says how many list rows the save wrote, out-of-stock ones included, which "Stored" alone undersells', () => {
    expect(importListRowsText({ ...list, listRows: 2341 })).toBe('2,341 scrap.tf items updated on your price list, out-of-stock ones included.');
    expect(importListRowsText({ ...list, listRows: 1 })).toBe('1 scrap.tf item updated on your price list, out-of-stock ones included.');
    expect(importListRowsText({ ...list, listRows: 0 })).toBe('No list rows changed: a newer save of scrap.tf/items is already stored.');
  });

  it('has no list line for other pages, or a result without the count', () => {
    expect(importListRowsText({ pageKind: 'buy' })).toBeNull();
    expect(importListRowsText({ pageKind: 'buy', listRows: 5 })).toBeNull();
    expect(importListRowsText({ pageKind: 'items-list' })).toBeNull();
  });

  it('adds the list rows to the import toast, good when either half wrote something', () => {
    expect(importToastText({ ...list, listRows: 13 })).toEqual({ text: 'Imported 10 of 13 items from items.html; 13 price list rows updated', tone: 'good' });
    expect(importToastText({ ...list, stored: 0, listRows: 3 }).tone).toBe('good');
    expect(importToastText({ ...list, stored: 0, listRows: 0 }).tone).toBe('warn');
    // Other pages read as before.
    expect(importToastText({ pageKind: 'buy', stored: 4, parsed: 6, fileName: 'hats.html' })).toEqual({ text: 'Imported 4 of 6 items from hats.html', tone: 'good' });
    expect(importToastText({ pageKind: 'buy', stored: 0, parsed: 6, fileName: 'hats.html' }).tone).toBe('warn');
  });
});
