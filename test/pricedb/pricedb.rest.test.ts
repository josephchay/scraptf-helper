import { describe, expect, it } from 'vitest';
import {
  BULK_CHUNK,
  LOAD_ALL_MIN_INTERVAL_MS,
  LOAD_ALL_SLACK_MS,
  META_LOAD_ALL_AT,
  createPriceDb,
  pricedbRecordSchema,
  pricedbVariants,
  recordToRow,
} from '../../src/service/connectors/pricedb';
import { buildSchemaSnapshot } from '../../src/service/connectors/schema';
import type { HttpRequestOptions, HttpResponse } from '../../src/service/contracts';
import { NetworkPausedError } from '../../src/service/net';
import { refToScrap } from '../../src/shared/currency';
import { canonical, fromString } from '../../src/shared/sku';
import { FakeClock, FakeTimers, T0, fixture, flush, makeDeps, res, type TestDeps } from './helpers';

const API = 'https://pricedb.io/api';

interface Rec {
  sku: string;
  name: string;
  time: number;
  buy: { keys: number; metal: number };
  sell: { keys: number; metal: number };
}

function rec(sku: string, buyMetal = 1, sellMetal = 2, time = 1_791_960_000, keys = 0): Rec {
  return { sku, name: `Item ${sku}`, time, buy: { keys, metal: buyMetal }, sell: { keys, metal: sellMetal } };
}

/** Route for /api/item/{sku}: known SKUs answer 200, everything else 404. */
function itemRoute(known: Record<string, unknown>, extra?: (url: string, opts: HttpRequestOptions) => HttpResponse | null) {
  return (url: string, opts: HttpRequestOptions): HttpResponse => {
    const hit = extra?.(url, opts);
    if (hit) return hit;
    const m = /^https:\/\/pricedb\.io\/api\/item\/(.+)$/.exec(url);
    if (m) {
      const sku = decodeURIComponent(m[1]!);
      return sku in known ? res(known[sku]) : res({ error: 'Item not found' }, { status: 404 });
    }
    return res({ error: 'Item not found' }, { status: 404 });
  };
}

function itemUrl(sku: string): string {
  return `${API}/item/${encodeURIComponent(sku)}`;
}

function withSchema(deps: TestDeps): void {
  const built = buildSchemaSnapshot(fixture('schema-subset.json'), fixture('paint-list.json'), T0, null);
  deps.repo.replaceSchema(built.snapshot);
}

describe('PriceDB records', () => {
  it('converts metal to scrap and keeps keys separate', () => {
    const r = pricedbRecordSchema.parse(fixture('item-australium.json'));
    expect(recordToRow(r, '205;11;australium', T0)).toEqual({
      sku: '205;11;australium',
      name: 'Strange Australium Rocket Launcher',
      buyKeys: 41,
      buyScrap: refToScrap(47.66),
      sellKeys: 42,
      sellScrap: refToScrap(28.55),
      time: 1791968913,
      fetchedAt: T0,
    });
  });

  it('accepts numeric strings and rejects junk', () => {
    expect(pricedbRecordSchema.safeParse({ sku: '5021;6', name: 'Key', time: '1', buy: { metal: '63.11' }, sell: { keys: 0, metal: 64 } }).success).toBe(true);
    expect(pricedbRecordSchema.safeParse({ sku: '5021;6', buy: { metal: -1 }, sell: {} }).success).toBe(false);
    expect(pricedbRecordSchema.safeParse({ error: 'Item not found' }).success).toBe(false);
  });
});

