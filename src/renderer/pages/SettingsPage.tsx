import { useState, type ReactNode } from 'react';
import { parsePrice } from '../../shared/currency';
import type { SecretName, Settings } from '../../shared/types';
import { rpc } from '../api';
import { CommitInput, Field, Segmented, Toggle } from '../components/Controls';
import { ExternalLink } from '../components/ExternalLink';
import { Banner, LoadingBlock } from '../components/Feedback';
import { Icon } from '../components/Icon';
import { accelLabel, errorMessage, fmtDateTime, fmtRefOnly, parseSteamIdList } from '../format';
import { useApp } from '../hooks/appContext';
import { useRpcQuery } from '../hooks/useRpc';
import { MIN_MARGIN_PCT, MIN_PROFIT_PCT_OF_COST, numberValidator, userAgentPreview, validateContactUrl, validateHotkey } from '../settingsFields';

const SECTIONS = [
  ['set-access', 'backpack.tf access'],
  ['set-contact', 'Contact'],
  ['set-key', 'Key price'],
  ['set-profit', 'Profit thresholds'],
  ['set-notify', 'Notifications'],
  ['set-feed', 'Live feed'],
  ['set-connectors', 'Data sources'],
  ['set-block', 'Blocklist'],
  ['set-app', 'App behaviour'],
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

const refValidator = (allowEmpty: boolean) => (v: string) => (allowEmpty && !v.trim() ? null : parseRef(v) === null ? 'Enter refined, e.g. 1.33 or 14 scrap.' : null);

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
        <FeedSection s={settings} />
        <ConnectorsSection s={settings} />
        <BlocklistSection s={settings} />
        <AppSection s={settings} />
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
          Your own credentials only. They are encrypted on this computer, never shown again after saving, never logged, and sent only to backpack.tf. Get them at{' '}
          <ExternalLink url="https://backpack.tf/connections">backpack.tf/connections</ExternalLink>.
        </>
      }
    >
      <SecretField name="bptfAccessToken" label="Access token" help="Used for snapshots (refreshing one item on demand) and user info." />
      <SecretField name="bptfApiKey" label="API key" help="Used for community prices (every 2 h) and backpack.tf's key price (hourly)." />
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
  const { updateSettings, status } = useApp();
  const kp = status?.keyPrice;
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
        <Field label="Manual key price (ref)" htmlFor="key-manual">
          <CommitInput
            id="key-manual"
            inputMode="decimal"
            value={refText(s.keyPrice.manualScrap)}
            validate={refValidator(true)}
            onCommit={(v) => updateSettings({ keyPrice: { manualScrap: v.trim() ? parseRef(v) : null } })}
            suffix="ref"
          />
        </Field>
      ) : null}
      <div className="form-grid two">
        <Field label="scrap.tf key buy price (ref)" htmlFor="key-stf-buy" hint="What scrap.tf charges you for a key. Display only.">
          <CommitInput
            id="key-stf-buy"
            inputMode="decimal"
            value={refText(s.keyPrice.scraptfBuyScrap)}
            validate={refValidator(true)}
            onCommit={(v) => updateSettings({ keyPrice: { scraptfBuyScrap: v.trim() ? parseRef(v) : null, scraptfObservedAt: Date.now() } })}
            suffix="ref"
          />
        </Field>
        <Field label="scrap.tf key sell price (ref)" htmlFor="key-stf-sell" hint="What scrap.tf pays you for a key. Also caps the automatic value.">
          <CommitInput
            id="key-stf-sell"
            inputMode="decimal"
            value={refText(s.keyPrice.scraptfSellScrap)}
            validate={refValidator(true)}
            onCommit={(v) => updateSettings({ keyPrice: { scraptfSellScrap: v.trim() ? parseRef(v) : null, scraptfObservedAt: Date.now() } })}
            suffix="ref"
          />
        </Field>
      </div>
      {s.keyPrice.scraptfObservedAt ? <p className="muted small">scrap.tf key prices entered {fmtDateTime(s.keyPrice.scraptfObservedAt)}.</p> : null}
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
            { value: 'best', label: 'Best', title: 'Highest eligible order, even if it looks like an outlier' },
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
        <Field label="Outlier vs median" htmlFor="p-om" hint="Best order above this multiple of the median is an outlier.">
          <CommitInput id="p-om" inputMode="decimal" value={String(p.outlierVsMedian)} validate={numberValidator(1, 10)} onCommit={(v) => set({ outlierVsMedian: Number(v) })} suffix="×" />
        </Field>
        <Field label="Outlier vs reference" htmlFor="p-or">
          <CommitInput id="p-or" inputMode="decimal" value={String(p.outlierVsRef)} validate={numberValidator(1, 10)} onCommit={(v) => set({ outlierVsRef: Number(v) })} suffix="×" />
        </Field>
        <Field label="Unusual risk above" htmlFor="p-ur" hint="Warn about price manipulation.">
          <CommitInput id="p-ur" inputMode="numeric" value={String(p.unusualRiskKeys)} validate={numberValidator(0, 100000)} onCommit={(v) => set({ unusualRiskKeys: Number(v) })} suffix="keys" />
        </Field>
        <Field label="Price is stale after" htmlFor="p-stale" hint="Older scrap.tf prices lose confidence.">
          <CommitInput id="p-stale" inputMode="numeric" value={String(Math.round(p.inputStaleMs / 60_000))} validate={numberValidator(1, 60 * 24 * 30)} onCommit={(v) => set({ inputStaleMs: Math.round(Number(v)) * 60_000 })} suffix="min" />
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

