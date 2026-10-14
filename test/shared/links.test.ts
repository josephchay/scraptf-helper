import { describe, expect, it } from 'vitest';
import {
  ALLOWED_EXTERNAL_HOSTS,
  STATIC_EXTERNAL_URLS,
  bptfPriceindex,
  buildLinks,
  isAllowedExternalUrl,
  scraptfPageFor,
} from '../../src/shared/links';
import { fromString } from '../../src/shared/sku';
import { CATEGORIES } from '../../src/shared/types';
import type { LinkContext, LinkSpec } from '../../src/shared/types';

function ctx(sku: string, extra: Partial<LinkContext> = {}): LinkContext {
  return {
    sku,
    skuObject: fromString(sku),
    fullName: extra.fullName ?? '',
    baseName: extra.baseName ?? '',
    marketHashName: extra.marketHashName ?? null,
    effectName: extra.effectName ?? null,
    paintkitName: extra.paintkitName ?? null,
    assetId: extra.assetId ?? null,
    ...extra,
  };
}

function byId(links: LinkSpec[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of links) out[l.id] = l.url;
  return out;
}

describe('buildLinks: unusual hat', () => {
  const links = buildLinks(
    ctx('378;5;u13', {
      fullName: 'Burning Flames Team Captain',
      baseName: 'Team Captain',
      marketHashName: 'Unusual Team Captain',
      effectName: 'Burning Flames',
      assetId: '6337300606',
    }),
  );
  const u = byId(links);

  it('builds every link with the expected URL', () => {
    expect(u).toEqual({
      'bptf-stats': 'https://backpack.tf/stats/Unusual/Team%20Captain/Tradable/Craftable/13',
      'bptf-next-stats': 'https://next.backpack.tf/stats?item=Team+Captain&quality=Unusual&priceindex=13',
      'bptf-history': 'https://backpack.tf/item/6337300606',
      'bptf-classifieds': 'https://backpack.tf/classifieds?item=Team+Captain&quality=5&australium=-1&killstreak_tier=0&particle=13',
      'bptf-classifieds-accurate':
        'https://backpack.tf/classifieds?item=Team+Captain&quality=5&australium=-1&killstreak_tier=0&particle=13&craftable=1&festivized=-1',
      'bptf-premium': 'https://backpack.tf/premium/search?item=Team+Captain&quality=5&australium=-1&killstreak_tier=0&particle=13',
      'bptf-premium-accurate':
        'https://backpack.tf/premium/search?item=Team+Captain&quality=5&australium=-1&killstreak_tier=0&particle=13&craftable=1&festivized=-1',
      mptf: 'https://marketplace.tf/items/tf2/378;5;u13',
      scm: 'https://steamcommunity.com/market/listings/440/Unusual%20Team%20Captain',
      stn: 'https://stntrading.eu/item/tf2/Unusual+Burning+Flames+Team+Captain',
      pricedb: 'https://pricedb.io/item/378%3B5%3Bu13',
    });
  });

  it('orders and groups links', () => {
    expect(links.map((l) => l.id)).toEqual([
      'bptf-stats',
      'bptf-next-stats',
      'bptf-history',
      'bptf-classifieds',
      'bptf-classifieds-accurate',
      'bptf-premium',
      'bptf-premium-accurate',
      'mptf',
      'scm',
      'stn',
      'pricedb',
    ]);
    const groups = Object.fromEntries(links.map((l) => [l.id, l.group]));
    expect(groups['bptf-stats']).toBe('backpack');
    expect(groups['bptf-premium-accurate']).toBe('backpack');
    expect(groups['mptf']).toBe('market');
    expect(groups['scm']).toBe('market');
    expect(groups['stn']).toBe('market');
    expect(groups['pricedb']).toBe('tools');
    for (const l of links) expect(l.label.length).toBeGreaterThan(0);
  });

  it('only produces allowed URLs and unique ids', () => {
    for (const l of links) expect(isAllowedExternalUrl(l.url)).toBe(true);
    expect(new Set(links.map((l) => l.id)).size).toBe(links.length);
  });
});

