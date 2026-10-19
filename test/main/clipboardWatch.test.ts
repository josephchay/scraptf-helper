// F16 privacy filter and clipboard watcher (src/main/clipboardWatch.ts). Clipboard text must never
// reach the service unless it passed the filter: no secrets, no markup, no lists, nothing over 400
// characters; repeats are compared by a keyed hash; nothing is read while paused.

import { describe, expect, it, vi } from 'vitest';
import {
  CLIPBOARD_READ_STALL_TICKS,
  clipboardSkipMessage,
  clipboardTextHash,
  createClipboardWatch,
  createSystemPause,
  looksLikeSecret,
  shouldCheckClipboardText,
  type ClipboardSkipReason,
  type PowerEvent,
} from '../../src/main/clipboardWatch';
import { parseItemUrl } from '../../src/service/connectors/schema';
import { CHECK_MAX_CHARS, CHECK_REFUSALS } from '../../src/shared/check';

const STEAM_KEY = '0123456789ABCDEF0123456789ABCDEF';
const BPTF_TOKEN = '5f1e2d3c4b5a69788796a5b4';

describe('shouldCheckClipboardText', () => {
  const reason = (t: string, last: string | null = null): ClipboardSkipReason | null => shouldCheckClipboardText(t, last).reason;

  it('passes the forms a live check reads', () => {
    for (const t of [
      'Team Captain',
      'Strange Professional Killstreak Rocket Launcher',
      'Non-Craftable Tour of Duty Ticket',
      '378;6',
      '30359;6;uncraftable;kt-3',
      '15059;15;w3;pk164;strange;kt-3',
      'Team Captain, 1.33 ref',
      'Team Captain - 1 key 5.33 ref',
      'Team Captain\t1 key 22 ref\t1 key 18 ref\t3/12',
      'Team Captain    Sold out    1 key 18 ref    12/12',
      'Team Captain\n1 key 5.33 ref',
      'https://backpack.tf/stats/Strange/Professional%20Killstreak%20Rocket%20Launcher/Tradable/Craftable',
      'https://marketplace.tf/items/tf2/378;6',
      'Taunt: The Conga',
    ]) {
      const r = shouldCheckClipboardText(t, null);
      expect(r, t).toMatchObject({ ok: true, reason: null });
    }
  });

  it('refuses empty, over-long, markup, lists and text with no letter or digit', () => {
    expect(reason('')).toBe('empty');
    expect(reason('   \n\t')).toBe('empty');
    expect(reason('a'.repeat(CHECK_MAX_CHARS + 1))).toBe('too-long');
    expect(reason('a'.repeat(CHECK_MAX_CHARS))).toBeNull();
    expect(reason('<span>Team Captain</span>')).toBe('markup');
    expect(reason('Team Captain\nBill\'s Hat\nEarbuds\nConga')).toBe('too-many-lines');
    expect(reason('Team Captain\n\nBill\'s Hat\n\nEarbuds')).toBeNull();
    expect(reason('--- !!! ...')).toBe('no-text');
    expect(reason(42 as unknown as string)).toBe('empty');
  });

  it('refuses key and token shapes, alone or inside text', () => {
    expect(reason(STEAM_KEY)).toBe('secret');
    expect(reason(STEAM_KEY.toLowerCase())).toBe('secret');
    expect(reason(BPTF_TOKEN)).toBe('secret');
    expect(reason(`my key is ${STEAM_KEY} ok`)).toBe('secret');
    expect(reason(`token=${BPTF_TOKEN}`)).toBe('secret');
  });

  it('refuses long mixed tokens (passwords, JWTs, API tokens)', () => {
    for (const t of [
      'hunter2-Correct-Horse-Battery',
      'P@ssw0rd!P@ssw0rd!P@ss',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl',
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
      'password: Zx9!kQ2#mW7$pL4%tR8^',
    ]) {
      expect(reason(t), t).toBe('secret');
    }
    // Long letters-only words and short mixed tokens are not secrets.
    expect(reason('Antidisestablishmentarianism')).toBeNull();
    expect(reason('Team Captain x2 #5 abc-123')).toBeNull();
  });

  it('refuses URLs with credentials or credential parameters', () => {
    expect(reason('https://user:pass@example.com/x')).toBe('secret');
    expect(reason('ftp://me@files.example.com')).toBe('secret');
    expect(reason('https://steamcommunity.com/tradeoffer/new/?partner=12345&token=AbCdEfGh')).toBe('secret');
    expect(reason('https://api.example.com/v1?key=abc')).toBe('secret');
  });

  it('refuses card-like numbers that pass Luhn, not other digit runs', () => {
    expect(reason('4111 1111 1111 1111')).toBe('secret');
    expect(reason('4111-1111-1111-1111')).toBe('secret');
    expect(reason('4111111111111112')).toBeNull();
    expect(reason('Team Captain 15123456789')).toBeNull();
  });

  it('checks in the documented order', () => {
    // A secret wrapped in markup is refused as markup before anything reads it as a token.
    expect(reason(`<b>${STEAM_KEY}</b>`)).toBe('markup');
    expect(reason(`${STEAM_KEY}\n1\n2\n3`)).toBe('too-many-lines');
  });

  it('compares repeats by a keyed hash, never by the text', () => {
    const first = shouldCheckClipboardText('Team Captain', null);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first.hash).not.toContain('Team');
    expect(shouldCheckClipboardText('Team Captain', first.hash)).toEqual({ ok: false, hash: first.hash, reason: 'same' });
    expect(shouldCheckClipboardText('Earbuds', first.hash).ok).toBe(true);
    // A refused text is a repeat too, so the watcher does not re-scan it every poll.
    const secret = shouldCheckClipboardText(STEAM_KEY, null);
    expect(shouldCheckClipboardText(STEAM_KEY, secret.hash).reason).toBe('same');
    expect(clipboardTextHash('a')).not.toBe(clipboardTextHash('b'));
    expect(clipboardTextHash('x'.repeat(100_000))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the hotkey popup a fixed message for every reason', () => {
    const reasons: ClipboardSkipReason[] = ['same', 'empty', 'too-long', 'markup', 'too-many-lines', 'no-text', 'secret', 'link'];
    for (const r of reasons) expect(clipboardSkipMessage(r)).toMatch(/\S/);
    expect(clipboardSkipMessage('too-many-lines')).toBe(CHECK_REFUSALS.list);
    expect(clipboardSkipMessage('secret')).toBe(CHECK_REFUSALS.secret);
  });

  it('looksLikeSecret treats a valid SKU and an item link as fine', () => {
    expect(looksLikeSecret('30359;6;uncraftable;kt-3;festive')).toBe(false);
    expect(looksLikeSecret('https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable')).toBe(false);
    expect(looksLikeSecret('1;6;aaaaaaaaaaaaaaaaaaaaaaaaaaaa9')).toBe(true);
  });

  // Item links are the only links let past the long-token rule: any other link may carry a token in
  // its path or under a query name of its own, and wrapping a secret in https:// must not get it through.
  const WEBHOOK_SECRET = 'Ab3dEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEfGhIjKlMnOpQrStUvWx';
  const ITEM_LINKS = [
    'https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable',
    'https://www.backpack.tf/stats/Strange/Professional%20Killstreak%20Rocket%20Launcher/Tradable/Craftable',
    'https://backpack.tf/stats/Unusual/Team%20Captain/Tradable/Craftable/13',
    'https://backpack.tf/stats/Unique/Mann%20Co.%20Supply%20Crate%20Series%20%2330/Tradable/Craftable',
    'https://next.backpack.tf/stats?item=Team%20Captain&quality=Unique&tradable=1&craftable=1',
    'https://next.backpack.tf/stats?item=Rocket%20Launcher&quality=Strange&elevatedQuality=Strange&festivized=1&killstreakTier=3&texture=Night%20Owl&australium=0&wearTier=Factory%20New&priceindex=0',
    'https://marketplace.tf/items/tf2/378;6',
    'https://marketplace.tf/items/tf2/30359;6;uncraftable;kt-3',
    'https://pricedb.io/item/5021;6',
    'https://pricedb.io/item-history/15059;15;w3;pk164;strange;kt-3',
  ];

  it('lets item links through: the hosts and paths parseItemUrl reads, alone or followed by a price', () => {
    for (const link of ITEM_LINKS) {
      expect(parseItemUrl(link), link).not.toBeNull();
      for (const t of [link, `${link}, 1.33 ref`, `${link}\t1 key 5.33 ref`, `${link} = 2 ref`]) {
        expect(shouldCheckClipboardText(t, null), t).toMatchObject({ ok: true, reason: null });
      }
    }
    // A scrap.tf link still reaches the service, which answers it as a scrap.tf link and never opens it.
    expect(reason('https://scrap.tf/items')).toBeNull();
    expect(reason('https://scrap.tf/killstreaks')).toBeNull();
  });

  it('refuses every other long link: a token in its path or under any credential-like query name', () => {
    const refused = [
      `https://discord.com/api/webhooks/1100000000000000000/${WEBHOOK_SECRET}`,
      'https://example.com/oauth/callback?client_secret=Zx9Yw8Vu7Ts6Rq5Po4Nm3',
      'https://example.com/cb?refresh_token=1//0gAbCdEfGhIjKlMnOp',
      'https://example.com/cb?code=4/0AbCdEfGhIjKlMnOp',
      `https://bucket.s3.amazonaws.com/file.zip?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAEXAMPLE%2F20261016&X-Amz-Signature=${'ab'.repeat(32)}`,
      'https://help.steampowered.com/wizard/HelpWithLoginInfoReset/?s=1&account=2&reset=3&lost=0&code=AbC12dEf34GhI56',
      'https://example.com/reset/Zx9Yw8Vu7Ts6Rq5Po4Nm3',
      // An item host, but not an item path, or a token tucked into an item link.
      'https://backpack.tf/classifieds?item=Team%20Captain',
      `https://backpack.tf/stats/Unique/${WEBHOOK_SECRET}/Tradable/Craftable`,
      `https://next.backpack.tf/stats?item=${WEBHOOK_SECRET}`,
      'https://marketplace.tf/items/tf2/378;6?ref=Zx9Yw8Vu7',
      'https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable#Zx9Yw8Vu7',
      'https://backpack.tf.example.com/stats/Unique/Team%20Captain/Tradable/Craftable',
      'https://scrap.tf/items?session=Zx9Yw8Vu7Ts6Rq5Po4Nm3',
      'https://scrap.tf/profile?ref=Zx9Yw8Vu7',
    ];
    for (const t of refused) {
      const r = shouldCheckClipboardText(t, null);
      expect(r.ok, t).toBe(false);
      expect(['secret', 'link'], t).toContain(r.reason);
      expect(looksLikeSecret(t), t).toBe(true);
      expect(looksLikeSecret(`Team Captain ${t}`), t).toBe(true);
    }
    // The same secret alone or in a link: refused both ways.
    expect(reason(WEBHOOK_SECRET)).toBe('secret');
    expect(reason(`https://discord.com/api/webhooks/1100000000000000000/${WEBHOOK_SECRET}`)).toBe('link');
    expect(reason('https://example.com/oauth/callback?client_secret=Zx9Yw8Vu7Ts6Rq5Po4Nm3')).toBe('secret');
    // Credential-like query names catch short links the long-token rule cannot.
    expect(reason('http://a.co/?code=1')).toBe('secret');
    expect(reason('http://a.co/?my_token=1')).toBe('secret');
    expect(clipboardSkipMessage('link')).toBe(CHECK_REFUSALS.link);
  });
});

