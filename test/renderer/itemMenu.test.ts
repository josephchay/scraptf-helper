// F9: the row context menu's pure model (placement, roving focus, content).

import { describe, expect, it } from 'vitest';
import {
  MENU_MARGIN,
  MODAL_SELECTOR,
  copiedMessage,
  copyTargets,
  flattenSections,
  groupLinks,
  hostLabel,
  isContextMenuKey,
  isEnabledItem,
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

  it('stays inside the margin when flipping is not enough', () => {
    // Too far left to flip, too high to flip up: pinned to the margins.
    const p = placeMenu({ x: 100, y: 100 }, { width: 240, height: 760 }, { width: 300, height: 800 });
    expect(p.left).toBeGreaterThanOrEqual(MENU_MARGIN);
    expect(p.left + 240).toBeLessThanOrEqual(300 - MENU_MARGIN);
    expect(p.top).toBe(MENU_MARGIN);
  });

  it('caps a menu taller than the window and pins it to the top margin', () => {
    const p = placeMenu({ x: 50, y: 400 }, { width: 240, height: 2000 }, VIEW);
    expect(p.top).toBe(MENU_MARGIN);
    expect(p.maxHeight).toBe(VIEW.height - 2 * MENU_MARGIN);
  });

  it('never returns a position outside the viewport, for any pointer', () => {
    for (const x of [-50, 0, 1, 600, 1199, 1200, 5000, Number.NaN]) {
      for (const y of [-50, 0, 1, 400, 799, 800, 5000, Number.POSITIVE_INFINITY]) {
        const p = placeMenu({ x, y }, MENU, VIEW);
        expect(p.left).toBeGreaterThanOrEqual(MENU_MARGIN);
        expect(p.top).toBeGreaterThanOrEqual(MENU_MARGIN);
        expect(p.left + MENU.width).toBeLessThanOrEqual(VIEW.width - MENU_MARGIN);
        expect(p.top + MENU.height).toBeLessThanOrEqual(VIEW.height - MENU_MARGIN);
      }
    }
  });

  it('survives a tiny window', () => {
    const p = placeMenu({ x: 5, y: 5 }, MENU, { width: 10, height: 10 });
    expect(p).toEqual({ left: MENU_MARGIN, top: MENU_MARGIN, maxHeight: 0 });
  });
});

describe('keyboard opening', () => {
  it('recognises Shift+F10 and the ContextMenu key only', () => {
    expect(isContextMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true);
    expect(isContextMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(isContextMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
    expect(isContextMenuKey({ key: 'Enter', shiftKey: true })).toBe(false);
  });

  it('places a keyboard-opened menu inside the focused row', () => {
    expect(menuPointForRect({ left: 200, top: 300, width: 600, height: 34 })).toEqual({ x: 224, y: 328 });
    expect(menuPointForRect({ left: 10, top: 10, width: 20, height: 10 })).toEqual({ x: 20, y: 20 });
  });

  it('keeps a real pointer position', () => {
    expect(resolveMenuPoint({ x: 400, y: 200 }, { left: 0, top: 0, width: 50, height: 20 }, VIEW)).toEqual({ x: 400, y: 200 });
  });

  it('falls back to the focused element for a 0,0 (keyboard) contextmenu event, else near the top', () => {
    expect(resolveMenuPoint({ x: 0, y: 0 }, { left: 100, top: 50, width: 300, height: 30 }, VIEW)).toEqual({ x: 124, y: 78 });
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