describe('buildLinks: backpack.tf stats conventions', () => {
  const stats = (sku: string, extra: Partial<LinkContext>) => byId(buildLinks(ctx(sku, extra)));

  it('Strange Unusual uses "Strange Unusual" and elevatedQuality', () => {
    const u = stats('378;5;u13;strange', { baseName: 'Team Captain', effectName: 'Burning Flames' });
    expect(u['bptf-stats']).toBe('https://backpack.tf/stats/Strange%20Unusual/Team%20Captain/Tradable/Craftable/13');
    expect(u['bptf-next-stats']).toBe(
      'https://next.backpack.tf/stats?item=Team+Captain&quality=Unusual&elevatedQuality=Strange&priceindex=13',
    );
    expect(u['bptf-classifieds']).toBe(
      'https://backpack.tf/classifieds?item=Team+Captain&quality=5%2C11&australium=-1&killstreak_tier=0&particle=13',
    );
    expect(u['stn']).toBe('https://stntrading.eu/item/tf2/Strange+Unusual+Burning+Flames+Team+Captain');
  });

  it('Strange Genuine elevated quality', () => {
    const u = stats('30177;1;strange', { baseName: 'Hong Kong Cone' });
    expect(u['bptf-stats']).toBe('https://backpack.tf/stats/Strange%20Genuine/Hong%20Kong%20Cone/Tradable/Craftable');
    expect(u['bptf-classifieds']).toContain('quality=1%2C11');
  });

  it('Strange Professional Killstreak Australium', () => {
    const u = stats('205;11;australium;kt-3', { baseName: 'Rocket Launcher' });
    expect(u['bptf-stats']).toBe(
      'https://backpack.tf/stats/Strange/Professional%20Killstreak%20Australium%20Rocket%20Launcher/Tradable/Craftable',
    );
    expect(u['bptf-next-stats']).toBe(
      'https://next.backpack.tf/stats?item=Rocket+Launcher&quality=Strange&australium=1&killstreakTier=3&sheen=-1&killstreaker=-1',
    );
    expect(u['bptf-classifieds']).toBe(
      'https://backpack.tf/classifieds?item=Rocket+Launcher&quality=11&australium=1&killstreak_tier=3',
    );
    expect(u['mptf']).toBe('https://marketplace.tf/items/tf2/205;11;australium;kt-3');
    expect(u['stn']).toBe('https://stntrading.eu/item/tf2/Strange+Professional+Killstreak+Australium+Rocket+Launcher');
  });

  it('Non-Craftable Festivized Professional Killstreak', () => {
    const u = stats('205;11;uncraftable;kt-3;festive', { baseName: 'Rocket Launcher' });
    expect(u['bptf-stats']).toBe(
      'https://backpack.tf/stats/Strange/Festivized%20Professional%20Killstreak%20Rocket%20Launcher/Tradable/Non-Craftable',
    );
    expect(u['bptf-next-stats']).toBe(
      'https://next.backpack.tf/stats?item=Rocket+Launcher&quality=Strange&festivized=1&craftable=0&killstreakTier=3&sheen=-1&killstreaker=-1',
    );
    expect(u['bptf-classifieds']).toBe(
      'https://backpack.tf/classifieds?item=Rocket+Launcher&quality=11&australium=-1&killstreak_tier=3',
    );
    expect(u['bptf-classifieds-accurate']).toBe(
      'https://backpack.tf/classifieds?item=Rocket+Launcher&quality=11&australium=-1&killstreak_tier=3&craftable=-1&festivized=1',
    );
    expect(u['stn']).toBe(
      'https://stntrading.eu/item/tf2/Non-Craftable+Strange+Festivized+Professional+Killstreak+Rocket+Launcher',
    );
  });

  it('Decorated Weapon skin uses "Skin | Name (Wear)"', () => {
    const u = stats('15000;15;w1;pk14', { baseName: 'Sniper Rifle', paintkitName: 'Night Owl' });
    expect(u['bptf-stats']).toBe(
      'https://backpack.tf/stats/Decorated%20Weapon/Night%20Owl%20%7C%20Sniper%20Rifle%20(Factory%20New)/Tradable/Craftable',
    );
    expect(u['bptf-next-stats']).toBe(
      'https://next.backpack.tf/stats?item=Sniper+Rifle&quality=Decorated+Weapon&wearTier=Factory+New&texture=Night+Owl',
    );
    expect(u['bptf-classifieds']).toBe(
      'https://backpack.tf/classifieds?item=Sniper+Rifle&quality=15&australium=-1&killstreak_tier=0&texture_name=Night+Owl',
    );
    expect(u['bptf-classifieds-accurate']).toBe(
      'https://backpack.tf/classifieds?item=Sniper+Rifle&quality=15&australium=-1&killstreak_tier=0&texture_name=Night+Owl&wear_tier=1&craftable=1&festivized=-1',
    );
    expect(u['stn']).toBe('https://stntrading.eu/item/tf2/Night+Owl+Sniper+Rifle+(Factory+New)');
    expect(u['mptf']).toBe('https://marketplace.tf/items/tf2/15000;15;w1;pk14');
  });

  it('unusual skin is filed under Decorated Weapon with the effect as priceindex', () => {
    const u = stats('15000;15;u701;w1;pk14', { baseName: 'Sniper Rifle', paintkitName: 'Night Owl', effectName: 'Hot' });
    expect(u['bptf-stats']).toBe(
      'https://backpack.tf/stats/Decorated%20Weapon/Night%20Owl%20%7C%20Sniper%20Rifle%20(Factory%20New)/Tradable/Craftable/701',
    );
    expect(u['bptf-next-stats']).toBe(
      'https://next.backpack.tf/stats?item=Sniper+Rifle&quality=Decorated+Weapon&priceindex=701&wearTier=Factory+New&texture=Night+Owl',
    );
    expect(u['stn']).toBe('https://stntrading.eu/item/tf2/Hot+Night+Owl+Sniper+Rifle+(Factory+New)');
  });

  it('unusual skin written with quality 5 drops the Unusual quality filter (as NetroScript did)', () => {
    const u = stats('16309;5;u703;w2;pk309;strange', {
      baseName: 'War Paint',
      paintkitName: 'Piña Polished',
      effectName: 'Cool',
    });
    expect(u['bptf-stats']).toBe(
      'https://backpack.tf/stats/Strange/Pi%C3%B1a%20Polished%20%7C%20War%20Paint%20(Minimal%20Wear)/Tradable/Craftable/703',
    );
    expect(u['bptf-classifieds']).toBe(
      'https://backpack.tf/classifieds?item=War+Paint&quality=11&australium=-1&killstreak_tier=0&particle=703&texture_name=Pi%C3%B1a+Polished',
    );
  });

  it('strange skins are filed under Strange whether the SKU uses quality 11 or 15+strange', () => {
    const a = stats('15000;15;w2;pk14;strange', { baseName: 'Sniper Rifle', paintkitName: 'Night Owl' });
    const b = stats('15000;11;w2;pk14', { baseName: 'Sniper Rifle', paintkitName: 'Night Owl' });
    const expected =
      'https://backpack.tf/stats/Strange/Night%20Owl%20%7C%20Sniper%20Rifle%20(Minimal%20Wear)/Tradable/Craftable';
    expect(a['bptf-stats']).toBe(expected);
    expect(b['bptf-stats']).toBe(expected);
    expect(a['bptf-next-stats']).toBe(
      'https://next.backpack.tf/stats?item=Sniper+Rifle&quality=Strange&wearTier=Minimal+Wear&texture=Night+Owl',
    );
    expect(a['stn']).toBe('https://stntrading.eu/item/tf2/Strange+Night+Owl+Sniper+Rifle+(Minimal+Wear)');
    expect(b['stn']).toBe('https://stntrading.eu/item/tf2/Strange+Night+Owl+Sniper+Rifle+(Minimal+Wear)');
  });

  it('killstreak skin', () => {
    const u = stats('15013;11;kt-3;w2;pk102', { baseName: 'Revolver', paintkitName: 'Steel Brushed' });
    expect(u['bptf-stats']).toBe(
      'https://backpack.tf/stats/Strange/Professional%20Killstreak%20Steel%20Brushed%20%7C%20Revolver%20(Minimal%20Wear)/Tradable/Craftable',
    );
    expect(u['bptf-next-stats']).toBe(
      'https://next.backpack.tf/stats?item=Revolver&quality=Strange&killstreakTier=3&sheen=-1&killstreaker=-1&wearTier=Minimal+Wear&texture=Steel+Brushed',
    );
  });

  it('war paint', () => {
    const u = stats('16102;15;w1;pk102', { baseName: 'War Paint', paintkitName: 'Jazzy' });
    expect(u['bptf-stats']).toBe(
      'https://backpack.tf/stats/Decorated%20Weapon/Jazzy%20%7C%20War%20Paint%20(Factory%20New)/Tradable/Craftable',
    );
  });

  it('crate series is the priceindex; STN is skipped for series crates', () => {
    const u = stats('5041;6;c11', { baseName: 'Mann Co. Supply Crate', marketHashName: 'Mann Co. Supply Crate Series #11' });
    expect(u['bptf-stats']).toBe('https://backpack.tf/stats/Unique/Mann%20Co.%20Supply%20Crate/Tradable/Craftable/11');
    expect(u['bptf-next-stats']).toBe('https://next.backpack.tf/stats?item=Mann+Co.+Supply+Crate&quality=Unique&priceindex=11');
    expect(u['stn']).toBeUndefined();
    expect(u['scm']).toBe('https://steamcommunity.com/market/listings/440/Mann%20Co.%20Supply%20Crate%20Series%20%2311');
  });

  it('killstreak kit uses "Killstreak Kit" and tier-target', () => {
    const u = stats('6526;6;uncraftable;kt-3;td-205', { baseName: 'Kit' });
    expect(u['bptf-stats']).toBe('https://backpack.tf/stats/Unique/Killstreak%20Kit/Tradable/Non-Craftable/3-205');
    expect(u['bptf-next-stats']).toBe(
      'https://next.backpack.tf/stats?item=Kit&quality=Unique&priceindex=3-205&craftable=0&killstreakTier=3&sheen=-1&killstreaker=-1',
    );
    expect(u['stn']).toBeUndefined();
    expect(u['mptf']).toBe('https://marketplace.tf/items/tf2/6526;6;uncraftable;kt-3;td-205');
  });

  it('fabricator uses the plain name and output-quality-target', () => {
    const u = stats('20003;6;kt-3;td-205;od-6526;oq-6', { baseName: 'Fabricator' });
    expect(u['bptf-stats']).toBe('https://backpack.tf/stats/Unique/Fabricator/Tradable/Craftable/6526-6-205');
    expect(u['bptf-next-stats']).toBe('https://next.backpack.tf/stats?item=Fabricator&quality=Unique&priceindex=6526-6-205');
  });

  it('chemistry sets and strangifiers', () => {
    expect(stats('20005;6;td-336;od-6522;oq-6', { baseName: 'Chemistry Set' })['bptf-stats']).toBe(
      'https://backpack.tf/stats/Unique/Chemistry%20Set/Tradable/Craftable/6522-6-336',
    );
    expect(stats('20007;6;od-1085;oq-14', { baseName: 'Chemistry Set' })['bptf-stats']).toBe(
      'https://backpack.tf/stats/Unique/Chemistry%20Set/Tradable/Craftable/1085-14',
    );
    expect(stats('6522;6;td-205', { baseName: 'Strangifier' })['bptf-stats']).toBe(
      'https://backpack.tf/stats/Unique/Strangifier/Tradable/Craftable/205',
    );
    expect(stats('9258;5;uncraftable;td-1196', { baseName: 'Unusualifier' })['bptf-stats']).toBe(
      'https://backpack.tf/stats/Unusual/Unusualifier/Tradable/Non-Craftable/1196',
    );
  });

  it('key, non-tradable and collector’s items', () => {
    const key = stats('5021;6', { baseName: 'Mann Co. Supply Crate Key', marketHashName: 'Mann Co. Supply Crate Key' });
    expect(key['bptf-stats']).toBe('https://backpack.tf/stats/Unique/Mann%20Co.%20Supply%20Crate%20Key/Tradable/Craftable');
    expect(key['scm']).toBe('https://steamcommunity.com/market/listings/440/Mann%20Co.%20Supply%20Crate%20Key');
    expect(key['stn']).toBe('https://stntrading.eu/item/tf2/Mann+Co.+Supply+Crate+Key');
    expect(key['pricedb']).toBe('https://pricedb.io/item/5021%3B6');

    const untradable = stats('5021;6;untradable', { baseName: 'Mann Co. Supply Crate Key' });
    expect(untradable['bptf-stats']).toBe(
      'https://backpack.tf/stats/Unique/Mann%20Co.%20Supply%20Crate%20Key/Non-Tradable/Craftable',
    );
    expect(untradable['stn']).toBeUndefined();

    const collectors = stats('205;14', { baseName: 'Rocket Launcher' });
    expect(collectors['bptf-stats']).toBe("https://backpack.tf/stats/Collector's/Rocket%20Launcher/Tradable/Craftable");
    expect(collectors['bptf-next-stats']).toBe("https://next.backpack.tf/stats?item=Rocket+Launcher&quality=Collector%27s");
    expect(collectors['stn']).toBe("https://stntrading.eu/item/tf2/Collector's+Rocket+Launcher");
  });

  it('unusual taunt with punctuation in the name', () => {
    const u = stats('1196;5;u3043', { baseName: 'Taunt: Panzer Pants', effectName: 'Spellbound Aspect' });
    expect(u['bptf-stats']).toBe('https://backpack.tf/stats/Unusual/Taunt%3A%20Panzer%20Pants/Tradable/Craftable/3043');
    expect(u['stn']).toBe('https://stntrading.eu/item/tf2/Unusual+Spellbound+Aspect+Taunt%3A+Panzer+Pants');
  });

  it('encodes path-breaking characters in names', () => {
    const u = stats('1;6', { baseName: 'A/B? C#D+E&F', marketHashName: 'A/B? C#D+E&F' });
    expect(u['bptf-stats']).toBe('https://backpack.tf/stats/Unique/A%2FB%3F%20C%23D%2BE%26F/Tradable/Craftable');
    expect(u['bptf-classifieds']).toBe(
      'https://backpack.tf/classifieds?item=A%2FB%3F+C%23D%2BE%26F&quality=6&australium=-1&killstreak_tier=0',
    );
    expect(u['scm']).toBe('https://steamcommunity.com/market/listings/440/A%2FB%3F%20C%23D%2BE%26F');
    expect(u['stn']).toBe('https://stntrading.eu/item/tf2/A%2FB%3F+C%23D%2BE%26F');
  });
});

