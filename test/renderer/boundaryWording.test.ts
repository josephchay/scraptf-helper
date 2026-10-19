// UX-7 (0.7.1): the boundary wording stays true with the opt-in scrap.tf window on. Up to 0.6 the app never
// showed scrap.tf, so "the app never visits scrap.tf" was true; since F21 the user may browse it in the
// Flip Desk window, and what stays true is that nothing loads it on the app's own (R1). One sentence
// (SCRAPTF_BOUNDARY_SHORT) and one window-aware data-sources text replace the old literals; a test-time
// grep keeps the old wording out of the dashboard and the shared modules for good.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { marketBoundaryNote } from '../../src/renderer/marketModel';
import { SCRAPTF_BOUNDARY_SHORT, scraptfDataSourcesText } from '../../src/shared/boundaryText';
import { CHECK_SCRAPTF_LINK_REASON } from '../../src/shared/check';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (/\.(?:ts|tsx|css)$/.test(name)) out.push(p);
  }
  return out;
}

/** The wording the opt-in window made untrue (the plan's starting points), in any case. */
const OLD_WORDING = /never (?:visits|opens) scrap\.tf|never visits it|app never visits/i;

describe('the boundary wording (UX-7)', () => {
  it('says one short sentence, and where the data comes from with the window on or off', () => {
    expect(SCRAPTF_BOUNDARY_SHORT).toBe('Flip Desk never loads scrap.tf on its own.');
    expect(scraptfDataSourcesText(false)).toBe('prices you type, pages you save');
    expect(scraptfDataSourcesText(true)).toBe('prices you type, pages you save, or pages you browse in the Flip Desk window');
    expect(marketBoundaryNote(false)).toBe('Flip Desk never loads scrap.tf on its own. Browse it yourself: prices you type, pages you save show up here.');
    expect(marketBoundaryNote(true)).toContain('or pages you browse in the Flip Desk window show up here.');
  });

  it('refuses a copied scrap.tf link without claiming Flip Desk never opens scrap.tf', () => {
    expect(CHECK_SCRAPTF_LINK_REASON).toBe('Flip Desk does not open scrap.tf links you copy; copy the item name or its row instead.');
  });

  it('no file of the dashboard or the shared modules says "never visits" or "never opens scrap.tf" any more', () => {
    const files = [...filesUnder(join(SRC, 'renderer')), ...filesUnder(join(SRC, 'shared'))];
    expect(files.length).toBeGreaterThan(50);
    const hits: string[] = [];
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (OLD_WORDING.test(line)) hits.push(`${f.slice(SRC.length).replace(/\\/g, '/')}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it('the grep catches what it claims to', () => {
    for (const s of ['The app never visits scrap.tf.', 'Flip Desk never opens scrap.tf.', 'in your own browser; the app never visits it.', 'Flip Desk never visits it.']) {
      expect(OLD_WORDING.test(s), s).toBe(true);
    }
    expect(OLD_WORDING.test(SCRAPTF_BOUNDARY_SHORT)).toBe(false);
    expect(OLD_WORDING.test(CHECK_SCRAPTF_LINK_REASON)).toBe(false);
  });
});
