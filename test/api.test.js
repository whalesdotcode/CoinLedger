'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { PriceService, CoinGeckoProvider } = require('../src/prices');
const v = require('../src/validation');

/** In-memory stand-in for CoinGecko so tests never touch the network. */
class FakeProvider {
  constructor() {
    this.name = 'coingecko';
    this.coins = {
      bitcoin: { name: 'Bitcoin', symbol: 'BTC' },
      ethereum: { name: 'Ethereum', symbol: 'ETH' },
      'obscure-coin': { name: 'Obscure', symbol: 'OBS' },
    };
    this.prices = { bitcoin: '150', ethereum: '2700' }; // obscure-coin has no price
    this.calls = 0;
    this.fail = false;
  }
  async getPrices(assets) {
    this.calls += 1;
    if (this.fail) throw new Error('provider down');
    const prices = new Map();
    for (const a of assets) {
      const p = this.prices[a.provider_id];
      if (p) prices.set(a.id, { price: p, providerUpdatedAt: new Date().toISOString() });
    }
    return { prices, errors: [] };
  }
  async getCoin(id) {
    const c = this.coins[id];
    return c ? { providerId: id, ...c, imageUrl: '' } : null;
  }
  async getToken() { return null; }
  async search() { return []; }
  async listPlatforms() { return []; }
  async supportedCurrencies() { return ['usd', 'eur']; }
}

