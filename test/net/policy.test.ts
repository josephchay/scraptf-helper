import { describe, expect, it } from 'vitest';
import { ForbiddenHostError } from '../../src/service/net/errors';
import { assertAllowed, checkUrl, isBackpackHost, isScrapTfHost, normalizeHost } from '../../src/service/net/policy';
import { registerSecret, unregisterSecret } from '../../src/service/net/redact';

const denied = (url: string, kind: 'http' | 'ws' = 'http', method = 'GET') => {
  const d = checkUrl(url, kind, method);
  expect(d, `${method} ${url} (${kind}) should be denied`).toMatchObject({ allowed: false });
  expect(d.reason.length).toBeGreaterThan(0);
  expect(() => assertAllowed(url, kind, method)).toThrow(ForbiddenHostError);
  return d.reason;
};

const allowed = (url: string, kind: 'http' | 'ws' = 'http', method = 'GET') => {
  const d = checkUrl(url, kind, method);
  expect(d, `${method} ${url} (${kind}) should be allowed`).toMatchObject({ allowed: true });
  expect(() => assertAllowed(url, kind, method)).not.toThrow();
};

describe('Appendix B #1: forbidden URLs', () => {
  it.each([
    'https://scrap.tf/',
    'https://scrap.tf/buy/hats',
    'https://scrap.tf/items',
    'https://scrap.tf/ajax/raffles/Paginate',
    'https://scrap.tf/api/whatever',
    'https://backpack.tf/classifieds?item=Team%20Captain&quality=5',
    'https://marketplace.tf/items/tf2/5021;6',
    'https://stntrading.eu/item/tf2/Mann+Co.+Supply+Crate+Key',
    'https://mannco.store/item/440-mann-co-supply-crate-key',
  ])('rejects %s', (url) => {
    denied(url);
  });

  it('rejects wss://ws.scrap.tf for both kinds', () => {
    expect(denied('wss://ws.scrap.tf', 'ws')).toMatch(/scrap\.tf/);
    expect(denied('wss://ws.scrap.tf/socket.io/?EIO=4&transport=websocket', 'ws')).toMatch(/R1/);
    expect(denied('wss://ws.scrap.tf')).toMatch(/R1/);
  });
});

describe('scrap.tf can never be reached by any spelling', () => {
  it.each([
    'https://forum.scrap.tf/topic/1',
    'https://ws.scrap.tf/socket.io/',
    'https://a.b.c.scrap.tf/',
    'https://www.scrap.tf/',
    'HTTPS://SCRAP.TF/BUY/HATS',
    'https://Scrap.Tf/',
    'https://scrap.tf./',
    'https://scrap.tf../',
    'https://forum.scrap.tf./',
    'https://scrap.tf:443/',
    'https://scrap.tf:8443/',
    'http://scrap.tf/',
    'ws://ws.scrap.tf/',
    'ftp://scrap.tf/',
    'https://backpack.tf@scrap.tf/api/x',
    'https://api.backpack.tf:pw@scrap.tf/api/IGetPrices/v4',
    'https://ｓｃｒａｐ.ｔｆ/',
    'https://scr%61p.tf/',
    'https://backpack.tf\\@scrap.tf/',
    '  https://scrap.tf/  ',
    'https://scrap.tf/#https://api.backpack.tf/api/',
  ])('rejects %s', (url) => {
    denied(url);
    denied(url, 'ws');
  });

  it('names R1 as the reason', () => {
    expect(checkUrl('https://forum.scrap.tf/').reason).toMatch(/never contacted \(R1\)/);
  });

  it('isScrapTfHost matches the domain and subdomains only', () => {
    expect(isScrapTfHost('scrap.tf')).toBe(true);
    expect(isScrapTfHost('WS.SCRAP.TF.')).toBe(true);
    expect(isScrapTfHost('notscrap.tf')).toBe(false);
    expect(isScrapTfHost('scrap.tf.evil.example')).toBe(false);
  });
});

