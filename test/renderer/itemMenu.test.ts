// F9: the row context menu's pure model (placement, roving focus, content).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MENU_ANCHOR_SLACK_PX,
  MENU_MARGIN,
  MODAL_SELECTOR,
  RECORD_BUY_TITLE,
  RECORD_SALE_TITLE,
  anchorMoved,
  copiedMessage,
  copyTargets,
  createMenuClosePolicy,
  flattenSections,
  groupLinks,
  hostLabel,
  isContextMenuKey,
  isEnabledItem,
  isScrollKey,
  itemMenuSections,
  menuPointForRect,
  modalHostOf,
  placeMenu,
  resolveMenuPoint,
  stepIndex,
  typeaheadIndex,
  type ItemMenuAction,
  type MenuSection,
} from '../../src/renderer/itemMenuModel';
import type { LinkSpec } from '../../src/shared/types';

const VIEW = { width: 1200, height: 800 };
const MENU = { width: 240, height: 300 };

describe('placeMenu', () => {
  it('opens right of and below the pointer when it fits', () => {
    expect(placeMenu({ x: 100, y: 120 }, MENU, VIEW)).toEqual({ left: 100, top: 120, maxHeight: 800 - 2 * MENU_MARGIN });
  });

  it('flips left at the right edge and up at the bottom edge', () => {
    const p = placeMenu({ x: 1150, y: 700 }, MENU, VIEW);
    expect(p.left).toBe(1150 - 240);
    expect(p.top).toBe(700 - 300);
  });

  it('H4: opens upward with its bottom edge at the pointer when it does not fit below', () => {
    // A row near the bottom: the menu sits right above the pointer, not pinned to the top margin over the row.
    const p = placeMenu({ x: 100, y: 600 }, MENU, VIEW);
    expect(p.top + MENU.height).toBe(600);
    expect(p.top).toBe(300);
    expect(p.maxHeight).toBe(VIEW.height - 2 * MENU_MARGIN);
  });

  it('H4: a menu too tall for either side takes the roomier one and scrolls, never covering the pointer', () => {
    // More room below: opens down from the pointer with a scrollbar.
    const down = placeMenu({ x: 100, y: 100 }, { width: 240, height: 760 }, { width: 300, height: 800 });
    expect(down.left).toBeGreaterThanOrEqual(MENU_MARGIN);
    expect(down.left + 240).toBeLessThanOrEqual(300 - MENU_MARGIN);
    expect(down.top).toBe(100);
    expect(down.maxHeight).toBe(800 - MENU_MARGIN - 100);
    // More room above: opens up, bottom at the pointer, capped to the room above.
    const up = placeMenu({ x: 50, y: 500 }, { width: 240, height: 2000 }, VIEW);
    expect(up.top).toBe(MENU_MARGIN);
    expect(up.maxHeight).toBe(500 - MENU_MARGIN);
    expect(up.top + up.maxHeight).toBe(500);
  });

  it('never returns a position outside the viewport, for any pointer', () => {
    for (const size of [MENU, { width: 240, height: 760 }, { width: 2000, height: 2000 }]) {
      for (const x of [-50, 0, 1, 600, 1199, 1200, 5000, Number.NaN]) {
        for (const y of [-50, 0, 1, 400, 799, 800, 5000, Number.POSITIVE_INFINITY]) {
          for (const upY of [undefined, y - 30, Number.NaN]) {
            const p = placeMenu(upY === undefined ? { x, y } : { x, y, upY }, size, VIEW);
            const shown = Math.min(size.height, p.maxHeight);
            const w = Math.min(size.width, VIEW.width - 2 * MENU_MARGIN);
            expect(p.left).toBeGreaterThanOrEqual(MENU_MARGIN);
            expect(p.top).toBeGreaterThanOrEqual(MENU_MARGIN);
            expect(p.left + w).toBeLessThanOrEqual(VIEW.width - MENU_MARGIN);
            expect(p.top + shown).toBeLessThanOrEqual(VIEW.height - MENU_MARGIN);
            expect(p.maxHeight).toBeLessThanOrEqual(VIEW.height - 2 * MENU_MARGIN);
          }
        }
      }
    }
  });

  it('H4: never covers the point it opened at, wherever that is inside the margins', () => {
    for (const height of [120, 300, 500, 760, 2000]) {
      for (let y = MENU_MARGIN; y <= VIEW.height - MENU_MARGIN; y += 37) {
        const p = placeMenu({ x: 300, y }, { width: 240, height }, VIEW);
        const bottom = p.top + Math.min(height, p.maxHeight);
        // Either entirely below the pointer or entirely above it.
        expect(p.top >= y || bottom <= y, `height ${height}, y ${y}`).toBe(true);
      }
    }
  });

  it('H4: a menu hung under a button or opened from the keyboard flips up above it (upY), not over it', () => {
    // The drawer's buyer button: y under it, upY at its top. Near the bottom it opens above the button.
    const btn = placeMenu({ x: 300, y: 702, upY: 676 }, MENU, VIEW);
    expect(btn.top + MENU.height).toBe(676);
    // Room below: upY plays no part.
    expect(placeMenu({ x: 300, y: 202, upY: 176 }, MENU, VIEW).top).toBe(202);
    // A keyboard-opened menu near the bottom ends at the row's top edge.
    const row = menuPointForRect({ left: 0, top: 660, width: 900, height: 34 });
    const kb = placeMenu(row, MENU, VIEW);
    expect(kb.top + MENU.height).toBe(660);
    // Too tall for either side: capped to the room above the button.
    const tall = placeMenu({ x: 300, y: 702, upY: 676 }, { width: 240, height: 2000 }, VIEW);
    expect(tall.top).toBe(MENU_MARGIN);
    expect(tall.top + tall.maxHeight).toBe(676);
  });

  it('H4: an upY below the pointer (or junk) never pushes the menu over the pointer', () => {
    for (const upY of [900, 600, Number.NaN]) expect(placeMenu({ x: 300, y: 600, upY }, MENU, VIEW).top + MENU.height, String(upY)).toBe(600);
    // An anchor whose top is off screen leaves no room above: it opens below with a scrollbar instead.
    const off = placeMenu({ x: 300, y: 600, upY: -40 }, MENU, VIEW);
    expect(off.top).toBe(600);
    expect(off.maxHeight).toBe(VIEW.height - MENU_MARGIN - 600);
  });

  it('survives a tiny window', () => {
    const p = placeMenu({ x: 5, y: 5 }, MENU, { width: 10, height: 10 });
    expect(p).toEqual({ left: MENU_MARGIN, top: MENU_MARGIN, maxHeight: 0 });
  });
});