async function startServer() {
  const db = openDb(':memory:');
  const provider = new FakeProvider();
  const priceService = new PriceService({ db, provider, ttlMs: 0, minForceIntervalMs: 0 });
  const app = createApp({ db, priceProvider: provider, config: { priceService } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, provider, priceService, server, base };
}

function client(base) {
  let cookie = '';
  return async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'CoinLedger',
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
}

async function signUp(call, email = 'me@example.com') {
  const r = await call('POST', '/api/auth/register', { email, password: 'correct horse battery' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const accounts = await call('GET', '/api/accounts');
  return { user: r.data.user, accountId: accounts.data.accounts[0].id };
}

test('API end to end', async (t) => {
  const env = await startServer();
  t.after(() => env.server.close());
  const call = client(env.base);

  await t.test('requires sign-in', async () => {
    const r = await client(env.base)('GET', '/api/portfolio');
    assert.equal(r.status, 401);
  });

  const { accountId } = await signUp(call);
  const btc = (await call('POST', '/api/assets', { providerId: 'bitcoin' })).data.asset;
  const eth = (await call('POST', '/api/assets', { providerId: 'ethereum' })).data.asset;

  await t.test('assets are identified by provider ID', async () => {
    assert.equal(btc.providerId, 'bitcoin');
    assert.equal(btc.symbol, 'BTC');
    const unknown = await call('POST', '/api/assets', { providerId: 'not-a-coin' });
    assert.equal(unknown.status, 404);
  });

  await t.test('rejects invalid entries', async () => {
    const bad = [
      { quantity: '-1', price: '100' },
      { quantity: '0', price: '100' },
      { quantity: '1', price: '-5' },
      { quantity: '1', price: 'abc' },
      { quantity: '1e3', price: '100' },
      { quantity: '1', price: '100', fee: '-1' },
    ];
    for (const b of bad) {
      const r = await call('POST', '/api/transactions', { assetId: btc.id, accountId, date: '2024-01-01', ...b });
      assert.equal(r.status, 400, JSON.stringify(b));
    }
    const future = await call('POST', '/api/transactions', {
      assetId: btc.id, accountId, quantity: '1', price: '1', date: '2999-01-01',
    });
    assert.equal(future.status, 400);
  });

  let secondBuyId;
  await t.test('average entry price after multiple purchases', async () => {
    await call('POST', '/api/transactions', { assetId: btc.id, accountId, quantity: '1', price: '100', fee: '2', date: '2024-01-01' });
    const r = await call('POST', '/api/transactions', { assetId: btc.id, accountId, quantity: '2', price: '130', fee: '3', date: '2024-02-01' });
    secondBuyId = r.data.transaction.id;
    const p = (await call('GET', '/api/portfolio')).data;
    const h = p.holdings.find((x) => x.asset.providerId === 'bitcoin');
    assert.equal(h.averageEntryPrice, '120');
    assert.equal(h.costBasis, '360');
    assert.equal(h.marketValue, '450');
    assert.equal(h.unrealizedPL, '90');
    assert.equal(h.unrealizedPLPct, '25');
    assert.equal(h.feesPaid, '5');
    assert.equal(h.priceStatus, 'ok');
    assert.ok(p.pricesUpdatedAt.newest);
  });

  await t.test('amount-based entry: quantity calculated from amount and price, no fees needed', async () => {
    const a = (await call('POST', '/api/assets', { providerId: 'obscure-coin' })).data.asset;
    const r1 = await call('POST', '/api/transactions', { assetId: a.id, accountId, amount: '100', price: '100', date: '2024-01-01' });
    assert.equal(r1.status, 201, JSON.stringify(r1.data));
    assert.equal(r1.data.transaction.quantity, '1');
    assert.equal(r1.data.transaction.amount, '100');
    assert.equal(r1.data.transaction.total, '100');
    assert.equal(r1.data.transaction.fee, '0');
    const r2 = await call('POST', '/api/transactions', { assetId: a.id, accountId, amount: '260', price: '130', date: '2024-01-02' });
    assert.equal(r2.data.transaction.quantity, '2');
    const h = (await call('GET', `/api/portfolio?assetId=${a.id}`)).data.holdings[0];
    assert.equal(h.averageEntryPrice, '120');
    assert.equal(h.costBasis, '360');

    // a quantity sent alongside the amount is ignored; the server recalculates it
    const r3 = await call('POST', '/api/transactions', { assetId: a.id, accountId, amount: '50', price: '25', quantity: '999', date: '2024-01-02' });
    assert.equal(r3.status, 201, JSON.stringify(r3.data));
    assert.equal(r3.data.transaction.quantity, '2');
    await call('DELETE', `/api/transactions/${r3.data.transaction.id}`);

    // edit by amount recalculates quantity
    const e = await call('PUT', `/api/transactions/${r2.data.transaction.id}`, { assetId: a.id, accountId, amount: '320', price: '160', date: '2024-01-02' });
    assert.equal(e.data.transaction.quantity, '2');
    assert.equal((await call('GET', `/api/portfolio?assetId=${a.id}`)).data.holdings[0].averageEntryPrice, '140');

    // invalid amount / zero price rejected (cannot divide by zero)
    for (const bad of [{ amount: '-5', price: '10' }, { amount: '0', price: '10' }, { amount: '10', price: '0' }, { amount: 'ten', price: '10' }]) {
      const r = await call('POST', '/api/transactions', { assetId: a.id, accountId, date: '2024-01-03', ...bad });
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    for (const tx of [r1, r2]) await call('DELETE', `/api/transactions/${tx.data.transaction.id}`);
  });

  await t.test('editing without a fee field keeps an existing fee', async () => {
    const r = await call('POST', '/api/transactions', { assetId: eth.id, accountId, quantity: '1', price: '10', fee: '2', date: '2024-01-01' });
    const e = await call('PUT', `/api/transactions/${r.data.transaction.id}`, { assetId: eth.id, accountId, amount: '20', price: '10', date: '2024-01-01' });
    assert.equal(e.data.transaction.fee, '2');
    await call('DELETE', `/api/transactions/${r.data.transaction.id}`);
  });

  await t.test('editing and deleting recalculates holdings', async () => {
    let r = await call('PUT', `/api/transactions/${secondBuyId}`, {
      assetId: btc.id, accountId, quantity: '2', price: '160', fee: '3', date: '2024-02-01',
    });
    assert.equal(r.status, 200);
    let h = (await call('GET', '/api/portfolio')).data.holdings[0];
    assert.equal(h.averageEntryPrice, '140');

    r = await call('DELETE', `/api/transactions/${secondBuyId}`);
    assert.equal(r.status, 200);
    h = (await call('GET', '/api/portfolio')).data.holdings[0];
    assert.equal(h.averageEntryPrice, '100');
    assert.equal(h.quantity, '1');

    await call('POST', '/api/transactions', { assetId: btc.id, accountId, quantity: '2', price: '130', date: '2024-02-01' });
  });

  await t.test('cannot sell more than held, or delete a buy a later sell depends on', async () => {
    const tooMuch = await call('POST', '/api/transactions', {
      type: 'sell', assetId: btc.id, accountId, quantity: '5', price: '150', date: '2024-03-01',
    });
    assert.equal(tooMuch.status, 422);

    const ok = await call('POST', '/api/transactions', {
      type: 'sell', assetId: btc.id, accountId, quantity: '3', price: '150', date: '2024-03-01',
    });
    assert.equal(ok.status, 201);
    const txs = (await call('GET', '/api/transactions')).data.transactions;
    const firstBuy = txs.find((x) => x.type === 'buy' && x.price === '100');
    const del = await call('DELETE', `/api/transactions/${firstBuy.id}`);
    assert.equal(del.status, 422);
    // the failed delete was rolled back
    assert.equal((await call('GET', '/api/transactions')).data.transactions.length, txs.length);
    await call('DELETE', `/api/transactions/${ok.data.transaction.id}`);
  });

  await t.test('portfolio totals and filtering by account / cryptocurrency', async () => {
    const acct2 = (await call('POST', '/api/accounts', { name: 'Ledger' })).data.account;
    await call('POST', '/api/transactions', { assetId: eth.id, accountId: acct2.id, quantity: '1', price: '3000', date: '2024-01-15' });

    const all = (await call('GET', '/api/portfolio')).data;
    // BTC: cost 360, value 450. ETH: cost 3000, value 2700.
    assert.equal(all.totals.totalCostBasis, '3360');
    assert.equal(all.totals.currentValue, '3150');
    assert.equal(all.totals.unrealizedPL, '-210');
    assert.equal(all.totals.unrealizedPLPct, '-6.25');
    assert.equal(all.totals.complete, true);

    const byAccount = (await call('GET', `/api/portfolio?accountId=${acct2.id}`)).data;
    assert.equal(byAccount.holdings.length, 1);
    assert.equal(byAccount.holdings[0].asset.providerId, 'ethereum');

    const byAsset = (await call('GET', `/api/portfolio?assetId=${btc.id}`)).data;
    assert.equal(byAsset.holdings.length, 1);
    assert.equal(byAsset.totals.totalCostBasis, '360');

    const txByAccount = (await call('GET', `/api/transactions?accountId=${acct2.id}`)).data.transactions;
    assert.equal(txByAccount.length, 1);
  });

  await t.test('unavailable price is flagged and totals marked incomplete', async () => {
    const obs = (await call('POST', '/api/assets', { providerId: 'obscure-coin' })).data.asset;
    await call('POST', '/api/transactions', { assetId: obs.id, accountId, quantity: '100', price: '1', date: '2024-01-01' });
    const p = (await call('GET', '/api/portfolio')).data;
    const h = p.holdings.find((x) => x.asset.providerId === 'obscure-coin');
    assert.equal(h.priceStatus, 'unavailable');
    assert.equal(h.marketValue, null);
    assert.equal(p.totals.complete, false);
    assert.equal(p.totals.missingPriceAssets[0].symbol, 'OBS');
    assert.equal(p.totals.totalCostBasis, '3460');
    assert.equal(p.totals.currentValue, '3150'); // unchanged: missing price not counted as 0
  });

  await t.test('stale cached price is served when the provider fails', async () => {
    env.provider.fail = true;
    const p = (await call('GET', '/api/portfolio?refresh=1')).data;
    assert.ok(p.priceError);
    const h = p.holdings.find((x) => x.asset.providerId === 'bitcoin');
    assert.equal(h.marketPrice, '150');
    env.provider.fail = false;
    env.priceService.lastFailureAt = 0;
  });

  await t.test("users cannot see or modify each other's data", async () => {
    const other = client(env.base);
    const { accountId: otherAccount } = await signUp(other, 'other@example.com');
    const mine = (await call('GET', '/api/transactions')).data.transactions;

    assert.equal((await other('GET', '/api/transactions')).data.transactions.length, 0);
    assert.equal((await other('GET', '/api/portfolio')).data.holdings.length, 0);
    assert.equal((await other('DELETE', `/api/transactions/${mine[0].id}`)).status, 404);
    assert.equal(
      (await other('PUT', `/api/transactions/${mine[0].id}`, {
        assetId: btc.id, accountId: otherAccount, quantity: '1', price: '1', date: '2024-01-01',
      })).status,
      404,
    );
    // Cannot record into someone else's account
    const r = await other('POST', '/api/transactions', {
      assetId: btc.id, accountId, quantity: '1', price: '1', date: '2024-01-01',
    });
    assert.equal(r.status, 400);
    assert.equal((await call('GET', '/api/transactions')).data.transactions.length, mine.length);
  });

  await t.test('frontend files are always revalidated so updates are never mixed with stale copies', async () => {
    for (const file of ['/', '/app.js', '/styles.css']) {
      const res = await fetch(env.base + file);
      assert.equal(res.status, 200, file);
      assert.equal(res.headers.get('cache-control'), 'no-cache', file);
    }
  });

  await t.test('state-changing requests without the CSRF header are rejected', async () => {
    const res = await fetch(env.base + '/api/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    assert.equal(res.status, 403);
  });

  await t.test('reporting currency is configurable but locked once transactions exist', async () => {
    const fresh = client(env.base);
    await signUp(fresh, 'eur@example.com');
    const r = await fresh('PATCH', '/api/settings', { reportingCurrency: 'eur' });
    assert.equal(r.data.user.reportingCurrency, 'eur');
    const locked = await call('PATCH', '/api/settings', { reportingCurrency: 'eur' });
    assert.equal(locked.status, 409);
  });

  await t.test('login with wrong password fails; correct password works', async () => {
    const c = client(env.base);
    assert.equal((await c('POST', '/api/auth/login', { email: 'me@example.com', password: 'wrong-password' })).status, 401);
    assert.equal((await c('POST', '/api/auth/login', { email: 'me@example.com', password: 'correct horse battery' })).status, 200);
    assert.ok((await c('GET', '/api/portfolio')).data.holdings.length > 0);
  });
});

test('validation helpers', () => {
  assert.equal(v.parseDecimal('1.50', 'q'), '1.5');
  assert.equal(v.parseDecimal(' 0.000000000000000001 ', 'q'), '0.000000000000000001');
  assert.throws(() => v.parseDecimal('0.0000000000000000001', 'q')); // > 18 dp
  assert.throws(() => v.parseDecimal('-1', 'q'), /negative/);
  assert.throws(() => v.parseDecimal('1,000', 'q'));
  assert.throws(() => v.parseDecimal('0', 'q'), /greater than zero/);
  assert.equal(v.parseDecimal('0', 'q', { allowZero: true }), '0');
  assert.throws(() => v.parseDate('2024-02-30'));
  assert.equal(v.parseDate('2024-02-29'), '2024-02-29');
});

test('CoinGecko adapter parses prices exactly and keys by provider ID / contract', async () => {
  const requests = [];
  const fetchImpl = async (url, opts) => {
    requests.push({ url: String(url), headers: opts.headers });
    const u = new URL(url);
    if (u.pathname.endsWith('/simple/price')) {
      return Response.json({ bitcoin: { usd: 64231.12, last_updated_at: 1700000000 } });
    }
    return Response.json({ '0xabc0000000000000000000000000000000000001': { usd: 0.00001234, last_updated_at: 1700000000 } });
  };
  const p = new CoinGeckoProvider({ apiKey: 'k', plan: 'demo', fetchImpl });
  const { prices } = await p.getPrices(
    [
      { id: 1, provider_id: 'bitcoin', contract_address: '', platform: '' },
      { id: 2, provider_id: 'some-token', contract_address: '0xabc0000000000000000000000000000000000001', platform: 'ethereum' },
      { id: 3, provider_id: 'missing', contract_address: '', platform: '' },
    ],
    'USD',
  );
  assert.equal(prices.get(1).price, '64231.12');
  assert.equal(prices.get(1).providerUpdatedAt, '2023-11-14T22:13:20.000Z');
  assert.equal(prices.get(2).price, '0.00001234');
  assert.equal(prices.has(3), false);
  assert.equal(requests[0].headers['x-cg-demo-api-key'], 'k');
  assert.match(requests[1].url, /token_price\/ethereum/);
});
