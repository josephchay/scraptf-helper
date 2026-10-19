import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NOTIFY_BODY_MAX,
  NOTIFY_TITLE_MAX,
  NOTIFY_URL_MAX,
  clip,
  droppedOpenUrl,
  handleNotificationClick,
  notificationContent,
  notificationOpenUrl,
  notificationOptions,
  type NotificationClickDeps,
} from '../../src/main/notify';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { SCRAPTF_BANKS, STATIC_EXTERNAL_URLS } from '../../src/shared/links';
import { scraptfResaveNotice } from '../../src/shared/scraptfHistory';
import { SCRAPTF_BANK_IDS } from '../../src/shared/types';

describe('notificationContent', () => {
  it('keeps a valid push and its SKU', () => {
    expect(notificationContent({ title: 'Profit: Team Captain', body: '+1 ref', sku: '378;6' })).toEqual({ title: 'Profit: Team Captain', body: '+1 ref', sku: '378;6' });
  });

  it('drops malformed pushes and tolerates a bad SKU', () => {
    expect(notificationContent(null)).toBeNull();
    expect(notificationContent({ title: '', body: 'x', sku: null })).toBeNull();
    expect(notificationContent({ title: 'x', body: 3 })).toBeNull();
    expect(notificationContent({ title: 'x', body: 'y', sku: 42 })).toEqual({ title: 'x', body: 'y', sku: null });
  });

  it('clips the title and body to what a toast shows', () => {
    const out = notificationContent({ title: 'T'.repeat(500), body: 'B'.repeat(2000), sku: null });
    expect(out?.title).toHaveLength(NOTIFY_TITLE_MAX);
    expect(out?.body).toHaveLength(NOTIFY_BODY_MAX);
    expect(out?.title.endsWith('...')).toBe(true);
    expect(clip('short', 10)).toBe('short');
  });
});

describe('notificationOptions (F6 silent)', () => {
  const data = { title: 'Candidate: Team Captain', body: 'Check scrap.tf, pay up to 1.22 ref' };

  it('passes notifications.silent to the Electron Notification', () => {
    expect(notificationOptions(data, { silent: true }, 'C:\\icon.png')).toEqual({ ...data, icon: 'C:\\icon.png', silent: true });
    expect(notificationOptions(data, { silent: false }, 'icon.png').silent).toBe(false);
  });

  it('plays the sound by default', () => {
    expect(DEFAULT_SETTINGS.notifications.silent).toBe(false);
    expect(notificationOptions(data, DEFAULT_SETTINGS.notifications, 'icon.png').silent).toBe(false);
    // A settings file from before v0.2 has no silent key at all.
    expect(notificationOptions(data, {} as { silent: boolean }, 'icon.png').silent).toBe(false);
  });
});

// F20: a re-save reminder's 'notify' carries openUrl, a static scrap.tf bank page. Main keeps it only when it
// is exactly a SCRAPTF_BANKS URL the links allowlist accepts, checks it again at click time, and hands it to
// the user's browser (shell.openExternal, faked here). Nothing in these tests touches the network.
const BANK_URLS = SCRAPTF_BANKS.map((b) => b.url);
const HATS = SCRAPTF_BANKS.find((b) => b.bank === 'hats')!.url;
const LIST = SCRAPTF_BANKS.find((b) => b.bank === 'list')!.url;
const ITEM_NAME = 'Team Captain';
const REFUSED: readonly unknown[] = [
  // Allowlisted static pages that are not a bank page.
  ...STATIC_EXTERNAL_URLS.filter((u) => !BANK_URLS.includes(u)),
  // Other scrap.tf paths and other spellings of a bank page.
  `${HATS}/`,
  `${HATS}?sort=price`,
  `${HATS}#top`,
  `${HATS}/2`,
  `${LIST}/2`,
  HATS.toUpperCase(),
  HATS.replace('https:', 'http:'),
  HATS.replace('https://', 'https://user@'),
  HATS.replace('https://', 'https://www.'),
  HATS.replace('.tf/', '.tf:443/'),
  HATS.replace('.tf/', '.tf.example.com/'),
  HATS.replace('https://', 'https:\\\\'),
  ` ${HATS}`,
  `${HATS}\n`,
  // URLs built from item data.
  `${HATS}/${encodeURIComponent(ITEM_NAME)}`,
  `${HATS}?q=${encodeURIComponent(ITEM_NAME)}`,
  // Other hosts, allowlisted ones included.
  'https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable',
  'https://steamcommunity.com/market/listings/440/Team%20Captain',
  'https://example.com/',
  // Schemes the OS shell would run or open locally.
  'javascript:alert(1)',
  'JAVASCRIPT:alert(1)',
  'file:///C:/Windows/System32/calc.exe',
  'file://server/share/page.html',
  'data:text/html,<b>x</b>',
  'ms-settings:privacy',
  // Not a URL at all.
  '',
  'x'.repeat(NOTIFY_URL_MAX + 1),
  42,
  null,
  { href: HATS },
];

