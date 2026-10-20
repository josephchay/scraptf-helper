// 0.7.3: the Live log's Export CSV tooltip says what the file holds. The service reads the newest
// EVENTS_EXPORT_MAX events of the chosen kinds and only then applies the category and search, so older
// matching events (kept for 90 days) are not in it. The tooltip may not promise every matching event.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

describe('Live log Export CSV tooltip', () => {
  const page = root('src/renderer/pages/LogPage.tsx');
  const handlers = root('src/service/rpcHandlers.ts');
  const button = /<button[^>]*title=\{`([^`]*)`\}[^>]*onClick=\{\(\) => void exportCsv\(\)\}/.exec(page);
  const title = button ? button[1]! : '';

  it('describes the window the search runs over, not every matching event', () => {
    expect(title).not.toBe('');
    expect(title).not.toMatch(/\bevery event\b/i);
    expect(title).toContain('among the newest ${fmtInt(EVENTS_EXPORT_MAX)} of the chosen kinds');
  });

  it('stays true while the service filters the newest EVENTS_EXPORT_MAX of the kinds', () => {
    expect(handlers).toMatch(/repo\.listEvents\(withoutUndefined\(\{ limit: EVENTS_EXPORT_MAX, kinds \}\)\)\.filter\(/);
  });
});
