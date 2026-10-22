// 0.9 (#1): Holdings' Trade lock question and its one-line caution. Steam's Trade Protection may keep a TF2 item the
// user receives untradable for 7 days; Flip Desk cannot read the account, so it asks once (three answers and Valve's
// FAQ, opened in the user's browser on a click) and keeps the answer in settings (Settings → Trade lock changes it).
// With Not sure it only cautions; a 7-day lock changes Holdings' advice, Sellable now and the "Sell:" timing, never a
// price or a profit. Nothing here sends a request of its own: the answer is a settings write.
// Texts: holdingsModel.ts (TRADE_LOCK_*). Styles: styles/holdings.css (trade-lock-*).

import { STEAM_TRADE_PROTECTION_FAQ_URL } from '../../shared/links';
import type { TradeLockMode } from '../../shared/types';
import {
  TRADE_LOCK_BODY,
  TRADE_LOCK_CARD_FOOTER,
  TRADE_LOCK_CARD_ORDER,
  TRADE_LOCK_CAUTION,
  TRADE_LOCK_FAQ_LABEL,
  TRADE_LOCK_LABELS,
  TRADE_LOCK_QUESTION,
  TRADE_LOCK_TITLES,
  tradeLockCautionOn,
  tradeLockSetToast,
} from '../holdingsModel';
import { useApp } from '../hooks/appContext';
import { ExternalLink } from './ExternalLink';
import { Icon } from './Icon';

/** The first-run question: shown until the user answers (settings.tradeLock.answeredAt null), then never again. */
export function TradeLockCard() {
  const { settings, updateSettings, toast } = useApp();
  if (!settings?.tradeLock || settings.tradeLock.answeredAt !== null) return null;
  const answer = async (m: TradeLockMode) => {
    const r = await updateSettings({ tradeLock: { mode: m, answeredAt: Date.now() } });
    if (r) toast(tradeLockSetToast(m), 'good');
  };
  return (
    <section className="card trade-lock-card" aria-labelledby="trade-lock-q">
      <h2 id="trade-lock-q">
        <Icon name="shield" size={14} /> {TRADE_LOCK_QUESTION}
      </h2>
      <p className="small">{TRADE_LOCK_BODY}</p>
      <div className="form-actions">
        {TRADE_LOCK_CARD_ORDER.map((m, i) => (
          <button key={m} type="button" className={i === 0 ? 'btn small primary' : 'btn small'} title={TRADE_LOCK_TITLES[m]} onClick={() => void answer(m)}>
            {TRADE_LOCK_LABELS[m]}
          </button>
        ))}
      </div>
      <ExternalLink url={STEAM_TRADE_PROTECTION_FAQ_URL}>{TRADE_LOCK_FAQ_LABEL}</ExternalLink>
      <p className="muted small">{TRADE_LOCK_CARD_FOOTER}</p>
    </section>
  );
}

/** The one-line caution once the user answered Not sure, while something is held; a link-button opens Settings. */
export function TradeLockCaution({ held }: { held: boolean }) {
  const { settings, navigate } = useApp();
  // tradeLockCautionOn: answered, and the answer is Not sure (tradeLockModeOf 'unknown').
  if (!held || !tradeLockCautionOn(settings)) return null;
  return (
    <p className="hint-line muted small trade-lock-caution">
      <Icon name="shield" size={12} /> {TRADE_LOCK_CAUTION}{' '}
      <button type="button" className="link-btn" onClick={() => navigate('settings')}>
        Trade lock setting
      </button>
    </p>
  );
}
