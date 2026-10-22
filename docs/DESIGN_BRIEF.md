# TF2 Flip Desk: Design Brief (v1)

Working name. Do not use scrap.tf, backpack.tf, marketplace.tf or Steam names or logos in the product name, icon or UI branding.

Prepared 2026-10-14 from verified research. Confidence tags:
- **H**: primary source read directly.
- **M**: secondary source, or inferred from client code.
- **L**: community claim only.

Platform clauses are paraphrased. Engineers and the user should read the linked pages for exact wording.

Corrections found by the 2026-10-22 research (`docs/RESEARCH.md`) are marked in place as **Correction (2026-10-22)**, under the text they correct, which is kept as written. Changes 0.9 made to a rule stated here are marked **Note (0.9)**.

---

## 0. Positioning and hard rules

**Why the goal is reframed.** The user asked for a tool with "no detection faults". No tool can promise that. scrap.tf, backpack.tf and marketplace.tf are all run by ScrapTF, LLC. They enforce on observed behaviour and user reports, can ban without giving a reason, and use IP-based linking. The only durable protection is to stay inside each platform's rules.

So the product is **compliant by design, not undetectable**. We do not implement, research or document any of the following:
- user-agent spoofing
- proxy or IP rotation
- multi-account rate pooling
- CAPTCHA, Turnstile or Cloudflare challenge solving
- randomised "human-like" timing

**Hard rules.** Each one is enforced in code and covered by a test.

| # | Rule |
|---|---|
| R1 | The app never sends a network request to `scrap.tf` or any subdomain (including `ws.scrap.tf` and `forum.scrap.tf`). This is blocked in the HTTP layer (§2.0). |
| R2 | No HTML fetching from backpack.tf, next.backpack.tf, forums.backpack.tf, marketplace.tf, stntrading.eu, mannco.store or steamcommunity.com. Only documented JSON APIs and documented websockets are used. |
| R3 | No userscripts, no browser extensions, no injection into any website. |
| R4 | No automated buying, queueing, trading, accepting, declining, listing, bumping or undercutting on any platform. A human does every transaction, in their own browser and Steam client with mobile confirmation. |
| R5 | Only the user's own API keys and tokens. One account, one IP. No proxy support. |
| R6 | Honest, fixed User-Agent that identifies the app. |
| R7 | Internal request budgets set below every published limit. Honour 429 and `Retry-After`. Stop on any Cloudflare challenge; never retry it automatically. |
| R8 | Secrets are encrypted at rest with Electron `safeStorage` (DPAPI on Windows). They are never written to logs or URLs in logs, and never sent to any host other than the one that issued them. |
| R9 | The app never asks for, stores or handles Steam passwords, Steam or scrap.tf session cookies, `shared_secret`/`identity_secret`, or Steam Desktop Authenticator files. |
| R10 | scrap.tf data enters the app only through user input (default). Saved-page import is behind a permission gate (§3). |

---

## 1. Platform rules summary

