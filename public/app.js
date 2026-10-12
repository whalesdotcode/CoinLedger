// CoinLedger frontend. No framework, no build step.
// All financial math happens on the server with decimal arithmetic; the browser
// only formats the decimal strings it receives (and uses BigInt for the form preview).

const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  user: null,
  allowRegistration: true,
  authMode: 'login',
  accounts: [],
  assets: [],
  portfolio: null,
  transactions: [],
  filters: { accountId: '', assetId: '' },
  editingTx: null,
  selectedAsset: null,
  platforms: null,
};

// ---------------------------------------------------------------- API

class ApiError extends Error {
  constructor(message, status, field) {
    super(message);
    this.status = status;
    this.field = field;
  }
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      'x-requested-with': 'CoinLedger',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/')) showAuth();
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data.field);
  }
  return data;
}

const qs = (obj) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== '' && v !== null && v !== undefined) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ---------------------------------------------------------------- DOM helper (no innerHTML with data)

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// ---------------------------------------------------------------- formatting

const currencyCode = () => (state.user?.reportingCurrency || 'usd').toUpperCase();
const isoCurrency = (() => {
  const cache = new Map();
  return (code) => {
    if (!cache.has(code)) {
      try {
        new Intl.NumberFormat('en', { style: 'currency', currency: code });
        cache.set(code, true);
      } catch {
        cache.set(code, false);
      }
    }
    return cache.get(code);
  };
})();

function fmtMoney(value, { precise = false, signed = false } = {}) {
  if (value === null || value === undefined) return '—';
  const abs = Math.abs(Number(value));
  let maxFd = 2;
  if (precise && abs > 0 && abs < 1) maxFd = abs < 0.0001 ? 10 : 6;
  const code = currencyCode();
  const opts = { minimumFractionDigits: 2, maximumFractionDigits: maxFd, signDisplay: signed ? 'exceptZero' : 'auto' };
  // Intl accepts decimal strings, so values are not forced through floats where supported.
  if (isoCurrency(code)) return new Intl.NumberFormat(undefined, { ...opts, style: 'currency', currency: code }).format(value);
  return `${new Intl.NumberFormat(undefined, opts).format(value)} ${code}`;
}

const fmtQty = (value) =>
  value === null || value === undefined ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(value);

