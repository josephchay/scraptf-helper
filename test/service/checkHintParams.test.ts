// F19 contract in the service: 'check.text' accepts an optional hint { sku } (main's, while a check.arm
// is unexpired) under the service's SKU rule, with fixed messages that never quote the text. What the
// live check does with the hint is pinned with the evaluation (S2).

import { describe, expect, it, vi } from 'vitest';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { blankCheckResult, CHECK_NOT_ITEM_REASON } from '../../src/shared/check';
import type { PushEvent } from '../../src/shared/rpc';

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const MARKER = 'Zq7-SECRET-MARKER';

function handlers() {
  const check = vi.fn((_t: string, source, now: number) => blankCheckResult('not-item', CHECK_NOT_ITEM_REASON, source, now, 1));
  const ctx = {
    clock: { now: () => NOW },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    liveCheck: { check, recent: () => [] },
    push: (_event: PushEvent, _payload: unknown) => undefined,
  } as unknown as HandlerContext;
  return { rpc: createRpcHandlers(ctx), check };
}

describe("'check.text' hint params", () => {
  it('accepts a valid hint, and none', async () => {
    const h = handlers();
    await h.rpc('check.text', { text: '1.33 ref', source: 'hotkey', hint: { sku: ' 378;6 ' } });
    await h.rpc('check.text', { text: '1.33 ref', source: 'watch' });
    expect(h.check).toHaveBeenCalledTimes(2);
  });

  it('rejects an invalid hint SKU with a fixed message, never the text', async () => {
    const h = handlers();
    const bad: unknown[] = [{ sku: MARKER }, { sku: '' }, { sku: '378;6;uncratable' }, { sku: 378 }, {}, MARKER, null, [MARKER]];
    for (const hint of bad) {
      const err = await h.rpc('check.text', { text: `${MARKER} 1.33 ref`, source: 'hotkey', hint }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(err?.message, JSON.stringify(hint)).toMatch(/^Invalid parameters for check\.text: hint/);
      expect(err?.message).not.toContain('Zq7');
    }
    expect(h.check).not.toHaveBeenCalled();
  });
});
