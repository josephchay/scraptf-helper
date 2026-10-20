// 0.7.2: killstreak kits as a real /buy/killstreaks window read shows them (the user's parser report of
// 2026-10-19: 873 cards, every one a kit). scrap.tf titles a kit "Professional Rocket Launcher Kit" (no
// "Killstreak"), TF2's schema names every kit just "Kit", and the card carries the sheen and killstreaker
// as fx classes and tooltip lines plus a "Costs …" line. Each kit was stored as its bare defindex ("6526;6",
// named "Kit"): every kit of a tier as one price. A kit is now keyed by its weapon as backpack.tf keys it
// ("6526;6;uncraftable;kt-3;td-205"), and one whose weapon cannot be read is skipped with needs-target.
// The schema here is TF2's own item data (test/fixtures/pricedb/schema-subset.json), not a stub: until 0.7.2
// the stub named kits "Professional Killstreak Kit", which hid the bug (schemaStub.test.ts now keeps its
// names TF2's).

import { beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { SchemaService } from '../../src/service/contracts';
import { isImportableItem, parseScrapTfHtml, scraptfKitSteamName, warningCode } from '../../src/service/import/scraptfHtml';
import { makeDeps, schemaRoute } from '../pricedb/helpers';
import { createStubSchema } from './schemaStub';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

function killstreakPage(cards: string): string {
  const url = 'https://scrap.tf/buy/killstreaks';
  return `<!DOCTYPE html>\n<!-- saved from url=(${String(url.length).padStart(4, '0')})${url} -->\n<html><head><title>Buy Killstreaks</title></head><body>${cards}</body></html>`;
}

interface CardSpec {
  title: string;
  defindex?: number;
  /** fx classes: the sheen (1-7) and killstreaker (2002-2008). */
  fx?: number[];
  content?: string[];
  indicator?: string | null;
  value?: number;
  extraClasses?: string;
}

let nextId = 17_000_000_000;
/** A card as the real page shows it (classes, attributes and tooltip lines from the parser report). */
function card(c: CardSpec): string {
  const fx = (c.fx ?? [1, 2008]).map((n) => `fx${n}`).join(' ');
  const content = (c.content ?? ['Sheen: Team Shine', 'Killstreaker: Hypno-Beam', 'Costs 37 keys, 40 refined']).join('<br/>');
  const indicator = c.indicator === undefined ? '37 keys, 40 ref' : c.indicator;
  return (
    `<div class="item hoverable quality6 ${fx} app440${c.extraClasses ? ` ${c.extraClasses}` : ''}" data-id="${nextId++}" data-defindex="${c.defindex ?? 6526}"` +
    ` data-title="${c.title}" data-content="${content}" data-item-value="${c.value ?? 23411}" data-num-available="1" data-num-selected="0">` +
    (indicator === null ? '' : `<div class="item-value-indicator">${indicator}</div>`) +
    `</div>`
  );
}

function parseOne(spec: CardSpec, s: SchemaService = schema) {
  const r = parseScrapTfHtml(killstreakPage(card(spec)), s);
  expect(r.items).toHaveLength(1);
  return r.items[0]!;
}

const codes = (warnings: readonly string[]): string[] => warnings.map(warningCode);

describe('killstreak kits as /buy/killstreaks shows them', () => {
  it('keys the report card "Professional Rocket Launcher Kit" by its weapon, Non-Craftable, with no unread name or line', () => {
    const item = parseOne({ title: 'Professional Rocket Launcher Kit' });
    expect(item.sku).toBe('6526;6;uncraftable;kt-3;td-205');
    expect(item.name).toBe('Non-Craftable Professional Killstreak Rocket Launcher Kit');
    expect(item.costKeys).toBe(37);
    expect(item.costScrap).toBe(360);
    expect(item.special).toMatchObject({ sheen: 1, killstreaker: 2008 });
    expect(item.warnings).toEqual([]);
  });

  // Every weapon of the report that the schema subset holds, with the target backpack.tf keys its kit by
  // (the upgradeable defindex of a stock weapon). Prices and stock as on the report cards.
  it.each([
    ['Medi Gun', 211],
    ['Scattergun', 200],
    ['Sniper Rifle', 201],
    ['Flame Thrower', 208],
    ['Minigun', 202],
    ['Tomislav', 424],
    ['Stickybomb Launcher', 207],
    ['Shotgun', 199],
    ['Grenade Launcher', 206],
    ['Black Box', 228],
    ['Wrench', 197],
    ['Iron Bomber', 1151],
    ['Knife', 194],
    ['Kritzkrieg', 35],
    ['Eyelander', 132],
    ['Panic Attack', 1153],
    ['Force-a-Nature', 45],
    ['Ambassador', 61],
    ['SMG', 203],
    ['Frontier Justice', 141],
    ['Frying Pan', 264],
    ['Huntsman', 56],
    ['Pistol', 209],
  ])('Professional %s Kit -> td-%i', (weapon, target) => {
    const item = parseOne({ title: `Professional ${weapon} Kit` });
    expect(item.sku).toBe(`6526;6;uncraftable;kt-3;td-${target}`);
    expect(codes(item.warnings)).toEqual([]);
  });

  it('keys specialized and basic kits by their defindex tier, whichever way the title spells the tier', () => {
    const spec = parseOne({ title: 'Specialized Medi Gun Kit', defindex: 6523, fx: [3], content: ['Sheen: Manndarin', 'Costs 2 keys'], indicator: '2 keys', value: 1246 });
    expect(spec.sku).toBe('6523;6;uncraftable;kt-2;td-211');
    expect(spec.special).toMatchObject({ sheen: 3, killstreaker: null });
    for (const title of ['Killstreak Scattergun Kit', 'Basic Killstreak Scattergun Kit', 'Scattergun Kit']) {
      const basic = parseOne({ title, defindex: 6527, fx: [], content: ['Costs 3 refined'], indicator: '3 ref', value: 27 });
      expect(basic.sku).toBe('6527;6;uncraftable;kt-1;td-200');
      expect(basic.warnings).toEqual([]);
    }
  });

  it("reads Steam's own form and a Non-Craftable title the same way", () => {
    for (const title of ['Professional Killstreak Rocket Launcher Kit', 'Non-Craftable Professional Rocket Launcher Kit']) {
      expect(parseOne({ title }).sku).toBe('6526;6;uncraftable;kt-3;td-205');
    }
    expect(parseOne({ title: 'Professional Rocket Launcher Kit', extraClasses: 'uncraft' }).sku).toBe('6526;6;uncraftable;kt-3;td-205');
  });

  it('keeps the tier of the item when the title names another, and says so', () => {
    const item = parseOne({ title: 'Specialized Rocket Launcher Kit', defindex: 6526 });
    expect(item.sku).toBe('6526;6;uncraftable;kt-3;td-205');
    expect(codes(item.warnings)).toEqual(['killstreak-mismatch']);
  });

  it.each([['Kit'], ['Professional Kit'], ['Professional Killstreak Kit'], ['Rocket Launcher'], ['Professional Rocket Launcher Kit Fabricator']])(
    'skips a kit titled %j (no weapon to key it by) with needs-target, never as its bare defindex',
    (title) => {
      const item = parseOne({ title });
      expect(item.sku).toBeNull();
      expect(codes(item.warnings)).toContain('needs-target');
    },
  );

  it('skips a kit whose weapon the item schema does not know, never guessing a close name', () => {
    // The Original (513) is not in the schema subset; "Rocket Launcherr" is one letter off a real weapon.
    for (const title of ['Professional Original Kit', 'Professional Rocket Launcherr Kit']) {
      const item = parseOne({ title });
      expect(item.sku).toBeNull();
      expect(item.warnings.find((w) => warningCode(w) === 'needs-target')).toContain('item schema does not know');
    }
  });

  it('keys a fabricator titled the scrap.tf way by its weapon and keeps its own craftability', () => {
    const fab = parseOne({ title: 'Professional Rocket Launcher Kit Fabricator', defindex: 20003, content: ['Outputs: Professional Rocket Launcher Kit', 'Sheen: Hot Rod', 'Killstreaker: Incinerator'], indicator: '1 key, 20 ref', value: 744 });
    expect(fab.sku).toBe('20003;6;kt-3;td-205;od-6526;oq-6');
    const kitTitled = parseOne({ title: 'Professional Rocket Launcher Kit', defindex: 20003 });
    expect(kitTitled.sku).toBeNull();
    expect(codes(kitTitled.warnings)).toContain('needs-target');
  });

  it('skips a strangifier whose title names no target instead of keying the bare item', () => {
    const item = parseOne({ title: 'Strangifier', defindex: 6522, fx: [], content: [], indicator: '1 ref', value: 9 });
    expect(item.sku).toBeNull();
    expect(codes(item.warnings)).toContain('needs-target');
  });

  it('prices a card from its "Costs" line when it shows no other price, and notes a line that disagrees', () => {
    const fromCost = parseOne({ title: 'Professional Medi Gun Kit', fx: [3, 2008], indicator: null, value: 0, content: ['Sheen: Manndarin', 'Killstreaker: Hypno-Beam', 'Costs 35 keys'] });
    expect([fromCost.costKeys, fromCost.costScrap]).toEqual([35, 0]);
    expect(fromCost.warnings).toEqual([]);
    const mismatch = parseOne({ title: 'Professional Medi Gun Kit', indicator: '35 keys', content: ['Costs 36 keys'] });
    expect([mismatch.costKeys, mismatch.costScrap]).toEqual([35, 0]);
    expect(codes(mismatch.warnings)).toEqual(['price-mismatch']);
  });

  it('keys every card of a report-shaped page, three tiers and two sheens of one weapon', () => {
    const html = killstreakPage(
      [
        card({ title: 'Professional Rocket Launcher Kit', fx: [1, 2008] }),
        card({ title: 'Professional Rocket Launcher Kit', fx: [4, 2003], content: ['Sheen: Mean Green', 'Killstreaker: Cerebral Discharge', 'Costs 35 keys'], indicator: '35 keys', value: 21805 }),
        card({ title: 'Specialized Rocket Launcher Kit', defindex: 6523, fx: [2], content: ['Sheen: Deadly Daffodil', 'Costs 3 keys'], indicator: '3 keys', value: 1869 }),
        card({ title: 'Killstreak Rocket Launcher Kit', defindex: 6527, fx: [], content: ['Costs 1 key'], indicator: '1 key', value: 623 }),
      ].join(''),
    );
    const r = parseScrapTfHtml(html, schema, { diagnostics: true });
    expect(r.bank).toBe('killstreaks');
    expect(r.items.map((i) => i.sku)).toEqual([
      '6526;6;uncraftable;kt-3;td-205',
      '6526;6;uncraftable;kt-3;td-205',
      '6523;6;uncraftable;kt-2;td-205',
      '6527;6;uncraftable;kt-1;td-205',
    ]);
    expect(r.items.flatMap((i) => i.warnings)).toEqual([]);
    // Nothing for the parser report to explain: no refused or guessed card.
    expect(r.diagnostics).toBeDefined();
    expect(r.diagnostics!.items).toEqual([]);
  });

  it('leaves ordinary items alone', () => {
    const r = parseScrapTfHtml(killstreakPage(card({ title: 'Team Captain', defindex: 378, fx: [], content: [], indicator: '1.33 ref', value: 12 })), schema);
    expect(r.items[0]!.sku).toBe('378;6');
  });

  it('works the same with the stub schema the other import tests use', () => {
    const stub = createStubSchema();
    expect(parseOne({ title: 'Professional Rocket Launcher Kit' }, stub).sku).toBe('6526;6;uncraftable;kt-3;td-205');
    expect(parseOne({ title: 'Kit' }, stub).sku).toBeNull();
  });

  // Review findings (0.7.2 adversarial pass).

  it('keeps the tier of the item whatever a name learned from backpack.tf says (one mis-tiered listing)', async () => {
    const deps = makeDeps(schemaRoute());
    // The resolver reads learned names first; one listing filed the craftable kit's name under tier 1.
    deps.repo.upsertBptfNames([{ sku: '6526;6;kt-1;td-205', name: 'Professional Killstreak Rocket Launcher Kit', marketName: null, lastSeen: 1 }]);
    const learned = createSchemaService(deps);
    await learned.init();
    expect(learned.resolve('Professional Killstreak Rocket Launcher Kit')?.sku).toBe('6526;6;kt-1;td-205');
    expect(parseOne({ title: 'Professional Rocket Launcher Kit' }, learned).sku).toBe('6526;6;uncraftable;kt-3;td-205');
  });

  it('refuses words the resolver would read into a kit (Australium, Strange) instead of keying them', () => {
    for (const title of ['Professional Australium Rocket Launcher Kit', 'Professional Strange Rocket Launcher Kit']) {
      const item = parseOne({ title });
      expect(item.sku).toBeNull();
      expect(codes(item.warnings)).toContain('needs-target');
    }
  });

  it('reads a weapon named with a leading "The" or hyphens as the schema spells it', () => {
    expect(parseOne({ title: 'Professional Force-a-Nature Kit' }).sku).toBe('6526;6;uncraftable;kt-3;td-45');
    expect(parseOne({ title: 'Professional The Black Box Kit' }).sku).toBe('6526;6;uncraftable;kt-3;td-228');
  });

  it.each([
    [6522, 'Team Captain'],
    [9258, 'Taunt: Conga'],
    [20000, 'Strangifier Series #1'],
  ])('skips defindex %i titled %j (schema item_name Strangifier/Unusualifier/Chemistry Set), never the bare tool', (defindex, title) => {
    const item = parseOne({ title, defindex, fx: [], content: [], indicator: '1 ref', value: 9 });
    expect(item.sku).toBeNull();
    expect(codes(item.warnings)).toEqual(['needs-target']);
  });

  it('refuses a chemistry set whose "Series #N" the resolver would read as a craft number', () => {
    const item = parseOne({ title: 'Team Captain Strangifier Chemistry Set Series #1', defindex: 20000, fx: [], content: [], indicator: '1 ref', value: 9 });
    expect(item.sku).toBeNull();
    expect(codes(item.warnings)).toContain('needs-target');
  });

  it('keys a card with no defindex whose Steam-form title names a kit Non-Craftable, and says it was identified by name', () => {
    const html = killstreakPage(
      `<div class="item hoverable quality6 fx1 fx2008 app440" data-id="1" data-title="Professional Killstreak Rocket Launcher Kit" data-content="Sheen: Team Shine<br/>Killstreaker: Hypno-Beam" data-item-value="23411" data-num-available="1"><div class="item-value-indicator">37 keys, 40 ref</div></div>`,
    );
    const item = parseScrapTfHtml(html, schema).items[0]!;
    expect(item.sku).toBe('6526;6;uncraftable;kt-3;td-205');
    expect(codes(item.warnings)).toEqual(['no-defindex']);
  });

  it('keys a Non-Craftable fabricator Non-Craftable (title or class) and notes a tier its title disagrees with', () => {
    const fab = { defindex: 20003, fx: [] as number[], content: ['Costs 1 key'], indicator: '1 key', value: 600 };
    expect(parseOne({ ...fab, title: 'Non-Craftable Professional Rocket Launcher Kit Fabricator' }).sku).toBe('20003;6;uncraftable;kt-3;td-205;od-6526;oq-6');
    expect(parseOne({ ...fab, title: 'Professional Rocket Launcher Kit Fabricator', extraClasses: 'uncraft' }).sku).toBe('20003;6;uncraftable;kt-3;td-205;od-6526;oq-6');
    const mismatch = parseOne({ ...fab, title: 'Specialized Rocket Launcher Kit Fabricator' });
    expect(mismatch.sku).toBe('20003;6;kt-3;td-205;od-6526;oq-6');
    expect(codes(mismatch.warnings)).toEqual(['killstreak-mismatch']);
    const specialized = parseOne({ ...fab, defindex: 20002, title: 'Specialized Rocket Launcher Kit Fabricator' });
    expect(specialized.sku).toBe('20002;6;kt-2;td-205;od-6523;oq-6');
  });

  it('keeps a kit whose title names another tier in the parser report (how unseen title forms show up)', () => {
    const r = parseScrapTfHtml(killstreakPage(card({ title: 'Specialized Rocket Launcher Kit' }) + card({ title: 'Killstreak Rocket Launcher Kit' })), schema, { diagnostics: true });
    expect(r.items.map((i) => codes(i.warnings))).toEqual([['killstreak-mismatch'], ['killstreak-mismatch']]);
    expect(r.diagnostics).toBeDefined();
    expect(r.diagnostics!.items.map((d) => d.sku)).toEqual(['6526;6;uncraftable;kt-3;td-205', '6526;6;uncraftable;kt-3;td-205']);
  });

  it('keeps pricing a card by data-item-value when its "Costs" line cannot be read, and notes the line', () => {
    const item = parseOne({ title: 'Team Captain', defindex: 378, fx: [], indicator: null, value: 564, content: ['Costs a lot of keys'] });
    expect([item.costKeys, item.costScrap]).toEqual([0, 564]);
    expect(isImportableItem(item)).toBe(true);
    expect(codes(item.warnings)).toEqual(['unparsed-modifier']);
  });

  it('keys an /items list row of a kit by its weapon, with no unread name', () => {
    const row = (title: string) =>
      `<tr data-quality="6" data-defindex="6526"><td></td><td>${title}</td><td>37 keys</td><td>30 keys</td><td><div rel="tooltip" title="1/5"></div></td></tr>`;
    const html =
      '<!DOCTYPE html><html><head><title>Item Trading - TF2 - Scrap.TF</title><meta property="og:url" content="https://scrap.tf/items" /></head><body id="pid-items"><table>' +
      '<thead><tr><th>Icon</th><th>Item</th><th>Price to buy</th><th>Price we pay</th><th>Item Limits</th></tr></thead>' +
      `<tbody>${row('Professional Rocket Launcher Kit')}${row('Professional Killstreak Kit')}</tbody></table></body></html>`;
    const r = parseScrapTfHtml(html, schema);
    expect(r.pageKind).toBe('items-list');
    expect(r.items.map((i) => [i.sku, codes(i.warnings)])).toEqual([
      ['6526;6;uncraftable;kt-3;td-205', []],
      [null, ['needs-target']],
    ]);
  });

  it("turns scrap.tf's kit names into Steam's, keyed as the import keys them, and leaves every other name alone", () => {
    expect(scraptfKitSteamName('Professional Rocket Launcher Kit')).toBe('Non-Craftable Professional Killstreak Rocket Launcher Kit');
    expect(scraptfKitSteamName('Specialized Medi Gun Kit')).toBe('Non-Craftable Specialized Killstreak Medi Gun Kit');
    expect(scraptfKitSteamName('Professional Rocket Launcher Kit Fabricator')).toBe('Professional Killstreak Rocket Launcher Kit Fabricator');
    expect(scraptfKitSteamName('Non-Craftable Professional Rocket Launcher Kit Fabricator')).toBe('Non-Craftable Professional Killstreak Rocket Launcher Kit Fabricator');
    for (const other of ['Professional Killstreak Rocket Launcher Kit', 'Killstreak Shotgun Kit', 'Shotgun Kit', 'Professional Kit', 'Team Captain', 'Disguise Kit']) {
      expect(scraptfKitSteamName(other)).toBeNull();
    }
    expect(schema.resolve(scraptfKitSteamName('Professional Rocket Launcher Kit')!)?.sku).toBe('6526;6;uncraftable;kt-3;td-205');
    expect(schema.resolve(scraptfKitSteamName('Professional Rocket Launcher Kit Fabricator')!)?.sku).toBe('20003;6;kt-3;td-205;od-6526;oq-6');
  });
});