describe('closing on scroll (H4)', () => {
  const OPENED = 10_000;
  const at = (ms: number) => OPENED + ms;

  it('closes on a wheel, a touch drag or a scroll key outside the menu', () => {
    const p = createMenuClosePolicy({ left: 10, top: 100 }, OPENED);
    expect(p.closes({ type: 'wheel', inside: false })).toBe(true);
    expect(p.closes({ type: 'touchmove', inside: false })).toBe(true);
    for (const key of ['PageDown', 'PageUp', 'Home', 'End', 'ArrowDown', 'ArrowUp', ' ']) expect(p.closes({ type: 'key', key, inside: false }), key).toBe(true);
  });

  it('ignores the same inside the menu (it scrolls itself), other keys, chords and typing in a field', () => {
    const p = createMenuClosePolicy({ left: 10, top: 100 }, OPENED);
    expect(p.closes({ type: 'wheel', inside: true })).toBe(false);
    expect(p.closes({ type: 'touchmove', inside: true })).toBe(false);
    expect(p.closes({ type: 'key', key: 'PageDown', inside: true })).toBe(false);
    expect(p.closes({ type: 'key', key: 'a', inside: false })).toBe(false);
    expect(p.closes({ type: 'key', key: 'Enter', inside: false })).toBe(false);
    expect(p.closes({ type: 'key', key: 'End', inside: false, ctrlKey: true })).toBe(false);
    expect(p.closes({ type: 'key', key: ' ', inside: false, editable: true })).toBe(false);
    expect(isScrollKey({ key: 'PageDown' })).toBe(true);
    expect(isScrollKey({ key: 'Tab' })).toBe(false);
  });

  it('does not close on a bare scroll event that leaves the anchor where it was (a programmatic smooth scroll)', () => {
    const p = createMenuClosePolicy({ left: 10, top: 100 }, OPENED);
    expect(p.closes({ type: 'scroll', inside: false, anchor: { left: 10, top: 100 }, at: at(1000) })).toBe(false);
    // Up to 4 px is jitter (sub-pixel layout, scroll anchoring after a live refresh).
    expect(p.closes({ type: 'scroll', inside: false, anchor: { left: 14, top: 96 }, at: at(1100) })).toBe(false);
    expect(MENU_ANCHOR_SLACK_PX).toBe(4);
  });

  it('closes when a scroll moves the anchor more than 4 px, or takes it away', () => {
    const p = createMenuClosePolicy({ left: 10, top: 100 }, OPENED);
    expect(p.closes({ type: 'scroll', inside: false, anchor: { left: 10, top: 105 }, at: at(1000) })).toBe(true);
    expect(createMenuClosePolicy({ left: 10, top: 100 }, OPENED).closes({ type: 'scroll', inside: false, anchor: { left: 4, top: 100 }, at: at(1000) })).toBe(true);
    expect(createMenuClosePolicy({ left: 10, top: 100 }, OPENED).closes({ type: 'scroll', inside: false, anchor: null, at: at(1000) })).toBe(true);
    // A scroll of the menu itself never does.
    expect(createMenuClosePolicy({ left: 10, top: 100 }, OPENED).closes({ type: 'scroll', inside: true, anchor: null, at: at(1000) })).toBe(false);
  });

  it('lets the row be scrolled into view right after opening, then measures from there', () => {
    const p = createMenuClosePolicy({ left: 10, top: 100 }, OPENED);
    // The click that opened the menu selected the row and the page scrolled it into view.
    expect(p.closes({ type: 'scroll', inside: false, anchor: { left: 10, top: 60 }, at: at(50) })).toBe(false);
    expect(p.closes({ type: 'scroll', inside: false, anchor: { left: 10, top: 62 }, at: at(1000) })).toBe(false);
    expect(p.closes({ type: 'scroll', inside: false, anchor: { left: 10, top: 100 }, at: at(1100) })).toBe(true);
  });

  it('without an anchor only a user scroll closes it', () => {
    const p = createMenuClosePolicy(null, OPENED);
    expect(p.closes({ type: 'scroll', inside: false, anchor: null, at: at(5000) })).toBe(false);
    expect(p.closes({ type: 'wheel', inside: false })).toBe(true);
  });

  it('anchorMoved compares both axes against the slack', () => {
    expect(anchorMoved(null, null)).toBe(false);
    expect(anchorMoved({ left: 0, top: 0 }, null)).toBe(true);
    expect(anchorMoved({ left: 0, top: 0 }, { left: 4, top: -4 })).toBe(false);
    expect(anchorMoved({ left: 0, top: 0 }, { left: 0, top: 4.5 })).toBe(true);
    expect(anchorMoved({ left: 0, top: 0 }, { left: 10, top: 0 }, 20)).toBe(false);
  });
});