### 1.1 One operator for three sites
The footers of all three sites name the same owner:
- scrap.tf: "Copyright 2026 ScrapTF, LLC" (https://scrap.tf/terms)
- marketplace.tf: "© 2013-2026 ScrapTF, LLC" (https://marketplace.tf/terms)
- backpack.tf: "© 2012-2026 · ScrapTF, LLC" (https://web.archive.org/web/20261004165504/https://next.backpack.tf/developer/)

All three are **H**. No cross-site enforcement policy is published. Treat them as one risk domain anyway (inference). backpack.tf's keyed API is the operator's own sanctioned data channel.

### 1.2 scrap.tf
Source: https://scrap.tf/terms. The page says "Last updated September 02, 2015". It was read live 2026-10-14 and matches the Wayback copy http://web.archive.org/web/20261014041215/https://scrap.tf/terms. **H**

**Prohibited**
- Gaining an advantage over other users by any method. The ToS lists, among others: "automation, scripts, user-scripts, auto-refreshers, external tools".
- Circumventing the site's security in any way.
- Disrupting the service, including bypassing limitations and scanning the servers.
- Downloading, copying, reusing or redistributing site content for commercial purposes or personal gain without express advance written permission (Content section).
- Using alternate accounts while banned. Account owners are identified by IP address "and other factors".
- Penalties include account bans and IP bans. Accounts can be terminated for any reason, reasons can be withheld, and appeals are not guaranteed. Material ToS changes require 30 days' notice.

**Staff statements**
- Moderator Luki, 2016-05-16: no scripting of any kind on the banking side of the site; cosmetic and community-side userstyles and scripts are tolerated. https://forum.scrap.tf/topic/9241-scraptf-community-made-userstyles/ (**H**, old). `/buy/*` and `/unusuals/*`, where the old profit helper ran, are banking pages.
- Developer "nikki", 2021-03-24: the raffle-script policy will not change any time soon. http://web.archive.org/web/20210614154256/https://forum.scrap.tf/topic/24155-why-are-raffle-scripts-forbidden/?tab=comments (**H**)

**Enforcement evidence**
- Raffle-script bans, with the appeal upheld after staff tied the user to a GitHub script. https://steamcommunity.com/app/440/discussions/0/2592234299533936432/ (**M**, 2017)
- A second-hand report of a permanent "using scripts" ban for 12+ hours a day of hat banking with 3+ tabs refreshing and no script. https://scrap.tf/raffles/7URXHG (**L/M**, 2017). Behaviour alone can be read as botting.
- KB 166: IPs are blacklisted for Tor, VPN or proxy use, for many users at one location, or for being "flagged for suspicious behavior". http://web.archive.org/web/20260306132433/https://scrap.tf/help/kb/166 (**H**)

**Technical facts**
- HTML is behind a Cloudflare managed challenge: `403` with `Cf-Mitigated: challenge` (**H**).
- Logged out, `/buy/*` redirects to Steam OpenID (**H**).
- There is no public API. `/apidocs` existed only in 2013–2014 (http://web.archive.org/web/20140129184108/http://scrap.tf/apidocs, **H**).
- Internal endpoints exist but are off-limits: `/ajax/*` (session-bound, uses CSRF `ScrapTF.User.Hash`, sudo/2FA), raffle entry (needs Turnstile), and the `ws.scrap.tf` socket.io feed.

**Unknown**
- The login-gated "Community Rules" (`/ajax/rules/GetRulesText`) have not been read.

**Not addressed by the rules**
- Reselling items bought from scrap.tf elsewhere is not mentioned. That is absence of a rule, not permission (**M**).

**Reference values observed by hand on 2026-10-14**
- Key buy price `ScrapTF.KeyPriceInScrap = 616` (68.44 ref); key sell price `KeySellPriceInScrap = 580` (64.44 ref).
- Craft hat `HatPriceInScrap = 16`, `HatSellPriceInScrap = 14`.
- scrap.tf displays scrap as ref with `floor(s/9) + 0.11*(s%9)`.

**Contacts:** admin@scrap.tf (questions about the ToS), nikki@scrap.tf (manager), Admin Oswald (appeals). Source: http://web.archive.org/web/20261014041103/https://scrap.tf/about

### 1.3 backpack.tf
**API Terms.** Source: https://web.archive.org/web/20250326053955/https://next.backpack.tf/developer/terms. This is the newest readable capture; the live page is behind Cloudflare. **H**, possibly outdated. By using the APIs you agree:
- to stay within API limits without using multiple accounts;
- not to use internal APIs (paths whose first character is `_`);
- not to page-scrape to get around rate limits.

Penalties: keys revoked and IPs or users blacklisted without notice. No SLA is offered.

**Developer Centre.** Source: https://web.archive.org/web/20261004165504/https://next.backpack.tf/developer/ (**H**). Entry dated 2025-05-28:
- v1 listing APIs are deprecated, rate limited and slated for removal.
- 429 responses now carry `Retry-After`.

That is still the latest entry. API docs are at https://api.backpack.tf/api/index.html, with the spec at https://api.backpack.tf/api/swagger.json (identical to https://backpack.tf/api/swagger.json).

**Websocket doc.** Source: http://web.archive.org/web/20260209024451/https://next.backpack.tf/developer/websocket (**H**).
- No server-side filtering.
- Too many concurrent connections from one IP triggers `client-limit-exceeeded` (sic) and the server closes the connection.
- The docs recommend one connection, rebroadcast locally.
- The server may restart at any time.

**Community rules.** Source: https://web.archive.org/web/20261004165417/https://backpack.tf/rules (**H**).
- Third-party bots are allowed only if trades can be done entirely by trade offer or by adding the bot from backpack.tf.
- A generic buy order must be the price the buyer will pay for any clean, non-duped item.
- Buyers must have the pure on hand.
- Line cutting, unrealistic listings, and repeatedly changing your mind after receiving offers are bannable.
- Background checks are required for trades over 15 keys (2019 forum post; may be outdated). https://web.archive.org/web/20240415024144/https://forums.backpack.tf/topic/70966-new-rules-for-background-checks/

**Spec facts** (https://backpack.tf/api/swagger.json, **H**)
- `POST /agent/pulse` marks the account as bot-controlled for 30 minutes and bumps its listings. A read-only tool must never call it.
- Inventory data should come from Steam's own APIs, not backpack.tf.
- The spec defines an optional `X-App-Context` header, recommended value `440`.

**Technical (H, 2026-10-14).** HTML pages, including `/classifieds?...`, are Cloudflare-challenged. `/api/*` JSON and `wss://ws.backpack.tf/events` are not.

### 1.4 marketplace.tf
**Terms.** Source: https://marketplace.tf/terms (**H**).
- §9 forbids using scripts, bots, extensions, automation or external tools for advantage; circumventing site security; and multiple or alternate accounts.
- §2 licenses site materials only for personal, non-commercial, transitory viewing, and forbids copying or mirroring them.
- §11 lets the site remove access for any reason. Chargebacks bring a permanent ban.

**"Update on Scripting" blog post**, 2017-09-30 (https://marketplace.tf/blog/posts/KIXIWD, **H**, old): the site deliberately offers no endpoint for an item's lowest price. Scripted undercutters are banned from selling.

**API.** Source: https://marketplace.tf/apidocs and keyless `GET https://marketplace.tf/api/Meta/GetEndpoints/v1` (**H**). The API covers only your own account:
- `Bans/GetUserBan/v2` (key, steamid)
- `Orders/GetOrders/v1`
- `Seller/GetDashboardItems/v2`, `Seller/GetDashboardStats/v2`, `Seller/GetSales/v2`

`Deals/GetDeals/v2` now returns `404 "Endpoint not found."` No rate limits are documented. HTML pages are Cloudflare-challenged.

### 1.5 Steam
**Subscriber Agreement.** Source: https://store.steampowered.com/subscriber_agreement/english/, last updated 2026-09-10 (**H**).
- §4.C Automation: no scripts, bots, macros or other non-human-controlled systems interacting with Steam content or services in any manner. The clause first appeared in the 2025-09-18 revision; it is absent from the 2024-09-26 version (https://web.archive.org/web/20250613193805/https://store.steampowered.com/subscriber_agreement/english/).
- §4.B: no unauthorized software that modifies Subscription Marketplace processes. §3.D names Steam Trading and the Community Market as Subscription Marketplaces.
- §4.D: enforcement uses automated detection plus human review, and accounts can be terminated without notice.
- §3.A: no IP proxying to disguise where you live.
- §2.A: the licence is for personal, non-commercial use.

**Web API Terms.** Source: https://steamcommunity.com/dev/apiterms, dated July 2010 (**H**).
- Limit of 100,000 calls per day.
- Keep the key confidential and do not transfer it.
- Never intercept or store Steam passwords.
- Fetch a user's data only when that user requests it.
- Publish a privacy policy if nonpublic user data is handled.
- Do not degrade Steam, and do not use the API in a way that violates the SSA.

**Account facts**
- Limited accounts (under $5 spent) cannot use the Web API or the Market. https://help.steampowered.com/en/faqs/view/71D3-35C2-AD96-AA3A (**H**)
- Creating a Web API key has required a Mobile Authenticator since 2023-12. https://dev.doctormckay.com/topic/4638-node-steamcommunity-v3480 (**M**)
- The "API key scam" hijacks trades through a key registered by a phishing site. https://scrap.tf/help/trade-offers (**M**)

**Trade holds.** Source: https://help.steampowered.com/en/faqs/view/34A1-EA3F-83ED-54AB (**H**).
- Holds last up to 15 days unless a Mobile Authenticator has been active for at least 7 days.
- Cancelling a held trade starts a 7-day trade cooldown.
- Trade Protection (7-day reversible trades) currently covers only CS2 (https://help.steampowered.com/en/faqs/view/365F-4BEE-2AE2-7BDD).

> **Correction (2026-10-22, RESEARCH §4.6, §9 q15):** contested. Valve's FAQ did not render on 2026-10-22, so the CS2-only reading could not be re-checked. DMarket's API documentation says Steam's 7-day Trade Protection applies to every Steam game (https://docs.dmarket.com/v1/swagger.html), and a 2025-07-17 article said it would later reach other games that use the Community Market (https://www.pcworld.com/article/2851576/steam-thwarts-counter-strike-scammers-with-new-trade-reversal-system.html). If TF2 is covered, every TF2 trade is reversible and the item locked for 7 days. From 0.9 Flip Desk asks the user (Settings → Trade lock: Not sure by default, No lock, 7-day lock), and with a 7-day lock Holdings counts it.

**Scam FAQ.** Source: https://help.steampowered.com/en/faqs/view/70E6-991B-233B-A37B (**H**). Bans can extend to all of a scammer's accounts. The FAQ warns about "quick-sell profit" pitches on price-manipulated unusuals, whose Market transactions may be reversed.

**Community Market priceoverview.** This is an undocumented JSON endpoint. Per-IP limits are unpublished, and community reports describe lockouts of 6 hours or more (**L**).

### 1.6 Other services
- **mannco.store.** ToS revision 2026-05-02 (https://mannco.store/tos, **H**). It bans bots, scrapers, userscripts, add-ons and extensions used to automate purchasing or collect data. Clause (h) bans systematic retrieval to build a database by any means; there is no carve-out for the API. An official API exists (https://docs.mannco.store/api-reference/introduction): API key exchanged for a JWT bound to your IP, typically about 600 requests per 60 s.
- **STN Trading.** Every API endpoint needs a key, including `GetKeyPrices`, and some are billed in credits (https://api.stntrading.eu/swagger.json, **H**). Site rules are login-gated and HTML is challenged.
- **PriceDB.** ToS dated 2026-06-29 (https://pricedb.io/terms-of-service, **H**). Personal, community and commercial use and redistribution of API output are allowed, with attribution where practical. Evading limits or blocks, concealing abusive traffic and market manipulation are forbidden, and PriceDB may block access.
- **sku.pricedb.io.** Documented at 360 requests per minute per IP (https://docs.pricedb.io/docs/sku, **H**).
- **schema.autobot.tf.** No published limits or use policy.
- **prices.tf.** Dead: the subdomains return NXDOMAIN and autobot.tf's mirror returns `503 "prices.tf service ended"` (**H**).

### 1.7 Compliant boundary for this app

| Action | Verdict | Basis |
|---|---|---|
| App fetches anything from scrap.tf: pages, `/items`, `/ajax/*`, `ws.scrap.tf` | **Never** | ToS automation, content and security clauses; Cloudflare challenge |
| Userscript, extension or DOM injection on any site | **Never** | scrap.tf ToS names user-scripts; moderator statement on banking pages; marketplace.tf §9; mannco ToS |
| Automated buy, queue, accept, decline, list or bump anywhere | **Never** | scrap.tf ToS; SSA §4.B/§4.C; bp.tf rules |
| Embedded scrap.tf browser that reads the DOM passively | **Not in v1.** Only if scrap.tf gives written permission that explicitly covers it (§3.5) | It is functionally a script on banking pages. The Electron UA token is visible to scrap.tf, and Steam login would happen inside our app. |
| Importing a scrap.tf page the user saved by hand | **Off by default.** Enable only after recording written permission | Content clause (use for personal gain). No network contact. |
| User types or pastes an item and its scrap.tf price | **Default mode. Residual grey area** | No contact with scrap.tf, comparable to checking bp.tf in another tab. The "external tools" wording is broad, so the app recommends asking admin@scrap.tf (Appendix C). |
| bp.tf HTML classifieds | **Never** | API ToS clause against page scraping; Cloudflare |
| bp.tf documented API and websocket with the user's own key or token, within limits | **Allowed** | Developer Centre; API ToS |
| bp.tf `/agent/*`, listing writes, `_`-prefixed APIs | **Never in v1** | Read-only tool; API ToS |
| marketplace.tf, STN, mannco, SCM or bp.tf web pages | **Links only**, opened by the user in their default browser | Site licences |
| marketplace.tf, mannco or STN official APIs with the user's own key | **Optional, off by default** | Permitted API use. Keep any mannco cache small and personal. |
| PriceDB REST and socket, sku.pricedb.io | **Allowed**, with attribution and within limits | PriceDB ToS |
| Steam Web API with the user's own key | **Optional, minimal, user-initiated** | Web API Terms; caution under SSA §4.C |
| SCM priceoverview | **Off by default; on click only** | Undocumented; IP lockouts; SSA §4.C |
| VPN, proxy, multiple accounts, UA spoofing, challenge solving | **Never.** The app warns the user about VPNs. | scrap.tf KB 166; SSA §3.A; bp.tf and PriceDB ToS; mannco JWT is IP-bound |

---

## 2. Data sources

### 2.0 Network layer (shared by every connector)
- **One HTTP/WS client module** runs in the service process (§7). No other code makes network calls, and there is no cookie jar.
- **Denylist**, checked first. A match throws `ForbiddenHostError`, and a unit test proves it:
  - `scrap.tf`, `*.scrap.tf`
  - `backpack.tf`, `next.backpack.tf`, `forums.backpack.tf` (any path not under `/api/`)
  - `marketplace.tf` (any path not under `/api/`)
  - `stntrading.eu`, `mannco.store`
  - `steamcommunity.com` (except `/market/priceoverview/`)
- **Allowlist**:
  - `https://api.backpack.tf/api/*`, `https://backpack.tf/api/*`, `wss://ws.backpack.tf/events`
  - `https://pricedb.io/api/*`, `https://ws.pricedb.io/socket.io/*`
  - `https://sku.pricedb.io/api/*`
  - Optional: `https://api.steampowered.com/*`, `https://steamcommunity.com/market/priceoverview/`, `https://marketplace.tf/api/*`, `https://api.mannco.store/*`, `https://api.stntrading.eu/*`
- **Headers**
  - `User-Agent: TF2FlipDesk/<semver> (+<contact URL the user sets in Settings>)`
  - Never a browser UA string.
  - For bp.tf, also send `X-App-Context: 440`.
- **Errors**
  - 429 or 503: honour `Retry-After`, accepting seconds, an HTTP date, or a Unix timestamp. bp.tf's old docs used a Unix timestamp; detect values above 10^9. Without the header, back off 60 s, then ×2, capped at 15 min. After 3 consecutive 429s, pause that host for 1 h and show it in the UI.
  - 401 or 403 with a JSON body: disable the connector and ask the user to check the key.
  - Any `cf-mitigated: challenge` header or HTML 403: disable the connector until the user re-enables it. Never retry automatically. The block is stored in the database, so a crash restart or a relaunch does not retry the host either; the user clears it with "Re-enable" on the Data health page (`net.unblock`).
- **Concurrency:** 1 request at a time per host (2 for pricedb.io).
- **Request log:** SQLite table `request_log` with ts, host, path with secrets redacted, status, ms and bytes. Keep 7 days. The UI "Data health" page shows per-host counts against budget.

| Host / endpoint | Published limit | Our budget |
|---|---|---|
| `wss://ws.backpack.tf/events` | about 1 connection per IP | exactly 1, process-wide singleton |
| bp.tf `classifieds/listings/snapshot` | unpublished; community estimate about 1 per 10 s (**L**) | 1 per 10 s, at most 300 per hour, only user-driven or watchlist items |
| bp.tf `IGetPrices/v4` | cached globally 900 s | one full fetch at first run, then `since` deltas every 2 h (never more often than every 15 min) |
| bp.tf `IGetCurrencies/v1` | none published | every 60 min |
| bp.tf `users/info/v1` | none published | at most 1 per 10 s, steamids batched comma-separated |
| `pricedb.io/api/*` | `RateLimit-Policy: 360;w=60` per IP | at most 60 per minute; pause while `RateLimit-Remaining` < 36 |
| `ws.pricedb.io` | none | exactly 1 connection |
| `sku.pricedb.io/api/*` | 360 per minute per IP | schema at most once per 24 h with `If-None-Match`; lookups at most 30 per minute |
| `api.steampowered.com` | 100,000 per day | hard cap 5,000 per day, at most 1 per second |
| SCM `priceoverview` | unpublished | on click only, at most 1 per 5 s, cache 60 min; a 429 disables it for 6 h |
| `api.mannco.store` | about 600 per 60 s; `/item/prices` 1 per 5 min | `/item/prices` at most 1 per hour; bulk at most 1 per minute |
| `marketplace.tf/api`, `api.stntrading.eu` | none, or credits | on click only |

> **Note (0.9, RESEARCH §4.6, §8 #14):** the SCM `priceoverview` budget also has a daily cap: at most 1 per 5 s and 300 per day, under the community-measured 1,000. On `api.steampowered.com`, an `x-eresult` of 25 or 84 counts as a rate limit, like a 429, and any HTML answer carrying a Cloudflare challenge script stops its host until the user re-enables it.

### 2.1 backpack.tf websocket (primary live source of buy orders)
- **URL:** `wss://ws.backpack.tf/events`. No auth, no key.
- **Client:** the `ws` npm package, because WHATWG WebSocket cannot set headers. Optionally send header `batch-test: true`; the docs describe it as temporary. Frames arrived as arrays even without it (**H**, 2026-10-14). Offer `perMessageDeflate`; the server may decline.
- **Frame format:** a JSON array of `{id, event, payload}`. Also accept a single object, for robustness.
  - `id` is 12 bytes in ObjectId style, and its first 4 bytes are a timestamp.
  - `event` is one of:
    - `listing-update`: create or update. It does not fire for bumps or for currency revaluation.
    - `listing-delete`: archiving also counts as a delete.
    - `buffer-limit-exceeded`
    - `client-limit-exceeeded` (sic)
- **Volume** (**H**, probes of 2026-10-14): 565–730 events per 12 s, about 1.0–1.7 MB per 12 s, roughly 100–140 KB/s, or 8–12 GB/day uncompressed. About 90% of updates carry `userAgent`.
- **Payload field names** (**H**, live). Nested sub-shapes marked † must be confirmed from captured fixtures. Illustrative example:

```json
{
  "id": "440_1234567890",
  "steamid": "76561198000000000",
  "appid": 440,
  "intent": "buy",
  "currencies": { "keys": 2, "metal": 10.33 },
  "value": { "raw": 136.55, "short": "…", "long": "…" },
  "tradeOffersPreferred": true,
  "buyoutOnly": true,
  "details": "free-text notes",
  "listedAt": 1791950000,
  "bumpedAt": 1791958000,
  "count": 1,
  "status": "active",
  "source": "userAgent",
  "userAgent": { "client": "…", "lastPulse": 1791958700 },
  "user": { "id": "7656…", "name": "…", "premium": false, "online": true, "banned": false, "bans": [], "tradeOfferUrl": "DISCARD" },
  "item": {
    "name": "Burning Flames Team Captain",
    "marketName": "Unusual Team Captain",
    "baseName": "Team Captain",
    "defindex": 378,
    "quality": { "id": 5, "name": "Unusual", "color": "#8650AC" },
    "particle": { "id": 13, "name": "Burning Flames", "shortName": "…", "type": "cosmetic" },
    "killstreakTier": 0, "sheen": "†", "killstreaker": "†",
    "paint": "† {id,name,color}", "spells": [], "killEaters": [], "strangeParts": [],
    "festivized": false, "australium": false, "wearTier": "†", "texture": "†",
    "crateSeries": null, "recipe": "†", "craftable": true, "tradable": true,
    "priceindex": "13", "price": { "steam": "…", "community": "…", "suggested": "…" },
    "summary": "…", "class": [], "slot": "…", "customName": null, "customDesc": null, "paintSecondaryHex": null
  }
}
```

  - Sell listing ids are `440_<assetid>`. The buy-order id format is not documented, so treat it as an opaque string.
  - `delete` payloads also had a `deal` field.
  - Timestamp units are believed to be seconds; verify from fixtures.
- **Processing** (in the service process):
  1. Drop events where `appid !== 440`.
  2. Upsert or delete in `listings`, keyed by `id`.
  3. Write in batches, one transaction per second.
  4. Compute the SKU from structured item fields (§4.4) and store it alongside the listing.
  5. Record `(sku → item.name, item.marketName)` in `bptf_names` with `last_seen`. This feeds the snapshot `sku` parameter.
  6. Re-evaluate the opportunity engine (§5) only for SKUs that are watched or match a price-sheet rule.
- **Privacy:** never store `user.tradeOfferUrl`, because it contains a trade token. Keep only `steamid, name, premium, banned, bans, online`.
- **Retention**
  - Buy listings: all TF2 buy listings. Keep the full SKU; drop `summary`, `customDesc` and `price`.
  - Sell listings: only for watched SKUs. A user setting can widen this.
  - TTL: bumps are not streamed, so `last_event_at` older than 24 h marks the listing `unverified`. Unverified listings are excluded from High confidence (§5.7). Rows not seen for 14 days are purged.
- **Connection management**
  - Reconnect with exponential backoff: 1 s, ×2, capped at 60 s.
  - A silence watchdog forces a reconnect after 120 s with no frames.
  - On `client-limit-exceeded`, stop and tell the user another app on this IP is already connected. Do not reconnect in a loop.
  - On `buffer-limit-exceeded`, log it and continue; expect a gap in the data.
  - The user can toggle "Live feed" (default ON while the app runs). There is a daily data cap setting (default 12 GB). The feed pauses when Windows reports a metered connection.
- **Cold start.** The socket sends only changes. For watched SKUs, backfill with the snapshot endpoint (2.2). The SQLite book persists across restarts.

### 2.2 backpack.tf classifieds snapshot (on-demand backfill and refresh)
- **Request:** `GET https://api.backpack.tf/api/classifieds/listings/snapshot?sku=<bp.tf full item name>&appid=440`
  - `sku` is the bp.tf **full name**, not a tf2-sku and not a defindex. Examples: "Strange Pain Train", "Burning Flames Team Captain". Source: the spec's `itemDocument.name` description (**H**), plus every client library (**H**).
  - Name resolution: try `bptf_names` first, then `sku.pricedb.io/api/sku/{legacy-sku}` `.data.name`. If the response has no listings, retry once with `"The " + name`, or with the leading "The " removed (bliss-autopricer queries both forms).
- **Auth:** the user's access token. The endpoint is not in swagger. Every client sends `?token=`; the `X-Auth-Token` header is undocumented here.
  - The Settings "Test connection" button tries the header first and falls back to the query parameter. The working method is stored.
  - The token is redacted from all logs.
  - Without a valid token the endpoint returns `401 {"message":"This access token is not valid."}` (**H**).
- **Response** (**M**: client types and 2021–2022 fixtures; may have drifted):

```json
{ "id": null, "appid": 440, "sku": "Strange Pain Train", "createdAt": 1791958000,
  "listings": [ { "steamid": "7656…", "offers": 1, "buyout": 1, "details": "…", "intent": "buy",
    "timestamp": 1791950000, "bump": 1791958000, "price": 63.11,
    "currencies": { "keys": 0, "metal": 63.11 },
    "userAgent": { "client": "…", "lastPulse": 1791958700 },
    "item": { "defindex": 154, "quality": 11, "quantity": "1",
              "attributes": [ { "defindex": 214, "value": 0, "float_value": 0 } ] } } ] }
```

  - `price` appears to be the total in refined; this is inferred.
  - Marketplace.tf listings carry `currencies.usd` plus `item.marketplace_sku`, `item.marketplace_price` and `item.marketplace_bot_steamid`.
  - `userAgent` can be present even on marketplace.tf listings.
- **Limits:** unpublished. Budget 1 request per 10 s (§2.0). Cache by name for at least 10 minutes and use `createdAt`.
- **Use:** backfill and reconcile watched SKUs, and refresh the best order when the user opens an item. **Never loop over the catalogue.** Do not use it to replace alerts; the old docs said that can get an account banned.
- **Deprecation:** forum users consider this a v1 endpoint, and v1 is slated for removal. Wrap it behind an interface. On 404 or 410, mark it unavailable, fall back to websocket-only data, and show a banner.

### 2.3 backpack.tf community prices (IGetPrices v4)
- **Request:** `GET https://api.backpack.tf/api/IGetPrices/v4?key=<api key>&raw=1&since=<unix>`
  - Auth: query parameter `key`. Without it the response is `403 {"response":{"success":0,"message":"This API key is not valid..."}}` (**H**).
  - The response is cached globally for 900 s. The spec recommends `since` for delta updates (**H**).
- **Shape** (**H** spec, plus the observed `response` wrapper):

```json
{ "response": { "success": 1, "current_time": 1791958000, "raw_usd_value": 0.03, "usd_currency": "metal", "usd_currency_index": 5002,
  "items": { "Team Captain": { "defindex": [378],
     "prices": { "5": { "Tradable": { "Craftable": { "13": { "currency": "keys", "value": 60, "value_high": 70,
        "value_raw": 3786.6, "last_update": 1791000000, "difference": 0, "australium": false } } } } } } } } }
```

  - Keys run quality id → `Tradable`/`Non-Tradable` → `Craftable`/`Non-Craftable` → priceindex.
  - `priceindex` is the effect id for unusuals, the crate series for crates, and the target defindex for strangifiers and unusualifiers. For chemistry sets it is `"defindex-quality"`. A non-indexed item uses `"0"`.
  - Accept both the object and the array form at the Craftable level; the array form is unverified.
- **Use:** a "bp.tf community price" column, sanity bounds for outlier detection (§5.5), and a fallback key price (entry `Mann Co. Supply Crate Key`, quality 6, defindex 5021).
- **Caching:** persist the merged result to SQLite and store `current_time` for the next `since`.

### 2.4 backpack.tf currencies (key price)
- **Request:** `GET https://api.backpack.tf/api/IGetCurrencies/v1?key=<api key>&raw=1`
- **Shape is uncertain.** The spec models `currencies` as an array; the classic docs model it as an object keyed `metal`/`keys`/`hat`. Parse defensively: iterate the values of `response.currencies` (array or object) and pick the entry with `defindex === 5021` or key `keys`.
- **Price:** `price.value` (and `value_high`) in refined when `price.currency === "metal"`.
- **Refresh:** every 60 min.
- **Use:** key price source #1 when the user has supplied a key (§5.3).

### 2.5 backpack.tf user and ban info (optional)
- `GET https://api.backpack.tf/api/users/info/v1?steamids=<comma list>`, token auth. The `bans` field gives ban flags.
- `GET https://api.backpack.tf/api/IGetUsers/v3?steamids=...&key=...` is an alternative.
- **Use:** flag or exclude banned buyers (§5.2), and the background-check helper for trades over 15 keys (§5.8).

### 2.6 backpack.tf alerts and notifications (optional, v1.1)
- `POST /api/classifieds/alerts` with `item_name, intent, currency, min, max, blanket`.
- `GET /api/notifications?unread=1`, polled at most every 5 min.
- This is the sanctioned "tell me when a listing appears" mechanism. Do not substitute snapshot polling for it.

### 2.7 PriceDB REST (keyless baseline prices and key price)
Base URL `https://pricedb.io/api`. Read endpoints need no auth. Limits come from the response headers `RateLimit-Policy: 360;w=60`, `RateLimit-Remaining` and `RateLimit-Reset` (**H**).

| Endpoint | Use | Notes |
|---|---|---|
| `GET /item/{sku}` | single price | 404 returns `{"error":"Item not found"}` for both unknown and malformed SKUs |
| `POST /items-bulk` with body `{"skus":[...]}` (1–100) | refresh watched SKUs | A raw array returns 400. Unknown SKUs are silently dropped. Output is not in request order, so map results by `sku`. |
| `GET /autob/items` | cold-start full list | `{"success":true,"currency":"metal","items":[...]}`. About 52,249 SKUs; 8.4 MB decompressed, about 1.05 MB with brotli. CDN `max-age=14400`, so it can lag up to 4 h. |
| `GET /item-stats/{sku}`, `GET /item-history/{sku}?start&end` | history and stats panel | Key history is spaced about 900 s; most other items are sparse |
| `GET /search?q=&limit<=50` | name search fallback | `{success, data:{results, nextCursor, hasMore, limit, total}}` |
| `GET /graph/{sku}` | HTML graph | **Link only**, opened in the browser |
| `POST /autob/items/{sku}` | — | **Do not use.** It is intended for TF2Autobot. |

> **Correction (2026-10-22, RESEARCH §4.7):** the about-900 s spacing holds only for the recent tail. PriceDB's `5021;6` history had 328 points from 2025-09-25 to 2026-10-22: 2-6 a month before October 2026, then mostly 900 s apart, with about 220 identical consecutive pairs; `item-stats` gives all-time min, max and average only. 0.9's key move band (Holdings) stops at the first span whose ends have no point within 2 days, so only the dense tail counts and the sparse months never read as a flat key.

**Record shape** (**H**):

```json
{ "name": "Mann Co. Supply Crate Key", "sku": "5021;6", "source": "bptf", "time": 1791959959,
  "buy": { "keys": 0, "metal": 63.11 }, "sell": { "keys": 0, "metal": 64.44 } }
```

Data notes:
- Metal values are on a 1/9 ref grid, truncated to 2 decimals.
- Metal is not normalised below one key. Example: `buy {keys:1, metal:63.88}`.
- Lookups match the SKU string exactly and use the **legacy** token order, with variants (§4.2).
- Coverage gaps: no Strange Unusual SKUs, no unusual skins (u701–704), and no effects above u3223, while the schema goes up to 3242.
- Data is often stale: about 34% of SKUs are older than 30 days. Currency SKUs are nonsensical, e.g. `5002;6` shows buy 0 / sell 0.11.

UI attribution: "Prices by PriceDB.io".

### 2.8 PriceDB socket (live price updates)
- socket.io-client v4 connecting to `https://ws.pricedb.io` (TLS), `transports:['websocket']`, default namespace.
- The handshake reports `pingInterval 25000` and `maxPayload 1000000` (**H**).
- Event `price` carries `{sku, name, buy, sell, source, time}`, per the docs (**H**). No event arrived in a 45 s live test.
- **Reconnect:** 1, 2, 4, 8, 16 s. After 5 failures, retry every 10 min; do not hammer the server and do not give up permanently. Exactly one connection.
- **Use:** keep `pricedb_prices` fresh after the cold-start `/autob/items` load.

### 2.9 Schema source (sku.pricedb.io)
- `GET https://sku.pricedb.io/api/schema`: the full node-tf2-schema object. It is about 21.3 MB parsed and about 1.3–1.5 MB on the wire (zstd/gzip/br), with `Cache-Control: max-age=7200` and an ETag.
  - Fetch at most once per 24 h, with `If-None-Match`.
  - Persist the derived maps to SQLite. Do not hold the 21 MB object in memory after building them.
  - Top level: `{version, time, raw:{schema:{qualities, qualityNames, originNames, attributes, items(11,606), paintkits(250), attribute_controlled_attached_particles(671), kill_eater_score_types, string_lookups, item_sets, item_levels}, items_game:{...}}}`
- **Light endpoints**, used for the first run and for incremental checks: `/api/effect/list` (590 entries, deduplicated), `/api/paint/list`, `/api/paintkit/list`, `/api/quality/list`, `/api/wear/list`, `/api/strangepart/list`, `/api/crateseries/list`.
- **Resolvers:** `/api/sku/{sku}` returns parsed fields and `name`. Example: `30177;5;u13` gives `{"sku":"30177;5;u13","name":"Burning Flames Hong Kong Cone","defindex":30177,"quality":5,"craftable":true,"tradable":true,"killstreak":0,"australium":false,"effect":13,"festive":false,"paintkit":null,"wear":null,"quality2":null,...}`. `/api/name/{name}` returns a **legacy-order** SKU.
- **Images:** `/api/sku/{sku}/image`. Unusual images are composited server-side; other images 302 to the Steam CDN or scrap.tf. Load images only in the app's own UI and never from scrap.tf. Images that redirect to scrap.tf must be served from cache or skipped, because of R1. Default: Steam CDN only, otherwise a placeholder.
- **Alternatives**, both optional:
  - The user's Steam key: `IEconItems_440/GetSchemaOverview/v0001` plus `GetSchemaItems/v0001` (paged with `start`/`next`, at most 1000 items per page), plus `items_game.txt` and `tf_proto_obj_defs_english.txt` from `raw.githubusercontent.com/SteamDatabase/GameTracking-TF2/master/...` (use the ETag).
  - `schema.autobot.tf` as a resolver fallback only. It has no published policy and returns **v3**-order SKUs.

### 2.10 Steam Web API (optional, user's own key)
- **Used:** schema (2.9 alternative). Optionally `IEconItems_440/GetPlayerItems` for the user's own backpack (only on the user's request), and `IEconService/GetTradeOffersSummary` and `GetTradeHoldDurations` (`key, steamid_target, trade_offer_access_token`) to warn about holds.
- **Auth:** send the key in the `x-webapi-key` header (supported per https://steamapi.xpaw.me/).
- **Rate limiting:** signalled by 429 or `x-eresult` 25/84; back off.
- **Never** call any trade-state-changing endpoint. These are web-session endpoints and the key cannot perform them anyway.

### 2.11 Steam Community Market priceoverview (optional, off by default)
- `GET https://steamcommunity.com/market/priceoverview/?appid=440&currency=1&market_hash_name=<encoded>`. No cookies.
- Response: `{"success":true,"lowest_price":"$2.14","volume":"54,396","median_price":"$2.16"}`, with `Cache-Control: max-age=15`.
- On click only, within the budget in §2.0.
- `market_hash_name` comes from bp.tf `marketName`. For example, unusuals collapse to "Unusual <hat>" with no effect, so SCM values for unusuals are per hat, not per effect. Show that caveat.
- Never call `pricehistory`; it requires cookies.

### 2.12 marketplace.tf (links, plus optional account API)
- **Links:** `https://marketplace.tf/items/tf2/{v3-order sku}`. The canonical tag rewrites to the v3 order; out-of-order SKUs load too.
- **Optional, with the user's own key:** `GET https://marketplace.tf/api/Bans/GetUserBan/v2?key=&steamid=` for the background-check helper. `GET https://marketplace.tf/api/Meta/GetEndpoints/v1` (keyless) is an API health check.
- **Not used:** `GetDeals` (404), item HTML, and `api.backpack.tf/item/get_third_party_prices/...`. That last endpoint is undocumented and not in the spec, even though it responds.

### 2.13 mannco.store (optional, off by default)
- `POST https://api.mannco.store/user/login` with `{apiKey}` returns `content.jwt`. The token lasts about 31 days and is bound to the login IP. Send `Authorization: Bearer <jwt>`.
- `GET /item/pricing/bulk?items=<up to 100 ids>`: fields `lowest_sale_price`, `lowest_buy_order` (documented as the highest buy order; verify), `steam_price`, `suggested_price`, `last_sale`. Integer cents.
- `GET /item/prices?game=440`: at most 1 per 5 minutes per key; we use 1 per hour.
- Keep any cache limited to watched SKUs, because ToS clause (h) bans building a database. Links: use the `url` field from the API; never guess slugs.

### 2.14 STN Trading (optional, off by default)
- `https://api.stntrading.eu/{GetKeyPrices,GetItemDetails,...}/v1?apikey=`. Every endpoint needs a key. Call `GetApiCosts/v1` first and show the credit cost; the `X-Api-Credit-Cost` header reports it.
- `GetItemDetails` returns `pricing.buy` and `pricing.sell` as `{keys, metal}`, plus `stock {level, level_for_quick_buy, limit}`.
- Never call `RequestKeyTrade`, `RequestItemTrade` or `CancelQueueRequest`.
- **Links:** `https://stntrading.eu/item/tf2/<name with spaces as +>`, where name is `[Non-Craftable ][Quality ][Effect ][Australium ][Skin ]Name[ (Wear)]`.

### 2.15 Explicitly not used
- prices.tf and autobot.tf `/json/*` (dead).
- `classifieds/search/v1`. It is legacy, missing from the spec, and polling it as an alerts substitute was forbidden.
- bp.tf v2 listing writes, `/agent/*`, `_`-prefixed paths.
- `get_third_party_prices`.
- marketplace.tf `GetDeals`.
- SteamApis. It is paid, the free tier is only 500 requests per cycle, and a connector can be added later behind its own key.

---

## 3. Acquiring scrap.tf item data

### 3.1 Options

| Option | Ships | Network contact with scrap.tf | Notes |
|---|---|---|---|
| A. Manual quick entry (item and price typed or pasted) | **v1 default** | none | Residual grey area (§1.7); recommend emailing staff |
| B. Price sheet: per-SKU or per-category scrap.tf prices entered by the user | **v1** | none | Lets the engine "constantly check" without touching scrap.tf (§5.6) |
| C. Import of a page the user saved by hand (Ctrl+S, "HTML only") | **v1, disabled behind a permission gate** | none | Content clause; parser shared with D |
| D. Embedded scrap.tf view with passive isolated-world read | **Not built in v1** | the user's own browsing inside our app | Only if written permission explicitly covers it |
| E. Official scrap.tf API | none exists | — | — |
| F. Polling, headless browser, `/ajax/*`, `ws.scrap.tf`, session reuse | **Never** | — | ToS and Cloudflare (R1) |

**Permission gate.** Options C and D can only be enabled after the user fills in Settings → Permissions: grantor name and email, date, scope text, and optionally an attached copy of the permission.

While the gate is closed:
- the import menu item is hidden;
- the parser module is still unit-tested against fixtures.

The UI text must state plainly that, without permission, these modes are outside scrap.tf's rules as written.

### 3.2 Manual quick entry (A)
- **Global hotkey** (default `Ctrl+Alt+F`, user-configurable) opens a small always-on-top window. It has:
  - an item field with autocomplete over schema names, bp.tf names (`bptf_names`) and SKUs, accepting a pasted name or SKU;
  - a price field;
  - an optional category.
- **Accepted price formats** (case-insensitive):

| Input | Scrap |
|---|---|
| `12` (bare number) | ref by default, so 12 ref = 108 scrap (see the ambiguity note below) |
| `1.33`, `1.33 ref` | 12 |
| `14 scrap`, `14s` | 14 |
| `2 keys`, `2k` | 2 × the scrap.tf key price |
| `2 keys 5.11` | keys plus ref |

  Bare integers are ambiguous, so show the parsed value immediately and let the user switch the unit.
- **Stored** as `scrap_prices{sku, price_scrap, source:'user', observed_at, note}`. The entry immediately shows: best clean bp.tf buy order, profit, margin, confidence, and quick links (§4.6).
- **Optional clipboard watcher**, off by default. When enabled, it reads only the user's own clipboard. If the text resolves to an item name or SKU, it pre-fills quick entry; it never submits anything.

### 3.3 Item card DOM reference (for options C and D only)
Sources: the site bundle http://web.archive.org/web/20261011161958/https://scrap.tf/js/bundle.1783460416.js and both userscripts in the user's zips. Logged-in pages were not observed. **M**. Build fixtures from the user's own saved pages before relying on any of this.

**Card selector:** `div.item.hoverable.app440`. The old helper used `.item.hoverable.app440`.

| Data | Where | Parse |
|---|---|---|
| Price | `data-item-value` | integer **scrap**. Do not divide by 9 for storage. Display ref as `floor(s/9) + 0.11*(s%9)`. |
| Quality | class `quality{N}` | `N` = quality id (§4.3) |
| Defindex | `data-defindex` | integer |
| Name | `data-title` (HTML) | strip tags, decode entities; parse modifiers (below) |
| Tooltip | `data-content`, `data-content2` | stripped text; `Level N`; spell or strange-part lines if present (used for special-attribute detection) |
| Unusual effect | `background-image` URL containing `particles_440/{id}_380` (on the card or a child) | `u{id}`, normalised to the lower id of a RED/BLU pair (§4.5) |
| Killstreak tier | class `killstreak1`/`2`/`3` | `kt-1`/`kt-2`/`kt-3` |
| Sheen / killstreaker | class `fx{NNNN}` | meaning not verified; store raw and do not use in the SKU |
| Paint | child `.paintcolor` `background-color` | rgb → hex → RED decimal (§4.5 paint table; map BLU hexes too). `#5885A2` is ambiguous (Team Spirit BLU or Legacy Paint), so flag it. |
| Asset id | `data-id` | for links to `https://backpack.tf/item/{id}` |
| Group | `data-item-group-hash`, `data-num-available`, `data-num-selected`, `.item-group-num-text` | stock count |
| Other | `data-classes`, `data-slot`, `data-appid`, `data-bot` | display only |

**Name modifiers.** Take quality, defindex, effect and killstreak from the structured fields above. Use the name only for the following:
- `Non-Craftable` prefix → `uncraftable`.
- `Strange ` prefix when quality ≠ 11 → elevated strange (`;strange`, quality2 = 11).
- `Festivized ` → `festive`.
- `Australium ` immediately before the weapon name → `australium`. Do not confuse it with the paint "Australium Gold", which is not part of the item title.
- Wear suffix `(Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle Scarred)` → `w1`–`w5`.
- Skin: match the longest paintkit name from `/api/paintkit/list` against the start of the remaining name to get `pk{id}`. "Haunted Ghosts" is a paintkit, not the Haunted quality; NetroScript special-cases it.
- Port NetroScript's name extraction from the user's zip (`scrap.tf-item-information.user.js`) as the reference implementation, then rebuild the SKU in canonical order (§4.2).

**Public `/items` price list** (logged out, but still covered by the content clause). Rows are `tr[data-quality][data-defindex][data-type][data-slot]` with columns "Price to buy", "Price we pay" and "Item Limits" (`n/limit`). Snapshot: http://web.archive.org/web/20261014041145/https://scrap.tf/items. The import parser should recognise this layout as well.

### 3.4 Saved-HTML import (C, permission-gated)
- The user saves a page from their own browser with "HTML only" and opens it through a file dialog. The app never opens URLs found in the file.
- **Parsing** happens in the service process with `parse5`, without executing scripts. Rules:
  - size limit 20 MB;
  - the file is treated as untrusted;
  - no `eval` and no inline-script execution;
  - external references (images, CSS) are never fetched.
- **Output:** `ScrapItem[]` stored as `scrap_prices` with `source:'import'` and `observed_at` = the file's mtime, plus an `import_batches` row.
- Imported prices age out of High confidence after 15 minutes (§5.7).

### 3.5 Embedded passive viewer (D): constraints if it is ever built
It is not in v1. Recorded here so a future implementation stays inside its limits:
- One `WebContentsView` with partition `persist:scraptf`; `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, `webSecurity:true`; **no preload**.
- Leave the default user agent. Never call `setUserAgent`. It will contain `Electron/<ver>` and `TF2FlipDesk/<ver>`, so scrap.tf can see the app.
- Reads happen only on `did-finish-load`, `did-navigate-in-page`, or a user click on "Scan". Use `webContents.executeJavaScriptInIsolatedWorld(1001, [{code}])`; the world id must be at least 1000 and not 999 (https://www.electronjs.org/docs/latest/api/context-bridge).
- The read script is pure: `querySelectorAll` plus attribute reads, returning JSON. No DOM writes, no fetch/XHR, no clicks, scrolls, reloads or `loadURL`, and no `MutationObserver`.
- Navigation is restricted to scrap.tf and Steam OpenID hosts. Any other URL opens in the default browser. All permissions are denied.
- **Known downsides:**
  - Steam credentials would be typed into our app's view. That is poor hygiene and could look like phishing.
  - It is functionally what the moderator ruled out on banking pages.
  - It encourages long sessions, and the 7URXHG report shows long sessions alone can be read as botting.

---

## 4. Item identity

### 4.1 SKU format
The app ships a local, faithful port of `@tf2autobot/tf2-sku` 3.1.0 (https://raw.githubusercontent.com/TF2Autobot/node-tf2-sku/master/index.js, **H**).

Template: `{defindex, quality, craftable:true, tradable:true, killstreak:0, australium:false, effect:null, festive:false, paintkit:null, wear:null, quality2:null, craftnumber:null, crateseries:null, target:null, output:null, outputQuality:null, paint:null}`

| Token | Field |
|---|---|
| `u{n}` | effect |
| `australium` | australium |
| `uncraftable` | craftable = false |
| `untradable` / `untradeable` | tradable = false |
| `w{1-5}` | wear |
| `pk{n}` | paintkit |
| `strange` | quality2 = 11 (elevated strange) |
| `kt-{1-3}` | killstreak |
| `festive` | festive |
| `td-{n}` | target |
| `n{n}` | craftnumber |
| `c{n}` | crateseries |
| `od-{n}` | output |
| `oq-{n}` | outputQuality |
| `p{decimal}` | paint (RED decimal) |

**`fromString`**
- Order-agnostic. Split on `;`; the first two tokens are defindex and quality.
- For each remaining token, remove only the **first** `-`, then test prefixes in this order: `uncraftable`, `untradeable`/`untradable`, `australium`, `festive`, `strange`, `kt`, `u`, `pk`, `w`, `td`, `n`, `c`, `od`, `oq`, `p`. `pk` is tested before `p`.

**`fromObject(item, legacy)`**
- v3 order: `defindex;quality;u;australium;n;c;uncraftable;untradable;w;pk;strange;kt-;festive;td-;od-;oq-;p`
- legacy order: `defindex;quality;u;australium;uncraftable;untradable;w;pk;strange;kt-;td-;festive;n;c;od-;oq-;p`

Examples: `5021;6`, `378;5;u13`, `378;5;u13;strange`, `205;11;australium;kt-3`, `205;11;uncraftable;kt-3;festive`, `1104;15;w1;pk114`, `15000;5;u701;w1;pk14`, `20003;6;kt-3;td-205;od-6526;oq-6`, `378;6;p16738740`, `160;3;n4`, `5041;6;c11` (not `5022;6;c11`).

### 4.2 Canonicalisation and lookup strategy
- **Internal identity:** the parsed object. The DB key is its v3 string; secondary indexes hold the legacy string and a base SKU with paint removed.
- **Per consumer:**
  - marketplace.tf links use v3.
  - pricedb lookups use legacy (exact string match).
  - The display name comes from `bptf_names`, then sku.pricedb.io `name`.
- **pricedb variant chain.** Try each until one hits, and cache which variant worked (`sku_aliases`):
  1. legacy;
  2. v3;
  3. swapped `w`/`pk` order (pricedb holds 179 `pk..;w..` SKUs and 2,988 `w`-first ones);
  4. for strange skins: the 11-primary form `{d};11;w;pk[;kt]`, then `{d};15;w;pk[;kt];strange` (the stale fallback). From 0.7.1 the saved-page parser itself emits the 11-primary form for a strange skin without an effect (`15000;11;w2;pk14`, whatever quality class scrap.tf gives the card), and (from 0.7.4) `{d};5;u{e};w;pk;strange` for an unusual strange skin (`{d};5;u{e};w;pk` when not strange), so imported prices already match the buyers' SKUs (ARCHITECTURE, "0.7.1 round", P2, and the "0.7.4 round", unusual skins);
  5. for crates: a defindex alias (5022 ↔ 5041 and similar) from the schema.
- **Defindex aliases:** use the `defindex[]` array from IGetPrices (stock vs upgradeable, crate defindexes) to build `defindex_aliases`. Matching treats aliases as equal.
- **"The" prefix:** schema items with `proper_name:true` map "The X" and "X" to the same defindex. bp.tf names include "The" inconsistently ("The Festivized Huntsman" vs "Strange Festivized ..."), so **never synthesise bp.tf names** when a learned name exists.
- **Currency SKUs:** `5000;6`, `5001;6`, `5002;6` and `5021;6` are excluded from profit scanning.
- **Quality 255** (two pricedb rows): ignore it.
- Keep SKU handling behind an interface. TF2-Price-DB is drafting a successor identifier called "HAT".

### 4.3 Qualities, wears, killstreaks, sheens, killstreakers (H)

**Qualities**

| Id | Quality |
|---|---|
| 0 | Normal |
| 1 | Genuine |
| 3 | Vintage |
| 5 | Unusual |
| 6 | Unique |
| 7 | Community |
| 8 | Valve |
| 9 | Self-Made |
| 10 | Customized |
| 11 | Strange |
| 12 | Completed |
| 13 | Haunted |
| 14 | Collector's |
| 15 | Decorated Weapon |

Ids 2 and 4 are unused.

**Wear:** w1 Factory New, w2 Minimal Wear, w3 Field-Tested, w4 Well-Worn, w5 Battle Scarred.

**Killstreak tiers:** kt-1 Killstreak, kt-2 Specialized Killstreak, kt-3 Professional Killstreak.

**Sheens** (not part of the SKU): 1 Team Shine, 2 Deadly Daffodil, 3 Manndarin, 4 Mean Green, 5 Agonizing Emerald, 6 Villainous Violet, 7 Hot Rod.

**Killstreakers** (not part of the SKU): 2002 Fire Horns, 2003 Cerebral Discharge, 2004 Tornado, 2005 Flames, 2006 Singularity, 2007 Incinerator, 2008 Hypno-Beam.

**Conventions**
- Strange Unusual: quality 5 plus `strange`.
- Strange Australium: quality 11 plus `australium`.
- Unusual skins: quality 5 plus u701 Hot, u702 Isotope, u703 Cool or u704 Energy Orb, and `strange` (quality2) for a strange one (`15000;5;u701;w1;pk14;strange`), the form backpack.tf's buy orders use. (Until 0.7.4 this said quality 15 plus the effect, which no live order matched: ARCHITECTURE deviation 12.)
- War Paint items: defindex 16000 + paintkit, quality 15 (strange war paints are quality 11).

### 4.4 Building a SKU from backpack.tf structured fields

| SKU field | Websocket (v2) item | Snapshot (v1) item |
|---|---|---|
| defindex | `item.defindex` | `item.defindex` |
| quality | `item.quality.id` | `item.quality` |
| effect | `item.particle?.id`, normalised to the lower id of a pair | attribute 134 `float_value` (2041 for taunts) |
| australium | `item.australium === true` | attribute 2027 |
| craftable / tradable | `item.craftable !== false`, `item.tradable !== false` | flags or `Non-Craftable` in name |
| wear | `item.wearTier?.id` † | attribute 725 (float → tier: verify bands from fixtures) |
| paintkit | `item.texture?.id` † | attribute 834 |
| quality2 | `item.elevatedQuality?.id === 11` †; fallback: `name` starts with `Strange ` and quality ≠ 11 | attribute 214 present while quality ≠ 11 |
| killstreak | `item.killstreakTier` (number or `{id}` †) | attribute 2025 |
| festive | `item.festivized === true` | attribute 2053 |
| crateseries | `item.crateSeries` | attribute 187 |
| target / output | `item.recipe` †, else parse `priceindex` | attribute 2012 |

† = field name or shape unverified; confirm from captured fixtures before release. Cross-check every computed SKU against `item.priceindex` where present.

**Special attributes**, used for matching (§5.2) and not part of the base SKU: paint (142, and BLU 261 per TF2 schema conventions, verify), spells (1004–1009), strange parts (379–388), sheen (2014), killstreaker (2013), custom name and description.

### 4.5 Effects and paints
- **Effects:** load from `raw.schema.attribute_controlled_attached_particles` (671 entries) or `/api/effect/list` (590). Never hardcode them.
  - Hide placeholder `Attrib_Particle###` entries (ids such as 55, 140, 146, 176, 184, 406, and 22001–22008).
  - Ids 2001–2008 are killstreaker eye glows, not unusual effects.
  - When two ids share a name (RED/BLU pairs), map to the **lower** id. Examples: Searing Stove → 360, Crystal Crown → 365.
  - Ranges as of 2026-10-14: cosmetic 1–428, weapon 701–704, taunt 3001–3242. Scream Fortress XVIII added cosmetic 416–428 and taunt 3230–3242 on 2026-10-01; pricedb has no prices yet for ids above 3223.
- **Paints.** The `p` token uses the RED decimal (https://sku.pricedb.io/api/paint/list, **H**):

```
3100495 #2F4F4F A Color Similar to Slate        8208497 #7D4071 A Deep Commitment to Purple
1315860 #141414 A Distinctive Lack of Hue        12377523 #BCDDB3 A Mann's Mint
2960676 #2D2D24 After Eight                      8289918 #7E7E7E Aged Moustache Grey
6637376 #654740 An Air of Debonair               15132390 #E6E6E6 An Extraordinary Abundance of Tinge
15185211 #E7B53B Australium Gold                 3874595 #3B1F23 Balaclavas Are Forever
14204632 #D8BED8 Color No. 216-190-216            12807213 #C36C2D Cream Spirit
15308410 #E9967A Dark Salmon Injustice           8421376 #808000 Drably Olive
7511618 #729E42 Indubitably Green                5801378 #5885A2 Legacy Paint (ambiguous hex)
13595446 #CF7336 Mann Co. Orange                 10843461 #A57545 Muskelmannbraun
5322826 #51384A Noble Hatter's Violet            4732984 #483838 Operator's Overalls
12955537 #C5AF91 Peculiarly Drab Tincture        16738740 #FF69B4 Pink as Hell
6901050 #694D3A Radigan Conagher Brown           12073019 #B8383B Team Spirit
3329330 #32CD32 The Bitter Taste of Defeat and Lime   15787660 #F0E68C The Color of a Gentlemann's Business Pants
8400928 #803020 The Value of Teamwork            11049612 #A89A8C Waterlogged Lab Coat
8154199 #7C6C57 Ye Olde Rustic Colour            4345659 #424F3B Zepheniah's Greed
```

Team paints also have BLU hexes; load them from the schema or the wiki and map them to the RED decimal.

### 4.6 Link generator (rebuild of scrap.tf-item-information)
This runs entirely in the app and needs no scrap.tf access. Input is an item name, SKU, pasted text or a row from any table. The app shows a link menu, and `shell.openExternal` opens a link only on the user's click, after the URL passes an https host allowlist.

| Target | URL |
|---|---|
| bp.tf stats | `https://next.backpack.tf/stats?item={encoded base name}&quality={q}` plus optional `&priceindex={effect}`, `&craftable=0`, `&killstreakTier={n}&sheen=-1&killstreaker=-1`, `&wearTier={Wear Name}&texture={Skin Name}` (this is the pattern marketplace.tf's own BackpackTF button uses, **H**) |
| bp.tf item history | `https://backpack.tf/item/{assetid}`, only when an asset id is known |
| bp.tf classifieds and premium search | port NetroScript's templates (including the "Accurate" variants) from the user's zip, fed from the parsed SKU |
| marketplace.tf | `https://marketplace.tf/items/tf2/{v3 sku}` |
| SCM | `https://steamcommunity.com/market/listings/440/{encodeURIComponent(marketName)}` |
| STN | `https://stntrading.eu/item/tf2/{name with + for spaces}` (§2.14) |
| PriceDB graph | `https://pricedb.io/api/graph/{sku}` |
| mannco | API `url` field only, when the user has supplied a key |
| scrap.tf bank page | the static page for the item's category (`https://scrap.tf/buy/{hats,weapons,stranges,killstreaks,skins,items}` or `https://scrap.tf/unusuals`), no query; opened in the user's own browser so they can check stock and price. The app never fetches it (R1). |

The menu also offers "Copy SKU", "Copy name" and "Copy bp.tf name" through `navigator.clipboard` in the dashboard. Electron 44 removed the `clipboard` module from renderers.

---

## 5. Profit model

### 5.1 Units and conversions
- All money is stored as **integer scrap**. Keys are separate integers.
- ref → scrap: `Math.round(ref * 9)`. This is safe for values truncated to 2 decimals: 1.33 → 12, 64.33 → 579, 29.66 → 267.
  > **Correction (2026-10-22, RESEARCH §4.2):** not safe for every live value. In the 2026-10-14 feed capture (`test/fixtures/bptf/ws-sample.json`), 6 of 293 metal values are half-scrap amounts (4.5, 4.05, 16.38, 18.83, 42.16, 57.05), 5 of them on multi-key buy orders. `Math.round(ref*9)` rounds 4.5 up (40.5 → 41) and the other five down, an error of at most half a scrap per value. 0.9 keeps integer-scrap maths (half-scrap units, RESEARCH #20, are deferred).
- scrap → ref display: `Math.floor(s/9) + 0.11*(s%9)`, formatted to 2 decimals.
- keys plus metal → scrap: `keys * K + Math.round(metal*9)`, where K is the key value in scrap for that context (§5.3).

### 5.2 Clean buy-order matching
A bp.tf listing L is eligible for item X only if **all** of the following hold:
1. `intent == 'buy'`, `appid == 440`, and the listing is not deleted.
2. Base SKU equality: defindex (via aliases), quality, effect, australium, craftable, tradable, wear, paintkit, quality2, killstreak tier, festive, crateseries and target/output all match X.
3. Not a marketplace.tf listing: no `currencies.usd` and no `marketplace_*` item fields.
4. The buyer is not banned (`user.banned`, `bans`, or bp.tf/marketplace.tf ban checks when available) and not on the user's blocklist.
5. **Special attributes.**
   - If L's item specifies paint, spells, strange parts, sheen, killstreaker or a custom name or description, L matches only if X has exactly that attribute. If X's attribute is unknown (manual entry), the listing is shown as "attribute-specific" and excluded from profit.
   - A generic order (none of those attributes) matches any clean X.
   - A painted or spelled X can still sell into a generic order. Mark such matches "X has extras": generic orders legally cover any clean item, but you may be underselling.
6. **Notes keywords** (configurable, case-insensitive, whole words, NFKD-normalised). `details` matching `\b(paint(ed)?|spell(ed)?|parts?|only|dupe(d)?|clean only|no dupes)\b` is flagged, not excluded, and lowers confidence.

Deduplicate by `(steamid, base SKU, intent)` and keep the newest.

### 5.3 Key price
- **Revenue key value K_rev**, used to value keys you receive from bp.tf buyers. Priority order:
  1. bp.tf `IGetCurrencies` value (buy side);
  2. pricedb `5021;6` `buy.metal`;
  3. user override.

  On 2026-10-14: pricedb buy 63.11 ref = 568 scrap. Conservative default: `min(source, scrap.tf key sell price if entered)`.
- **scrap.tf key prices** (buy and sell) are always user-entered, with the date shown. Example: 616 / 580 scrap on 2026-10-14. These are used only to display scrap.tf costs in keys.
- Show every key price with its source and age. Mark a source stale after 6 h.
- The old helper's hardcoded `KEY_PRICE = 54.49` is removed. It was 13–25% too low.

### 5.4 Fees and exit venues
- **bp.tf buy orders** are the default exit: no platform fee, item-for-pure.
- **scrap.tf:** no fee documented.
- **Other exits**, shown as secondary columns when enabled:

| Venue | Net to seller | Notes |
|---|---|---|
| SCM | `price / 1.15` (5% Steam + 10% TF2 fee, each at least $0.01) | Proceeds are Steam Wallet funds, not cash. $1,800 listing cap, $2,000 wallet cap. https://help.steampowered.com/en/faqs/view/61F0-72B7-9A18-C70B |
| marketplace.tf | 90% | Cash out at 1:1 USD |
| mannco | about 95% | Unverified; some sources say 92% |
| STN | spread is built into its buy/sell prices | — |

> **Correction (2026-10-22, RESEARCH §4.4):** mannco's documentation now states the fee: the seller receives the sale price minus a 5% fee, "rounded in the seller's favor", with a minimum fee of 1 cent except on 1-cent items, and its bulk-pricing guide makes no distinction between instant and listed sales (https://docs.mannco.store/api-reference/deposit/instant-sell.md, https://docs.mannco.store/api-reference/inventory/bulk-pricing.md). So the mannco row is 95% rounded up; 92% is not supported. From 0.9 mannco.store is a journal venue with that fee hint, and break-even prices name it.

- Optional user setting "friction per trade" in scrap (default 0) for the time and trade-hold cost.

### 5.5 Outliers and the conservative price
For each X, sort the eligible orders by value: v1 ≥ v2 ≥ …

- `ref = median(v1..v_min(5,n))`
- `v1` is an **outlier** if any of these hold:
  - n ≥ 3 and v1 > 1.30 × ref;
  - pricedb `sell` exists and v1 > 1.50 × pricedb sell;
  - the IGetPrices `value_high` exists and v1 > 1.50 × that value.
- **Best** = v1. **Conservative** = the first non-outlier order.
- **Instant** = the best non-outlier order whose `source === 'userAgent'` (a bot, likely to auto-accept). That `userAgent` means "bot" is a heuristic: marketplace.tf listings can carry one too.

> **Correction (2026-10-22, RESEARCH §4.2):** `source` is the weaker signal. In the 2026-10-14 capture, 294 live events carried `source: "userAgent"`, but only 253 carried a `userAgent` object (`{client, lastPulse}`). Flip Desk defines a bot, and so Instant, by that object (`isBot` in `src/service/connectors/bptfItem.ts`), as §5.7's +20 row does with `userAgent.lastPulse`. From 0.9 the drawer also names the bot service the client reports (`OrderSummary.botService`), as a label only.

Profit uses Conservative by default. Best and Instant are shown alongside.

### 5.6 Calculation and the "constant check" engine
- **Profit:** `profit = revenue(order) − cost_scrap − friction`, and `margin = profit / cost_scrap`.
- **Inputs to the engine** (all user-originated):
  - per-SKU `scrap_prices`, from manual entry or a gated import;
  - **price-sheet rules**, e.g. "Unique cosmetics I've seen on scrap.tf at 16 scrap", or "Strange weapons at X". A rule has `{filter: quality, slot/type, killstreak, craftable…, price_scrap, observed_at}`.

  KB 41 says scrap.tf bots pay a flat rate per hat type when buying. Whether scrap.tf's sell prices are also flat per type is unverified, so rules are the user's own observations.
- **Trigger:** on every relevant `listing-update`/`delete`, and every 60 s for rule sweeps. The engine evaluates:
  - every SKU with an explicit price;
  - every SKU in the bp.tf book matched by a rule.

  It writes `opportunities` (upserted by `sku` plus input source) and appends `opportunity_events`: `appeared`, `changed`, `gone`, `notified`.
- **Thresholds** (defaults, all configurable per category):
  - minimum profit = `max(9 scrap, ceil(0.05 × cost_scrap))`;
  - minimum margin = 8%;
  - notify only at confidence Medium or higher;
  - de-duplicate notifications per SKU for 30 min.
- **Grouping in the UI**
  - Category: Hats/cosmetics, Weapons/items, Stranges, Killstreaks, Skins, Unusuals, Taunts, Other.
  - Profit tier: ≥ 1 key, 10 ref–1 key, 2–10 ref, < 2 ref.
  - Confidence.
  - Input source: user, rule or import.
- **Rule matches** appear as "Candidates to look for on scrap.tf". The app cannot know scrap.tf's stock, so the user checks it by hand.

### 5.7 Confidence score (0–100)
Start at 50, then apply:

| Condition | Adjustment |
|---|---|
| Best conservative order is a bot (`source=='userAgent'`) with `userAgent.lastPulse` ≤ 30 min | +20 |
| Buyer `online === true` | +5 |
| Order last confirmed (event or snapshot) ≤ 2 h | +10 |
| Order unverified for > 24 h | −15 |
| ≥ 2 distinct buyers within 10% of conservative | +10 |
| Conservative within 0.8–1.2 × pricedb buy, or bp.tf community price | +10 |
| Conservative > 1.5 × either reference | −20 |
| No reference price | −10 |
| scrap.tf price age ≤ 15 min | 0 |
| scrap.tf price age 15 min – 2 h | −10 |
| scrap.tf price age > 2 h, or a rule-based estimate | −25 |
| Notes keyword flag, or "X has extras" | −10 |
| Unusual with revenue > 10 keys (Steam Scam FAQ risk of manipulated, reversible items) | −15, plus a warning icon |
| Banned, blocklisted or marketplace.tf | excluded |

Clamp to 0–100. **High** ≥ 70, **Medium** 45–69, **Low** < 45.

> **Correction (2026-10-22, RESEARCH §4.2):** `user.online` carries no signal on the feed: it was true on all 299 live events of the 2026-10-14 capture. From 0.7.4 the +5 needed an event within 2 h (ARCHITECTURE deviation 11). 0.9 no longer adds it for feed rows (RESEARCH #11), and `notifications.minConfidence` stays 45.

### 5.8 Trade safety helpers
These are informational only; the app never blocks or accepts anything.
- If estimated value exceeds 15 keys, prompt for a background check: bp.tf bans via `users/info` and marketplace.tf `GetUserBan/v2`. Do not rely on SteamRep, which has closed.
- Hold warnings:
  - Mobile Authenticator active for under 7 days → up to 15-day holds.
  - A recent password change or new device → trading lock (scrap.tf help cites 7–15 days).
  - If Valve extends Trade Protection to TF2, flips become locked for 7 days; there is a settings flag for this.
    > **Correction (2026-10-22):** no such flag existed before 0.9 (RESEARCH §1.2). From 0.9 it is Settings → Trade lock (see the §1.5 correction); it changes Holdings (advice, Sellable now, "Sell:" timing), not opportunities.
- Remind the user to check https://steamcommunity.com/dev/apikey for keys they don't recognise.
- Show a VPN warning (scrap.tf KB 166; the mannco JWT is IP-bound).

### 5.9 Journal (FIFO P/L)
- Manual trade log: buy and sell rows with venue, SKU, price, and keys/metal.
- FIFO matching of sells to buys gives realised profit in scrap, ref and keys.
- CSV export. This is the TF2TradeLogger pattern, minus its committed `.env`.

---

## 6. Lessons from existing tools

**Copy these**

| Source | Idea |
|---|---|
| TF2-Price-DB/bliss-autopricer, `websocket/bptfWebSocket.js` (last commit 2025-12-06) | Websocket local order book; backoff 1–30 s; 120 s silence watchdog; IGetPrices cache of 7200 s |
| Albert12302/tf2-arbitrage-dashboard (2026-09-10) | A single writer process owns the socket; a read-only table sorted by margin |
| jack-richards/bptf-autopricer (archived 2025-08-03) | Hygiene filters: userAgent presence, paint and spell exclusion, steamid block and trust lists, dedupe by steamid+sku+intent, outlier removal. Its `handleEvent` paint check references an undefined `name`; do not copy that bug. |
| TF2Autobot/node-bptf-listings (2026-10-08) | 429 handling order: body `retry_after_ms`, then `retry_after`, then the `Retry-After` header, then an "in N second" message, then 61 s; at least 1 s spacing |
| TF2Autobot pricedb socket manager | Exponential reconnect. We do **not** stop permanently after 5 attempts, and we do not copy its buggy `getBulkPrices`, which sends a raw array with GET. |
| mwesterham/tf2-auto-profit (2025-02-10) | Never contacts scrap.tf; trades are manual |
| offish/tf2-arbitrage README | Explicitly excludes scrap.tf "due to their ToS"; a useful precedent |
| NetroScript/scrap.tf-item-information v0.1.13 (2026-04-06) | Link templates and name parsing. Fix its non-canonical SKU order. It downloads the schema only when a defindex is missing and at most every 24 h; we use ETag. |
| AkkayaKaan/TF2TradeLogger | FIFO profit and export |
| @tf2autobot/tf2-sku 3.1.0 | Port it exactly, including the legacy option |

**Avoid these.** Each one is a ban or ToS risk.

| Source | Problem |
|---|---|
| VeBeshka/tf2-scraptf-profit-helper (`user.js` line 26 `KEY_PRICE = 54.49`; around line 454 bp.tf classifieds HTML, `BP_PAGES_TO_CHECK=6`, `PARALLEL_CHECKS=3`, `AUTO_CHECK_DELAY=120`, GM_xmlhttpRequest with the user's cookies) | Page scraping under the user's account; a stale key price; injection into banking pages |
| Raffle bots (nj-neer, Bonfire/Scraffle, PredatorIWD, Lemirda/ScrapTF2, Dalarcsis, which claims to avoid detection) | Explicitly bannable |
| Greasy Fork "Scrap.tf Full Auto-Accept Trade" | Banking automation; SSA §4.B |
| tomaszjagielka/ScrapyPy and ScrapyNode | Scrape `scrap.tf/items` with a browser-imitating UA; claim auto-trading; depend on prices.tf |
| Preport/getBackpackTFListings | Advertises getting around bp.tf API limits |
| mninc/pytf `bypass_cf` | Cloudflare bypass; it also scraped marketplace.tf HTML |
| juliarose/marketplacetf-api | Hardcoded Chrome UA |
| offish/tf2-arbitrage | Cookie replay to "imitate" internal API requests |
| TF2Autobot/node-bptf-login | Automated Steam login, then HTML key scraping |
| node-bptf-listings `PROXY_CONFIG` | Proxy support |
| Anything that calls prices.tf | Dead |
| offish/tf2-utils `get_third_party_prices` | Undocumented endpoint |
| Any read-only tool calling `/agent/pulse` | Flags the account as a bot and bumps its listings |
| Opening more than one bp.tf websocket per IP | Triggers `client-limit-exceeeded` |

---

## 7. Desktop stack and security

### 7.1 Stack (pin exact versions; each version at least two weeks old)
- **Electron 44.7.2** (Chromium 152, Node 24.21.0, released 2026-10-14). Move to 45.x after it goes stable (scheduled 2026-10-20) and has had a few patch releases. 42.x reaches end of life on 2026-10-20. Build win-x64 only: Electron 44 dropped ia32.
- **electron-builder 26.15.3** with an NSIS installer. TypeScript throughout.
- **Electron 42+ note:** the Electron binary now downloads on first run of the `electron` bin, and `ELECTRON_SKIP_BINARY_DOWNLOAD` no longer works. Plan CI caching for this.
- **Storage:** `node:sqlite` in the service process. It is a release candidate in Node 24.15+, so no ExperimentalWarning. It should be compiled into Electron (PR #47706). **Verify at startup**: `require('node:sqlite')` and log `process.versions`. Fallback: `better-sqlite3`, which needs a native rebuild.
- **Libraries:** `ws` (bp.tf socket, custom headers), `socket.io-client` v4 (pricedb), `zod` (validates every external payload; counts unknown fields), `parse5` (gated import only), React plus Vite for the dashboard, and a virtualised table library.
- **Processes**
  - **Main:** windows, tray, notifications, IPC, the `app://` protocol, settings and secrets via `safeStorage`.
  - **Service:** `utilityProcess.fork`. It holds all connectors, rate limiters, SQLite, the opportunity engine and the request log, and talks to main over `MessagePort`.
  - **Renderer:** dashboard UI only. It makes no network calls.
- **Why not the alternatives**
  - Tauri v2 needs Rust and MSVC, which are not installed, and its eval documents no isolated world.
  - .NET 10 with WebView2 runs scripts in the page's main world, needs CDP for isolation, and needs extra tray and toast plumbing.
  - A separate local Node service adds a second runtime and a localhost attack surface. The system Node 24.11 also prints the SQLite ExperimentalWarning.
  - v1 has no embedded scrap.tf view (§3), so Electron is chosen for its tray and notification support, Node runtime and UI, not for webview tricks.

### 7.2 Background behaviour
- `app.setAppUserModelId('<appId>')` is the first line of main; the appId never changes after release. Then `app.requestSingleInstanceLock()`.
- **Tray** context menu: Show dashboard / Quick entry / Pause live feed / Pause all network / Quit. Closing the window minimises to the tray. Pass a Tray GUID only once the exe is code-signed.
- **Start at login** is optional: `setLoginItemSettings({openAtLogin:true, args:['--hidden']})`; check `process.argv`, because `openAsHidden` was removed.
- **Notifications** use the main-process `Notification`. Verify that the NSIS Start Menu shortcut has an AUMID; toasts depend on it.
- **"Pause all network"** is a global kill switch.

### 7.3 Security checklist
1. Dashboard loads from a custom `app://` scheme via `protocol.handle`. No `file://`, no localhost server.
2. All renderers: `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, `webSecurity:true`; no `allowRunningInsecureContent`, no experimental or Blink features.
3. Minimal preload. `contextBridge` exposes a narrow, typed API (`getOpportunities`, `submitQuickEntry`, `openLink(id)`, …) and never raw `ipcRenderer`.
4. Main validates `event.senderFrame.url` (`app://`) on every IPC message and validates payloads with zod.
5. Dashboard CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://steamcdn-a.akamaihd.net https://community.cloudflare.steamstatic.com data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. Adjust the image hosts to what Steam's CDN actually serves.
6. `will-navigate` is prevented, `setWindowOpenHandler` returns `{action:'deny'}`, and permission request and check handlers deny everything.
7. `shell.openExternal` is used only from main, only for URLs built by the link generator, and only for https hosts on the allowlist (backpack.tf, next.backpack.tf, marketplace.tf, steamcommunity.com, stntrading.eu, pricedb.io, mannco.store). Steam's `steamcommunity.com/linkfilter/` redirector is refused. The only exception is a fixed list of exact URLs (no other path, query or fragment on those hosts): the platform terms and attribution links of §7.5.8 (scrap.tf/terms, the Steam Subscriber Agreement, the two GitHub repositories) and the static scrap.tf bank pages the item menu offers per category.
8. Fuses via electron-builder `electronFuses`:
   - `runAsNode=false`
   - `enableNodeOptionsEnvironmentVariable=false`
   - `enableNodeCliInspectArguments=false`
   - `enableEmbeddedAsarIntegrityValidation=true`
   - `onlyLoadAppFromAsar=true`
   - `grantFileProtocolExtraPrivileges=false`
   - `enableCookieEncryption=true` from the first release, because this setting is one-way.
9. Secrets (bp.tf key and token; optional Steam, marketplace.tf, mannco and STN keys) are encrypted with `safeStorage.encryptString`. They are never stored in config JSON, never logged, and redacted in the request log. Each is sent only to its issuing host.
10. No local HTTP or WebSocket server. If one is ever added:
    - bind to `127.0.0.1` on a random port;
    - accept only an exact `Host` of `127.0.0.1:PORT` or `localhost:PORT`;
    - check `Origin` against an exact allowlist and return 403 on mismatch;
    - require a per-launch 256-bit token in a header (never in a URL), compared in constant time;
    - check WS `Origin` in the `upgrade` handler before `handleUpgrade`;
    - authenticate WebSockets in the first message.
11. Gated HTML import: parse5, no script execution, size limit, no fetching of referenced resources.
12. Third-party data minimisation: never persist `tradeOfferUrl` or trade tokens; store other users' steamids only on listing rows; purge after 14 days.
13. Code signing, needed for SmartScreen, tray GUID and integrity checks. Auto-update only through signed releases.
14. Publish a privacy policy page in-app. The Steam Web API Terms require one if nonpublic user data is handled; the app handles the user's own inventory only on request.
15. Ship pinned dependencies with a lockfile. Run `npm audit` in CI. Stay on a supported Electron major.

### 7.4 SQLite schema (minimum)

```sql
listings(id TEXT PK, sku TEXT, base_sku TEXT, intent TEXT, steamid TEXT, keys INT, metal_scrap INT,
         value_scrap_at_ingest INT, source TEXT, ua_client TEXT, ua_last_pulse INT, user_online INT, user_banned INT,
         special_attrs TEXT /*json*/, details TEXT, listed_at INT, bumped_at INT, last_event_at INT, origin TEXT /*ws|snapshot*/)
  INDEX(base_sku, intent), INDEX(last_event_at)
bptf_names(sku TEXT PK, name TEXT, market_name TEXT, last_seen INT)
sku_aliases(sku TEXT, pricedb_sku TEXT, PRIMARY KEY(sku))
pricedb_prices(sku TEXT PK, name TEXT, buy_keys INT, buy_scrap INT, sell_keys INT, sell_scrap INT, time INT, fetched_at INT)
bptf_community(sku TEXT PK, currency TEXT, value REAL, value_high REAL, last_update INT)
key_prices(source TEXT PK, buy_scrap INT, sell_scrap INT, observed_at INT)
scrap_prices(id INTEGER PK, sku TEXT, price_scrap INT, source TEXT /*user|import*/, observed_at INT, note TEXT, import_batch INT)
price_rules(id INTEGER PK, filter_json TEXT, price_scrap INT, observed_at INT, enabled INT)
opportunities(sku TEXT, input_ref TEXT, cost_scrap INT, best_scrap INT, cons_scrap INT, instant_scrap INT,
              profit_scrap INT, margin REAL, confidence INT, flags TEXT, updated_at INT, PRIMARY KEY(sku,input_ref))
opportunity_events(id INTEGER PK, sku TEXT, kind TEXT, payload TEXT, ts INT)
journal(id INTEGER PK, ts INT, side TEXT, venue TEXT, sku TEXT, keys INT, scrap INT, note TEXT)
schema_items(defindex INT PK, name TEXT, proper_name INT, item_class TEXT, slot TEXT)
effects(id INT PK, name TEXT, canonical_id INT, type TEXT)
paints(decimal INT PK, hex TEXT, name TEXT, blu_hex TEXT)
paintkits(id INT PK, name TEXT)
request_log(id INTEGER PK, ts INT, host TEXT, path TEXT, status INT, ms INT, bytes INT)
permissions(id INTEGER PK, grantor TEXT, contact TEXT, granted_at TEXT, scope TEXT, evidence_path TEXT)
```

### 7.5 UI screens
1. **Opportunities**: grouped and filterable; columns for profit, margin, confidence, instant/conservative/best, buyer type, ages; links.
2. **Item view**: bp.tf book (buy and sell), pricedb and community prices, a history graph from `item-history` drawn in-app, links.
3. **Quick entry**: hotkey window.
4. **Price sheet**: per-SKU entries and category rules.
5. **Journal**: trade log with FIFO profit and CSV export.
6. **Data health**: connection states, per-host budgets and the request log, source ages, endpoint status (snapshot available or not).
7. **Settings**: keys and tokens with a test button, thresholds, key-price sources, live-feed data cap, optional connectors, contact URL for the UA, permissions.
8. **Rules & attribution**: the §1 summary, links to each platform's terms, and "Prices by PriceDB.io" / "Data from backpack.tf".

---

## 8. Open uncertainties and how the app handles them

| Uncertainty | Handling |
|---|---|
| Content of scrap.tf's login-gated Community Rules | The first-run checklist asks the user to read them at https://scrap.tf/rules while logged in. Ship nothing that depends on them. |
| Whether scrap.tf treats a manual-entry desktop tool as an "external tool" | Default mode A, with in-app disclosure. Appendix C email template. Record any reply under Permissions. |
| scrap.tf DOM attribute names and meanings (`fx` classes, effect URL, craftability marker) | Gated parser only. Build fixtures from the user's own saved pages. Version the parser; when the "unparsed attribute" count is high, warn and do not guess. |
| Whether scrap.tf sells hats at flat per-type prices (KB 41 covers buying) | Price-sheet rules are user observations, labelled "estimate". Rule-based candidates are capped at Medium confidence. |
| Current bp.tf API ToS wording (latest capture 2025-03-26) and rules | Link the pages in Settings and ask the user to confirm. Every base URL and budget is configurable in `config.json` with safe defaults; the app refuses budgets above the defaults in §2.0 unless an "advanced" flag is set. |
| Snapshot rate limit and possible removal | Adaptive limiter with a 10 s minimum, honouring Retry-After. On 404 or 410, disable it and fall back to websocket-only, with a banner. |
| bp.tf websocket payload drift and `batch-test` | zod schemas with `.passthrough()`; accept an array or an object; count parse failures and unknown fields on Data health; store a small rolling sample of raw frames (redacted) for debugging. |
| Websocket bandwidth of about 8–12 GB/day | Live-feed toggle, daily cap, pause on metered networks, ingest buy listings only for non-watched SKUs. |
| `IGetCurrencies` shape (array vs object) | Defensive parse (§2.4); fall back to pricedb. |
| Whether IGetPrices still allows only one call per 300 s | Our 2 h cadence is far below both limits. |
| pricedb staleness and coverage gaps | Show the age of every price. Grey out prices older than 30 days. Show "no reliable price" for newer effects and unusual skins. Never treat pricedb as the exit price; bp.tf buy orders are. |
| SKU order disagreements across services | Parse locally; variant chain with an alias cache (§4.2). |
| Websocket field names marked † | Confirm from fixtures before release; fall back to `priceindex` and name heuristics. |
| Whether `userAgent` means "bot" | Used only as a confidence signal, never as a hard filter. |
| SSA §4.C coverage of read-only Web API calls | Steam connectors off by default; user-initiated; 5,000 calls/day cap. |
| SCM market name for unusuals | Show the caveat. SCM is never used for unusual profit. |
| mannco fee (5% vs 8%) and `lowest_buy_order` meaning; STN credit costs | Both connectors off by default. Fees configurable. Check field semantics against a live response when the user enables the connector. |
| Valve extending Trade Protection to TF2 | Settings flag that adds a 7-day lock warning to every opportunity. |
| Electron 44/45 `node:sqlite` availability | Startup self-test with the `better-sqlite3` fallback path. |
| Shared enforcement across scrap.tf, bp.tf and marketplace.tf | Treat them as one risk domain: the same conservative budgets everywhere, no alternate accounts, VPN warning. |

> **Corrections (2026-10-22):** the mannco fee is settled at 5% (see the §5.4 correction). Trade Protection's TF2 scope is contested (see the §1.5 correction); 0.9's Trade lock setting applies to Holdings, not to every opportunity.

---

## Appendix A: default config (excerpt)

```json
{
  "network": {
    "userAgent": "TF2FlipDesk/{version} (+{contactUrl})",
    "bptf": { "base": "https://api.backpack.tf/api", "ws": "wss://ws.backpack.tf/events",
              "snapshotMinIntervalMs": 10000, "snapshotMaxPerHour": 300,
              "igetpricesIntervalMs": 7200000, "currenciesIntervalMs": 3600000, "appContext": "440" },
    "pricedb": { "base": "https://pricedb.io/api", "socket": "https://ws.pricedb.io", "maxPerMinute": 60 },
    "sku": { "base": "https://sku.pricedb.io/api", "schemaMaxAgeMs": 86400000, "maxPerMinute": 30 },
    "steam": { "enabled": false, "dailyCap": 5000 },
    "scm": { "enabled": false, "minIntervalMs": 5000, "cacheMs": 3600000, "lockoutMs": 21600000 },
    "mannco": { "enabled": false }, "stn": { "enabled": false }, "mptf": { "enabled": false },
    "liveFeed": { "enabled": true, "dailyCapBytes": 12000000000, "pauseOnMetered": true }
  },
  "profit": { "minProfitScrap": 9, "minProfitPctOfCost": 0.05, "minMargin": 0.08,
              "notifyMinConfidence": 45, "notifyDedupMs": 1800000, "frictionScrap": 0,
              "outlierVsMedian": 1.30, "outlierVsRef": 1.50, "unusualRiskKeys": 10 },
  "scraptf": { "importEnabled": false, "embeddedViewEnabled": false }
}
```

## Appendix B: compliance tests (CI must pass)
1. The HTTP client rejects `https://scrap.tf/...`, `wss://ws.scrap.tf`, `https://backpack.tf/classifieds?...`, `https://marketplace.tf/items/...`, `https://stntrading.eu/...` and `https://mannco.store/...`.
2. No code path sets a browser-like `User-Agent`, and no proxy option exists.
3. No code calls `/agent/`, `/v2/classifieds/listings` with POST, PATCH or DELETE, or any `/_` path.
4. Secrets never appear in `request_log` or application logs, verified with a fuzz test that seeds a known token.
5. With the permission gate closed, the import menu is absent.
6. The SKU port passes the upstream tf2-sku test vectors plus the examples in §4.1.

## Appendix C: permission request (user sends it themselves, from their own email)

To admin@scrap.tf. Subject: "Question about a personal price-tracking tool and the ToS".

Body points:
- I use a personal desktop tool that never connects to scrap.tf.
- I type in prices I see on scrap.tf, and the tool compares them with backpack.tf buy orders from backpack.tf's official API.
- Is this acceptable under the ToS?
- Would you permit importing pages I save myself, for personal use only?
- I will follow whatever you decide.

> **Correction (2026-10-22):** from 0.7 (F21) Flip Desk can show scrap.tf in a window the user browses, so "never connects to scrap.tf" no longer holds. From 0.9 the email (Import page and About → Unsupported by scrap.tf; `PERMISSION_TEMPLATE` in `src/renderer/aboutModel.ts`) says "never sends requests to scrap.tf on its own" and asks three more questions: (1) is a read-only, user-driven window acceptable; (2) how long do a queue reservation, a bot's trade offer and the missed-offer lockout last; (3) is there a sanctioned feed, export or device key for item data that a personal tool may use.

Do not send it from inside the app; the user sends it.