describe('buildLinks: SKU-derived links', () => {
  it('paint goes to the accurate search and PriceDB, not to marketplace.tf', () => {
    const u = byId(buildLinks(ctx('378;6;p16738740', { baseName: 'Team Captain' })));
    expect(u['bptf-classifieds']).not.toContain('paint=');
    expect(u['bptf-classifieds-accurate']).toBe(
      'https://backpack.tf/classifieds?item=Team+Captain&quality=6&australium=-1&killstreak_tier=0&paint=16738740&craftable=1&festivized=-1',
    );
    expect(u['mptf']).toBe('https://marketplace.tf/items/tf2/378;6');
    expect(u['pricedb']).toBe('https://pricedb.io/item/378%3B6%3Bp16738740');
  });

  it('marketplace.tf uses v3 order and PriceDB uses legacy order', () => {
    const u = byId(buildLinks(ctx('200;6;uncraftable;n100', { baseName: 'SMG' })));
    expect(u['mptf']).toBe('https://marketplace.tf/items/tf2/200;6;n100;uncraftable');
    expect(u['pricedb']).toBe('https://pricedb.io/item/200%3B6%3Buncraftable%3Bn100');
  });

  it('falls back to parsing ctx.sku when skuObject is missing', () => {
    const c = ctx('378;5;u13', { baseName: 'Team Captain' }) as Partial<LinkContext>;
    delete c.skuObject;
    const u = byId(buildLinks(c as LinkContext));
    expect(u['bptf-stats']).toBe('https://backpack.tf/stats/Unusual/Team%20Captain/Tradable/Craftable/13');
  });

  it('returns nothing for an unusable context', () => {
    expect(buildLinks(null as unknown as LinkContext)).toEqual([]);
    const bad = ctx('5021;6', { baseName: 'Key' });
    expect(buildLinks({ ...bad, skuObject: { ...bad.skuObject, defindex: Number.NaN } })).toEqual([]);
    expect(buildLinks({ ...bad, skuObject: { ...bad.skuObject, quality: -1 } })).toEqual([]);
    const noObj = { ...bad, sku: 'not a sku' } as Partial<LinkContext>;
    delete noObj.skuObject;
    expect(buildLinks(noObj as LinkContext)).toEqual([]);
  });
});

