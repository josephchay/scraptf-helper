// 0.9 (#11): buyer signals read from data that already arrives (the feed's events and snapshot rows): a listing's
// status and archived flag (bptfListingActive), bp.tf's impersonation flag, object-form bans by the users/info rule
// (isBannedFromBans, moved to bptfItem.ts) and the bot service a client names (botServiceOf, a label only). Run over
// the 2026-10-14 capture (test/fixtures/bptf/ws-sample.json) and copies of its payloads. Nothing is fetched.

import { describe, expect, it } from 'vitest';
import { isBannedFromBans as isBannedFromBansApi } from '../../src/service/connectors/bptfApi';
import {
  bptfListingActive,
  createMapStats,
  isBannedFromBans,
  listingFromSnapshot,
  mapWsPayload,
  truthyBan,
} from '../../src/service/connectors/bptfItem';
import { BOT_SERVICES, botServiceOf, botServiceTitle } from '../../src/shared/buyerSeen';
import { createStubSchema, loadFixture, type WsEvent, type WsSample } from './helpers';

const NOW = Date.UTC(2026, 9, 14, 9, 12, 5);
const schema = createStubSchema();
const sample = loadFixture<WsSample>('ws-sample.json');
const events = sample.events;
const buyA = events.find((e) => e.event === 'listing-update' && e.payload.intent === 'buy')!;

/** A copy of buyA's payload with `over` merged in. */
function payloadWith(over: Record<string, unknown>): WsEvent['payload'] {
  return { ...structuredClone(buyA.payload), ...over };
}

/** buyA's payload with its user's `bans` replaced. */
function withBans(bans: unknown): WsEvent['payload'] {
  const p = structuredClone(buyA.payload) as WsEvent['payload'] & { user?: Record<string, unknown> };
  return { ...p, user: { ...(p.user ?? {}), banned: false, bans } };
}

describe('the capture: every event is live, and one is an impersonator', () => {
  const stats = createMapStats();
  const mapped = events.map((e, i) => ({ i, r: mapWsPayload(e.payload, schema, NOW, stats) }));

  it('maps all 299 events as active, counting no inactive listing and no unknown status', () => {
    expect(events).toHaveLength(299);
    for (const { i, r } of mapped) {
      expect(r.ok, `event ${i}`).toBe(true);
      if (r.ok) expect(r.active, `event ${i}`).toBe(true);
    }
    expect(stats.inactive).toBe(0);
    expect(stats.unknownShapes.status).toBeUndefined();
    expect(stats.mapped).toBe(299);
  });

  it('flags events[288] (user.flagImpersonated) as an impersonator, not as banned, and no other event', () => {
    const user = events[288]!.payload['user'] as Record<string, unknown>;
    expect(user['flagImpersonated']).toBe(true);
    const flagged = mapped.filter(({ r }) => r.ok && 'userImpersonated' in r.listing).map(({ i }) => i);
    expect(flagged).toEqual([288]);
    const r = mapped[288]!.r;
    expect(r.ok && r.listing.userImpersonated).toBe(true);
    expect(r.ok && r.listing.userBanned).toBe(false);
    expect(r.ok && r.listing.intent).toBe('buy');
  });

  it('only === true counts as the flag', () => {
    for (const v of [false, 1, 'true', null]) {
      const p = payloadWith({ user: { ...(buyA.payload['user'] as object), flagImpersonated: v } });
      const r = mapWsPayload(p, schema, NOW);
      expect(r.ok, String(v)).toBe(true);
      if (r.ok) expect('userImpersonated' in r.listing, String(v)).toBe(false);
    }
  });
});

describe('bptfListingActive: status and archived', () => {
  it('drops the known inactive statuses in any case and spacing, counting them', () => {
    const stats = createMapStats();
    for (const status of ['listingInactive', 'hiddenByUser', 'notEnoughCurrency', ' ARCHIVED ']) {
      const r = mapWsPayload(payloadWith({ status }), schema, NOW, stats);
      expect(r.ok, status).toBe(true);
      if (r.ok) {
        expect(r.active, status).toBe(false);
        // The name row is still learned for an inactive listing.
        expect(r.name.sku, status).toBe(r.listing.baseSku);
      }
    }
    expect(stats.inactive).toBe(4);
    expect(stats.unknownShapes.status).toBeUndefined();
  });

  it('keeps active and unknown statuses, counting the unknown ones as a shape', () => {
    const stats = createMapStats();
    const active = (over: Record<string, unknown>) => {
      const r = mapWsPayload(payloadWith(over), schema, NOW, stats);
      return r.ok ? r.active : null;
    };
    expect(active({ status: 'Active' })).toBe(true);
    expect(stats.unknownShapes.status).toBeUndefined();
    expect(active({ status: 'paused' })).toBe(true);
    expect(stats.unknownShapes.status).toBe(1);
    expect(active({ status: 3 })).toBe(true);
    expect(stats.unknownShapes.status).toBe(2);
    expect(active({ status: undefined })).toBe(true);
    expect(active({ status: null })).toBe(true);
    expect(stats.unknownShapes.status).toBe(2);
    expect(stats.inactive).toBe(0);
  });

  it('drops archived: true only', () => {
    const stats = createMapStats();
    const r = mapWsPayload(payloadWith({ archived: true }), schema, NOW, stats);
    expect(r.ok && r.active).toBe(false);
    expect(stats.inactive).toBe(1);
    const yes = mapWsPayload(payloadWith({ archived: 'yes' }), schema, NOW, stats);
    expect(yes.ok && yes.active).toBe(true);
    expect(stats.inactive).toBe(1);
    expect(bptfListingActive({ archived: false, status: 'active' })).toBe(true);
    expect(bptfListingActive({})).toBe(true);
  });

  it('skips a snapshot row bp.tf reports inactive, before mapping it', () => {
    const stats = createMapStats();
    const row = { steamid: '76561198000000001', intent: 'buy', item: { defindex: 378, quality: 6 } };
    expect(listingFromSnapshot({ ...row, status: 'listingInactive' }, schema, NOW, 'Team Captain', stats)).toBeNull();
    expect(stats.inactive).toBe(1);
    expect(stats.mapped).toBe(0);
    expect(stats.invalid).toBe(0);
    expect(listingFromSnapshot({ ...row, archived: true }, schema, NOW, 'Team Captain', stats)).toBeNull();
    expect(stats.inactive).toBe(2);
    const live = listingFromSnapshot({ ...row, status: 'active' }, schema, NOW, 'Team Captain', stats);
    expect(live?.sku).toBe('378;6');
    expect(stats.mapped).toBe(1);
  });
});