describe('pricedbVariants', () => {
  it('tries legacy, v3, then the w/pk swap', () => {
    expect(pricedbVariants('15000;15;w1;pk14')).toEqual(['15000;15;w1;pk14', '15000;15;pk14;w1']);
    expect(pricedbVariants('160;3;n4;uncraftable')).toEqual(['160;3;uncraftable;n4', '160;3;n4;uncraftable']);
    expect(pricedbVariants('20003;6;kt-3;td-205;od-6526;oq-6')[0]).toBe('20003;6;kt-3;td-205;od-6526;oq-6');
    expect(pricedbVariants('200;6;uncraftable;kt-1;td-5;festive')).toEqual(['200;6;uncraftable;kt-1;td-5;festive', '200;6;uncraftable;kt-1;festive;td-5']);
  });

  it('adds the strange skin forms', () => {
    expect(pricedbVariants('1104;15;w1;pk163;strange;kt-3')).toEqual([
      '1104;15;w1;pk163;strange;kt-3',
      '1104;15;pk163;w1;strange;kt-3',
      '1104;11;w1;pk163;kt-3',
      '1104;11;pk163;w1;kt-3',
    ]);
    expect(pricedbVariants('15000;11;w3;pk14;kt-1;festive')).toContain('15000;15;w3;pk14;strange;kt-1;festive');
  });

  it('adds crate defindex aliases', () => {
    expect(pricedbVariants('5022;6;c11', (d) => (d === 5022 ? [5041, 5045] : []))).toEqual(['5022;6;c11', '5041;6;c11', '5045;6;c11']);
  });
});