function NotifySection({ s }: { s: Settings }) {
  const { updateSettings } = useApp();
  const n = s.notifications;
  const set = (patch: Partial<Settings['notifications']>) => updateSettings({ notifications: patch });
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
    </Section>
  );
}

function FeedSection({ s }: { s: Settings }) {
  const { updateSettings } = useApp();
  const f = s.liveFeed;
  return (
    <Section id="set-feed" title="Live feed" intro="backpack.tf's public websocket streams every listing change, about 8 to 12 GB a day. It needs no key. One connection only.">
      <Toggle checked={f.enabled} onChange={(enabled) => void updateSettings({ liveFeed: { enabled } })} label="Live buy-order feed" description="When off, buy orders only update when you refresh an item." />
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

function BlocklistSection({ s }: { s: Settings }) {
  const { updateSettings, toast } = useApp();
  const [text, setText] = useState(s.blocklist.join('\n'));
  const parsed = parseSteamIdList(text);
  const dirty = parsed.ids.join(',') !== s.blocklist.join(',');
  const save = async () => {
    const r = await updateSettings({ blocklist: parsed.ids });
    if (r) {
      setText(r.blocklist.join('\n'));
      toast(`Blocklist saved (${r.blocklist.length}).`, 'good');
    }
  };
  return (
    <Section id="set-block" title="Blocklist" intro="Buy orders from these SteamID64s are never used, for example buyers who backed out on you.">
      <Field label="SteamID64s, one per line" htmlFor="blocklist" error={parsed.invalid.length ? `Not a SteamID64: ${parsed.invalid.slice(0, 3).join(', ')}${parsed.invalid.length > 3 ? '…' : ''}` : null}>
        <textarea id="blocklist" className="input mono" rows={4} value={text} spellCheck={false} onChange={(e) => setText(e.target.value)} placeholder="7656119..." />
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

function AppSection({ s }: { s: Settings }) {
  const { updateSettings } = useApp();
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
        hint={
          a.quickEntryHotkey
            ? `Currently ${accelLabel(a.quickEntryHotkey)}. Electron accelerator format, e.g. CommandOrControl+Alt+F. Leave it empty to turn the shortcut off.`
            : 'Off. Enter a shortcut such as CommandOrControl+Alt+F to turn it on.'
        }
      >
        <CommitInput id="hotkey" value={a.quickEntryHotkey} placeholder="Off" validate={validateHotkey} onCommit={(v) => set({ quickEntryHotkey: v.trim() })} />
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