describe('keyboard opening', () => {
  it('recognises Shift+F10 and the ContextMenu key only', () => {
    expect(isContextMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true);
    expect(isContextMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(isContextMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
    expect(isContextMenuKey({ key: 'Enter', shiftKey: true })).toBe(false);
  });

  it('places a keyboard-opened menu inside the focused row, and above the row when it flips up', () => {
    expect(menuPointForRect({ left: 200, top: 300, width: 600, height: 34 })).toEqual({ x: 224, y: 328, upY: 300 });
    expect(menuPointForRect({ left: 10, top: 10, width: 20, height: 10 })).toEqual({ x: 20, y: 20, upY: 10 });
  });

  it('keeps a real pointer position', () => {
    expect(resolveMenuPoint({ x: 400, y: 200 }, { left: 0, top: 0, width: 50, height: 20 }, VIEW)).toEqual({ x: 400, y: 200 });
    // A button-anchored point keeps where an upward menu ends.
    expect(resolveMenuPoint({ x: 400, y: 200, upY: 170 }, null, VIEW)).toEqual({ x: 400, y: 200, upY: 170 });
  });

  it('falls back to the focused element for a 0,0 (keyboard) contextmenu event, else near the top', () => {
    expect(resolveMenuPoint({ x: 0, y: 0 }, { left: 100, top: 50, width: 300, height: 30 }, VIEW)).toEqual({ x: 124, y: 78, upY: 50 });
    expect(resolveMenuPoint({ x: 0, y: 0 }, null, VIEW)).toEqual({ x: 600, y: 200 });
    expect(resolveMenuPoint({ x: Number.NaN, y: 5 }, null, VIEW)).toEqual({ x: 600, y: 200 });
  });
});

describe('portal host', () => {
  // A stand-in for Element.closest: the chain of ancestors, nearest first.
  const node = (chain: { name: string; modal: boolean }[]) => ({
    closest: (sel: string) => {
      expect(sel).toBe(MODAL_SELECTOR);
      return chain.find((n) => n.modal)?.name ?? null;
    },
  });

  it('keeps a menu opened inside the drawer (aria-modal) in the drawer', () => {
    expect(modalHostOf(node([{ name: 'row', modal: false }, { name: 'drawer', modal: true }]))).toBe('drawer');
  });

  it('uses document.body (null here) for page rows and for no opener', () => {
    expect(modalHostOf(node([{ name: 'row', modal: false }]))).toBeNull();
    expect(modalHostOf(null)).toBeNull();
    expect(modalHostOf(undefined)).toBeNull();
  });
});

describe('roving focus', () => {
  const enabled = [true, false, true, true, false];

  it('moves with the arrows, wrapping and skipping disabled items', () => {
    expect(stepIndex(enabled, 0, 'ArrowDown')).toBe(2);
    expect(stepIndex(enabled, 3, 'ArrowDown')).toBe(0);
    expect(stepIndex(enabled, 0, 'ArrowUp')).toBe(3);
    expect(stepIndex(enabled, 2, 'ArrowUp')).toBe(0);
  });

  it('starts at the first or last enabled item when nothing is active', () => {
    expect(stepIndex(enabled, -1, 'ArrowDown')).toBe(0);
    expect(stepIndex(enabled, -1, 'ArrowUp')).toBe(3);
  });

  it('jumps with Home and End and ignores other keys', () => {
    expect(stepIndex(enabled, 3, 'Home')).toBe(0);
    expect(stepIndex(enabled, 0, 'End')).toBe(3);
    expect(stepIndex(enabled, 2, 'Enter')).toBe(2);
  });

  it('returns -1 when nothing can take focus', () => {
    expect(stepIndex([false, false], 0, 'ArrowDown')).toBe(-1);
    expect(stepIndex([], -1, 'Home')).toBe(-1);
  });

  it('type-ahead finds the next enabled item starting with the letter', () => {
    const labels = ['Open details', 'Copy SKU', 'Copy name', 'Copy backpack.tf name', 'Classifieds'];
    const on = [true, true, false, true, true];
    expect(typeaheadIndex(labels, on, 0, 'c')).toBe(1);
    expect(typeaheadIndex(labels, on, 1, 'C')).toBe(3);
    expect(typeaheadIndex(labels, on, 3, 'c')).toBe(4);
    expect(typeaheadIndex(labels, on, 4, 'c')).toBe(1);
    expect(typeaheadIndex(labels, on, 2, 'z')).toBe(2);
    expect(typeaheadIndex(labels, on, 0, 'ab')).toBe(0);
  });
});

describe('copy targets', () => {
  it('copies the SKU, the name and the backpack.tf name', () => {
    expect(copyTargets({ sku: '5021;6', name: 'Mann Co. Supply Crate Key', bptfName: 'Mann Co. Supply Crate Key' }).map((c) => [c.label, c.text])).toEqual([
      ['Copy SKU', '5021;6'],
      ['Copy name', 'Mann Co. Supply Crate Key'],
      ['Copy backpack.tf name', 'Mann Co. Supply Crate Key'],
    ]);
  });

  it('falls back to the name when the row has no backpack.tf name', () => {
    const t = copyTargets({ sku: '200;11;kt-3', name: 'Strange Professional Killstreak Scattergun' });
    expect(t.find((c) => c.kind === 'bptf')?.text).toBe('Strange Professional Killstreak Scattergun');
    expect(copyTargets({ sku: '1;6', name: ' ', bptfName: '' }).map((c) => c.text)).toEqual(['1;6', '1;6', '1;6']);
  });

  it('says what was copied, briefly', () => {
    expect(copiedMessage('5021;6', true)).toBe('Copied 5021;6');
    expect(copiedMessage('x'.repeat(200), true).length).toBeLessThan(100);
    expect(copiedMessage('5021;6', false)).toBe('Could not copy to the clipboard.');
  });
});

const LINKS: LinkSpec[] = [
  { id: 'bp-stats', label: 'Stats', url: 'https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable', group: 'backpack' },
  { id: 'mptf', label: 'Marketplace.tf', url: 'https://marketplace.tf/items/tf2/378;6', group: 'market' },
  { id: 'bp-class', label: 'Classifieds', url: 'https://backpack.tf/classifieds?item=Team%20Captain', group: 'backpack' },
  { id: 'pricedb', label: 'PriceDB', url: 'https://pricedb.io/item/378%3B6', group: 'tools' },
];

describe('item menu content', () => {
  const target = { sku: '378;6', name: 'Team Captain', bptfName: 'The Team Captain' };
  const actionsOf = (sections: MenuSection<ItemMenuAction>[]) => flattenSections(sections).map((i) => [i.label, i.action]);

  it('lists Open details, the copy actions and Record scrap.tf price first, in that order', () => {
    const items = flattenSections(itemMenuSections(target, { status: 'loading' }));
    expect(items.slice(0, 5).map((i) => i.label)).toEqual(['Open details', 'Copy SKU', 'Copy name', 'Copy backpack.tf name', 'Record scrap.tf price…']);
    expect(actionsOf(itemMenuSections(target, { status: 'loading' })).slice(0, 5)).toEqual([
      ['Open details', { kind: 'details' }],
      ['Copy SKU', { kind: 'copy', text: '378;6' }],
      ['Copy name', { kind: 'copy', text: 'Team Captain' }],
      ['Copy backpack.tf name', { kind: 'copy', text: 'The Team Captain' }],
      ['Record scrap.tf price…', { kind: 'quick-entry' }],
    ]);
  });

  it('offers Record buy… and Record sale… (the journal, F12) right after Record scrap.tf price', () => {
    const items = flattenSections(itemMenuSections(target, { status: 'loading' }));
    expect(items.slice(4, 7).map((i) => [i.label, i.action])).toEqual([
      ['Record scrap.tf price…', { kind: 'quick-entry' }],
      ['Record buy…', { kind: 'record', side: 'buy' }],
      ['Record sale…', { kind: 'record', side: 'sell' }],
    ]);
    const trade = itemMenuSections(target, { status: 'loading' }).find((s) => s.id === 'trade')!;
    expect(trade.items.every(isEnabledItem)).toBe(true);
    expect(trade.items.map((i) => i.title)).toEqual([RECORD_BUY_TITLE, RECORD_SALE_TITLE]);
    // Writes the journal only: the wording never promises a trade.
    for (const t of [RECORD_BUY_TITLE, RECORD_SALE_TITLE]) expect(t).toMatch(/Nothing is (bought|sold)\./);
  });

  it('shows a disabled placeholder while the links load or when they fail', () => {
    const loading = flattenSections(itemMenuSections(target, { status: 'loading' })).at(-1)!;
    expect(loading.label).toBe('Loading links…');
    expect(isEnabledItem(loading)).toBe(false);
    const failed = flattenSections(itemMenuSections(target, { status: 'error', message: 'Service restarting' })).at(-1)!;
    expect(failed.label).toBe('Links unavailable');
    expect(failed.title).toBe('Service restarting');
    expect(isEnabledItem(failed)).toBe(false);
    const none = flattenSections(itemMenuSections(target, { status: 'ready', links: [] })).at(-1)!;
    expect(isEnabledItem(none)).toBe(false);
  });

  it('adds the link groups in the generator order, each link opening its own URL', () => {
    const sections = itemMenuSections(target, { status: 'ready', links: LINKS });
    expect(sections.filter((s) => s.id.startsWith('links-')).map((s) => [s.label, s.items.map((i) => i.label)])).toEqual([
      ['backpack.tf', ['Stats', 'Classifieds']],
      ['Markets', ['Marketplace.tf']],
      ['Tools', ['PriceDB']],
    ]);
    const links = flattenSections(sections).filter((i) => i.action?.kind === 'link');
    expect(links.map((i) => (i.action as { url: string }).url)).toEqual([LINKS[0]!.url, LINKS[2]!.url, LINKS[1]!.url, LINKS[3]!.url]);
    expect(links.every(isEnabledItem)).toBe(true);
    expect(links[0]!.hint).toBe('backpack.tf');
    expect(links[0]!.title).toBe(LINKS[0]!.url);
  });

  it('gives every item a unique id (React keys, roving focus)', () => {
    const ids = flattenSections(itemMenuSections(target, { status: 'ready', links: LINKS })).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never builds a link action from anything but links.forSku', () => {
    // Only the URLs the service returned are opened; the menu adds none of its own.
    const urls = flattenSections(itemMenuSections(target, { status: 'ready', links: LINKS }))
      .map((i) => i.action)
      .filter((a): a is { kind: 'link'; url: string } => a?.kind === 'link')
      .map((a) => a.url);
    expect(urls.sort()).toEqual(LINKS.map((l) => l.url).sort());
  });
});

describe('link helpers', () => {
  it('groups links by first appearance', () => {
    expect(groupLinks(LINKS).map((g) => g.group)).toEqual(['backpack', 'market', 'tools']);
    expect(groupLinks([])).toEqual([]);
  });

  it('labels hosts without www', () => {
    expect(hostLabel('https://www.backpack.tf/stats')).toBe('backpack.tf');
    expect(hostLabel('not a url')).toBe('');
  });
});

describe('item menu wiring (F12 record entries, H4 closing)', () => {
  const menu = readFileSync(new URL('../../src/renderer/components/ItemMenu.tsx', import.meta.url), 'utf8');
  const drawer = readFileSync(new URL('../../src/renderer/pages/ItemDrawer.tsx', import.meta.url), 'utf8');

  it('prefills Record buy / Record sale from the local item.detail, newest click only, nothing after the page is left', () => {
    // History off: a local read, no PriceDB request.
    expect(menu).toContain("rpc('item.detail', { sku: target.sku, history: false })");
    expect(menu).toMatch(/if \(recordGate\.isCurrent\(ticket\)\) openRecord\.current\(recordTradeInit\(side, target, d, profit\.current\)\)/);
    expect(menu).toContain('useEffect(() => () => recordGate.cancel(), [recordGate]);');
    // A failed read still opens the dialog, without a price.
    expect(menu).toMatch(/\.catch\(\(\): ItemDetail \| null => null\)/);
    expect(menu).toContain('{recordTrade.element}');
  });

  it('closes on user scrolling and on an anchor that moved, not on any scroll event', () => {
    for (const ev of ["'wheel'", "'touchmove'", "'keydown'", "'scroll'"]) expect(menu).toContain(`window.addEventListener(${ev}`);
    expect(menu).not.toMatch(/SCROLL_GRACE_MS/);
    expect(menu).toContain('createMenuClosePolicy(boxOf(anchorEl), performance.now())');
    // The row, not the cell text a live refresh may replace.
    expect(menu).toContain(`hit.closest('[role="row"], tr') ?? hit`);
  });

  it('hangs the drawer buyer menu from its button: it flips up above the button, not over it', () => {
    expect(drawer).toContain('openMenu(o, { x: r.right, y: r.bottom + 2, upY: r.top - 2 }, e.currentTarget);');
    expect(drawer).toContain('anchor={menu.anchor}');
  });
});