describe('bans: the users/info rule on the feed and snapshots (E-D6)', () => {
  const banned = (bans: unknown): boolean | null => {
    const r = mapWsPayload(withBans(bans), schema, NOW);
    return r.ok ? r.listing.userBanned : null;
  };

  it('counts only all, steamrep_scammer, marketplace and valve.economy in an object', () => {
    // 0.8 read any non-empty object as a ban.
    expect(banned({ steamrep_caution: 1 })).toBe(false);
    expect(banned({ vac: 1 })).toBe(false);
    expect(banned({ all: { end: -1 } })).toBe(true);
    expect(banned({ steamrep_scammer: 1 })).toBe(true);
    expect(banned({ marketplace: true })).toBe(true);
    expect(banned({ valve: { economy: 1 } })).toBe(true);
    expect(banned({ valve: { vac: 1 } })).toBe(false);
    expect(banned({ all: 0 })).toBe(false);
  });

  it('keeps the array form: any entry is a ban', () => {
    expect(banned([{ type: 'steamrep' }])).toBe(true);
    expect(banned([])).toBe(false);
    expect(banned(undefined)).toBe(false);
  });

  it('reads a snapshot row with the same rule', () => {
    const row = { steamid: '76561198000000001', intent: 'buy', item: { defindex: 378, quality: 6 } };
    const snap = (user: Record<string, unknown>) => listingFromSnapshot({ ...row, user }, schema, NOW, 'Team Captain');
    expect(snap({ bans: { steamrep_caution: 1 } })?.userBanned).toBe(false);
    expect(snap({ bans: { all: 1 } })?.userBanned).toBe(true);
    expect(snap({ flagImpersonated: true })?.userImpersonated).toBe(true);
    const plain = snap({});
    expect(plain).not.toBeNull();
    expect('userImpersonated' in plain!).toBe(false);
  });

  it('is one function, re-exported by bptfApi', () => {
    expect(isBannedFromBansApi).toBe(isBannedFromBans);
    expect(truthyBan('0')).toBe(false);
    expect(truthyBan('1')).toBe(true);
    expect(truthyBan([])).toBe(false);
    expect(truthyBan({ end: 1 })).toBe(true);
  });
});

describe('bot services (a label only)', () => {
  it('names the capture\'s services by the client text before " - "', () => {
    const tally: Record<string, number> = {};
    let unnamed = 0;
    let withAgent = 0;
    for (const e of events) {
      const ua = e.payload['userAgent'] as { client?: unknown } | undefined;
      if (!ua) continue;
      withAgent++;
      const label = botServiceOf(ua.client);
      if (label === null) {
        unnamed++;
        expect(String(ua.client).split(' - ')[0]).toBe('User Agent');
      } else tally[label] = (tally[label] ?? 0) + 1;
    }
    expect(withAgent).toBe(253);
    expect(tally).toEqual({
      'TF2Autobot (PriceDB)': 94,
      TF2Autobot: 61,
      'Gladiator.tf': 21,
      'cobra.tf': 16,
      Dolphin: 6,
      'Merchant.TF': 6,
      'Quicksell.store': 2,
    });
    expect(unnamed).toBe(47);
    expect(BOT_SERVICES).toHaveLength(7);
  });

  it('gives null for anything that is not a known client text', () => {
    for (const v of [undefined, '', 42, null, 'User Agent - v1', 'TF2Autobotx - y', 'my bot']) expect(botServiceOf(v), String(v)).toBeNull();
    expect(botServiceOf('TF2Autobot - Run your own bot for free')).toBe('TF2Autobot');
    expect(botServiceOf('  tf2autobotpricedb  ')).toBe('TF2Autobot (PriceDB)');
  });

  it('words the buyer icon hover', () => {
    expect(botServiceTitle({ isBot: false })).toBe('Human');
    expect(botServiceTitle({ isBot: false, botService: 'TF2Autobot' })).toBe('Human');
    expect(botServiceTitle({ isBot: true })).toBe('Bot (user agent)');
    expect(botServiceTitle({ isBot: true, botService: 'TF2Autobot' })).toBe('Bot (user agent: TF2Autobot)');
  });
});
