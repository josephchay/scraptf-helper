import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  bptfBuyListingId,
  communityRowsFromPrices,
  createMapStats,
  listingFromSnapshot,
  listingFromWsPayload,
  mapWsPayload,
  parseIGetCurrencies,
  parseIGetPrices,
} from '../../src/service/connectors/bptfItem';
import { baseSku, canonical } from '../../src/shared/sku';
import type { Listing } from '../../src/shared/types';
import { createStubSchema, loadFixture, type WsEvent, type WsSample } from './helpers';

const NOW = Date.UTC(2026, 9, 14, 9, 12, 5);
const schema = createStubSchema();
const sample = loadFixture<WsSample>('ws-sample.json');
const updates = sample.events.filter((e) => e.event === 'listing-update');

function byName(name: string, events: WsEvent[] = updates): WsEvent {
  const e = events.find((x) => x.payload.item.name === name);
  if (!e) throw new Error(`fixture has no listing-update for "${name}"`);
  return e;
}

function synthetic(idPart: string): WsEvent {
  const e = sample.synthetic.find((x) => x.payload.id.includes(idPart));
  if (!e) throw new Error(`no synthetic event ${idPart}`);
  return e;
}

function map(e: WsEvent): Listing {
  const r = listingFromWsPayload(e.payload, schema, NOW);
  if (!r) throw new Error(`mapping failed for ${e.payload.item.name}`);
  return r.listing;
}

describe('websocket fixture sweep', () => {
  const stats = createMapStats();
  const results = updates.map((e) => ({ e, r: mapWsPayload(e.payload, schema, NOW, stats) }));
  const ok = results.flatMap(({ e, r }) => (r.ok ? [{ e, listing: r.listing, name: r.name }] : []));

  it('maps every real listing-update without throwing or rejecting', () => {
    expect(updates.length).toBeGreaterThan(200);
    expect(results.filter((x) => !x.r.ok).map((x) => x.e.payload.item.name)).toEqual([]);
    expect(stats.invalid).toBe(0);
    expect(stats.unknownShapes).toEqual({});
  });

  it('agrees with every priceindex bp.tf sent', () => {
    expect(stats.priceindexChecked).toBeGreaterThan(60);
    expect(stats.priceindexMismatches).toBe(0);
  });

  it('keeps buy and sell intents and the listing ids', () => {
    const buys = ok.filter((x) => x.listing.intent === 'buy').length;
    const sells = ok.filter((x) => x.listing.intent === 'sell').length;
    expect(buys).toBe(updates.filter((e) => e.payload.intent === 'buy').length);
    expect(sells).toBe(updates.filter((e) => e.payload.intent === 'sell').length);
    for (const { e, listing } of ok) expect(listing.id).toBe(e.payload.id);
  });

  it('produces canonical SKUs and never puts paint in the base SKU', () => {
    for (const { listing } of ok) {
      expect(canonical(listing.sku)).toBe(listing.sku);
      expect(listing.baseSku).toBe(baseSku(listing.sku));
      expect(listing.baseSku).not.toMatch(/;p\d+/);
      if (listing.special.paint !== null) expect(listing.sku).toBe(`${listing.baseSku};p${listing.special.paint}`);
      else expect(listing.sku).toBe(listing.baseSku);
    }
  });

  it('gives every specific unusual an effect (only "Unusual X" any-effect orders lack one)', () => {
    const unusual = ok.filter(({ e }) => (e.payload.item['quality'] as { id: number }).id === 5);
    expect(unusual.length).toBeGreaterThan(30);
    for (const { e, listing } of unusual) {
      if (/^Unusual /.test(e.payload.item.name)) expect(listing.sku).not.toMatch(/;u\d+/);
      else expect(listing.sku).toMatch(/;u\d+/);
    }
    expect(unusual.some(({ e }) => /^Unusual /.test(e.payload.item.name))).toBe(true);
  });

  it('gives every skin or war paint a wear and a paintkit', () => {
    const skins = ok.filter(({ e }) => e.payload.item['texture']);
    expect(skins.length).toBeGreaterThan(3);
    for (const { listing } of skins) expect(listing.sku).toMatch(/;w[1-5];pk\d+/);
  });

  it('marks non-craftable items whose payload omits `craftable`', () => {
    const nc = ok.filter(({ e }) => e.payload.item['craftable'] === undefined);
    expect(nc.length).toBeGreaterThan(10);
    for (const { e, listing } of nc) {
      expect(e.payload.item.name.startsWith('Non-Craftable')).toBe(true);
      expect(listing.sku).toContain(';uncraftable');
    }
    for (const { e, listing } of ok) if (e.payload.item['craftable'] === true) expect(listing.sku).not.toContain('uncraftable');
  });

  it('derives bot, marketplace, user and money fields', () => {
    for (const { e, listing } of ok) {
      expect(listing.isBot).toBe(!!e.payload['userAgent']);
      expect(listing.isMarketplace).toBe(false);
      expect(listing.origin).toBe('ws');
      expect(listing.lastEventAt).toBe(NOW);
      expect(Number.isInteger(listing.metalScrap)).toBe(true);
      expect(listing.listedAt).toBeLessThan(2e9);
      const cur = e.payload['currencies'] as { keys?: number; metal?: number };
      expect(listing.keys).toBe(cur.keys ?? 0);
      expect(listing.metalScrap).toBe(Math.round((cur.metal ?? 0) * 9));
    }
    expect(ok.some((x) => !x.listing.isBot)).toBe(true);
  });

  it('never copies a trade offer URL or token into a listing', () => {
    const withUrl = updates.map((e) => ({
      ...e.payload,
      user: { ...(e.payload['user'] as object), tradeOfferUrl: 'https://steamcommunity.com/tradeoffer/new/?partner=1&token=SECRETTOKEN' },
    }));
    for (const p of withUrl) {
      const r = listingFromWsPayload(p, schema, NOW);
      expect(JSON.stringify(r)).not.toContain('SECRETTOKEN');
      expect(JSON.stringify(r)).not.toContain('tradeoffer');
    }
  });

  it('learns bp.tf names keyed by base SKU', () => {
    for (const { e, listing, name } of ok) {
      expect(name.sku).toBe(listing.baseSku);
      expect(name.name).toBe(e.payload.item.name);
      expect(name.lastSeen).toBe(NOW);
    }
  });

  it('matches the md5 buy-order id rule on every buy', () => {
    for (const { e } of ok.filter((x) => x.listing.intent === 'buy')) {
      expect(e.payload.id).toBe(bptfBuyListingId(String(e.payload['steamid']), e.payload.item.name));
    }
    expect(bptfBuyListingId('7656', 'Team Captain')).toBe(`440_7656_${createHash('md5').update('Team Captain').digest('hex')}`);
  });

  it('accepts delete payloads as listing updates too (they carry full listings)', () => {
    const deletes = sample.events.filter((e) => e.event === 'listing-delete');
    expect(deletes.length).toBeGreaterThan(10);
    for (const e of deletes) expect(listingFromWsPayload(e.payload, schema, NOW)).not.toBeNull();
  });
});

