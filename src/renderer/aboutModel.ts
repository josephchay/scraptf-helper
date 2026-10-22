// 0.9 (RESEARCH #25): the About page's "Unsupported by scrap.tf" panel: what scrap.tf does not offer or allow, why, and
// what Flip Desk does instead, each with its dated sources (docs/RESEARCH.md §6.1), and the email the user may send
// scrap.tf themselves (DESIGN_BRIEF Appendix C, extended). Pure text. The source addresses are copied to the clipboard
// for the user to read in their own browser, never opened or fetched by the app (R1, R3): most of them are not on the
// links.open allowlist, so the panel has no opener at all (test/compliance/static.test.ts pins it), and
// test/renderer/externalLinks.test.ts skips this file for that reason.

/** How a source was read: at the source, as a search-engine copy, or a community report read that way. */
export type BoundaryGrade = 'verified' | 'search-copy' | 'community';
/** One dated source of a row: its label, its address (copied, never opened) and how it was read. */
export interface BoundarySource {
  label: string;
  url: string;
  grade: BoundaryGrade;
}
/** One thing scrap.tf does not offer or allow: what, why, what Flip Desk does instead, and the sources. */
export interface UnsupportedRow {
  id: string;
  what: string;
  why: string;
  instead: string;
  sources: readonly BoundarySource[];
}

/** When the sources were read (RESEARCH.md §1.3, §6.1). */
export const UNSUPPORTED_CHECKED = '2026-10-22';

/** How sure each grade of source is, as the source buttons' titles say it. */
export const BOUNDARY_GRADE_LABELS: Readonly<Record<BoundaryGrade, string>> = Object.freeze({
  verified: `read at the source on ${UNSUPPORTED_CHECKED}`,
  'search-copy': `a search-engine copy: the page blocked a direct read on ${UNSUPPORTED_CHECKED}`,
  community: 'a community report, not confirmed by scrap.tf (read as a search-engine copy)',
});

/** The panel's first line: what it lists, when it was checked, and how sure it is. */
export const UNSUPPORTED_INTRO = `What scrap.tf does not offer or allow, why, and what Flip Desk does instead. Checked ${UNSUPPORTED_CHECKED} (docs/RESEARCH.md §6.1); scrap.tf's help and forum pages blocked direct reads that day, so most of these rest on search-engine copies and may be out of date. Copy a source's address to read it yourself.`;

const KB_114: BoundarySource = { label: 'Help: reserving items (kb 114)', url: 'https://scrap.tf/help/kb/114', grade: 'search-copy' };

