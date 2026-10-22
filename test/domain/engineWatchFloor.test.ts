// 0.8 (G1 path B): a watched copy's profit target is its "Profit:" bar in the engine (EngineDeps.watchFloorFor). A typed
// or imported opportunity of a watched copy is toasted at the watch's minProfitScrap instead of
// notifications.minProfitScrap, titled "Watch: <name>"; a rule candidate never asks; a failing hook is the usual bar.
// Every other gate is unchanged. In-memory repo, fake clock; no network, nothing touches scrap.tf.

import { afterEach, describe, expect, it } from 'vitest';
import type { Repo } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createEngine, notificationBody, notificationTitle, type EngineDeps } from '../../src/service/domain/engine';
import { bankStockSpecialKey } from '../../src/shared/bankStock';
import { CHECKOUT_GUARD_TOAST, withCheckoutGuard } from '../../src/shared/checkoutGuard';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import type { DeepPartial, Settings } from '../../src/shared/types';
import { FakeClock, FakeTimers, MIN, T0, createStubSchema, makeDeps, makeListing, recordingEvents, recordingLogger, special } from './helpers';

const K = 567;
const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

function setup(hooks: Pick<EngineDeps, 'watchFloorFor'> = {}, patch: DeepPartial<Settings> = {}) {
  const repo = openRepo(':memory:');
  repos.push(repo);
  repo.upsertKeyQuote({ source: 'pricedb', buyScrap: K, sellScrap: K + 3, observedAt: T0 });
  const clock = new FakeClock();
  // notifications.minProfitScrap 18 (the default), any confidence.
  const settings = mergeSettings(DEFAULT_SETTINGS, { notifications: { minConfidence: 0 }, ...patch });
  const events = recordingEvents();
  const log = recordingLogger();
  const engine = createEngine({ ...makeDeps(repo, clock, () => settings, log), schema: createStubSchema(), events, timers: new FakeTimers(clock), ...hooks });
  /** Three fresh buyers of `sku` at about `scrap` (a bot first). */
  const book = (sku: string, scrap: number): void => {
    repo.upsertListings(
      [0, 1, 2].map((i) =>
        makeListing({ id: `${sku}-${i}`, sku, baseSku: sku, steamid: `S${sku}-${i}`, metalScrap: scrap - i, isBot: i === 0, uaLastPulse: Math.floor(clock.t / 1000), userOnline: true, lastEventAt: clock.t - MIN }),
      ),
    );
  };
  const titles = (): string[] => events.notified.map((n) => n.title);
  return { repo, clock, engine, events, log, settings, book, titles };
}

/** The revenue the engine reads from book(sku, 108) (probed once: the profit of a 60-scrap import plus 60). */
async function revenueOf108(): Promise<number> {
  const h = setup({}, { notifications: { enabled: false } });
  h.book('378;6', 108);
  h.repo.upsertScrapPrice({ sku: '378;6', name: '', costScrap: 60, source: 'import', observedAt: T0 - MIN });
  await h.engine.runNow();
  const row = h.repo.allOpportunities()[0]!;
  expect(row.status).toBe('profitable');
  return row.profitScrap! + 60;
}