describe('lookalike and trick hosts', () => {
  it.each([
    'https://notscrap.tf/',
    'https://scrap.tf.evil.example/',
    'https://scraptf.com/',
    'https://api.backpack.tf.evil.example/api/IGetPrices/v4',
    'https://backpack.tf.evil.example/api/x',
    'https://evilbackpack.tf/api/x',
    'https://api-backpack.tf/api/x',
    'https://api.backpack.tf%2eevil.example/api/x',
    'https://xn--bckpack-2ya.tf/api/x',
    'https://bаckpack.tf/api/x', // Cyrillic a
    'https://pricedb.io.evil.example/api/item/5021;6',
    'https://evilpricedb.io/api/item/5021;6',
    'https://www.pricedb.io/api/item/5021;6',
    'https://next.backpack.tf/api/x',
    'https://www.backpack.tf/api/x',
    'https://www.marketplace.tf/api/Meta/GetEndpoints/v1',
    'https://store.steampowered.com/api/appdetails',
    'https://help.steampowered.com/',
    'https://prices.tf/items',
    'https://autobot.tf/json/pricelist',
    'https://schema.autobot.tf/schema',
  ])('rejects %s', (url) => {
    denied(url);
  });

  it('rejects userinfo even on allowed hosts', () => {
    expect(denied('https://scrap.tf@api.backpack.tf/api/IGetPrices/v4')).toMatch(/credentials/);
    expect(denied('https://user:pass@pricedb.io/api/item/5021;6')).toMatch(/credentials/);
    expect(denied('https://:pass@pricedb.io/api/item/5021;6')).toMatch(/credentials/);
  });

  it('rejects IP literals and localhost', () => {
    expect(denied('https://104.18.32.7/api/x')).toMatch(/IP-literal/);
    expect(denied('https://0x7f000001/')).toMatch(/IP-literal/);
    expect(denied('https://2130706433/')).toMatch(/IP-literal/);
    expect(denied('https://[::1]/')).toMatch(/IP-literal/);
    expect(denied('https://[2606:4700::6810:2007]/api/x')).toMatch(/IP-literal/);
    expect(denied('https://localhost/api/x')).toMatch(/localhost/);
    expect(denied('https://localhost./api/x')).toMatch(/localhost/);
    expect(denied('https://app.localhost/api/x')).toMatch(/localhost/);
  });

  it('rejects non-default ports but accepts an explicit default port', () => {
    expect(denied('https://api.backpack.tf:8443/api/IGetPrices/v4')).toMatch(/port/);
    expect(denied('https://pricedb.io:80/api/item/5021;6')).toMatch(/port/);
    expect(denied('wss://ws.backpack.tf:8080/events', 'ws')).toMatch(/port/);
    allowed('https://api.backpack.tf:443/api/IGetPrices/v4');
    allowed('wss://ws.backpack.tf:443/events', 'ws');
  });

  it('rejects insecure and unsupported schemes', () => {
    expect(denied('http://api.backpack.tf/api/IGetPrices/v4')).toMatch(/insecure/);
    expect(denied('ws://ws.backpack.tf/events', 'ws')).toMatch(/insecure/);
    expect(denied('http://pricedb.io/api/item/5021;6')).toMatch(/insecure/);
    denied('file:///C:/Windows/win.ini');
    denied('javascript:alert(1)');
    denied('data:text/html,<p>x</p>');
    denied('ftp://pricedb.io/api/x');
  });

  it('rejects unparseable input', () => {
    denied('');
    denied('   ');
    denied('not a url');
    denied('/api/IGetPrices/v4');
    denied('//api.backpack.tf/api/IGetPrices/v4');
    denied('https://');
    denied('https://api.backpack.tf%00.scrap.tf/');
  });
});

