// Every link the dashboard renders must pass main's links.open allowlist
// (isAllowedExternalUrl); otherwise clicking it would only copy the address.

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (/placeholder=/.test(line)) continue; // example text in an input, not a link
        for (const m of line.matchAll(/https:\/\/[^\s'"`)<>{}]+/g)) urls.push({ file: rel, url: m[0] });
      }
    }
    expect(urls.length).toBeGreaterThan(5);
    expect(urls.filter((u) => !isAllowedExternalUrl(u.url))).toEqual([]);
  });
});