describe('websocket golden cases', () => {
  const cases: [string, string][] = [
    ['Strange Killstreak Pistol', '209;11;kt-1'],
    ["Cloudy Moon Tyrant's Helm", '99;5;u38'],
    ['Strange Specialized Killstreak Australium Eyelander', '132;11;australium;kt-2'],
    ['Strange Festivized Specialized Killstreak Rocket Launcher', '205;11;kt-2;festive'],
    ['Non-Craftable Professional Killstreak Scattergun Kit', '6526;6;uncraftable;kt-3;td-200'],
    ['Pyroland Weapons Case #99', '5831;6;c99'],
    ["Strange Collector's Professional Killstreak Widowmaker", '527;14;strange;kt-3'],
    ['Strange Business Class War Paint (Factory New)', '17415;11;w1;pk415'],
    ['Non-Craftable The Festivized Spy-Cicle', '649;6;uncraftable;festive'],
    ['Mysterious Mixture Taunt: Second Rate Sorcery', '30816;5;u3092'],
    ['Unusual Taunt: Conga', '1118;5'],
    ['Strange Bacon Grease', '5633;6'],
    ['Strange Part: Scouts Killed', '6003;6'],
    ['The Birdie Bonnet', '30215;6'],
  ];
  for (const [name, sku] of cases) {
    it(`${name} -> ${sku}`, () => {
      const l = map(byName(name));
      expect(l.sku).toBe(sku);
      expect(l.baseSku).toBe(sku);
    });
  }

  it('the paint can itself carries no paint token', () => {
    const l = map(byName('Non-Craftable A Color Similar to Slate'));
    expect(l.sku).toBe('5052;6;uncraftable');
    expect(l.special.paint).toBeNull();
  });

  it('painted items keep paint out of the base SKU', () => {
    const clown = map(byName("Strange Clown's Cover-Up"));
    expect(clown.sku).toBe('31386;11;p15308410');
    expect(clown.baseSku).toBe('31386;11');
    expect(clown.special.paint).toBe(15308410);
    const disco = map(byName('Disco Beat Down Throttlehead'));
    expect(disco.sku).toBe('31282;5;u62;p8208497');
    expect(disco.baseSku).toBe('31282;5;u62');
  });

  it('kit fabricators take the tier from the name when killstreakTier is missing', () => {
    const fab = map(byName('Professional Killstreak Maul Kit Fabricator', sample.events));
    expect(fab.sku).toBe('20003;6;kt-3;td-466;od-6526;oq-6');
    expect(fab.special.sheen).toBe(7);
    expect(fab.special.killstreaker).toBe(2008);
    const splendid = map(byName('Professional Killstreak Splendid Screen Kit Fabricator', sample.events));
    expect(splendid.sku).toBe('20003;6;kt-3;td-406;od-6526;oq-6');
  });

  it('spells, strange parts, sheen, killstreaker and custom names are special attributes', () => {
    const brass = map(byName("Collector's Professional Killstreak Brass Beast"));
    expect(brass.special.spells).toEqual(['Exorcism']);
    expect(brass.sku).not.toContain('spell');
    const huntsman = map(byName('Strange Festivized Professional Killstreak Huntsman'));
    expect(huntsman.special.parts).toEqual(['Headshot Kills', 'Revenges', 'Taunt Kills']);
    expect(huntsman.special.sheen).toBe(4);
    expect(huntsman.special.killstreaker).toBe(2002);
    expect(huntsman.sku).toBe('56;11;kt-3;festive');
    const awper = map(byName('Genuine Specialized Killstreak AWPer Hand'));
    expect(awper.special.customName).toBe(true);
    expect(awper.special.customDesc).toBe(false);
    expect(awper.sku).toBe('851;1;kt-2');
  });

  it('copies user, agent and timing fields', () => {
    const e = byName("Cloudy Moon Tyrant's Helm");
    const l = map(e);
    const ua = e.payload['userAgent'] as { client: string; lastPulse: number } | undefined;
    expect(l.isBot).toBe(!!ua);
    expect(l.uaClient).toBe(ua?.client ?? null);
    expect(l.uaLastPulse).toBe(ua?.lastPulse ?? null);
    expect(l.userName).toBe((e.payload['user'] as { name: string }).name);
    expect(l.userOnline).toBe(true);
    expect(l.userBanned).toBe(false);
    expect(l.listedAt).toBe(e.payload['listedAt']);
    expect(l.bumpedAt).toBe(e.payload['bumpedAt']);
    expect(l.itemName).toBe("Cloudy Moon Tyrant's Helm");
    expect(l.marketName).toBe("Unusual Tyrant's Helm");
  });
});

