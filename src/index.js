'use strict';

const { openDb } = require('./db');
const { createApp } = require('./app');
const { CoinGeckoProvider } = require('./prices');

const env = process.env;
const plan = (env.COINGECKO_PLAN || (env.COINGECKO_API_KEY ? 'demo' : 'public')).toLowerCase();

if (!['demo', 'pro', 'public'].includes(plan)) {
  console.error('COINGECKO_PLAN must be demo, pro, or public');
  process.exit(1);
}
if (plan !== 'public' && !env.COINGECKO_API_KEY) {
  console.warn(`COINGECKO_PLAN=${plan} but COINGECKO_API_KEY is empty; falling back to the keyless public API.`);
}

const db = openDb(env.DATABASE_PATH || './data/coinledger.db');
const priceProvider = new CoinGeckoProvider({ apiKey: env.COINGECKO_API_KEY || '', plan });

const app = createApp({
  db,
  priceProvider,
  config: {
    defaultCurrency: (env.DEFAULT_CURRENCY || 'usd').toLowerCase(),
    secureCookies: env.NODE_ENV === 'production',
    trustProxy: env.TRUST_PROXY === 'true' ? 1 : false,
    allowRegistration: env.ALLOW_REGISTRATION !== 'false',
    priceTtlMs: Math.max(10, Number(env.PRICE_TTL_SECONDS) || 60) * 1000,
  },
});

const port = Number(env.PORT) || 3000;
app.listen(port, () => {
  console.log(`CoinLedger running at http://localhost:${port}  (prices: CoinGecko ${plan})`);
});