describe('createClipboardWatch', () => {
  function setup(initial = 'old text') {
    let clip = initial;
    let paused = false;
    let tick: (() => void) | null = null;
    const reads = vi.fn(() => clip);
    const onText = vi.fn<(t: string) => void>();
    const onError = vi.fn();
    const timers = {
      setInterval: vi.fn((fn: () => void) => {
        tick = fn;
        return 1;
      }),
      clearInterval: vi.fn(() => {
        tick = null;
      }),
    };
    const watch = createClipboardWatch({ readText: reads, onText, isPaused: () => paused, timers, onError });
    return {
      watch,
      reads,
      onText,
      onError,
      timers,
      copy: (t: string) => {
        clip = t;
      },
      pause: (p: boolean) => {
        paused = p;
      },
      poll: () => tick?.(),
    };
  }

  it('polls every 700 ms and ignores what was on the clipboard when it started', () => {
    const s = setup('copied before the watcher started');
    s.watch.start();
    expect(s.timers.setInterval).toHaveBeenCalledWith(expect.any(Function), 700);
    expect(s.watch.running()).toBe(true);
    s.poll();
    expect(s.onText).not.toHaveBeenCalled();
    s.copy('Team Captain');
    s.poll();
    s.poll();
    expect(s.onText.mock.calls).toEqual([['Team Captain']]);
  });

  it('passes only filtered text on', () => {
    const s = setup();
    s.watch.start();
    for (const t of [STEAM_KEY, '<b>x</b>', 'a\nb\nc\nd', 'x'.repeat(500), '!!!', '']) {
      s.copy(t);
      s.poll();
    }
    expect(s.onText).not.toHaveBeenCalled();
    s.copy('Earbuds, 2 keys');
    s.poll();
    expect(s.onText.mock.calls).toEqual([['Earbuds, 2 keys']]);
  });

  it('reads nothing while paused, and text copied during the pause is not new afterwards', () => {
    const s = setup();
    s.watch.start();
    const before = s.reads.mock.calls.length;
    s.pause(true);
    s.copy('Team Captain');
    s.poll();
    s.poll();
    expect(s.reads.mock.calls.length).toBe(before);
    s.pause(false);
    s.poll();
    expect(s.onText).not.toHaveBeenCalled();
    s.copy('Earbuds');
    s.poll();
    expect(s.onText.mock.calls).toEqual([['Earbuds']]);
  });

  it('stops, restarts fresh, and survives a failing read or check without the text', () => {
    const s = setup();
    s.watch.start();
    s.watch.start();
    expect(s.timers.setInterval).toHaveBeenCalledTimes(1);
    s.reads.mockImplementationOnce(() => {
      throw new Error('clipboard busy');
    });
    s.poll();
    expect(s.onError).toHaveBeenCalledWith('read', expect.any(Error));
    s.onText.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    s.copy('Team Captain');
    s.poll();
    expect(s.onError).toHaveBeenLastCalledWith('check', expect.any(Error));
    s.watch.stop();
    expect(s.watch.running()).toBe(false);
    expect(s.timers.clearInterval).toHaveBeenCalledTimes(1);
    s.copy('Earbuds');
    s.watch.start();
    s.poll();
    expect(s.onText.mock.calls.map((c) => c[0])).toEqual(['Team Captain']);
  });

  it('markChecked: a copy the hotkey just checked is not new to the next poll', () => {
    const s = setup();
    s.watch.start();
    s.copy('Team Captain');
    s.watch.markChecked('Team Captain');
    s.poll();
    expect(s.onText).not.toHaveBeenCalled();
    s.copy('Earbuds');
    s.poll();
    expect(s.onText.mock.calls).toEqual([['Earbuds']]);
    // Stopped: nothing to mark.
    s.watch.stop();
    expect(() => s.watch.markChecked('x')).not.toThrow();
  });

  it('isLastSeen (F19): compares a keyed hash with the last text seen or marked; false while stopped or unprimed', () => {
    const s = setup('Team Captain');
    const tc = clipboardTextHash('Team Captain');
    expect(s.watch.isLastSeen(tc)).toBe(false);
    s.watch.start();
    // The priming read records what was there.
    expect(s.watch.isLastSeen(tc)).toBe(true);
    s.copy('Earbuds');
    s.poll();
    expect(s.watch.isLastSeen(tc)).toBe(false);
    expect(s.watch.isLastSeen(clipboardTextHash('Earbuds'))).toBe(true);
    // Refused texts are seen too: copying one again changes nothing the watcher reacts to.
    s.copy(STEAM_KEY);
    s.poll();
    expect(s.watch.isLastSeen(clipboardTextHash(STEAM_KEY))).toBe(true);
    s.watch.markChecked('Team Captain');
    expect(s.watch.isLastSeen(tc)).toBe(true);
    // A pause un-primes it: the next read starts afresh.
    s.pause(true);
    s.poll();
    expect(s.watch.isLastSeen(tc)).toBe(false);
    s.pause(false);
    s.poll();
    expect(s.watch.isLastSeen(clipboardTextHash(STEAM_KEY))).toBe(true);
    s.watch.stop();
    expect(s.watch.isLastSeen(clipboardTextHash(STEAM_KEY))).toBe(false);
  });

  it('onPrimed (F19): reports each priming read by keyed hash only (start, end of a pause), never a later read', () => {
    let clip = 'Team Captain';
    let paused = false;
    let tick: (() => void) | null = null;
    const onPrimed = vi.fn<(hash: string) => void>();
    const onText = vi.fn<(t: string) => void>();
    const onError = vi.fn();
    const timers = { setInterval: (fn: () => void) => ((tick = fn), 1), clearInterval: () => (tick = null) };
    const watch = createClipboardWatch({ readText: () => clip, onText, onPrimed, isPaused: () => paused, timers, onError });
    watch.start();
    expect(onPrimed.mock.calls).toEqual([[clipboardTextHash('Team Captain')]]);
    clip = 'Earbuds';
    tick!();
    expect(onText.mock.calls).toEqual([['Earbuds']]);
    expect(onPrimed).toHaveBeenCalledTimes(1);
    paused = true;
    tick!();
    clip = '1.33 ref';
    paused = false;
    tick!();
    expect(onPrimed.mock.calls.at(-1)).toEqual([clipboardTextHash('1.33 ref')]);
    expect(onText).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(onPrimed.mock.calls)).not.toMatch(/Team Captain|1\.33/);
    // A throwing callback is reported like onText's, and the watcher keeps going.
    onPrimed.mockImplementation(() => {
      throw new Error('boom');
    });
    watch.stop();
    watch.start();
    expect(onError).toHaveBeenCalledWith('check', expect.any(Error));
    clip = 'Earbuds';
    tick!();
    expect(onText.mock.calls.at(-1)).toEqual(['Earbuds']);
  });
});

