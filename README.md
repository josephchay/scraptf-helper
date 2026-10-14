# TF2 Flip Desk

A Windows desktop app that runs in the background and tells you which TF2 items are worth flipping. It compares the scrap.tf prices you give it with live backpack.tf buy orders. It groups the profitable items, keeps a running log of them, and gives you one-click links to backpack.tf, marketplace.tf, Steam Community Market, STN and PriceDB.

It replaces two userscripts:
- **tf2-scraptf-profit-helper** (VeBeshka): profit badges on scrap.tf.
- **scrap.tf-item-information** (NetroScript): the middle-click link menu.

Neither userscript is used. Nothing is injected into any website.

## Why this design keeps your accounts safe

No tool can promise it is "undetectable". scrap.tf, backpack.tf and marketplace.tf share one owner (ScrapTF, LLC) and can ban at their own discretion. The safe approach is to do nothing a site prohibits, rather than hide what you do. The app is built that way, and tests enforce it.

| The app never… | Instead it… |
|---|---|
| contacts scrap.tf in any way (no page loads, no `/ajax`, no socket). The scrap.tf ToS forbids "automation, scripts, user-scripts, auto-refreshers, external tools" for advantage. | gets scrap.tf prices only from **you**: typed in, from category rules, or from pages you saved yourself (opt-in). |
| scrapes HTML from backpack.tf or marketplace.tf. The old profit helper scraped up to 6 classifieds pages per item; backpack.tf's API terms forbid page scraping. | uses backpack.tf's **public websocket** and its **documented JSON APIs** with your own key and token, kept well under the published limits. |
| buys, sells, trades, lists, bumps or accepts anything, anywhere. | leaves every trade to you, in your browser and Steam client. |
| spoofs a browser, rotates proxies, solves CAPTCHAs or randomises timing. | sends an honest User-Agent (`TF2FlipDesk/<version> (+your contact URL)`) and stops when a site serves a challenge page. |
| stores Steam passwords, cookies or authenticator secrets. | encrypts your API key and token with Windows DPAPI and redacts them from every log. |

**Remaining risk.** scrap.tf's "external tools" wording is broad, and could cover even a tool you only type prices into. The **Import** page includes a ready-to-send email to `admin@scrap.tf` asking whether this is OK. Sending it is optional, and you send it from your own email.

## Install and run

**Installer:** run `release\TF2 Flip Desk Setup 0.1.0.exe`. It is unsigned, so Windows SmartScreen will warn you on first launch.

**From source** (Node 24+):

```bash
npm install
```

```bash
npm start
```

Closing the window keeps the app running in the tray. Use the tray menu to open the dashboard, open quick entry, pause the live feed or all network access, or quit.

## First run

1. **Settings → Contact URL.** Add something that reaches you, such as your Steam profile URL. It goes into the User-Agent so API operators can contact you instead of blocking you.
2. **Settings → backpack.tf.** Add your **access token** and **API key** from <https://backpack.tf/connections>.
   - The live buy-order feed works without them.
   - The token enables on-demand and watched-item refreshes.
   - The key adds backpack.tf community prices and backpack.tf's key price.
   - PriceDB already provides a key price without a key.
3. Add your first scrap.tf price (next section).

## Daily workflow

1. **Browse scrap.tf yourself**, as you normally would.
2. **Tell the app the price** of anything interesting, in any of these ways:
   - **Quick entry** (`Ctrl+Alt+F` from anywhere). Type the item name or SKU and the price, e.g. `1.33`, `14 scrap`, `2 keys 5.11`, or `1,5 keys`. It shows the best clean buy order and the profit straight away.
   - **Price sheet → Rules.** Category estimates such as "unique craftable hats ≈ 1.33 ref". The app then lists every item whose backpack.tf buy orders beat that, as *candidates to check on scrap.tf*.
   - **Import** (off by default; you turn it on after reading the ToS note). Save a scrap.tf page with `Ctrl+S` as "Webpage, HTML only" and import it. You can also pick a watch folder so saved pages are picked up automatically. The file is parsed locally; nothing is fetched.