const fmtPct = (value) =>
  value === null || value === undefined
    ? '—'
    : `${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' }).format(value)}%`;

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function timeAgo(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');

const sign = (v) => (v === null || v === undefined ? null : Math.sign(Number(v)));

/** Profit/loss with colour AND text label and arrow, so it never relies on colour alone. */
function plNode(amount, pct, { large = false } = {}) {
  if (amount === null || amount === undefined) {
    return h('span', { class: 'unavailable' }, 'Price unavailable');
  }
  const s = sign(amount);
  const cls = s > 0 ? 'gain' : s < 0 ? 'loss' : 'neutral';
  const label = s > 0 ? '▲ Gain' : s < 0 ? '▼ Loss' : 'Break-even';
  return h(
    'span',
    { class: `pl ${cls}`, 'aria-label': `Unrealized ${s > 0 ? 'gain' : s < 0 ? 'loss' : 'break-even'} ${fmtMoney(amount, { signed: true })}, ${fmtPct(pct)}` },
    large ? null : h('span', { class: 'pl-badge' }, label),
    h('span', { class: 'pl-amount num' }, fmtMoney(amount, { signed: true })),
    h('span', { class: 'pl-pct num' }, pct === null ? '' : fmtPct(pct)),
  );
}

function assetIcon(asset) {
  if (asset.imageUrl) return h('img', { class: 'asset-icon', src: asset.imageUrl, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  return h('span', { class: 'asset-icon fallback', 'aria-hidden': 'true' }, (asset.symbol || '?').slice(0, 3));
}

function assetIdentity(asset) {
  return asset.contractAddress
    ? `${asset.platform} · ${asset.contractAddress.slice(0, 6)}…${asset.contractAddress.slice(-4)}`
    : `id: ${asset.providerId}`;
}

function assetCell(asset, { identity = true } = {}) {
  return h(
    'div',
    { class: 'asset-cell' },
    assetIcon(asset),
    h(
      'div',
      { class: 'asset-text' },
      h('div', { class: 'asset-name' }, asset.name, ' ', h('span', { class: 'muted small' }, asset.symbol)),
      identity ? h('div', { class: 'asset-meta', title: asset.contractAddress || asset.providerId }, assetIdentity(asset)) : null,
    ),
  );
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3000);
}

function showError(form, err) {
  const box = $('.form-error', form);
  box.textContent = err ? err.message || String(err) : '';
  box.hidden = !err;
  form.querySelectorAll('[aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
  if (err?.field) {
    const map = { Amount: 'amount', 'Price per coin': 'price', 'Transaction date': 'date', Account: 'accountId' };
    const input = form.elements[map[err.field] || err.field];
    if (input?.setAttribute) input.setAttribute('aria-invalid', 'true');
  }
}

// ---------------------------------------------------------------- exact decimal helpers (form preview only)

const DEC_RE = /^\d{1,24}(\.\d{1,18})?$/;
function toBig(s) {
  const [i, f = ''] = s.split('.');
  return { n: BigInt(i + f), scale: f.length };
}
function fromBig(n, scale) {
  const neg = n < 0n;
  let s = (neg ? -n : n).toString().padStart(scale + 1, '0');
  if (scale) s = `${s.slice(0, -scale)}.${s.slice(-scale)}`.replace(/\.?0+$/, '');
  return (neg ? '-' : '') + s;
}
/** a / b to `dp` decimal places, rounded down (matches the server's calculation). */
function divDec(a, b, dp = 18) {
  const x = toBig(a);
  const y = toBig(b);
  if (y.n === 0n) return null;
  return fromBig((x.n * 10n ** BigInt(y.scale + dp)) / (y.n * 10n ** BigInt(x.scale)), dp);
}

// ---------------------------------------------------------------- auth view

function showAuth() {
  state.user = null;
  $('#app-view').hidden = true;
  $('#auth-view').hidden = false;
  setAuthMode(state.authMode);
}

function setAuthMode(mode) {
  state.authMode = mode;
  const reg = mode === 'register';
  $('#tab-login').setAttribute('aria-selected', String(!reg));
  $('#tab-register').setAttribute('aria-selected', String(reg));
  $('#tab-register').hidden = !state.allowRegistration;
  $('#auth-submit').textContent = reg ? 'Create account' : 'Sign in';
  $('#password-hint').hidden = !reg;
  $('#auth-form').elements.password.autocomplete = reg ? 'new-password' : 'current-password';
  showError($('#auth-form'), null);
}

$('#tab-login').addEventListener('click', () => setAuthMode('login'));
$('#tab-register').addEventListener('click', () => setAuthMode('register'));

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const btn = $('#auth-submit');
  btn.disabled = true;
  try {
    const path = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const { user } = await api('POST', path, { email: form.elements.email.value, password: form.elements.password.value });
    form.reset();
    await enterApp(user);
  } catch (err) {
    showError(form, err);
  } finally {
    btn.disabled = false;
  }
});

$('#btn-logout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout').catch(() => {});
  state.portfolio = null;
  showAuth();
});

// ---------------------------------------------------------------- app data

async function enterApp(user) {
  state.user = user;
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  await Promise.all([loadAccounts(), loadAssets()]);
  await Promise.all([loadPortfolio(), loadTransactions()]);
}

async function loadAccounts() {
  state.accounts = (await api('GET', '/api/accounts')).accounts;
  fillSelect($('#filter-account'), state.accounts, 'All accounts', state.filters.accountId);
}

async function loadAssets() {
  state.assets = (await api('GET', '/api/assets')).assets;
  fillSelect(
    $('#filter-asset'),
    state.assets.map((a) => ({ id: a.id, name: `${a.name} (${a.symbol})` })),
    'All cryptocurrencies',
    state.filters.assetId,
  );
}

