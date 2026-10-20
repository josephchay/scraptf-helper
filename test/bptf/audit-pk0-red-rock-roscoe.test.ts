// Audit schema-2: paintkit 0 (Red Rock Roscoe) is a real paintkit, so bp.tf
// listings for it must carry pk0 like PriceDB, the import and the resolver do.

import { describe, expect, it } from 'vitest';
import { listingFromSnapshot, mapWsPayload } from '../../src/service/connectors/bptfItem';
import { createSchemaService } from '../../src/service/connectors/schema';
import { createStubSchema, loadFixture, type WsEvent, type WsSample } from './helpers';
import { makeDeps, schemaRoute } from '../pricedb/helpers';

const NOW = Date.UTC(2026, 9, 14, 9, 12, 5);
const schema = createStubSchema();
const sample = loadFixture<WsSample>('ws-sample.json');

function nightOwl(): WsEvent {
  const e = sample.synthetic.find((x) => x.payload.id.includes('synthetic-skin'));
  if (!e) throw new Error('no synthetic skin event');
  return structuredClone(e);
}

function roscoe(extra: Record<string, unknown> = {}): WsEvent {
  const e = nightOwl();
  Object.assign(e.payload.item, {
    defindex: 15013,
    name: 'Red Rock Roscoe Pistol (Factory New)',
    marketName: 'Red Rock Roscoe Pistol (Factory New)',
    baseName: 'Pistol',
    texture: { id: 0, itemDefindex: 15013, name: 'Red Rock Roscoe' },
    wearTier: { id: 1, name: 'Factory New', short: 'FN' },
    ...extra,
  });
  return e;
}

function wsSku(e: WsEvent): { sku: string; baseSku: string } {
  const r = mapWsPayload(e.payload, schema, NOW);
  if (!r.ok) throw new Error(`mapping failed: ${r.detail}`);
  return { sku: r.listing.sku, baseSku: r.listing.baseSku };
}

function snapshot(attr834: Record<string, unknown> | null) {
  const attributes: Record<string, unknown>[] = [{ defindex: 725, float_value: 0.04 }];
  if (attr834) attributes.unshift({ defindex: 834, ...attr834 });
  return listingFromSnapshot(
    { intent: 'buy', steamid: '76561198000000001', currencies: { metal: 5 }, item: { defindex: 15013, quality: 15, attributes } },
    schema,
    NOW,
    'Red Rock Roscoe Pistol (Factory New)',
    undefined,
    '15013;15;w1;pk0',
  );
}

describe('Red Rock Roscoe (paintkit 0) on bp.tf listings', () => {
  it('keeps pk0 from the websocket texture', () => {
    expect(wsSku(roscoe())).toEqual({ sku: '15013;15;w1;pk0', baseSku: '15013;15;w1;pk0' });
  });

  it('keeps pk0 on a strange killstreak variant', () => {
    const e = roscoe({ elevatedQuality: { id: 11, name: 'Strange' }, killstreakTier: 3, name: 'Strange Professional Killstreak Red Rock Roscoe Pistol (Factory New)' });
    expect(wsSku(e).sku).toContain(';w1;pk0;strange;kt-3');
  });

  it('keeps pk0 from snapshot attribute 834 in every encoding', () => {
    for (const enc of [{ value: 0 }, { value: '0' }, { float_value: 0 }]) {
      const l = snapshot(enc);
      expect(l?.sku, JSON.stringify(enc)).toBe('15013;15;w1;pk0');
      expect(l?.baseSku, JSON.stringify(enc)).toBe('15013;15;w1;pk0');
    }
  });

  it('leaves the controls unchanged', () => {
    expect(wsSku(nightOwl()).sku).toBe('15000;15;w2;pk14');
    const noTexture = roscoe();
    delete noTexture.payload.item['texture'];
    expect(wsSku(noTexture).sku).not.toContain(';pk');
    expect(snapshot(null)?.sku).not.toContain(';pk');
  });

  it('matches the SKU the schema resolver gives the same name', async () => {
    const svc = createSchemaService(makeDeps(schemaRoute()));
    await svc.init();
    expect(svc.resolve('Red Rock Roscoe Pistol (Factory New)')?.sku).toBe(wsSku(roscoe()).sku);
  });
});
