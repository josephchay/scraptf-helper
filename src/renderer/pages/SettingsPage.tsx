import { useEffect, useRef, useState, type ReactNode } from 'react';
import { bankStockPagePath } from '../../shared/bankStock';
import { CHECK_PRIVACY_SENTENCE, CHECK_SAMPLE_TEXT } from '../../shared/check';
import { parsePrice } from '../../shared/currency';
import { BPTF_API_ACCESS_URL, SCRAPTF_BANKS, STEAM_TRADE_PROTECTION_FAQ_URL } from '../../shared/links';
import type { HotkeysStatus } from '../../shared/rpc';
import { SCRAPTF_RESAVE_HELP } from '../../shared/scraptfHistory';
import type { CheckResult, InputKind, ScraptfBank, SecretName, Settings } from '../../shared/types';
import { rpc } from '../api';
import { checkBriefText } from '../checkModel';
import { CheckGroup, CommitInput, ConfirmButton, Field, Segmented, Toggle } from '../components/Controls';
import { ExternalLink } from '../components/ExternalLink';
import { Banner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { TonePill } from '../components/Pills';
import { accelLabel, errorMessage, fmtDateTime, fmtRefOnly, parseSteamIdList } from '../format';
import { useApp } from '../hooks/appContext';
import { usePush, useRpcQuery } from '../hooks/useRpc';
import { useNow } from '../hooks/useTimers';
import { CheckVerdictPill } from './CheckPopup';
import {
  SCRAPTF_WINDOW_ACK_TEXT,
  SCRAPTF_WINDOW_CLEAR_TITLE,
  SCRAPTF_WINDOW_DOES,
  SCRAPTF_WINDOW_ENABLE_LABEL,
  SCRAPTF_WINDOW_KEEP_HINT,
  SCRAPTF_WINDOW_KEEP_LABEL,
  SCRAPTF_WINDOW_LINKS_HINT,
  SCRAPTF_WINDOW_LINKS_LABEL,
  SCRAPTF_WINDOW_NAV_TITLE,
  SCRAPTF_WINDOW_NEVER,
  SCRAPTF_WINDOW_READ_HINT,
  SCRAPTF_WINDOW_READ_LABEL,
  SCRAPTF_WINDOW_RISK,
  WINDOW_CLEARED_TEXT,
  windowAckText,
  windowEnableView,
  windowOpenFailedText,
  windowRefusalText,
} from '../scraptfWindowModel';
import {
  applyBlocklistEdit,
  BUY_TIMING_NOTIFY_LABEL,
  buyTimingNotifyHint,
  CHECK_NOTIFY_LABEL,
  CHECK_POPUP_HINT,
  CHECK_POPUP_LABEL,
  CHECK_WATCH_LABEL,
  checkHotkeyStatus,
  checkNotifyHint,
  checkWatchHint,
  type CheckHotkeySave,
  daysTextToMs,
  EXIT_RESERVE_PCT,
  exitReserveHint,
  quickHotkeyProblem,
  HOLDINGS_NOTIFY_LABEL,
  holdingsNotifyHint,
  INPUT_STALE_HINT,
  inputKindsHint,
  keyPriceHint,
  MARKETPLACE_FEE_HINT,
  MARKETPLACE_FEE_PCT,
  MIN_MARGIN_PCT,
  MIN_PROFIT_PCT_OF_COST,
  MIN_PROFITABLE_DEPTH,
  MIN_PROFITABLE_DEPTH_LABEL,
  minProfitableDepthHint,
  msToDaysText,
  NEW_ON_SCRAPTF_NOTIFY_LABEL,
  newOnScraptfNotifyHint,
  NOTIFY_INPUT_KINDS,
  numberValidator,
  pctTextToRatio,
  ratioToPctText,
  REFERENCE_MAX_AGE_DAYS,
  referenceAgeHint,
  REF_TEXT_ERROR,
  RESAVE_LAST_BANK_TITLE,
  resaveBanksHint,
  resaveBanksShown,
  resaveMinutesOf,
  resaveReminderHint,
  sameIdList,
  scraptfKeyBuyPatch,
  scraptfListKeyView,
  setResaveBank,
  setInputKind,
  SUSPECT_MARGIN_PCT,
  suspectMarginHint,
  userAgentPreview,
  validateCheckHotkey,
  validateContactUrl,
  validateKeyPriceRef,
  validateQuickEntryHotkey,
  validateResaveMinutes,
  WATCHES_NOTIFY_LABEL,
  watchesNotifyHint,
} from '../settingsFields';
import { reserveSuggestionView } from '../riskModel';
// 0.9 (#1): Settings → Trade lock (the user's answer; Holdings counts a 7-day lock).
import { tradeLockModeOf } from '../../shared/holdingAdvice';
import { TRADE_LOCK_MODES, type TradeLockMode } from '../../shared/types';
import { TRADE_LOCK_BODY, TRADE_LOCK_FAQ_LABEL, TRADE_LOCK_HELP, TRADE_LOCK_LABELS, TRADE_LOCK_TITLES, tradeLockAnsweredText } from '../holdingsModel';

const SECTIONS = [
  ['set-access', 'backpack.tf access'],
  ['set-contact', 'Contact'],
  ['set-key', 'Key price'],
  ['set-profit', 'Profit thresholds'],
  ['set-notify', 'Notifications'],
  ['set-import', 'Saved-page import'],
  ['set-window', 'scrap.tf window'],
  ['set-feed', 'Live feed'],
  ['set-connectors', 'Data sources'],
  ['set-block', 'Blocklist'],
  ['set-own', 'Your accounts'],
  ['set-trade', 'Trade lock'],
  ['set-app', 'App behaviour'],
  ['set-check', 'Live check'],
  ['set-look', 'Appearance'],
] as const;

/** "1.33" (ref) to scrap; null when empty or unreadable. */
function refText(scrap: number | null): string {
  return scrap === null ? '' : fmtRefOnly(scrap).replace(' ref', '');
}

function parseRef(text: string): number | null {
  const p = parsePrice(text, 'ref');
  return p && !p.keys ? p.scrap : null;
}

const refValidator = (allowEmpty: boolean) => (v: string) => (allowEmpty && !v.trim() ? null : parseRef(v) === null ? REF_TEXT_ERROR : null);

export function SettingsPage() {
  const { settings } = useApp();
  if (!settings) return <LoadingBlock label="Loading settings…" />;
  return (
    <div className="page settings-page">
      <nav className="settings-toc" aria-label="Settings sections">
        {SECTIONS.map(([id, label]) => (
          <button key={id} type="button" className="toc-link" onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        <AccessSection />
        <ContactSection s={settings} />
        <KeyPriceSection s={settings} />
        <ProfitSection s={settings} />
        <NotifySection s={settings} />
        {/* F20: re-save reminders (the import switches themselves stay on the Import page). */}
        <ImportSection s={settings} />
        {/* F21. Main's settings load always adds the window group; the guard keeps the page up regardless. */}
        {settings.scraptfWindow ? <ScraptfWindowSection s={settings} /> : null}
        <FeedSection s={settings} />
        <ConnectorsSection s={settings} />
        <BlocklistSection s={settings} />
        {/* 0.8 (H3): your own SteamID64s, so your listings leave "Others ask". */}
        <OwnAccountsSection s={settings} />
        {/* 0.9 (#1): Steam's Trade Protection as you know it; Holdings counts a 7-day lock. */}
        <TradeLockSection s={settings} />
        <AppSection s={settings} />
        {/* F16. Main's settings load always adds the check group; the guard keeps the page up regardless. */}
        {settings.check ? <CheckSection s={settings} /> : null}
        <AppearanceSection s={settings} />
        <AboutAppSection />
      </div>
    </div>
  );
}

function Section({ id, title, children, intro }: { id: string; title: string; children: ReactNode; intro?: ReactNode }) {
  return (
    <section className="card settings-section" id={id} aria-labelledby={`${id}-t`}>
      <h2 id={`${id}-t`}>{title}</h2>
      {intro ? <div className="muted small section-intro">{intro}</div> : null}
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------

function AccessSection() {
  return (
    <Section
      id="set-access"
      title="backpack.tf access"
      intro={
        <>
          Your own credentials only. They are encrypted on this computer, never shown again after saving, never logged, and sent only to backpack.tf. Both are on{' '}
          <ExternalLink url={BPTF_API_ACCESS_URL}>next.backpack.tf/account/api-access</ExternalLink>. They are two different values.
        </>
      }
    >
      <SecretField
        name="bptfAccessToken"
        label="Access token"
        help={'Click "Reveal" under "Access Token". Used for snapshots (refreshing an item on demand and keeping the items you price or hold current) and user info.'}
      />
      <SecretField
        name="bptfApiKey"
        label="API key"
        help={'Under "API Key", register a key first (any site URL, e.g. http://localhost, and a short comment), then copy it. Used for community prices (every 2 h) and backpack.tf\'s key price (hourly).'}
      />
      <SecretField name="steamApiKey" label="Steam Web API key (optional)" help="Not needed. Only used if you turn on Steam features later. Check steamcommunity.com/dev/apikey for keys you don't recognise." />
    </Section>
  );
}

function SecretField({ name, label, help }: { name: SecretName; label: string; help: string }) {
  const { secrets, setSecrets, toast, refreshStatus } = useApp();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const stored = secrets?.[name] ?? false;
  const id = `secret-${name}`;

  const save = async (v: string | null) => {
    setBusy(true);
    setTest(null);
    try {
      const s = await rpc('secrets.set', { name, value: v });
      setSecrets(s);
      setValue('');
      refreshStatus();
      toast(v === null ? `${label} removed.` : `${label} saved.`, 'good');
    } catch (e) {
      toast(`Could not save: ${errorMessage(e)}`, 'bad');
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    try {
      setTest(await rpc('secrets.test', { name }));
    } catch (e) {
      setTest({ ok: false, message: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="secret-field">
      <Field label={label} htmlFor={id} hint={help}>
        <form
          className="secret-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) void save(value.trim());
          }}
        >
          <input
            id={id}
            className="input mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            placeholder={stored ? 'Stored and hidden. Type to replace.' : 'Not set'}
            onChange={(e) => setValue(e.target.value)}
          />
          <span className={`pill tone-${stored ? 'good' : 'muted'}`}>{stored ? 'Stored' : 'Not set'}</span>
          <button type="submit" className="btn small primary" disabled={busy || !value.trim()}>
            Save
          </button>
          <button type="button" className="btn small" disabled={busy || !stored} onClick={() => void runTest()}>
            Test
          </button>
          {stored ? (
            <button type="button" className="btn small ghost" disabled={busy} onClick={() => void save(null)}>
              Remove
            </button>
          ) : null}
        </form>
      </Field>
      {test ? (
        <div className={`small ${test.ok ? 'tone-text-good' : 'tone-text-bad'}`} role="status">
          <Icon name={test.ok ? 'check' : 'warning'} size={12} /> {test.message}
        </div>
      ) : null}
    </div>
  );
}

function ContactSection({ s }: { s: Settings }) {
  const { updateSettings, status } = useApp();
  // Exactly what the service sends, including its placeholder while no contact is saved.
  const ua = userAgentPreview(status?.version ?? '0.1.0', s.contactUrl);
  return (
    <Section id="set-contact" title="Contact for the User-Agent" intro="Every request says which app sent it and how to reach you, so API operators can contact you instead of blocking you. Use a page you control or a mailto: address.">
      <Field label="Contact URL" htmlFor="contact-url">
        <CommitInput
          id="contact-url"
          type="url"
          inputMode="url"
          value={s.contactUrl}
          placeholder="https://steamcommunity.com/id/you or mailto:you@example.com"
          validate={validateContactUrl}
          onCommit={(v) => updateSettings({ contactUrl: v.trim() })}
        />
      </Field>
      <div className="ua-preview">
        <span className="muted small">Sent as</span> <code>User-Agent: {ua}</code>
        {s.contactUrl.trim() ? null : <span className="muted small"> Add your contact above to replace the placeholder.</span>}
      </div>
    </Section>
  );
}

function KeyPriceSection({ s }: { s: Settings }) {
  const { updateSettings, status, refreshStatus } = useApp();
  const kp = status?.keyPrice;
  const now = useNow(30_000);
  // F14: a newly saved scrap.tf/items list may carry new scrap.tf key prices (local status read).
  usePush('scraptf.listChanged', () => refreshStatus());
  const listKey = scraptfListKeyView(kp?.scraptfFromList, s.keyPrice, now);
  return (
    <Section id="set-key" title="Key price" intro="Keys you receive from buyers are valued at this price. Auto uses backpack.tf (with an API key), then PriceDB.">
      <Field label="Mode">
        <Segmented
          ariaLabel="Key price mode"
          value={s.keyPrice.mode}
          onChange={(mode) => void updateSettings({ keyPrice: { mode } })}
          options={[
            { value: 'auto', label: 'Automatic' },
            { value: 'manual', label: 'Manual' },
          ]}
        />
      </Field>
      {kp ? (
        <p className="small">
          Now using <strong className="money">{fmtRefOnly(kp.valueScrap)}</strong>
          {kp.stale ? <span className="tone-text-warn"> (stale)</span> : null}.
        </p>
      ) : null}
      {s.keyPrice.mode === 'manual' ? (
        <Field label="Manual key price (ref)" htmlFor="key-manual" hint={keyPriceHint(s.keyPrice.manualScrap)}>
          <CommitInput
            id="key-manual"
            inputMode="decimal"
            value={refText(s.keyPrice.manualScrap)}
            validate={validateKeyPriceRef}
            onCommit={(v) => updateSettings({ keyPrice: { manualScrap: v.trim() ? parseRef(v) : null } })}
            suffix="ref"
          />
        </Field>
      ) : null}
      <div className="form-grid two">
        <Field label="scrap.tf key buy price (ref)" htmlFor="key-stf-buy" hint={keyPriceHint(s.keyPrice.scraptfBuyScrap, 'What scrap.tf charges you for a key. Display only.')}>
          <CommitInput
            id="key-stf-buy"
            inputMode="decimal"
            value={refText(s.keyPrice.scraptfBuyScrap)}
            validate={validateKeyPriceRef}
            onCommit={(v) => updateSettings(scraptfKeyBuyPatch(v.trim() ? parseRef(v) : null, s.keyPrice, Date.now()))}
            suffix="ref"
          />
        </Field>
        <Field label="scrap.tf key sell price (ref)" htmlFor="key-stf-sell" hint={keyPriceHint(s.keyPrice.scraptfSellScrap, 'What scrap.tf pays you for a key. Also caps the automatic value.')}>
          <CommitInput
            id="key-stf-sell"
            inputMode="decimal"
            value={refText(s.keyPrice.scraptfSellScrap)}
            validate={validateKeyPriceRef}
            onCommit={(v) => updateSettings({ keyPrice: { scraptfSellScrap: v.trim() ? parseRef(v) : null, scraptfObservedAt: Date.now() } })}
            suffix="ref"
          />
        </Field>
      </div>
      {s.keyPrice.scraptfObservedAt ? <p className="muted small">scrap.tf key prices entered {fmtDateTime(s.keyPrice.scraptfObservedAt)}.</p> : null}
      {listKey ? (
        <p className="small" title={listKey.title}>
          {listKey.text}{' '}
          <TonePill tone={listKey.pill === 'In use' ? 'good' : listKey.pill === 'Partly in use' ? 'info' : 'muted'}>{listKey.pill}</TonePill> <span className="muted">{listKey.status}</span>
        </p>
      ) : null}
    </Section>
  );
}

function ProfitSection({ s }: { s: Settings }) {
  const { updateSettings } = useApp();
  const p = s.profit;
  // Returns the save so a field the app rejects goes back to the value in effect.
  const set = (patch: Partial<Settings['profit']>) => updateSettings({ profit: patch });
  return (
    <Section id="set-profit" title="Profit thresholds" intro="An item is profitable when profit is at least the larger of the minimum profit and the percentage of cost, and the margin is at least the minimum margin.">
      <Field label="Revenue used for profit">
        <Segmented
          ariaLabel="Revenue used for profit"
          value={p.useOrder}
          onChange={(useOrder) => set({ useOrder })}
          options={[
            { value: 'conservative', label: 'Conservative', title: 'Best order that is not an outlier (recommended)' },
            { value: 'best', label: 'Best', title: 'Highest eligible order, even if it looks like an outlier or was not seen for a day' },
            { value: 'instant', label: 'Instant', title: 'Best non-outlier bot order' },
          ]}
        />
      </Field>
      <div className="form-grid three">
        <Field label="Minimum profit" htmlFor="p-min">
          <CommitInput id="p-min" inputMode="decimal" value={refText(p.minProfitScrap)} validate={refValidator(false)} onCommit={(v) => set({ minProfitScrap: parseRef(v) ?? p.minProfitScrap })} suffix="ref" />
        </Field>
        <Field label="…or % of cost" htmlFor="p-pct">
          <CommitInput id="p-pct" inputMode="decimal" value={String(+(p.minProfitPctOfCost * 100).toFixed(2))} validate={numberValidator(MIN_PROFIT_PCT_OF_COST.min, MIN_PROFIT_PCT_OF_COST.max)} onCommit={(v) => set({ minProfitPctOfCost: Number(v) / 100 })} suffix="%" />
        </Field>
        <Field label="Minimum margin" htmlFor="p-margin">
          <CommitInput id="p-margin" inputMode="decimal" value={String(+(p.minMargin * 100).toFixed(2))} validate={numberValidator(MIN_MARGIN_PCT.min, MIN_MARGIN_PCT.max)} onCommit={(v) => set({ minMargin: Number(v) / 100 })} suffix="%" />
        </Field>
        <Field label="Friction per trade" htmlFor="p-friction" hint="Your time and trade-hold cost.">
          <CommitInput id="p-friction" inputMode="decimal" value={refText(p.frictionScrap)} validate={refValidator(false)} onCommit={(v) => set({ frictionScrap: parseRef(v) ?? p.frictionScrap })} suffix="ref" />
        </Field>
        {/* 0.8 (PC-1): the user's own allowance for a price drop, taken off every buy decision (flipProfit). */}
        <Field label="Price-move reserve" htmlFor="p-reserve" hint={exitReserveHint(p.exitReservePct)}>
          <CommitInput id="p-reserve" inputMode="decimal" value={ratioToPctText(p.exitReservePct)} validate={numberValidator(EXIT_RESERVE_PCT.min, EXIT_RESERVE_PCT.max)} onCommit={(v) => set({ exitReservePct: pctTextToRatio(v) })} suffix="%" />
        </Field>
        {/* 0.9 (#2): the user's marketplace.tf fee, for its break-even price and the journal's fee hint only. */}
        <Field label="marketplace.tf fee" htmlFor="p-mptf-fee" hint={MARKETPLACE_FEE_HINT}>
          <CommitInput id="p-mptf-fee" inputMode="decimal" value={ratioToPctText(p.marketplaceFeePct)} validate={numberValidator(MARKETPLACE_FEE_PCT.min, MARKETPLACE_FEE_PCT.max)} onCommit={(v) => set({ marketplaceFeePct: pctTextToRatio(v) })} suffix="%" />
        </Field>
        <Field label="Outlier vs median" htmlFor="p-om" hint="Best order above this multiple of the median is an outlier.">
          <CommitInput id="p-om" inputMode="decimal" value={String(p.outlierVsMedian)} validate={numberValidator(1, 10)} onCommit={(v) => set({ outlierVsMedian: Number(v) })} suffix="×" />
        </Field>
        <Field label="Outlier vs reference" htmlFor="p-or">
          <CommitInput id="p-or" inputMode="decimal" value={String(p.outlierVsRef)} validate={numberValidator(1, 10)} onCommit={(v) => set({ outlierVsRef: Number(v) })} suffix="×" />
        </Field>
        <Field label="Unusual risk above" htmlFor="p-ur" hint="Warn about price manipulation.">
          <CommitInput id="p-ur" inputMode="numeric" value={String(p.unusualRiskKeys)} validate={numberValidator(0, 100000)} onCommit={(v) => set({ unusualRiskKeys: Number(v) })} suffix="keys" />
        </Field>
        <Field label="Price is stale after" htmlFor="p-stale" hint={INPUT_STALE_HINT}>
          <CommitInput id="p-stale" inputMode="numeric" value={String(Math.round(p.inputStaleMs / 60_000))} validate={numberValidator(1, 60 * 24 * 30)} onCommit={(v) => set({ inputStaleMs: Math.round(Number(v)) * 60_000 })} suffix="min" />
        </Field>
      </div>
      {/* 0.9 (#12): what the user's own data suggests for the reserve, per value band: text only, never applied. */}
      <ReserveSuggestionNote />
      <div className="form-grid two">
        <Field label="Ignore reference prices older than" htmlFor="p-refage" hint={referenceAgeHint(p.referenceMaxAgeMs)}>
          <CommitInput
            id="p-refage"
            inputMode="decimal"
            value={msToDaysText(p.referenceMaxAgeMs)}
            validate={numberValidator(REFERENCE_MAX_AGE_DAYS.min, REFERENCE_MAX_AGE_DAYS.max)}
            onCommit={(v) => set({ referenceMaxAgeMs: daysTextToMs(v) })}
            suffix="days"
          />
        </Field>
        <Field label="Suspect margin above" htmlFor="p-suspect" hint={suspectMarginHint(p.suspectMargin)}>
          <CommitInput
            id="p-suspect"
            inputMode="decimal"
            value={ratioToPctText(p.suspectMargin)}
            validate={numberValidator(SUSPECT_MARGIN_PCT.min, SUSPECT_MARGIN_PCT.max)}
            onCommit={(v) => set({ suspectMargin: pctTextToRatio(v) })}
            suffix="%"
          />
        </Field>
      </div>
      <Field label="Buyer note keywords" htmlFor="p-notes" hint="Comma separated. Orders whose note mentions one are flagged and lose confidence.">
        <CommitInput
          id="p-notes"
          value={p.notesKeywords.join(', ')}
          onCommit={(v) =>
            set({
              notesKeywords: v
                .split(',')
                .map((x) => x.trim().toLowerCase())
                .filter(Boolean),
            })
          }
        />
      </Field>
    </Section>
  );
}

/**
 * 0.9 (#12): the suggested price-move reserve per value band ('profit.reserveSuggestion': local reads only), with its
 * n, source and hold. Text only: nothing here sets the reserve. Renders nothing while loading or on an error.
 */
function ReserveSuggestionNote() {
  const q = useRpcQuery('profit.reserveSuggestion', undefined);
  usePush('journal.changed', () => void q.reload());
  const view = reserveSuggestionView(q.data);
  if (!view) return null;
  return (
    <div className="reserve-suggest small" title={view.title}>
      <p className="muted">{view.head}</p>
      {view.lines.map((l) => (
        <p key={l.band}>{l.text}</p>
      ))}
    </div>
  );
}

/** Exported for the render tests. */
export function NotifySection({ s }: { s: Settings }) {
  const { updateSettings } = useApp();
  const n = s.notifications;
  const set = (patch: Partial<Settings['notifications']>) => updateSettings({ notifications: patch });
  // Arrays replace whole, so a second tick before the first save returns must build on the first
  // one. A ref, because both ticks can run before React re-renders.
  const sent = useRef<{ base: InputKind[]; next: InputKind[] } | null>(null);
  const [, rerender] = useState(0);
  const currentKinds = () => (sent.current && sent.current.base === n.inputKinds ? sent.current.next : n.inputKinds);
  const toggleKind = (kind: InputKind, on: boolean) => {
    const mark = { base: n.inputKinds, next: setInputKind(currentKinds(), kind, on) };
    sent.current = mark;
    rerender((x) => x + 1);
    void set({ inputKinds: mark.next }).then((r) => {
      if (!r && sent.current === mark) {
        sent.current = null;
        rerender((x) => x + 1);
      }
    });
  };
  const kinds = currentKinds();
  return (
    <Section id="set-notify" title="Notifications">
      <Toggle checked={n.enabled} onChange={(enabled) => set({ enabled })} label="Desktop notifications for new profitable items" />
      <div className="form-grid three">
        <Field label="Minimum confidence" htmlFor="n-conf" hint="45 = Medium, 70 = High">
          <CommitInput id="n-conf" inputMode="numeric" value={String(n.minConfidence)} validate={numberValidator(0, 100)} onCommit={(v) => set({ minConfidence: Math.round(Number(v)) })} />
        </Field>
        <Field label="Minimum profit" htmlFor="n-profit">
          <CommitInput id="n-profit" inputMode="decimal" value={refText(n.minProfitScrap)} validate={refValidator(false)} onCommit={(v) => set({ minProfitScrap: parseRef(v) ?? n.minProfitScrap })} suffix="ref" />
        </Field>
        <Field label="Repeat for the same item after" htmlFor="n-dedup">
          <CommitInput id="n-dedup" inputMode="numeric" value={String(Math.round(n.dedupMs / 60_000))} validate={numberValidator(1, 60 * 24)} onCommit={(v) => set({ dedupMs: Math.round(Number(v)) * 60_000 })} suffix="min" />
        </Field>
      </div>
      {/* 0.9 (#3): the risk control (0, the default: off). */}
      <Field label={MIN_PROFITABLE_DEPTH_LABEL} htmlFor="n-depth" hint={minProfitableDepthHint(n.minProfitableDepth)}>
        <CommitInput id="n-depth" inputMode="numeric" value={String(n.minProfitableDepth)} validate={numberValidator(MIN_PROFITABLE_DEPTH.min, MIN_PROFITABLE_DEPTH.max)} onCommit={(v) => set({ minProfitableDepth: Math.round(Number(v)) })} suffix="buyers" />
      </Field>
      <Field label="Notify for" hint={inputKindsHint(kinds)}>
        <CheckGroup ariaLabel="Notify for these inputs" values={kinds} options={NOTIFY_INPUT_KINDS} onToggle={toggleKind} />
      </Field>
      {/* F11: "Sell: <name>" when a held item's next lot can be sold at a profit. */}
      <Toggle checked={n.holdings} onChange={(holdings) => void set({ holdings })} label={HOLDINGS_NOTIFY_LABEL} description={holdingsNotifyHint(n.enabled)} />
      {/* F17: "New on scrap.tf (<Bank>): <name>" when a bank page you save shows new items that are flips. */}
      <Toggle
        checked={n.newOnScraptf}
        onChange={(newOnScraptf) => void set({ newOnScraptf })}
        label={NEW_ON_SCRAPTF_NOTIFY_LABEL}
        description={newOnScraptfNotifyHint({ notificationsOn: n.enabled, importKind: kinds.includes('import'), importOn: s.import.enabled && s.import.acknowledgedAt !== null })}
      />
      {/* 0.8 (G1, G3): "Watch (<Bank>): <name>" and "Back on scrap.tf" for the items you watch. */}
      <Toggle checked={n.watches} onChange={(watches) => void set({ watches })} label={WATCHES_NOTIFY_LABEL} description={watchesNotifyHint({ notificationsOn: n.enabled, importOn: s.import.enabled && s.import.acknowledgedAt !== null })} />
      {/* 0.8 (G4): "Buy now (<Bank>): <name>", opt-in (D25). */}
      <Toggle checked={n.buyTiming} onChange={(buyTiming) => void set({ buyTiming })} label={BUY_TIMING_NOTIFY_LABEL} description={buyTimingNotifyHint({ notificationsOn: n.enabled, newOnScraptfOn: n.newOnScraptf, importKind: kinds.includes('import'), importOn: s.import.enabled && s.import.acknowledgedAt !== null })} />
      <Toggle checked={n.silent} onChange={(silent) => void set({ silent })} label="Silent notifications" description="Shown without the Windows notification sound." />
    </Section>
  );
}

/** Exported for the render tests. */
export function FeedSection({ s }: { s: Settings }) {
  const { updateSettings } = useApp();
  const f = s.liveFeed;
  return (
    <Section id="set-feed" title="Live feed" intro="backpack.tf's public websocket streams every listing change, about 8 to 12 GB a day. It needs no key. One connection only.">
      {/* 0.7.3: the 'snapshot-watched' job does not depend on the feed (scheduler.ts). */}
      <Toggle
        checked={f.enabled}
        onChange={(enabled) => void updateSettings({ liveFeed: { enabled } })}
        label="Live buy-order feed"
        description="When off, buy orders update only when you refresh an item and, with an access token, for the items you price or hold (one a minute at most, each at most every 30 minutes). To stop all backpack.tf requests, turn off backpack.tf API under Data sources or pause the network."
      />
      <div className="form-grid two">
        <Field label="Daily data cap" htmlFor="f-cap" hint="The feed pauses for the day when it reaches this. Counts uncompressed data; lower it on a capped or metered connection.">
          <CommitInput
            id="f-cap"
            inputMode="decimal"
            value={String(+(f.dailyCapBytes / 1e9).toFixed(2))}
            validate={numberValidator(0.1, 100)}
            onCommit={(v) => updateSettings({ liveFeed: { dailyCapBytes: Math.round(Number(v) * 1e9) } })}
            suffix="GB"
          />
        </Field>
        <Field label="Keep sell listings for">
          <Segmented
            ariaLabel="Keep sell listings for"
            value={f.keepSellListings}
            onChange={(keepSellListings) => void updateSettings({ liveFeed: { keepSellListings } })}
            options={[
              { value: 'watched', label: 'Priced items' },
              { value: 'all', label: 'All items' },
            ]}
          />
        </Field>
      </div>
    </Section>
  );
}

function ConnectorsSection({ s }: { s: Settings }) {
  const { updateSettings } = useApp();
  const c = s.connectors;
  const set = (patch: Partial<Settings['connectors']>) => void updateSettings({ connectors: patch });
  return (
    <Section id="set-connectors" title="Data sources">
      <Toggle checked={c.bptfApi} onChange={(bptfApi) => set({ bptfApi })} label="backpack.tf API" description="Community prices and key price (needs the API key), snapshots (needs the token)." />
      <Toggle checked={c.pricedb} onChange={(pricedb) => set({ pricedb })} label="PriceDB prices" description="Keyless reference prices and a fallback key price. Prices by PriceDB.io." />
      <Toggle checked={c.pricedbSocket} onChange={(pricedbSocket) => set({ pricedbSocket })} label="PriceDB live updates" description="One socket connection that keeps reference prices fresh." />
      <Toggle checked={c.scm} onChange={(scm) => set({ scm })} label="Steam Community Market price check" description="Off by default. On click only, at most one request every 5 s." />
      {c.scm ? (
        <Banner tone="warn" icon="warning">
          The market price endpoint is undocumented and Steam locks out IPs for hours after too many requests. Steam&apos;s Subscriber Agreement also restricts
          automated access. Leave this off unless you need it.
        </Banner>
      ) : null}
    </Section>
  );
}

/**
 * 0.7.3: the drawer can block a buyer while this page stays open under it. `base` is the stored list
 * the textarea was last seeded from: with no pending edit the textarea follows the stored list, and
 * Save applies only the user's own edit to a fresh read. Exported for the render tests.
 */
export function BlocklistSection({ s }: { s: Settings }) {
  const { updateSettings, toast } = useApp();
  const [draft, setDraft] = useState(() => ({ text: s.blocklist.join('\n'), base: s.blocklist }));
  useEffect(
    () =>
      setDraft((d) => {
        const p = parseSteamIdList(d.text);
        return p.invalid.length === 0 && sameIdList(p.ids, d.base) && !sameIdList(d.base, s.blocklist) ? { text: s.blocklist.join('\n'), base: s.blocklist } : d;
      }),
    [s.blocklist],
  );
  const parsed = parseSteamIdList(draft.text);
  const dirty = !sameIdList(parsed.ids, draft.base);
  const save = async () => {
    const submitted = draft.text;
    let fresh: Settings;
    try {
      fresh = await rpc('settings.get');
    } catch (e) {
      toast(`Could not save settings: ${errorMessage(e)}`, 'bad');
      return;
    }
    const r = await updateSettings({ blocklist: applyBlocklistEdit(fresh.blocklist, draft.base, parsed.ids) });
    if (r) {
      // Typed again during the save: keep that text, only move the base.
      setDraft((d) => (d.text === submitted ? { text: r.blocklist.join('\n'), base: r.blocklist } : { ...d, base: r.blocklist }));
      toast(`Blocklist saved (${r.blocklist.length}).`, 'good');
    }
  };
  return (
    <Section id="set-block" title="Blocklist" intro="Buy orders from these SteamID64s are never used, for example buyers who backed out on you.">
      <Field label="SteamID64s, one per line" htmlFor="blocklist" error={parsed.invalid.length ? `Not a SteamID64: ${parsed.invalid.slice(0, 3).join(', ')}${parsed.invalid.length > 3 ? '…' : ''}` : null}>
        <textarea id="blocklist" className="input mono" rows={4} value={draft.text} spellCheck={false} onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))} placeholder="7656119..." />
      </Field>
      <div className="form-actions">
        <button type="button" className="btn small primary" disabled={!dirty || parsed.invalid.length > 0} onClick={() => void save()}>
          Save blocklist
        </button>
        <span className="muted small">{parsed.ids.length} valid</span>
      </div>
    </Section>
  );
}

/** settings.ownSteamIds holds at most this many (the settings schema's max). */
const OWN_STEAM_IDS_MAX = 10;

/**
 * 0.8 (H3): the user's own SteamID64s (settings.ownSteamIds, at most OWN_STEAM_IDS_MAX), so their own backpack.tf
 * sell listings are left out of "Others ask". BlocklistSection's draft / base / fresh-read pattern: Save applies only
 * the user's own edit to a fresh read. The list only filters (R5): Flip Desk signs in to nothing. Exported for tests.
 */
export function OwnAccountsSection({ s }: { s: Settings }) {
  const { updateSettings, toast } = useApp();
  const stored = s.ownSteamIds ?? [];
  const [draft, setDraft] = useState(() => ({ text: stored.join('\n'), base: stored }));
  useEffect(
    () =>
      setDraft((d) => {
        const p = parseSteamIdList(d.text);
        return p.invalid.length === 0 && sameIdList(p.ids, d.base) && !sameIdList(d.base, stored) ? { text: stored.join('\n'), base: stored } : d;
      }),
    // Keyed on the stored array itself: `stored` is a new [] only when settings has none.
    [s.ownSteamIds],
  );
  const parsed = parseSteamIdList(draft.text);
  const dirty = !sameIdList(parsed.ids, draft.base);
  const tooMany = parsed.ids.length > OWN_STEAM_IDS_MAX;
  const error = parsed.invalid.length
    ? `Not a SteamID64: ${parsed.invalid.slice(0, 3).join(', ')}${parsed.invalid.length > 3 ? '…' : ''}`
    : tooMany
      ? `At most ${OWN_STEAM_IDS_MAX}`
      : null;
  const save = async () => {
    const submitted = draft.text;
    let fresh: Settings;
    try {
      fresh = await rpc('settings.get');
    } catch (e) {
      toast(`Could not save settings: ${errorMessage(e)}`, 'bad');
      return;
    }
    const r = await updateSettings({ ownSteamIds: applyBlocklistEdit(fresh.ownSteamIds ?? [], draft.base, parsed.ids) });
    if (r) {
      const saved = r.ownSteamIds ?? [];
      // Typed again during the save: keep that text, only move the base.
      setDraft((d) => (d.text === submitted ? { text: saved.join('\n'), base: saved } : { ...d, base: saved }));
      toast(`Your accounts saved (${saved.length}).`, 'good');
    }
  };
  return (
    <Section
      id="set-own"
      title="Your accounts"
      intro="Your own SteamID64s, optional. Your own backpack.tf sell listings are then left out of “Others ask” on Holdings and in the item panel. Flip Desk signs in to nothing and acts for no account; this list never leaves settings.json."
    >
      <Field label="SteamID64s, one per line" htmlFor="own-steamids" error={error}>
        <textarea id="own-steamids" className="input mono" rows={3} value={draft.text} spellCheck={false} onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))} placeholder="7656119..." />
      </Field>
      <div className="form-actions">
        <button type="button" className="btn small primary" disabled={!dirty || parsed.invalid.length > 0 || tooMany} onClick={() => void save()}>
          Save accounts
        </button>
        <span className="muted small">{parsed.ids.length} valid</span>
      </div>
    </Section>
  );
}

/**
 * Main's registration of both global hotkeys ('app.hotkeys'), re-read after every settings change
 * (main registers a changed hotkey before it saves it), so a chord another app took at start-up shows.
 */
function useHotkeys(): HotkeysStatus | null {
  const q = useRpcQuery('app.hotkeys', undefined);
  usePush('settings.changed', () => void q.reload());
  return q.data ?? null;
}

/**
 * 0.9 (#1): Settings → Trade lock: the user's answer (Not sure / No lock / 7-day lock), when it was given, Valve's FAQ
 * (opened in the user's browser), and while unanswered a button that keeps Not sure and stops Holdings asking. Every
 * choice writes `tradeLock` with answeredAt now; Flip Desk cannot read the account.
 */
export function TradeLockSection({ s }: { s: Settings }) {
  const { updateSettings } = useApp();
  const mode = tradeLockModeOf(s);
  const answeredAt = s.tradeLock?.answeredAt ?? null;
  const answer = (m: TradeLockMode) => void updateSettings({ tradeLock: { mode: m, answeredAt: Date.now() } });
  return (
    <Section id="set-trade" title="Trade lock" intro={TRADE_LOCK_BODY}>
      <Field label="When you receive a TF2 item in a trade" hint={TRADE_LOCK_HELP[mode]}>
        <Segmented
          ariaLabel="Trade lock"
          value={mode}
          options={TRADE_LOCK_MODES.map((m) => ({ value: m, label: TRADE_LOCK_LABELS[m], title: TRADE_LOCK_TITLES[m] }))}
          onChange={(m) => answer(m)}
        />
      </Field>
      <p className="muted small">
        {tradeLockAnsweredText(answeredAt)} <ExternalLink url={STEAM_TRADE_PROTECTION_FAQ_URL}>{TRADE_LOCK_FAQ_LABEL}</ExternalLink>
      </p>
      {answeredAt === null ? (
        <div className="form-actions">
          <button type="button" className="btn small" onClick={() => answer('unknown')}>
            Keep &quot;Not sure&quot; and stop asking
          </button>
        </div>
      ) : null}
    </Section>
  );
}

function AppSection({ s }: { s: Settings }) {
  const { updateSettings } = useApp();
  const hotkeys = useHotkeys();
  const a = s.app;
  const set = (patch: Partial<Settings['app']>) => updateSettings({ app: patch });
  return (
    <Section id="set-app" title="App behaviour">
      <Toggle checked={a.startAtLogin} onChange={(startAtLogin) => void set({ startAtLogin })} label="Start when I sign in to Windows" />
      <Toggle checked={a.startHidden} onChange={(startHidden) => void set({ startHidden })} label="Start hidden in the tray" />
      <Toggle checked={a.closeToTray} onChange={(closeToTray) => void set({ closeToTray })} label="Closing the window keeps the app running in the tray" />
      <Field
        label="Quick-entry hotkey"
        htmlFor="hotkey"
        error={quickHotkeyProblem(a.quickEntryHotkey, hotkeys?.quickEntry)}
        hint={
          a.quickEntryHotkey
            ? `Currently ${accelLabel(a.quickEntryHotkey)}. Electron accelerator format, e.g. CommandOrControl+Alt+F. Leave it empty to turn the shortcut off.`
            : 'Off. Enter a shortcut such as CommandOrControl+Alt+F to turn it on.'
        }
      >
        <CommitInput
          id="hotkey"
          value={a.quickEntryHotkey}
          placeholder="Off"
          validate={(v) => validateQuickEntryHotkey(v, s.check?.hotkey ?? '')}
          onCommit={(v) => set({ quickEntryHotkey: v.trim() })}
        />
      </Field>
    </Section>
  );
}

/**
 * F16 Live check: every check.* setting. The check hotkey (registered by main before it is saved, so a
 * refusal comes back as the save's error; 'app.hotkeys' says when the stored one is taken), the opt-in
 * clipboard watcher with its privacy sentence, the flip notification and popup switches, and a Test
 * that checks a sample string through the service. The app never reads the clipboard from here.
 * Exported for the render tests.
 */
export function CheckSection({ s }: { s: Settings }) {
  const { updateSettings, toast } = useApp();
  const hotkeys = useHotkeys();
  const c = s.check;
  const [lastSave, setLastSave] = useState<CheckHotkeySave | null>(null);
  const [test, setTest] = useState<{ busy: boolean; result: CheckResult | null; error: string | null }>({ busy: false, result: null, error: null });
  const now = useNow(30_000);
  const set = (patch: Partial<Settings['check']>) => updateSettings({ check: patch });
  const hotkeyStatus = checkHotkeyStatus(c.hotkey, lastSave, hotkeys?.check ?? null);

  // Not through updateSettings: its toast drops main's reason, and the field shows it instead.
  // 'settings.changed' (main broadcasts every change) brings the new value back to the page.
  const saveHotkey = async (v: string) => {
    const hotkey = v.trim();
    try {
      const next = await rpc('settings.set', { check: { hotkey } });
      setLastSave({ hotkey, error: null });
      return next;
    } catch (e) {
      setLastSave({ hotkey, error: errorMessage(e) });
      return null;
    }
  };

  const setWatch = async (on: boolean) => {
    const r = await set({ watchClipboard: on });
    if (r && on) toast(`Clipboard check is on. ${CHECK_PRIVACY_SENTENCE}`, 'info');
  };

  const runTest = async () => {
    setTest((t) => ({ ...t, busy: true }));
    try {
      setTest({ busy: false, result: await rpc('check.text', { text: CHECK_SAMPLE_TEXT, source: 'manual' }), error: null });
    } catch (e) {
      setTest({ busy: false, result: null, error: errorMessage(e) });
    }
  };

  // Main pauses the watcher on the setting itself; the status poll can lag behind it.
  const paused = s.networkPaused;
  return (
    <Section
      id="set-check"
      title="Live check"
      intro="Copy an item name or a row of scrap.tf/items while you browse, then see its flip at once: the price, what it sells for and Pay up to. Flip Desk never loads scrap.tf on its own or reads your browser; it only reads text you copy, on this computer."
    >
      <Field label="Check hotkey" htmlFor="check-hotkey" hint={hotkeyStatus.tone === 'bad' ? undefined : hotkeyStatus.text} error={hotkeyStatus.tone === 'bad' ? hotkeyStatus.text : null}>
        <div className="lc-hotkey-row">
          <CommitInput id="check-hotkey" value={c.hotkey} placeholder="Off" validate={(v) => validateCheckHotkey(v, s.app.quickEntryHotkey)} onCommit={saveHotkey} />
          <TonePill tone={hotkeyStatus.tone}>{hotkeyStatus.pill}</TonePill>
        </div>
      </Field>
      <Toggle checked={c.watchClipboard} onChange={(on) => void setWatch(on)} label={CHECK_WATCH_LABEL} description={checkWatchHint(c.watchClipboard, paused)} />
      <Toggle checked={c.notifyFlips} onChange={(notifyFlips) => void set({ notifyFlips })} label={CHECK_NOTIFY_LABEL} description={checkNotifyHint(s.notifications.enabled, c.popup)} />
      <Toggle checked={c.popup} onChange={(popup) => void set({ popup })} label={CHECK_POPUP_LABEL} description={CHECK_POPUP_HINT} />
      <div className="form-actions">
        <button type="button" className="btn small" disabled={test.busy} onClick={() => void runTest()} title={`Checks "${CHECK_SAMPLE_TEXT}" against your local data, as if you had copied it`}>
          {test.busy ? 'Checking…' : 'Test'}
        </button>
        <span className="muted small">
          Checks <code>{CHECK_SAMPLE_TEXT}</code> as if you had copied it.
        </span>
      </div>
      {test.error ? (
        <div className="small tone-text-bad" role="alert">
          <Icon name="warning" size={12} /> Could not check: {test.error}
        </div>
      ) : test.result ? (
        <div className="lc-test small" role="status">
          {test.result.status === 'item' ? <CheckVerdictPill result={test.result} /> : <Icon name="info" size={12} />}
          <span>{checkBriefText(test.result, now)}</span>
        </div>
      ) : null}
    </Section>
  );
}

/**
 * F20 Saved-page import: the re-save reminders (settings.import.resaveReminderMin and resaveBanks). The
 * app cannot refresh scrap.tf; a reminder only asks the user to save the page again, and a click on it
 * opens only that bank's static page (main checks it). Turning import on stays on the Import page,
 * behind its acknowledgement. Exported for the render tests.
 */
export function ImportSection({ s }: { s: Settings }) {
  const { updateSettings, navigate } = useApp();
  const i = s.import;
  const importOn = i.enabled && i.acknowledgedAt !== null;
  // Arrays replace whole, so a second tick before the first save returns must build on the first one
  // (as NotifySection's kinds). A ref, because both ticks can run before React re-renders.
  const sent = useRef<{ base: ScraptfBank[]; next: ScraptfBank[] } | null>(null);
  const [, rerender] = useState(0);
  const current = () => (sent.current && sent.current.base === i.resaveBanks ? sent.current.next : i.resaveBanks);
  const toggleBank = (bank: ScraptfBank, on: boolean) => {
    const next = setResaveBank(current(), bank, on);
    if (next === null) return;
    const mark = { base: i.resaveBanks, next };
    sent.current = mark;
    rerender((x) => x + 1);
    void updateSettings({ import: { resaveBanks: next } }).then((r) => {
      if (!r && sent.current === mark) {
        sent.current = null;
        rerender((x) => x + 1);
      }
    });
  };
  const banks = current();
  const shown = resaveBanksShown(banks);
  return (
    <Section
      id="set-import"
      title="Saved-page import"
      intro={
        <>
          Pages you save from scrap.tf with your own browser are read from your watch folder. Import is <strong>{importOn ? 'on' : 'off'}</strong>; turn it on and pick the folder on the{' '}
          <button type="button" className="link-btn" onClick={() => navigate('import')}>
            Import
          </button>{' '}
          page.
        </>
      }
    >
      <p className="stf-resave-help small">
        <Icon name="clock" size={13} />
        <span>{SCRAPTF_RESAVE_HELP}.</span>
      </p>
      <Field
        label="Remind me to save a bank again after"
        htmlFor="imp-resave"
        hint={resaveReminderHint({ minutes: i.resaveReminderMin, importOn, notificationsOn: s.notifications.enabled, networkPaused: s.networkPaused })}
      >
        <CommitInput
          id="imp-resave"
          inputMode="numeric"
          value={String(i.resaveReminderMin)}
          placeholder="0"
          validate={validateResaveMinutes}
          onCommit={(v) => updateSettings({ import: { resaveReminderMin: resaveMinutesOf(v) } })}
          suffix="min"
        />
      </Field>
      <Field label="For these banks" hint={resaveBanksHint(banks)}>
        <div className="check-list check-group stf-resave-banks" role="group" aria-label="Remind me about these banks">
          {SCRAPTF_BANKS.map((b) => {
            const on = shown.includes(b.bank);
            const last = on && shown.length === 1;
            return (
              <label key={b.bank} className="check-row" title={last ? RESAVE_LAST_BANK_TITLE : undefined}>
                <input type="checkbox" checked={on} disabled={last} onChange={(e) => toggleBank(b.bank, e.target.checked)} />
                <span>{b.label}</span>
                <span className="muted small">{bankStockPagePath(b.url)}</span>
              </label>
            );
          })}
        </div>
      </Field>
    </Section>
  );
}

function AppearanceSection({ s }: { s: Settings }) {
  const { updateSettings } = useApp();
  return (
    <Section id="set-look" title="Appearance">
      <div className="form-grid two">
        <Field label="Theme">
          <Segmented
            ariaLabel="Theme"
            value={s.ui.theme}
            onChange={(theme) => void updateSettings({ ui: { theme } })}
            options={[
              { value: 'system', label: 'System' },
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
          />
        </Field>
        <Field label="Density">
          <Segmented
            ariaLabel="Density"
            value={s.ui.density}
            onChange={(density) => void updateSettings({ ui: { density } })}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </Field>
      </div>
    </Section>
  );
}

/**
 * F21 "scrap.tf window (opt-in)": what the window does and never does, the risk in scrap.tf's own words
 * (the ToS, the staff stance, a ban possible on both sites), the acknowledgement (scraptfWindow.acknowledgedAt),
 * the switch (main's setter refuses it without import and both acknowledgements; its reason shows here),
 * the three options, Open the scrap.tf window and Log out & clear. Opening is 'scraptfWindow.open' on a
 * click only; nothing here loads scrap.tf. Exported for the render tests.
 */
export function ScraptfWindowSection({ s }: { s: Settings }) {
  const { updateSettings, navigate, toast } = useApp();
  const w = s.scraptfWindow;
  const enable = windowEnableView(s);
  const ackText = windowAckText(w.acknowledgedAt);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Settings['scraptfWindow']>) => void updateSettings({ scraptfWindow: patch });

  const setAck = (on: boolean) => {
    setRefusal(null);
    set({ acknowledgedAt: on ? Date.now() : null });
  };

  // Not through updateSettings: its toast drops main's reason, and the switch shows it instead.
  // 'settings.changed' (main broadcasts every change) brings the new value back to the page.
  const setEnabled = async (on: boolean) => {
    setBusy(true);
    try {
      await rpc('settings.set', { scraptfWindow: { enabled: on } });
      setRefusal(null);
    } catch (e) {
      setRefusal(windowRefusalText(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  };

  const openWindow = () => {
    rpc('scraptfWindow.open').catch((e: unknown) => toast(windowOpenFailedText(errorMessage(e)), 'bad'));
  };
  const clearWindow = () => {
    rpc('scraptfWindow.clear').then(
      () => toast(WINDOW_CLEARED_TEXT, 'good'),
      (e: unknown) => toast(`Could not clear the scrap.tf window: ${errorMessage(e)}`, 'bad'),
    );
  };

  return (
    <Section
      id="set-window"
      title="scrap.tf window (opt-in)"
      intro="Browse scrap.tf yourself in a window of Flip Desk. When a scrap.tf page you opened finishes loading, Flip Desk reads what is on screen and imports it, as if you had saved the page with Ctrl+S."
    >
      <div className="stfw-settings-lists">
        <div>
          <h3>What it does</h3>
          <ul className="small">
            {SCRAPTF_WINDOW_DOES.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3>What it never does</h3>
          <ul className="small">
            {SCRAPTF_WINDOW_NEVER.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      </div>
      <Banner tone="bad" icon="warning">
        <div className="stfw-risk-text">
          <p>
            <strong>{SCRAPTF_WINDOW_RISK[0]}</strong> {SCRAPTF_WINDOW_RISK[1]}
          </p>
          <p>
            {SCRAPTF_WINDOW_RISK[2]} <strong>{SCRAPTF_WINDOW_RISK[3]}</strong>
          </p>
          {/* Settings opens no scrap.tf page (F20's opener-free list): the terms link lives on the About page. */}
          <p>
            {SCRAPTF_WINDOW_RISK[4]}{' '}
            <button type="button" className="link-btn" onClick={() => navigate('about')}>
              scrap.tf&apos;s terms are linked on the About page
            </button>
          </p>
        </div>
      </Banner>
      <label className="ack-row">
        <input type="checkbox" checked={w.acknowledgedAt !== null} onChange={(e) => setAck(e.target.checked)} />
        <span>{SCRAPTF_WINDOW_ACK_TEXT}</span>
      </label>
      {ackText ? <p className="muted small stfw-ack-when">{ackText}</p> : null}
      <Toggle
        checked={w.enabled}
        disabled={enable.disabled || busy}
        onChange={(on) => void setEnabled(on)}
        label={SCRAPTF_WINDOW_ENABLE_LABEL}
        description={
          <>
            {enable.hint}
            {enable.blocker === 'import' ? (
              <>
                {' '}
                <button type="button" className="link-btn" onClick={() => navigate('import')}>
                  Go to Import
                </button>
              </>
            ) : null}
          </>
        }
      />
      {refusal ? (
        <div className="small tone-text-bad" role="alert">
          <Icon name="warning" size={12} /> {refusal}
        </div>
      ) : null}
      <Toggle checked={w.keepLoggedIn} onChange={(keepLoggedIn) => set({ keepLoggedIn })} label={SCRAPTF_WINDOW_KEEP_LABEL} description={SCRAPTF_WINDOW_KEEP_HINT} />
      <Toggle checked={w.readOnLoad} onChange={(readOnLoad) => set({ readOnLoad })} label={SCRAPTF_WINDOW_READ_LABEL} description={SCRAPTF_WINDOW_READ_HINT} />
      <Toggle checked={w.openLinksInWindow} onChange={(openLinksInWindow) => set({ openLinksInWindow })} label={SCRAPTF_WINDOW_LINKS_LABEL} description={SCRAPTF_WINDOW_LINKS_HINT} />
      <div className="form-actions">
        <button type="button" className="btn small primary" disabled={!w.enabled} title={w.enabled ? SCRAPTF_WINDOW_NAV_TITLE : 'Turn the window on first.'} onClick={openWindow}>
          <Icon name="window" size={14} /> Open the scrap.tf window
        </button>
        <ConfirmButton className="btn small ghost" confirmLabel="Log out and clear?" ariaLabel="Log out & clear the scrap.tf window" title={SCRAPTF_WINDOW_CLEAR_TITLE} onConfirm={clearWindow}>
          <Icon name="logout" size={14} /> Log out &amp; clear
        </ConfirmButton>
      </div>
    </Section>
  );
}

function AboutAppSection() {
  const info = useRpcQuery('app.info', undefined);
  const i = info.data;
  return (
    <section className="card settings-section" aria-labelledby="set-info-t">
      <h2 id="set-info-t">This installation</h2>
      {i ? (
        <dl className="kv">
          <dt>Version</dt>
          <dd>{i.version}</dd>
          {/* 0.7.2: which copy this is, when more than one (an install and a copy of the code) share the data folder. */}
          {i.appDir ? (
            <>
              <dt>Runs from</dt>
              <dd className="mono small">{i.appDir}</dd>
            </>
          ) : null}
          <dt>Data folder</dt>
          <dd className="mono small">{i.dataDir}</dd>
          <dt>Logs</dt>
          <dd className="mono small">{i.logDir}</dd>
          <dt>Runtime</dt>
          <dd className="small">
            {i.platform} · Electron {i.electron} · Node {i.node}
          </dd>
        </dl>
      ) : (
        <p className="muted small">{info.error ?? 'Loading…'}</p>
      )}
    </section>
  );
}