describe('backpack.tf path rules', () => {
  it.each([
    'https://backpack.tf/',
    'https://backpack.tf/classifieds',
    'https://backpack.tf/stats/Unique/Team%20Captain/Tradable/Craftable',
    'https://backpack.tf/profiles/76561198000000000',
    'https://next.backpack.tf/classifieds',
    'https://forums.backpack.tf/topic/1',
    'https://api.backpack.tf/',
    'https://api.backpack.tf/index.html',
    'https://backpack.tf/api',
    'https://backpack.tf/API/IGetPrices/v4',
    'https://backpack.tf/%61pi/IGetPrices/v4',
    'https://backpack.tf/api/../classifieds',
    'https://backpack.tf/api/%2e%2e/classifieds',
    'https://backpack.tf/api/..%2fclassifieds',
    'https://backpack.tf/api/..%5Cclassifieds',
    'https://backpack.tf/api/%E0%A4%A',
    'https://backpack.tf/api/x%00y',
  ])('rejects %s', (url) => {
    denied(url);
  });

  it.each([
    'https://backpack.tf/api/agent/pulse',
    'https://api.backpack.tf/api/agent/pulse',
    'https://api.backpack.tf/api/agent/status',
    'https://api.backpack.tf/api/Agent/pulse',
    'https://api.backpack.tf/api/%61gent/pulse',
    'https://api.backpack.tf/api/agent',
    'https://api.backpack.tf/api/v2/agent/pulse',
  ])('rejects the bot-marking agent endpoint %s', (url) => {
    expect(denied(url)).toMatch(/agent/);
    expect(denied(url, 'http', 'POST')).toMatch(/agent/);
  });

  it.each([
    'https://api.backpack.tf/api/_internal/x',
    'https://backpack.tf/api/_/x',
    'https://api.backpack.tf/api/classifieds/_search',
    'https://api.backpack.tf/api/%5Finternal',
    'https://ws.backpack.tf/_events',
  ])('rejects internal underscore API %s', (url) => {
    expect(denied(url)).toMatch(/internal/);
  });

  it('rejects writes to listings', () => {
    denied('https://api.backpack.tf/api/v2/classifieds/listings', 'http', 'POST');
    denied('https://api.backpack.tf/api/v2/classifieds/listings/123', 'http', 'PATCH');
    denied('https://api.backpack.tf/api/v2/classifieds/listings/123', 'http', 'DELETE');
    denied('https://api.backpack.tf/api/classifieds/alerts', 'http', 'POST');
    denied('https://api.backpack.tf/api/v2/classifieds/listings/batch', 'http', 'PUT');
  });

  it('allows the documented read APIs', () => {
    allowed('https://api.backpack.tf/api/IGetPrices/v4?key=x&raw=1&since=1791958000');
    allowed('https://api.backpack.tf/api/IGetCurrencies/v1?key=x&raw=1');
    allowed('https://api.backpack.tf/api/classifieds/listings/snapshot?sku=Strange%20Pain%20Train&appid=440');
    allowed('https://backpack.tf/api/classifieds/listings/snapshot?sku=Strange+Pain+Train&appid=440');
    allowed('https://api.backpack.tf/api/users/info/v1?steamids=76561198000000000,76561198000000001');
    allowed('https://API.BACKPACK.TF./api/IGetPrices/v4');
  });

  it('isBackpackHost covers the domain and subdomains only', () => {
    expect(isBackpackHost('api.backpack.tf')).toBe(true);
    expect(isBackpackHost('Backpack.TF.')).toBe(true);
    expect(isBackpackHost('evilbackpack.tf')).toBe(false);
  });
});

