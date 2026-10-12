'use strict';

/**
 * Portfolio math. Pure functions only — no I/O — so every number shown in the
 * UI can be unit tested. All arithmetic uses decimal.js; JavaScript floats are
 * never used for quantities, prices, fees, or totals.
 *
 * Cost method: moving weighted average.
 *   - Average entry price = cost of held coins (excluding fees) / quantity held.
 *     With only purchases this is exactly "total purchase cost / total quantity
 *     purchased" (1 @ 100 + 2 @ 130 => 360 / 3 = 120).
 *   - A sell removes coins at the current average cost, so it does not change
 *     the average entry price of what remains.
 *   - Fees never affect the average entry price. Whether they are added to the
 *     cost basis is a user setting (includeFeesInCostBasis).
 */

const DecimalBase = require('decimal.js');

const D = DecimalBase.clone({
  precision: 60,
  rounding: DecimalBase.ROUND_HALF_UP,
  toExpNeg: -80,
  toExpPos: 80,
});

const ZERO = new D(0);
const HUNDRED = new D(100);

// Output precision: generous enough to never hide value, small enough to read.
const QTY_DP = 18;
const MONEY_DP = 12;
const PCT_DP = 6;

class LedgerError extends Error {
  constructor(message, transactionId) {
    super(message);
    this.name = 'LedgerError';
    this.transactionId = transactionId;
  }
}

const out = (d, dp) => (d === null || d === undefined ? null : d.toDecimalPlaces(dp).toFixed());

/** Chronological order; same-day buys before sells; then insertion order. */
function sortTransactions(transactions) {
  return [...transactions].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.type !== b.type) return a.type === 'buy' ? -1 : 1;
    return (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER);
  });
}

function emptyPosition() {
  return {
    quantity: ZERO, // coins currently held
    principal: ZERO, // purchase cost (excl. fees) of the coins currently held
    feeBasis: ZERO, // purchase fees attributable to the coins currently held
    boughtQuantity: ZERO,
    boughtCost: ZERO,
    feesPaid: ZERO, // every fee ever paid on this asset (buys and sells)
    realizedPL: ZERO,
    transactionCount: 0,
  };
}

function applyTransaction(pos, tx, { includeFeesInCostBasis = false } = {}) {
  const quantity = new D(tx.quantity);
  const price = new D(tx.price);
  const fee = new D(tx.fee ?? 0);

  if (!quantity.isFinite() || quantity.lte(0)) throw new LedgerError('Quantity must be greater than zero', tx.id);
  if (!price.isFinite() || price.lt(0)) throw new LedgerError('Price cannot be negative', tx.id);
  if (!fee.isFinite() || fee.lt(0)) throw new LedgerError('Fee cannot be negative', tx.id);

  pos.feesPaid = pos.feesPaid.plus(fee);
  pos.transactionCount += 1;
  // When the user entered the money amount, that exact amount is the cost/proceeds
  // (the quantity was derived from it); otherwise cost = quantity x price.
  const gross = tx.amount !== null && tx.amount !== undefined ? new D(tx.amount) : quantity.times(price);
  if (!gross.isFinite() || gross.lt(0)) throw new LedgerError('Amount cannot be negative', tx.id);

  if (tx.type === 'buy') {
    pos.quantity = pos.quantity.plus(quantity);
    pos.principal = pos.principal.plus(gross);
    pos.feeBasis = pos.feeBasis.plus(fee);
    pos.boughtQuantity = pos.boughtQuantity.plus(quantity);
    pos.boughtCost = pos.boughtCost.plus(gross);
    return pos;
  }

  if (tx.type !== 'sell') throw new LedgerError(`Unknown transaction type "${tx.type}"`, tx.id);

  if (quantity.gt(pos.quantity)) {
    throw new LedgerError(
      `Sell of ${quantity.toFixed()} on ${tx.date} exceeds the ${pos.quantity.toFixed()} held at that date`,
      tx.id,
    );
  }

  const closesPosition = quantity.eq(pos.quantity);
  const share = quantity.div(pos.quantity);
  const removedPrincipal = closesPosition ? pos.principal : pos.principal.times(share);
  const removedFees = closesPosition ? pos.feeBasis : pos.feeBasis.times(share);

  pos.quantity = pos.quantity.minus(quantity);
  pos.principal = closesPosition ? ZERO : pos.principal.minus(removedPrincipal);
  pos.feeBasis = closesPosition ? ZERO : pos.feeBasis.minus(removedFees);

  let realized = gross.minus(removedPrincipal);
  if (includeFeesInCostBasis) realized = realized.minus(removedFees).minus(fee);
  pos.realizedPL = pos.realizedPL.plus(realized);
  return pos;
}

/** Weighted average entry price of the coins held, or null if none are held. */
function averageEntryPrice(pos) {
  return pos.quantity.gt(0) ? pos.principal.div(pos.quantity) : null;
}

