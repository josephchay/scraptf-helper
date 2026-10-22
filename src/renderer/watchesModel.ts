// scrap.tf watches in the dashboard (0.8, G1/G3): the words and the form rules of "Watch on scrap.tf…" (the item
// menu, the drawer's "scrap.tf watch" section, the Banks page's watch list). A watch is the user's own target,
// judged only on the scrap.tf pages they read in the window or save; Flip Desk never loads scrap.tf on its own (R1)
// and never buys anything (R4): a hit is a notification. Pure: the matching rules live in src/shared/watches.ts.
// The texts below use SCRAPTF_BOUNDARY_SHORT's wording, the one UX-7 kept (boundaryWording.test.ts).

import { bankStockTargetOf } from '../shared/bankStock';
import { SCRAPTF_BOUNDARY_SHORT } from '../shared/boundaryText';
import { formatKeysMetal, parsePrice } from '../shared/currency';
import { opportunityCopyKey } from '../shared/copyExtras';
import { scraptfBankInfo } from '../shared/links';
import { WATCHES_MAX, WATCH_NAME_MAX, watchInputProblem, type ScraptfWatchRestore } from '../shared/watches';
import type {
  Category,
  Opportunity,
  Scrap,
  ScrapPrice,
  ScraptfBank,
  ScraptfChangeEvent,
  ScraptfWatch,
  ScraptfWatchInput,
  ScraptfWatchView,
  Settings,
  UnixMs,
} from '../shared/types';
import { bankStockExtras } from './bankStockModel';
import type { BareUnit } from './components/PriceInput';
import { fmtAgo, fmtKeysMetal, fmtMoney, fmtRefOnly, type Tone } from './format';

/** The item menu entry and the drawer's button. */
export const WATCH_MENU_LABEL = 'Watch on scrap.tf…';
/** Its tooltip: what a watch tells, and that nothing is visited or bought. */
export const WATCH_MENU_TITLE =
  'Tell me when it is at your price or profit, or back on sale, on a scrap.tf page you read or save. Flip Desk never loads scrap.tf on its own and never buys anything.';
/** Under every watch form: where a watch is checked (the user's own reads and saves only). */
export const WATCH_BOUNDARY_NOTE =
  'Checked only on the scrap.tf pages you read in the window or save; Flip Desk never loads scrap.tf on its own. A change is told at your next read. Nothing is bought for you.';
/** The watch list with no watch. */
export const WATCHES_EMPTY = {
  title: 'No watches yet',
  body: "Open an item and choose Watch on scrap.tf… in its menu or its details panel. You'll be told when a page you read or save shows it at your price.",
} as const;

/** The watch form's fields as typed. */
export interface WatchFormState {
  /** 'one': the copy the form was opened on; 'any': every copy of the item. */
  copies: 'one' | 'any';
  /** "Tell me when it costs at most": a price as traders type it, '' for none. */
  price: string;
  /** "or makes at least", in ref; '' for none. */
  profit: string;
  /** "Tell me when it is back on sale". */
  onRestock: boolean;
}

/**
 * The form for an existing watch (or a blank one): its price as typed (keys and metal, formatKeysMetal; a metal-only
 * price without its ' ref' when bare numbers read as ref, so the field shows "1.88"), its profit in ref (fmtRefOnly)
 * and its "back on sale" switch.
 */
export function watchFormInit(w: Pick<ScraptfWatch, 'maxCostKeys' | 'maxCostScrap' | 'minProfitScrap' | 'onRestock'> | null, copies: 'one' | 'any', unit: BareUnit = 'ref'): WatchFormState {
  if (w === null) return { copies, price: '', profit: '', onRestock: false };
  const keys = Number.isFinite(w.maxCostKeys) ? w.maxCostKeys : 0;
  let price = '';
  if (w.maxCostScrap !== null) {
    const text = formatKeysMetal(keys, w.maxCostScrap);
    // A bare "1.88" would read as scrap or keys under another unit: keep the suffix there.
    price = keys === 0 && unit === 'ref' ? text.replace(/ ref$/, '') : text;
  }
  return { copies, price, profit: w.minProfitScrap === null ? '' : fmtRefOnly(w.minProfitScrap), onRestock: w.onRestock };
}

// Refusals of the watch form (watchFormInput); the shared rules' own (watchInputProblem) pass through as they are.
/** A price the form cannot read (parsePrice in the chosen unit). */
export const WATCH_PRICE_ERROR = 'Enter a price, for example 1.33 or 2 keys 5.11.';
/** A profit the form cannot read (parsePrice in ref). */
export const WATCH_PROFIT_ERROR = 'Enter a profit, for example 1.33.';
/** A profit typed in keys while the key price is not known: it cannot be valued. */
export const WATCH_PROFIT_KEYS_ERROR = 'The key price is not known yet; enter the profit in ref.';

