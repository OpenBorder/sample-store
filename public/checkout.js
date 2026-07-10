// Demo catalog. Each product carries a list price per currency (integer minor units) — the
// shopper's chosen currency is what routes the charge to an Open Border acquiring entity.
const ENTITY = { USD: 'obmor_us', GBP: 'obmor_uk', EUR: 'obmor_nl', CAD: 'obmor_ca', AUD: 'obmor_au' };
const CURRENCIES = ['USD', 'GBP', 'EUR', 'CAD', 'AUD'];

// Each product carries its HS (tariff) code; the server quotes duties & taxes from the code
// + ship-to destination.
const PRODUCTS = [
  {
    id: 'hoodie', name: 'Classic Pullover Hoodie', cat: 'Apparel', emoji: '🧥', grad: ['#6366f1', '#8b5cf6'], hs: '6110.20',
    desc: 'A midweight organic-cotton hoodie with a brushed interior, ribbed cuffs, and a relaxed everyday fit. Built to be your go-to layer from spring evenings to autumn mornings.',
    features: ['380gsm organic cotton fleece', 'Double-lined drawcord hood', 'Pre-shrunk, garment-washed', 'Ethically made in Portugal'],
    prices: { USD: 4200, GBP: 3400, EUR: 3900, CAD: 5700, AUD: 6300 },
  },
  {
    id: 'scarf', name: 'Merino Wool Scarf', cat: 'Accessories', emoji: '🧣', grad: ['#ec4899', '#f43f5e'], hs: '6214.20',
    desc: 'A featherweight yet warm scarf knit from 100% extra-fine merino. Naturally temperature-regulating and soft enough to wear against the skin.',
    features: ['100% extra-fine merino wool', 'Naturally odour-resistant', '180 × 30 cm', 'Hand-finished fringe'],
    prices: { USD: 2800, GBP: 2200, EUR: 2600, CAD: 3800, AUD: 4200 },
  },
  {
    id: 'sneakers', name: 'Suede Runner Sneakers', cat: 'Footwear', emoji: '👟', grad: ['#06b6d4', '#3b82f6'], hs: '6403.19',
    desc: 'A retro-cut runner in soft suede and breathable mesh, set on a cushioned EVA sole. Everyday comfort that reads smart-casual.',
    features: ['Premium suede + recycled mesh', 'Cushioned EVA midsole', 'Removable arch-support insole', 'True to size'],
    prices: { USD: 8900, GBP: 6900, EUR: 7900, CAD: 11900, AUD: 13500 },
  },
  {
    id: 'flannel', name: 'Heavyweight Flannel Shirt', cat: 'Apparel', emoji: '👕', grad: ['#f59e0b', '#ef4444'], hs: '6205.20',
    desc: 'A brushed-cotton flannel with a substantial hand-feel and a classic check. Wears equally well open over a tee or buttoned as a light jacket.',
    features: ['200gsm brushed cotton', 'Corozo-nut buttons', 'Chest patch pocket', 'Relaxed modern fit'],
    prices: { USD: 4900, GBP: 3900, EUR: 4500, CAD: 6500, AUD: 7500 },
  },
  {
    id: 'shades', name: 'Polarized Sunglasses', cat: 'Accessories', emoji: '🕶️', grad: ['#10b981', '#14b8a6'], hs: '9004.10',
    desc: 'A timeless keyhole silhouette in a lightweight acetate frame with polarized, UV400 lenses. Comes with a hard case and cleaning cloth.',
    features: ['Polarized UV400 lenses', 'Italian acetate frame', 'CR-39 scratch-resistant coating', 'Includes hard case'],
    prices: { USD: 2900, GBP: 2300, EUR: 2700, CAD: 3900, AUD: 4400 },
  },
];
const byId = (id) => PRODUCTS.find((p) => p.id === id);

const $ = (id) => document.getElementById(id);
const price = (amount, currency) =>
  new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount / 100);

const state = { currency: 'USD', product: null, breakdown: null };

const overlay = $('overlay');
const drawer = $('drawer');
const receiptCard = $('receipt-card');
const receipt = $('receipt');


const ob = OpenBorder(OB_CONFIG.publishableKey, { apiBaseUrl: OB_CONFIG.apiBaseUrl });
let mounted = null; // current embed instance, so we can unmount when switching currency/product.

function unmountEmbed() {
  if (mounted) {
    mounted.unmount();
    mounted = null;
  }
  $('ob-checkout').innerHTML = '';
}

function renderPaymentPlaceholder(message) {
  unmountEmbed();
  const placeholder = document.createElement('div');
  placeholder.className = 'payment-placeholder';
  placeholder.textContent = message;
  $('ob-checkout').replaceChildren(placeholder);
}

/* ---------------- Views & routing ---------------- */