describe('buildLinks: only includes links whose data is known', () => {
  it('no name: only SKU-based links', () => {
    for (const baseName of ['', '   ', '5021;6']) {
      const ids = buildLinks(ctx('5021;6', { baseName })).map((l) => l.id);
      expect(ids).toEqual(['mptf', 'pricedb']);
    }
  });

  it('item history needs a numeric asset id', () => {
    expect(byId(buildLinks(ctx('5021;6', { baseName: 'Key', assetId: '123' })))['bptf-history']).toBe(
      'https://backpack.tf/item/123',
    );
    for (const assetId of ['', 'abc', '12/../34', '1'.repeat(21), '-5', null]) {
      expect(byId(buildLinks(ctx('5021;6', { baseName: 'Key', assetId })))['bptf-history']).toBeUndefined();
    }
  });

  it('SCM needs a market hash name', () => {
    expect(byId(buildLinks(ctx('5021;6', { baseName: 'Key' })))['scm']).toBeUndefined();
    expect(byId(buildLinks(ctx('5021;6', { baseName: 'Key', marketHashName: '  ' })))['scm']).toBeUndefined();
  });

  it('skins need the paintkit name for every name-based link', () => {
    const ids = buildLinks(ctx('15000;15;w1;pk14', { baseName: 'Sniper Rifle' })).map((l) => l.id);
    expect(ids).toEqual(['mptf', 'pricedb']);
  });

  it('unusuals without an effect name still get backpack.tf links but no STN link', () => {
    const u = byId(buildLinks(ctx('378;5;u13', { baseName: 'Team Captain' })));
    expect(u['bptf-stats']).toBeDefined();
    expect(u['bptf-classifieds']).toBeDefined();
    expect(u['stn']).toBeUndefined();
  });

  it('unknown quality ids skip the stats and STN links but keep the searches', () => {
    const u = byId(buildLinks(ctx('5021;2', { baseName: 'Key' })));
    expect(u['bptf-stats']).toBeUndefined();
    expect(u['bptf-next-stats']).toBeUndefined();
    expect(u['stn']).toBeUndefined();
    expect(u['bptf-classifieds']).toBe('https://backpack.tf/classifieds?item=Key&quality=2&australium=-1&killstreak_tier=0');
  });

  it('out-of-range wear or killstreak values never produce a misleading name', () => {
    const wear = byId(buildLinks(ctx('15000;15;w9;pk14', { baseName: 'Sniper Rifle', paintkitName: 'Night Owl' })));
    expect(wear['bptf-stats']).toBeUndefined();
    expect(wear['bptf-next-stats']).toBeUndefined();
    expect(wear['stn']).toBeUndefined();
    const ks = byId(buildLinks(ctx('205;11;kt-7', { baseName: 'Rocket Launcher' })));
    expect(ks['bptf-stats']).toBeUndefined();
    expect(ks['bptf-next-stats']).toBeUndefined();
    expect(ks['stn']).toBeUndefined();
  });
});

