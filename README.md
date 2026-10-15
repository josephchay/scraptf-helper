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

**Installer:** run `release\TF2 Flip Desk Setup 0.3.0.exe` (built by `npm run dist`). It is unsigned, so Windows SmartScreen will warn you on first launch.

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
2. **Settings → backpack.tf.** Add your **access token** and **API key**. Both are on <https://next.backpack.tf/account/api-access>, and they are two different values:
   - **Access token:** click *Reveal* under *Access Token*.
   - **API key:** under *API Key*, register a key first (any site URL such as `http://localhost`, plus a short comment), then copy it. A 403 "This API key is not valid" almost always means the access token or a Steam Web API key was pasted here.
   - The live buy-order feed works without them.
   - The token enables on-demand and watched-item refreshes.
   - The key adds backpack.tf community prices and backpack.tf's key price.
   - PriceDB already provides a key price without a key.
3. Add your first scrap.tf price (next section).

## Daily workflow

1. **Open the Shopping list, then browse scrap.tf yourself**, as you normally would. For every item the app tracks, the list shows **Pay up to**: the highest scrap.tf price that still clears your profit thresholds against live backpack.tf buy orders. Anything priced at or under it is a flip. Items are grouped by scrap.tf bank page; a group's link opens that page in your browser. You can also export the list as CSV.
2. **Or start from the Live market**, the second page. It lists every item that has a backpack.tf buyer in the live feed, plus every item you have priced. Each row shows the best buyer, the Pay up to ceiling, your scrap.tf price and a verdict: *Flip*, *Rule flip* (a rule's estimate is under the ceiling), *Not checked*, *Over* or *No buyers*. Rows update as buy orders change. Filter by *Not checked* or *Rule flip* and sort by Pay up to to choose what to look up on scrap.tf next. **Freeze** stops the re-sorting while you read (unfreeze to load more rows), and **Export CSV** saves the current view.
   - **The app never visits scrap.tf**, and the Live market adds no network traffic: it reads the buy orders the live feed already stores. The scrap.tf side is only what you give the app: typed prices, rules and pages you saved.
   - **To keep the scrap.tf side current while you browse,** turn on Import, pick a **Watch folder**, and save each scrap.tf page you look at with `Ctrl+S` into that folder. Its prices and stock appear in the Live market within a few seconds, marked *page* with their age.
   - **Which pages to save next:** with Import on, a strip above the table has one chip per scrap.tf bank page (Hats, Weapons, Stranges, Killstreaks, Skins, Items, Unusuals) saying when you last saved it and how many items it had. Green means within 15 minutes, amber within 2 hours, grey older or never. Clicking a chip opens that page in your own browser; the app never fetches it.
3. **Tell the app the price** of anything interesting, in any of these ways:
   - **Quick entry** (`Ctrl+Alt+F` from anywhere). Type the item name or SKU and the price, e.g. `1.33`, `14 scrap`, `2 keys 5.11`, or `1,5 keys`. As soon as you pick the item it shows who buys it, for how much, and its Pay up to; while you type the price it shows profit, margin and status. `Enter` saves; `Shift+Enter` only checks.
   - **Price sheet → Paste a list.** One item per line (`Team Captain, 1 key 5 ref`, a SKU, or a backpack.tf item link, then the price). You get a preview, then save up to 500 lines at once.
   - **Price sheet → Rules.** Category estimates such as "unique craftable hats ≈ 1.33 ref". The app then lists every item whose backpack.tf buy orders beat that, as *candidates to check on scrap.tf*.
   - **Import** (off by default; you turn it on after reading the ToS note). Save a scrap.tf page with `Ctrl+S` as "Webpage, HTML only" and import it. You can also pick a watch folder so saved pages are picked up automatically. The file is parsed locally; nothing is fetched.
4. **The app keeps checking.** It re-evaluates every price against live backpack.tf buy orders as they change, about 65 updates per second. For each item it:
   - drops attribute-specific, banned, blocklisted and marketplace.tf orders;
   - flags outliers;
   - computes conservative, best and instant revenue, and the Pay up to ceiling;
   - scores confidence from 0 to 100, with the reasons shown.
5. **Opportunities** groups the results by category, profit tier, confidence or input source. **Live log** shows every *appeared / changed / gone* event. High-confidence finds trigger a desktop notification. Right-click any row (or press `Shift+F10`) to copy the item's name, SKU or backpack.tf name, record a price in quick entry, record a buy or sale in your journal, or open its links.
6. **Click an item** to see its full buy-order book, PriceDB and community references, price history and the link menu. Then do the trade yourself.
   - Each buyer has an actions menu: open their backpack.tf or Steam profile, copy their SteamID64, **Block buyer** (the confirmation offers Undo), **Check bans** on backpack.tf, or **Record sale to this buyer**.
   - Under *Your scrap.tf prices*, mark a price **Seen now**, delete it, or add or update one. For a rule candidate the form reads *Found it on scrap.tf? Record the real price*.
7. **Record the buy.** Once you have bought an item on scrap.tf, tell the app, in any of these ways:
   - **Quick entry → Bought it.** After you save a price, one click records a buy of one unit at that price on scrap.tf.
   - **Record buy** in the item panel, or **Record buy…** in a row's right-click menu. The dialog opens with your newest scrap.tf price for that exact copy (a painted copy's price is never used for the plain item) and, as you type, shows the item's Pay up to and your profit.
   - The Journal page.

   `Ctrl+Enter` saves the dialog. Every recorded trade shows a confirmation with **Undo** for 12 seconds; hovering over it or tabbing to it keeps it open.
