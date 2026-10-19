// UX-5 (0.7.1): the "scrap.tf price list" card and the setup notes with the opt-in scrap.tf window on. The
// window imports what it reads without a watch folder, so a missing folder is an optional, muted note,
// the save steps no longer open by themselves, and "Open in Flip Desk window" (scrap.tf/items, on a click
// only) comes first; "Open scrap.tf/items" (the browser) goes when main sends the links there anyway.
// Pure helpers checked as data, the card rendered server-side. Nothing leaves the process.

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScraptfListCardView, type ScraptfListCardViewProps } from '../../src/renderer/components/ScraptfListCard';
import {
  FIRST_PRICE_LEAD,
  LIST_BOUNDARY_NOTE,
  LIST_BOUNDARY_NOTE_WINDOW,
  SCRAPTF_ITEMS_PATH,
  firstPriceText,
  listBoundaryNote,
  listSetupNote,
  listSetupState,
  listStepsAutoOpen,
  listWindowOpenHint,
} from '../../src/renderer/scraptfListModel';
import type { ScraptfListStatus } from '../../src/shared/types';

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const MIN = 60_000;
const noop = () => undefined;

function status(over: Partial<ScraptfListStatus> = {}): ScraptfListStatus {
  return { items: 2341, newestAt: T0 - 3 * MIN, oldestAt: T0 - 3 * MIN, pages: 1, importEnabled: true, watchFolder: 'D:\\saves', watchActive: true, watchError: null, ...over };
}

describe('the setup state with the window on', () => {
  it('a missing folder is optional: its own state, and a muted note with the folder dialog', () => {
    const noFolder = status({ watchFolder: null, watchActive: false });
    expect(listSetupState(noFolder)).toBe('no-folder');
    expect(listSetupState(noFolder, false)).toBe('no-folder');
    expect(listSetupState(noFolder, true)).toBe('window-only');
    for (const placement of ['market', 'import', 'banks'] as const) {
      const note = listSetupNote('window-only', placement)!;
      expect(note.tone).toBe('muted');
      expect(note.text).toMatch(/^No watch folder: optional while you read pages in the Flip Desk window\. Choose one to also import /);
      expect(note).toMatchObject({ action: 'pick-folder', actionLabel: 'Choose a watch folder' });
    }
    expect(listSetupNote('window-only', 'banks')!.text).toContain('the scrap.tf pages you save with Ctrl+S');
    expect(listSetupNote('window-only', 'market')!.text).toContain('scrap.tf/items when you save it with Ctrl+S');
  });

  it('everything else reads as before, the window on or off', () => {
    for (const windowOn of [false, true]) {
      expect(listSetupState(status({ importEnabled: false }), windowOn)).toBe('import-off');
      expect(listSetupState(status(), windowOn)).toBe('ready');
      expect(listSetupState(status({ watchActive: false, watchError: 'Folder not found' }), windowOn)).toBe('watch-error');
      expect(listSetupState(status({ watchActive: false }), windowOn)).toBe('watch-starting');
    }
  });

  it('the save steps no longer open by themselves with the window on', () => {
    const never = status({ items: 0, newestAt: null, watchFolder: null, watchActive: false });
    expect(listStepsAutoOpen(never)).toBe(true);
    expect(listStepsAutoOpen(never, false)).toBe(true);
    expect(listStepsAutoOpen(never, true)).toBe(false);
    expect(listStepsAutoOpen(status(), true)).toBe(false);
  });

  it('says where the data comes from, true with the window on', () => {
    expect(listBoundaryNote(false)).toBe(LIST_BOUNDARY_NOTE);
    expect(listBoundaryNote(true)).toBe(LIST_BOUNDARY_NOTE_WINDOW);
    expect(LIST_BOUNDARY_NOTE_WINDOW).toBe('Flip Desk never loads scrap.tf on its own. You open it, in your browser or the Flip Desk window, and you choose when.');
    expect(SCRAPTF_ITEMS_PATH).toBe('scrap.tf/items');
    expect(listWindowOpenHint(true)).toContain('In the Flip Desk window it is read as it loads');
    expect(listWindowOpenHint(false)).toContain('read when you press Read page now');
  });

  it('first run leads with one save of scrap.tf/items (UX-4)', () => {
    expect(FIRST_PRICE_LEAD).toBe('Save scrap.tf/items once to price every item scrap.tf trades');
    expect(firstPriceText(false)).toBe('Save scrap.tf/items once to price every item scrap.tf trades.');
    expect(firstPriceText(true)).toBe('Save scrap.tf/items once to price every item scrap.tf trades, or browse it in the Flip Desk window.');
  });
});

function view(over: Partial<ScraptfListCardViewProps> = {}): string {
  const props: ScraptfListCardViewProps = {
    placement: 'market',
    boundaryNote: true,
    status: status(),
    error: null,
    now: T0,
    stepsOpen: false,
    picking: false,
    onToggleSteps: noop,
    onOpenList: noop,
    onCopyPath: noop,
    onPickFolder: noop,
    onGoImport: noop,
    onRetry: noop,
    ...over,
  };
  return renderToString(createElement(ScraptfListCardView, props)).replace(/<!-- -->/g, '').replace(/&#x27;/g, "'");
}

const WINDOW = { linksHere: false, readOnLoad: true };

describe('the card with the window on', () => {
  it('without it: Open scrap.tf/items only, as before', () => {
    const html = view();
    expect(html).toContain('Open scrap.tf/items');
    expect(html).not.toContain('Open in Flip Desk window');
  });

  it('with it: the window button first, then the browser one, on the head and in the steps', () => {
    const head = view({ scraptfWindow: WINDOW });
    expect(head).toContain('aria-label="Open in Flip Desk window: scrap.tf/items"');
    expect(head.indexOf('Open in Flip Desk window')).toBeLessThan(head.indexOf('Open scrap.tf/items'));
    const steps = view({ scraptfWindow: WINDOW, stepsOpen: true });
    expect(steps).toContain(listWindowOpenHint(true));
    expect(steps).toContain('Or, in your browser, press <kbd>Ctrl</kbd>+<kbd>S</kbd>');
    expect(steps).toContain(LIST_BOUNDARY_NOTE_WINDOW);
    expect(steps).not.toContain(LIST_BOUNDARY_NOTE);
    // The window button is the primary one.
    expect(steps).toMatch(/class="btn small sl-open-window primary"/);
  });

  it("drops the browser button when Flip Desk's scrap.tf links open in the window anyway", () => {
    const html = view({ scraptfWindow: { ...WINDOW, linksHere: true }, stepsOpen: true });
    expect(html).toContain('Open in Flip Desk window');
    expect(html).not.toContain('Open scrap.tf/items');
  });

  it('a missing folder is the muted optional note, not the info one', () => {
    const html = view({ scraptfWindow: WINDOW, status: status({ watchFolder: null, watchActive: false }) });
    expect(html).toContain('sl-note tone-muted');
    expect(html).toContain('No watch folder: optional while you read pages in the Flip Desk window.');
    expect(view({ status: status({ watchFolder: null, watchActive: false }) })).toContain('No watch folder yet.');
  });

  it('import off disables the window button too', () => {
    const html = view({ scraptfWindow: WINDOW, status: status({ importEnabled: false }) });
    expect(html).toMatch(/<button type="button" class="btn small sl-open-window" disabled=""/);
  });
});
