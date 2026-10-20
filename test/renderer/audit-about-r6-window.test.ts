// 0.7.3: the About page's R6 names the opt-in scrap.tf window's exception, as ARCHITECTURE R6, the README and
// Settings' risk text do. The window is a browser the user drives and keeps Electron's own user agent (no
// setUserAgent, no headers), so its requests carry no TF2FlipDesk contact address.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/** The text of one About rule entry, whichever quote the string uses. */
function aboutRule(about: string, rule: string): string {
  const m = new RegExp(`rule: '${rule}',\\s*text:\\s*(["'])([\\s\\S]*?)\\1\\s*,?\\s*\\}`).exec(about);
  return m ? m[2]! : '';
}

describe("About page R6: the scrap.tf window's user agent", () => {
  const r6 = aboutRule(root('src/renderer/pages/AboutPage.tsx'), 'R6');

  it('keeps the honest user agent promise for the app’s own requests', () => {
    expect(r6).toContain('TF2FlipDesk plus your contact address');
    expect(r6).toContain('Never pretends to be a browser');
  });

  it("names the window's exception in the README's words", () => {
    expect(r6).toContain('scrap.tf window');
    expect(r6).toContain("Electron's own user agent");
    expect(r6).toMatch(/names Flip Desk and Electron/);
    // "every request" alone would cover the window's traffic too.
    expect(r6.trimEnd()).not.toMatch(/Never pretends to be a browser\.$/);
  });

  it('agrees with ARCHITECTURE R6 and Settings', () => {
    const r6Row = root('docs/ARCHITECTURE.md').split('\n').find((l) => l.startsWith('| R6 |'))!;
    expect(r6Row).toContain("keeps Electron's default user agent");
    expect(root('src/renderer/scraptfWindowModel.ts')).toContain("This window's user agent names this app and Electron");
  });
});
