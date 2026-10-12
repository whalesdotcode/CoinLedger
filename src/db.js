'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Monetary values are stored as TEXT decimal strings so SQLite never rounds them.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                         INTEGER PRIMARY KEY,
  email                      TEXT NOT NULL UNIQUE,
  password_hash              TEXT NOT NULL,
  reporting_currency         TEXT NOT NULL DEFAULT 'usd',
  include_fees_in_cost_basis INTEGER NOT NULL DEFAULT 0,
  created_at                 TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Wallets / exchanges a user holds coins in (e.g. "Coinbase", "Ledger").
CREATE TABLE IF NOT EXISTS accounts (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, name COLLATE NOCASE)
);

-- Shared catalogue of assets, identified by price-provider ID (and network +
-- contract address for tokens) rather than by ticker symbol.
CREATE TABLE IF NOT EXISTS assets (
  id               INTEGER PRIMARY KEY,
  provider         TEXT NOT NULL,
  provider_id      TEXT NOT NULL DEFAULT '',
  platform         TEXT NOT NULL DEFAULT '',
  contract_address TEXT NOT NULL DEFAULT '',
  symbol           TEXT NOT NULL,
  name             TEXT NOT NULL,
  image_url        TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (provider, provider_id, platform, contract_address)
);

CREATE TABLE IF NOT EXISTS transactions (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  asset_id   INTEGER NOT NULL REFERENCES assets(id),
  type       TEXT NOT NULL CHECK (type IN ('buy','sell')),
  quantity   TEXT NOT NULL,
  price      TEXT NOT NULL,
  fee        TEXT NOT NULL DEFAULT '0',
  currency   TEXT NOT NULL,
  tx_date    TEXT NOT NULL,
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS transactions_user ON transactions(user_id, asset_id);

CREATE TABLE IF NOT EXISTS price_cache (
  asset_id            INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  currency            TEXT NOT NULL,
  price               TEXT NOT NULL,
  provider_updated_at TEXT,
  fetched_at          INTEGER NOT NULL,
  PRIMARY KEY (asset_id, currency)
);
`;

function openDb(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive migrations for databases created by earlier versions. */
function migrate(db) {
  const txCols = db.prepare('PRAGMA table_info(transactions)').all().map((c) => c.name);
  // Money amount the user entered (cost for buys, proceeds for sells). NULL for
  // quantity-based entries, where the amount is quantity x price.
  if (!txCols.includes('amount')) db.exec('ALTER TABLE transactions ADD COLUMN amount TEXT');
}

/** Run fn inside a single SQLite transaction. */
function withTransaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, withTransaction };
