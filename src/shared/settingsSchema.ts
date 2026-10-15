// zod schema for Settings (owned by the Electron main process, usable anywhere).
//
//   parseSettings(raw)          lenient: every invalid or missing field falls back to
//                               its DEFAULT_SETTINGS value; used when loading settings.json
//   applySettingsPatch(base, p) strict: validates a partial update, merges it and
//                               validates the result; throws SettingsValidationError

import { z } from 'zod';
import { DEFAULT_SETTINGS, mergeSettings } from './defaults';
import type { DeepPartial, Settings } from './types';
import { isValidAccelerator } from './accelerator';
import { CONTACT_MAX, CONTACT_RE } from './contact';

const MAX_SCRAP = 1_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const scrap = z.number().int().min(0).max(MAX_SCRAP);
const timestamp = z.number().int().min(0).max(8.64e15);
const bool = z.boolean();

// ---------------------------------------------------------------------------
// Leaf helpers
// ---------------------------------------------------------------------------

// The accelerator and contact rules live in zod-free modules so the renderer
// validates with exactly the same rules.
export { isValidAccelerator };

const contactUrl = z.string().trim().max(CONTACT_MAX).regex(CONTACT_RE, 'Use printable characters only, no spaces or parentheses');
const keyword = z.string().trim().toLowerCase().min(1).max(64);
const steamId64 = z.string().trim().regex(/^\d{17}$/, 'Expected a 17-digit SteamID64');
const noNul = (s: string) => !s.includes('\0');
const shortText = (max: number) => z.string().max(max).refine(noNul, 'Invalid character');
// An absolute folder on a drive letter ("C:\pages", "D:/saved"); mapped drives work.
// UNC shares ("\\host\share"), device paths ("\\?\…") and relative paths are
// rejected: the service stats and watches this path, and on Windows touching a
// UNC path authenticates to that host over SMB, while a relative path resolves
// against whatever the working directory is (System32 at login). No node:path
// here: this module is shared with the renderer.
const LOCAL_DIR_RE = /^[A-Za-z]:[\\/]/;
const localDir = z
  .string()
  .min(1)
  .max(1024)
  .refine(noNul, 'Invalid character')
  .refine((s) => LOCAL_DIR_RE.test(s), 'Choose a folder on a local drive');

// ---------------------------------------------------------------------------
// Group schemas (strict)
// ---------------------------------------------------------------------------

const keyPriceSchema = z.object({
  mode: z.enum(['auto', 'manual']),
  manualScrap: scrap.nullable(),
  scraptfBuyScrap: scrap.nullable(),
  scraptfSellScrap: scrap.nullable(),
  scraptfObservedAt: timestamp.nullable(),
});

const profitSchema = z.object({
  minProfitScrap: scrap,
  minProfitPctOfCost: z.number().min(0).max(10),
  minMargin: z.number().min(0).max(1),
  frictionScrap: scrap,
  outlierVsMedian: z.number().min(1).max(100),
  outlierVsRef: z.number().min(1).max(100),
  unusualRiskKeys: z.number().min(0).max(100_000),
  useOrder: z.enum(['conservative', 'best', 'instant']),
  inputStaleMs: z.number().int().min(0).max(365 * DAY_MS),
  notesKeywords: z.array(keyword).max(200),
  referenceMaxAgeMs: z.number().int().min(0).max(365 * DAY_MS),
  suspectMargin: z.number().min(0).max(1000),
});

const liveFeedSchema = z.object({
  enabled: bool,
  dailyCapBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  keepSellListings: z.enum(['watched', 'all']),
});

const connectorsSchema = z.object({
  bptfApi: bool,
  pricedb: bool,
  pricedbSocket: bool,
  scm: bool,
});

const permissionSchema = z.object({
  grantor: shortText(200),
  contact: shortText(200),
  grantedAt: shortText(100),
  scope: shortText(1000),
});

const importSchema = z.object({
  enabled: bool,
  acknowledgedAt: timestamp.nullable(),
  watchFolder: localDir.nullable(),
  permission: permissionSchema.nullable(),
});

const inputKind = z.enum(['user', 'import', 'rule']);

const notificationsSchema = z.object({
  enabled: bool,
  minConfidence: z.number().min(0).max(100),
  minProfitScrap: scrap,
  dedupMs: z.number().int().min(0).max(30 * DAY_MS),
  inputKinds: z.array(inputKind).max(3),
  silent: bool,
  // A settings file from before v0.3 has no key: the lenient load falls back to the default (on).
  holdings: bool,
});

const appSchema = z.object({
  startAtLogin: bool,
  startHidden: bool,
  closeToTray: bool,
  quickEntryHotkey: z.string().max(64).refine(isValidAccelerator, 'Not a usable shortcut (needs Ctrl, Alt or Super plus a key, and not a system shortcut such as Ctrl+C or Alt+F4)'),
});

const uiSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']),
  density: z.enum(['comfortable', 'compact']),
});

export const settingsSchema = z.object({
  contactUrl,
  keyPrice: keyPriceSchema,
  profit: profitSchema,
  liveFeed: liveFeedSchema,
  connectors: connectorsSchema,
  import: importSchema,
  notifications: notificationsSchema,
  app: appSchema,
  networkPaused: bool,
  blocklist: z.array(steamId64).max(10_000),
  ui: uiSchema,
});