/**
 * The form as 'watches.upsert' params, or the first refusal: a price read as traders type it (bare numbers in `unit`;
 * keys and metal kept as typed, valued at each read's key price), a profit read in ref (keys valued at `keyScrap` and
 * rounded; refused without a key price), then the shared watchInputProblem. 'any' watches every copy; 'one' the
 * form's copy (`special`, else the SKU's own). Saving turns the watch on.
 */
export function watchFormInput(
  s: WatchFormState,
  a: { sku: string; special: string | null; name: string; id?: number; unit: BareUnit; keyScrap: Scrap | null },
): { input: ScraptfWatchInput } | { error: string } {
  let maxCostKeys = 0;
  let maxCostScrap: Scrap | null = null;
  if (s.price.trim()) {
    const p = parsePrice(s.price, a.unit);
    if (!p) return { error: WATCH_PRICE_ERROR };
    maxCostKeys = p.keys;
    maxCostScrap = Math.round(p.scrap);
  }
  let minProfitScrap: Scrap | null = null;
  if (s.profit.trim()) {
    const p = parsePrice(s.profit, 'ref');
    if (!p) return { error: WATCH_PROFIT_ERROR };
    if (p.keys > 0 && !(a.keyScrap !== null && a.keyScrap > 0)) return { error: WATCH_PROFIT_KEYS_ERROR };
    minProfitScrap = Math.round(p.keys * (a.keyScrap ?? 0) + p.scrap);
  }
  const problem = watchInputProblem({ maxCostKeys, maxCostScrap, minProfitScrap, onRestock: s.onRestock });
  if (problem !== null) return { error: problem };
  return {
    input: {
      ...(a.id !== undefined ? { id: a.id } : {}),
      sku: a.sku,
      copies: s.copies,
      special: s.copies === 'any' ? null : a.special,
      name: a.name.trim().slice(0, WATCH_NAME_MAX),
      maxCostKeys,
      maxCostScrap,
      minProfitScrap,
      onRestock: s.onRestock,
      enabled: true,
    },
  };
}

/** Which copies a watch covers, in words: 'Any copy', 'Clean copy', or the copy's extras ("Paint: Pink as Hell"). */
export function watchCopyText(w: Pick<ScraptfWatch, 'sku' | 'specialKey'>): string {
  if (w.specialKey === null) return 'Any copy';
  if (w.specialKey === '') return 'Clean copy';
  return bankStockExtras(`${w.sku}|${w.specialKey}`).join(', ') || 'This copy';
}

/** A bank's label ("Hats"), else its id. */
function bankLabel(bank: string): string {
  return scraptfBankInfo(bank)?.label ?? bank;
}

/**
 * Where a watch stands in the user's newest saves (ScraptfWatchView.now), one line and its tooltip: not on sale
 * (muted), at the price target or the profit target (good), over the price target (warn), else just the price
 * (muted). The price is the copy's as listed; every tooltip names the save it rests on ("your save 5 min ago").
 */
export function watchNowView(v: Pick<ScraptfWatchView, 'now'>, keyScrap: Scrap | null, now: UnixMs): { text: string; title: string; tone: Tone } {
  const n = v.now;
  if (n === null) {
    return {
      text: 'Not on sale in your saves',
      title: `None of your saved pages' newest saves lists it on sale. Read or save its page to check; ${SCRAPTF_BOUNDARY_SHORT}`,
      tone: 'muted',
    };
  }
  const where = `${fmtKeysMetal(n.costKeys, n.costScrapRaw)} on ${bankLabel(n.bank)}`;
  const save = `(your save ${fmtAgo(n.savedAt, now)})`;
  if (n.met === 'price') {
    return { text: `At your target: ${where}`, title: `The cheapest copy it covers on your newest saves is at or under your price ${save}. Nothing is bought for you.`, tone: 'good' };
  }
  if (n.met === 'profit') {
    return {
      text: `Profit target met: +${fmtMoney(n.profitScrap, keyScrap)} at ${where}`,
      title: `The cheapest copy it covers on your newest saves makes at least your profit at today's buy orders ${save}. Nothing is bought for you.`,
      tone: 'good',
    };
  }
  if (n.overTargetScrap !== null && n.overTargetScrap > 0) {
    return { text: `${where}: ${fmtMoney(n.overTargetScrap, keyScrap)} over your target`, title: `The cheapest copy it covers on your newest saves ${save}.`, tone: 'warn' };
  }
  return { text: where, title: `The cheapest copy it covers on your newest saves ${save}.`, tone: 'muted' };
}