function fakeClick(openFails = false) {
  const calls: string[] = [];
  const warnings: { msg: string; meta: unknown }[] = [];
  const deps: NotificationClickDeps = {
    openExternal: (url) => {
      calls.push(`openExternal ${url}`);
      return openFails ? Promise.reject(new Error('no browser')) : Promise.resolve();
    },
    openItem: (sku) => calls.push(`openItem ${sku}`),
    showDashboard: () => calls.push('showDashboard'),
    log: { warn: (msg, meta) => warnings.push({ msg, meta }) },
  };
  return { deps, calls, warnings };
}

describe('notificationOpenUrl (F20)', () => {
  it('accepts every static bank page, each also on the links allowlist', () => {
    expect(BANK_URLS.length).toBeGreaterThan(0);
    for (const url of BANK_URLS) {
      expect(STATIC_EXTERNAL_URLS).toContain(url);
      expect(notificationOpenUrl(url), url).toBe(url);
    }
  });

  it('refuses other scrap.tf paths, other hosts, item-built URLs, javascript: and file:', () => {
    for (const url of REFUSED) expect(notificationOpenUrl(url), String(url).slice(0, 80)).toBeNull();
  });
});

describe('notificationContent openUrl (F20)', () => {
  it('keeps a static bank page', () => {
    const push = { title: 'Re-save scrap.tf/buy/hats', body: 'Last saved 1 h 05 m ago.', sku: null, openUrl: HATS };
    expect(notificationContent(push)).toEqual(push);
  });

  it('keeps the toast but drops any other openUrl, the key itself included', () => {
    for (const openUrl of REFUSED) {
      const out = notificationContent({ title: 'Re-save', body: 'b', sku: '378;6', openUrl });
      expect(out, String(openUrl).slice(0, 80)).toEqual({ title: 'Re-save', body: 'b', sku: '378;6' });
      expect(out !== null && 'openUrl' in out).toBe(false);
    }
  });

  it('leaves a push without openUrl as it was', () => {
    const out = notificationContent({ title: 'Profit: Team Captain', body: '+1 ref', sku: '378;6' });
    expect(out).toEqual({ title: 'Profit: Team Captain', body: '+1 ref', sku: '378;6' });
    expect(out !== null && 'openUrl' in out).toBe(false);
  });

  it('droppedOpenUrl tells main a link was refused on receipt', () => {
    const kept = { title: 't', body: 'b', sku: null, openUrl: HATS };
    const bad = { title: 't', body: 'b', sku: null, openUrl: 'javascript:alert(1)' };
    const plain = { title: 't', body: 'b', sku: null };
    expect(droppedOpenUrl(kept, notificationContent(kept)!)).toBe(false);
    expect(droppedOpenUrl(bad, notificationContent(bad)!)).toBe(true);
    expect(droppedOpenUrl(plain, notificationContent(plain)!)).toBe(false);
    expect(droppedOpenUrl({ ...plain, openUrl: undefined }, notificationContent(plain)!)).toBe(false);
  });
});

