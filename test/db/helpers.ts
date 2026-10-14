import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Listing, Opportunity, OpportunityEvent, OrderSummary, SpecialAttrs } from '../../src/shared/types';

export function emptySpecial(): SpecialAttrs {
  return { paint: null, spells: [], parts: [], sheen: null, killstreaker: null, customName: false, customDesc: false };
}

export function makeListing(over: Partial<Listing> = {}): Listing {
  return {
    id: 'l1',
    sku: '378;6',
    baseSku: '378;6',
    intent: 'buy',
    steamid: '76561198000000001',
    userName: 'Trader',
    keys: 0,
    metalScrap: 27,
    isBot: false,
    uaClient: null,
    uaLastPulse: null,
    userOnline: null,
    userBanned: false,
    isMarketplace: false,
    special: emptySpecial(),
    details: '',
    listedAt: 1_791_950_000,
    bumpedAt: null,
    lastEventAt: 1_791_958_000_000,
    origin: 'ws',
    itemName: 'Team Captain',
    marketName: null,
    ...over,
  };
}

export function makeOrder(over: Partial<OrderSummary> = {}): OrderSummary {
  return {
    listingId: 'l1',
    steamid: '76561198000000001',
    userName: 'Buyer',
    keys: 1,
    metalScrap: 18,
    valueScrap: 600,
    isBot: true,
    online: null,
    lastEventAt: 1_791_958_000_000,
    bumpedAt: null,
    details: 'buying',
    flags: ['unverified'],
    eligible: true,
    ...over,
  };
}

export function makeOpp(over: Partial<Opportunity> = {}): Opportunity {
  const sku = over.sku ?? '378;6';
  const inputRef = over.inputRef ?? 'price:1';
  return {
    key: `${sku}|${inputRef}`,
    sku,
    name: 'Team Captain',
    category: 'hats',
    inputRef,
    inputKind: 'user',
    costKeys: 0,
    costScrapRaw: 300,
    costScrap: 300,
    bestScrap: 400,
    consScrap: 380,
    instantScrap: 360,
    revenueScrap: 380,
    profitScrap: 80,
    margin: 0.21,
    maxCostScrap: null,
    confidence: 70,
    confidenceLevel: 'medium',
    flags: [],
    reasons: ['3 buyers'],
    buyerCount: 3,
    bestOrder: makeOrder(),
    consOrder: null,
    instantOrder: null,
    references: { pricedb: { buyScrap: 350, sellScrap: 380, time: 1_791_950_000, ageMs: 1000 }, community: null },
    profitTier: 'ref2',
    status: 'profitable',
    inputObservedAt: 1_791_950_000_000,
    firstSeenAt: 1_791_950_000_000,
    updatedAt: 1_791_958_000_000,
    ...over,
  };
}

export function makeEvent(over: Partial<Omit<OpportunityEvent, 'id'>> = {}): Omit<OpportunityEvent, 'id'> {
  return {
    key: '378;6|price:1',
    sku: '378;6',
    name: 'Team Captain',
    category: 'hats',
    kind: 'appeared',
    profitScrap: 80,
    costScrap: 300,
    revenueScrap: 380,
    confidence: 70,
    summary: 'appeared',
    ts: 1_000,
    ...over,
  };
}

/** A fresh directory under the OS temp dir; call cleanup() after closing every DB in it. */
export function tempDir(prefix = 'flipdesk-db-'): { dir: string; file(name?: string): string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    file: (name = 'flipdesk.sqlite') => join(dir, name),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
