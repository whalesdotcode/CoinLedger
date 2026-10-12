'use strict';

const { D } = require('./calc');

class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.field = field;
  }
}

// Plain decimal notation only: no signs, exponents, commas, or hex.
const DECIMAL_RE = /^\d{1,24}(\.\d{1,18})?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CURRENCY_RE = /^[a-z]{3,5}$/;
const EARLIEST_DATE = '2009-01-03'; // Bitcoin genesis block

function parseDecimal(value, field, { allowZero = false, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (!required) return '0';
    throw new ValidationError(`${field} is required`, field);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError(`${field} must be a number`, field);
    value = new D(value).toFixed();
  }
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a number`, field);
  const s = value.trim();
  if (s.startsWith('-')) throw new ValidationError(`${field} cannot be negative`, field);
  if (!DECIMAL_RE.test(s)) {
    throw new ValidationError(`${field} must be a plain decimal number (up to 18 decimal places)`, field);
  }
  const d = new D(s);
  if (!allowZero && d.isZero()) throw new ValidationError(`${field} must be greater than zero`, field);
  return d.toFixed();
}

function parseDate(value, field = 'Date') {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    throw new ValidationError(`${field} must be in YYYY-MM-DD format`, field);
  }
  const [, y, m, d] = DATE_RE.exec(value).map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new ValidationError(`${field} is not a valid calendar date`, field);
  }
  if (value < EARLIEST_DATE) throw new ValidationError(`${field} cannot be before ${EARLIEST_DATE}`, field);
  // Allow one day of slack for users ahead of UTC.
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  if (value > tomorrow) throw new ValidationError(`${field} cannot be in the future`, field);
  return value;
}

function parseId(value, field) {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n <= 0) throw new ValidationError(`${field} is required`, field);
  return n;
}

function parseText(value, field, { max = 100, required = true } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new ValidationError(`${field} must be text`, field);
  const s = value.trim();
  if (required && !s) throw new ValidationError(`${field} is required`, field);
  if (s.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, field);
  return s;
}

function parseEmail(value) {
  const s = parseText(value, 'Email', { max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(s)) throw new ValidationError('Enter a valid email address', 'email');
  return s;
}

function parsePassword(value) {
  if (typeof value !== 'string' || value.length < 8) {
    throw new ValidationError('Password must be at least 8 characters', 'password');
  }
  if (value.length > 72) throw new ValidationError('Password must be at most 72 characters', 'password');
  return value;
}

function parseCurrency(value) {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!CURRENCY_RE.test(s)) throw new ValidationError('Reporting currency must be a currency code such as usd', 'currency');
  return s;
}

/**
 * Coins received for an amount of money at a price, to 18 decimal places.
 * Rounded down so a computed quantity can never exceed what was actually bought.
 */
function quantityFromAmount(amount, price) {
  return new D(amount).div(price).toDecimalPlaces(18, D.ROUND_DOWN).toFixed();
}

function parseTransactionInput(body = {}) {
  const type = body.type === undefined ? 'buy' : body.type;
  if (type !== 'buy' && type !== 'sell') throw new ValidationError('Type must be "buy" or "sell"', 'type');
  let amount = null;
  let quantity;
  let price;
  if (body.amount !== undefined && body.amount !== null && body.amount !== '') {
    // Amount-based entry (what the UI sends): quantity = amount / price.
    // Any quantity sent alongside is ignored; the server's calculation is authoritative.
    amount = parseDecimal(body.amount, 'Amount');
    price = parseDecimal(body.price, 'Price per coin');
    quantity = quantityFromAmount(amount, price);
    if (new D(quantity).isZero()) {
      throw new ValidationError('Amount is too small for this price (less than 0.000000000000000001 coins)', 'amount');
    }
  } else {
    // Quantity-based entry, kept for API clients.
    quantity = parseDecimal(body.quantity, 'Quantity');
    price = parseDecimal(body.price, 'Price per coin', { allowZero: true });
  }
  return {
    type,
    assetId: parseId(body.assetId, 'Cryptocurrency'),
    accountId: parseId(body.accountId, 'Account'),
    amount,
    quantity,
    price,
    fee: body.fee === undefined ? undefined : parseDecimal(body.fee, 'Fees', { allowZero: true, required: false }),
    date: parseDate(body.date, 'Transaction date'),
    notes: parseText(body.notes, 'Notes', { max: 500, required: false }),
  };
}

module.exports = {
  ValidationError,
  parseDecimal,
  parseDate,
  parseId,
  parseText,
  parseEmail,
  parsePassword,
  parseCurrency,
  parseTransactionInput,
  quantityFromAmount,
};
