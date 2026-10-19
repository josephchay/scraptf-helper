// F21 contract in the service: 'import.html' takes an optional `address` (an https page on exactly
// scrap.tf, a page-address hint, never fetched) and `origin` ('file' | 'window'), which main sets for a
// read of the scrap.tf window. Bad values are refused with fixed text that never quotes them. What the
// import does with them is the service owner's (bank detection, ImportBatch.origin).

import { describe, expect, it, vi } from 'vitest';
import { createRpcHandlers, type HandlerContext } from '../../src/service/rpcHandlers';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { SCRAPTF_BANKS } from '../../src/shared/links';
import type { PushEvent } from '../../src/shared/rpc';

const MARKER = 'Zq7-MARKER';
const HATS = SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url;

function handlers() {
  // Import stays off, so a call that passes validation stops at the import switch, before any parsing.
  const ctx = {
    clock: { now: () => 1_791_958_000_000 },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: () => DEFAULT_SETTINGS,
    push: (_event: PushEvent, _payload: unknown) => undefined,
  } as unknown as HandlerContext;
  return createRpcHandlers(ctx);
}

const page = { html: '<html></html>', fileName: 'scrap.tf window /buy/hats', mtimeMs: 1_791_958_000_000 };

describe("'import.html' address and origin params", () => {
  it('accepts a scrap.tf page address and either origin, and none', async () => {
    const rpc = handlers();
    for (const extra of [{}, { origin: 'file' }, { origin: 'window', address: HATS }, { address: 'https://scrap.tf/items/2?sort=1' }]) {
      await expect(rpc('import.html', { ...page, ...extra }), JSON.stringify(extra)).rejects.toThrow(/turned off/);
    }
  });

  it('refuses any other address or origin with a fixed message', async () => {
    const rpc = handlers();
    const addresses: unknown[] = [
      `http://scrap.tf/${MARKER}`,
      `https://www.scrap.tf/${MARKER}`,
      `https://evil.example/${MARKER}`,
      `https://u@scrap.tf/${MARKER}`,
      `file:///C:/${MARKER}`,
      `https://scrap.tf/${'a'.repeat(4100)}`,
      42,
      null,
    ];
    for (const address of addresses) {
      const msg = await rpc('import.html', { ...page, address }).then(
        () => null,
        (e: unknown) => (e as Error).message,
      );
      expect(msg, String(address).slice(0, 60)).toMatch(/^Invalid parameters for import\.html: address/);
      expect(msg).not.toContain('Zq7');
    }
    for (const origin of ['browser', MARKER, 1, null]) {
      const msg = await rpc('import.html', { ...page, origin }).then(
        () => null,
        (e: unknown) => (e as Error).message,
      );
      expect(msg).toMatch(/^Invalid parameters for import\.html: origin/);
      expect(msg).not.toContain('Zq7');
    }
  });
});
