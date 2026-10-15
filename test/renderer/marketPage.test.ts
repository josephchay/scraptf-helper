// F10 Live market wiring, checked statically (the renderer tests run in node,
// without a DOM): the nav entry and route, the only app methods the page
// calls, and the stylesheet's use of tokens and reduced motion.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVICE_METHODS, MAIN_METHODS } from '../../src/shared/rpc';

const read = (rel: string) => readFileSync(new URL(`../../src/renderer/${rel}`, import.meta.url), 'utf8');

describe('navigation', () => {
  const app = read('App.tsx');

  it('lists Live market second, right after Opportunities', () => {
    const ids = [...app.matchAll(/\{ id: '([a-z]+)', label: '([^']+)', icon: '([A-Za-z]+)' \}/g)].map((m) => [m[1], m[2], m[3]]);
    expect(ids[0]).toEqual(['opportunities', 'Opportunities', 'opps']);
    expect(ids[1]).toEqual(['market', 'Live market', 'market']);
    expect(ids.filter(([id]) => id === 'market')).toHaveLength(1);
  });

  it('routes and titles the page', () => {
    expect(app).toMatch(/type RouteId = [^;]*'market'/);
    expect(app).toMatch(/market: 'Live market',/);
    expect(app).toMatch(/case 'market':\s*return <MarketPage \/>;/);
    expect(read('components/Icon.tsx')).toMatch(/\n {2}market: \(/);
  });
});

describe('the page', () => {
  const page = read('pages/MarketPage.tsx');

  it('only reads the local index, exports and opens quick entry: no new traffic', () => {
    const methods = new Set([...page.matchAll(/rpc\('([a-zA-Z.]+)'/g)].map((m) => m[1]));
    expect([...methods].sort()).toEqual(['app.showQuickEntry', 'market.list', 'opps.exportCsv']);
    for (const m of methods) expect([...SERVICE_METHODS, ...MAIN_METHODS]).toContain(m);
    expect(page).toContain("kind: 'market'");
    expect(page).not.toMatch(/https?:\/\//);
    // The one link (F13): a coverage chip hands its bank page, from the service's coverage list, to the
    // user's own browser through links.open (openOrCopy). Nothing on the page fetches it.
    expect([...page.matchAll(/openOrCopy\(([^,]+),/g)].map((m) => m[1])).toEqual(['c.url']);
    expect(page).not.toMatch(/links\.open|openLink|fetch\(|XMLHttpRequest|new WebSocket/);
  });

  it('H2: reads the loaded window in one call; no chunked refresh, no snapshot pinning', () => {
    const model = read('marketModel.ts');
    const win = model.slice(model.indexOf('export function createMarketWindow'));
    expect(win).toContain('const readWindow = (q: Q, n: number): Promise<MarketListResult> => call({ ...q, ...windowRequest(n) });');
    expect(win).not.toMatch(/Promise\.all|windowRequests\(|mergeMarketPages/);
    expect(model).not.toMatch(/mergeMarketPages/);
    for (const src of [page, model]) expect(src).not.toMatch(/\bpin\b|repinned|\.version\b/);
  });

  it('H1: polls while a failed rebuild waits for its retry, and shows the error instead of "Building 0 %"', () => {
    expect(page).toContain('const pollMs = marketPollMs(result?.stats);');
    expect(page).toMatch(/useInterval\([\s\S]*?pollMs \?\? 0,\s*pollMs !== null && !frozen,\s*\);/);
    expect(page).toContain("case 'error':");
    expect(page).toMatch(/index && stats && index\.error \? \(\s*<IndexError/);
  });

  it('refetches on market.changed and prices.changed, throttled to 2 s and only while shown', () => {
    expect(page).toContain("usePush('market.changed'");
    expect(page).toContain("usePush('prices.changed'");
    expect(page).toMatch(/useThrottled\(\(\) => \{\s*if \(!frozenRef\.current\) win\.refresh\(\);\s*\}, 2000\)/);
    expect(page).toContain('createHiddenPushGate');
  });

  it('holds the window on Freeze (queued and in-flight refreshes too) and gates loading on it', () => {
    const toggle = page.slice(page.indexOf('const toggleFreeze'), page.indexOf('const onOpen'));
    expect(toggle).toMatch(/setFrozen\(true\);[\s\S]*win\.hold\(true\);[\s\S]*return;/);
    expect(toggle).toMatch(/win\.hold\(false\);\s*(\/\/.*\s*)*win\.refresh\(\);/);
    expect(page).toContain('frozen={frozen}');
  });

  it('keys the window on the minimum as typed, converting it with the key price per request', () => {
    // A key price move must not turn "1 key" into a new query (top of the list, Freeze bypassed).
    expect(page).not.toMatch(/readMinCeiling\(minText/);
    expect(page).toMatch(/readMinPrice\(minText\)/);
    expect(page).toMatch(/marketWindowQuery\(\{ \.\.\.filters, search \}, minPrice, sort\)/);
    expect(page).toContain("rpc('market.list', marketListParams(q, keyRef.current))");
  });
});

describe('market.css', () => {
  const css = readFileSync(new URL('../../src/renderer/styles/market.css', import.meta.url), 'utf8');

  it('takes every colour from the tokens', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\(/);
  });

  it('turns the flash animation off for reduced motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced.length).toBeGreaterThan(40);
    expect(reduced).toMatch(/\.market-row\.flash-up,\s*\.market-row\.flash-down\s*\{\s*animation: none !important;/);
  });
});