/**
 * Why a watch would tell nothing, said under the form: desktop notifications off, watch notifications off
 * (notifications.watches), or saved-page import off (no page is read); null when watches can notify.
 */
export function watchNotifyNote(s: Settings | null): string | null {
  if (!s) return null;
  if (!s.notifications.enabled) return 'Desktop notifications are off (Settings → Notifications): watches show here only.';
  if (s.notifications.watches === false) return 'Watch notifications are off (Settings → Notifications).';
  if (!(s.import.enabled && s.import.acknowledgedAt !== null)) return 'Saved-page import is off, so no page is read for your watches (Import).';
  return null;
}

/**
 * An item's watches by scope: `one`, the watch of the form's copy (`special`, else the SKU's own: its paint, else a
 * clean copy); `any`, its every-copy watch. Watches of another base are left out.
 */
export function watchesForCopy<W extends Pick<ScraptfWatch, 'sku' | 'specialKey'>>(list: readonly W[], sku: string, special: string | null): { one: W | null; any: W | null } {
  const target = bankStockTargetOf(sku);
  const base = target?.base ?? sku;
  const copy = special ?? target?.specialKey ?? '';
  const mine = list.filter((w) => w.sku === base);
  return { one: mine.find((w) => w.specialKey !== null && w.specialKey === copy) ?? null, any: mine.find((w) => w.specialKey === null) ?? null };
}

/**
 * The item menu target of a row that prices one copy, with that copy (ItemMenuTarget.special, a bank_stock special
 * key), so "Watch on scrap.tf…" watches the copy the row shows, as the drawer opened on it does. Imports keep a painted
 * hat or a kit combo under the plain base SKU with its extras on the side (copyExtras.ts), so the SKU alone names the
 * clean copy. An Opportunities row: its input's copy (Opportunity.copyKey; absent on older objects: the SKU's own).
 */
export function oppMenuTarget(o: Pick<Opportunity, 'sku' | 'name' | 'category' | 'copyKey'>): { sku: string; name: string; category: Category; special?: string } {
  return { sku: o.sku, name: o.name, category: o.category, ...(typeof o.copyKey === 'string' ? { special: o.copyKey } : {}) };
}

/** A price row's menu target: the copy it prices (opportunityCopyKey of its SKU and extras, as its opportunity's copyKey). */
export function priceMenuTarget(p: Pick<ScrapPrice, 'sku' | 'name' | 'special'>): { sku: string; name: string; special: string } {
  return { sku: p.sku, name: p.name, special: opportunityCopyKey(p.sku, p.special) };
}

/** A scrap.tf change event's menu target: the copy it is about (its bank_stock special key) on its bank's page. */
export function changeMenuTarget(e: Pick<ScraptfChangeEvent, 'sku' | 'name' | 'bank' | 'specialKey'>): { sku: string; name: string; bank: ScraptfBank; special: string } {
  return { sku: e.sku, name: e.name, bank: e.bank, special: e.specialKey };
}

/**
 * The accessible names of a watch row's Pause/Resume and Remove buttons, which show only the verb: the list holds up
 * to 200 watches and the drawer can show a "Clean copy" and an "Any copy" watch of one item, so each names its watch
 * ("Remove the watch of Team Captain (Any copy)"), as the app's other row actions name their row.
 */
export function watchActionLabels(w: Pick<ScraptfWatch, 'sku' | 'specialKey' | 'name' | 'enabled'>): { toggle: string; remove: string } {
  const which = `the watch of ${w.name} (${watchCopyText(w)})`;
  return { toggle: `${w.enabled ? 'Pause' : 'Resume'} ${which}`, remove: `Remove ${which}` };
}

/** The toast after Remove (its Undo adds the watch back: watchUndoInput). */
export function watchRemovedText(w: Pick<ScraptfWatch, 'name'>): string {
  return `Stopped watching ${w.name}`;
}

/**
 * Undo of a removal: the removed watch as 'watches.restore' params, its copy, targets and switches with the id and
 * times it had, so the same watch comes back (watchRestoreOf): its notification dedupe still holds and a same-price
 * read tells nothing again, where a new watch would be judged afresh under a new id.
 */
export function watchUndoInput(w: ScraptfWatch): ScraptfWatchRestore {
  return {
    id: w.id,
    sku: w.sku,
    copies: w.specialKey === null ? 'any' : 'one',
    special: w.specialKey,
    name: w.name,
    maxCostKeys: w.maxCostKeys,
    maxCostScrap: w.maxCostScrap,
    minProfitScrap: w.minProfitScrap,
    onRestock: w.onRestock,
    enabled: w.enabled,
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

/** The watch list's count against the cap: "3 of 200". */
export function watchesCountText(n: number): string {
  return `${n} of ${WATCHES_MAX}`;
}