describe('websocket synthetic shapes', () => {
  it('detects marketplace.tf mirrors by currencies.usd or marketplace_* fields', () => {
    expect(map(synthetic('99000000001')).isMarketplace).toBe(true);
    expect(map(synthetic('99000000002')).isMarketplace).toBe(true);
  });

  it('maps Decorated Weapon skins and unusual strange skins', () => {
    expect(map(synthetic('synthetic-skin')).sku).toBe('15000;15;w2;pk14');
    expect(map(synthetic('synthetic-unusual-skin')).sku).toBe('15000;15;u701;w1;pk14;strange;kt-3');
  });

  it('maps strange unusual and strange genuine through elevatedQuality', () => {
    expect(map(synthetic('synthetic-strange-unusual')).sku).toBe('99;5;u38;strange');
    expect(map(synthetic('synthetic-strange-genuine')).sku).toBe('30643;1;strange');
  });

  it('canonicalises the BLU id of an effect pair', () => {
    expect(map(synthetic('synthetic-effect-pair')).sku).toBe('99;5;u360');
  });

  it('accepts killstreakTier as an object', () => {
    expect(map(synthetic('synthetic-ks-object')).sku).toBe('30643;6;kt-2');
  });

  it('marks untradable items and drops other games', () => {
    expect(map(synthetic('99000000003')).sku).toContain(';untradable');
    const stats = createMapStats();
    expect(mapWsPayload(synthetic('730_').payload, schema, NOW, stats)).toMatchObject({ ok: false, reason: 'not-tf2' });
    expect(stats.skipped).toBe(1);
    expect(stats.invalid).toBe(0);
  });

  it('maps a team paint to its RED decimal', () => {
    const l = map(synthetic('synthetic-team-paint'));
    expect(l.special.paint).toBe(12073019);
    expect(l.sku).toBe('30643;6;p12073019');
    expect(l.baseSku).toBe('30643;6');
  });

  it('converts millisecond timestamps to seconds', () => {
    const e = synthetic('synthetic-ms-timestamps');
    const l = map(e);
    expect(l.listedAt).toBe(Math.floor((e.payload['listedAt'] as number) / 1000));
    expect(l.bumpedAt).toBe(Math.floor((e.payload['bumpedAt'] as number) / 1000));
  });
});

