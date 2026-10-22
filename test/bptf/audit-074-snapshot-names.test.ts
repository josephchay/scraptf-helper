// 0.7.4 (F74): snapshot names. A kit or tool SKU without its target ("Kit", then "The Kit") names no item anyone
// lists: refused before any call. After an empty book, the second call goes only to a spelling backpack.tf
// uses: "The" dropped, or added before a plain Unique item and after "Non-Craftable " for a festivized one
// ("Non-Craftable The Festivized Blutsauger"); never before a quality, effect, paintkit or killstreak prefix.
// Same budget, fewer calls; nothing new is requested. Real schema fixture; a fake HTTP client.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SNAPSHOT_URL, bptfNameVariant, createBptfApi } from '../../src/service/connectors/bptfApi';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { Repo, SchemaService } from '../../src/service/contracts';
import { openRepo } from '../../src/service/db';
import { makeDeps, schemaRoute } from '../pricedb/helpers';
import { FakeHttp, createLogger, jsonResponse, settingsWith, type HttpCall } from './helpers';

const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const TOKEN = 'tok_SECRET_0123456789abcdef';

let schema: SchemaService;
beforeAll(async () => {
  schema = createSchemaService(makeDeps(schemaRoute()));
  await schema.init();
});

const repos: Repo[] = [];
afterEach(() => {
  while (repos.length) repos.pop()!.close();
});

const nameOf = (c: HttpCall): string | null => new URL(c.fullUrl).searchParams.get('sku');

function api() {
  const repo = openRepo(':memory:');
  repos.push(repo);
  const http = new FakeHttp((call) =>
    call.url === SNAPSHOT_URL ? jsonResponse(200, { id: null, appid: 440, sku: nameOf(call), createdAt: 1791958000, listings: [] }) : { status: 404, data: null },
  );
  const bptf = createBptfApi({
    clock: { now: () => T0 },
    log: createLogger(),
    repo,
    http,
    settings: () => settingsWith(),
    secret: (n) => (n === 'bptfAccessToken' ? TOKEN : null),
    schema,
  });
  return { bptf, http };
}

describe('bptfNameVariant', () => {
  it.each([
    ['Team Captain', '378;6', 'The Team Captain'],
    ['The Team Captain', '378;6', 'Team Captain'],
    ['Festivized Wrangler', '140;6;festive', 'The Festivized Wrangler'],
    ['Non-Craftable Festivized Blutsauger', '36;6;uncraftable;festive', 'Non-Craftable The Festivized Blutsauger'],
    ['Non-Craftable Team Captain', '378;6;uncraftable', null],
    ['Burning Flames Team Captain', '378;5;u13', null],
    ['Strange Pain Train', '154;11', null],
    ['Civil Servant Mk.II Disciplinary Action (Field-Tested)', '447;15;w3;pk139', null],
    ['Professional Killstreak Rocket Launcher', '205;6;kt-3', null],
  ])('%j (%s) -> %j', (name, sku, want) => {
    expect(bptfNameVariant(name, sku)).toBe(want);
  });

  it('keeps a leading "The" that belongs to the effect name', () => {
    expect(bptfNameVariant('The Ooze Team Captain', '378;5;u35', 'The Ooze')).toBeNull();
    expect(bptfNameVariant('The Mega Strike Taunt: The Bunnyhopper', '30920;5;u3010', 'Mega Strike')).toBe('Mega Strike Taunt: The Bunnyhopper');
  });
});

describe('snapshots spend no call on a name no listing can have', () => {
  it('refuses a kit without its target before any request', async () => {
    const { bptf, http } = api();
    await expect(bptf.snapshot('6527;6', 'user')).rejects.toThrow(/without its target/);
    expect(http.calls).toHaveLength(0);
  });

  it('asks once for an unusual whose book is empty, twice for a proper-name Non-Craftable festivized item', async () => {
    const one = api();
    await one.bptf.snapshot('378;5;u13', 'user');
    expect(one.http.calls.map(nameOf)).toEqual(['Burning Flames Team Captain']);
    const two = api();
    await two.bptf.snapshot('36;6;uncraftable;festive', 'user');
    expect(two.http.calls.map(nameOf)).toEqual(['Non-Craftable Festivized Blutsauger', 'Non-Craftable The Festivized Blutsauger']);
  });
});
