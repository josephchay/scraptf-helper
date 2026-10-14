// ==UserScript==
// @name         TF2 ScrapTF Profit Helper
// @namespace    https://github.com/VeBeshka/tf2-scraptf-profit-helper
// @version      1.2
// @author       VeBeshka
// @description  Scrap.tf profit checker with Backpack.tf buy order comparison
// @icon         https://raw.githubusercontent.com/VeBeshka/tf2-scraptf-profit-helper/main/icon.png

// @match        https://scrap.tf/buy/hats*
// @match        https://scrap.tf/buy/items*
// @match        https://scrap.tf/buy/stranges*
// @match        https://scrap.tf/buy/skins*
// @match        https://scrap.tf/buy/killstreaks*
// @match        https://scrap.tf/unusuals/*

// @grant        GM_xmlhttpRequest
// @connect      backpack.tf

// @downloadURL  https://raw.githubusercontent.com/VeBeshka/tf2-scraptf-profit-helper/main/tf2-scraptf-profit-helper.user.js
// @updateURL    https://raw.githubusercontent.com/VeBeshka/tf2-scraptf-profit-helper/main/tf2-scraptf-profit-helper.user.js
// ==/UserScript==

(function () {
    'use strict';

    const KEY_PRICE = 54.49;
    const CHECKED_CLASS = 'vbp-initialized';
    const CACHE_KEY = 'vbp_bp_price_cache_v23';
    const CACHE_TTL = 30 * 60 * 1000;

    const AUTO_CHECK_DELAY = 120;
    const BP_PAGES_TO_CHECK = 6;
    const PARALLEL_CHECKS = 3;

    [
        'vbp_bp_price_cache_v1',
        'vbp_bp_price_cache_v2',
        'vbp_bp_price_cache_v3',
        'vbp_bp_price_cache_v4',
        'vbp_bp_price_cache_v5',
        'vbp_bp_price_cache_v6',
        'vbp_bp_price_cache_v7',
        'vbp_bp_price_cache_v8',
        'vbp_bp_price_cache_v9',
        'vbp_bp_price_cache_v20',
        'vbp_bp_price_cache_v21',
        'vbp_bp_price_cache_v22'
    ].forEach(k => localStorage.removeItem(k));

    const QUALITY_MAP = {
        0: 'Normal',
        1: 'Genuine',
        3: 'Vintage',
        5: 'Unusual',
        6: 'Unique',
        11: 'Strange',
        13: 'Haunted',
        14: "Collector's",
        15: 'Decorated Weapon'
    };

    const QUALITY_PREFIXES = [
        'Genuine',
        'Vintage',
        'Unusual',
        'Unique',
        'Strange',
        'Haunted',
        "Collector's",
        'Decorated Weapon',
        'Normal'
    ];

    const UNUSUAL_EFFECTS = {
        'green confetti': 6,
        'purple confetti': 7,
        'haunted ghosts': 8,
        'green energy': 9,
        'purple energy': 10,
        'circling tf logo': 11,
        'massed flies': 12,
        'burning flames': 13,
        'scorching flames': 14,
        'searing plasma': 15,
        'vivid plasma': 16,
        'sunbeams': 17,
        'circling peace sign': 18,
        'circling heart': 19,
        'map stamps': 20,
        'genteel smoke': 28,
        'stormy storm': 29,
        'blizzardy storm': 30,
        'nuts n bolts': 31,
        'orbiting planets': 32,
        'orbiting fire': 33,
        'bubbling': 34,
        'smoking': 35,
        'steaming': 36,
        'flaming lantern': 37,
        'cloudy moon': 38,
        'cauldron bubbles': 39,
        'eerie orbiting fire': 40,
        'knifestorm': 43,
        'misty skull': 44,
        'harvest moon': 45,
        "it's a secret to everybody": 46,
        'stormy 13th hour': 47,
        'aces high': 59,
        'kill-a-watt': 60,
        'terror-watt': 61,
        'cloud 9': 62,
        'a time bomb': 70,
        'green black hole': 71,
        'roboactive': 72,
        'arcana': 73,
        'spellbound': 74,
        'chiroptera venenata': 75,
        'poisoned shadows': 76,
        'something burning this way comes': 77,
        'hellfire': 78,
        'darkblaze': 79,
        'demonflame': 80,
        'bonzo the all-gnawing': 81,
        'amaranthine': 82,
        'stare from beyond': 83,
        'the ooze': 84,
        'ghastly ghost': 85,
        'haunted phantasm': 86,
        'frostbite': 87,
        'molten mallard': 88,
        'morning glory': 89,
        'death at dusk': 90,
        'abduction': 91,
        'atomic': 92,
        'subatomic': 93,
        'electric hat protector': 94,
        'magnetic hat protector': 95,
        'voltaic hat protector': 96,
        'galactic codex': 97,
        'ancient codex': 98,
        'nebula': 99,
        'death by disco': 100,
        'phosphorous': 101,
        'sulphurous': 102,
        'memory leak': 103,
        'overclocked': 104,
        'electrostatic': 105,
        'power surge': 106,
        'anti-freeze': 107,
        'time warp': 108,
        'green ray': 109,
        'green sunbeams': 110,
        'frosted star': 111,
        'hellish inferno': 112,
        'burning red': 113,
        'red lightning': 114,
        'sinister lightning': 115,
        'hellfire storm': 116,
        'tornado': 117,
        'flaming tornado': 118,
        'green gibus': 119,
        'scorching flames circling peace sign': 120,
        'phosphorous burning flames': 121,
        'spooky storm': 122,
        'spellbound aspect': 123,
        'static mist': 124,
        'ether trail': 125,
        'nether trail': 126,
        'ancient eldritch': 127,
        'eldritch flame': 128,
        'neutron star': 129,
        'starstorm slumber': 130,
        'starstorm insomnia': 131,
        'volcanic eruption': 132,
        'tesla coil': 133,
        'stardust': 134,
        'starry orbit': 135,
        'sulphurous smoke': 136,
        'phosphorous smoke': 137,
        'green tornado': 138,
        'green energy orb': 139,
        'roboactive orb': 140,
        'time warp orb': 141,
        'arcana orb': 142,
        'burning flames orb': 143,
        'scorching flames orb': 144
    };

    let autoQueue = [];
    let autoRunning = false;

    function ref(n) {
        return Number(n).toFixed(2);
    }

    function formatRefWithKeys(value) {
        const keys = Math.floor(value / KEY_PRICE);
        const metal = value - keys * KEY_PRICE;

        if (keys <= 0) return `${ref(value)} ref`;

        return `${keys} key${keys === 1 ? '' : 's'} ${ref(metal)} ref`;
    }

    function normalizeName(name) {
        return String(name || '')
            .toLowerCase()
            .replace(/^the\s+/, '')
            .replace(/^unique\s+/, '')
            .replace(/^strange\s+/, '')
            .replace(/^genuine\s+/, '')
            .replace(/^vintage\s+/, '')
            .replace(/^haunted\s+/, '')
            .replace(/^unusual\s+/, '')
            .replace(/^collector's\s+/, '')
            .replace(/^festivized\s+/, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function escapeRegExp(text) {
        return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function cleanName(rawHtml) {
        const div = document.createElement('div');
        div.innerHTML = rawHtml || '';
        return div.textContent.trim();
    }

    function getQualityId(item) {
        for (const cls of item.classList) {
            const match = cls.match(/^quality(\d+)$/);
            if (match) return Number(match[1]);
        }

        return 6;
    }

    function getQualityName(item) {
        return QUALITY_MAP[getQualityId(item)] || 'Unique';
    }

    function getQualityIdFromName(name) {
        for (const [id, q] of Object.entries(QUALITY_MAP)) {
            if (q === name) return id;
        }

        return 6;
    }

    function getUnusualEffectName(item) {
        const rawName = cleanName(item.dataset.title).toLowerCase();
        const content = String(item.dataset.content || '').toLowerCase();

        const effects = Object.keys(UNUSUAL_EFFECTS).sort((a, b) => b.length - a.length);

        for (const effect of effects) {
            if (rawName.startsWith(effect + ' ')) return effect;
        }

        for (const effect of effects) {
            if (content.includes(effect)) return effect;
        }

        return null;
    }

    function stripQualityAndEffectPrefix(name) {
        let out = String(name || '').trim();

        for (const q of QUALITY_PREFIXES) {
            out = out.replace(new RegExp(`^${escapeRegExp(q)}\\s+`, 'i'), '');
        }

        out = out.replace(/^Festivized\s+/i, '');

        const effects = Object.keys(UNUSUAL_EFFECTS).sort((a, b) => b.length - a.length);

        for (const effect of effects) {
            out = out.replace(new RegExp(`^${escapeRegExp(effect)}\\s+`, 'i'), '');
        }

        return out.trim();
    }

    function isFestivizedScrapItem(item) {
        const text = String(`${item.dataset.content || ''} ${item.dataset.title || ''}`).toLowerCase();
        return text.includes('festivized');
    }

    function getItemInfo(item) {
        const rawName = cleanName(item.dataset.title);
        const quality = getQualityName(item);
        const qualityId = getQualityId(item);
        const festivized = isFestivizedScrapItem(item);
        const effectName = quality === 'Unusual' ? getUnusualEffectName(item) : null;
        const effectId = effectName ? UNUSUAL_EFFECTS[effectName] : null;
        const baseName = stripQualityAndEffectPrefix(rawName);

        return {
            rawName,
            quality,
            qualityId,
            baseName,
            festivized,
            effectName,
            effectId,
            cacheKey: `${quality}:${normalizeName(baseName)}:${festivized ? 'festivized' : 'normal'}:${effectId || 'noeffect'}`
        };
    }    function makeBackpackStatsUrl(info) {
        const quality = encodeURIComponent(info.quality);
        const item = encodeURIComponent(info.baseName);

        if (info.quality === 'Unusual' && info.effectId) {
            return `https://backpack.tf/stats/${quality}/${item}/Tradable/Craftable/${info.effectId}`;
        }

        return `https://backpack.tf/stats/${quality}/${item}/Tradable/Craftable`;
    }

    function loadCache() {
        try {
            return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
        } catch {
            return {};
        }
    }

    function saveCache(cache) {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    }

    function getCached(info) {
        const cache = loadCache();
        const entry = cache[info.cacheKey];

        if (!entry) return null;

        if (Date.now() - entry.time > CACHE_TTL) {
            delete cache[info.cacheKey];
            saveCache(cache);
            return null;
        }

        return entry;
    }

    function setCached(info, data) {
        const cache = loadCache();

        cache[info.cacheKey] = {
            ...data,
            time: Date.now()
        };

        saveCache(cache);
    }

    function scrapPriceFromItem(item) {
        const value = Number(item.dataset.itemValue || 0);
        if (value > 0) return value / 9;

        const text = item.querySelector('.item-value-indicator')?.textContent || '';

        const refMatch = text.match(/([\d.]+)\s*refined/i);
        if (refMatch) return Number(refMatch[1]);

        const keyMatch = text.match(/([\d.]+)\s*key/i);
        if (keyMatch) return Number(keyMatch[1]) * KEY_PRICE;

        return null;
    }

    function parsePriceToRef(text) {
        text = String(text || '')
            .toLowerCase()
            .replace(/,/g, '.')
            .replace(/\s+/g, ' ')
            .trim();

        let total = 0;

        const keyMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:keys|key)/);
        const refMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:ref|refined|metal)/);

        if (keyMatch) total += Number(keyMatch[1]) * KEY_PRICE;
        if (refMatch) total += Number(refMatch[1]);

        return total > 0 ? total : null;
    }

    function isCleanBuyOrder(listingElement) {
        const fullText = String(listingElement?.textContent || '').toLowerCase();

       const bad = [
    'painted',
    'painted hats',
    'painted items',

    'black ',
    'pink ',
    'lime ',
    'white ',
    'purple ',
    'gold ',
    'after eight',
    'team spirit',
    'australium gold',

    'spell',
    'spelled',
    'footprints',
    'parts attached',
    'strange part',

    'cash',
    'paypal',
    'usd',

    'listed price',
    'c/c',

    'buy any effect',
    'any effect',
    'depending on price',
    'can buy any',
    'buying any',
    'paying more than anyone',
    'price depends',
    'negotiable',

    'inventory',
    'backpacks',
    'human',

    'clean mint',
    'only mint'
];

        if (bad.some(word => fullText.includes(word))) return false;

        if (/\b(lvl|level)\s*\d{1,3}\b/i.test(fullText)) return false;
        if (/\b\d{1,3}\s*(lvl|level)\b/i.test(fullText)) return false;

        return true;
    }

    function makeClassifiedsUrl(info, page = 1) {
        const item = encodeURIComponent(info.baseName);
        const qualityId = getQualityIdFromName(info.quality);
        const festivizedValue = info.festivized ? 1 : -1;

        let url = `https://backpack.tf/classifieds?page=${page}&item=${item}&quality=${qualityId}&tradable=1&craftable=1&australium=-1&killstreak_tier=0&festivized=${festivizedValue}`;

        if (info.quality === 'Unusual' && info.effectId) {
            url += `&particle=${info.effectId}`;
        }

        return url;
    }

    function fetchUrl(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                timeout: 15000,
                onload: res => resolve(res.responseText),
                onerror: reject,
                ontimeout: reject
            });
        });
    }

    function priceLooksReasonable(price, scrapPrice, info) {
        if (price === null) return false;
        if (price <= 0) return false;

        if (info.quality === 'Unusual') {
            if (price > scrapPrice + 80) return false;
            if (price < 1) return false;
            return true;
        }

        if (price > 300) return false;
        if (scrapPrice < 5 && price > 8) return false;
        if (scrapPrice < 10 && price > 20) return false;
        if (price > scrapPrice * 3 && price > scrapPrice + 5) return false;
        if (price > scrapPrice + 25) return false;

        return true;
    }

    function getCleanBuyOrdersFromHtml(html, info, scrapPrice) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const cleanPrices = [];
        const targetName = normalizeName(info.baseName);

        const buyItems = [...doc.querySelectorAll('.listing .item[data-listing_intent="buy"]')];

        for (const item of buyItems) {
            const itemQuality = Number(item.dataset.quality || item.getAttribute('data-quality') || 6);
            if (itemQuality !== info.qualityId) continue;

            if (info.quality !== 'Unusual') {
                const isPainted =
                    item.dataset.paint_price ||
                    item.dataset.paint_hex ||
                    item.querySelector('.paint');

                if (isPainted) continue;
            }

            const listingRoot = item.closest('.listing') || item.parentElement;
            const listingText = String(listingRoot?.textContent || '').toLowerCase();

            if (info.quality === 'Unusual' && info.effectName) {
                if (!listingText.includes(info.effectName)) continue;
            }

            const bpIsFestivized = listingText.includes('festivized');

            if (info.festivized && !bpIsFestivized) continue;
            if (!info.festivized && bpIsFestivized) continue;

            const name = normalizeName(
                item.dataset.name ||
                item.dataset.base_name ||
                item.getAttribute('data-name') ||
                item.getAttribute('data-original-title') ||
                ''
            );

            if (name !== targetName) continue;

            const priceText = item.dataset.listing_price || '';
            if (!priceText) continue;

            if (info.quality !== 'Unusual') {
                if (!isCleanBuyOrder(listingRoot)) continue;
            }

            const price = parsePriceToRef(priceText);
            if (!priceLooksReasonable(price, scrapPrice, info)) continue;

            cleanPrices.push(price);
        }

        return cleanPrices;
    }

    async function findBestCleanBuyOrder(info, scrapPrice) {
        const allPrices = [];

        for (let page = 1; page <= BP_PAGES_TO_CHECK; page++) {
            const url = makeClassifiedsUrl(info, page);
            const html = await fetchUrl(url);
            const prices = getCleanBuyOrdersFromHtml(html, info, scrapPrice);

            allPrices.push(...prices);

            if (prices.length > 0) break;

            await new Promise(r => setTimeout(r, 100));
        }

        if (!allPrices.length) return null;

        return Math.max(...allPrices);
    }

    function makeBadge(item) {
        let badge = item.querySelector('.vbp-profit-box');

        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'vbp-profit-box';
            badge.style.cssText = `
                position:absolute;
                left:2px;
                right:2px;
                bottom:2px;
                z-index:20;
                background:rgba(0,0,0,.84);
                color:#fff;
                font-size:10px;
                line-height:12px;
                padding:2px;
                text-align:center;
                border-radius:3px;
                pointer-events:auto;
                font-weight:bold;
            `;
            item.style.position = 'relative';
            item.appendChild(badge);
        }

        return badge;
    }

    function setCardState(item, state) {
        if (state === 'profit') {
            item.style.outline = '2px solid #00ff66';
            item.style.boxShadow = '0 0 8px rgba(0,255,102,.45)';
            return;
        }

        if (state === 'loss') {
            item.style.outline = '2px solid #ff5555';
            item.style.boxShadow = '0 0 8px rgba(255,85,85,.35)';
            return;
        }

        if (state === 'unknown') {
            item.style.outline = '2px solid #ffcc00';
            item.style.boxShadow = '0 0 8px rgba(255,204,0,.35)';
            return;
        }

        item.style.outline = '';
        item.style.boxShadow = '';
    }

    function renderResult(item, scrapPrice, bpBuy, info, fromCache = false) {
        const badge = makeBadge(item);

        if (bpBuy === null) {
            badge.innerHTML = `NO BUY`;
            badge.style.color = '#ffcc00';
            setCardState(item, 'unknown');
            return;
        }

        const profit = bpBuy - scrapPrice;
        const good = profit >= 0;

        badge.innerHTML = `
            BP: ${formatRefWithKeys(bpBuy)}<br>
            ${good ? '+' : ''}${ref(profit)} ref
            ${fromCache ? '<span style="font-size:9px;color:#aaa;"> cached</span>' : ''}
        `;

        badge.title =
            `${info.quality}${info.effectName ? ' ' + info.effectName : ''}${info.festivized ? ' Festivized' : ''} ${info.baseName}\n` +
            `BP buy: ${formatRefWithKeys(bpBuy)}\n` +
            `Scrap: ${formatRefWithKeys(scrapPrice)}\n` +
            `Profit: ${ref(profit)} ref`;

        badge.style.color = good ? '#00ff66' : '#ff5555';
        setCardState(item, good ? 'profit' : 'loss');
    }

    async function checkItem(item, force = false) {
        const badge = makeBadge(item);
        const info = getItemInfo(item);
        const scrapPrice = scrapPriceFromItem(item);

        if (!info.baseName || scrapPrice === null) {
            badge.textContent = 'NO DATA';
            badge.style.color = '#ff5555';
            setCardState(item, 'unknown');
            return;
        }

        if (!force) {
            const cached = getCached(info);
            if (cached) {
                renderResult(item, scrapPrice, cached.bpBuy, info, true);
                return;
            }
        }

        badge.textContent = 'CHECK...';
        badge.style.color = '#ffffff';
        setCardState(item, null);

        try {
            const bpBuy = await findBestCleanBuyOrder(info, scrapPrice);

            setCached(info, { bpBuy });
            renderResult(item, scrapPrice, bpBuy, info, false);

        } catch (e) {
            console.error('[VBP] BP check failed', e);
            badge.textContent = 'ERROR';
            badge.style.color = '#ff5555';
            setCardState(item, 'unknown');
        }
    }

    function createButton(item) {
        if (item.querySelector('.vbp-check-bp')) return;

        const btn = document.createElement('button');
        btn.className = 'vbp-check-bp';
        btn.textContent = 'BP';
        btn.title = 'Force check Backpack.tf price';
        btn.style.cssText = `
            position:absolute;
            top:2px;
            left:2px;
            z-index:30;
            font-size:10px;
            padding:1px 4px;
            background:#111;
            color:#fff;
            border:1px solid #888;
            border-radius:3px;
            cursor:pointer;
        `;

        btn.onclick = e => {
            e.preventDefault();
            e.stopPropagation();

            const info = getItemInfo(item);
            const cache = loadCache();
            delete cache[info.cacheKey];
            saveCache(cache);

            item.dataset.vbpQueued = '0';
            checkItem(item, true);
        };

        item.appendChild(btn);
    }

    function createOpenBackpackButton(item) {
        if (item.querySelector('.vbp-open-bp')) return;

        const btn = document.createElement('button');
        btn.className = 'vbp-open-bp';
        btn.textContent = '↗';
        btn.title = 'Open on Backpack.tf';
        btn.style.cssText = `
            position:absolute;
            top:2px;
            right:2px;
            z-index:31;
            font-size:10px;
            width:20px;
            height:18px;
            padding:0;
            background:#111;
            color:#fff;
            border:1px solid #8b5cf6;
            border-radius:3px;
            cursor:pointer;
            font-weight:bold;
        `;

        btn.onclick = e => {
            e.preventDefault();
            e.stopPropagation();

            const info = getItemInfo(item);
            const url = makeBackpackStatsUrl(info);

            window.open(url, '_blank', 'noopener,noreferrer');
        };

        item.appendChild(btn);
    }

    function isVisible(el) {
        const rect = el.getBoundingClientRect();

        return (
            rect.bottom > 0 &&
            rect.top < window.innerHeight &&
            rect.right > 0 &&
            rect.left < window.innerWidth
        );
    }

    function enqueueVisibleItems() {
        const items = [...document.querySelectorAll('.item.hoverable.app440')];

        for (const item of items) {
            if (!item.dataset.title) continue;
            if (!isVisible(item)) continue;
            if (item.dataset.vbpQueued === '1') continue;

            item.dataset.vbpQueued = '1';
            autoQueue.push(item);
        }

        runQueue();
    }

    async function worker() {
        while (autoQueue.length) {
            const item = autoQueue.shift();

            if (item && document.body.contains(item)) {
                await checkItem(item, false);
                await new Promise(r => setTimeout(r, AUTO_CHECK_DELAY));
            }
        }
    }

    async function runQueue() {
        if (autoRunning) return;

        autoRunning = true;

        const workers = [];
        const count = Math.min(PARALLEL_CHECKS, autoQueue.length);

        for (let i = 0; i < count; i++) {
            workers.push(worker());
        }

        await Promise.all(workers);

        autoRunning = false;
    }

    function initItems() {
        document.querySelectorAll('.item.hoverable.app440').forEach(item => {
            if (item.classList.contains(CHECKED_CLASS)) return;
            if (!item.dataset.title) return;

            item.classList.add(CHECKED_CLASS);
            item.style.position = 'relative';

            createButton(item);
            createOpenBackpackButton(item);
            makeBadge(item);
        });

        enqueueVisibleItems();
    }

    initItems();

    let scrollTimer = null;

    window.addEventListener('scroll', () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(enqueueVisibleItems, 250);
    }, true);

    new MutationObserver(() => {
        clearTimeout(window.__vbpMutation);
        window.__vbpMutation = setTimeout(initItems, 300);
    }).observe(document.body, {
        childList: true,
        subtree: true
    });
})();
