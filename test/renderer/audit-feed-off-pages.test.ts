// 0.7.3 (follow-up to xdocs-10): with the live feed off, the 'snapshot-watched' job still refreshes the
// items you price or hold (with an access token), so the Live market's live dot, banner and empty state,
// the Holdings banner and the Opportunities empty states no longer say the market "only changes when you
// refresh items by hand". They share FEED_OFF_UPDATES, which is the Settings switch's own wording
// (audit-feed-off-wording.test.ts pins the behaviour). Rendered server-side, or read as source. No network.

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppProvider } from '../../src/renderer/hooks/appContext';
import { FEED_OFF_UPDATES, marketLiveState } from '../../src/renderer/marketModel';
import { NoResults } from '../../src/renderer/pages/OpportunitiesPage';
import { FeedSection } from '../../src/renderer/pages/SettingsPage';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import type { Settings } from '../../src/shared/types';

const strip = (html: string) => html.replace(/<!-- -->/g, '');
const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');
const BY_HAND = /refresh(?:es)? (?:items )?by hand/;
const noop = () => undefined;

describe('the shared feed-off sentence', () => {
  it("is the Settings switch's own description of what still updates", () => {
    const off: Settings = { ...DEFAULT_SETTINGS, liveFeed: { ...DEFAULT_SETTINGS.liveFeed, enabled: false } };
    const html = strip(renderToString(createElement(AppProvider, null, createElement(FeedSection, { s: off }))));
    expect(html).toContain(`When off, ${FEED_OFF_UPDATES} (`);
    expect(FEED_OFF_UPDATES).toContain('when you refresh an item');
    expect(FEED_OFF_UPDATES).toContain('for the items you price or hold');
  });

  it("is the Live market's Feed off dot", () => {
    const s = marketLiveState('live', false, true);
    expect(s).toMatchObject({ state: 'off', label: 'Feed off' });
    expect(s.title).toBe(`The backpack.tf live feed is off (Settings): ${FEED_OFF_UPDATES}.`);
    expect(s.title).not.toMatch(BY_HAND);
  });
});

describe('the Opportunities empty states', () => {
  const render = (p: { reason: 'nothing-yet' | 'status-hidden'; hiddenCount: number; noToken?: boolean }) =>
    strip(renderToString(createElement(AppProvider, null, createElement(NoResults, { reason: p.reason, hiddenCount: p.hiddenCount, paused: false, feedOff: true, noToken: p.noToken ?? false, onReset: noop, onAllStatuses: noop }))));

  it('the feed-off state names the background refresh, and the token it needs', () => {
    const html = render({ reason: 'nothing-yet', hiddenCount: 0 });
    expect(html).toContain(`Without it, ${FEED_OFF_UPDATES}.`);
    expect(html).not.toMatch(BY_HAND);
    expect(render({ reason: 'nothing-yet', hiddenCount: 0, noToken: true })).toContain('Refreshing an item needs that token too (Settings).');
  });

  it('the status-hidden note does too', () => {
    const html = render({ reason: 'status-hidden', hiddenCount: 12 });
    expect(html).toContain(`The live feed is off, so ${FEED_OFF_UPDATES}.`);
    expect(html).not.toMatch(BY_HAND);
  });
});

describe('the Live market and Holdings pages', () => {
  it('use the shared sentence for the feed-off banners and empty state', () => {
    const market = read('pages/MarketPage.tsx');
    expect(market).not.toMatch(BY_HAND);
    expect(market).toContain('The live feed is off, so {FEED_OFF_UPDATES}.');
    expect(market).toContain("The market is built from backpack.tf&apos;s live buy-order feed. Without it, {FEED_OFF_UPDATES}.");
    const holdings = read('pages/HoldingsPage.tsx');
    expect(holdings).not.toMatch(BY_HAND);
    expect(holdings).toContain('The live feed is off, so {FEED_OFF_UPDATES}.');
    expect(read('marketModel.ts')).not.toMatch(BY_HAND);
    expect(read('pages/OpportunitiesPage.tsx')).not.toMatch(BY_HAND);
  });
});
