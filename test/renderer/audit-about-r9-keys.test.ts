// 0.7.3: the About page's R9 promise matches main. main has two listeners on the scrap.tf window's view, and
// both see every key press there, Steam's sign-in page included: since F21-11 (0.7.1) before-input-event checks
// it for the window's own keys, and input-event stamps the time of the user's last click or key press (never
// the key) so a pop-up link may reach the user's browser within USER_ACTIVATION_MS. The page may say nothing
// typed is kept, logged or sent, not that the app never sees it, and it must name both uses.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/** The text of one About rule entry, whichever quote the string uses. */
function aboutRule(about: string, rule: string): string {
  const m = new RegExp(`rule: '${rule}',\\s*text:\\s*(["'])([\\s\\S]*?)\\1\\s*,?\\s*\\}`).exec(about);
  return m ? m[2]! : '';
}

describe("About page R9: what the app does with key presses on Steam's sign-in", () => {
  const about = root('src/renderer/pages/AboutPage.tsx');
  const r9 = aboutRule(about, 'R9');

  it('does not claim the app never sees what is typed in the window', () => {
    expect(about).not.toContain('never sees what you type');
    expect(about).not.toMatch(/never (sees|reads|receives) what you type/i);
  });

  it('says typed keys are only checked for the window keys, and never kept, logged or sent', () => {
    expect(r9).toContain('keeps, logs and sends nothing you type there');
    for (const key of ['Back', 'Forward', 'Reload', 'Home']) expect(r9).toContain(key);
  });

  it('still promises the rest: Steam’s own sign-in page and a session in the window’s own storage', () => {
    expect(r9).toContain("Never asks for, reads or stores Steam passwords, session cookies or authenticator secrets.");
    expect(r9).toContain("you sign in on Steam's own page");
    expect(r9).toContain('unless you choose to stay signed in');
  });

  it('stays true while main listens to the view’s key presses', () => {
    const main = root('src/main/scraptfWindow.ts');
    if (main.includes("'before-input-event'")) expect(about).not.toMatch(/never (sees|reads|receives) what you type/i);
    expect(main).toContain("'before-input-event'");
    // 0.7.3: every key press also stamps the activation time that lets a page's link leave for the browser.
    const activating = /const ACTIVATING_INPUTS\b[^;]*new Set\(\[([^\]]*)\]\)/.exec(main)?.[1] ?? '';
    if (main.includes("'input-event'") && activating.includes("'keyDown'")) {
      expect(r9).toContain('notes the time of your last click or key press');
      expect(r9).toContain('never the key');
    }
    expect(main).toContain("'input-event'");
    expect(activating).toContain("'keyDown'");
  });
});
