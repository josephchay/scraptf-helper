import { describe, expect, it } from 'vitest';
import { effectiveSettings, envProxyEnabled } from '../../src/service/entry';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';

describe('environment proxy backstop (R5)', () => {
  it('detects Node env-proxy support switched on by variable, NODE_OPTIONS or a CLI flag', () => {
    expect(envProxyEnabled({ NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:8080' }, [])).toBe(true);
    expect(envProxyEnabled({ NODE_USE_ENV_PROXY: 'true' }, [])).toBe(true);
    expect(envProxyEnabled({ NODE_OPTIONS: '--max-old-space-size=4096 --use-env-proxy' }, [])).toBe(true);
    expect(envProxyEnabled({}, ['--use-env-proxy'])).toBe(true);
  });

  it('ignores proxy variables alone (Node does not use them for fetch without the opt-in)', () => {
    expect(envProxyEnabled({ HTTPS_PROXY: 'http://127.0.0.1:8080', HTTP_PROXY: 'http://127.0.0.1:8080' }, [])).toBe(false);
    expect(envProxyEnabled({ NODE_USE_ENV_PROXY: '0' }, [])).toBe(false);
    expect(envProxyEnabled({ NODE_USE_ENV_PROXY: '' }, [])).toBe(false);
    expect(envProxyEnabled({ NODE_OPTIONS: '--use-env-proxy-not-really' }, [])).toBe(false);
  });

  it('keeps the network paused while an environment proxy is active, and leaves settings alone otherwise', () => {
    const on = { ...DEFAULT_SETTINGS, networkPaused: false };
    expect(effectiveSettings(on, true).networkPaused).toBe(true);
    expect(effectiveSettings(on, true).liveFeed).toEqual(on.liveFeed);
    expect(effectiveSettings(on, false)).toBe(on);
    const paused = { ...DEFAULT_SETTINGS, networkPaused: true };
    expect(effectiveSettings(paused, true)).toBe(paused);
  });
});