describe('the engine\'s watch floor (G1 path B)', () => {
  it('a floor of 12 toasts a profit-14 import that the 18 bar holds, titled "Watch: <name>"', async () => {
    const R = await revenueOf108();
    const plain = setup();
    plain.book('378;6', 108);
    plain.repo.upsertScrapPrice({ sku: '378;6', name: '', costScrap: R - 14, source: 'import', observedAt: T0 - MIN });
    await plain.engine.runNow();
    expect(plain.repo.allOpportunities()[0]).toMatchObject({ status: 'profitable', profitScrap: 14 });
    expect(plain.titles()).toEqual([]);

    const asked: [string, string][] = [];
    const h = setup({
      watchFloorFor: (base, copyKey) => {
        asked.push([base, copyKey]);
        return 12;
      },
    });
    h.book('378;6', 108);
    h.repo.upsertScrapPrice({ sku: '378;6', name: '', costScrap: R - 14, source: 'import', observedAt: T0 - MIN });
    await h.engine.runNow();
    expect(h.titles()).toEqual(['Watch: Team Captain']);
    // The base and the copy the price is for ('' a plain copy).
    expect(asked).toEqual([['378;6', '']]);
    // The same notified record as any toast: the next sweep stays quiet.
    await h.engine.runNow();
    expect(h.titles()).toHaveLength(1);
  });

  it('a floor of 40 holds a profit-30 toast the 18 bar would send', async () => {
    const R = await revenueOf108();
    const h = setup({ watchFloorFor: () => 40 });
    h.book('378;6', 108);
    h.repo.upsertScrapPrice({ sku: '378;6', name: '', costScrap: R - 30, source: 'user', observedAt: T0 - 10 * MIN });
    await h.engine.runNow();
    expect(h.repo.allOpportunities()[0]).toMatchObject({ status: 'profitable', profitScrap: 30 });
    expect(h.titles()).toEqual([]);
  });

  it('never asks for a rule candidate: its bar stays notifications.minProfitScrap', async () => {
    const R = await revenueOf108();
    const asked: string[] = [];
    const h = setup({
      watchFloorFor: (base) => {
        asked.push(base);
        return 0;
      },
    });
    h.book('378;6', 108);
    h.repo.upsertRule({ name: 'Look for', filter: { defindexes: [378], hasEffect: false }, costScrap: R - 14, observedAt: T0 - MIN });
    await h.engine.runNow();
    expect(h.repo.allOpportunities()[0]).toMatchObject({ inputKind: 'rule', status: 'profitable', profitScrap: 14 });
    expect(h.titles()).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('asks with a painted copy\'s key, and a null answer is the usual bar and title', async () => {
    const R = await revenueOf108();
    const asked: [string, string][] = [];
    const h = setup({
      watchFloorFor: (base, copyKey) => {
        asked.push([base, copyKey]);
        return null;
      },
    });
    h.book('378;6', 108);
    h.repo.upsertScrapPrice({ sku: '378;6;p8208497', name: '', costScrap: R - 30, source: 'user', observedAt: T0 - 10 * MIN, special: special({ paint: 8208497 }) });
    await h.engine.runNow();
    expect(asked).toEqual([['378;6', bankStockSpecialKey({ paint: 8208497 })]]);
    expect(h.titles()).toHaveLength(1);
    expect(h.titles()[0]).toMatch(/^Profit: Team Captain/);
  });

  it('a throwing or nonsense hook falls back to notifications.minProfitScrap, logged', async () => {
    const R = await revenueOf108();
    const broken = setup({
      watchFloorFor: () => {
        throw new Error('watches gone');
      },
    });
    broken.book('378;6', 108);
    broken.repo.upsertScrapPrice({ sku: '378;6', name: '', costScrap: R - 30, source: 'user', observedAt: T0 - 10 * MIN });
    await broken.engine.runNow();
    expect(broken.titles()).toEqual(['Profit: Team Captain']);
    expect(broken.log.lines.some((l) => l.level === 'warn' && /notification check failed/.test(l.msg))).toBe(true);

    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY, '3' as unknown as number]) {
      const h = setup({ watchFloorFor: () => bad });
      h.book('378;6', 108);
      h.repo.upsertScrapPrice({ sku: '378;6', name: '', costScrap: R - 14, source: 'user', observedAt: T0 - 10 * MIN });
      await h.engine.runNow();
      // Profit 14 under the 18 bar: held, as without a watch.
      expect(h.titles(), String(bad)).toEqual([]);
    }
  });

  it("0.9 (#9): the engine's Watch toast carries the checkout guard; a Profit toast does not", async () => {
    const R = await revenueOf108();
    const h = setup({ watchFloorFor: () => 12 });
    h.book('378;6', 108);
    h.repo.upsertScrapPrice({ sku: '378;6', name: '', costScrap: R - 14, source: 'import', observedAt: T0 - MIN });
    await h.engine.runNow();
    const watched = h.events.notified[0]!;
    expect(watched.title).toBe('Watch: Team Captain');
    const keyScrap = h.engine.keyPrice().valueScrap;
    const body = notificationBody(h.repo.allOpportunities()[0]!, keyScrap, h.settings.profit.useOrder);
    expect(watched.body).toBe(withCheckoutGuard(body));
    expect(watched.body.endsWith(CHECKOUT_GUARD_TOAST)).toBe(true);
    expect(watched.body).not.toBe(body);

    // No watch: a profit at or over the 18 bar is a "Profit:" toast whose body is notificationBody's, word for word.
    const plain = setup();
    plain.book('378;6', 108);
    plain.repo.upsertScrapPrice({ sku: '378;6', name: '', costScrap: R - 30, source: 'user', observedAt: T0 - 10 * MIN });
    await plain.engine.runNow();
    const profit = plain.events.notified[0]!;
    expect(profit.title).toBe('Profit: Team Captain');
    expect(profit.body).toBe(notificationBody(plain.repo.allOpportunities()[0]!, plain.engine.keyPrice().valueScrap, plain.settings.profit.useOrder));
    expect(profit.body).not.toContain(CHECKOUT_GUARD_TOAST);
  });

  it('keeps every other gate: a watched copy under notifications.minConfidence is not toasted', async () => {
    const R = await revenueOf108();
    const h = setup({ watchFloorFor: () => 0 }, { notifications: { minConfidence: 101 } });
    h.book('378;6', 108);
    h.repo.upsertScrapPrice({ sku: '378;6', name: '', costScrap: R - 30, source: 'user', observedAt: T0 - 10 * MIN });
    await h.engine.runNow();
    expect(h.titles()).toEqual([]);
  });
});

describe('notificationTitle(…, watched)', () => {
  it("reads 'Watch: <name>' for a watched typed or imported price, never for a rule", () => {
    const o = { inputKind: 'import' as const, name: 'Team Captain', sku: '378;6' };
    expect(notificationTitle(o, undefined, true)).toBe('Watch: Team Captain');
    expect(notificationTitle(o)).toBe('Profit: Team Captain');
    expect(notificationTitle({ ...o, inputKind: 'user' }, undefined, true)).toBe('Watch: Team Captain');
    expect(notificationTitle({ ...o, inputKind: 'rule' }, undefined, true)).toBe('Candidate: Team Captain');
    // A copy's extras name it as before.
    expect(notificationTitle({ ...o, copyKey: bankStockSpecialKey({ paint: 2960676 }) }, (d) => (d === 2960676 ? 'After Eight' : null), true)).toBe('Watch: Team Captain (After Eight)');
  });
});