function costBasis(pos, { includeFeesInCostBasis = false } = {}) {
  return includeFeesInCostBasis ? pos.principal.plus(pos.feeBasis) : pos.principal;
}

/** Map of assetId -> position, built from transactions across any accounts given. */
function buildPositions(transactions, opts = {}) {
  const positions = new Map();
  for (const tx of sortTransactions(transactions)) {
    if (!positions.has(tx.assetId)) positions.set(tx.assetId, emptyPosition());
    applyTransaction(positions.get(tx.assetId), tx, opts);
  }
  return positions;
}

/**
 * Checks that every account's balance of every asset stays >= 0 over time
 * (you cannot sell coins an account did not hold on that date).
 * Returns null when valid, or { message, transactionId }.
 */
function validateLedger(transactions) {
  const groups = new Map();
  for (const tx of transactions) {
    const key = `${tx.accountId}:${tx.assetId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(tx);
  }
  for (const txs of groups.values()) {
    try {
      buildPositions(txs);
    } catch (err) {
      if (err instanceof LedgerError) return { message: err.message, transactionId: err.transactionId };
      throw err;
    }
  }
  return null;
}

/**
 * Full portfolio view.
 * @param {object} p
 * @param {Array}  p.transactions  [{ id, assetId, accountId, type, quantity, price, amount?, fee, date }]
 * @param {Map}    p.prices        assetId -> { price: string } (missing/null price = unavailable)
 * @param {boolean} p.includeFeesInCostBasis
 */
function computePortfolio({ transactions, prices = new Map(), includeFeesInCostBasis = false }) {
  const opts = { includeFeesInCostBasis };
  const positions = buildPositions(transactions, opts);

  const holdings = [];
  let totalCostBasis = ZERO;
  let pricedCostBasis = ZERO;
  let currentValue = ZERO;
  let realizedPL = ZERO;
  let feesPaid = ZERO;
  const missingPrices = [];

  for (const [assetId, pos] of positions) {
    realizedPL = realizedPL.plus(pos.realizedPL);
    feesPaid = feesPaid.plus(pos.feesPaid);
    if (pos.quantity.lte(0)) continue;

    const basis = costBasis(pos, opts);
    const priceInfo = prices.get(assetId);
    const hasPrice = priceInfo && priceInfo.price !== null && priceInfo.price !== undefined;

    let marketPrice = null;
    let marketValue = null;
    let unrealized = null;
    let unrealizedPct = null;

    totalCostBasis = totalCostBasis.plus(basis);

    if (hasPrice) {
      marketPrice = new D(priceInfo.price);
      marketValue = pos.quantity.times(marketPrice);
      unrealized = marketValue.minus(basis);
      unrealizedPct = basis.gt(0) ? unrealized.div(basis).times(HUNDRED) : null;
      pricedCostBasis = pricedCostBasis.plus(basis);
      currentValue = currentValue.plus(marketValue);
    } else {
      // A missing price is never treated as zero: the holding is left out of
      // value and P/L totals, and the totals are flagged as incomplete.
      missingPrices.push(assetId);
    }

    holdings.push({
      assetId,
      quantity: out(pos.quantity, QTY_DP),
      averageEntryPrice: out(averageEntryPrice(pos), MONEY_DP),
      costBasis: out(basis, MONEY_DP),
      feesInCostBasis: out(includeFeesInCostBasis ? pos.feeBasis : ZERO, MONEY_DP),
      feesPaid: out(pos.feesPaid, MONEY_DP),
      marketPrice: out(marketPrice, MONEY_DP),
      marketValue: out(marketValue, MONEY_DP),
      unrealizedPL: out(unrealized, MONEY_DP),
      unrealizedPLPct: out(unrealizedPct, PCT_DP),
      realizedPL: out(pos.realizedPL, MONEY_DP),
      priceAvailable: Boolean(hasPrice),
    });
  }

  const unrealizedPL = currentValue.minus(pricedCostBasis);
  // Total % is computed from total cost basis — never an average of per-coin %s.
  const unrealizedPLPct = pricedCostBasis.gt(0) ? unrealizedPL.div(pricedCostBasis).times(HUNDRED) : null;

  return {
    holdings,
    totals: {
      totalCostBasis: out(totalCostBasis, MONEY_DP),
      pricedCostBasis: out(pricedCostBasis, MONEY_DP),
      currentValue: out(currentValue, MONEY_DP),
      unrealizedPL: out(unrealizedPL, MONEY_DP),
      unrealizedPLPct: out(unrealizedPLPct, PCT_DP),
      realizedPL: out(realizedPL, MONEY_DP),
      feesPaid: out(feesPaid, MONEY_DP),
      complete: missingPrices.length === 0,
      missingPriceAssetIds: missingPrices,
      holdingCount: holdings.length,
    },
  };
}

module.exports = {
  D,
  LedgerError,
  sortTransactions,
  emptyPosition,
  applyTransaction,
  averageEntryPrice,
  costBasis,
  buildPositions,
  validateLedger,
  computePortfolio,
};
