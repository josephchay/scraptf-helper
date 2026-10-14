# TF2 Flip Desk

A Windows desktop app that runs in the background and tells you which TF2 items are worth flipping. It compares the scrap.tf prices you give it with live backpack.tf buy orders. It groups the profitable items, keeps a running log of them, and gives you one-click links to backpack.tf, marketplace.tf, Steam Community Market, STN and PriceDB. For every item it tracks, it also shows the most you can pay on scrap.tf and still make your profit, so you know what to look for before you start browsing.

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

**Installer:** run `release\TF2 Flip Desk Setup 0.2.0.exe` (built by `npm run dist`). It is unsigned, so Windows SmartScreen will warn you on first launch.

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

1. **Open the Shopping list, then browse scrap.tf yourself**, as you normally would. For every item the app tracks, the list shows **Pay up to**: the highest scrap.tf price that still clears your profit thresholds against live backpack.tf buy orders. Anything priced at or under it is a flip. Items are grouped by scrap.tf bank page; a group's link opens that page in your browser. You can also export the list as CSV.
2. **Tell the app the price** of anything interesting, in any of these ways:
   - **Quick entry** (`Ctrl+Alt+F` from anywhere). Type the item name or SKU and the price, e.g. `1.33`, `14 scrap`, `2 keys 5.11`, or `1,5 keys`. As soon as you pick the item it shows who buys it, for how much, and its Pay up to; while you type the price it shows profit, margin and status. `Enter` saves; `Shift+Enter` only checks.
   - **Price sheet → Paste a list.** One item per line (`Team Captain, 1 key 5 ref`, a SKU, or a backpack.tf item link, then the price). You get a preview, then save up to 500 lines at once.
   - **Price sheet → Rules.** Category estimates such as "unique craftable hats ≈ 1.33 ref". The app then lists every item whose backpack.tf buy orders beat that, as *candidates to check on scrap.tf*.
   - **Import** (off by default; you turn it on after reading the ToS note). Save a scrap.tf page with `Ctrl+S` as "Webpage, HTML only" and import it. You can also pick a watch folder so saved pages are picked up automatically. The file is parsed locally; nothing is fetched.
3. **The app keeps checking.** It re-evaluates every price against live backpack.tf buy orders as they change, about 65 updates per second. For each item it:
   - drops attribute-specific, banned, blocklisted and marketplace.tf orders;
   - flags outliers;
   - computes conservative, best and instant revenue, and the Pay up to ceiling;
   - scores confidence from 0 to 100, with the reasons shown.
4. **Opportunities** groups the results by category, profit tier, confidence or input source. **Live log** shows every *appeared / changed / gone* event. High-confidence finds trigger a desktop notification. Right-click any row (or press `Shift+F10`) to copy the item's name, SKU or backpack.tf name, record a price in quick entry, or open its links.
5. **Click an item** to see its full buy-order book, PriceDB and community references, price history and the link menu. Then do the trade yourself.
   - Each buyer has an actions menu: open their backpack.tf or Steam profile, copy their SteamID64, **Block buyer** (with Undo), or **Check bans** on backpack.tf.
   - Under *Your scrap.tf prices*, mark a price **Seen now**, delete it, or add or update one. For a rule candidate the form reads *Found it on scrap.tf? Record the real price*.
6. **Journal** (optional): record what you actually bought and sold to get FIFO realised profit.

## New in 0.2

- **Shopping list and Pay up to.** A ceiling for every tracked item, as a page, a column in Opportunities, a line in quick entry and on each input in the item drawer, and a CSV export.
- **Quick-entry preview.** Live revenue, buyer, ceiling and profit while you type, a Check only mode, copy buttons and links. The drawer and the row menu open quick entry with the item already picked.
- **Buyer actions.** Open a buyer's profiles, copy their SteamID64, block them, or check backpack.tf bans. The ban check runs only when you click it. It needs your access token, and an answer is reused for an hour.
- **Bulk paste.** Paste a list of items and prices. Anything that looks like page content (`<` or a `scrap.tf/` link) is refused; use Import for saved pages.
- **Backups.** Price sheet → **Export CSV**: paste its `sku` and `cost` columns back into Paste a list to restore. Rules → **Export rules** / **Import rules** (JSON): import adds rules and never deletes any; rules you already have are skipped.
- **Notification controls.** Settings → Notifications: choose what to notify for (typed prices, imported pages, rule candidates) and turn off the sound. Rule-candidate toasts read *Candidate: …* and say how much to pay up to.
- **Guards.** Settings → Profit thresholds:
  - **Ignore reference prices older than** (default 30 days). PriceDB prices older than this are not used, and the row is flagged *Old reference*. backpack.tf community prices are set by hand and change rarely, so they always get at least a year.
  - **Suspect margin above** (default 200 %, 0 turns it off). A huge margin with fewer than 3 buyers and no usable reference is usually the wrong variant or unit. Such a row is flagged *Suspect margin*, capped at Low confidence, and never notified.

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

- `npm test` runs about 2,500 vitest tests, including the compliance tests: network policy, static scans for forbidden calls, and secret redaction.
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