/** 0.9 (#25): the nine rows, in the order shown (RESEARCH.md §6.1). */
export const SCRAPTF_UNSUPPORTED: readonly UnsupportedRow[] = Object.freeze([
  {
    id: 'monitoring',
    what: 'Automatic watching of scrap.tf for new items, prices and stock',
    why: 'scrap.tf has no API or feed (a staff member refused one in 2015 as too easy to use for botting); its terms name automation and auto-refreshers; its pages sit behind a Cloudflare check; staff describe automatic, behaviour-based flagging.',
    instead: 'You save pages or browse in the opt-in scrap.tf window; Flip Desk imports what you brought and alerts on your own reads and saves.',
    sources: [
      { label: 'Forum: "scrap.tf API changes" (staff, 2015-01-14)', url: 'https://forum.scrap.tf/topic/1182-scraptf-api-changes/', grade: 'search-copy' },
      { label: 'Forum: "scrap.tf API" (2024)', url: 'https://forum.scrap.tf/topic/27296-scraptf-api/', grade: 'search-copy' },
      { label: 'Terms of Service ("Last updated: September 02, 2015")', url: 'https://scrap.tf/terms', grade: 'search-copy' },
      { label: 'Forum: captcha thread (staff on automatic flagging)', url: 'https://forum.scrap.tf/topic/9011-captcha-or-something-similar', grade: 'search-copy' },
    ],
  },
  {
    id: 'item-pages',
    what: "Crawling scrap.tf's item pages or sitemaps",
    why: 'The same reasons, and R1: Flip Desk never sends a request of its own to scrap.tf.',
    instead: 'Nothing: only pages you save or open yourself are read.',
    sources: [{ label: 'Third-party crawler of every item page (code, 2024)', url: 'https://raw.githubusercontent.com/AmityBlamity/tf2scraper/main/urlchecker.py', grade: 'verified' }],
  },
  {
    id: 'auto-queue',
    what: "Joining a bank's queue automatically",
    why: 'No interface exists; joining the queue is what reserves an item; the terms forbid automation; R4.',
    instead: 'You click; Flip Desk shows Pay up to, buy timing and what to know before you buy.',
    sources: [KB_114],
  },
  {
    id: 'rejoin',
    what: 'Leaving and rejoining the queue to wait for a lower price',
    why: 'Not a documented feature; a bot offer that lapses reportedly locks buying for about 2 hours; automating it breaks the terms and R4.',
    instead: 'The Buy now tag, the item panel, the Live check and the Shopping list warn against it.',
    sources: [
      {
        label: 'Forum: the missed-offer penalty (2024-11-21)',
        url: 'https://forum.scrap.tf/topic/27463-does-anyone-think-that-the-trading-penalty-for-failing-to-accept-an-item-trade-from-the-bots-is-a-bit-much/',
        grade: 'community',
      },
      { label: 'Help: offers that expire (kb 26)', url: 'https://scrap.tf/help/kb/26', grade: 'search-copy' },
    ],
  },
  {
    id: 'queue-state',
    what: 'Tracking queue eligibility or how long a reservation lasts',
    why: 'Neither is published; a reservation shows only as a marker on a loaded page, whose markup no real save has confirmed.',
    instead: 'The parser report counts reserved markers; until then a reservation can read as gone.',
    sources: [KB_114],
  },
  {
    id: 'auto-buy',
    what: 'Buying automatically',
    why: "Every buy needs your click, the bot's offer and a Steam mobile confirmation; scrap.tf's terms, Steam's Subscriber Agreement (§4.B, §4.C) and R4.",
    instead: 'Pay up to, buy timing and Record buy; you make every trade.',
    sources: [
      { label: 'Help: how buying works (kb 79)', url: 'https://scrap.tf/help/kb/79', grade: 'search-copy' },
      { label: 'Steam Subscriber Agreement (updated 2026-09-10)', url: 'https://store.steampowered.com/subscriber_agreement/english/', grade: 'verified' },
    ],
  },
  {
    id: 'repricing',
    what: "Using scrap.tf's own repricing schedule",
    why: 'It is not documented; the only claimed one, a hat bank "recently traded" section whose prices drop over time, was reported gone in July 2024.',
    instead: 'Buy timing is estimated from your own saves, and the parser report watches for that section.',
    sources: [
      { label: 'Forum: "Where did the recently traded section go" (July 2024)', url: 'https://forum.scrap.tf/topic/27240-where-did-the-recently-traded-section-go', grade: 'search-copy' },
    ],
  },
  {
    id: 'limits',
    what: 'Reading your per-trade limits and the Community Rules',
    why: 'They show only while you are signed in on scrap.tf.',
    instead: 'You read them on scrap.tf.',
    sources: [{ label: 'Help: the basics (limits)', url: 'https://scrap.tf/help/basics', grade: 'search-copy' }],
  },
  {
    id: 'dev-api',
    what: 'A scrap.tf developer API for item data',
    why: 'The only one found is for chat, in example code up to 2020, on a subdomain R1 bars.',
    instead: 'The email below asks scrap.tf whether a sanctioned feed exists.',
    // D8: RESEARCH.md §6.1's exact address.
    sources: [
      { label: 'Example chat bot (code, last commit 2020-09-20)', url: 'https://raw.githubusercontent.com/Jessecar96/scrap-chat-bot-example/master/index.js', grade: 'verified' },
    ],
  },
]);

/** 0.9 (#25): the email's three numbered questions, in order (the window, the timings, a sanctioned feed). */
export const PERMISSION_QUESTIONS: readonly string[] = Object.freeze([
  'The tool can also show scrap.tf in a window that I browse myself. It never clicks, loads or refreshes a page on its own; it only reads the page I am looking at, as saving it would. Is that acceptable?',
  "How long does a queue reservation last, how long is a bot's trade offer valid, and how long does the lockout after a missed offer last?",
  'Is there a sanctioned feed, export or device key for item data (prices and stock) that a personal tool may use?',
]);

/**
 * The email the user may send scrap.tf from their own address (DESIGN_BRIEF Appendix C; the app never sends it). 0.9
 * (#25): it replaces 0.8's, which said the tool "never connects to scrap.tf" (untrue since the opt-in F21 window), and
 * adds PERMISSION_QUESTIONS, numbered.
 */
export const PERMISSION_TEMPLATE = `To: admin@scrap.tf
Subject: Questions about a personal price-tracking tool and the ToS

Hello,

I use a personal desktop tool that never sends requests to scrap.tf on its own.
I type in prices I see on scrap.tf, and the tool compares them with backpack.tf buy orders from backpack.tf's official API.
Is this acceptable under your Terms of Service?
Would you permit importing pages I save myself (Ctrl+S in my browser), for personal use only?

Three more questions:
${PERMISSION_QUESTIONS.map((q, i) => `${i + 1}. ${q}`).join('\n')}

I will follow whatever you decide.

Thank you.`;

/** 0.9 (#25): a source button's title: its address, how it was read, and that the button copies it (never opens it). */
export function boundarySourceTitle(s: Pick<BoundarySource, 'url' | 'grade'>): string {
  return `${s.url} (${BOUNDARY_GRADE_LABELS[s.grade] ?? BOUNDARY_GRADE_LABELS['search-copy']}). Copies the address.`;
}