describe('PriceDb.item', () => {
  it('fetches, converts and stores a price', async () => {
    const deps = makeDeps(itemRoute({ '5021;6': fixture('item-key.json') }));
    const pdb = createPriceDb(deps);
    const row = await pdb.item('5021;6');
    expect(row).toEqual({
      sku: '5021;6',
      name: 'Mann Co. Supply Crate Key',
      buyKeys: 0,
      buyScrap: 569,
      sellKeys: 0,
      sellScrap: 581,
      time: 1791968059,
      fetchedAt: T0,
    });
    expect(deps.repo.getPricedb('5021;6')).toEqual(row);
    expect(deps.http.calls[0]).toMatchObject({ url: itemUrl('5021;6'), opts: { budget: 'pricedb', priority: 'user' } });
    expect(pdb.health()[0]).toMatchObject({ id: 'pricedb', state: 'idle' });
  });

  it('walks the variant chain and caches the variant that worked', async () => {
    const deps = makeDeps(itemRoute({ '15000;15;pk14;w1': rec('15000;15;pk14;w1', 5.11, 6.77) }));
    const pdb = createPriceDb(deps);
    const row = await pdb.item('15000;15;pk14;w1');
    expect(row?.sku).toBe('15000;15;w1;pk14');
    expect(row?.buyScrap).toBe(46);
    expect(deps.http.urls()).toEqual([itemUrl('15000;15;w1;pk14'), itemUrl('15000;15;pk14;w1')]);
    expect(deps.repo.getSkuAlias('15000;15;w1;pk14')).toBe('15000;15;pk14;w1');

    deps.http.calls.length = 0;
    await pdb.item('15000;15;w1;pk14');
    expect(deps.http.urls()).toEqual([itemUrl('15000;15;pk14;w1')]);
  });

  it('falls back to the 11-primary strange skin form', async () => {
    const deps = makeDeps(itemRoute({ '1104;11;w1;pk163;kt-3': rec('1104;11;w1;pk163;kt-3') }));
    const row = await createPriceDb(deps).item('1104;15;w1;pk163;kt-3;strange');
    expect(row?.sku).toBe('1104;15;w1;pk163;strange;kt-3');
    expect(deps.http.urls()).toHaveLength(3);
    expect(deps.repo.getSkuAlias('1104;15;w1;pk163;strange;kt-3')).toBe('1104;11;w1;pk163;kt-3');
  });

  it('tries crate aliases from the schema', async () => {
    const deps = makeDeps(itemRoute({ '5041;6;c11': rec('5041;6;c11', 0, 0, 1, 2) }));
    withSchema(deps);
    const row = await createPriceDb(deps).item('5022;6;c11');
    expect(row).toMatchObject({ sku: '5022;6;c11', buyKeys: 2 });
    expect(deps.http.urls()).toEqual([itemUrl('5022;6;c11'), itemUrl('5041;6;c11')]);
  });

  it('remembers misses for 30 minutes', async () => {
    const clock = new FakeClock();
    const deps = makeDeps(itemRoute({}), { clock });
    const pdb = createPriceDb(deps);
    expect(await pdb.item('999999;6')).toBeNull();
    expect(deps.http.calls).toHaveLength(1);
    expect(await pdb.item('999999;6')).toBeNull();
    expect(deps.http.calls).toHaveLength(1);
    clock.advance(31 * 60 * 1000);
    await pdb.item('999999;6');
    expect(deps.http.calls).toHaveLength(2);
  });

  it('does nothing when disabled or for invalid SKUs', async () => {
    const deps = makeDeps(itemRoute({ '5021;6': fixture('item-key.json') }), { settings: { connectors: { pricedb: false } } });
    const pdb = createPriceDb(deps);
    expect(await pdb.item('5021;6')).toBeNull();
    expect(await pdb.bulk(['5021;6'])).toEqual([]);
    expect(await pdb.loadAll()).toBe(0);
    expect(await pdb.history('5021;6')).toEqual([]);
    expect(await pdb.keyQuote()).toBeNull();
    expect(deps.http.calls).toHaveLength(0);
    expect(pdb.health()[0]).toMatchObject({ state: 'off' });

    deps.setSettings({ connectors: { pricedb: true } });
    expect(await pdb.item('Team Captain')).toBeNull();
    expect(deps.http.calls).toHaveLength(0);
  });

  it('records failures in health without throwing', async () => {
    const deps = makeDeps(() => res({ error: 'oops' }, { status: 500 }));
    const pdb = createPriceDb(deps);
    await expect(pdb.item('5021;6')).resolves.toBeNull();
    // 0.7.4 (F52): a 500 pauses the budget as a 503 does, so health reads backoff (was 'error').
    expect(pdb.health()[0]).toMatchObject({ state: 'backoff', lastError: 'HTTP 500' });

    const paused = makeDeps(() => {
      throw new NetworkPausedError();
    });
    const p2 = createPriceDb(paused);
    await expect(p2.item('5021;6')).resolves.toBeNull();
    paused.http.paused = true;
    expect(p2.health()[0]!.state).toBe('paused');
  });

  for (const [status, body] of [
    [403, { error: 'Forbidden' }],
    [401, { error: 'Unauthorized' }],
    [403, null],
  ] as const) {
    it(`disables the connector on HTTP ${status}${body ? ' with a JSON body' : ''} and sends nothing more`, async () => {
      const deps = makeDeps(() => res(body, { status }));
      const pdb = createPriceDb(deps);
      expect(await pdb.keyQuote()).toBeNull();
      expect(deps.http.calls).toHaveLength(1);
      const h = pdb.health()[0]!;
      expect(h.state).toBe('blocked');
      expect(h.disabledReason).toMatch(new RegExp(`PriceDB refused requests \\(HTTP ${status}\\)`));

      // key price retries, bulk refreshes, the full list and history all stay quiet.
      expect(await pdb.keyQuote()).toBeNull();
      expect(await pdb.item('378;6')).toBeNull();
      expect(await pdb.bulk(['378;6', '5021;6'])).toEqual([]);
      expect(await pdb.loadAll()).toBe(0);
      expect(await pdb.history('5021;6')).toEqual([]);
      expect(deps.http.calls).toHaveLength(1);
      expect(pdb.health()[0]!.state).toBe('blocked');
    });
  }

  it('stays off across a Settings toggle; a restart (new instance) tries again', async () => {
    let refuse = true;
    const route = (url: string, opts: HttpRequestOptions): HttpResponse =>
      refuse ? res({ error: 'Forbidden' }, { status: 403 }) : itemRoute({ '5021;6': fixture('item-key.json') })(url, opts);
    const deps = makeDeps(route);
    const pdb = createPriceDb(deps);
    await pdb.item('5021;6');
    expect(pdb.health()[0]!.disabledReason).toMatch(/until the app restarts/);
    refuse = false;
    deps.setSettings({ connectors: { pricedb: false } });
    deps.setSettings({ connectors: { pricedb: true } });
    expect(await pdb.item('5021;6')).toBeNull();
    expect(deps.http.calls).toHaveLength(1);

    const restarted = makeDeps(route, { repo: deps.repo });
    const again = createPriceDb(restarted);
    expect(await again.item('5021;6')).not.toBeNull();
    expect(again.health()[0]!.state).toBe('idle');
  });

  it('counts unreadable records', async () => {
    const deps = makeDeps(itemRoute({ '5021;6': { sku: '5021;6', buy: 'nope' } }));
    const pdb = createPriceDb(deps);
    expect(await pdb.item('5021;6')).toBeNull();
    expect(pdb.health()[0]!.detail).toContain('1 unreadable');
  });
});