function fillSelect(select, items, allLabel, current) {
  select.replaceChildren(
    h('option', { value: '' }, allLabel),
    ...items.map((i) => h('option', { value: i.id }, i.name)),
  );
  select.value = items.some((i) => String(i.id) === String(current)) ? current : '';
  if (select.value !== String(current)) {
    if (select.id === 'filter-account') state.filters.accountId = '';
    if (select.id === 'filter-asset') state.filters.assetId = '';
  }
}

let portfolioRequest = 0;
async function loadPortfolio({ refresh = false } = {}) {
  const id = ++portfolioRequest;
  const btn = $('#btn-refresh');
  btn.disabled = true;
  try {
    const p = await api('GET', `/api/portfolio${qs({ ...state.filters, refresh: refresh ? 1 : '' })}`);
    if (id !== portfolioRequest) return;
    state.portfolio = p;
    renderPortfolio();
  } catch (err) {
    if (err.status !== 401) toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function loadTransactions() {
  state.transactions = (await api('GET', `/api/transactions${qs(state.filters)}`)).transactions;
  renderTransactions();
}

async function reloadAll() {
  await Promise.all([loadAccounts(), loadAssets()]);
  await Promise.all([loadPortfolio(), loadTransactions()]);
}

$('#filter-account').addEventListener('change', (e) => {
  state.filters.accountId = e.target.value;
  loadPortfolio();
  loadTransactions();
});
$('#filter-asset').addEventListener('change', (e) => {
  state.filters.assetId = e.target.value;
  loadPortfolio();
  loadTransactions();
});
$('#btn-refresh').addEventListener('click', () => loadPortfolio({ refresh: true }));

// Keep prices fresh while the tab is visible.
setInterval(() => {
  if (state.user && document.visibilityState === 'visible') loadPortfolio();
}, 60_000);
// Re-render "x min ago" labels.
setInterval(() => state.portfolio && renderStatus(), 30_000);

// ---------------------------------------------------------------- rendering

function renderPortfolio() {
  renderStatus();
  renderBanners();
  renderSummary();
  renderHoldings();
}

function renderStatus() {
  const p = state.portfolio;
  const el = $('#price-status');
  if (!p.holdings.length) {
    el.textContent = `Reporting currency: ${p.currency.toUpperCase()}`;
    return;
  }
  const { oldest, newest } = p.pricesUpdatedAt;
  el.replaceChildren(
    `Prices from CoinGecko in ${p.currency.toUpperCase()} · `,
    newest
      ? h('span', { title: `Oldest: ${fmtDateTime(oldest)}\nNewest: ${fmtDateTime(newest)}` },
          `last updated ${timeAgo(newest)} (${new Date(newest).toLocaleTimeString()})`,
          oldest !== newest ? `, oldest ${timeAgo(oldest)}` : '')
      : 'no prices available yet',
  );
}

function renderBanners() {
  const p = state.portfolio;
  const banners = [];
  if (!p.totals.complete) {
    const names = p.totals.missingPriceAssets.map((a) => `${a.name} (${a.symbol})`).join(', ');
    banners.push(
      h('div', { class: 'banner', role: 'alert' },
        h('strong', {}, 'Portfolio totals are incomplete. '),
        `No current price is available for ${names}. `,
        'These holdings are excluded from current value and profit/loss — they are not counted as zero.'),
    );
  }
  if (p.priceError) {
    banners.push(h('div', { class: 'banner' }, h('strong', {}, 'Price provider issue: '), p.priceError, '. Showing the last known prices where available.'));
  }
  if (p.holdings.some((x) => x.priceStatus === 'stale')) {
    banners.push(h('div', { class: 'banner' }, 'Some prices have not updated in over 15 minutes and are marked “stale”.'));
  }
  $('#banners').replaceChildren(...banners);
}

function renderSummary() {
  const { totals, holdings } = state.portfolio;
  const incomplete = !totals.complete;
  const s = sign(totals.unrealizedPL);
  const plCls = holdings.length ? (s > 0 ? 'pl-gain' : s < 0 ? 'pl-loss' : '') : '';

  $('#summary').replaceChildren(
    h('div', { class: 'card' },
      h('div', { class: 'card-label' }, 'Total cost basis'),
      h('div', { class: 'card-value num' }, fmtMoney(totals.totalCostBasis)),
      h('div', { class: 'card-sub' },
        `${holdings.length} holding${holdings.length === 1 ? '' : 's'}`,
        Number(totals.feesPaid) !== 0 ? ` · Fees paid ${fmtMoney(totals.feesPaid)}` : ''),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'card-label' }, 'Current portfolio value', incomplete ? ' · incomplete' : ''),
      h('div', { class: 'card-value num' }, fmtMoney(totals.currentValue)),
      h('div', { class: 'card-sub' },
        incomplete ? `Excludes ${totals.missingPriceAssets.length} holding(s) without a price` : 'All holdings priced'),
    ),
    h('div', { class: `card ${plCls}` },
      h('div', { class: 'card-label' }, 'Unrealized profit / loss', incomplete ? ' · incomplete' : ''),
      h('div', { class: 'card-value' },
        holdings.length ? plNode(totals.unrealizedPL, totals.unrealizedPLPct, { large: true }) : fmtMoney('0')),
      h('div', { class: 'card-sub' },
        incomplete
          ? `On ${fmtMoney(totals.pricedCostBasis)} of priced cost basis`
          : `Return on total cost basis`,
        Number(totals.realizedPL) !== 0 ? ` · Realized ${fmtMoney(totals.realizedPL, { signed: true })}` : ''),
    ),
  );
  $('#cost-method-note').textContent = 'Weighted average cost';
}

