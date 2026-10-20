// 0.7.2: the dashboard's screen for a copy of Flip Desk older than its data (dataTooNewModel.ts). The
// service's refusal (SchemaVersionError) is parsed as it is worded, through every hop it takes to the
// dashboard, and the text never names a folder or version main did not report.

import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, SchemaVersionError } from '../../src/service/db';
import { dataTooNewText, parseDataTooNew } from '../../src/renderer/dataTooNewModel';
import { errorMessage } from '../../src/renderer/format';
import type { AppInfo } from '../../src/shared/rpc';

const INFO: AppInfo = {
  version: '0.7.1',
  appDir: 'C:\\Users\\User\\Desktop\\old-clone\\scraptf-helper',
  dataDir: 'C:\\Users\\User\\AppData\\Roaming\\TF2 Flip Desk\\data',
  logDir: 'C:\\Users\\User\\AppData\\Roaming\\TF2 Flip Desk\\logs',
  platform: 'win32',
  electron: '44.5.0',
  node: '24.21.0',
};

describe('parseDataTooNew', () => {
  it('reads the versions out of the exact SchemaVersionError message', () => {
    const msg = new SchemaVersionError(11, 10).message;
    expect(msg).toBe('Database schema version 11 is newer than this app supports (10). Update the app or use a different data folder.');
    expect(parseDataTooNew(msg)).toEqual({ found: 11, supported: 10 });
    expect(parseDataTooNew(new SchemaVersionError(999, SCHEMA_VERSION).message)).toEqual({ found: 999, supported: SCHEMA_VERSION });
  });

  it('still matches the way the dashboard shows it (an Electron prefix, errorMessage)', () => {
    // The service's own clean-up leaves the message whole: test/service/dataTooNewCore.test.ts.
    const msg = new SchemaVersionError(12, 10).message;
    const shown = errorMessage(new Error(`Error invoking remote method 'rpc': Error: ${msg}`));
    expect(shown).toBe(msg);
    expect(parseDataTooNew(shown)).toEqual({ found: 12, supported: 10 });
    expect(parseDataTooNew(`Error: ${msg}`)).toEqual({ found: 12, supported: 10 });
  });

  it('does not match any other error', () => {
    for (const other of [
      null,
      undefined,
      '',
      'The service is still starting',
      'The service is not ready (restarting); status.get timed out',
      'The database could not be opened: database is locked',
      'The app bridge failed to load. Restart TF2 Flip Desk; details are in the log.',
      'Database schema version is newer than this app supports. Update the app.',
      'Database schema version eleven is newer than this app supports (10).',
    ]) {
      expect(parseDataTooNew(other)).toBeNull();
    }
  });

  it('does not claim the data is newer when the numbers say otherwise', () => {
    expect(parseDataTooNew('Database schema version 10 is newer than this app supports (10).')).toBeNull();
    expect(parseDataTooNew('Database schema version 3 is newer than this app supports (10).')).toBeNull();
    expect(parseDataTooNew(`Database schema version ${'9'.repeat(30)} is newer than this app supports (10).`)).toBeNull();
  });
});

describe('dataTooNewText', () => {
  const refusal = { found: 11, supported: 10 };

  it('says what happened, that nothing changed, which copy runs and what to do', () => {
    const t = dataTooNewText(refusal, INFO);
    expect(t.title).toBe('This copy of Flip Desk is older than its data');
    expect(t.lead).toBe(`This copy of Flip Desk is older than the data it found in ${INFO.dataDir}.`);
    expect(t.why).toBe(
      'A newer copy of Flip Desk already updated that data, for example a development build or a newer installer. ' +
        'The data is at version 11. This copy reads up to version 10.',
    );
    expect(t.safe).toBe('Nothing was changed. Your data is safe.');
    expect(t.steps).toEqual([
      'Close this copy and start the newer one.',
      `Or update this copy. If you run it from source, get the latest code into ${INFO.appDir}, then run npm start. If you installed it, install the newer version.`,
    ]);
    expect(t.copy).toEqual([
      { label: 'Version', value: '0.7.1', path: false },
      { label: 'Runs from', value: INFO.appDir, path: true },
      { label: 'Data folder', value: INFO.dataDir, path: true },
    ]);
    expect(t.copyUnknown).toBeNull();
  });

  it('never names a folder it was not told (no app info, or blank fields)', () => {
    for (const info of [null, undefined, {}, { ...INFO, version: '', appDir: '  ', dataDir: '' }]) {
      const t = dataTooNewText(refusal, info);
      expect(t.lead).toBe('This copy of Flip Desk is older than the data in its data folder.');
      expect(t.steps[1]).toContain('get the latest code into its folder, then run npm start.');
      expect(t.copy).toEqual([]);
      expect(t.copyUnknown).toBe('Flip Desk could not tell which copy this is.');
      const all = [t.title, t.lead, t.why, t.safe, ...t.steps].join('\n');
      expect(all).not.toMatch(/[A-Za-z]:\\|AppData|Roaming/);
    }
  });

  it('shows only what main reported', () => {
    const t = dataTooNewText(refusal, { version: '0.7.1' });
    expect(t.copy).toEqual([{ label: 'Version', value: '0.7.1', path: false }]);
    expect(t.copyUnknown).toBeNull();
    expect(t.lead).toBe('This copy of Flip Desk is older than the data in its data folder.');
    expect(t.steps[1]).toContain('into its folder');

    // The data folder is not where the code goes: with no app folder reported, the step names none.
    const dataOnly = dataTooNewText(refusal, { dataDir: INFO.dataDir });
    expect(dataOnly.lead).toBe(`This copy of Flip Desk is older than the data it found in ${INFO.dataDir}.`);
    expect(dataOnly.steps[1]).toContain('get the latest code into its folder, then run npm start.');
    expect(dataOnly.steps.join('\n')).not.toContain(INFO.dataDir);
    expect(dataOnly.copy).toEqual([{ label: 'Data folder', value: INFO.dataDir, path: true }]);
  });

  it('speaks plainly: no "schema", no "database", no "migration"', () => {
    const t = dataTooNewText(refusal, INFO);
    const all = [t.title, t.lead, t.why, t.safe, t.stepsTitle, ...t.steps, t.copyTitle, ...t.copy.map((r) => r.label)].join('\n');
    expect(all).not.toMatch(/schema|database|migrat|sqlite/i);
  });
});