describe('bptfPriceindex', () => {
  it.each([
    ['378;5;u13', '13'],
    ['378;5;u13;strange', '13'],
    ['5041;6;c11', '11'],
    ['6522;6;td-205', '205'],
    ['6526;6;uncraftable;kt-3;td-205', '3-205'],
    ['20003;6;kt-3;td-205;od-6526;oq-6', '6526-6-205'],
    ['20007;6;od-1085;oq-14', '1085-14'],
    ['20005;6;td-336;od-6522', '6522-6-336'],
    ['5021;6', null],
    ['205;11;kt-3', null],
  ])('%s -> %s', (sku, expected) => {
    expect(bptfPriceindex(fromString(sku))).toBe(expected);
  });
});

describe('isAllowedExternalUrl', () => {
  it.each([
    'https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable',
    'https://next.backpack.tf/stats?item=Team+Captain&quality=Unusual',
    'https://marketplace.tf/items/tf2/378;5;u13',
    'https://steamcommunity.com/market/listings/440/Mann%20Co.%20Supply%20Crate%20Key',
    'https://stntrading.eu/item/tf2/Team+Captain',
    'https://pricedb.io/item/5021%3B6',
    'https://mannco.store/item/440-team-captain',
    'https://scrap.tf/buy/hats',
    'https://scrap.tf/unusuals',
    'https://scrap.tf/terms',
    'https://SCRAP.TF/terms',
    'https://scrap.tf:443/terms',
    'https://github.com/NetroScript/scrap.tf-item-information',
    'https://github.com/VeBeshka/tf2-scraptf-profit-helper',
    'https://store.steampowered.com/subscriber_agreement/english/',
    'https://steamcommunity.com/dev/apiterms',
    'https://steamcommunity.com/market/listings/440/Linkfilter%20Hat',
    'https://BACKPACK.TF/stats',
    'HTTPS://backpack.tf/',
    'https://backpack.tf',
    'https://backpack.tf./stats',
    'https://backpack.tf:443/stats',
    'https://backpack.tf/item/1#history',
  ])('allows %s', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(true);
  });

  it.each([
    ['http://backpack.tf/', 'plain http'],
    ['ftp://backpack.tf/', 'other scheme'],
    ['javascript:alert(1)', 'javascript'],
    ['data:text/html,hi', 'data'],
    ['file:///C:/Windows', 'file'],
    ['//backpack.tf/', 'protocol-relative'],
    ['https:backpack.tf', 'missing slashes'],
    ['https:/backpack.tf', 'one slash'],
    ['https://evilbackpack.tf/', 'prefix lookalike'],
    ['https://backpack.tf.evil.com/', 'suffix lookalike'],
    ['https://backpack.tf@evil.com/', 'userinfo trick'],
    ['https://user:pass@backpack.tf/', 'credentials'],
    ['https://@backpack.tf/', 'empty userinfo'],
    ['https://backpack.tf:8443/', 'non-default port'],
    ['https://backpack.tf:80/', 'port 80 on https'],
    ['https://backpack.tf:/', 'empty port'],
    ['https://www.backpack.tf/', 'subdomain not listed'],
    ['https://api.backpack.tf/api/', 'api host is not for the browser'],
    ['https://ws.scrap.tf/', 'scrap.tf subdomain'],
    ['https://forum.scrap.tf/', 'scrap.tf subdomain'],
    ['https://backpack.tf../', 'double trailing dot'],
    ['https://bаckpack.tf/', 'IDN homograph'],
    ['https://xn--bckpack-2fg.tf/', 'punycode lookalike'],
    ['https://backpack%2Etf/', 'percent-encoded host'],
    ['https://backpack.tf\\@evil.com/', 'backslash'],
    ['https://evil.com\\.backpack.tf/', 'backslash'],
    ['https://back\npack.tf/', 'newline inside'],
    ['https://backpack.tf/\tpath', 'tab inside'],
    [' https://backpack.tf/', 'leading space'],
    ['https://backpack.tf/ path', 'space inside'],
    ['https://127.0.0.1/', 'ip literal'],
    ['https://[::1]/', 'ipv6 literal'],
    ['https://', 'no host'],
    ['', 'empty'],
    ['backpack.tf', 'no scheme'],
    // Hosts outside the link generator's seven are allowed for exact static pages only (§7.3.7).
    ['https://github.com/evil/x/releases/download/v1/FlipDeskUpdate.exe', 'GitHub release download'],
    ['https://github.com/NetroScript/scrap.tf-item-information/releases', 'other path on GitHub'],
    ['https://github.com/', 'GitHub root'],
    ['https://help.steampowered.com/en/faqs', 'host not on the list'],
    ['https://store.steampowered.com/app/440', 'other Steam store page'],
    ['https://scrap.tf/', 'scrap.tf root'],
    ['https://scrap.tf/buy/hats?ref=1', 'static page with a query'],
    ['https://scrap.tf/terms#top', 'static page with a fragment'],
    ['https://scrap.tf/raffles', 'other scrap.tf page'],
    // Steam's redirector forwards to any site.
    ['https://steamcommunity.com/linkfilter/?u=https://evil.example', 'Steam linkfilter'],
    ['https://steamcommunity.com/linkfilter?url=https://evil.example', 'Steam linkfilter without slash'],
    ['https://steamcommunity.com/LinkFilter/?u=https://evil.example', 'Steam linkfilter, other case'],
    ['https://steamcommunity.com/%6Cinkfilter/?u=https://evil.example', 'Steam linkfilter, percent-encoded'],
    ['https://steamcommunity.com/%E0%A4%A/', 'malformed percent-encoding on steamcommunity.com'],
  ])('rejects %s (%s)', (url) => {
    expect(isAllowedExternalUrl(url)).toBe(false);
  });

  it('rejects non-strings and oversized URLs', () => {
    expect(isAllowedExternalUrl(undefined as unknown as string)).toBe(false);
    expect(isAllowedExternalUrl(42 as unknown as string)).toBe(false);
    expect(isAllowedExternalUrl(`https://backpack.tf/${'a'.repeat(5000)}`)).toBe(false);
  });

  it('allows every listed host and nothing that only resembles one', () => {
    for (const host of ALLOWED_EXTERNAL_HOSTS) {
      expect(isAllowedExternalUrl(`https://${host}/`)).toBe(true);
      expect(isAllowedExternalUrl(`https://x${host}/`)).toBe(false);
      expect(isAllowedExternalUrl(`https://${host}.example.com/`)).toBe(false);
      expect(isAllowedExternalUrl(`https://${host}@example.com/`)).toBe(false);
    }
  });
});