describe('other hosts', () => {
  it('marketplace.tf: API only', () => {
    allowed('https://marketplace.tf/api/Meta/GetEndpoints/v1');
    allowed('https://marketplace.tf/api/Bans/GetUserBan/v2?key=x&steamid=76561198000000000');
    denied('https://marketplace.tf/');
    denied('https://marketplace.tf/items/tf2/5021;6');
    denied('https://marketplace.tf/apidocs');
    denied('https://marketplace.tf/api');
  });

  it('STN and mannco: API hosts only', () => {
    allowed('https://api.stntrading.eu/GetKeyPrices/v1?apikey=x');
    allowed('https://api.mannco.store/item/pricing/bulk?items=1,2,3');
    denied('https://stntrading.eu/');
    denied('https://www.stntrading.eu/item/tf2/Team+Captain');
    denied('https://mannco.store/');
    denied('https://www.mannco.store/tos');
    denied('https://docs.mannco.store/api-reference/introduction');
  });

  it.each([
    'https://api.stntrading.eu/RequestKeyTrade/v1?apikey=x',
    'https://api.stntrading.eu/RequestItemTrade/v1?apikey=x&sku=5021;6',
    'https://api.stntrading.eu/CancelQueueRequest/v1?apikey=x',
    'https://api.stntrading.eu/requestkeytrade/v1',
    'https://api.stntrading.eu/%52equestKeyTrade/v1',
    'https://api.stntrading.eu/v1/RequestItemTrade',
  ])('never calls the STN trade endpoint %s, even as a GET (§2.14)', (url) => {
    expect(denied(url)).toMatch(/STN trade endpoints/);
  });

  it('mannco: only the three documented API paths', () => {
    allowed('https://api.mannco.store/item/prices?game=440');
    allowed('https://api.mannco.store/item/pricing/bulk?items=1');
    allowed('https://api.mannco.store/user/login', 'http', 'POST');
    denied('https://api.mannco.store/item/buy');
    denied('https://api.mannco.store/item/buy?id=1&price=1');
    denied('https://api.mannco.store/user/withdraw');
    denied('https://api.mannco.store/');
    denied('https://api.mannco.store/item/prices/../buy');
    denied('https://api.mannco.store/item/%70rices');
  });

  it.each([
    'https://api.backpack.tf/api/classifieds/search/v1?item=Team%20Captain',
    'https://backpack.tf/api/classifieds/search/v1',
    'https://api.backpack.tf/api/Classifieds/Search/v1',
    'https://api.backpack.tf/api/classifieds/%73earch/v1',
  ])('never polls classifieds search %s (§2.15)', (url) => {
    expect(denied(url)).toMatch(/classifieds search/);
  });

  it.each([
    'https://backpack.tf/api/item/get_third_party_prices/Unique/Team%20Captain',
    'https://api.backpack.tf/api/item/get_third_party_prices/x',
    'https://api.backpack.tf/item/get_third_party_prices/Unique/x',
  ])('never calls get_third_party_prices %s (§2.15)', (url) => {
    expect(denied(url)).toMatch(/get_third_party_prices/);
  });

  it('steamcommunity.com: priceoverview only', () => {
    allowed('https://steamcommunity.com/market/priceoverview/?appid=440&currency=1&market_hash_name=Mann%20Co.%20Supply%20Crate%20Key');
    denied('https://steamcommunity.com/market/pricehistory/?appid=440&market_hash_name=x');
    denied('https://steamcommunity.com/market/listings/440/Mann%20Co.%20Supply%20Crate%20Key');
    denied('https://steamcommunity.com/id/someone/inventory');
    denied('https://steamcommunity.com/tradeoffer/new/?partner=1&token=abc');
    denied('https://steamcommunity.com/market/priceoverview/../listings/440/x');
    denied('https://api.steamcommunity.com/market/priceoverview/');
    denied('https://steamcommunity.com/MARKET/PRICEOVERVIEW/');
  });

  it('Steam Web API, PriceDB and sku.pricedb.io', () => {
    allowed('https://api.steampowered.com/IEconItems_440/GetSchemaOverview/v0001/');
    allowed('https://pricedb.io/api/item/5021;6');
    allowed('https://pricedb.io/api/autob/items');
    allowed('https://pricedb.io/api/item-history/5021;6?start=1&end=2');
    allowed('https://sku.pricedb.io/api/schema');
    allowed('https://sku.pricedb.io/api/sku/30177;5;u13');
    allowed('https://sku.pricedb.io/api/sku/30177;5;u13/image');
    denied('https://pricedb.io/graph/5021;6');
    denied('https://pricedb.io/');
    denied('https://sku.pricedb.io/');
    denied('https://docs.pricedb.io/docs/sku');
  });
});

