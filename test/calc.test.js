'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computePortfolio, buildPositions, averageEntryPrice, validateLedger } = require('../src/calc');

let nextId = 1;
const buy = (assetId, quantity, price, fee = '0', date = '2024-01-01', accountId = 1) =>
  ({ id: nextId++, type: 'buy', assetId, accountId, quantity, price, fee, date });
const sell = (assetId, quantity, price, fee = '0', date = '2024-06-01', accountId = 1) =>
  ({ id: nextId++, type: 'sell', assetId, accountId, quantity, price, fee, date });
const prices = (obj) => new Map(Object.entries(obj).map(([k, price]) => [Number(k), { price }]));

test('average entry price: 1 @ 100 and 2 @ 130 => 120', () => {
  const { holdings } = computePortfolio({ transactions: [buy(1, '1', '100'), buy(1, '2', '130')] });
  assert.equal(holdings[0].averageEntryPrice, '120');
  assert.equal(holdings[0].quantity, '3');
  assert.equal(holdings[0].costBasis, '360');
});

test('average entry price updates with every purchase', () => {
  const txs = [buy(1, '1', '100')];
  assert.equal(computePortfolio({ transactions: txs }).holdings[0].averageEntryPrice, '100');
  txs.push(buy(1, '2', '130'));
  assert.equal(computePortfolio({ transactions: txs }).holdings[0].averageEntryPrice, '120');
  txs.push(buy(1, '1', '200'));
  // (100 + 260 + 200) / 4 = 140
  assert.equal(computePortfolio({ transactions: txs }).holdings[0].averageEntryPrice, '140');
});

test('average entry price uses exact decimals, not floats', () => {
  // Classic float trap: 0.1 + 0.2 != 0.3
  const { holdings } = computePortfolio({ transactions: [buy(1, '0.1', '3'), buy(1, '0.2', '3')] });
  assert.equal(holdings[0].quantity, '0.3');
  assert.equal(holdings[0].costBasis, '0.9');
  assert.equal(holdings[0].averageEntryPrice, '3');

  const tiny = computePortfolio({ transactions: [buy(1, '0.000000000000000001', '0.00000123')] });
  assert.equal(tiny.holdings[0].quantity, '0.000000000000000001');
  assert.equal(tiny.holdings[0].averageEntryPrice, '0.00000123');
});

test('repeating-decimal averages are rounded, not truncated to floats', () => {
  // (1*1 + 2*2) / 3 = 1.6666...
  const { holdings } = computePortfolio({ transactions: [buy(1, '1', '1'), buy(1, '2', '2')] });
  assert.equal(holdings[0].averageEntryPrice, '1.666666666667');
  assert.equal(holdings[0].costBasis, '5');
});

test('fees are excluded from the average entry price', () => {
  const { holdings } = computePortfolio({
    transactions: [buy(1, '1', '100', '5'), buy(1, '2', '130', '10')],
  });
  assert.equal(holdings[0].averageEntryPrice, '120');
  assert.equal(holdings[0].feesPaid, '15');
});

test('fees are excluded from cost basis by default', () => {
  const { holdings, totals } = computePortfolio({
    transactions: [buy(1, '1', '100', '5'), buy(1, '2', '130', '10')],
    prices: prices({ 1: '150' }),
  });
  assert.equal(holdings[0].costBasis, '360');
  assert.equal(holdings[0].unrealizedPL, '90'); // 450 - 360
  assert.equal(totals.feesPaid, '15');
});

test('fees can be included in cost basis without changing average entry price', () => {
  const { holdings } = computePortfolio({
    transactions: [buy(1, '1', '100', '5'), buy(1, '2', '130', '10')],
    prices: prices({ 1: '150' }),
    includeFeesInCostBasis: true,
  });
  assert.equal(holdings[0].averageEntryPrice, '120');
  assert.equal(holdings[0].costBasis, '375'); // 360 + 15
  assert.equal(holdings[0].unrealizedPL, '75'); // 450 - 375
  assert.equal(holdings[0].unrealizedPLPct, '20');
});

