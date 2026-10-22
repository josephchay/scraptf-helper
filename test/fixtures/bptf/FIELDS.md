# backpack.tf websocket payload: observed field shapes

Source: one read-only connection to `wss://ws.backpack.tf/events` on 2026-10-14 (09:12 UTC, 24 s,
User-Agent `TF2FlipDesk/0.1.0 (+fixture-capture)`, permessage-deflate negotiated). 17 frames,
1,556 events, 3.55 MB decompressed. Every frame was a JSON **array** of `{id, event, payload}`
(no `batch-test` header was sent). `ws-sample.json` holds 300 of these events (sanitised) plus 12
clearly marked synthetic variants for shapes that did not occur in the window.

This resolves the fields marked † in DESIGN_BRIEF §4.4. Counts are out of 1,556 events.

## Envelope

| Field | Shape |
|---|---|
| `id` | 24-hex ObjectId; first 4 bytes = Unix **seconds** (matched capture time) |
| `event` | `listing-update` (1,465) or `listing-delete` (91). No limit events were seen. |
| `payload.appid` | number, always 440 here |
| `payload.status` | `"active"` on both updates and deletes |
| `payload.source` | `"userAgent"` (1,551), `"user"` (4), `"steam"` (1) |
| `payload.deal` | only on some deletes: `{percent, value}` |

## Listing ids (verified on every event)

- Sell: `440_<assetid>`, and `item.id === <assetid>` (159/159).
- Buy: `440_<steamid>_<md5(item.name)>` (1,397/1,397). The hash input is the exact bp.tf full
  name, so a user has at most one buy order per full name; painted/spelled variants share it.
  Buy items have `item.id === ""`.

## Timestamps

All **Unix seconds**: `listedAt`, `bumpedAt`, `userAgent.lastPulse`, `item.price.community.updatedAt`.
`listedAt` can be later than `bumpedAt` (an edit updates `listedAt`).

## Price and user

- `currencies`: `{metal}` (368), `{keys, metal}` (1,166), `{keys}` (22). Metal is refined with 2
  decimals. **No `currencies.usd` in this window** (no marketplace.tf mirrors seen); see synthetic.
- `value`: `{raw, short, long}`; `raw` is total refined.
- `userAgent`: `{client, lastPulse}`; present on 1,421 events, absent when `source` is `user`/`steam`.
- `user`: `{id, name, avatar, avatarFull, premium, online, banned, customNameStyle, class, style,
  role, tradeOfferUrl, bans}` (+ `flagImpersonated` once). `bans` was always `[]`.
  **`tradeOfferUrl` carries a trade token and is removed from the fixture; the mapper never reads it.**

## Item fields