describe('createClipboardWatch with an async reader (Electron 44 clipboard.readText)', () => {
  function setupAsync(initial = 'old text') {
    let clip = initial;
    let paused = false;
    let tick: (() => void) | null = null;
    const resolvers: (() => void)[] = [];
    let held = false;
    const reads = vi.fn(
      () =>
        new Promise<string>((resolve, reject) => {
          const value = clip;
          const settle = () => (value === '!throw' ? reject(new Error('busy')) : resolve(value));
          if (held) resolvers.push(settle);
          else settle();
        }),
    );
    const onText = vi.fn<(t: string) => void>();
    const onError = vi.fn();
    const timers = {
      setInterval: vi.fn((fn: () => void) => {
        tick = fn;
        return 1;
      }),
      clearInterval: vi.fn(() => {
        tick = null;
      }),
    };
    const watch = createClipboardWatch({ readText: reads, onText, isPaused: () => paused, timers, onError });
    const flush = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    return {
      watch,
      reads,
      onText,
      onError,
      copy: (t: string) => {
        clip = t;
      },
      pause: (p: boolean) => {
        paused = p;
      },
      hold: (h: boolean) => {
        held = h;
      },
      release: async () => {
        for (const r of resolvers.splice(0)) r();
        await flush();
      },
      releaseOldest: async () => {
        resolvers.shift()?.();
        await flush();
      },
      poll: async () => {
        tick?.();
        await flush();
      },
      flush,
    };
  }

  it('primes on the first resolved read and checks later copies', async () => {
    const s = setupAsync('copied before');
    s.watch.start();
    await s.flush();
    await s.poll();
    expect(s.onText).not.toHaveBeenCalled();
    s.copy('Team Captain');
    await s.poll();
    await s.poll();
    expect(s.onText.mock.calls).toEqual([['Team Captain']]);
  });

  it('never stacks reads: a tick during a pending read is skipped', async () => {
    const s = setupAsync();
    s.watch.start();
    await s.flush();
    s.hold(true);
    s.copy('Team Captain');
    await s.poll();
    await s.poll();
    await s.poll();
    expect(s.reads).toHaveBeenCalledTimes(2);
    await s.release();
    expect(s.onText.mock.calls).toEqual([['Team Captain']]);
  });

  it('drops a read that resolves after a stop or a pause began', async () => {
    const s = setupAsync();
    s.watch.start();
    await s.flush();
    s.hold(true);
    s.copy('Team Captain');
    await s.poll();
    s.pause(true);
    await s.poll();
    await s.release();
    expect(s.onText).not.toHaveBeenCalled();
    s.pause(false);
    s.hold(false);
    // The first read after the pause primes again: what was copied during it is not new.
    await s.poll();
    await s.poll();
    expect(s.onText).not.toHaveBeenCalled();

    s.hold(true);
    s.copy('Earbuds');
    await s.poll();
    s.watch.stop();
    await s.release();
    expect(s.onText).not.toHaveBeenCalled();
  });

  it('gives up on a read that never settles and reads again, without stacking reads', async () => {
    const s = setupAsync();
    s.watch.start();
    await s.flush();
    s.hold(true);
    s.copy('Team Captain');
    await s.poll();
    expect(s.reads).toHaveBeenCalledTimes(2);
    for (let i = 1; i < CLIPBOARD_READ_STALL_TICKS; i++) await s.poll();
    expect(s.reads).toHaveBeenCalledTimes(2);
    // The stalled read is abandoned on this tick and a fresh one starts.
    await s.poll();
    expect(s.reads).toHaveBeenCalledTimes(3);
    // The abandoned read settling late neither delivers its text nor frees the newer read's slot.
    await s.releaseOldest();
    expect(s.onText).not.toHaveBeenCalled();
    await s.poll();
    expect(s.reads).toHaveBeenCalledTimes(3);
    await s.release();
    expect(s.onText.mock.calls).toEqual([['Team Captain']]);
  });

  it('reports a rejected read without the text', async () => {
    const s = setupAsync();
    s.watch.start();
    await s.flush();
    s.copy('!throw');
    await s.poll();
    expect(s.onError).toHaveBeenCalledWith('read', expect.any(Error));
    expect(s.onText).not.toHaveBeenCalled();
  });
});