8. **Holdings** (in the sidebar after Shopping list) shows what you still hold: every journal buy that no sale has matched yet, oldest unit first. It updates as buy orders change. For each item it shows:
   - your cost for the next unit you would sell (hover for the total), and how long you have held it. A cost paid in keys counts at today's key price, the way the Journal will book the sale, so a key price change alone never shows as profit or loss;
   - who buys it on backpack.tf right now and for how much (the buy order your profit settings use, as everywhere else in the app), bot or human, online or not, and how many buyers there are;
   - the profit now, with a status: *Sell now* (it clears your profit thresholds), *Hold* (a profit, but below them), *Loss* or *No buyers*.

   The header adds up your cost, what it is worth now, the unrealised profit or loss and how many items can be sold now. To sell:
   - Press **Record sale…** on a row (or `s`). The dialog is filled in with that buyer's price and a *Sold to …* note, and shows your profit against that unit.
   - Press `b` or click the buyer's name to open their backpack.tf profile in your browser.
   - Make the trade yourself, then save the sale. That unit leaves Holdings and its profit goes to the Journal. The app never sends, accepts or lists a trade.

   When something you hold can be sold at a profit, a desktop notification says *Sell: (item name)* with the buyer, their price and your profit. Turn it off in Settings → Notifications (*Notify when something you hold can be sold at a profit*). It uses the same minimum confidence and repeat time as the other notifications.
9. **Journal**: every trade you recorded, with FIFO realised profit. Delete a row there to correct a mistake.

## New in 0.3