describe('PriceDb.bulk', () => {
  it('posts chunks of 100 and maps results back by sku', async () => {
    const bodies: string[][] = [];
    const deps = makeDeps((url, opts) => {
      expect(url).toBe(`${API}/items-bulk`);
      const skus = (opts.json as { skus: string[] }).skus;
      bodies.push(skus);
      // Out of order, one unknown dropped by the server, one extra the client never asked for.
      return res([...skus.filter((s) => !s.startsWith('7;')).reverse().map((s) => rec(s)), rec('424242;6')]);
    });
    const skus = Array.from({ length: 250 }, (_, i) => `${i + 1};6`);
    const rows = await createPriceDb(deps).bulk(skus);
    expect(bodies.map((b) => b.length)).toEqual([BULK_CHUNK, BULK_CHUNK, 50]);
    expect(deps.http.calls.every((c) => c.opts.method === 'POST' && c.opts.budget === 'pricedb')).toBe(true);
    expect(rows).toHaveLength(249);
    expect(rows.some((r) => r.sku === '7;6' || r.sku === '424242;6')).toBe(false);
    expect(deps.repo.pricedbCount()).toBe(249);
  });

  it('maps the captured /items-bulk response (bare array, any order)', async () => {
    const requested = ['5021;6', '5002;6', '378;6', '30177;5;u13', '205;11;australium', '200;6;uncraftable', '999999;6', '161;6', '160;3', '1071;11'];
    const deps = makeDeps(() => res(fixture('items-bulk.json')));
    const rows = await createPriceDb(deps).bulk(requested);
    expect(rows.map((r) => r.sku).sort()).toEqual(['1071;11', '160;3', '161;6', '205;11;australium', '30177;5;u13', '378;6', '5002;6', '5021;6'].sort());
    expect(rows.find((r) => r.sku === '30177;5;u13')).toMatchObject({ buyKeys: 515, buyScrap: 0, sellKeys: 592, sellScrap: 144 });
  });

  it('queries the cached alias and maps differently ordered answers', async () => {
    const deps = makeDeps((_, opts) => {
      const skus = (opts.json as { skus: string[] }).skus;
      return res(skus.map((s) => (s === '1;6;uncraftable;n4' ? rec('1;6;n4;uncraftable') : rec(s))));
    });
    deps.repo.setSkuAlias('15000;15;w1;pk14', '15000;15;pk14;w1');
    const rows = await createPriceDb(deps).bulk(['15000;15;w1;pk14', '1;6;n4;uncraftable', '1;6;n4;uncraftable']);
    expect((deps.http.calls[0]!.opts.json as { skus: string[] }).skus).toEqual(['15000;15;pk14;w1', '1;6;uncraftable;n4']);
    expect(rows.map((r) => r.sku).sort()).toEqual(['1;6;n4;uncraftable', '15000;15;w1;pk14'].sort());
  });

  it('stops at the first failed chunk and keeps what it got', async () => {
    let n = 0;
    const deps = makeDeps((_, opts) => {
      n++;
      if (n === 2) return res({ error: 'Too many' }, { status: 429 });
      return res((opts.json as { skus: string[] }).skus.map((s) => rec(s)));
    });
    const pdb = createPriceDb(deps);
    const rows = await pdb.bulk(Array.from({ length: 300 }, (_, i) => `${i + 1};6`));
    expect(rows).toHaveLength(100);
    expect(deps.http.calls).toHaveLength(2);
    expect(pdb.health()[0]).toMatchObject({ state: 'backoff', lastError: 'HTTP 429' });
  });

  it('0.7.4 (F52): shows backoff, not error, for a 502, 504 or Cloudflare 522; a 400 is still an error', async () => {
    for (const [status, state] of [
      [502, 'backoff'],
      [504, 'backoff'],
      [522, 'backoff'],
      [400, 'error'],
    ] as const) {
      const deps = makeDeps(() => res({ error: 'upstream' }, { status }));
      const pdb = createPriceDb(deps);
      await pdb.bulk(['161;6']).catch(() => undefined);
      expect(pdb.health()[0]).toMatchObject({ state, lastError: `HTTP ${status}` });
    }
  });
});

