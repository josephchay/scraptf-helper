# PriceDB / sku.pricedb.io fixtures

Captured live on 2026-10-14 with `User-Agent: TF2FlipDesk/0.1.0 (+fixture-capture)`, sequentially and
1.5 to 2 s apart (about 70 requests in total, plus one 25 s socket connection). Nothing here came from
scrap.tf. The responses contain no secrets, cookies or trade URLs; `response-headers.json` keeps only the
rate-limit, caching and content headers.

## Files

| File | Source | Trimming |
|---|---|---|
| `schema-subset.json` | `GET https://sku.pricedb.io/api/schema` | 301 of 11,606 items (hats, stock + upgradeable weapons, every australium-able weapon, skins, war paints, taunts, crates, keys, metal, kits, fabricators, chemistry sets, all 29 paint cans, items whose names start with an effect name, plus a deterministic sample). All 671 particles, all 250 paintkits and the qualities are kept. Item descriptions, styles and large image URLs are dropped. `raw.items_game.items` keeps only `name`, `prefab`, `tags`, `static_attrs`, `attributes` of the same items. |
| `effect-list.json`, `paint-list.json`, `paintkit-list.json`, `quality-list.json`, `wear-list.json` | `GET https://sku.pricedb.io/api/{effect,paint,paintkit,quality,wear}/list` | none |
| `sku-lookups.json` | 10 x `GET /api/sku/{sku}`, 8 x `GET /api/name/{name}` | none |
| `golden-names.json` | 32 x `GET /api/sku/{sku}` | `{status, name, sku}` only |
| `item-key.json`, `item-378.json`, `item-unusual.json`, `item-australium.json`, `item-404.json` | `GET https://pricedb.io/api/item/{sku}` | none |
| `items-bulk.json` | `POST https://pricedb.io/api/items-bulk` with 10 SKUs | none |
| `item-history-key.json` | `GET /api/item-history/5021;6` | last 40 of 284 points |
| `item-history-australium.json` | `GET /api/item-history/205;11;australium` | last 25 of 82 points |
| `autob-items.json` | `GET https://pricedb.io/api/autob/items` | 303 of 52,251 rows (rows of the subset's defindexes, at most 3-8 per defindex, special forms kept) |
| `response-headers.json` | headers of every capture | rate-limit / cache / content headers only |

The full schema (21.3 MB) and the full `/autob/items` (8.4 MB) were saved to the OS temp directory only.

## Confirmed facts

### sku.pricedb.io

- `/api/schema`: 21,328,477 bytes decompressed, `content-encoding: br`, `cache-control: max-age=7200`, weak ETag
  (`W/"145733a-..."`), served from the Cloudflare cache (`age` 1651). `version` 4.5.4. Top level
  `{version, time, raw: {schema, items_game}}`; `raw.schema` has `qualities`, `qualityNames`, `originNames`,
  `attributes` (843), `item_sets`, `attribute_controlled_attached_particles` (671, sorted by id), `item_levels`,
  `kill_eater_score_types`, `string_lookups`, `items` (11,606, sorted by defindex), `paintkits` (250, id -> name).
- No `RateLimit-*` headers on sku.pricedb.io responses.
- Particles: ids 1-428 cosmetic, 701-704 weapon, 2001-2008 killstreak eyes, 3001-3242 taunt, 22001-22008.
  22 are `Attrib_Particle*` placeholders (55, 140, 146, 176, 184, 406, 2001-2008, 22001-22008). 81 names occur
  twice (RED/BLU twins, e.g. Searing Stove 360/361, Showstopper 3001/3002). `/api/effect/list` returns 590
  entries = 671 minus those 81 duplicates (placeholders included).
- `item_quality` is not 6 for 471 items: 0 (36 stock weapons), 3 (1), 5 (2: 266, 267), 11 (1: 655), 15 (322 skins
  and war paints), 255 (109). `SchemaItemRow` cannot hold it, so the schema service stores it in repo meta
  `schema.extras.v1` together with crate series and skin paintkits.
- 941 item names are shared by several defindexes (stock vs `Upgradeable ...`, skin-specific 15xxx copies,
  three "Mann Co. Supply Crate" items, Name Tag 2093/5020, ...).
- The schema's `set supply crate series` attribute is 82 / 83 / 77 for the Mann Co. Supply Crates 5022 / 5041 /
  5045, which is wrong for naming; the series -> defindex lists from node-tf2-schema are used instead.
- `items_game.items[d].static_attrs.paintkit_proto_def_index` exists for 374 items (15xxx skin weapons and war
  paints) and maps skin-specific defindexes to paintkits (15000 -> 14 Night Owl).
- Team paint BLU tints are on the paint can items as `set item tint RGB 2`: Team Spirit 12073019 / BLU 5801378
  (#5885A2, the same colour as "Legacy Paint"), Operator's Overalls 4732984 / 3686984, Waterlogged Lab Coat
  11049612 / 8626083, Balaclavas Are Forever 3874595 / 1581885, An Air of Debonair 6637376 / 2636109, The Value of
  Teamwork 8400928 / 2452877, Cream Spirit 12807213 / 12091445.
- `/api/paint/list`: `{success, data: [{id: RED decimal, name}]}`, 30 paints including Legacy Paint, no hex.
- `/api/sku/{sku}`: `{success, data: {sku, name, ...SkuObject}}`. Names follow node-tf2-schema `getName` with
  `proper = true` ("The Team Captain", "The War Paint (Field-Tested)") and **without** the `(e)` elevated marker
  ("15000;15;w1;pk14;strange" -> "Strange Night Owl Sniper Rifle (Factory New)").
- `/api/name/{name}` returns the legacy-order SKU (`Festivized Specialized Killstreak Huntsman` -> `56;6;kt-2;festive`).

### pricedb.io

- Every response, 404 included, carries `RateLimit-Policy: 360;w=60`, `RateLimit-Limit: 360`,
  `RateLimit-Remaining` and `RateLimit-Reset` (seconds until the window resets, e.g. `60`).
- `/api/item/{sku}`: a bare record `{name, sku, source:"bptf", time, buy:{keys, metal}, sell:{keys, metal}}`.
  Unknown and unpriced SKUs: HTTP 404 `{"error":"Item not found"}` (also for `15000;15;u701;w1;pk14`, an
  unusual skin).
- `POST /api/items-bulk` with `{"skus":[...]}`: a **bare array**, not in request order; unknown SKUs are dropped
  (`999999;6` and `200;6;uncraftable` were missing from the answer).
- `/api/item-history/{sku}`: a bare array of records, oldest first. Key history (no start/end) has 284 points
  from 2025-09-25 to 2026-10-14: weekly at first, every 900 s recently (median gap 900 s).
- `/api/autob/items`: `{success: true, currency: "metal", items: [...]}`, 52,251 rows, 8,389,941 bytes,
  `cache-control: max-age=14400`. All `source` values are `bptf`. Highest effect u3223. 179 SKUs put `pk` before
  `w`, 2,990 put `w` first; some skins exist in both forms. Strange skins exist as `{d};11;w;pk` and as the
  stale `{d};15;w;pk;strange`. Two quality-255 rows. No Strange Unusual (`5;...;strange`), no u701-704 and no
  painted SKUs.
- Names in PriceDB are backpack.tf style and differ from sku.pricedb.io: no "The" ("Team Captain", "Big Kill"),
  "Killstreak Non-Craftable Ham Shank", single-series crates without "#N" ("Scorched Crate"), unusual-only items
  without "Unusual" ("Haunted Metal Scrap"), and keyless cases keep a newline inside the name.
- Key on 2026-10-14: buy 63.22 ref (569 scrap), sell 64.55 ref (581 scrap) via `/api/item`; the bulk list had
  63.11 / 64.44 a few minutes earlier.

### ws.pricedb.io

- socket.io-client 4.8.4 with `transports: ['websocket']`, `extraHeaders: {'User-Agent': ...}` and
  `reconnection: false` connected in about 1 s over the websocket transport. No event of any kind arrived in
  25 s (the brief saw none in 45 s), so silence is normal.