- **Holdings.** A page of everything you hold (journal buys not sold yet), priced live against backpack.tf buyers: cost of the next unit, who buys it now, profit now and a *Sell now / Hold / Loss / No buyers* status, with totals for cost, worth now and unrealised profit. It reads the buy orders the live feed already stores. Held items also join the short list the app refreshes with backpack.tf snapshots, inside the same request budget as before.
- **Sell notifications.** *Sell: (item name)* when something you hold can be sold at a profit, or when that profit rises by another 1 ref. At most three at once, never repeated within your repeat time (also across restarts). Settings → Notifications has a switch for it.
- **Record trades in one click.** A Record trade dialog with a live comparison (Pay up to and profit for a buy, profit against your next unit for a sale), reachable from the item panel (*Record buy*, *Record sale*, and *Record sale to this buyer* on each buy order), the row menu (*Record buy…*, *Record sale…*), Holdings rows, and quick entry's one-click **Bought it**. The confirmation offers **Undo**.
- **Undo in confirmations.** Block buyer and every recorded trade show an Undo button that stays for 12 seconds, longer while you hover over or tab to it. It replaces the undo bar inside the item panel.
- **Saved-page strip.** With Import on, the Live market shows when you last saved each scrap.tf bank page, so you know which one to save again while browsing. A chip opens that page in your own browser; the app still never contacts scrap.tf.
- **Sturdier Live market.** If the local database cannot be read, the page says so and retries after 30 seconds, then up to every 10 minutes, instead of sitting at *Building 0 %*. The loaded rows (up to 2,000) refresh in one read, so a row that moves during a refresh can no longer be skipped.
- **Row menu.** It stays open while the table updates or scrolls by itself, and closes when you scroll. Near the bottom of the window it opens upward instead of covering the row you clicked.

## New in 0.2

- **Live market.** One live table of every item with backpack.tf buyers, next to your scrap.tf side: best buyer, Pay up to, your price (typed, or from a saved page with its stock, or a rule's estimate in italics) and a verdict, with verdict counts, filters, Freeze and CSV export. It reads the buy orders the live feed already stores, so it adds no network traffic, and the app still never contacts scrap.tf. With Import's watch folder on, pages you save while browsing show up in it within seconds.
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

- `npm test` runs about 2,900 vitest tests, including the compliance tests: network policy, static scans for forbidden calls, and secret redaction. The tests that measure timings run last, as their own group.
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
- **Live market and unusual effects.** An unusual effect whose only buyers are "any effect" orders appears in the Live market once you have priced it; the book has nothing per effect to list it by before that. Opportunities works the same way. Holdings does price such an effect, because it looks up each held item on its own.
- **Holdings know only what you record.** A trade you did not record, or recorded twice, makes the quantities and costs wrong; fix it in the Journal. Sales are matched to buys oldest first (FIFO).
- **Holdings value a clean copy.** Paint and spells add nothing to the buyer price; such rows are flagged *has extras*. Keys and metal you recorded as trades are listed without buyers.
- **Undo after a delete elsewhere.** If you delete a recorded trade on the Journal page and then press Undo on its confirmation, the confirmation still says it was removed. Nothing else changes.
- **Saved-page strip and pages imported with 0.2.** From 0.3 the app notes which bank page each saved page was when it imports it. A page imported with 0.2 is judged by the prices it still holds, so after a later import of scrap.tf's item list it can show as older, or *never saved*, until you save it again. It only ever errs towards saving again.

## Credits and licences

- **Link menu and saved-page parsing** follow [NetroScript/scrap.tf-item-information](https://github.com/NetroScript/scrap.tf-item-information) (Apache-2.0).
- **The profit-comparison idea** comes from VeBeshka's tf2-scraptf-profit-helper. None of its code is used.
- **SKU format:** a port of [@tf2autobot/tf2-sku](https://github.com/TF2Autobot/node-tf2-sku) (MIT).
- **Item names:** a port of `getName` from [node-tf2-schema](https://github.com/TF2Autobot/node-tf2-schema) (MIT).
- **Prices by [PriceDB.io](https://pricedb.io).** Buy orders and item data from [backpack.tf](https://backpack.tf).

See `NOTICE` for licence texts and attributions. `reference/` holds the two original userscripts for comparison only; nothing loads them. The profit helper carries no licence, so remove `reference/tf2-scraptf-profit-helper-main` before publishing this repository.

This project is not affiliated with Valve, scrap.tf, backpack.tf, marketplace.tf or PriceDB.