describe('scraptfPageFor', () => {
  it.each([
    ['hats', 'https://scrap.tf/buy/hats'],
    ['weapons', 'https://scrap.tf/buy/weapons'],
    ['stranges', 'https://scrap.tf/buy/stranges'],
    ['killstreaks', 'https://scrap.tf/buy/killstreaks'],
    ['skins', 'https://scrap.tf/buy/skins'],
    ['unusuals', 'https://scrap.tf/unusuals'],
    ['taunts', 'https://scrap.tf/buy/items'],
    ['other', 'https://scrap.tf/buy/items'],
  ] as const)('%s -> %s', (category, url) => {
    expect(scraptfPageFor(category)).toBe(url);
  });

  it('covers every category with an allowed static https URL', () => {
    for (const c of CATEGORIES) {
      const url = scraptfPageFor(c);
      expect(isAllowedExternalUrl(url)).toBe(true);
      expect(new URL(url).hostname).toBe('scrap.tf');
      expect(new URL(url).search).toBe('');
    }
  });

  it('falls back to the items page for unexpected input', () => {
    expect(scraptfPageFor('toString' as never)).toBe('https://scrap.tf/buy/items');
    expect(scraptfPageFor('nope' as never)).toBe('https://scrap.tf/buy/items');
  });
});