describe('websocket defensive parsing', () => {
  const base = byName("Cloudy Moon Tyrant's Helm").payload;

  it('rejects payloads without required fields', () => {
    for (const bad of [null, 42, 'x', {}, { ...base, id: undefined }, { ...base, steamid: undefined }, { ...base, intent: 'trade' }, { ...base, item: { name: 'x' } }]) {
      const stats = createMapStats();
      expect(mapWsPayload(bad, schema, NOW, stats).ok).toBe(false);
      expect(listingFromWsPayload(bad, schema, NOW)).toBeNull();
      expect(stats.invalid).toBe(1);
    }
  });

  it('counts odd sub-field shapes instead of failing', () => {
    const stats = createMapStats();
    const weird = {
      ...base,
      currencies: 'lots',
      userAgent: 7,
      item: { ...base.item, sheen: 'shiny', spells: { a: 1 }, particle: { name: 'no id' } },
    };
    const r = mapWsPayload(weird, schema, NOW, stats);
    expect(r.ok).toBe(true);
    expect(stats.unknownShapes).toMatchObject({ currencies: 1, userAgent: 1, sheen: 1, spells: 1, particle: 1 });
    if (r.ok) {
      expect(r.listing.keys).toBe(0);
      expect(r.listing.isBot).toBe(false);
      // particle unreadable, so the priceindex supplies the effect
      expect(r.listing.sku).toBe('99;5;u38');
    }
  });

  it('accepts numeric strings and banned users', () => {
    const r = listingFromWsPayload(
      {
        ...base,
        appid: '440',
        currencies: { keys: '2', metal: '10.33' },
        user: { name: 'x', banned: false, bans: [{ type: 'steamrep' }] },
        item: { ...base.item, defindex: '99', quality: '5' },
      },
      schema,
      NOW,
    );
    expect(r?.listing.keys).toBe(2);
    expect(r?.listing.metalScrap).toBe(93);
    expect(r?.listing.userBanned).toBe(true);
    expect(r?.listing.sku).toBe('99;5;u38');
  });

  it('survives a schema service that throws', () => {
    const broken = createStubSchema({ throwing: true });
    for (const e of updates.slice(0, 50)) expect(() => listingFromWsPayload(e.payload, broken, NOW)).not.toThrow();
    expect(listingFromWsPayload(byName("Cloudy Moon Tyrant's Helm").payload, broken, NOW)?.listing.sku).toBe('99;5;u38');
  });
});

// ---------------------------------------------------------------------------
// Snapshot (v1 attributes)
// ---------------------------------------------------------------------------

interface SnapshotFixture {
  responses: Record<string, { listings: unknown[] }>;
}
const snapshots = loadFixture<SnapshotFixture>('snapshot-responses.json').responses;

function snap(name: string): (Listing | null)[] {
  const resp = snapshots[name];
  if (!resp) throw new Error(`no snapshot fixture ${name}`);
  return resp.listings.map((l) => listingFromSnapshot(l, schema, NOW, name));
}

