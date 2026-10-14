// schema.resolve on typed SKUs: upper case is lower-cased, and tokens fromString
// would silently drop make the text "not a SKU" instead of another item.

import { beforeAll, describe, expect, it } from 'vitest';
import { createSchemaService } from '../../src/service/connectors/schema';
import type { SchemaService } from '../../src/service/contracts';
import { makeDeps, schemaRoute } from './helpers';

let svc: SchemaService;

beforeAll(async () => {
  svc = createSchemaService(makeDeps(schemaRoute()));
  await svc.init();
});

describe('resolve with typed SKUs', () => {
  it.each([
    ['205;11;KT-3', '205;11;kt-3'],
    ['378;6;UNCRAFTABLE', '378;6;uncraftable'],
    ['378;5;U13', '378;5;u13'],
    ['15000;15;W1;PK14', '15000;15;w1;pk14'],
    ['https://marketplace.tf/items/tf2/378;5;U13', '378;5;u13'],
  ])('reads %s as %s', (text, sku) => {
    const r = svc.resolve(text);
    expect(r).toMatchObject({ sku, match: 'sku' });
  });

  it('keeps the killstreak and craftability of an upper-case SKU', () => {
    expect(svc.resolve('205;11;KT-3')!.skuObject).toMatchObject({ killstreak: 3 });
    expect(svc.resolve('378;6;UNCRAFTABLE')!.skuObject).toMatchObject({ craftable: false });
  });

  it.each(['378;6;uncratable', '378;6;foo', '378;5;u13;u14', 'https://marketplace.tf/items/tf2/378;6;uncratable'])(
    'does not silently drop tokens from %s',
    (text) => {
      expect(svc.resolve(text)).toBeNull();
    },
  );
});