describe('handleNotificationClick (F20)', () => {
  it('opens a static bank page in the browser, and nothing else', async () => {
    for (const url of BANK_URLS) {
      const { deps, calls, warnings } = fakeClick();
      const data = notificationContent({ title: 'Re-save', body: 'b', sku: null, openUrl: url })!;
      await expect(handleNotificationClick(data, deps)).resolves.toBe('url');
      expect(calls).toEqual([`openExternal ${url}`]);
      expect(warnings).toEqual([]);
    }
  });

  it('checks again at click time: a refused URL never reaches openExternal and the click acts as before', async () => {
    for (const openUrl of REFUSED) {
      if (typeof openUrl !== 'string') continue;
      // The payload as main holds it, without the receipt check (or altered after it).
      const withSku = fakeClick();
      await expect(handleNotificationClick({ title: 't', body: 'b', sku: '378;6', openUrl }, withSku.deps)).resolves.toBe('item');
      expect(withSku.calls).toEqual(['openItem 378;6']);
      const noSku = fakeClick();
      await expect(handleNotificationClick({ title: 't', body: 'b', sku: null, openUrl }, noSku.deps)).resolves.toBe('dashboard');
      expect(noSku.calls).toEqual(['showDashboard']);
      // Logged once, without the URL (it may carry item data).
      expect(noSku.warnings).toHaveLength(1);
      const logged = JSON.stringify(noSku.warnings);
      if (openUrl.trim().length > 0) expect(logged).not.toContain(JSON.stringify(openUrl.slice(0, 40)).slice(1, -1));
      expect(logged).not.toContain(ITEM_NAME);
      expect(logged).not.toContain(encodeURIComponent(ITEM_NAME));
    }
  });

  it("opens the service's re-save reminder for every bank: payload kept whole, link to that bank's static page", async () => {
    // The service builds the reminder with the shared scraptfResaveNotice; main must accept exactly that.
    const now = 1_792_000_000_000;
    for (const bank of SCRAPTF_BANK_IDS) {
      const push = scraptfResaveNotice(bank, now - 65 * 60_000, now)!;
      expect(push, bank).not.toBeNull();
      const data = notificationContent(push)!;
      // Nothing clipped, nothing dropped, so main logs nothing on receipt.
      expect(data, bank).toEqual(push);
      expect(droppedOpenUrl(push, data)).toBe(false);
      const { deps, calls, warnings } = fakeClick();
      await expect(handleNotificationClick(data, deps)).resolves.toBe('url');
      expect(calls).toEqual([`openExternal ${SCRAPTF_BANKS.find((b) => b.bank === bank)!.url}`]);
      expect(warnings).toEqual([]);
    }
  });

  it('re-checks a payload altered after receipt', async () => {
    const data = notificationContent({ title: 'Re-save', body: 'b', sku: null, openUrl: HATS })!;
    data.openUrl = `${HATS}/${encodeURIComponent(ITEM_NAME)}`;
    const { deps, calls } = fakeClick();
    await expect(handleNotificationClick(data, deps)).resolves.toBe('dashboard');
    expect(calls).toEqual(['showDashboard']);
  });

  it('keeps the old click behaviour without openUrl: the item, else the dashboard', async () => {
    const item = fakeClick();
    await expect(handleNotificationClick(notificationContent({ title: 'Profit', body: '+1 ref', sku: '378;6' })!, item.deps)).resolves.toBe('item');
    expect(item.calls).toEqual(['openItem 378;6']);
    expect(item.warnings).toEqual([]);
    const dash = fakeClick();
    await expect(handleNotificationClick(notificationContent({ title: 'Status', body: 'x', sku: null })!, dash.deps)).resolves.toBe('dashboard');
    expect(dash.calls).toEqual(['showDashboard']);
    expect(dash.warnings).toEqual([]);
    // An empty SKU is no item, as before.
    const empty = fakeClick();
    await expect(handleNotificationClick({ title: 't', body: 'b', sku: '' }, empty.deps)).resolves.toBe('dashboard');
    expect(empty.calls).toEqual(['showDashboard']);
  });

  it('falls back to the dashboard when the browser does not open, and never rejects', async () => {
    const { deps, calls, warnings } = fakeClick(true);
    await expect(handleNotificationClick({ title: 't', body: 'b', sku: null, openUrl: HATS }, deps)).resolves.toBe('dashboard');
    expect(calls).toEqual([`openExternal ${HATS}`, 'showDashboard']);
    expect(warnings).toHaveLength(1);
    const sync = fakeClick();
    sync.deps.openExternal = () => {
      throw new Error('boom');
    };
    await expect(handleNotificationClick({ title: 't', body: 'b', sku: null, openUrl: HATS }, sync.deps)).resolves.toBe('dashboard');
    expect(sync.calls).toEqual(['showDashboard']);
  });
});

describe('main.ts notification click wiring (F20)', () => {
  // main.ts imports Electron, so it is read, not run (as in liveCheckWiring.test.ts).
  const MAIN = readFileSync(new URL('../../src/main/main.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ');

  it('routes every click through handleNotificationClick with shell.openExternal as the opener', () => {
    const at = MAIN.indexOf("n.on('click', () => {");
    expect(at).toBeGreaterThan(-1);
    const click = MAIN.slice(at, MAIN.indexOf("n.on('close'", at));
    expect(click).toContain('void handleNotificationClick(data, {');
    expect(click).toContain('openExternal: (url) => shell.openExternal(url),');
    expect(click).toContain('openItem: (sku) => openItemInDashboard(rt, sku),');
    expect(click).toContain('showDashboard: () => rt.windows.showDashboard(),');
    expect(click.match(/openExternal\(/g)).toHaveLength(1);
  });

  it('opens a URL from main only through links.open, the notification click and the scrap.tf window', () => {
    // F21 adds the third: a page the scrap.tf window's policy calls 'external' (isAllowedExternalUrl).
    expect(MAIN.match(/shell\.openExternal\(/g)).toHaveLength(3);
    expect(MAIN).toContain('isAllowedExternalUrl, openExternal: (url) => shell.openExternal(url),');
    const stfw = MAIN.slice(MAIN.indexOf('createScraptfWindowManager({'), MAIN.indexOf('rt.scraptfWindow = scraptfWindow;'));
    expect(stfw).toContain('openExternal: (url) => shell.openExternal(url),');
  });
});