describe('PriceDb.loadAll', () => {
  const autob = fixture<{ items: Rec[] }>('autob-items.json');

  it('stores the full list by canonical SKU, newest wins, skipping quality 255', async () => {
    const clock = new FakeClock();
    const deps = makeDeps(() => res(autob), { clock });
    const pdb = createPriceDb(deps);
    const n = await pdb.loadAll();

    const expected = new Map<string, Rec>();
    for (const r of autob.items) {
      if (fromString(r.sku).quality === 255) continue;
      const c = canonical(r.sku);
      const prev = expected.get(c);
      if (!prev || r.time > prev.time) expected.set(c, r);
    }
    expect(n).toBe(expected.size);
    expect(deps.repo.pricedbCount()).toBe(expected.size);
    expect(deps.repo.getPricedb('6522;255;td-25000')).toBeNull();
    expect(Number(deps.repo.getMeta(META_LOAD_ALL_AT))).toBe(clock.now());

    // PriceDB lists both 15000;15;pk14;w1 and 15000;15;w1;pk14: the newer record is kept and its form aliased.
    const nightOwl = expected.get('15000;15;w1;pk14')!;
    expect(deps.repo.getPricedb('15000;15;w1;pk14')?.time).toBe(nightOwl.time);
    const alias = deps.repo.getSkuAlias('15000;15;w1;pk14');
    expect(alias === null ? '15000;15;w1;pk14' : alias).toBe(nightOwl.sku);
    expect(deps.http.calls[0]).toMatchObject({ url: `${API}/autob/items`, opts: { priority: 'background', budget: 'pricedb' } });
  });

  it('skips the download for 4 hours and shares a running load', async () => {
    const clock = new FakeClock();
    const deps = makeDeps(() => res(autob), { clock });
    const pdb = createPriceDb(deps);
    const [a, b] = await Promise.all([pdb.loadAll(), pdb.loadAll()]);
    expect(a).toBe(b);
    expect(deps.http.calls).toHaveLength(1);
    // 0.7.3: the skip ends LOAD_ALL_SLACK_MS before 4 h, so a 4 h job run always loads.
    clock.advance(LOAD_ALL_MIN_INTERVAL_MS - LOAD_ALL_SLACK_MS - 1);
    expect(await pdb.loadAll()).toBe(0);
    expect(deps.http.calls).toHaveLength(1);
    clock.advance(1);
    expect(await pdb.loadAll()).toBeGreaterThan(0);
    expect(deps.http.calls).toHaveLength(2);
  });

  it('returns 0 on failure or an unexpected shape', async () => {
    const pdb = createPriceDb(makeDeps(() => res({ success: false, message: 'nope' })));
    expect(await pdb.loadAll()).toBe(0);
    expect(pdb.health()[0]!.lastError).toContain('unexpected shape');
    expect(await createPriceDb(makeDeps(() => res(null, { status: 503 }))).loadAll()).toBe(0);
  });
});

