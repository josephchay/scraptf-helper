// 0.9 docs (D6, plan C.7): the design brief's corrections from the 2026-10-22 research (docs/RESEARCH.md) and the
// 0.9 rows of test/fixtures/bptf/FIELDS.md. The brief keeps every corrected line as written, with a dated note in the
// same section: after the line, or between the section heading and the line where the note belongs under a table.
// Each note's claims are then checked against the code and the 2026-10-14 capture (test/fixtures/bptf/ws-sample.json),
// so a later change cannot leave a note silently wrong. Nothing is fetched.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PERMISSION_QUESTIONS, PERMISSION_TEMPLATE } from '../../src/renderer/aboutModel';
import { bptfListingActive, isBannedFromBans, mapWsPayload } from '../../src/service/connectors/bptfItem';
import { BUDGETS } from '../../src/service/net/budgets';
import { STEAM_RATE_LIMIT_ERESULTS } from '../../src/service/net/http';
import { botServiceOf } from '../../src/shared/buyerSeen';
import { DEFAULT_SETTINGS } from '../../src/shared/defaults';
import { manncoNetCents } from '../../src/shared/venues';
import { createStubSchema, loadFixture, type WsSample } from '../bptf/helpers';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const BRIEF = read('docs/DESIGN_BRIEF.md');
const LINES = BRIEF.split(/\r?\n/);
const FIELDS = read('test/fixtures/bptf/FIELDS.md');
const sample = loadFixture<WsSample>('ws-sample.json');
const events = sample.events;
/** The feed's key value in refined in the capture (FIELDS.md's `deal` row), for community prices quoted in keys. */
const FEED_KEY_REF = 64.555;

/** One corrected line of the brief and the note that goes with it. */
interface BriefAnchor {
  /** The section, as the brief numbers it. */
  where: string;
  /** The start of the section's heading line. */
  heading: string;
  /** The corrected line, verbatim from 0.8.0. */
  line: string;
  /** 'after': the note follows the line in its section; 'before': it sits between the heading and the line. */
  place: 'after' | 'before';
  /** How the note opens: a dated correction, or a 0.9 note for a rule 0.9 changed. */
  marker: string;
  /** Phrases the note must carry: its source or its 0.9 consequence. */
  says: string[];
}

const ANCHORS: BriefAnchor[] = [
  {
    where: '§1.5',
    heading: '### 1.5 ',
    line: '- Trade Protection (7-day reversible trades) currently covers only CS2 (https://help.steampowered.com/en/faqs/view/365F-4BEE-2AE2-7BDD).',
    place: 'after',
    marker: '**Correction (2026-10-22',
    says: ['RESEARCH §4.6, §9 q15', 'contested', 'https://docs.dmarket.com/v1/swagger.html', 'Settings → Trade lock'],
  },
  {
    where: '§2.0',
    heading: '### 2.0 ',
    line: '| `marketplace.tf/api`, `api.stntrading.eu` | none, or credits | on click only |',
    place: 'after',
    marker: '**Note (0.9',
    says: ['RESEARCH §4.6, §8 #14', '300 per day', '`x-eresult` of 25 or 84', 'Cloudflare challenge script'],
  },
  {
    where: '§2.7',
    heading: '### 2.7 ',
    line: '**Record shape** (**H**):',
    place: 'before',
    marker: '**Correction (2026-10-22',
    says: ['RESEARCH §4.7', '328 points', 'within 2 days'],
  },
  {
    where: '§5.1',
    heading: '### 5.1 ',
    line: '- ref → scrap: `Math.round(ref * 9)`. This is safe for values truncated to 2 decimals: 1.33 → 12, 64.33 → 579, 29.66 → 267.',
    place: 'after',
    marker: '**Correction (2026-10-22',
    says: ['RESEARCH §4.2', '6 of 293 metal values', '4.5, 4.05, 16.38, 18.83, 42.16, 57.05', '40.5 → 41', 'RESEARCH #20'],
  },
  {
    where: '§5.4',
    heading: '### 5.4 ',
    line: '- Optional user setting "friction per trade" in scrap (default 0) for the time and trade-hold cost.',
    place: 'before',
    marker: '**Correction (2026-10-22',
    says: ['RESEARCH §4.4', '5% fee', 'https://docs.mannco.store/api-reference/deposit/instant-sell.md', '95% rounded up'],
  },
  {
    where: '§5.5',
    heading: '### 5.5 ',
    line: "- **Instant** = the best non-outlier order whose `source === 'userAgent'` (a bot, likely to auto-accept). That `userAgent` means \"bot\" is a heuristic: marketplace.tf listings can carry one too.",
    place: 'after',
    marker: '**Correction (2026-10-22',
    says: ['RESEARCH §4.2', '294 live events', 'only 253', '`isBot` in `src/service/connectors/bptfItem.ts`', '`OrderSummary.botService`'],
  },
  {
    where: '§5.7',
    heading: '### 5.7 ',
    line: 'Clamp to 0–100. **High** ≥ 70, **Medium** 45–69, **Low** < 45.',
    place: 'after',
    marker: '**Correction (2026-10-22',
    says: ['RESEARCH §4.2', 'all 299 live events', 'no longer adds it', '`notifications.minConfidence` stays 45'],
  },
  {
    where: '§5.8',
    heading: '### 5.8 ',
    line: '  - If Valve extends Trade Protection to TF2, flips become locked for 7 days; there is a settings flag for this.',
    place: 'after',
    marker: '**Correction (2026-10-22',
    says: ['RESEARCH §1.2', 'Settings → Trade lock', 'not opportunities'],
  },
  {
    where: '§8',
    heading: '## 8. ',
    line: '| Shared enforcement across scrap.tf, bp.tf and marketplace.tf | Treat them as one risk domain: the same conservative budgets everywhere, no alternate accounts, VPN warning. |',
    place: 'after',
    marker: '**Corrections (2026-10-22',
    says: ['settled at 5%', 'contested', 'applies to Holdings'],
  },
  {
    where: 'Appendix C',
    heading: '## Appendix C',
    line: '- I will follow whatever you decide.',
    place: 'after',
    marker: '**Correction (2026-10-22',
    says: ['never connects to scrap.tf', 'never sends requests to scrap.tf on its own', '`PERMISSION_TEMPLATE`', 'three more questions'],
  },
];

