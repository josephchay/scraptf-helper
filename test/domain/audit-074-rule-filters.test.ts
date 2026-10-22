// 0.7.4 (F79): a 'strange weapons at 3.55 ref' rule had no way to leave out Festivized or elevated-Strange
// copies, the editor left Australium on 'any', and DC-5 let an australium candidate toast however fresh the
// user's saves were. Rules now have Festivized and Elevated Strange tri-states (rpcSchemas, matcher, the mock,
// describeRuleFilter, the editor), a new rule leaves out australiums and Festivized copies, a backup that uses
// the new filters is version 2 (an older build refuses it rather than broaden the rule), and ACT-8 holds an
// australium candidate back only when both its category's page and the items bank were seen whole within
// profit.inputStaleMs. Real schema fixture for the engine and preview (schema-subset.json).

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { createEngine } from '../../src/service/domain/engine';
import { ruleMatches } from '../../src/service/domain/matcher';
import { previewRule } from '../../src/service/domain/views';
import { RULES_BACKUP_VERSION, rulesFromJson, rulesToJson } from '../../src/service/priceSheetIo';
import { ruleFilterSchema } from '../../src/service/rpcSchemas';
import { mockRulesToJson, ruleMatches as mockRuleMatches } from '../../src/renderer/mockData';
import { describeRuleFilter } from '../../src/renderer/format';
import { NEW_RULE_FILTER } from '../../src/renderer/pages/RulesPanel';
import { DEFAULT_SETTINGS, mergeSettings } from '../../src/shared/defaults';
import { fromString } from '../../src/shared/sku';
import type { Category, PriceRule, RuleFilter, ScraptfBank } from '../../src/shared/types';
import { makeDeps as schemaDeps, schemaRoute } from '../pricedb/helpers';
import { FakeClock, FakeTimers, MIN, T0, makeDeps, makeListing, recordingEvents } from './helpers';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(schemaDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

const subject = (sku: string, category: Category) => ({ obj: fromString(sku), category, name: sku });

describe('Festivized and Elevated Strange filters', () => {
  it('match as tri-states in the service and the mock alike', () => {
    const cases: [RuleFilter, string, Category, boolean][] = [
      [{ festive: false }, '205;6;festive', 'weapons', false],
      [{ festive: true }, '205;6;festive', 'weapons', true],
      [{ festive: true }, '205;6', 'weapons', false],
      [{ festive: false }, '205;6', 'weapons', true],
      [{ festive: null }, '205;6;festive', 'weapons', true],
      [{}, '205;6;festive', 'weapons', true],
      [{ elevated: false }, '378;5;u13;strange', 'unusuals', false],
      [{ elevated: true }, '378;5;u13;strange', 'unusuals', true],
      [{ elevated: true }, '378;5;u13', 'unusuals', false],
      // The Strange quality itself is no elevated Strange.
      [{ elevated: false }, '205;11', 'stranges', true],
    ];
    for (const [filter, sku, category, want] of cases) {
      expect(ruleMatches(filter, subject(sku, category)), `${JSON.stringify(filter)} ${sku}`).toBe(want);
      expect(mockRuleMatches(filter, { sku, name: sku, category }), `mock ${JSON.stringify(filter)} ${sku}`).toBe(want);
    }
  });

  it('are validated, described, and stored', () => {
    expect(ruleFilterSchema.safeParse({ festive: false, elevated: null }).success).toBe(true);
    expect(ruleFilterSchema.safeParse({ festive: 'no' }).success).toBe(false);
    expect(describeRuleFilter({ categories: ['stranges'], australium: false, festive: false, elevated: false })).toBe('Stranges · not australium · not festivized · not elevated Strange');
    expect(describeRuleFilter({ festive: true, elevated: true })).toBe('festivized · elevated Strange');
    const repo = openRepo(':memory:');
    repos.push(repo);
    const saved = repo.upsertRule({ name: 'Strange weapons', filter: { categories: ['stranges'], festive: false, elevated: false }, costScrap: 32, observedAt: T0 });
    expect(repo.listRules().find((r) => r.id === saved.id)?.filter).toEqual({ categories: ['stranges'], festive: false, elevated: false });
  });

  it('a new rule leaves out australiums and Festivized copies', () => {
    expect(NEW_RULE_FILTER).toEqual({ categories: ['hats'], qualities: [6], craftable: true, hasEffect: false, australium: false, festive: false });
  });

  it('the preview counts what the engine would match (real schema)', () => {
    const repo = openRepo(':memory:');
    repos.push(repo);
    for (const sku of ['205;11', '205;11;festive', '205;11;australium', '424;11']) {
      repo.upsertListings([makeListing({ id: `b-${sku}`, sku, baseSku: sku, metalScrap: 60, lastEventAt: T0 - MIN })]);
    }
    const any = previewRule(repo, schema, { qualities: [11] });
    const plain = previewRule(repo, schema, { qualities: [11], australium: false, festive: false });
    expect(any.matchingSkus).toBe(4);
    expect(plain.sample.map((s) => s.sku).sort()).toEqual(['205;11', '424;11']);
  });
});

describe('rules backup', () => {
  const rule = (filter: RuleFilter): PriceRule => ({ id: 1, name: 'r', filter, costKeys: 0, costScrap: 32, observedAt: T0, enabled: true });

  it('is version 2 only when a rule uses the new filters, and reads both back', () => {
    expect(RULES_BACKUP_VERSION).toBe(2);
    const v1 = JSON.parse(rulesToJson([rule({ categories: ['stranges'], australium: false })], T0)) as { version: number };
    expect(v1.version).toBe(1);
    const v2text = rulesToJson([rule({ categories: ['stranges'], festive: false })], T0);
    expect((JSON.parse(v2text) as { version: number }).version).toBe(2);
    expect(rulesFromJson(v2text).rules[0]!.filter).toEqual({ categories: ['stranges'], festive: false });
    // A version 1 backup without the fields keeps its meaning ("either").
    expect(rulesFromJson(JSON.stringify({ format: 'tf2-flip-desk-rules', version: 1, rules: [{ name: 'old', filter: { qualities: [11] }, costScrap: 32 }] })).rules[0]!.filter).toEqual({ qualities: [11] });
    // The mock writes the same versions.
    expect((JSON.parse(mockRulesToJson([rule({ festive: true })], T0)) as { version: number }).version).toBe(2);
    expect((JSON.parse(mockRulesToJson([rule({ qualities: [6] })], T0)) as { version: number }).version).toBe(1);
  });
});

describe('DC-5: an australium candidate needs both of its pages seen whole (ACT-8)', () => {
  function engine(saves: Partial<Record<ScraptfBank, number>>) {
    const repo = openRepo(':memory:');
    repos.push(repo);
    repo.upsertKeyQuote({ source: 'pricedb', buyScrap: 567, sellScrap: 570, observedAt: T0 });
    const clock = new FakeClock();
    const events = recordingEvents();
    const asked: ScraptfBank[] = [];
    const settings = mergeSettings(DEFAULT_SETTINGS, { notifications: { minConfidence: 0 } });
    const e = createEngine({
      ...makeDeps(repo, clock, () => settings),
      schema,
      events,
      timers: new FakeTimers(clock),
      recentBankSaveAt: (bank) => {
        asked.push(bank);
        return saves[bank] ?? null;
      },
    });
    const sku = '424;11;australium';
    repo.upsertListings(
      [0, 1, 2].map((i) =>
        makeListing({ id: `a-${i}`, sku, baseSku: sku, steamid: `SA-${i}`, metalScrap: 108 - i, isBot: i === 0, uaLastPulse: Math.floor(T0 / 1000), userOnline: true, lastEventAt: T0 - MIN }),
      ),
    );
    repo.upsertRule({ name: 'Australiums', filter: { defindexes: [424], australium: true }, costScrap: 60, observedAt: T0 - 60 * MIN });
    return { repo, e, events, asked };
  }

  it('holds the toast back when /buy/stranges and /buy/items were both saved within inputStaleMs', async () => {
    const h = engine({ stranges: T0 - 10 * MIN, items: T0 - 20 * MIN });
    await h.e.runNow();
    expect(h.events.notified).toEqual([]);
    expect(h.asked).toEqual(['stranges', 'items']);
    expect(h.repo.opportunitiesForSku('424;11;australium').map((o) => [o.inputKind, o.status])).toEqual([['rule', 'profitable']]);
  });

  it('still toasts when only one of them is fresh', async () => {
    for (const saves of [{ stranges: T0 - 10 * MIN }, { items: T0 - 10 * MIN }, { stranges: T0 - 10 * MIN, items: T0 - 3 * 60 * MIN }]) {
      const h = engine(saves);
      await h.e.runNow();
      expect(h.events.notified.map((n) => n.title), JSON.stringify(saves)).toEqual(['Candidate: Strange Australium Tomislav']);
    }
  });
});
