'use strict';

const { D } = require('./calc');

class ProviderError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

/** Convert a provider number to an exact decimal string (no float math afterwards). */
function toDecimalString(value) {
  if (value === null || value === undefined) return null;
  const d = new D(typeof value === 'number' ? value : String(value));
  if (!d.isFinite() || d.isNegative()) return null;
  return d.toFixed();
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * CoinGecko adapter. Coins are priced by CoinGecko coin ID (e.g. "bitcoin");
 * tokens are priced by network (asset platform, e.g. "ethereum") + contract address,
 * so two tokens sharing a ticker can never be confused.
 */
class CoinGeckoProvider {
  constructor({ apiKey = '', plan = 'demo', fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    this.name = 'coingecko';
    this.apiKey = apiKey;
    this.plan = plan;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.baseUrl = plan === 'pro' ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
  }

  async request(path, params = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const headers = { accept: 'application/json' };
    if (this.apiKey) headers[this.plan === 'pro' ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key'] = this.apiKey;

    let res;
    try {
      res = await this.fetch(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      throw new ProviderError(`Could not reach CoinGecko (${err.name === 'TimeoutError' ? 'timeout' : err.message})`);
    }
    if (res.status === 404) return null;
    if (res.status === 429) throw new ProviderError('CoinGecko rate limit reached; try again shortly', 429);
    if (!res.ok) throw new ProviderError(`CoinGecko returned HTTP ${res.status}`, res.status);
    return res.json();
  }

  /**
   * @param {Array} assets  rows from the assets table
   * @returns {Promise<{ prices: Map<number,{price:string, providerUpdatedAt:string|null}>, errors: string[] }>}
   */
  async getPrices(assets, currency) {
    const cur = currency.toLowerCase();
    const prices = new Map();
    const errors = [];
    const record = (asset, entry) => {
      const price = entry ? toDecimalString(entry[cur]) : null;
      if (price === null) return;
      prices.set(asset.id, {
        price,
        providerUpdatedAt: entry.last_updated_at ? new Date(entry.last_updated_at * 1000).toISOString() : null,
      });
    };

    const coins = assets.filter((a) => !a.contract_address);
    for (const batch of chunk(coins, 100)) {
      try {
        const data = await this.request('/simple/price', {
          ids: batch.map((a) => a.provider_id).join(','),
          vs_currencies: cur,
          include_last_updated_at: 'true',
          precision: 'full',
        });
        for (const a of batch) record(a, data?.[a.provider_id]);
      } catch (err) {
        errors.push(err.message);
      }
    }

    // Free/demo plans accept one contract address per token_price request.
    const tokens = assets.filter((a) => a.contract_address);
    const perRequest = this.plan === 'pro' ? 50 : 1;
    const byPlatform = new Map();
    for (const t of tokens) {
      if (!byPlatform.has(t.platform)) byPlatform.set(t.platform, []);
      byPlatform.get(t.platform).push(t);
    }
    for (const [platform, list] of byPlatform) {
      for (const batch of chunk(list, perRequest)) {
        try {
          const data = await this.request(`/simple/token_price/${encodeURIComponent(platform)}`, {
            contract_addresses: batch.map((a) => a.contract_address).join(','),
            vs_currencies: cur,
            include_last_updated_at: 'true',
            precision: 'full',
          });
          for (const a of batch) record(a, data?.[a.contract_address] ?? data?.[a.contract_address.toLowerCase()]);
        } catch (err) {
          errors.push(err.message);
        }
      }
    }

    return { prices, errors };
  }

  async search(query) {
    const data = await this.request('/search', { query });
    return (data?.coins || []).slice(0, 15).map((c) => ({
      providerId: c.id,
      name: c.name,
      symbol: (c.symbol || '').toUpperCase(),
      marketCapRank: c.market_cap_rank ?? null,
      imageUrl: c.thumb || '',
    }));
  }

  /** Look up a coin by provider ID. Returns null if it does not exist. */
  async getCoin(providerId) {
    const data = await this.request(`/coins/${encodeURIComponent(providerId)}`, {
      localization: 'false',
      tickers: 'false',
      market_data: 'false',
      community_data: 'false',
      developer_data: 'false',
    });
    if (!data?.id) return null;
    return {
      providerId: data.id,
      name: data.name,
      symbol: (data.symbol || '').toUpperCase(),
      imageUrl: data.image?.small || data.image?.thumb || '',
    };
  }

  /** Look up a token by network + contract address. Returns null if unknown. */
  async getToken(platform, contractAddress) {
    const data = await this.request(
      `/coins/${encodeURIComponent(platform)}/contract/${encodeURIComponent(contractAddress)}`,
    );
    if (!data?.id) return null;
    return {
      providerId: data.id,
      name: data.name,
      symbol: (data.symbol || '').toUpperCase(),
      imageUrl: data.image?.small || data.image?.thumb || '',
    };
  }

  async listPlatforms() {
    const data = await this.request('/asset_platforms');
    return (data || [])
      .filter((p) => p.id)
      .map((p) => ({ id: p.id, name: p.name || p.id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async supportedCurrencies() {
    const data = await this.request('/simple/supported_vs_currencies');
    return Array.isArray(data) ? data : null;
  }
}

/**
 * Price cache in SQLite in front of the provider. Prices are reused for ttlMs;
 * if the provider fails, the last known price is served and flagged as stale.
 * Assets with no known price at all are reported as unavailable — never as zero.
 */
class PriceService {
  constructor({ db, provider, ttlMs = 60_000, staleAfterMs = 15 * 60_000, minForceIntervalMs = 15_000, now = () => Date.now() }) {
    this.db = db;
    this.provider = provider;
    this.ttlMs = ttlMs;
    this.staleAfterMs = staleAfterMs;
    this.minForceIntervalMs = minForceIntervalMs;
    this.now = now;
    this.lastFailureAt = 0;
    this.lastForcedAt = 0;
  }

  readCache(assetIds, currency) {
    if (!assetIds.length) return new Map();
    const rows = this.db
      .prepare(
        `SELECT asset_id, price, provider_updated_at, fetched_at FROM price_cache
         WHERE currency = ? AND asset_id IN (${assetIds.map(() => '?').join(',')})`,
      )
      .all(currency, ...assetIds);
    return new Map(rows.map((r) => [r.asset_id, r]));
  }

  async getPrices(assets, currency, { forceRefresh = false } = {}) {
    const cur = currency.toLowerCase();
    const now = this.now();
    let cache = this.readCache(assets.map((a) => a.id), cur);
    let error = null;

    const canForce = forceRefresh && now - this.lastForcedAt >= this.minForceIntervalMs;
    const due = assets.filter((a) => {
      const row = cache.get(a.id);
      return !row || canForce || now - row.fetched_at >= this.ttlMs;
    });
    // Back off for 30s after a provider failure instead of hammering it.
    const backingOff = now - this.lastFailureAt < 30_000;

    if (due.length && !backingOff) {
      if (canForce) this.lastForcedAt = now;
      try {
        const { prices, errors } = await this.provider.getPrices(due, cur);
        const upsert = this.db.prepare(
          `INSERT INTO price_cache (asset_id, currency, price, provider_updated_at, fetched_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (asset_id, currency) DO UPDATE SET
             price = excluded.price, provider_updated_at = excluded.provider_updated_at, fetched_at = excluded.fetched_at`,
        );
        for (const [assetId, p] of prices) upsert.run(assetId, cur, p.price, p.providerUpdatedAt, now);
        if (errors.length) {
          error = errors[0];
          this.lastFailureAt = now;
        }
      } catch (err) {
        error = err.message;
        this.lastFailureAt = now;
      }
      cache = this.readCache(assets.map((a) => a.id), cur);
    } else if (due.length && backingOff) {
      error = 'Price provider temporarily unavailable; showing last known prices';
    }

    const result = new Map();
    for (const a of assets) {
      const row = cache.get(a.id);
      if (!row) {
        result.set(a.id, { price: null, status: 'unavailable', providerUpdatedAt: null, fetchedAt: null });
        continue;
      }
      const updatedMs = row.provider_updated_at ? Date.parse(row.provider_updated_at) : row.fetched_at;
      result.set(a.id, {
        price: row.price,
        status: now - updatedMs > this.staleAfterMs ? 'stale' : 'ok',
        providerUpdatedAt: row.provider_updated_at,
        fetchedAt: new Date(row.fetched_at).toISOString(),
      });
    }
    return { prices: result, error };
  }
}

module.exports = { CoinGeckoProvider, PriceService, ProviderError, toDecimalString };
