import { ExternalLink } from '../components/ExternalLink';
import { Icon } from '../components/Icon';

const NEVER: { rule: string; text: string }[] = [
  {
    rule: 'R1',
    text: 'Never sends a request of its own to scrap.tf or its subdomains: no page fetch, no /ajax, no socket, no polling or auto-refresh. You browse scrap.tf yourself, in your own browser or, if you turn it on, in the scrap.tf window.',
  },
  { rule: 'R2', text: 'Never reads web pages from backpack.tf, marketplace.tf, Steam, STN or mannco. Only their documented JSON APIs and websockets.' },
  {
    rule: 'R3',
    text: "No userscripts or browser extensions, and nothing of the app's runs in any website, with one exception: the opt-in scrap.tf window. It has no preload or extension; its only code in a page is one read-only snapshot of the scrap.tf page on screen, as saving the page would take, and it never clicks, types or changes anything there.",
  },
  { rule: 'R4', text: 'Never buys, sells, trades, lists, bumps, accepts or declines anything. You do every trade yourself, with Steam mobile confirmation.' },
  { rule: 'R5', text: 'No proxies and no multiple accounts. One account, one connection, your own keys.' },
  {
    rule: 'R6',
    text: "Identifies itself honestly in every request (TF2FlipDesk plus your contact address). Never pretends to be a browser. The exception is the opt-in scrap.tf window: it is a browser you drive, and it keeps Electron's own user agent, which names Flip Desk and Electron but not your contact address.",
  },
  { rule: 'R7', text: 'Stays below every published rate limit, waits when a site asks it to (429, Retry-After), and stops on any challenge page.' },
  { rule: 'R8', text: 'Your keys and tokens are encrypted on this computer, never logged, and sent only to the site that issued them.' },
  {
    rule: 'R9',
    text: "Never asks for, reads or stores Steam passwords, session cookies or authenticator secrets. In the scrap.tf window you sign in on Steam's own page. The app keeps, logs and sends nothing you type there: it only checks each key press for the window's own Back, Forward, Reload and Home keys, and notes the time of your last click or key press (never the key) so that a link you open can go to your browser. The session stays in that window's own browser storage (gone when the app quits, unless you choose to stay signed in).",
  },
  {
    rule: 'R10',
    text: 'scrap.tf prices come only from you: typed in, from your own price-sheet rules, from pages you saved yourself, or read from the scrap.tf window while you browse it (each off until you opt in).',
  },
];

const TERMS: { label: string; url: string; note?: string }[] = [
  { label: 'scrap.tf Terms of Service', url: 'https://scrap.tf/terms', note: 'Lists "external tools" among prohibited ways to gain an advantage.' },
  { label: 'backpack.tf API terms', url: 'https://next.backpack.tf/developer/terms' },
  { label: 'backpack.tf community rules', url: 'https://backpack.tf/rules' },
  { label: 'marketplace.tf terms', url: 'https://marketplace.tf/terms' },
  { label: 'Steam Subscriber Agreement', url: 'https://store.steampowered.com/subscriber_agreement/english/' },
  { label: 'Steam Web API terms', url: 'https://steamcommunity.com/dev/apiterms' },
  { label: 'PriceDB terms of service', url: 'https://pricedb.io/terms-of-service' },
];

export function AboutPage() {
  return (
    <div className="page about-page narrow">
      <section className="card" aria-labelledby="about-what">
        <h2 id="about-what">What TF2 Flip Desk does</h2>
        <p>
          It compares the scrap.tf prices <strong>you</strong> enter with live backpack.tf buy orders, and shows which items would sell for more than they cost,
          how sure it is, and why. Everything runs on your computer.
        </p>
        <ul className="bullets">
          <li>Watches backpack.tf&apos;s public live feed of buy orders and checks reference prices from PriceDB.</li>
          <li>Ignores orders that would not take a clean copy of your item, and orders from banned, blocklisted or marketplace.tf buyers.</li>
          <li>Uses a conservative price that skips outliers, and scores confidence from buyer activity, reference prices and the age of your price.</li>
          <li>Links you to each item on backpack.tf, marketplace.tf and Steam, opened in your own browser.</li>
        </ul>
        <p className="muted small">
          No tool can promise you won&apos;t be banned. These platforms can act on behaviour and reports. The only lasting protection is to stay inside their rules,
          which is what the app is built around. The opt-in scrap.tf window is the exception: scrap.tf&apos;s terms forbid external tools, so
          it carries a ban risk you accept when you turn it on.
        </p>
      </section>

      <section className="card" aria-labelledby="about-never">
        <h2 id="about-never">What it never does</h2>
        <ol className="rules-list">
          {NEVER.map((r) => (
            <li key={r.rule}>
              <span className="rule-id">{r.rule}</span>
              <span>{r.text}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="card" aria-labelledby="about-terms">
        <h2 id="about-terms">Platform rules</h2>
        <p className="muted small">Read these yourself; this app only summarises them. If a link does not open, its address is copied for you.</p>
        <ul className="terms-list">
          {TERMS.map((t) => (
            <li key={t.url}>
              <ExternalLink url={t.url} showUrl>
                {t.label}
              </ExternalLink>
              {t.note ? <div className="muted small">{t.note}</div> : null}
            </li>
          ))}
        </ul>
        <p className="small">
          <Icon name="warning" size={12} /> Don&apos;t use a VPN or proxy with these sites: scrap.tf blacklists VPN and proxy IPs, and Steam forbids hiding where you
          live.
        </p>
      </section>

      <section className="card" aria-labelledby="about-credits">
        <h2 id="about-credits">Attribution and credits</h2>
        <ul className="bullets">
          <li>
            <strong>Prices by PriceDB.io</strong> (<ExternalLink url="https://pricedb.io">pricedb.io</ExternalLink>).
          </li>
          <li>
            <strong>Data from backpack.tf</strong> (<ExternalLink url="https://backpack.tf">backpack.tf</ExternalLink>), through its documented API and websocket.
          </li>
          <li>
            The item link menu is a rebuild of NetroScript&apos;s{' '}
            <ExternalLink url="https://github.com/NetroScript/scrap.tf-item-information">scrap.tf-item-information</ExternalLink> userscript, licensed under Apache-2.0.
          </li>
          <li>
            The idea comes from VeBeshka&apos;s <ExternalLink url="https://github.com/VeBeshka/tf2-scraptf-profit-helper">TF2 ScrapTF Profit Helper</ExternalLink>. This app
            runs nothing on scrap.tf beyond the opt-in scrap.tf window&apos;s read-only snapshot of a page you opened.
          </li>
          <li>SKU handling is a port of @tf2autobot/tf2-sku (node-tf2-sku), MIT License, Copyright (c) 2020 IdiNium/Nicklas Marc Pedersen.</li>
          <li>Item names use a port of getName from node-tf2-schema, MIT License, Copyright (c) 2020 IdiNium/Nicklas Marc Pedersen.</li>
        </ul>
        <p className="muted small">
          The full licence texts (the MIT permission notice and the Apache License 2.0) are in NOTICE.txt and LICENSE.Apache-2.0.txt in the app&apos;s install
          folder.
        </p>
        <p className="muted small">
          Not affiliated with scrap.tf, backpack.tf, marketplace.tf, PriceDB or Valve. Team Fortress 2 is a trademark of Valve Corporation.
        </p>
      </section>
    </div>
  );
}
