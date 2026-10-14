import { describe, expect, it } from 'vitest';
import {
  META_SCHEMA_CHECKED_AT,
  META_SCHEMA_EXTRAS,
  SCHEMA_MAX_AGE_MS,
  SchemaFormatError,
  buildSchemaSnapshot,
  createSchemaService,
} from '../../src/service/connectors/schema';
import { parseExtras } from '../../src/service/connectors/schemaNames';
import { openRepo } from '../../src/service/db';
import { HostBlockedError, NetworkPausedError } from '../../src/service/net';
import { FakeClock, PAINT_URL, SCHEMA_URL, fixture, makeDeps, res, schemaRoute } from './helpers';

const NOW = Date.UTC(2026, 9, 14, 12);

function build(paintList: unknown = fixture('paint-list.json')) {
  return buildSchemaSnapshot(fixture('schema-subset.json'), paintList, NOW, 'W/"x"');
}

describe('buildSchemaSnapshot', () => {
  it('derives items, effects, paintkits and paints from the schema subset', () => {
    const { snapshot, stats } = build();
    expect(stats.items).toBe(301);
    expect(stats.skippedItems).toBe(0);
    expect(snapshot.items).toHaveLength(301);
    expect(snapshot.paintkits).toHaveLength(250);
    expect(snapshot.paints).toHaveLength(30);
    // 671 particles minus 22 hidden (Attrib_Particle placeholders incl. killstreak eyes 2001-2008).
    expect(stats.hiddenEffects).toBe(22);
    expect(snapshot.effects).toHaveLength(649);
    expect(snapshot.fetchedAt).toBe(NOW);
    expect(snapshot.etag).toBe('W/"x"');
  });

  it('maps schema items to SchemaItemRow', () => {
    const { snapshot } = build();
    const tc = snapshot.items.find((i) => i.defindex === 378)!;
    expect(tc).toMatchObject({
      name: 'The Team Captain',
      itemName: 'Team Captain',
      properName: true,
      itemClass: 'tf_wearable',
      slot: 'misc',
      craftClass: 'hat',
    });
    expect(tc.imageUrl).toMatch(/^https:\/\/media\.steampowered\.com\//);
    const rl = snapshot.items.find((i) => i.defindex === 205)!;
    expect(rl.name).toBe('Upgradeable TF_WEAPON_ROCKETLAUNCHER');
    expect(rl.craftClass).toBeNull(); // '' in the schema
    expect(rl.usedByClasses).toEqual(['Soldier']);
  });

  it('canonicalises RED/BLU effect twins to the lower id and types effects by id range', () => {
    const { snapshot } = build();
    const byId = new Map(snapshot.effects.map((e) => [e.id, e]));
    for (const [lo, hi, name] of [
      [360, 361, 'Searing Stove'],
      [365, 366, 'Crystal Crown'],
      [193, 194, 'Restless Wraiths'],
      [3001, 3002, 'Showstopper'],
    ] as const) {
      expect(byId.get(lo)).toMatchObject({ name, canonicalId: lo });
      expect(byId.get(hi)).toMatchObject({ name, canonicalId: lo });
    }
    expect(byId.get(13)).toMatchObject({ name: 'Burning Flames', canonicalId: 13, type: 'cosmetic' });
    expect(byId.get(701)).toMatchObject({ name: 'Hot', type: 'weapon' });
    expect(byId.get(3010)).toMatchObject({ name: 'Mega Strike', type: 'taunt' });
    for (const hidden of [55, 140, 406, 2001, 2008, 22001]) expect(byId.has(hidden)).toBe(false);
  });

  it('adds BLU hexes for team paints from the paint can tints', () => {
    const { snapshot } = build();
    const byDec = new Map(snapshot.paints.map((p) => [p.decimal, p]));
    expect(byDec.get(12073019)).toEqual({ decimal: 12073019, hex: '#B8383B', name: 'Team Spirit', bluHex: '#5885A2' });
    expect(byDec.get(4732984)?.bluHex).toBe('#384248');
    expect(byDec.get(6637376)?.bluHex).toBe('#28394D');
    expect(byDec.get(16738740)).toEqual({ decimal: 16738740, hex: '#FF69B4', name: 'Pink as Hell', bluHex: null });
    expect(byDec.get(5801378)?.name).toBe('Legacy Paint');
  });

  it('derives paints from the schema when the paint list is unavailable', () => {
    const { snapshot } = build(null);
    expect(snapshot.paints).toHaveLength(30);
    const ts = snapshot.paints.find((p) => p.name === 'Team Spirit');
    expect(ts).toEqual({ decimal: 12073019, hex: '#B8383B', name: 'Team Spirit', bluHex: '#5885A2' });
    expect(snapshot.paints.some((p) => p.name === 'Legacy Paint')).toBe(true);
  });

  it('collects extras: default qualities, crate series, skin paintkits', () => {
    const { extras } = build();
    expect(extras.itemQuality['266']).toBe(5);
    expect(extras.itemQuality['18']).toBe(0);
    expect(extras.itemQuality['655']).toBe(11);
    expect(extras.itemQuality['378']).toBeUndefined();
    expect(extras.crateSeries['5078']).toBe(46);
    expect(extras.crateSeriesAttr).toContain(5022);
    expect(extras.skinPaintkit['15000']).toBe(14);
    expect(extras.skinPaintkit['16105']).toBe(105);
    const roundTrip = parseExtras(JSON.stringify(extras));
    expect(roundTrip).toEqual(extras);
  });

  it('skips malformed entries and rejects payloads that are not a schema', () => {
    const raw = structuredClone(fixture<{ raw: { schema: { items: unknown[]; attribute_controlled_attached_particles: unknown[] } } }>('schema-subset.json'));
    raw.raw.schema.items.push({ defindex: 'nope' }, null, 42);
    raw.raw.schema.attribute_controlled_attached_particles.push({ id: -1, name: 'Bad' });
    const r = buildSchemaSnapshot(raw, null, NOW, null);
    expect(r.stats.skippedItems).toBe(3);
    expect(r.snapshot.items).toHaveLength(301);
    expect(() => buildSchemaSnapshot({ foo: 1 }, null, NOW, null)).toThrow(SchemaFormatError);
    expect(() => buildSchemaSnapshot({ raw: { schema: { items: [] } } }, null, NOW, null)).toThrow(SchemaFormatError);
  });
});

describe('SchemaService lifecycle', () => {
  it('downloads the schema on an empty database and persists it', async () => {
    const deps = makeDeps(schemaRoute());
    const svc = createSchemaService(deps);
    expect(svc.isLoaded()).toBe(false);
    expect(svc.health().state).toBe('off');
    await svc.init();

    expect(svc.isLoaded()).toBe(true);
    expect(deps.http.urls()).toEqual([SCHEMA_URL, PAINT_URL]);
    expect(deps.http.calls[0]!.opts).toMatchObject({ budget: 'sku', ifNoneMatch: null });
    const info = deps.repo.schemaInfo();
    expect(info).toMatchObject({ items: 301, effects: 649, paintkits: 250, etag: 'W/"subset-1"' });
    expect(parseExtras(deps.repo.getMeta(META_SCHEMA_EXTRAS))).not.toBeNull();
    const h = svc.health();
    expect(h).toMatchObject({ id: 'schema', state: 'idle', lastError: null });
    expect(h.detail).toContain('301 items');
  });

  it('loads from the database without a request while the copy is fresh', async () => {
    const clock = new FakeClock();
    const repo = openRepo(':memory:');
    await createSchemaService(makeDeps(schemaRoute(), { repo, clock })).init();

    clock.advance(60 * 60 * 1000);
    const deps = makeDeps(schemaRoute(), { repo, clock });
    const svc = createSchemaService(deps);
    await svc.init();
    expect(deps.http.calls).toHaveLength(0);
    expect(svc.isLoaded()).toBe(true);
    expect(svc.nameForSku('30177;5;u13')).toBe('Burning Flames Hong Kong Cone');
    expect(svc.effectName(13)).toBe('Burning Flames');
    expect(svc.paintkits()).toHaveLength(250);
  });

  it('revalidates with If-None-Match after 24 h and keeps the data on 304', async () => {
    const clock = new FakeClock();
    const repo = openRepo(':memory:');
    await createSchemaService(makeDeps(schemaRoute(), { repo, clock })).init();
    const fetchedAt = repo.schemaInfo().loadedAt;

    clock.advance(SCHEMA_MAX_AGE_MS + 1);
    const deps = makeDeps(schemaRoute(), { repo, clock });
    const svc = createSchemaService(deps);
    await svc.init();
    await svc.refresh(); // the revalidation runs in the background once a cached copy is usable
    expect(deps.http.urls()).toEqual([SCHEMA_URL]);
    expect(deps.http.calls[0]!.opts.ifNoneMatch).toBe('W/"subset-1"');
    expect(repo.schemaInfo().loadedAt).toBe(fetchedAt);
    expect(Number(repo.getMeta(META_SCHEMA_CHECKED_AT))).toBe(clock.now());
    expect(svc.health().state).toBe('idle');

    // The 304 counts as a check: no request for another day.
    clock.advance(60 * 60 * 1000);
    const deps2 = makeDeps(schemaRoute(), { repo, clock });
    await createSchemaService(deps2).init();
    expect(deps2.http.calls).toHaveLength(0);
  });

  it('refetches without a validator when the stored extras are missing', async () => {
    const repo = openRepo(':memory:');
    await createSchemaService(makeDeps(schemaRoute(), { repo })).init();
    repo.setMeta(META_SCHEMA_EXTRAS, '');
    const deps = makeDeps(schemaRoute(), { repo });
    const svc = createSchemaService(deps);
    await svc.init();
    await svc.refresh();
    expect(deps.http.calls[0]!.opts.ifNoneMatch).toBeNull();
    expect(parseExtras(repo.getMeta(META_SCHEMA_EXTRAS))).not.toBeNull();
  });

  it('reports errors and keeps cached data usable', async () => {
    const repo = openRepo(':memory:');
    const clock = new FakeClock();
    await createSchemaService(makeDeps(schemaRoute(), { repo, clock })).init();
    clock.advance(SCHEMA_MAX_AGE_MS + 1);

    const deps = makeDeps(() => res({ error: 'boom' }, { status: 500 }), { repo, clock });
    const svc = createSchemaService(deps);
    await svc.init();
    await svc.refresh();
    expect(svc.isLoaded()).toBe(true);
    const h = svc.health();
    expect(h.state).toBe('idle');
    expect(h.lastError).toBe('HTTP 500');
    expect(h.detail).toContain('cached copy');
    expect(svc.nameForSku('378;6')).toBe('The Team Captain');
  });

  it('maps network errors to health states', async () => {
    const cases: [unknown, string][] = [
      [new NetworkPausedError(), 'paused'],
      [new HostBlockedError('sku.pricedb.io', 'challenge page'), 'blocked'],
      [new Error('ECONNRESET'), 'error'],
    ];
    for (const [err, state] of cases) {
      const svc = createSchemaService(
        makeDeps(() => {
          throw err;
        }),
      );
      await expect(svc.init()).resolves.toBeUndefined();
      expect(svc.isLoaded()).toBe(false);
      expect(svc.health().state).toBe(state);
      if (state === 'blocked') expect(svc.health().disabledReason).toBe('challenge page');
    }
  });

  for (const [status, body] of [
    [403, { error: 'Forbidden' }],
    [401, { error: 'Unauthorized' }],
  ] as const) {
    it(`stops asking sku.pricedb.io after HTTP ${status} with a JSON body`, async () => {
      const repo = openRepo(':memory:');
      const clock = new FakeClock();
      await createSchemaService(makeDeps(schemaRoute(), { repo, clock })).init();
      clock.advance(SCHEMA_MAX_AGE_MS + 1);

      const deps = makeDeps(() => res(body, { status }), { repo, clock });
      const svc = createSchemaService(deps);
      await svc.init();
      await svc.refresh();
      expect(deps.http.calls).toHaveLength(1);
      const h = svc.health();
      expect(h.state).toBe('blocked');
      expect(h.disabledReason).toMatch(new RegExp(`refused the schema request \\(HTTP ${status}\\)`));
      expect(svc.isLoaded()).toBe(true);

      // The scheduler's retries (and a forced refresh) send nothing more.
      clock.advance(SCHEMA_MAX_AGE_MS + 1);
      await svc.refresh();
      await svc.refresh(true);
      expect(deps.http.calls).toHaveLength(1);
      expect(svc.health().state).toBe('blocked');
    });
  }

  it('rejects a payload that is not a schema without replacing the cache', async () => {
    const repo = openRepo(':memory:');
    await createSchemaService(makeDeps(schemaRoute(), { repo })).init();
    const deps = makeDeps((url) => (url === SCHEMA_URL ? res({ hello: 'world' }) : res(fixture('paint-list.json'))), { repo });
    const svc = createSchemaService(deps);
    await svc.init();
    await svc.refresh(true);
    expect(repo.schemaInfo().items).toBe(301);
    expect(svc.health().lastError).toContain('unexpected shape');
  });

  it('is usable from the cache before a due refresh finishes', async () => {
    const repo = openRepo(':memory:');
    const clock = new FakeClock();
    await createSchemaService(makeDeps(schemaRoute(), { repo, clock })).init();
    clock.advance(SCHEMA_MAX_AGE_MS + 1);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const route = schemaRoute();
    const deps = makeDeps(
      async (url, opts) => {
        await gate;
        return route(url, opts);
      },
      { repo, clock },
    );
    const svc = createSchemaService(deps);
    await svc.init();
    expect(svc.nameForSku('378;6')).toBe('The Team Captain');
    expect(svc.health().state).toBe('connecting');
    release();
    await svc.refresh();
    expect(svc.health().state).toBe('idle');
  });

  it('runs one refresh at a time', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const route = schemaRoute();
    const deps = makeDeps(async (url, opts) => {
      if (url === SCHEMA_URL) await gate;
      return route(url, opts);
    });
    const svc = createSchemaService(deps);
    const a = svc.refresh(true);
    const b = svc.refresh(true);
    expect(svc.health().state).toBe('connecting');
    release();
    await Promise.all([a, b]);
    expect(deps.http.urls().filter((u) => u === SCHEMA_URL)).toHaveLength(1);
  });
});