describe('websocket rules', () => {
  it('allows only the documented sockets over TLS', () => {
    allowed('wss://ws.backpack.tf/events', 'ws');
    allowed('wss://ws.pricedb.io/socket.io/?EIO=4&transport=websocket', 'ws');
    allowed('https://ws.pricedb.io/socket.io/', 'ws');
    allowed('https://ws.pricedb.io/socket.io/?EIO=4&transport=polling', 'http');
  });

  it('rejects other socket URLs and kind mismatches', () => {
    denied('wss://ws.backpack.tf/', 'ws');
    denied('wss://ws.backpack.tf/events/extra', 'ws');
    denied('https://ws.backpack.tf/events', 'ws');
    denied('https://ws.backpack.tf/events', 'http');
    denied('wss://ws.backpack.tf/events', 'http');
    denied('wss://ws.pricedb.io/other', 'ws');
    denied('wss://api.backpack.tf/api/IGetPrices/v4', 'ws');
    denied('wss://pricedb.io/api/item/5021;6', 'ws');
    denied('wss://ws.backpack.tf/events', 'ws', 'POST');
  });
});

describe('method rules', () => {
  it('allows POST only to items-bulk and mannco login', () => {
    allowed('https://pricedb.io/api/items-bulk', 'http', 'POST');
    allowed('https://pricedb.io/api/items-bulk', 'http', 'post');
    allowed('https://api.mannco.store/user/login', 'http', 'POST');
  });

  it('rejects POST everywhere else', () => {
    denied('https://pricedb.io/api/items-bulk/', 'http', 'POST');
    denied('https://pricedb.io/api/items-bulk?x=1#', 'http', 'PUT');
    denied('https://pricedb.io/api/autob/items/5021;6', 'http', 'POST');
    denied('https://pricedb.io/api/item/5021;6', 'http', 'POST');
    denied('https://api.mannco.store/item/buy', 'http', 'POST');
    denied('https://api.steampowered.com/IEconService/DeclineTradeOffer/v1/', 'http', 'POST');
    denied('https://sku.pricedb.io/api/schema', 'http', 'POST');
  });

  it.each(['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE', ''])('rejects %s everywhere', (m) => {
    if (m === '') {
      // An empty method falls back to GET.
      allowed('https://pricedb.io/api/item/5021;6', 'http', m);
      return;
    }
    denied('https://pricedb.io/api/items-bulk', 'http', m);
    denied('https://api.backpack.tf/api/IGetPrices/v4', 'http', m);
    denied('https://api.mannco.store/user/login', 'http', m);
  });

  it('accepts POST in the allowed form only, regardless of query', () => {
    allowed('https://pricedb.io/api/items-bulk?trace=1', 'http', 'POST');
    denied('https://PRICEDB.io/api/Items-Bulk', 'http', 'POST');
  });
});

describe('error details', () => {
  it('ForbiddenHostError carries the reason and a redacted URL', () => {
    const token = 'tok_ABCDEFGHIJ0123456789';
    registerSecret(token);
    try {
      let caught: unknown;
      try {
        assertAllowed(`https://scrap.tf/ajax/x?token=${token}&key=${token}`);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ForbiddenHostError);
      const err = caught as ForbiddenHostError;
      expect(err.reason).toMatch(/R1/);
      expect(err.url).not.toContain(token);
      expect(err.message).not.toContain(token);
      expect(err.url).toContain('token=REDACTED');
    } finally {
      unregisterSecret(token);
    }
  });

  it('normalizeHost lower-cases and strips trailing dots', () => {
    expect(normalizeHost('API.Backpack.TF.')).toBe('api.backpack.tf');
    expect(normalizeHost('scrap.tf..')).toBe('scrap.tf');
  });
});