describe('STATIC_EXTERNAL_URLS', () => {
  it('lists only exact https pages, each one allowed', () => {
    expect(new Set(STATIC_EXTERNAL_URLS).size).toBe(STATIC_EXTERNAL_URLS.length);
    for (const url of STATIC_EXTERNAL_URLS) {
      expect(isAllowedExternalUrl(url), url).toBe(true);
      const u = new URL(url);
      expect(u.href).toBe(url);
      expect(u.search).toBe('');
      expect(u.hash).toBe('');
    }
  });

  it('keeps the whole-host list to the link generator hosts of §7.3.7', () => {
    expect([...ALLOWED_EXTERNAL_HOSTS].sort()).toEqual(
      ['backpack.tf', 'mannco.store', 'marketplace.tf', 'next.backpack.tf', 'pricedb.io', 'steamcommunity.com', 'stntrading.eu'].sort(),
    );
  });
});

describe('buildLinks: scrap.tf category page', () => {
  const hat = (extra: Partial<LinkContext> = {}) =>
    buildLinks(ctx('378;6', { baseName: 'Team Captain', marketHashName: 'Team Captain', ...extra }));

  it('adds the static bank page when the category is known', () => {
    const links = hat({ category: 'hats' });
    const page = links.find((l) => l.id === 'scraptf-page');
    expect(page).toMatchObject({ url: 'https://scrap.tf/buy/hats', group: 'market' });
    expect(page!.label).toMatch(/scrap\.tf/);
    expect(new URL(page!.url).search).toBe('');
    expect(isAllowedExternalUrl(page!.url)).toBe(true);
    expect(links.map((l) => l.id).indexOf('scraptf-page')).toBeLessThan(links.map((l) => l.id).indexOf('pricedb'));
  });

  it.each(CATEGORIES.map((c) => [c] as const))('maps %s to its static page', (category) => {
    expect(byId(hat({ category }))['scraptf-page']).toBe(scraptfPageFor(category));
  });

  it('adds nothing when the category is unknown or invalid', () => {
    expect(hat().some((l) => l.id === 'scraptf-page')).toBe(false);
    expect(hat({ category: null }).some((l) => l.id === 'scraptf-page')).toBe(false);
    expect(hat({ category: 'toString' as never }).some((l) => l.id === 'scraptf-page')).toBe(false);
    expect(hat({ category: 'https://evil.example' as never }).some((l) => l.id === 'scraptf-page')).toBe(false);
  });
});
