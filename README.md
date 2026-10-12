# CoinLedger

CoinLedger is a self-hosted cryptocurrency portfolio tracker. You record your purchases (and sales), and it works out your weighted average entry price, cost basis, and unrealized profit/loss for each coin and for the whole portfolio, using live prices from CoinGecko.

- **Accounts and privacy:** you sign up with an email and password. Every query is scoped to the signed-in user, and each transaction is filed under a wallet or exchange "account" (Coinbase, Ledger, …).
- **Transactions:** buy or sell. You enter the coin, the **amount** you spent or received (in your reporting currency), the **price per coin**, the date, the account and optional notes. CoinLedger calculates the **quantity** as amount ÷ price. You can edit or delete any entry, and holdings are recalculated from the full ledger after every change.
- **Average entry price:** total purchase cost ÷ total quantity purchased. For example, $100 at $100 (1 coin) plus $260 at $130 (2 coins) gives **$120**.
- **Holdings:** quantity, average entry price, cost basis, current price, market value, and unrealized P/L in both currency and %. The P/L sits beside each coin, in green or red, with ▲ Gain / ▼ Loss labels so the colour is never the only cue.
- **Totals:** total cost basis, current value, and combined unrealized P/L. The total % is computed from total cost basis, never by averaging per-coin percentages. You can filter by account and by cryptocurrency.
- **Prices:** coins are identified by CoinGecko coin ID (e.g. `bitcoin`). Tokens are identified by network + contract address (e.g. `ethereum` + `0xa0b8…`), never by ticker alone. The UI shows when prices were last updated. If a price is missing, that holding is marked **Unavailable**, the totals are flagged **incomplete**, and the holding is left out of value and P/L (it is never counted as zero).

## Requirements

- **Node.js 22.13 or newer** (uses the built-in `node:sqlite`; no native modules to compile). Tested on Node 23.11.
- Optional but recommended: a free CoinGecko **Demo API key** from <https://www.coingecko.com/en/api>. Without a key the app falls back to CoinGecko's keyless public API, which works but has tight rate limits.

## Setup

```bash
cd CoinLedger
npm install
cp .env.example .env        # then edit .env and set COINGECKO_API_KEY
npm start
```

Open <http://localhost:3000>, choose **Create account**, and add your first transaction. A default account called "Main" is created for you; add more under **Accounts**.

Other commands:

```bash
npm test     # run the test suite (no network access needed)
npm run dev  # restart automatically on file changes
```

### Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `./data/coinledger.db` | SQLite file (created automatically) |
| `DEFAULT_CURRENCY` | `usd` | Reporting currency for new users (any CoinGecko `vs_currency`) |
| `COINGECKO_PLAN` | `demo` | `demo`, `pro`, or `public` (keyless) |
| `COINGECKO_API_KEY` | *(empty)* | Provider key. Read only by the server, never sent to the browser |
| `PRICE_TTL_SECONDS` | `60` | How long a fetched price is reused |
| `NODE_ENV` | `development` | Set to `production` behind HTTPS so cookies are `Secure` |
| `TRUST_PROXY` | `false` | Set to `true` when running behind a reverse proxy |
| `ALLOW_REGISTRATION` | `true` | Set to `false` after creating your own account to close sign-ups |

Each user can change their reporting currency in **Settings**, but only while they have no transactions recorded in a different currency. CoinLedger does not convert the prices you entered between currencies, so allowing the change later would silently mix currencies.

## How the numbers are calculated