function renderGrid() {
  const grid = $('product-grid');
  grid.innerHTML = '';
  for (const product of PRODUCTS) {
    const card = document.createElement('article');
    card.className = 'product';
    card.dataset.id = product.id;
    card.innerHTML =
      `<div class="thumb" style="background: linear-gradient(135deg, ${product.grad[0]}, ${product.grad[1]})">` +
      `<span class="tag">${product.cat}</span>${product.emoji}</div>` +
      '<div class="product-body">' +
      `<div class="cat">${product.cat}</div>` +
      `<div class="name">${product.name}</div>` +
      `<div class="price">${price(product.prices[state.currency], state.currency)}</div>` +
      '<div class="link-row">View details →</div>' +
      '</div>';
    card.addEventListener('click', () => goProduct(product.id));
    grid.appendChild(card);
  }
  $('shop-ccy-label').textContent = state.currency;
}

function renderPDP(product) {
  const ccy = state.currency;
  const g = $('pdp-gallery');
  g.style.background = `linear-gradient(135deg, ${product.grad[0]}, ${product.grad[1]})`;
  g.textContent = product.emoji;
  $('crumb-name').textContent = product.name;
  $('pdp-cat').textContent = product.cat;
  $('pdp-name').textContent = product.name;
  $('pdp-price').textContent = price(product.prices[ccy], ccy);
  $('pdp-route').textContent = `Charged in ${ccy} → routes to ${ENTITY[ccy]}`;
  $('pdp-desc').textContent = product.desc;
  $('pdp-features').innerHTML = product.features.map((f) => `<li>${f}</li>`).join('');
  $('pdp-ccy').value = ccy;
}

function showView(which) {
  $('view-shop').hidden = which !== 'shop';
  $('view-product').hidden = which !== 'product';
}

function route() {
  const m = location.hash.match(/^#\/product\/(.+)$/);
  const product = m && byId(m[1]);
  if (product) {
    state.product = product;
    renderPDP(product);
    showView('product');
    window.scrollTo(0, 0);
  } else {
    showView('shop');
    renderGrid();
  }
}

function goHome() {
  location.hash = '#/';
}
function goProduct(id) {
  location.hash = `#/product/${id}`;
}

/* ---------------- Currency ---------------- */

function setCurrency(ccy) {
  if (!CURRENCIES.includes(ccy)) return;
  state.currency = ccy;
  for (const id of ['nav-ccy', 'pdp-ccy', 'drawer-ccy']) {
    const el = $(id);
    if (el) el.value = ccy;
  }
  renderGrid();
  if (!$('view-product').hidden && state.product) renderPDP(state.product);
  // A currency change while the drawer is open must reload the payment element on the new
  // entity's account — the embed takes `currency` at mount, so re-mount it.
  if (drawer.classList.contains('open') && state.product) updateDrawer();
}

/* ---------------- Checkout drawer ---------------- */

function renderReceipt(kind, html) {
  receiptCard.hidden = false;
  receipt.className = `receipt ${kind}`;
  receipt.innerHTML = html;
}

function renderTotals(b, note) {
  $('tot-sub').textContent = b ? price(b.subtotal, b.currency) : '—';
  $('tot-tax').textContent = b ? price(b.tax, b.currency) : '—';
  $('tot-duty').textContent = b ? price(b.duty, b.currency) : '—';
  $('tot-total').textContent = b ? price(b.total, b.currency) : '—';
  $('totals-note').textContent = note || '';
}

function renderOrderSummary() {
  const product = state.product;
  const ccy = state.currency;
  const amount = product.prices[ccy];
  const thumb = $('sum-thumb');

  thumb.textContent = product.emoji;
  thumb.style.background = `linear-gradient(135deg, ${product.grad[0]}, ${product.grad[1]})`;
  $('sum-name').textContent = product.name;
  $('sum-meta').textContent = `${ccy} → ${ENTITY[ccy]}`;
  $('sum-price').textContent = price(amount, ccy);
  receiptCard.hidden = true;
}

// Pre-payment quote: duties & taxes for the current product + currency + ship-to address.
// The seq guard drops stale responses when the buyer changes currency/address mid-flight.
let quoteSeq = 0;
async function refreshQuote() {
  const product = state.product;
  const ccy = state.currency;
  const seq = ++quoteSeq;
  state.breakdown = null;
  renderTotals(null, 'Calculating duties & taxes for your address…');
  renderPaymentPlaceholder('Calculating final total before payment…');
  try {
    const res = await fetch('/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productName: product.name,
        hsCode: product.hs,
        currency: ccy,
        amount: product.prices[ccy],
        address: buyer().address,
      }),
    });
    const data = await res.json();
    if (seq !== quoteSeq) return false;
    if (!data.ok) {
      renderTotals(null, `Could not quote duties & taxes (${data.code}).`);
      renderPaymentPlaceholder('Payment is unavailable until duties & taxes can be quoted.');
      return false;
    }
    state.breakdown = data.amount_breakdown;
    renderTotals(
      data.amount_breakdown,
      data.domestic
        ? 'Domestic order — no cross-border duties or taxes.'
        : 'Duties & taxes quoted for your shipping destination.',
    );
    return true;
  } catch {
    if (seq === quoteSeq) {
      renderTotals(null, 'Could not reach the store backend.');
      renderPaymentPlaceholder('Payment is unavailable until the quote service responds.');
    }
    return false;
  }
}