/** Validates `settings.set` input: every group and field optional; arrays and records replace whole. */
export const settingsPatchSchema = z.object({
  contactUrl: contactUrl.optional(),
  keyPrice: keyPriceSchema.partial().optional(),
  profit: profitSchema.partial().optional(),
  liveFeed: liveFeedSchema.partial().optional(),
  connectors: connectorsSchema.partial().optional(),
  import: importSchema.partial().optional(),
  notifications: notificationsSchema.partial().optional(),
  app: appSchema.partial().optional(),
  networkPaused: bool.optional(),
  blocklist: z.array(steamId64).max(10_000).optional(),
  ui: uiSchema.partial().optional(),
});

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
// Compile-time guard: the schema must describe exactly the Settings type.
void (true satisfies Equals<z.output<typeof settingsSchema>, Settings>);

// ---------------------------------------------------------------------------
// Lenient parsing (load from disk)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Keeps the valid, de-duplicated elements of an array instead of dropping the whole field. */
function lenientArray<T>(el: z.ZodType<T>, max: number) {
  return z.array(z.unknown()).transform((items) => {
    const out: T[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const r = el.safeParse(item);
      if (!r.success) continue;
      const k = JSON.stringify(r.data);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(r.data);
      if (out.length >= max) break;
    }
    return out;
  });
}

const LENIENT_LEAVES: Record<string, z.ZodType> = {
  'profit.notesKeywords': lenientArray(keyword, 200),
  'notifications.inputKinds': lenientArray(inputKind, 3),
  blocklist: lenientArray(steamId64, 10_000),
};

function parseGroup(
  schema: z.ZodObject,
  raw: unknown,
  defaults: Record<string, unknown>,
  prefix: string,
  invalid: string[],
): Record<string, unknown> {
  if (!isRecord(raw)) {
    if (raw !== undefined) invalid.push(prefix);
    return structuredClone(defaults);
  }
  const out: Record<string, unknown> = {};
  for (const [key, leaf] of Object.entries(schema.shape as Record<string, z.ZodType>)) {
    const path = `${prefix}.${key}`;
    const r = (LENIENT_LEAVES[path] ?? leaf).safeParse(raw[key]);
    if (r.success) {
      out[key] = r.data;
    } else {
      out[key] = structuredClone(defaults[key]);
      if (raw[key] !== undefined) invalid.push(path);
    }
  }
  return out;
}

/** Cross-field rules shared by load and update. Returns a message when `s` breaks one. */
function crossFieldProblem(s: Settings): string | null {
  if (s.import.enabled && s.import.acknowledgedAt === null) {
    return 'import.enabled: saved-page import needs the acknowledgement first';
  }
  return null;
}

/**
 * Parses untrusted settings (settings.json). Never throws: each invalid or
 * missing field falls back to DEFAULT_SETTINGS; `invalid` lists the dotted
 * paths of fields that were present but rejected.
 */
export function parseSettingsWithReport(raw: unknown): { settings: Settings; invalid: string[] } {
  const invalid: string[] = [];
  const src = isRecord(raw) ? raw : {};
  if (raw !== undefined && !isRecord(raw)) invalid.push('(root)');
  const d = DEFAULT_SETTINGS as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, schema] of Object.entries(settingsSchema.shape as Record<string, z.ZodType>)) {
    if (schema instanceof z.ZodObject) {
      out[key] = parseGroup(schema, src[key], d[key] as Record<string, unknown>, key, invalid);
      continue;
    }
    const r = (LENIENT_LEAVES[key] ?? schema).safeParse(src[key]);
    if (r.success) {
      out[key] = r.data;
    } else {
      out[key] = structuredClone(d[key]);
      if (src[key] !== undefined) invalid.push(key);
    }
  }

  const settings = out as unknown as Settings;
  if (crossFieldProblem(settings)) {
    settings.import.enabled = false;
    invalid.push('import.enabled');
  }
  return { settings, invalid };
}

export function parseSettings(raw: unknown): Settings {
  return parseSettingsWithReport(raw).settings;
}

// ---------------------------------------------------------------------------
// Strict update
// ---------------------------------------------------------------------------

export class SettingsValidationError extends Error {
  override readonly name = 'SettingsValidationError';
  constructor(message: string) {
    super(message);
  }
}

function describeIssues(error: z.ZodError): string {
  const parts = error.issues.slice(0, 5).map((i) => {
    const path = i.path.map(String).join('.');
    return path ? `${path}: ${i.message}` : i.message;
  });
  const more = error.issues.length > 5 ? ` (+${error.issues.length - 5} more)` : '';
  return `Invalid settings: ${parts.join('; ')}${more}`;
}

/** Validates the shape of a `settings.set` patch. Throws SettingsValidationError. */
export function validateSettingsPatch(patch: unknown): DeepPartial<Settings> {
  if (patch === undefined || patch === null) return {};
  const r = settingsPatchSchema.safeParse(patch);
  if (!r.success) throw new SettingsValidationError(describeIssues(r.error));
  return r.data as DeepPartial<Settings>;
}

/**
 * Validates `patch`, merges it into `base` and validates the merged result,
 * including cross-field rules. Returns a new object; `base` is not modified.
 */
export function applySettingsPatch(base: Settings, patch: unknown): Settings {
  const valid = validateSettingsPatch(patch);
  const merged = mergeSettings(base, valid);
  const r = settingsSchema.safeParse(merged);
  if (!r.success) throw new SettingsValidationError(describeIssues(r.error));
  const problem = crossFieldProblem(r.data);
  if (problem) throw new SettingsValidationError(`Invalid settings: ${problem}`);
  return r.data;
}