All arithmetic uses [`decimal.js`](https://mikemcl.github.io/decimal.js/) with 60 significant digits. Values are stored as decimal **strings** in SQLite and returned to the browser as strings, so floats are never used for money. Inputs accept up to 18 decimal places. Negative or zero amounts, zero or negative prices (you can't divide by zero), malformed numbers, impossible dates and future dates are all rejected.

**Quantity from amount:** quantity = amount ÷ price, rounded **down** to 18 decimal places so it never exceeds what was actually bought. The cost basis of that purchase is the exact amount you entered: $100 at $3 gives 33.333333333333333333 coins with a cost basis of exactly $100.00, not $99.99…

**Cost method: moving weighted average**

| Value | Formula |
|---|---|
| Average entry price | purchase cost of coins held (excl. fees) ÷ quantity held. With purchases only, this is exactly *total purchase cost ÷ total quantity purchased*. |
| Cost basis | quantity held × average entry price (+ attributable purchase fees if you turn that setting on) |
| Market value | quantity held × current price |
| Unrealized P/L | market value − cost basis of the remaining holdings |
| Unrealized P/L % | unrealized P/L ÷ cost basis × 100 |
| Portfolio P/L % | Σ unrealized P/L ÷ Σ cost basis × 100 (of priced holdings) |

- **Fees:** the entry form has no fee field. The API still accepts an optional `fee` (it never affects the average entry price), and the UI only shows a Fees column if an older entry has one. Editing a transaction keeps any existing fee.
- **Sells** remove coins at the current average cost. The average entry price of what remains does not change, and the difference is reported as realized P/L. A sell is rejected if the account did not hold enough of that coin on that date. Edits and deletes are validated the same way: you cannot delete a buy that a later sell depends on.
- **Missing prices:** the holding still shows its quantity and cost basis, but market value and P/L show "Unavailable". The totals carry an *incomplete* flag, and portfolio P/L is computed only over holdings that have a price, against those holdings' cost basis. If the provider is down, the last cached price is shown and the outage is reported. Prices older than 15 minutes are labelled *stale*.

## Security

- Passwords are hashed with bcrypt (cost 12). Logins are rate limited, and the server takes the same time to answer whether or not an email is registered.
- Sessions use a random 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie (`Secure` in production). Only a SHA-256 hash of the token is stored.
- State-changing API calls require a custom `X-Requested-With` header, as CSRF defence on top of SameSite.
- Every query on accounts, transactions and the portfolio is filtered by the signed-in user's ID. The tests check that one user cannot read, edit, delete, or post into another user's data.
- The CSP allows only same-origin scripts and styles. The UI builds the DOM without `innerHTML`, so user text cannot inject markup.
- The CoinGecko key stays on the server. The browser only ever talks to CoinLedger's own API.

## Tests

`npm test` runs 38 tests with Node's built-in test runner:

- `test/calc.test.js`: quantity = amount ÷ price (including rounding), average entry price (including the $100 @ 100 + $260 @ 130 = 120 example), exact decimal behaviour, fees excluded from the average and optionally included in cost basis, unrealized P/L in currency and %, portfolio % from total cost basis (not averaged), missing prices not treated as zero, sells and realized P/L, chronological ordering, and ledger validation.
- `test/api.test.js`: end-to-end HTTP tests against an in-memory database and a fake price provider. They cover sign-up and login, input validation, recalculation after edit and delete, filters, incomplete totals, stale-price fallback, cross-user isolation, the CSRF header, the currency lock, and parsing of CoinGecko responses.

## Project layout

```
src/
  index.js       server entry point (reads env, wires provider + db)
  app.js         Express routes, auth guard, per-user scoping
  calc.js        pure portfolio math (decimal.js), fully unit tested
  prices.js      CoinGecko adapter + SQLite-backed price cache
  auth.js        password hashing, sessions, rate limiting
  validation.js  input validation
  db.js          SQLite schema
public/          responsive frontend (vanilla JS, no build step)
test/            node:test suites
```

## Swapping the price provider

`PriceService` works with any object that has the same methods as `CoinGeckoProvider` (`getPrices`, `search`, `getCoin`, `getToken`, `listPlatforms`, `supportedCurrencies`). To use another source, implement those methods and pass your provider to `createApp` in `src/index.js`.
