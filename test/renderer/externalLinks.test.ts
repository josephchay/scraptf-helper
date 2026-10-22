// Every link the dashboard renders must pass main's links.open allowlist
// (isAllowedExternalUrl); otherwise clicking it would only copy the address.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buyerProfileUrls } from '../../src/renderer/itemMenuModel';
import { isAllowedExternalUrl } from '../../src/shared/links';

const RENDERER = fileURLToPath(new URL('../../src/renderer/', import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : [],
  );
}

describe('links rendered by the dashboard', () => {
  it('are all on the links.open allowlist', () => {
    const urls: { file: string; url: string }[] = [];
    for (const file of walk(RENDERER)) {
      const rel = path.relative(RENDERER, file);
      if (/^mock(Data)?\.ts$/.test(rel)) continue; // fake data for the browser preview
      if (rel === 'aboutModel.ts') continue; // 0.9 (#25): the About panel's sources are copied, never opened (static.test pins it).
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (/placeholder=/.test(line)) continue; // example text in an input, not a link
        for (const m of line.matchAll(/https:\/\/[^\s'"`)<>{}]+/g)) urls.push({ file: rel, url: m[0] });
      }
    }
    expect(urls.length).toBeGreaterThan(5);
    expect(urls.filter((u) => !isAllowedExternalUrl(u.url))).toEqual([]);
  });
});

// F3: the order book's "Open on backpack.tf" and "Steam profile" actions open
// these through 'links.open', so both forms must pass the allowlist as built.
describe('buyer profile links built by the drawer', () => {
  const ids = ['76561197960265728', '76561198012345678', '76561199999999999'];

  it('pass the links.open allowlist in both forms', () => {
    for (const id of ids) {
      const urls = buyerProfileUrls(id);
      expect(urls).not.toBeNull();
      expect(urls!.backpack).toBe(`https://backpack.tf/profiles/${id}`);
      expect(urls!.steam).toBe(`https://steamcommunity.com/profiles/${id}`);
      expect(isAllowedExternalUrl(urls!.backpack)).toBe(true);
      expect(isAllowedExternalUrl(urls!.steam)).toBe(true);
    }
  });

  it('never go through Steam\'s linkfilter redirector or another host', () => {
    for (const id of ids) {
      const { backpack, steam } = buyerProfileUrls(id)!;
      expect(new URL(backpack).hostname).toBe('backpack.tf');
      expect(new URL(steam).hostname).toBe('steamcommunity.com');
      expect(steam.toLowerCase()).not.toContain('linkfilter');
    }
  });
});