3. **The app keeps checking.** It re-evaluates every price against live backpack.tf buy orders as they change, about 65 updates per second. For each item it:
   - drops attribute-specific, banned, blocklisted and marketplace.tf orders;
   - flags outliers;
   - computes conservative, best and instant revenue;
   - scores confidence from 0 to 100, with the reasons shown.
4. **Opportunities** groups the results by category, profit tier, confidence or input source. **Live log** shows every *appeared / changed / gone* event. High-confidence finds trigger a desktop notification.
5. **Click an item** to see its full buy-order book, PriceDB and community references, price history and the link menu. Then do the trade yourself.
6. **Journal** (optional): record what you actually bought and sold to get FIFO realised profit.

## Where your data lives

Everything stays on your PC under `%APPDATA%\TF2 Flip Desk\`:

| Path | Contents |
|---|---|
| `data\flipdesk.sqlite` | order book, prices, opportunities, events, journal |
| `logs\opportunities-YYYY-MM-DD.jsonl` | one JSON line per opportunity event. Kept as long as the events (90 days), 512 MB total cap. |
| `logs\service.log`, `logs\main.log` | diagnostics, with secrets redacted |
| `settings.json`, `secrets.json` | settings; DPAPI-encrypted key and token |

The live feed uses roughly 13 GB/day of *decompressed* data, and much less on the wire because it is compressed. You can pause it or cap it in Settings.

## Development

```bash
npm test
```

```bash
npm run typecheck
```

```bash
npm run dev:renderer
```

```bash
npm run dist
```

- `npm test` runs about 2,100 vitest tests, including the compliance tests: network policy, static scans for forbidden calls, and secret redaction.
- `npm run dev:renderer` serves the dashboard in a browser with mock data, at http://127.0.0.1:5199.
- `npm run dist` builds the NSIS installer into `release/`.
- **Smoke test** against the real app and live feeds (development builds):

  ```bash
  npx electron . --smoke-test=test/.tmp/smoke.json --user-data-dir=test/.tmp/ud --smoke-wait=45
  ```

**Documentation:**
- `docs/ARCHITECTURE.md`: processes, modules, rules R1–R10.
- `docs/DESIGN_BRIEF.md`: the verified research behind every endpoint, budget and rule, with sources.

## Known limits

- **backpack.tf keyed endpoints** (snapshot, IGetPrices, IGetCurrencies, users/info) were built from documentation and tested against fixtures. No credentials were available while building, so check *Data health* after you add yours.
- **Logged-in scrap.tf page formats** for import come from public markup and the original userscripts. If a saved page imports badly, the import result lists every skipped card and the reason.
- **PriceDB's live socket** was silent during testing. Prices still refresh through PriceDB's REST API on a schedule.

## Credits and licences

- **Link menu and saved-page parsing** follow [NetroScript/scrap.tf-item-information](https://github.com/NetroScript/scrap.tf-item-information) (Apache-2.0).
- **The profit-comparison idea** comes from VeBeshka's tf2-scraptf-profit-helper. None of its code is used.
- **SKU format:** a port of [@tf2autobot/tf2-sku](https://github.com/TF2Autobot/node-tf2-sku) (MIT).
- **Item names:** a port of `getName` from [node-tf2-schema](https://github.com/TF2Autobot/node-tf2-schema) (MIT).
- **Prices by [PriceDB.io](https://pricedb.io).** Buy orders and item data from [backpack.tf](https://backpack.tf).

See `NOTICE` for licence texts and attributions. `reference/` holds the two original userscripts for comparison only; nothing loads them. The profit helper carries no licence, so remove `reference/tf2-scraptf-profit-helper-main` before publishing this repository.

This project is not affiliated with Valve, scrap.tf, backpack.tf, marketplace.tf or PriceDB.