describe('snapshot attribute mapping', () => {
  it('Strange Pain Train: buys, sells, extras, marketplace and an invalid row', () => {
    const [a, b, c, d, e] = snap('Strange Pain Train');
    expect(a).toMatchObject({ sku: '154;11', baseSku: '154;11', intent: 'buy', keys: 0, metalScrap: 568, isBot: true, origin: 'snapshot' });
    expect(a?.id).toBe(bptfBuyListingId('76561198000000001', 'Strange Pain Train'));
    expect(a?.listedAt).toBe(1791950000);
    expect(a?.bumpedAt).toBe(1791958000);
    expect(a?.uaClient).toBe('TF2Autobot');
    expect(b).toMatchObject({ sku: '154;11', isBot: false, listedAt: 1791950100, metalScrap: 540 });
    expect(c?.id).toBe('440_15000000001');
    expect(c?.intent).toBe('sell');
    expect(c?.keys).toBe(1);
    expect(c?.special).toEqual({
      paint: null,
      spells: ['Exorcism'],
      parts: ['Headshot Kills', 'Revenges'],
      sheen: null,
      killstreaker: null,
      customName: true,
      customDesc: false,
    });
    expect(d?.isMarketplace).toBe(true);
    expect(d?.sku).toBe('154;11');
    expect(e).toBeNull();
  });

  it('unusual effects, paint (142/261) and spells (1004/1005)', () => {
    const [a, b, c] = snap('Burning Flames Team Captain');
    expect(a?.sku).toBe('378;5;u13');
    expect(a?.keys).toBe(60);
    expect(b?.sku).toBe('378;5;u13;p12073019');
    expect(b?.baseSku).toBe('378;5;u13');
    expect(b?.special.paint).toBe(12073019);
    expect(b?.keys).toBe(62.5);
    expect(c?.special.spells).toEqual(['Die Job', 'Team Spirit Footprints']);
    expect(c?.sku).toBe('378;5;u13');
  });

  it('kill eater 214 on a non-strange quality means elevated strange', () => {
    expect(snap('Strange Burning Flames Team Captain')[0]?.sku).toBe('378;5;u13;strange');
  });

  it('australium (2027), killstreak (2025), sheen (2014), killstreaker (2013), and name fill-in', () => {
    const [a, b, c] = snap('Strange Professional Killstreak Australium Rocket Launcher');
    expect(a?.sku).toBe('205;11;australium;kt-3');
    expect(a?.metalScrap).toBe(100);
    expect(b?.sku).toBe('205;11;australium;kt-3');
    expect(b?.special.sheen).toBe(7);
    expect(b?.special.killstreaker).toBe(2004);
    expect(c?.sku).toBe('205;11;australium;kt-3');
  });

  it('festivized (2053)', () => {
    expect(snap('Strange Festivized Rocket Launcher')[0]?.sku).toBe('205;11;festive');
  });

  it('skins: paintkit (834) and wear from 725 or the name', () => {
    const [a, b] = snap('Night Owl Sniper Rifle (Minimal Wear)');
    expect(a?.sku).toBe('15000;15;w2;pk14');
    expect(b?.sku).toBe('15000;15;w2;pk14');
  });

  it('crate series (187), target (2012) and taunt effects (2041)', () => {
    expect(snap('Mann Co. Supply Crate #82')[0]?.sku).toBe('5022;6;c82');
    expect(snap('Strangifier')[0]?.sku).toBe('6522;6;td-46');
    expect(snap('Mega Strike Taunt: The Bunnyhopper')[0]?.sku).toBe('30920;5;u3010');
  });

  it('craftability from flag_cannot_craft or the name; numeric intent', () => {
    const [a, b] = snap("Non-Craftable Bill's Hat");
    expect(a?.sku).toBe('126;6;uncraftable');
    expect(b?.sku).toBe('126;6;uncraftable');
    expect(b?.intent).toBe('buy');
  });

  it('decodes raw float bits when float_value is missing', () => {
    const l = listingFromSnapshot(
      { steamid: '76561198000000001', intent: 'buy', item: { defindex: 378, quality: 5, attributes: [{ defindex: 134, value: 1095761920 }] } },
      schema,
      NOW,
      'Burning Flames Team Captain',
    );
    expect(l?.sku).toBe('378;5;u13');
  });

  it('takes the effect from the name when a buy order has no attributes', () => {
    const l = listingFromSnapshot(
      { steamid: '76561198000000001', intent: 'buy', item: { defindex: 378, quality: 5 } },
      schema,
      NOW,
      'Burning Flames Team Captain',
    );
    expect(l?.sku).toBe('378;5;u13');
  });

  describe('recipe outputs come from the requested SKU (v1 attributes have none)', () => {
    const fabName = 'Professional Killstreak Sniper Rifle Kit Fabricator';
    const fabSku = '20003;6;kt-3;td-201;od-6526;oq-6';

    it('keeps a Kit Fabricator buy order on the same base SKU and id as the feed', () => {
      const ws = map(byName(fabName, sample.events));
      expect(ws.baseSku).toBe(fabSku);
      const withAttrs = listingFromSnapshot(
        {
          steamid: ws.steamid,
          intent: 'buy',
          item: { defindex: 20003, quality: 6, attributes: [{ defindex: 2025, float_value: 3 }, { defindex: 2012, float_value: 201 }] },
        },
        schema,
        NOW,
        fabName,
        undefined,
        fabSku,
      );
      expect(withAttrs).toMatchObject({ id: ws.id, sku: fabSku, baseSku: fabSku });
      // Buy orders often carry no attributes at all: tier from the name, target and output from the request.
      const bare = listingFromSnapshot({ steamid: ws.steamid, intent: 'buy', item: { defindex: 20003, quality: 6 } }, schema, NOW, fabName, undefined, fabSku);
      expect(bare).toMatchObject({ id: ws.id, baseSku: fabSku });
    });

    it("fills a Collector's Chemistry Set output and quality", () => {
      const l = listingFromSnapshot(
        { steamid: '76561198000000009', intent: 'buy', item: { defindex: 20007, quality: 6 } },
        schema,
        NOW,
        "Collector's Festive Wrangler Chemistry Set",
        undefined,
        '20007;6;od-1086;oq-14',
      );
      expect(l?.baseSku).toBe('20007;6;od-1086;oq-14');
    });

    it('never copies from a different item, and keeps a target the attributes give', () => {
      const other = listingFromSnapshot(
        { steamid: '76561198000000009', intent: 'buy', item: { defindex: 20002, quality: 6 } },
        schema,
        NOW,
        'Specialized Killstreak Sniper Rifle Kit Fabricator',
        undefined,
        fabSku,
      );
      expect(other?.baseSku).not.toContain('od-');
      const own = listingFromSnapshot(
        { steamid: '76561198000000009', intent: 'buy', item: { defindex: 20003, quality: 6, attributes: [{ defindex: 2012, float_value: 205 }] } },
        schema,
        NOW,
        fabName,
        undefined,
        fabSku,
      );
      expect(own?.baseSku).toBe('20003;6;kt-3;td-205;od-6526;oq-6');
      // Without a requested SKU nothing changes (older callers).
      expect(listingFromSnapshot({ steamid: '1', intent: 'buy', item: { defindex: 20003, quality: 6 } }, schema, NOW, fabName)?.baseSku).toBe('20003;6;kt-3');
    });
  });

  it('rejects junk and other appids', () => {
    for (const bad of [null, {}, { steamid: '1', intent: 'buy' }, { steamid: '1', intent: 'x', item: { defindex: 1, quality: 6 } }]) {
      expect(listingFromSnapshot(bad, schema, NOW, 'x')).toBeNull();
    }
    expect(
      listingFromSnapshot({ appid: 730, steamid: '1', intent: 'buy', item: { defindex: 1, quality: 6 } }, schema, NOW, 'x'),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// IGetPrices / IGetCurrencies
// ---------------------------------------------------------------------------

describe('IGetPrices v4 mapping', () => {
  const json = loadFixture('igetprices-v4.json');
  const parsed = parseIGetPrices(json, schema);
  const rows = new Map(parsed.rows.map((r) => [r.sku, r]));

  it('reads the envelope', () => {
    expect(parsed.success).toBe(true);
    expect(parsed.currentTime).toBe(1791958000);
    expect(communityRowsFromPrices(json, schema)).toEqual(parsed.rows);
  });

  it('maps quality -> tradable -> craftable -> priceindex, both object and array forms', () => {
    expect(rows.get('5021;6')).toEqual({ sku: '5021;6', currency: 'metal', value: 64.66, valueHigh: 64.88, lastUpdate: 1791900000 });
    expect(rows.get('5021;6;uncraftable')?.value).toBe(62.11);
    expect(rows.get('378;5;u13')).toMatchObject({ currency: 'keys', value: 60, valueHigh: 70 });
    expect(rows.get('378;5;u360')?.value).toBe(55);
    expect(rows.get('378;6')?.value).toBe(1.33);
    expect(rows.get('378;6;uncraftable')?.value).toBe(1.11);
    expect(rows.get('378;11')?.value).toBe(12.33);
    expect(rows.get('126;6;uncraftable;untradable')?.value).toBe(1);
  });

  it('emits one row per known defindex', () => {
    expect(rows.get('18;11')?.value).toBe(3.66);
    expect(rows.get('205;11')?.value).toBe(3.66);
    expect(rows.get('5022;6;c82')?.value).toBe(1.11);
    expect(rows.get('5041;6;c82')?.value).toBe(1.11);
    expect(rows.get('5045;6;c1')?.value).toBe(0.11);
  });

  it('reads killstreak, festivized and australium from names and flags', () => {
    expect(rows.get('205;6;kt-3')?.value).toBe(25.11);
    expect(rows.get('205;11;kt-3')).toMatchObject({ currency: 'keys', value: 1.2 });
    expect(rows.get('205;11;festive')?.value).toBe(20);
    expect(rows.get('205;11;australium')).toMatchObject({ currency: 'keys', value: 40, valueHigh: 42 });
  });

  it('interprets priceindex codes: target, chemistry set, fabricator, kit, taunt effect', () => {
    expect(rows.get('6522;6;td-46')?.value).toBe(9);
    expect(rows.get('20007;6;od-1086;oq-14')?.value).toBe(3);
    expect(rows.get('20003;6;kt-3;td-205;od-6526;oq-6')?.value).toBe(2.5);
    expect(rows.get('6526;6;kt-3;td-205')?.value).toBe(3.1);
    expect(rows.get('6526;6;uncraftable;kt-3;td-205')?.value).toBe(2.9);
    expect(rows.get('30920;5;u3010')).toMatchObject({ value: 30, valueHigh: 35 });
    expect(rows.get('30920;6')?.value).toBe(10.55);
  });

  it('keeps "Strange Part" tools plain and resolves skins by paintkit name', () => {
    expect(rows.get('6011;6')?.value).toBe(1.05);
    expect(rows.get('15000;15;w2;pk14')?.value).toBe(5);
  });

  it('counts entries it cannot map and never emits invalid rows', () => {
    expect(parsed.skipped).toBeGreaterThanOrEqual(2);
    for (const r of parsed.rows) {
      expect(canonical(r.sku)).toBe(r.sku);
      expect(Number.isFinite(r.value)).toBe(true);
    }
  });

  it('handles failures and junk', () => {
    expect(parseIGetPrices({ response: { success: 0, message: 'API key does not exist.' } }, schema)).toMatchObject({
      success: false,
      message: 'API key does not exist.',
      rows: [],
    });
    for (const junk of [null, 'x', 1, [], { response: { success: 1, items: [] } }]) {
      expect(() => parseIGetPrices(junk, schema)).not.toThrow();
      expect(parseIGetPrices(junk, schema).rows).toEqual([]);
    }
  });
});

describe('IGetCurrencies v1', () => {
  const fx = loadFixture<{ objectForm: unknown; arrayForm: unknown; failure: unknown }>('igetcurrencies-v1.json');

  it('parses the object form', () => {
    expect(parseIGetCurrencies(fx.objectForm, NOW)).toEqual({ source: 'bptf', buyScrap: 582, sellScrap: 584, observedAt: NOW });
  });

  it('parses the array form with string numbers', () => {
    expect(parseIGetCurrencies(fx.arrayForm, NOW)).toEqual({ source: 'bptf', buyScrap: 586, sellScrap: 586, observedAt: NOW });
  });

  it('returns null for failures, junk and non-metal prices', () => {
    expect(parseIGetCurrencies(fx.failure, NOW)).toBeNull();
    for (const junk of [null, undefined, 'x', 3, [], {}, { response: { currencies: 'x' } }]) {
      expect(parseIGetCurrencies(junk, NOW)).toBeNull();
    }
    expect(
      parseIGetCurrencies({ response: { currencies: { keys: { defindex: 5021, price: { value: 2.1, currency: 'usd' } } } } }, NOW),
    ).toBeNull();
  });
});