describe('PriceDb.history and keyQuote', () => {
  const keyHist = fixture<Rec[]>('item-history-key.json');
  const ausHist = fixture<Rec[]>('item-history-australium.json');

  function historyRoute(map: Record<string, unknown>) {
    return (url: string): HttpResponse => {
      const m = /\/item-history\/([^?]+)/.exec(url);
      const sku = m ? decodeURIComponent(m[1]!) : '';
      return sku in map ? res(map[sku]) : res({ error: 'Item not found' }, { status: 404 });
    };
  }

  it('returns metal-only history in scrap', async () => {
    const deps = makeDeps(historyRoute({ '5021;6': keyHist }));
    const pts = await createPriceDb(deps).history('5021;6', 1_700_000_000, 1_800_000_000);
    expect(pts).toHaveLength(keyHist.length);
    expect(pts[0]).toEqual({ t: keyHist[0]!.time, buyScrap: refToScrap(keyHist[0]!.buy.metal), sellScrap: refToScrap(keyHist[0]!.sell.metal) });
    expect(pts.every((p, i) => i === 0 || p.t > pts[i - 1]!.t)).toBe(true);
    expect(deps.http.calls[0]!.opts.query).toEqual({ start: 1_700_000_000, end: 1_800_000_000 });
  });

  it('values keys with the key price at that time', async () => {
    const deps = makeDeps(historyRoute({ '5021;6': keyHist, '205;11;australium': ausHist }));
    const pts = await createPriceDb(deps).history('205;11;australium');
    expect(pts).toHaveLength(ausHist.length);
    const keyAt = (t: number): Rec => [...keyHist].reverse().find((k) => k.time <= t) ?? keyHist[0]!;
    for (const [i, r] of ausHist.entries()) {
      const k = keyAt(r.time);
      expect(pts[i]).toEqual({
        t: r.time,
        buyScrap: Math.round(r.buy.keys * refToScrap(k.buy.metal)) + refToScrap(r.buy.metal),
        sellScrap: Math.round(r.sell.keys * refToScrap(k.sell.metal)) + refToScrap(r.sell.metal),
      });
    }
  });

  it('falls back to the latest stored key price, then to null', async () => {
    const deps = makeDeps(historyRoute({ '205;11;australium': ausHist.slice(0, 2) }));
    const pdb = createPriceDb(deps);
    const noKey = await pdb.history('205;11;australium');
    expect(noKey[0]).toMatchObject({ buyScrap: null, sellScrap: null });

    deps.repo.upsertPricedb([{ sku: '5021;6', name: 'Key', buyKeys: 0, buyScrap: 568, sellKeys: 0, sellScrap: 580, time: 1, fetchedAt: T0 }]);
    const withKey = await createPriceDb(deps).history('205;11;australium');
    const r = ausHist[0]!;
    expect(withKey[0]).toEqual({
      t: r.time,
      buyScrap: Math.round(r.buy.keys * 568) + refToScrap(r.buy.metal),
      sellScrap: Math.round(r.sell.keys * 580) + refToScrap(r.sell.metal),
    });
  });

  it('returns [] for unknown items', async () => {
    expect(await createPriceDb(makeDeps(historyRoute({}))).history('999999;6')).toEqual([]);
  });

  it('builds the key quote from 5021;6 and stores it', async () => {
    const deps = makeDeps(itemRoute({ '5021;6': fixture('item-key.json') }));
    const q = await createPriceDb(deps).keyQuote();
    // 0.7.4 (F71): PriceDB's price time is also the quote's priceAt.
    expect(q).toEqual({ source: 'pricedb', buyScrap: 569, sellScrap: 581, observedAt: 1791968059 * 1000, priceAt: 1791968059 * 1000 });
    expect(deps.repo.keyQuotes()).toEqual([q]);
    expect(deps.http.calls[0]!.opts.priority).toBe('background');
  });

  it('rejects a nonsensical key price', async () => {
    const deps = makeDeps(itemRoute({ '5021;6': rec('5021;6', 0, 0, 1, 1) }));
    expect(await createPriceDb(deps).keyQuote()).toBeNull();
    expect(deps.repo.keyQuotes()).toEqual([]);
  });
});

describe('RateLimit-Remaining', () => {
  it('pauses requests while fewer than 36 remain', async () => {
    const clock = new FakeClock();
    const timers = new FakeTimers(clock);
    let remaining = 40;
    const deps = makeDeps(
      itemRoute({}, (url) =>
        url.includes('/item/')
          ? res(rec('5021;6'), { headers: { 'ratelimit-remaining': String(remaining--), 'ratelimit-reset': '30', 'ratelimit-policy': '360;w=60' } })
          : null,
      ),
      { clock },
    );
    const pdb = createPriceDb(deps, { timers });
    remaining = 35;
    await pdb.item('5021;6');
    expect(pdb.health()[0]).toMatchObject({ state: 'paused' });
    expect(pdb.health()[0]!.detail).toContain('RateLimit-Remaining 35');

    let done = false;
    const second = pdb.item('378;6').then(() => (done = true));
    await flush();
    expect(deps.http.calls).toHaveLength(1);
    expect(done).toBe(false);
    await timers.advance(29_000);
    expect(deps.http.calls).toHaveLength(1);
    remaining = 300;
    await timers.advance(1_000);
    await second;
    expect(deps.http.calls).toHaveLength(2);
    expect(pdb.health()[0]!.state).toBe('idle');
  });
});
