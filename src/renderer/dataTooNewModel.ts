// 0.7.2: the dashboard's screen for a copy of Flip Desk that is older than its data. Two copies can
// share one data folder (a development build and an install, or two clones of the code). Once the
// newer one has updated the database, the older one's service refuses it (SchemaVersionError in
// src/service/db/migrations.ts) and every call rejects with that message. The service is reachable,
// so "Can't reach the background service" was wrong; this screen says what happened, that nothing
// changed, which copy is running and how to get past it. Pure: App.tsx only lays the text out.

import type { AppInfo } from '../shared/rpc';

/** The data versions in a refusal. */
export interface DataTooNew {
  /** The version the data is at (the database's user_version). */
  found: number;
  /** The newest data version this copy reads. */
  supported: number;
}

// SchemaVersionError's wording, which this must not change. Matched anywhere in the text: the error
// can reach the dashboard behind a prefix such as Electron's "Error invoking remote method ...".
const REFUSAL_RE = /Database schema version (\d+) is newer than this app supports \((\d+)\)/;

/** The versions when `message` is the newer-data refusal; null for any other error. */
export function parseDataTooNew(message: string | null | undefined): DataTooNew | null {
  if (!message) return null;
  const m = REFUSAL_RE.exec(message);
  if (!m) return null;
  const found = Number(m[1]);
  const supported = Number(m[2]);
  // The service refuses only data newer than it reads; anything else is not this case.
  if (!Number.isSafeInteger(found) || !Number.isSafeInteger(supported) || found <= supported) return null;
  return { found, supported };
}

export interface DataTooNewRow {
  label: string;
  value: string;
  /** A folder: shown in the path style, like Settings' "This installation". */
  path: boolean;
}

export interface DataTooNewText {
  title: string;
  lead: string;
  why: string;
  safe: string;
  stepsTitle: string;
  steps: string[];
  copyTitle: string;
  /** What main reported about the running copy, and nothing else. */
  copy: DataTooNewRow[];
  /** Said instead of the rows when main reported nothing. */
  copyUnknown: string | null;
}

/** A non-blank string, or null: the screen never names a folder or version it was not told. */
function known(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The screen's text. `info` is main's 'app.info' answer: null while it loads or when it failed. */
export function dataTooNewText(refusal: DataTooNew, info: Partial<AppInfo> | null | undefined): DataTooNewText {
  const version = known(info?.version);
  const appDir = known(info?.appDir);
  const dataDir = known(info?.dataDir);
  const copy: DataTooNewRow[] = [];
  if (version) copy.push({ label: 'Version', value: version, path: false });
  if (appDir) copy.push({ label: 'Runs from', value: appDir, path: true });
  if (dataDir) copy.push({ label: 'Data folder', value: dataDir, path: true });
  return {
    title: 'This copy of Flip Desk is older than its data',
    lead: dataDir ? `This copy of Flip Desk is older than the data it found in ${dataDir}.` : 'This copy of Flip Desk is older than the data in its data folder.',
    why:
      'A newer copy of Flip Desk already updated that data, for example a development build or a newer installer. ' +
      `The data is at version ${refusal.found}. This copy reads up to version ${refusal.supported}.`,
    safe: 'Nothing was changed. Your data is safe.',
    stepsTitle: 'What to do',
    steps: [
      'Close this copy and start the newer one.',
      'Or update this copy. ' +
        `If you run it from source, get the latest code into ${appDir ?? 'its folder'}, then run npm start. ` +
        'If you installed it, install the newer version.',
    ],
    copyTitle: 'Which copy is running',
    copy,
    copyUnknown: copy.length > 0 ? null : 'Flip Desk could not tell which copy this is.',
  };
}
