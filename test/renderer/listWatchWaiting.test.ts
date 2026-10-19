// 0.7.1 step I (P3, C's watch gate + E's setup notes): while the item schema loads, the service reports the
// folder watch as WATCH_WAITING_FOR_SCHEMA. The price-list card, the banks page and the bank stock page show
// it as a muted wait with no action (the watch starts by itself), not as a red "Watch error" asking for
// another folder, and they re-read the status soon. Pure helpers checked as data.

import { describe, expect, it } from 'vitest';
import { WATCH_WAITING_FOR_SCHEMA as CORE_WAITING } from '../../src/service/core';
import { LIST_POLL_MS, LIST_STARTING_POLL_MS, listPollMs, listSetupNote, listSetupState, listStepsAutoOpen } from '../../src/renderer/scraptfListModel';
import { WATCH_WAITING_FOR_SCHEMA } from '../../src/shared/scraptfList';
import type { ScraptfListStatus } from '../../src/shared/types';

function status(over: Partial<ScraptfListStatus> = {}): ScraptfListStatus {
  return { items: 0, newestAt: null, oldestAt: null, pages: 0, importEnabled: true, watchFolder: 'D:\\saves', watchActive: false, watchError: WATCH_WAITING_FOR_SCHEMA, ...over };
}

describe('the folder watch waiting for item data', () => {
  it('is the same text the service reports', () => {
    expect(CORE_WAITING).toBe(WATCH_WAITING_FOR_SCHEMA);
  });

  it('is a wait, with or without the window, and never a watch error', () => {
    for (const windowOn of [false, true]) expect(listSetupState(status(), windowOn)).toBe('watch-waiting');
    for (const placement of ['market', 'import', 'banks'] as const) {
      expect(listSetupNote('watch-waiting', placement)).toEqual({
        tone: 'muted',
        text: 'Waiting for item data to load; the folder watch starts by itself once it has.',
        action: null,
        actionLabel: null,
      });
    }
    // A real error still reads as one.
    expect(listSetupState(status({ watchError: 'Folder not found' }))).toBe('watch-error');
    // No folder or import off still come first.
    expect(listSetupState(status({ watchFolder: null }))).toBe('no-folder');
    expect(listSetupState(status({ importEnabled: false }))).toBe('import-off');
  });

  it('re-reads the status soon while waiting, and keeps the steps open as for any unfinished setup', () => {
    expect(listPollMs(status())).toBe(LIST_STARTING_POLL_MS);
    expect(listPollMs(status({ watchActive: true, watchError: null }))).toBe(LIST_POLL_MS);
    expect(listStepsAutoOpen(status())).toBe(true);
    expect(listStepsAutoOpen(status(), true)).toBe(false);
  });
});
