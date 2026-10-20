// 0.7.3 audit (rmarket-2): the empty Opportunities list blames the paused network or the live feed
// only when there is no opportunity at all, as the Live market's emptyMarketReason does. With
// opportunities stored, a search or filter that matches nothing says so (with Reset filters), and the
// default "profitable only" view says nothing is profitable (with Show every status). Rendered
// server-side (no effects run, so the first-run branch stays out). No network.

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppProvider } from '../../src/renderer/hooks/appContext';
import { FEED_OFF_UPDATES } from '../../src/renderer/marketModel';
import { DEFAULT_FILTERS, emptyListReason, type EmptyListReason } from '../../src/renderer/oppModel';
import { NoResults } from '../../src/renderer/pages/OpportunitiesPage';

const strip = (html: string) => html.replace(/<!-- -->/g, '');
const noop = () => undefined;

function render(p: { reason: EmptyListReason; hiddenCount: number; paused?: boolean; feedOff?: boolean }): string {
  const props = { reason: p.reason, hiddenCount: p.hiddenCount, paused: p.paused ?? false, feedOff: p.feedOff ?? false, noToken: false, onReset: noop, onAllStatuses: noop };
  return strip(renderToString(createElement(AppProvider, null, createElement(NoResults, props))));
}

describe('the empty Opportunities list with opportunities stored', () => {
  it('counts a typed search as a filter', () => {
    expect(emptyListReason({ ...DEFAULT_FILTERS, status: [...DEFAULT_FILTERS.status], search: 'xyz' }, 200)).toBe('filters');
  });

  it('says the filters hide them while the live feed is off', () => {
    const html = render({ reason: 'filters', hiddenCount: 200, feedOff: true });
    expect(html).toContain('Nothing matches these filters');
    expect(html).toContain('Reset filters');
    expect(html).not.toContain('The live feed is off');
  });

  it('says the filters hide them while the network is paused', () => {
    const html = render({ reason: 'filters', hiddenCount: 200, paused: true });
    expect(html).toContain('Nothing matches these filters');
    expect(html).not.toContain('The network is paused');
  });

  it('says nothing is profitable, with Show every status, while paused and with the feed off', () => {
    const html = render({ reason: 'status-hidden', hiddenCount: 200, paused: true, feedOff: true });
    expect(html).toContain('Nothing is profitable right now');
    expect(html).toContain('Show every status');
    expect(html).not.toContain('The network is paused');
    expect(html).not.toContain('Turn on live feed');
  });

  it('still names the live feed as the likely cause when it is off', () => {
    expect(render({ reason: 'status-hidden', hiddenCount: 200, feedOff: true })).toContain(`The live feed is off, so ${FEED_OFF_UPDATES}.`);
    expect(render({ reason: 'status-hidden', hiddenCount: 200 })).not.toContain('The live feed is off');
  });
});

describe('the empty Opportunities list with no opportunity at all', () => {
  it('still blames the pause, then the feed, before "nothing to show yet"', () => {
    expect(render({ reason: 'nothing-yet', hiddenCount: 0, paused: true })).toContain('The network is paused');
    expect(render({ reason: 'nothing-yet', hiddenCount: 0, feedOff: true })).toContain('The live feed is off');
    expect(render({ reason: 'filters', hiddenCount: 0, feedOff: true })).toContain('The live feed is off');
    expect(render({ reason: 'nothing-yet', hiddenCount: 0 })).toContain('Nothing to show yet');
  });
});