function priceCell(hd) {
  if (hd.priceStatus === 'unavailable') {
    return h('span', { class: 'unavailable', title: 'The price provider returned no price for this asset' }, 'Unavailable');
  }
  return h('span', {},
    h('span', { class: 'num' }, fmtMoney(hd.marketPrice, { precise: true })),
    h('span', { class: `price-meta ${hd.priceStatus === 'stale' ? 'stale' : ''}`, title: fmtDateTime(hd.priceUpdatedAt) },
      hd.priceStatus === 'stale' ? `stale · ${timeAgo(hd.priceUpdatedAt)}` : timeAgo(hd.priceUpdatedAt)),
  );
}

function renderHoldings() {
  const { holdings } = state.portfolio;
  if (!holdings.length) {
    $('#holdings').replaceChildren(
      h('div', { class: 'empty' },
        state.transactions.length || state.filters.accountId || state.filters.assetId
          ? 'No open holdings for this filter.'
          : 'No holdings yet. Add your first purchase to get started.'),
    );
    return;
  }
  const head = ['Cryptocurrency', 'Unrealized P/L', 'Quantity', 'Avg entry price', 'Cost basis', 'Current price', 'Market value'];
  $('#holdings').replaceChildren(
    h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, head.map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {},
          holdings.map((hd) =>
            h('tr', {},
              h('td', { class: 'cell-asset' }, assetCell(hd.asset)),
              h('td', { class: 'cell-pl' }, plNode(hd.unrealizedPL, hd.unrealizedPLPct)),
              h('td', { 'data-label': 'Quantity', class: 'num', title: hd.quantity }, fmtQty(hd.quantity), ' ', h('span', { class: 'muted small' }, hd.asset.symbol)),
              h('td', { 'data-label': 'Avg entry price', class: 'num', title: hd.averageEntryPrice }, fmtMoney(hd.averageEntryPrice, { precise: true })),
              h('td', { 'data-label': 'Cost basis', class: 'num', title: hd.costBasis }, fmtMoney(hd.costBasis)),
              h('td', { 'data-label': 'Current price' }, priceCell(hd)),
              h('td', { 'data-label': 'Market value', class: 'num' },
                hd.marketValue === null ? h('span', { class: 'unavailable' }, 'Unavailable') : fmtMoney(hd.marketValue)),
            ),
          ),
        ),
      ),
    ),
  );
}