// Quote first, then (re-)mount the embed so the Pay button shows the full quoted total.
function updateDrawer() {
  renderOrderSummary();
  refreshQuote().then((quoted) => {
    if (quoted && drawer.classList.contains('open') && state.product) mountEmbed();
  });
}

function mountEmbed() {
  const product = state.product;
  const ccy = state.currency;
  const amount = product.prices[ccy];

  if (!state.breakdown) {
    renderPaymentPlaceholder('Payment is unavailable until duties & taxes can be quoted.');
    return;
  }

  unmountEmbed();
  $('ob-checkout').innerHTML = '';
  mounted = ob.mount('#ob-checkout', {
    currency: ccy,
    // The buyer pays the displayed landed cost (subtotal + tax + duty). This is also the
    // total the Apple Pay sheet shows, so it MUST be the quoted total, never the subtotal.
    amount: state.breakdown.total,
    // The embed awaits this handler: a rejection closes the Apple Pay sheet as FAILED
    // (the receipt already shows the specific error), a resolve closes it as paid.
    onSuccess: async ({ paymentMethodId }) => {
      const details = buyer();
      if (!details.email || !details.address.line1) {
        renderReceipt('err', '<h4>Missing details</h4><p>Enter your email and address before paying.</p>');
        throw new Error('missing_details');
      }
      if (!state.breakdown) {
        renderReceipt('err', '<h4>Payment unavailable</h4><p>Duties & taxes must be quoted before paying.</p>');
        throw new Error('quote_missing');
      }
      renderReceipt('pending', 'Processing your payment…');
      let data;
      try {
        const res = await fetch('/charge', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ paymentMethodId, productName: product.name, hsCode: product.hs, currency: ccy, amount, ...details }),
        });
        data = await res.json();
      } catch {
        renderReceipt('err', '<h4>Payment failed</h4><p>Network error talking to the store backend.</p>');
        throw new Error('network_error');
      }
      if (!data.ok) {
        renderReceipt('err', `<h4>Payment failed</h4><p>${data.code}: ${data.message}</p>`);
        throw new Error('charge_failed');
      }
      const pi = data.paymentIntent;
      const b = pi.amount_breakdown;
      renderReceipt(
        'ok',
        '<h4>✓ Payment ' + pi.status + '</h4>' +
          '<dl>' +
          `<dt>Order</dt><dd>${product.name}</dd>` +
          `<dt>Intent</dt><dd>${pi.id}</dd>` +
          `<dt>Entity</dt><dd>${pi.entity}</dd>` +
          `<dt>Subtotal</dt><dd>${price(b.subtotal, b.currency)}</dd>` +
          `<dt>Tax</dt><dd>${price(b.tax, b.currency)}</dd>` +
          `<dt>Duty</dt><dd>${price(b.duty, b.currency)}</dd>` +
          `<dt>Total</dt><dd>${price(b.total, b.currency)}</dd>` +
          '</dl>',
      );
    },
    onError: (message) => renderReceipt('err', `<h4>Payment failed</h4><p>${message}</p>`),
  });
}

function buyer() {
  return {
    email: $('email').value.trim(),
    name: $('name').value.trim(),
    address: {
      line1: $('line1').value.trim(),
      city: $('city').value.trim(),
      postal_code: $('postal_code').value.trim(),
      country: $('country').value,
    },
  };
}

function openCheckout() {
  if (!state.product) return;
  $('cart-count').textContent = '1';
  overlay.classList.add('open');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  updateDrawer();
}

function closeCheckout() {
  overlay.classList.remove('open');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  quoteSeq += 1;
  unmountEmbed();
}

/* ---------------- Wire-up ---------------- */

$('nav-ccy').addEventListener('change', (e) => setCurrency(e.target.value));
$('pdp-ccy').addEventListener('change', (e) => setCurrency(e.target.value));
$('drawer-ccy').addEventListener('change', (e) => setCurrency(e.target.value));
$('pdp-add').addEventListener('click', openCheckout);

$('brand-home').addEventListener('click', goHome);
$('crumb-shop').addEventListener('click', goHome);
$('hero-cta').addEventListener('click', () => document.getElementById('shop').scrollIntoView());
for (const el of document.querySelectorAll('[data-nav-home]')) el.addEventListener('click', goHome);

// A new ship-to country / postal code changes the duty & tax quote.
function onAddressChange() {
  if (!drawer.classList.contains('open') || !state.product) return;
  refreshQuote().then((quoted) => {
    if (quoted && drawer.classList.contains('open') && state.product) mountEmbed();
  });
}
$('country').addEventListener('change', onAddressChange);
$('postal_code').addEventListener('change', onAddressChange);

$('drawer-close').addEventListener('click', closeCheckout);
overlay.addEventListener('click', closeCheckout);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCheckout();
});

window.addEventListener('hashchange', route);
route();
