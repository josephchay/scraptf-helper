// 0.9 (#13): the shared rules behind the Banks card's "not trading" line (src/shared/banks.ts): the newest batch of a
// bank whose page said the bank was not trading (bankNoticeNewestAt), and whether it is still the bank's newest look
// (bankUnavailableAt). Pure; the batches are the user's own imports.

import { describe, expect, it } from 'vitest';
import { bankNoticeNewestAt, bankUnavailableAt } from '../../src/shared/banks';
import type { ImportBatch } from '../../src/shared/types';

const T = Date.UTC(2026, 9, 22, 12, 0, 0);
const HOUR = 3_600_000;

type B = Pick<ImportBatch, 'bank' | 'fileMtime' | 'importedAt' | 'bankNotice'>;
const b = (over: Partial<B>): B => ({ bank: 'hats', fileMtime: T, importedAt: T, bankNotice: null, ...over });

describe('0.9 (#13): bankNoticeNewestAt', () => {
  it("picks the newest notice batch of that bank by its save time (the file's time, else the import time)", () => {
    const batches: B[] = [
      b({ bankNotice: 'unavailable', fileMtime: T - 3 * HOUR, importedAt: T }),
      b({ bankNotice: 'unavailable', fileMtime: T - HOUR, importedAt: T - HOUR }),
      // No file time: the import time dates it.
      b({ bankNotice: 'unavailable', fileMtime: 0, importedAt: T - 2 * HOUR }),
    ];
    expect(bankNoticeNewestAt(batches, 'hats')).toBe(T - HOUR);
    expect(bankNoticeNewestAt([b({ bankNotice: 'unavailable', fileMtime: 0, importedAt: T - 2 * HOUR })], 'hats')).toBe(T - 2 * HOUR);
  });

  it('ignores other banks, notice-less batches (null or absent) and a batch with no usable time', () => {
    const batches: B[] = [
      b({ bank: 'weapons', bankNotice: 'unavailable', fileMtime: T }),
      b({ bankNotice: null, fileMtime: T + HOUR }),
      { bank: 'hats', fileMtime: T + 2 * HOUR, importedAt: T + 2 * HOUR },
      b({ bank: null, bankNotice: 'unavailable', fileMtime: T + 3 * HOUR }),
      b({ bankNotice: 'unavailable', fileMtime: Number.NaN, importedAt: Number.NaN }),
    ];
    expect(bankNoticeNewestAt(batches, 'hats')).toBeNull();
    expect(bankNoticeNewestAt(batches, 'weapons')).toBe(T);
    expect(bankNoticeNewestAt([], 'hats')).toBeNull();
  });
});

describe('0.9 (#13): bankUnavailableAt', () => {
  it('is the notice time while the notice is the newest look, else null', () => {
    // No notice.
    expect(bankUnavailableAt(null, T)).toBeNull();
    expect(bankUnavailableAt(null, null)).toBeNull();
    expect(bankUnavailableAt(Number.NaN, null)).toBeNull();
    // Never saved: the notice stands.
    expect(bankUnavailableAt(T, null)).toBe(T);
    // A notice older than the newest save: superseded.
    expect(bankUnavailableAt(T - HOUR, T)).toBeNull();
    // At the same time as the save, or newer: it stands.
    expect(bankUnavailableAt(T, T)).toBe(T);
    expect(bankUnavailableAt(T + HOUR, T)).toBe(T + HOUR);
  });
});