function renderTransactions() {
  const txs = state.transactions;
  if (!txs.length) {
    $('#transactions').replaceChildren(h('div', { class: 'empty' }, 'No transactions recorded for this filter.'));
    return;
  }
  const accountName = new Map(state.accounts.map((a) => [a.id, a.name]));
  const assetById = new Map(state.assets.map((a) => [a.id, a]));
  // Fees can no longer be entered; the column only appears for older entries that have them.
  const showFees = txs.some((tx) => Number(tx.fee) !== 0);
  const head = ['Cryptocurrency', 'Type', 'Date', 'Account', 'Amount', 'Price per coin', 'Quantity', showFees ? 'Fees' : null, ''].filter((x) => x !== null);
  $('#transactions').replaceChildren(
    h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, head.map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', {},
          txs.map((tx) => {
            const asset = assetById.get(tx.assetId) || { name: 'Unknown', symbol: '?' };
            return h('tr', {},
              h('td', { class: 'cell-asset' }, assetCell(asset, { identity: false })),
              h('td', { class: 'cell-pl' }, h('span', { class: `type-pill type-${tx.type}` }, tx.type === 'buy' ? 'Buy' : 'Sell')),
              h('td', { 'data-label': 'Date', class: 'num' }, fmtDate(tx.date)),
              h('td', { 'data-label': 'Account' }, accountName.get(tx.accountId) || '—'),
              h('td', { 'data-label': tx.type === 'buy' ? 'Amount bought' : 'Amount sold', class: 'num', title: tx.total }, fmtMoney(tx.total)),
              h('td', { 'data-label': 'Price per coin', class: 'num', title: tx.price }, fmtMoney(tx.price, { precise: true })),
              h('td', { 'data-label': 'Quantity', class: 'num', title: tx.quantity }, fmtQty(tx.quantity), ' ', h('span', { class: 'muted small' }, asset.symbol)),
              showFees ? h('td', { 'data-label': 'Fees', class: 'num' }, fmtMoney(tx.fee)) : null,
              h('td', { class: 'cell-actions' },
                h('div', { class: 'row-actions' },
                  h('button', { type: 'button', class: 'btn btn-sm', onclick: () => openTxDialog(tx) }, 'Edit'),
                  h('button', { type: 'button', class: 'btn btn-sm btn-danger', onclick: () => deleteTx(tx, asset) }, 'Delete'),
                ),
              ),
            );
          }),
        ),
      ),
    ),
  );
}

async function deleteTx(tx, asset) {
  const msg = `Delete this ${tx.type} of ${fmtQty(tx.quantity)} ${asset.symbol} on ${fmtDate(tx.date)}? This cannot be undone.`;
  if (!confirm(msg)) return;
  try {
    await api('DELETE', `/api/transactions/${tx.id}`);
    toast('Transaction deleted; holdings recalculated');
    await reloadAll();
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------------- dialogs (shared)

for (const dlg of document.querySelectorAll('dialog')) {
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();
  });
}

// ---------------------------------------------------------------- transaction dialog

const txForm = $('#tx-form');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function openTxDialog(tx = null) {
  state.editingTx = tx;
  txForm.reset();
  showError(txForm, null);
  try {
    fillTxForm(tx);
  } catch (err) {
    // Never let a pre-fill problem stop the dialog from opening; show it inside instead.
    console.error(err);
    showError(txForm, new Error(`Could not pre-fill the form: ${err.message}`));
  }
  $('#tx-dialog').showModal();
  if (!state.selectedAsset) $('#asset-search').focus();
}

