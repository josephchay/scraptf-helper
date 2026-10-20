import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSettingsStore } from '../../src/main/settingsStore';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';

// Audit mainshell-5: a settings.json saved with a UTF-8 BOM (Windows PowerShell 5.1, some editors)
// is valid JSON, not a corrupt file to move aside.

const quietLog = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_CHAR = String.fromCharCode(0xfeff);

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'flipdesk-audit-bom-'));
  file = path.join(dir, 'settings.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const userSettings = { ...DEFAULT_SETTINGS, networkPaused: true, blocklist: ['76561198000000001'] };

describe('settings store: a settings.json with a UTF-8 BOM', () => {
  it('loads it as is: the network stays paused and nothing is moved aside', () => {
    writeFileSync(file, Buffer.concat([BOM, Buffer.from(JSON.stringify(userSettings))]));
    const log = quietLog();
    const s = createSettingsStore({ file, log, now: () => 42 });
    expect(s.get().networkPaused).toBe(true);
    expect(s.get().blocklist).toEqual(['76561198000000001']);
    expect(existsSync(`${file}.corrupt-42`)).toBe(false);
    expect(existsSync(file)).toBe(true);
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringMatching(/not valid JSON/));
  });

  it('saves it back without the BOM and keeps the user settings', () => {
    writeFileSync(file, Buffer.concat([BOM, Buffer.from(JSON.stringify(userSettings))]));
    const s = createSettingsStore({ file, log: quietLog() });
    s.set({ liveFeed: { enabled: false } });
    const text = readFileSync(file, 'utf8');
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    const onDisk = JSON.parse(text);
    expect(onDisk.networkPaused).toBe(true);
    expect(onDisk.blocklist).toEqual(['76561198000000001']);
    expect(onDisk.liveFeed.enabled).toBe(false);
  });

  it('strips it in load(), whatever reader is used', () => {
    writeFileSync(file, JSON.stringify(userSettings));
    const s = createSettingsStore({ file, log: quietLog(), readFile: () => BOM_CHAR + JSON.stringify(userSettings) });
    expect(s.get().networkPaused).toBe(true);
  });

  it('still moves a really corrupt file aside, BOM or not', () => {
    writeFileSync(file, Buffer.concat([BOM, Buffer.from('{ not json')]));
    const s = createSettingsStore({ file, log: quietLog(), now: () => 7 });
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(existsSync(`${file}.corrupt-7`)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });
});