test('unrealized P/L = market value - cost basis, in currency and percent', () => {
  const { holdings } = computePortfolio({
    transactions: [buy(1, '1', '100'), buy(1, '2', '130')],
    prices: prices({ 1: '150' }),
  });
  const h = holdings[0];
  assert.equal(h.marketPrice, '150');
  assert.equal(h.marketValue, '450');
  assert.equal(h.unrealizedPL, '90');
  assert.equal(h.unrealizedPLPct, '25'); // 90 / 360
});

test('unrealized loss is negative', () => {
  const { holdings } = computePortfolio({ transactions: [buy(1, '2', '50')], prices: prices({ 1: '40' }) });
  assert.equal(holdings[0].unrealizedPL, '-20');
  assert.equal(holdings[0].unrealizedPLPct, '-20');
});

test('portfolio % uses total cost basis, not the average of per-coin percentages', () => {
  const { holdings, totals } = computePortfolio({
    transactions: [buy(1, '10', '100'), buy(2, '1', '3000')],
    prices: prices({ 1: '150', 2: '2700' }),
  });
  assert.equal(holdings.find((h) => h.assetId === 1).unrealizedPLPct, '50');
  assert.equal(holdings.find((h) => h.assetId === 2).unrealizedPLPct, '-10');
  // Average of percentages would wrongly give 20%.
  assert.equal(totals.totalCostBasis, '4000');
  assert.equal(totals.currentValue, '4200');
  assert.equal(totals.unrealizedPL, '200');
  assert.equal(totals.unrealizedPLPct, '5');
  assert.equal(totals.complete, true);
});

test('missing price is not treated as zero and marks totals incomplete', () => {
  const { holdings, totals } = computePortfolio({
    transactions: [buy(1, '10', '100'), buy(2, '1', '3000')],
    prices: prices({ 1: '150' }), // no price for asset 2
  });
  const missing = holdings.find((h) => h.assetId === 2);
  assert.equal(missing.priceAvailable, false);
  assert.equal(missing.marketValue, null);
  assert.equal(missing.unrealizedPL, null);
  assert.equal(missing.costBasis, '3000');

  assert.equal(totals.complete, false);
  assert.deepEqual(totals.missingPriceAssetIds, [2]);
  assert.equal(totals.totalCostBasis, '4000');
  assert.equal(totals.pricedCostBasis, '1000');
  assert.equal(totals.currentValue, '1500');
  // P/L only over priced holdings; treating the missing price as 0 would give -2500.
  assert.equal(totals.unrealizedPL, '500');
  assert.equal(totals.unrealizedPLPct, '50');
});

test('sell removes coins at average cost; remaining cost basis and average unchanged', () => {
  const { holdings, totals } = computePortfolio({
    transactions: [buy(1, '1', '100'), buy(1, '2', '130'), sell(1, '1', '200')],
    prices: prices({ 1: '150' }),
  });
  const h = holdings[0];
  assert.equal(h.quantity, '2');
  assert.equal(h.averageEntryPrice, '120');
  assert.equal(h.costBasis, '240'); // cost basis of the remaining holdings
  assert.equal(h.unrealizedPL, '60'); // 300 - 240
  assert.equal(totals.realizedPL, '80'); // 200 - 120
});

test('fully sold positions disappear from holdings but keep realized P/L', () => {
  const { holdings, totals } = computePortfolio({
    transactions: [buy(1, '1', '100'), sell(1, '1', '90')],
  });
  assert.equal(holdings.length, 0);
  assert.equal(totals.realizedPL, '-10');
  assert.equal(totals.totalCostBasis, '0');
  assert.equal(totals.unrealizedPLPct, null);
});