function fillTxForm(tx) {
  $('#tx-title').textContent = tx ? 'Edit transaction' : 'Add transaction';
  $('#tx-submit').textContent = tx ? 'Save changes' : 'Add transaction';
  txForm.querySelectorAll('.cur-label').forEach((el) => (el.textContent = `(${currencyCode()})`));
  txForm.elements.date.max = today();

  const accSel = txForm.elements.accountId;
  accSel.replaceChildren(...state.accounts.map((a) => h('option', { value: a.id }, a.name)));

  if (tx) {
    txForm.elements.type.value = tx.type;
    accSel.value = tx.accountId;
    txForm.elements.amount.value = tx.total;
    txForm.elements.price.value = tx.price;
    txForm.elements.date.value = tx.date;
    txForm.elements.notes.value = tx.notes || '';
    selectAsset(state.assets.find((a) => a.id === tx.assetId) || null);
  } else {
    txForm.elements.date.value = today();
    if (state.filters.accountId) accSel.value = state.filters.accountId;
    const filtered = state.assets.find((a) => String(a.id) === state.filters.assetId);
    selectAsset(filtered || null);
  }
  $('#contract-form').hidden = true;
  updatePreview();
}

$('#btn-add').addEventListener('click', () => openTxDialog());

function selectAsset(asset) {
  state.selectedAsset = asset;
  const chip = $('#asset-selected');
  $('#asset-results').hidden = true;
  if (asset) {
    chip.replaceChildren(
      assetCell(asset),
      h('button', { type: 'button', class: 'link-btn small', onclick: () => { selectAsset(null); $('#asset-search').focus(); } }, 'Change'),
    );
    chip.hidden = false;
    $('#asset-picker').hidden = true;
    updatePreview();
  } else {
    chip.hidden = true;
    $('#asset-picker').hidden = false;
    $('#asset-search').value = '';
  }
}

let searchTimer;
let searchSeq = 0;
$('#asset-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const term = e.target.value.trim();
  renderAssetResults(term, null);
  if (term.length >= 2) searchTimer = setTimeout(() => remoteSearch(term), 300);
});
$('#asset-search').addEventListener('focus', (e) => renderAssetResults(e.target.value.trim(), null));

async function remoteSearch(term) {
  const seq = ++searchSeq;
  try {
    const { results } = await api('GET', `/api/assets/search${qs({ q: term })}`);
    if (seq === searchSeq) renderAssetResults(term, results);
  } catch (err) {
    if (seq === searchSeq) renderAssetResults(term, err);
  }
}