/** The heading line and the [start, end) line range of the section holding line `i` (headings bound it). */
function sectionOf(i: number): { heading: string; start: number; end: number } {
  let start = i;
  while (start > 0 && !LINES[start]!.startsWith('#')) start--;
  let end = i + 1;
  while (end < LINES.length && !LINES[end]!.startsWith('#')) end++;
  return { heading: LINES[start]!, start, end };
}

/** An anchor's note: the first marker line after it in its section ('after'), or the last one before it ('before'). */
function noteOf(a: BriefAnchor, at: number): string | undefined {
  const { start, end } = sectionOf(at);
  const span = a.place === 'after' ? LINES.slice(at + 1, end) : LINES.slice(start + 1, at).reverse();
  return span.find((l) => l.includes(a.marker));
}

/** The capture's metal amount of an event, when it has one. */
function metalOf(p: Record<string, unknown>): number | null {
  const m = (p['currencies'] as { metal?: unknown } | undefined)?.metal;
  return typeof m === 'number' ? m : null;
}

/** A community price in refined: a price quoted in keys at the feed's key value. */
function communityRef(c: { value: number; currency: string }): number {
  return c.currency === 'keys' ? c.value * FEED_KEY_REF : c.value;
}

describe('0.9 docs: DESIGN_BRIEF corrections (2026-10-22)', () => {
  it('says under its opening caveat how corrections and 0.9 notes are marked', () => {
    const at = LINES.indexOf('Platform clauses are paraphrased. Engineers and the user should read the linked pages for exact wording.');
    expect(at).toBeGreaterThan(0);
    expect(LINES[at + 1]).toBe('');
    expect(LINES[at + 2]).toBe(
      'Corrections found by the 2026-10-22 research (`docs/RESEARCH.md`) are marked in place as **Correction (2026-10-22)**, under the text they correct, which is kept as written. Changes 0.9 made to a rule stated here are marked **Note (0.9)**.',
    );
  });

  it.each(ANCHORS)('$where keeps its line verbatim and carries its dated note in the same section', (a) => {
    expect(LINES.filter((l) => l === a.line), `${a.where}: the corrected line, once and verbatim`).toHaveLength(1);
    const at = LINES.indexOf(a.line);
    expect(sectionOf(at).heading.startsWith(a.heading), `${a.where} sits under ${a.heading}`).toBe(true);
    const note = noteOf(a, at);
    expect(note, `${a.where}: a note ${a.place} the line opening "${a.marker}"`).toBeDefined();
    // A quote block, so it reads as a note on the brief, never as the brief's own rule.
    expect(note!.trimStart().startsWith(`> ${a.marker}`)).toBe(true);
    for (const phrase of a.says) expect(note, `${a.where} says "${phrase}"`).toContain(phrase);
  });

  it('keeps notes on list items inside their lists (§5.1, §5.8)', () => {
    const indentOf = (a: BriefAnchor) => /^ */.exec(noteOf(a, LINES.indexOf(a.line))!)![0].length;
    expect(indentOf(ANCHORS.find((a) => a.where === '§5.1')!)).toBe(2);
    expect(indentOf(ANCHORS.find((a) => a.where === '§5.8')!)).toBe(4);
  });

  it('holds exactly the ten dated notes, each one line, and no undated correction', () => {
    const notes = LINES.filter((l) => /^\s*> \*\*(Corrections? \(2026-10-22|Note \(0\.9)/.test(l));
    expect(notes).toHaveLength(ANCHORS.length);
    for (const l of LINES.filter((x) => x.includes('**Correction'))) {
      if (l.startsWith('Corrections found by')) continue;
      expect(l, 'every correction is dated').toMatch(/\*\*Corrections? \(2026-10-22/);
    }
  });

  it('keeps the save advice other tests read ("HTML only", importGuidance)', () => {
    expect(BRIEF).toContain('with "HTML only"');
  });
});

describe('0.9 docs: the notes match the code', () => {
  it('§5.7: the confidence score gives no online bonus', () => {
    expect(read('src/service/domain/confidence.ts')).not.toContain('Buyer is online');
  });

  it('§2.0: the Steam Market budget is 1 per 5 s and 300 a day, and x-eresult 25/84 is a rate limit', () => {
    const scm = BUDGETS.find((b) => b.id === 'scm');
    expect(scm?.minIntervalMs).toBe(5_000);
    expect(scm?.maxPerDay).toBe(300);
    expect([...STEAM_RATE_LIMIT_ERESULTS].sort()).toEqual(['25', '84']);
  });

  it("§5.4: mannco's seller net is 95% rounded up", () => {
    expect(manncoNetCents(100)).toBe(95);
    expect(manncoNetCents(101)).toBe(96);
  });

  it('§1.5, §5.8: the Trade lock setting exists and defaults to Not sure', () => {
    expect(DEFAULT_SETTINGS.tradeLock.mode).toBe('unknown');
  });

  it('§5.5: a bot is an event with a userAgent object, whatever its `source` says', () => {
    const schema = createStubSchema();
    const now = Date.UTC(2026, 9, 14, 9, 12, 5);
    let mapped = 0;
    let sourceOnly = 0;
    for (const e of events) {
      const r = mapWsPayload(e.payload, schema, now);
      if (!r.ok) continue;
      mapped++;
      const hasObject = typeof e.payload['userAgent'] === 'object' && e.payload['userAgent'] !== null;
      expect(r.listing.isBot === true, e.id).toBe(hasObject);
      if (e.payload['source'] === 'userAgent' && !hasObject) sourceOnly++;
    }
    expect(mapped).toBe(events.length);
    expect(sourceOnly).toBe(294 - 253);
  });

  it('Appendix C: the email no longer says "never connects" and asks three more questions', () => {
    expect(PERMISSION_TEMPLATE).toContain('never sends requests to scrap.tf on its own');
    expect(PERMISSION_TEMPLATE).not.toContain('never connects to scrap.tf');
    expect(PERMISSION_QUESTIONS).toHaveLength(3);
  });

  it('FIELDS.md names rules that exist', () => {
    for (const fn of [bptfListingActive, isBannedFromBans, botServiceOf]) expect(typeof fn).toBe('function');
  });
});

describe('0.9 docs: the notes and FIELDS.md match the 2026-10-14 capture', () => {
  it('holds 299 live events', () => {
    expect(events).toHaveLength(299);
    expect(sample._meta['eventsSelected']).toBe(299);
  });

  it('§5.1: 6 of 293 metal values are half-scrap amounts, 5 of them on multi-key buy orders', () => {
    const metals = events.map((e) => ({ e, m: metalOf(e.payload) })).filter((x) => x.m !== null);
    expect(metals).toHaveLength(293);
    const half = metals.filter(({ m }) => Math.abs(((m! * 9) % 1) - 0.5) < 0.15);
    expect(half.map((x) => x.m).sort((a, b) => a! - b!)).toEqual([4.05, 4.5, 16.38, 18.83, 42.16, 57.05]);
    const multiKeyBuys = half.filter(({ e }) => {
      const keys = (e.payload['currencies'] as { keys?: number }).keys ?? 0;
      return e.payload.intent === 'buy' && keys >= 2;
    });
    expect(multiKeyBuys).toHaveLength(5);
    expect(Math.round(4.5 * 9)).toBe(41);
  });

  it('§5.5, §5.7: `source` "userAgent" on 294, a userAgent object on 253, `user.online` true on all 299', () => {
    expect(events.filter((e) => e.payload['source'] === 'userAgent')).toHaveLength(294);
    expect(events.filter((e) => typeof e.payload['userAgent'] === 'object' && e.payload['userAgent'] !== null)).toHaveLength(253);
    expect(events.filter((e) => (e.payload['user'] as { online?: unknown }).online === true)).toHaveLength(299);
  });

  it('`deal`: only on sell listings, 9 of 78 (8 updates, 1 delete), at the community price with percent below it', () => {
    const sells = events.filter((e) => e.payload.intent === 'sell');
    expect(sells).toHaveLength(78);
    expect(events.filter((e) => e.payload.intent === 'buy')).toHaveLength(221);
    const withDeal = events.filter((e) => e.payload['deal'] !== undefined);
    expect(withDeal.every((e) => e.payload.intent === 'sell')).toBe(true);
    expect(withDeal).toHaveLength(9);
    expect(withDeal.filter((e) => e.event === 'listing-update')).toHaveLength(8);
    expect(withDeal.filter((e) => e.event === 'listing-delete')).toHaveLength(1);
    for (const e of withDeal) {
      const deal = e.payload['deal'] as { percent: number; value: number };
      const raw = (e.payload['value'] as { raw: number }).raw;
      const community = (e.payload.item['price'] as { community: { value: number; currency: string } }).community;
      expect(Math.abs(deal.value - raw / (1 - deal.percent)), e.id).toBeLessThan(0.01);
      expect(Math.abs(deal.value - communityRef(community)), e.id).toBeLessThan(0.01);
      expect(deal.percent).toBeGreaterThanOrEqual(0.0875);
      expect(deal.percent).toBeLessThan(0.2525);
    }
    // The one sell under the community price without a deal: about 2.5% under.
    const underWithout = sells.filter((e) => {
      const c = (e.payload.item['price'] as { community?: { value?: unknown; currency: string } } | undefined)?.community;
      if (e.payload['deal'] !== undefined || typeof c?.value !== 'number') return false;
      return (e.payload['value'] as { raw: number }).raw < communityRef(c as { value: number; currency: string });
    });
    expect(underWithout).toHaveLength(1);
    const c = (underWithout[0]!.payload.item['price'] as { community: { value: number; currency: string } }).community;
    const gap = 1 - (underWithout[0]!.payload['value'] as { raw: number }).raw / communityRef(c);
    expect(gap).toBeCloseTo(0.025, 2);
  });

  it('`flagImpersonated` is true on exactly one event (events[288]), and every `status` is "active"', () => {
    const flagged = events.flatMap((e, i) => ((e.payload['user'] as { flagImpersonated?: unknown }).flagImpersonated === true ? [i] : []));
    expect(flagged).toEqual([288]);
    expect(events.filter((e) => e.payload['status'] === 'active')).toHaveLength(299);
  });
});

describe('0.9 docs: FIELDS.md rows', () => {
  it('replaces the `deal` row (the old wording survives only as the dated quote)', () => {
    expect(FIELDS).not.toMatch(/^\| `payload\.deal` \| only on some deletes/m);
    expect(FIELDS.split('only on some deletes').length - 1).toBe(1);
    expect(FIELDS).toContain('Corrected 2026-10-22 (earlier: "only on some deletes")');
    expect(FIELDS).toContain('9 of the 78 sell events');
  });

  it('documents what 0.9 reads: status, impersonation, bans, the bot label and the community price', () => {
    expect(FIELDS).toMatch(/^\| `payload\.status` \| .*`bptfListingActive`/m);
    expect(FIELDS).toContain('`flagImpersonated` (`true` on 1 of the 299 live events');
    expect(FIELDS).toContain('`isBannedFromBans`');
    expect(FIELDS).toContain('`botServiceOf`');
    expect(FIELDS).toMatch(/^\| `price` \| .*`wsCommunityPriceOf`/m);
    expect(FIELDS).toContain('`steam`, `suggested` and `deal` are not read');
  });

  it('says which counts are out of the full capture and which out of ws-sample.json', () => {
    expect(FIELDS).toContain('Counts are out of 1,556 events');
    expect(FIELDS).toContain('those count its 299 live events');
  });
});