describe('createSystemPause', () => {
  function fakePower(state = 'active') {
    const listeners = new Map<PowerEvent, Set<() => void>>();
    return {
      pm: {
        on: vi.fn((e: PowerEvent, fn: () => void) => {
          if (!listeners.has(e)) listeners.set(e, new Set());
          listeners.get(e)!.add(fn);
        }),
        removeListener: vi.fn((e: PowerEvent, fn: () => void) => {
          listeners.get(e)?.delete(fn);
        }),
        // As Electron: a threshold below 1 throws "Invalid idle threshold, must be greater than 0".
        getSystemIdleState: vi.fn((t: number) => {
          if (!(t > 0)) throw new TypeError('Invalid idle threshold, must be greater than 0');
          return state;
        }),
      },
      emit: (e: PowerEvent) => {
        for (const fn of listeners.get(e) ?? []) fn();
      },
      count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    };
  }

  it('pauses while the session is locked or the machine is suspended', () => {
    const p = fakePower();
    const pause = createSystemPause(p.pm);
    expect(p.pm.getSystemIdleState).toHaveBeenCalledWith(1);
    expect(pause.paused()).toBe(false);
    p.emit('lock-screen');
    expect(pause.paused()).toBe(true);
    p.emit('suspend');
    p.emit('unlock-screen');
    // Still suspended.
    expect(pause.paused()).toBe(true);
    p.emit('resume');
    expect(pause.paused()).toBe(false);
  });

  it('starts paused when the screen is already locked, and survives a failing query', () => {
    expect(createSystemPause(fakePower('locked').pm).paused()).toBe(true);
    const p = fakePower();
    p.pm.getSystemIdleState.mockImplementation(() => {
      throw new Error('unsupported');
    });
    expect(createSystemPause(p.pm).paused()).toBe(false);
  });

  it('removes its listeners on dispose', () => {
    const p = fakePower();
    const pause = createSystemPause(p.pm);
    expect(p.count()).toBe(4);
    pause.dispose();
    expect(p.count()).toBe(0);
    p.emit('lock-screen');
    expect(pause.paused()).toBe(false);
  });
});