function renderAssetResults(term, remote) {
  const list = $('#asset-results');
  const t = term.toLowerCase();
  const local = state.assets.filter((a) => !t || a.name.toLowerCase().includes(t) || a.symbol.toLowerCase().includes(t));
  const items = [];
  if (local.length) {
    items.push(h('li', { class: 'group', role: 'presentation' }, 'Your cryptocurrencies'));
    for (const a of local.slice(0, 8)) {
      items.push(h('li', { role: 'option', tabindex: '0', onclick: () => selectAsset(a), onkeydown: (e) => e.key === 'Enter' && (e.preventDefault(), selectAsset(a)) }, assetCell(a)));
    }
  }
  if (t.length >= 2) {
    items.push(h('li', { class: 'group', role: 'presentation' }, 'CoinGecko results'));
    if (remote === null) items.push(h('li', { class: 'note' }, 'Searching…'));
    else if (remote instanceof Error) items.push(h('li', { class: 'note' }, remote.message));
    else if (!remote.length) items.push(h('li', { class: 'note' }, 'No matches. For tokens, try adding by contract address.'));
    else {
      const knownIds = new Set(state.assets.filter((a) => !a.contractAddress).map((a) => a.providerId));
      for (const r of remote.filter((x) => !knownIds.has(x.providerId))) {
        const pick = () => addAssetByProviderId(r.providerId);
        items.push(
          h('li', { role: 'option', tabindex: '0', onclick: pick, onkeydown: (e) => e.key === 'Enter' && (e.preventDefault(), pick()) },
            h('div', { class: 'asset-cell' },
              assetIcon(r),
              h('div', {},
                h('div', { class: 'asset-name' }, r.name, ' ', h('span', { class: 'muted small' }, r.symbol)),
                h('div', { class: 'asset-meta' }, `${r.marketCapRank ? `#${r.marketCapRank} · ` : ''}id: ${r.providerId}`),
              ),
            ),
          ),
        );
      }
    }
  } else if (!local.length) {
    items.push(h('li', { class: 'note' }, 'Type at least 2 characters to search.'));
  }
  list.replaceChildren(...items);
  list.hidden = items.length === 0;
}

async function addAssetByProviderId(providerId) {
  try {
    const { asset } = await api('POST', '/api/assets', { providerId });
    rememberAsset(asset);
    selectAsset(asset);
  } catch (err) {
    showError(txForm, err);
  }
}

function rememberAsset(asset) {
  if (!state.assets.some((a) => a.id === asset.id)) state.assets.push(asset);
}

const FALLBACK_PLATFORMS = [
  ['ethereum', 'Ethereum'], ['binance-smart-chain', 'BNB Smart Chain'], ['polygon-pos', 'Polygon POS'],
  ['arbitrum-one', 'Arbitrum One'], ['optimistic-ethereum', 'OP Mainnet'], ['base', 'Base'],
  ['avalanche', 'Avalanche C-Chain'], ['solana', 'Solana'],
].map(([id, name]) => ({ id, name }));

$('#toggle-contract').addEventListener('click', async () => {
  const box = $('#contract-form');
  box.hidden = !box.hidden;
  if (box.hidden || state.platforms) return;
  try {
    state.platforms = (await api('GET', '/api/assets/platforms')).platforms;
  } catch {
    state.platforms = FALLBACK_PLATFORMS;
  }
  const sel = $('#contract-platform');
  sel.replaceChildren(h('option', { value: '' }, 'Choose a network…'), ...state.platforms.map((p) => h('option', { value: p.id }, p.name)));
  sel.value = 'ethereum';
});

$('#contract-add').addEventListener('click', async () => {
  const btn = $('#contract-add');
  btn.disabled = true;
  try {
    const { asset } = await api('POST', '/api/assets', {
      platform: $('#contract-platform').value,
      contractAddress: $('#contract-address').value.trim(),
    });
    rememberAsset(asset);
    selectAsset(asset);
    showError(txForm, null);
  } catch (err) {
    showError(txForm, err);
  } finally {
    btn.disabled = false;
  }
});

function updatePreview() {
  const isBuy = txForm.elements.type.value === 'buy';
  $('#amount-label').textContent = isBuy ? 'Amount bought' : 'Amount sold';
  const a = txForm.elements.amount.value.trim();
  const p = txForm.elements.price.value.trim();
  const out = $('#qty-value');
  const symbol = state.selectedAsset?.symbol || 'coins';
  if (!DEC_RE.test(a) || !DEC_RE.test(p) || /^0*\.?0*$/.test(p)) {
    out.textContent = '—';
    out.removeAttribute('title');
    return;
  }
  const qty = divDec(a, p);
  out.textContent = `${fmtQty(qty)} ${symbol}`;
  out.title = `${qty} ${symbol} (exact, 18 decimal places)`;
}
txForm.addEventListener('input', (e) => {
  if (e.target.id !== 'asset-search' && e.target.id !== 'contract-address') updatePreview();
});

txForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.selectedAsset) {
    showError(txForm, new Error('Choose a cryptocurrency'));
    return;
  }
  const amount = txForm.elements.amount.value.trim();
  const price = txForm.elements.price.value.trim();
  const body = {
    type: txForm.elements.type.value,
    assetId: state.selectedAsset.id,
    accountId: Number(txForm.elements.accountId.value),
    amount,
    price,
    // The server recalculates quantity from amount / price and ignores this value;
    // it is sent so the form still works against a server running older code.
    quantity: DEC_RE.test(amount) && DEC_RE.test(price) ? divDec(amount, price) ?? undefined : undefined,
    date: txForm.elements.date.value,
    notes: txForm.elements.notes.value,
  };
  const btn = $('#tx-submit');
  btn.disabled = true;
  try {
    if (state.editingTx) await api('PUT', `/api/transactions/${state.editingTx.id}`, body);
    else await api('POST', '/api/transactions', body);
    $('#tx-dialog').close();
    toast(state.editingTx ? 'Transaction updated; holdings recalculated' : 'Transaction added');
    await reloadAll();
  } catch (err) {
    showError(txForm, err);
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- accounts dialog

function renderAccountsList() {
  $('#accounts-list').replaceChildren(
    ...state.accounts.map((a) =>
      h('li', {},
        h('div', {}, h('div', { class: 'asset-name' }, a.name),
          h('div', { class: 'muted small' }, `${a.transactionCount} transaction${a.transactionCount === 1 ? '' : 's'}`)),
        h('div', { class: 'row-actions' },
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => renameAccount(a) }, 'Rename'),
          h('button', {
            type: 'button', class: 'btn btn-sm btn-danger', disabled: a.transactionCount > 0,
            title: a.transactionCount > 0 ? 'Delete or move its transactions first' : null,
            onclick: () => deleteAccount(a),
          }, 'Delete'),
        ),
      ),
    ),
  );
}

