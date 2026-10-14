import { describe, expect, it } from 'vitest';
import { createHiddenPushGate } from '../../src/renderer/hooks/useRpc';

/** Replays opps.changed pushes against a window that is shown, hidden, then shown again. */
function replay(steps: ('push' | 'hide' | 'show')[]): number {
  const gate = createHiddenPushGate();
  let visible = true;
  let runs = 0;
  for (const s of steps) {
    if (s === 'hide') visible = false;
    else if (s === 'show') {
      visible = true;
      if (gate.shown()) runs++;
    } else if (gate.push(visible)) runs++;
  }
  return runs;
}

describe('pushes while a window is hidden (quick entry after Esc, dashboard in the tray)', () => {
  it('does no work for pushes that arrive while hidden, then catches up once when shown', () => {
    // Live feed: a push every couple of seconds for as long as the window sits hidden.
    const hidden = Array.from({ length: 500 }, () => 'push' as const);
    expect(replay(['push', 'hide', ...hidden])).toBe(1);
    expect(replay(['push', 'hide', ...hidden, 'show'])).toBe(2);
  });

  it('handles every push while visible, and does not catch up when nothing was missed', () => {
    expect(replay(['push', 'push', 'push'])).toBe(3);
    expect(replay(['hide', 'show', 'push'])).toBe(1);
    expect(replay(['hide', 'push', 'show', 'show'])).toBe(1);
  });
});
