// 0.9 (history, RESEARCH #7): the live feed's item.price.community of watched, held and scrap.tf-priced items, kept as
// history when it changes (bptf_community_history, source 'feed'). Storage only: never a reference, never bptf_community.
//
// H8: per SKU, a price is written when it differs from the last one written (a memo, plus the table's unique index
// for a memo cleared or a restart). Nothing is fetched: the prices come from feed batches already arriving.

import { COMMUNITY_FEED_MEMO_MAX, communityPointKey } from '../../shared/communityHistory';
import type { CommunityPoint } from '../../shared/types';
import type { FeedCommunityPrice, Logger, Repo } from '../contracts';

/** What the recorder writes: bptf_community_history only (INSERT OR IGNORE). */
export interface CommunityFeedRecorderDeps {
  repo: Pick<Repo, 'insertCommunityHistory'>;
  log: Logger;
}

/** 0.9 (history): core's recorder of the feed's community prices (createCommunityFeedRecorder). */
export interface CommunityFeedRecorder {
  /** core.onBatch: writes the batch's prices of `tracked` bases that differ from the last one written for that SKU; returns rows written. */
  record(prices: readonly FeedCommunityPrice[], tracked: ReadonlySet<string>): number;
}

/**
 * The feed's community price recorder (H8). Never throws: a failed write is logged once per failure streak, returns 0
 * and leaves the memo as it was, so the price is retried on its next report.
 */
export function createCommunityFeedRecorder(deps: CommunityFeedRecorderDeps): CommunityFeedRecorder {
  /** SKU -> communityPointKey of the last price written for it. */
  const memo = new Map<string, string>();
  let failing = false;

  return {
    record(prices, tracked) {
      const points: CommunityPoint[] = [];
      const keys: [string, string][] = [];
      for (const p of prices) {
        if (!p || typeof p.sku !== 'string' || !tracked.has(p.sku)) continue;
        const key = communityPointKey(p);
        if (memo.get(p.sku) === key) continue;
        points.push({ sku: p.sku, source: 'feed', currency: p.currency, value: p.value, valueHigh: p.valueHigh, lastUpdate: p.lastUpdate, recordedAt: p.seenAt });
        keys.push([p.sku, key]);
      }
      if (points.length === 0) return 0;
      let written: number;
      try {
        written = deps.repo.insertCommunityHistory(points);
      } catch (err) {
        if (!failing) deps.log.warn('Could not record backpack.tf community prices from the live feed', { error: String(err) });
        failing = true;
        return 0;
      }
      failing = false;
      for (const [sku, key] of keys) {
        // Bounded: past the cap the memo starts over (the unique index keeps a repeat out of the table).
        if (memo.size >= COMMUNITY_FEED_MEMO_MAX && !memo.has(sku)) memo.clear();
        memo.set(sku, key);
      }
      return written;
    },
  };
}