async function renameAccount(a) {
  const name = prompt('New account name', a.name);
  if (name === null || name.trim() === a.name) return;
  try {
    await api('PATCH', `/api/accounts/${a.id}`, { name });
    await loadAccounts();
    renderAccountsList();
    renderTransactions();
  } catch (err) {
    showError($('#accounts-dialog'), err);
  }
}

async function deleteAccount(a) {
  if (!confirm(`Delete account “${a.name}”?`)) return;
  try {
    await api('DELETE', `/api/accounts/${a.id}`);
    await loadAccounts();
    renderAccountsList();
  } catch (err) {
    showError($('#accounts-dialog'), err);
  }
}

$('#btn-accounts').addEventListener('click', () => {
  renderAccountsList();
  showError($('#accounts-dialog'), null);
  $('#accounts-dialog').showModal();
});

$('#account-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  try {
    await api('POST', '/api/accounts', { name: form.elements.name.value });
    form.reset();
    showError($('#accounts-dialog'), null);
    await loadAccounts();
    renderAccountsList();
  } catch (err) {
    showError($('#accounts-dialog'), err);
  }
});

// ---------------------------------------------------------------- settings dialog

const settingsForm = $('#settings-form');
$('#btn-settings').addEventListener('click', async () => {
  showError(settingsForm, null);
  $('#settings-email').textContent = `Signed in as ${state.user.email}`;
  const sel = settingsForm.elements.reportingCurrency;
  sel.replaceChildren(h('option', { value: state.user.reportingCurrency }, state.user.reportingCurrency.toUpperCase()));
  $('#settings-dialog').showModal();
  try {
    const { currencies } = await api('GET', '/api/currencies');
    sel.replaceChildren(...currencies.map((c) => h('option', { value: c }, c.toUpperCase())));
    sel.value = state.user.reportingCurrency;
  } catch {
    /* keep current value only */
  }
});

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { user } = await api('PATCH', '/api/settings', {
      reportingCurrency: settingsForm.elements.reportingCurrency.value,
    });
    state.user = user;
    $('#settings-dialog').close();
    toast('Settings saved');
    await loadPortfolio();
    renderTransactions();
  } catch (err) {
    showError(settingsForm, err);
  }
});

// ---------------------------------------------------------------- boot

(async function boot() {
  try {
    const { user, allowRegistration } = await api('GET', '/api/auth/me');
    state.allowRegistration = allowRegistration;
    if (user) await enterApp(user);
    else showAuth();
  } catch {
    showAuth();
  }
})();
