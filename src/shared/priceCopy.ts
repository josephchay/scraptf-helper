// 0.7.4 (F80): which stored price is one for a given copy of an item. Shared by the renderer (the drawer's
// form, Record buy, the Live market's newest price) and the service ('prices.upsert' with replaceTyped, so
// Quick entry and the check popup update the user's newest typed price of the copy instead of adding one).
// Pure and zod-free.

import { fromString } from './sku';
import type { ScrapPrice } from './types';

/** The paint a SKU names, or null (also for text that is not a SKU). */
function paintOfSku(sku: string): number | null {
  try {
    const paint = fromString(sku).paint;
    return typeof paint === 'number' && paint > 0 ? paint : null;
  } catch {
    return null;
  }
}

/**
 * Whether a stored price is one for the copy `sku` names. Prices sit under the base SKU with the paint
 * and other extras in `special` (null: never recorded, read as a plain copy, as the saved-page import
 * does): a painted SKU takes prices of its paint, a plain SKU only prices with no extras at all.
 * 0.7.2: a sheen or killstreaker is not an extra here (the service's isOtherCopy): every specialized and
 * professional kit or weapon carries one, so counted, such an item had no price of its own to prefill.
 */
export function priceIsForSku(p: Pick<ScrapPrice, 'sku' | 'special'>, sku: string): boolean {
  const s = p.special;
  const paint = (typeof s?.paint === 'number' && s.paint > 0 ? s.paint : null) ?? paintOfSku(p.sku);
  const want = paintOfSku(sku);
  if (want !== null || paint !== null) return paint === want;
  if (!s) return true;
  return s.spells.length === 0 && s.parts.length === 0 && !s.customName && !s.customDesc;
}

/**
 * 0.7.4 (F80): the user's newest typed price of the copy `sku` names (observedAt, then the higher id), or
 * null: the row Quick entry and the check popup update ('prices.upsert' replaceTyped), as the drawer's form
 * does (drawerPriceTargets). Imported and rule prices are never one.
 */
export function newestTypedPriceFor<T extends Pick<ScrapPrice, 'id' | 'sku' | 'special' | 'source' | 'observedAt'>>(prices: readonly T[], sku: string): T | null {
  let best: T | null = null;
  for (const p of prices) {
    if (p.source !== 'user' || !priceIsForSku(p, sku)) continue;
    if (best === null || p.observedAt > best.observedAt || (p.observedAt === best.observedAt && p.id > best.id)) best = p;
  }
  return best;
}