test('recalculation after edit or delete is deterministic', () => {
  const a = buy(1, '1', '100');
  const b = buy(1, '2', '130');
  assert.equal(averageEntryPrice(buildPositions([a, b]).get(1)).toFixed(), '120');
  // edit b's price
  assert.equal(averageEntryPrice(buildPositions([a, { ...b, price: '160' }]).get(1)).toFixed(), '140');
  // delete b
  assert.equal(averageEntryPrice(buildPositions([a]).get(1)).toFixed(), '100');
});

test('transaction order: out-of-order input is processed chronologically', () => {
  const later = buy(1, '1', '200', '0', '2024-03-01');
  const earlier = buy(1, '1', '100', '0', '2024-01-01');
  const s = sell(1, '1', '150', '0', '2024-02-01');
  // Sell happens after the 100 buy only, so it removes that coin at avg 100.
  const { holdings, totals } = computePortfolio({ transactions: [later, s, earlier] });
  assert.equal(holdings[0].averageEntryPrice, '200');
  assert.equal(totals.realizedPL, '50');
});

test('ledger validation rejects selling more than held at that date, per account', () => {
  assert.equal(validateLedger([buy(1, '1', '100'), sell(1, '1', '100')]), null);
  assert.match(validateLedger([buy(1, '1', '100'), sell(1, '1.5', '100')]).message, /exceeds/);
  // Sell dated before the buy
  assert.ok(validateLedger([buy(1, '1', '100', '0', '2024-05-01'), sell(1, '1', '100', '0', '2024-04-01')]));
  // Coins in account 1 cannot be sold from account 2
  assert.ok(validateLedger([buy(1, '1', '100', '0', '2024-01-01', 1), sell(1, '1', '100', '0', '2024-02-01', 2)]));
});

test('negative or zero quantities and negative prices are rejected by the engine', () => {
  assert.throws(() => buildPositions([buy(1, '0', '100')]));
  assert.throws(() => buildPositions([buy(1, '-1', '100')]));
  assert.throws(() => buildPositions([buy(1, '1', '-100')]));
  assert.throws(() => buildPositions([buy(1, '1', '100', '-1')]));
});

// ---- amount-based entry: user enters money spent + price, quantity is derived ----
const { quantityFromAmount } = require('../src/validation');
const buyAmount = (assetId, amount, price, date = '2024-01-01') =>
  ({ id: nextId++, type: 'buy', assetId, accountId: 1, amount, price, quantity: quantityFromAmount(amount, price), fee: '0', date });

test('quantity is calculated as amount / price', () => {
  assert.equal(quantityFromAmount('100', '100'), '1');
  assert.equal(quantityFromAmount('260', '130'), '2');
  assert.equal(quantityFromAmount('500', '62500'), '0.008');
  // Non-terminating: rounded DOWN to 18 dp so it never exceeds what was bought
  assert.equal(quantityFromAmount('100', '3'), '33.333333333333333333');
  assert.equal(quantityFromAmount('200', '3'), '66.666666666666666666');
});

test('amount-based buys: $100 @ $100 and $260 @ $130 => average entry price 120', () => {
  const { holdings } = computePortfolio({
    transactions: [buyAmount(1, '100', '100'), buyAmount(1, '260', '130')],
    prices: prices({ 1: '150' }),
  });
  assert.equal(holdings[0].quantity, '3');
  assert.equal(holdings[0].averageEntryPrice, '120');
  assert.equal(holdings[0].costBasis, '360');
  assert.equal(holdings[0].unrealizedPL, '90');
});

test('cost basis equals the exact amount entered even when quantity is rounded', () => {
  const { holdings } = computePortfolio({
    transactions: [buyAmount(1, '100', '3')],
    prices: prices({ 1: '3' }),
  });
  assert.equal(holdings[0].costBasis, '100'); // not 99.999999999999999999
  assert.equal(holdings[0].quantity, '33.333333333333333333');
  assert.equal(holdings[0].averageEntryPrice, '3');
});
