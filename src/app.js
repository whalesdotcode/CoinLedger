'use strict';

const path = require('node:path');
const express = require('express');

const { withTransaction } = require('./db');
const { D, computePortfolio, validateLedger } = require('./calc');
const { PriceService, ProviderError } = require('./prices');
const auth = require('./auth');
const v = require('./validation');

const FALLBACK_CURRENCIES = ['usd', 'eur', 'gbp', 'jpy', 'cad', 'aud', 'chf', 'ngn', 'inr', 'brl', 'krw', 'sgd'];
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const CONTRACT_RE = /^[A-Za-z0-9:._-]{20,128}$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/** Small TTL cache for provider lookups that do not need to be fresh (search, platforms). */
function memo(ttlMs) {
  const store = new Map();
  return async (key, fn) => {
    const hit = store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await fn();
    store.set(key, { at: Date.now(), value });
    if (store.size > 500) store.delete(store.keys().next().value);
    return value;
  };
}

function createApp({ db, priceProvider, config = {} }) {
  const cfg = {
    defaultCurrency: 'usd',
    secureCookies: false,
    allowRegistration: true,
    priceTtlMs: 60_000,
    ...config,
  };
  const priceService = config.priceService || new PriceService({ db, provider: priceProvider, ttlMs: cfg.priceTtlMs });
  const loginLimiter = auth.rateLimiter({ max: 10 });
  const lookupCache = memo(10 * 60 * 1000);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy ?? false);

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: https://coin-images.coingecko.com https://assets.coingecko.com; " +
        "style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    next();
  });

  app.use(express.json({ limit: '32kb' }));
  app.use(auth.sessionMiddleware(db));

  // CSRF defence in depth (on top of SameSite=Strict cookies): state-changing API
  // calls must carry a custom header, which cross-site forms cannot send.
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-requested-with') !== 'CoinLedger') {
      return next(httpError(403, 'Missing request header'));
    }
    next();
  });

  // ---------- helpers bound to this db ----------
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    account: db.prepare('SELECT * FROM accounts WHERE id = ? AND user_id = ?'),
    asset: db.prepare('SELECT * FROM assets WHERE id = ?'),
    transaction: db.prepare('SELECT * FROM transactions WHERE id = ? AND user_id = ?'),
    userTxForAssets: (userId, assetIds) =>
      db
        .prepare(
          `SELECT * FROM transactions WHERE user_id = ? AND asset_id IN (${assetIds.map(() => '?').join(',')})`,
        )
        .all(userId, ...assetIds),
  };

  const toCalcTx = (r) => ({
    id: r.id,
    assetId: r.asset_id,
    accountId: r.account_id,
    type: r.type,
    quantity: r.quantity,
    price: r.price,
    amount: r.amount,
    fee: r.fee,
    date: r.tx_date,
  });

  const publicUser = (u) => ({
    id: u.id,
    email: u.email,
    reportingCurrency: u.reporting_currency,
    includeFeesInCostBasis: Boolean(u.include_fees_in_cost_basis),
  });

  const publicAsset = (a) => ({
    id: a.id,
    provider: a.provider,
    providerId: a.provider_id,
    platform: a.platform || null,
    contractAddress: a.contract_address || null,
    symbol: a.symbol,
    name: a.name,
    imageUrl: a.image_url || null,
  });

  /** Rejects a change that would make any account's balance negative at any date. */
  function assertLedger(rows) {
    const problem = validateLedger(rows.map(toCalcTx));
    if (problem) throw httpError(422, problem.message);
  }

  function getOwnedAccount(userId, id) {
    const a = q.account.get(id, userId);
    if (!a) throw new v.ValidationError('Account not found', 'accountId');
    return a;
  }

  function getAsset(id) {
    const a = q.asset.get(id);
    if (!a) throw new v.ValidationError('Cryptocurrency not found', 'assetId');
    return a;
  }

  function login(res, userId) {
    auth.setSessionCookie(res, auth.createSession(db, userId), { secure: cfg.secureCookies });
  }

  // ---------- auth ----------
  app.post('/api/auth/register', async (req, res) => {
    if (!cfg.allowRegistration) throw httpError(403, 'Registration is disabled on this server');
    if (!loginLimiter(`reg:${req.ip}`)) throw httpError(429, 'Too many attempts; try again later');
    const email = v.parseEmail(req.body?.email);
    const password = v.parsePassword(req.body?.password);
    if (q.userByEmail.get(email)) throw httpError(409, 'An account with this email already exists');

    const hash = await auth.hashPassword(password);
    const user = withTransaction(db, () => {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO users (email, password_hash, reporting_currency) VALUES (?, ?, ?)')
        .run(email, hash, cfg.defaultCurrency);
      db.prepare('INSERT INTO accounts (user_id, name) VALUES (?, ?)').run(lastInsertRowid, 'Main');
      return db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
    });
    login(res, user.id);
    res.status(201).json({ user: publicUser(user) });
  });

  app.post('/api/auth/login', async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!loginLimiter(`login:${req.ip}:${email}`)) throw httpError(429, 'Too many attempts; try again later');
    const user = email ? q.userByEmail.get(email) : null;
    const ok = await auth.verifyPassword(password, user ? user.password_hash : auth.DUMMY_HASH);
    if (!user || !ok) throw httpError(401, 'Incorrect email or password');
    login(res, user.id);
    res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionTokenHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(req.sessionTokenHash);
    auth.clearSessionCookie(res, { secure: cfg.secureCookies });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', (req, res) => {
    res.json({ user: req.user ? publicUser(req.user) : null, allowRegistration: cfg.allowRegistration });
  });

  // Everything below requires a signed-in user and is scoped to req.user.id.
  app.use('/api', auth.requireAuth);

  // ---------- settings ----------
  app.get('/api/currencies', async (_req, res) => {
    let list = null;
    try {
      list = await lookupCache('currencies', () => priceProvider.supportedCurrencies());
    } catch {
      /* fall back below */
    }
    res.json({ currencies: list?.length ? list : FALLBACK_CURRENCIES });
  });

  app.patch('/api/settings', (req, res) => {
    const userId = req.user.id;
    const updates = {};
    if (req.body?.reportingCurrency !== undefined) {
      const cur = v.parseCurrency(req.body.reportingCurrency);
      if (cur !== req.user.reporting_currency) {
        const other = db
          .prepare('SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND currency != ?')
          .get(userId, cur).n;
        if (other > 0) {
          throw httpError(
            409,
            'Reporting currency can only be changed while you have no transactions recorded in another currency ' +
              '(prices you entered are not converted between currencies).',
          );
        }
      }
      updates.reporting_currency = cur;
    }
    if (req.body?.includeFeesInCostBasis !== undefined) {
      if (typeof req.body.includeFeesInCostBasis !== 'boolean') {
        throw new v.ValidationError('includeFeesInCostBasis must be true or false');
      }
      updates.include_fees_in_cost_basis = req.body.includeFeesInCostBasis ? 1 : 0;
    }
    for (const [col, val] of Object.entries(updates)) {
      db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(val, userId);
    }
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId)) });
  });

  // ---------- accounts (wallets / exchanges) ----------
  const listAccounts = (userId) =>
    db
      .prepare(
        `SELECT a.id, a.name, COUNT(t.id) AS transactionCount
         FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
         WHERE a.user_id = ? GROUP BY a.id ORDER BY a.name COLLATE NOCASE`,
      )
      .all(userId);

  app.get('/api/accounts', (req, res) => res.json({ accounts: listAccounts(req.user.id) }));

  app.post('/api/accounts', (req, res) => {
    const name = v.parseText(req.body?.name, 'Account name', { max: 60 });
    try {
      const { lastInsertRowid } = db.prepare('INSERT INTO accounts (user_id, name) VALUES (?, ?)').run(req.user.id, name);
      res.status(201).json({ account: { id: Number(lastInsertRowid), name, transactionCount: 0 } });
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw httpError(409, 'You already have an account with that name');
      throw err;
    }
  });

  app.patch('/api/accounts/:id', (req, res) => {
    const account = getOwnedAccount(req.user.id, v.parseId(req.params.id, 'Account'));
    const name = v.parseText(req.body?.name, 'Account name', { max: 60 });
    try {
      db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(name, account.id);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) throw httpError(409, 'You already have an account with that name');
      throw err;
    }
    res.json({ account: { id: account.id, name } });
  });

  app.delete('/api/accounts/:id', (req, res) => {
    const account = getOwnedAccount(req.user.id, v.parseId(req.params.id, 'Account'));
    const n = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?').get(account.id).n;
    if (n > 0) throw httpError(409, 'Delete or move this account’s transactions before deleting it');
    db.prepare('DELETE FROM accounts WHERE id = ?').run(account.id);
    res.json({ ok: true });
  });

  // ---------- assets ----------
  app.get('/api/assets', (req, res) => {
    const rows = db
      .prepare(
        `SELECT DISTINCT a.* FROM assets a JOIN transactions t ON t.asset_id = a.id
         WHERE t.user_id = ? ORDER BY a.name COLLATE NOCASE`,
      )
      .all(req.user.id);
    res.json({ assets: rows.map(publicAsset) });
  });

  app.get('/api/assets/search', async (req, res) => {
    const term = v.parseText(req.query.q, 'Search', { max: 50 });
    try {
      const results = await lookupCache(`search:${term.toLowerCase()}`, () => priceProvider.search(term));
      res.json({ results });
    } catch (err) {
      throw httpError(502, `Search unavailable: ${err.message}`);
    }
  });

  app.get('/api/assets/platforms', async (_req, res) => {
    try {
      res.json({ platforms: await lookupCache('platforms', () => priceProvider.listPlatforms()) });
    } catch (err) {
      throw httpError(502, `Network list unavailable: ${err.message}`);
    }
  });

  /**
   * Register an asset by provider ID ({ providerId: "bitcoin" }) or by network +
   * contract ({ platform: "ethereum", contractAddress: "0x..." }). The provider is
   * asked to confirm it exists so assets are never identified by ticker alone.
   */
  app.post('/api/assets', async (req, res) => {
    const body = req.body || {};
    let providerId = '';
    let platform = '';
    let contract = '';

    if (body.contractAddress) {
      platform = v.parseText(body.platform, 'Network', { max: 100 }).toLowerCase();
      contract = v.parseText(body.contractAddress, 'Contract address', { max: 128 });
      if (!PROVIDER_ID_RE.test(platform)) throw new v.ValidationError('Invalid network', 'platform');
      if (!CONTRACT_RE.test(contract)) throw new v.ValidationError('Invalid contract address', 'contractAddress');
      if (/^0x[0-9a-fA-F]{40}$/.test(contract)) contract = contract.toLowerCase(); // EVM addresses are case-insensitive
    } else {
      providerId = v.parseText(body.providerId, 'Provider ID', { max: 100 }).toLowerCase();
      if (!PROVIDER_ID_RE.test(providerId)) throw new v.ValidationError('Invalid provider ID', 'providerId');
    }

    const existing = contract
      ? db.prepare(`SELECT * FROM assets WHERE provider = ? AND platform = ? AND contract_address = ?`).get(priceProvider.name, platform, contract)
      : db.prepare(`SELECT * FROM assets WHERE provider = ? AND provider_id = ? AND contract_address = ''`).get(priceProvider.name, providerId);
    if (existing) return res.json({ asset: publicAsset(existing) });

    let info;
    try {
      info = contract ? await priceProvider.getToken(platform, contract) : await priceProvider.getCoin(providerId);
    } catch (err) {
      throw httpError(502, `Could not verify asset with price provider: ${err.message}`);
    }
    if (!info) throw httpError(404, contract ? 'No token with that contract address on that network' : 'Unknown provider ID');

    const imageUrl = /^https:\/\//.test(info.imageUrl || '') ? info.imageUrl : '';
    db.prepare(
      `INSERT OR IGNORE INTO assets (provider, provider_id, platform, contract_address, symbol, name, image_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(priceProvider.name, contract ? info.providerId : providerId, platform, contract, info.symbol.slice(0, 20), info.name.slice(0, 100), imageUrl);

    const asset = contract
      ? db.prepare(`SELECT * FROM assets WHERE provider = ? AND platform = ? AND contract_address = ?`).get(priceProvider.name, platform, contract)
      : db.prepare(`SELECT * FROM assets WHERE provider = ? AND provider_id = ? AND contract_address = ''`).get(priceProvider.name, providerId);
    res.status(201).json({ asset: publicAsset(asset) });
  });

  // ---------- transactions ----------
  function parseFilters(query) {
    return {
      accountId: query.accountId ? v.parseId(query.accountId, 'Account') : null,
      assetId: query.assetId ? v.parseId(query.assetId, 'Cryptocurrency') : null,
    };
  }

  function filteredTransactions(userId, { accountId, assetId }) {
    let sql = 'SELECT * FROM transactions WHERE user_id = ?';
    const args = [userId];
    if (accountId) {
      sql += ' AND account_id = ?';
      args.push(accountId);
    }
    if (assetId) {
      sql += ' AND asset_id = ?';
      args.push(assetId);
    }
    return db.prepare(sql + ' ORDER BY tx_date DESC, id DESC').all(...args);
  }

  const publicTransaction = (r) => ({
    id: r.id,
    type: r.type,
    assetId: r.asset_id,
    accountId: r.account_id,
    quantity: r.quantity,
    price: r.price,
    fee: r.fee,
    amount: r.amount,
    // Money spent (buy) or received (sell), excluding fees.
    total: r.amount ?? new D(r.quantity).times(r.price).toFixed(),
    currency: r.currency,
    date: r.tx_date,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  app.get('/api/transactions', (req, res) => {
    const rows = filteredTransactions(req.user.id, parseFilters(req.query));
    res.json({ transactions: rows.map(publicTransaction) });
  });

  app.post('/api/transactions', (req, res) => {
    const userId = req.user.id;
    const input = v.parseTransactionInput(req.body);
    getOwnedAccount(userId, input.accountId);
    getAsset(input.assetId);

    const row = withTransaction(db, () => {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO transactions (user_id, account_id, asset_id, type, quantity, price, amount, fee, currency, tx_date, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(userId, input.accountId, input.assetId, input.type, input.quantity, input.price, input.amount, input.fee ?? '0',
          req.user.reporting_currency, input.date, input.notes);
      assertLedger(q.userTxForAssets(userId, [input.assetId])); // throws -> rollback
      return q.transaction.get(lastInsertRowid, userId);
    });
    res.status(201).json({ transaction: publicTransaction(row) });
  });

  app.put('/api/transactions/:id', (req, res) => {
    const userId = req.user.id;
    const existing = q.transaction.get(v.parseId(req.params.id, 'Transaction'), userId);
    if (!existing) throw httpError(404, 'Transaction not found');
    const input = v.parseTransactionInput(req.body);
    getOwnedAccount(userId, input.accountId);
    getAsset(input.assetId);

    const row = withTransaction(db, () => {
      db.prepare(
        `UPDATE transactions SET account_id = ?, asset_id = ?, type = ?, quantity = ?, price = ?, amount = ?, fee = ?,
           tx_date = ?, notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ? AND user_id = ?`,
      // The form no longer has a fee field: an edit that omits fee keeps the existing one.
      ).run(input.accountId, input.assetId, input.type, input.quantity, input.price, input.amount,
        input.fee ?? existing.fee, input.date,
        input.notes, existing.id, userId);
      assertLedger(q.userTxForAssets(userId, [...new Set([existing.asset_id, input.assetId])]));
      return q.transaction.get(existing.id, userId);
    });
    res.json({ transaction: publicTransaction(row) });
  });

  app.delete('/api/transactions/:id', (req, res) => {
    const userId = req.user.id;
    const existing = q.transaction.get(v.parseId(req.params.id, 'Transaction'), userId);
    if (!existing) throw httpError(404, 'Transaction not found');
    withTransaction(db, () => {
      db.prepare('DELETE FROM transactions WHERE id = ? AND user_id = ?').run(existing.id, userId);
      assertLedger(q.userTxForAssets(userId, [existing.asset_id]));
    });
    res.json({ ok: true });
  });

  // ---------- portfolio ----------
  app.get('/api/portfolio', async (req, res) => {
    const user = req.user;
    const filters = parseFilters(req.query);
    const rows = filteredTransactions(user.id, filters).filter((r) => r.currency === user.reporting_currency);
    const includeFees = Boolean(user.include_fees_in_cost_basis);

    // First pass without prices to find which assets are still held.
    const base = computePortfolio({ transactions: rows.map(toCalcTx), includeFeesInCostBasis: includeFees });
    const heldAssets = base.holdings.map((h) => q.asset.get(h.assetId));

    const { prices, error } = await priceService.getPrices(heldAssets, user.reporting_currency, {
      forceRefresh: req.query.refresh === '1',
    });
    const portfolio = computePortfolio({ transactions: rows.map(toCalcTx), prices, includeFeesInCostBasis: includeFees });

    const assetById = new Map(heldAssets.map((a) => [a.id, a]));
    const holdings = portfolio.holdings
      .map((h) => {
        const p = prices.get(h.assetId);
        return {
          ...h,
          asset: publicAsset(assetById.get(h.assetId)),
          priceStatus: p.status,
          priceUpdatedAt: p.providerUpdatedAt || p.fetchedAt,
          priceFetchedAt: p.fetchedAt,
        };
      })
      .sort((a, b) => (a.asset.name < b.asset.name ? -1 : 1));

    const updatedTimes = holdings.map((h) => h.priceUpdatedAt).filter(Boolean).sort();
    res.json({
      currency: user.reporting_currency,
      includeFeesInCostBasis: includeFees,
      costMethod: 'weighted-average',
      priceProvider: priceProvider.name,
      priceError: error,
      pricesUpdatedAt: { oldest: updatedTimes[0] || null, newest: updatedTimes.at(-1) || null },
      holdings,
      totals: {
        ...portfolio.totals,
        missingPriceAssets: portfolio.totals.missingPriceAssetIds.map((id) => publicAsset(assetById.get(id))),
      },
      generatedAt: new Date().toISOString(),
    });
  });

  // ---------- static frontend ----------
  app.use('/api', (_req, _res, next) => next(httpError(404, 'Not found')));
  // `no-cache` makes the browser revalidate (cheap 304s via ETag) on every load, so after an
  // update it never pairs a stale cached app.js with a newer index.html.
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      index: 'index.html',
      setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
    }),
  );

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    let status = err.status || 500;
    if (err instanceof ProviderError) status = 502;
    if (status >= 500 && status !== 502) console.error(err);
    res.status(status).json({
      error: status >= 500 && status !== 502 ? 'Something went wrong' : err.message,
      field: err.field,
    });
  });

  return app;
}

module.exports = { createApp };
