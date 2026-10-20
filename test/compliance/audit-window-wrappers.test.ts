// 0.7.3: the dashboard's "window moves only on a click" scan (F21, R1) follows the local functions and maps
// that hold a window call (the toolbar's NAV_METHODS, act, readNow…, a page's openInWindow), so a timer, an
// effect, a push listener or a promise callback that calls one is flagged. The literal-only scans saw none.
// Push listeners are usePush and useVisiblePush; a method handed to useRpcQuery runs in its effect.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { deferredWindowCalls, deferredWindowOpens, deferredWindowWrappers, lineAt, sourceFile, walk, windowWrappers, type SourceFile } from './windowWrapperScan';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const read = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const dashboard = (): SourceFile[] =>
  walk(path.join(SRC, 'renderer'))
    .map((f) => path.relative(SRC, f).split(path.sep).join('/'))
    .filter((rel) => !rel.startsWith('renderer/mock'))
    .map((rel) => sourceFile(rel, read(rel)));

/** `rel` with `line` added after the block of `decl` (its closing `  };`), and the added line's number. */
function inject(rel: string, decl: string, line: string): { file: SourceFile; at: number } {
  const src = read(rel);
  const from = src.indexOf(decl);
  expect(from, `${rel}: ${decl}`).toBeGreaterThan(-1);
  const close = src.indexOf('\n  };\n', from);
  expect(close, `${rel}: the end of ${decl}`).toBeGreaterThan(from);
  const end = close + '\n  };\n'.length;
  const code = `${src.slice(0, end)}${line}\n${src.slice(end)}`;
  return { file: sourceFile(rel, code), at: lineAt(code, end) };
}

const BAR = 'renderer/pages/ScraptfWindowBar.tsx';
const AFTER_CLEAR = 'const clear = () => {';

describe('the dashboard window-call scan follows the wrappers that hold a call (F21, R1)', () => {
  it('passes the real dashboard and sees its wrappers', () => {
    const files = dashboard();
    expect(deferredWindowWrappers(files)).toEqual([]);
    expect(windowWrappers(files).holders).toEqual(
      expect.arrayContaining([
        `${BAR}:NAV_METHODS`,
        `${BAR}:act`,
        `${BAR}:go`,
        `${BAR}:readNow`,
        `${BAR}:clear`,
        `${BAR}:showFlips`,
        'renderer/pages/BanksPage.tsx:openInWindow',
        'renderer/pages/BankStockPage.tsx:openInWindow',
        'renderer/pages/BankStockPage.tsx:openPage',
        'renderer/components/ScraptfListCard.tsx:openInWindow',
        'renderer/App.tsx:open',
        'renderer/pages/SettingsPage.tsx:openWindow',
        'renderer/pages/SettingsPage.tsx:clearWindow',
      ]),
    );
  });

  const cases: readonly [rel: string, decl: string, line: string, name: string][] = [
    [BAR, AFTER_CLEAR, "  useInterval(() => act('reload'), 30_000, true);", 'act'],
    [BAR, AFTER_CLEAR, "  usePush('scraptfWindow.nav', () => void rpc(NAV_METHODS.reload));", 'NAV_METHODS'],
    [BAR, AFTER_CLEAR, "  useEffect(() => { act('reload'); }, [nav.url]);", 'act'],
    [BAR, AFTER_CLEAR, '  useEffect(() => { readNow(); }, [nav.url]);', 'readNow'],
    [BAR, AFTER_CLEAR, "  useEffect(() => { go('https://scrap.tf/buy/hats'); }, [nav.url]);", 'go'],
    [BAR, AFTER_CLEAR, "  rpc('scraptfWindow.state').then(() => act('home'));", 'act'],
    [BAR, AFTER_CLEAR, '  useEffect(() => { const id = setTimeout(readNow, 1000); return () => clearTimeout(id); }, []);', 'readNow'],
    [BAR, AFTER_CLEAR, '  useEffect(() => { clear(); }, []);', 'clear'],
    ['renderer/pages/BanksPage.tsx', 'const openInWindow = (c: BankCardView) => {', '  useEffect(() => { const c = banks.data?.cards?.[0]; if (c) openInWindow(c); }, [banks.data]);', 'openInWindow'],
    ['renderer/App.tsx', 'const open = () => {', '  useEffect(() => { open(); }, []);', 'open'],
    ['renderer/pages/SettingsPage.tsx', 'const openWindow = () => {', "  usePush('settings.changed', () => openWindow());", 'openWindow'],
    ['renderer/pages/BankStockPage.tsx', 'const openPage = () => {', '  useEffect(() => { openPage(); }, []);', 'openPage'],
    ['renderer/components/ScraptfListCard.tsx', 'const openInWindow = () => {', '  useEffect(() => { if (status) openInWindow(); }, [status]);', 'openInWindow'],
    // 0.7.3: useVisiblePush is the dashboard's usual push listener, and useRpcQuery calls its method in an effect.
    ['renderer/pages/BanksPage.tsx', 'const openInWindow = (c: BankCardView) => {', "  useVisiblePush('scraptf.banksChanged', () => { const c = banks.data?.cards?.[0]; if (c) openInWindow(c); });", 'openInWindow'],
    ['renderer/App.tsx', 'const open = () => {', "  useVisiblePush('prices.changed', open);", 'open'],
    [BAR, AFTER_CLEAR, '  const auto = useRpcQuery(NAV_METHODS.reload, undefined);', 'NAV_METHODS'],
  ];

  for (const [rel, decl, line, name] of cases) {
    it(`flags ${line.trim()} (${rel.split('/').at(-1)})`, () => {
      const { file, at } = inject(rel, decl, line);
      expect(deferredWindowWrappers([file])).toEqual([`${rel}:${at}: ${name}`]);
      // The literal-only scans miss it: the call sits in a wrapper outside the deferred span.
      expect(deferredWindowCalls([file])).toEqual([]);
      expect(deferredWindowOpens([file])).toEqual([]);
    });
  }

  it('flags a window method handed to useRpcQuery or called from useVisiblePush, but not a useVisiblePush subscription', () => {
    const query = inject(BAR, AFTER_CLEAR, "  const auto = useRpcQuery('scraptfWindow.reload', undefined);");
    expect(deferredWindowCalls([query.file])).toEqual([`${BAR}:${query.at}: 'scraptfWindow.reload'`]);
    const push = inject(BAR, AFTER_CLEAR, "  useVisiblePush('scraptf.changed', () => void rpc('scraptfWindow.home'));");
    expect(deferredWindowCalls([push.file])).toEqual([`${BAR}:${push.at}: 'scraptfWindow.home'`]);
    for (const line of ["  useVisiblePush('scraptfWindow.read', () => setBusy(false));", "  const s = useRpcQuery('scraptfWindow.state', undefined);"]) {
      const { file } = inject(BAR, AFTER_CLEAR, line);
      expect(deferredWindowCalls([file]), line).toEqual([]);
      expect(deferredWindowWrappers([file]), line).toEqual([]);
    }
  });

  it('leaves a click handler alone', () => {
    for (const line of ["  const onTest = () => act('reload');", "  const el = <button onClick={() => act('reload')} />;"]) {
      expect(deferredWindowWrappers([inject(BAR, AFTER_CLEAR, line).file])).toEqual([]);
    }
  });
});