| Field | Observed shape | Notes |
|---|---|---|
| `defindex` | number | |
| `quality` | `{id, name, color}` | always an object |
| `elevatedQuality` † | `{id, name, color}` | 1 event: Collector's (14) + Strange (11). There is no `quality2` field. |
| `particle` † | `{id, name, shortName, imageUrl, type}` | `type` is `"standard"` (344) or `"taunt"` (393), not "cosmetic"; weapon effects not seen. Only on quality 5 here. |
| `priceindex` | string | 831 events; equals `particle.id` (737), `crateSeries` (5), or a recipe code (89) |
| `killstreakTier` † | number 1-3 | 182 events. **Missing on some Professional Kit Fabricator sell listings** whose name says "Professional Killstreak"; fall back to the name. |
| `sheen` † | `{id, name}` | ids 1-7 |
| `killstreaker` † | `{id, name}` | ids 2002-2008 |
| `paint` † | `{id, name, color}` | `id` = paint can defindex (e.g. 5052), `color` = lower-case RED hex `#2f4f4f`. On the paint can itself (`id === defindex`) it is not an applied paint. |
| `paintSecondaryHex` | string `#rrggbb` | present with paint (BLU hex for team paints, else equal to `color`) |
| `spells` † | `[{id, spellId, name, type}]` | e.g. `{id:"weapon-SPELL: Halloween death ghosts", spellId:"SPELL: Halloween death ghosts", name:"Exorcism", type:"weapon"}` |
| `strangeParts` † | `[{score, killEater:{id, name, item:{...defindex 60xx...}}}]` | `killEater.name` e.g. "Headshot Kills" (id 21) |
| `killEaters` | `[{score, killEater:{name, id?}}]` | the item's own counters (Kills, Points Scored); not parts |
| `wearTier` † | `{id, name, short}` | `{id:1, name:"Factory New", short:"FN"}` |
| `texture` † | `{id, itemDefindex, rarity:{id,name,color}, name}` | `id` = paintkit; war paints use defindex `itemDefindex` (e.g. 17415 = pk415) |
| `rarity` | `{id, name, color}` | with textures |
| `crateSeries` † | number | equals `priceindex` |
| `recipe` † | `{estimatedCraftingCost, inputItems, outputItem, targetItem}` | `outputItem` is a full item doc (`defindex`, `quality{}`) or null. `targetItem` is `{itemName, imageUrl, _source}` with `_source.defindex` (schema doc); **no top-level defindex**. |
| `festivized` | boolean | only present when true |
| `australium` | boolean | only present when true |
| `craftable` | boolean | **present only when true. Non-craftable items omit the field** (78/78 had names starting "Non-Craftable"). `item.craftable !== false` (§4.4) is therefore wrong. |
| `tradable` | boolean | always `true` here |
| `customName`, `customDesc` | string | the text itself |
| `craftNumber`, `craftedBy`, `giftedBy`, `level`, `origin`, `style`, `equipped`, `tag`, `class`, `slot` | various | not used for the SKU |
| `name` | string | bp.tf full name, e.g. "Cloudy Moon Tyrant's Helm", "Non-Craftable Professional Killstreak Scattergun Kit", "The Birdie Bonnet" |
| `marketName` | string | e.g. "Unusual Tyrant's Helm"; drops "Non-Craftable" |
| `baseName` | string | "Tyrant's Helm", "Kit", "Fabricator", "War Paint" |
| `price` | `{steam?, community?, suggested?}` or `[]` | dropped by the mapper |

## priceindex codes

| Item | Example | Meaning |
|---|---|---|
| Unusual | `"38"` | effect id (raw, not canonicalised) |
| Crate | `"99"` | crate series |
| Killstreak Kit (6526) | `"3-200"` | killstreak tier - target defindex |
| Kit Fabricator (20003) | `"6526-6-466"` | output defindex - output quality - target defindex |
| Chemistry set (swagger) | `"1086-14"` | output defindex - output quality |
| Strangifier/Unusualifier (swagger) | `"46"` | target defindex |

## Names that start with "Strange" but are not elevated

"Strange Bacon Grease" (a hat, quality 6) and "Strange Part: ..." (tools, quality 6). The name
fallback for `quality2` must check that the base name does not already start with "Strange".

## Not observed in this window (covered by `synthetic`)

marketplace.tf mirrors (`currencies.usd`, `marketplace_*`), Decorated Weapon skins (quality 15),
weapon unusual effects (701-704), Strange Unusual / Strange Genuine, RED/BLU effect pairs,
untradable items, non-440 appids, millisecond timestamps, `killstreakTier` as an object.

Unusual skins (0.7.4, F08/F43/F69): backpack.tf's live buy orders key a skin with a weapon effect as
Unusual (quality 5) plus the effect, with Strange as `quality2` (`15000;5;u701;w1;pk14;strange`), not
Decorated (15) plus the effect. The `synthetic-unusual-skin` payload keeps the Decorated `quality` it was
written with; the mappers (`canonicalUnusualSkin`) give it the Unusual form, as they do the feed's
11-primary form (`quality` 11 with the effect).
