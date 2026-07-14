# Open Border sample store

A minimal storefront ("Northbound") that integrates the Open Border checkout end to end, the
way a real merchant would — using only two Open Border credentials:

- the **publishable key** (`pk_…`) in the browser — the
  [`@open-border/js`](https://www.npmjs.com/package/@open-border/js) `<script>` embed collects
  the card and returns an opaque payment method token (`pm_…`);
- the **secret key** (`sk_…`) on the backend — the
  [`@open-border/node`](https://www.npmjs.com/package/@open-border/node) SDK quotes duties &
  taxes and creates the payment intent.

Card details never touch this server — the embed collects them in the buyer's browser and hands
the page a token; the backend forwards that token to Open Border to charge it.

```
Browser (public pk_)                         Backend (secret sk_)
  OpenBorder(pk).mount('#checkout', …)          POST /charge
   → fetches branding + config                    → SDK.createTaxQuote({ destination_country, … })
   → collects the card, returns pm_  ── pm_ ─▶    → SDK.createPaymentIntent({ payment_method: pm_,
                                                       tax_quote_id })
                                                  → Open Border charges + returns the intent
```

## What it demonstrates

- **Local-currency pricing.** Each product has a list price in USD, GBP, EUR, CAD, and AUD; the
  shopper's chosen currency routes the charge to the matching Open Border acquiring entity,
  returned as `entity` on the payment intent (and shown on the product page).
- **Duties & taxes follow the ship-to destination.** The checkout drawer quotes them before
  payment (`/quote`) and `/charge` quotes again server-side, attaching the `tax_quote_id` to the
  payment intent. The quote is fail-closed — no quote, no charge — except a domestic destination,
  which has no cross-border duties/taxes and charges subtotal only.
- **Wallets ride the same flow.** The embed is mounted with the quoted landed-cost total, which
  is what the Apple Pay / Google Pay sheet shows; a failed charge closes the sheet as failed.
- **Key separation.** The secret key never reaches the browser, and a publishable key cannot
  move money.
- **Retry-safe payment creation.** One checkout gets one stable reference and idempotency key.
  A lost browser response can be replayed without creating a second payment intent.
- **Displayed-total integrity.** The server signs the exact quote shown in the payment element.
  The charge must use that same unexpired quote; changed or tampered checkout data is rejected.
- **Safe public-demo behavior.** The server accepts the five catalog products only, applies a
  best-effort per-instance throttle, sanitizes upstream errors, and refuses live keys at startup.

Not a production app: no cart, no auth, no persistence — just the checkout → charge path.

## Run locally

Requires Node 20+ and an Open Border **test** key pair.

```
cp .env.example .env    # fill in OB_SECRET_KEY + OB_PUBLISHABLE_KEY
npm install
npm start               # http://localhost:4000
```

Open the store, pick a **currency** in the top bar (the price and the acquiring entity change
with it), open a product, and click **Add to bag**. In the checkout drawer, fill in the buyer
details — the **Order total** quotes duties & taxes for the ship-to address before payment, and
changing the country or postal code refreshes it. The ships-from origin is the US, so a US
address is domestic and shows no duties/taxes; pick e.g. United Kingdom or Canada to see them.
Pay with the test card **4242 4242 4242 4242** (any future expiry + any CVC); the receipt shows
the full breakdown, resolved `entity`, payment-intent ID, and retry-safe checkout reference.

The server will not start with `sk_live_…` or `pk_live_…` credentials. This repository is a
test-mode integration reference, not a live payment proxy.

## Verify a fresh clone

The same commands run in CI:

```
npm ci
npm run typecheck
npm run build
npm test
npm run check:secrets
```

The tests cover catalog tampering, signed displayed quotes, same-key retries, changed-request
rejection, provider-safe errors, malformed JSON, the local throttle, and live-key refusal. CI also
runs the repository secret scanner on every tracked and untracked source file.

For a sustained public deployment, add a platform-level rate-limit rule for `/quote` and
`/charge`. An in-process limiter resets with serverless instances and is only a local safety net.

## Find the transaction in Open Border

After a successful test payment, copy the `pi_…` intent ID from the receipt. Sign in to the
[staging merchant dashboard](https://staging.openborderpayments.com/transactions), open
**Transactions**, and search for that ID. The dashboard record should show the same currency,
entity, subtotal, tax, duty, total, and merchant reference as the store receipt.

This monitoring step is intentionally outside the public storefront: the demo never exposes
merchant or admin credentials to visitors.

For the short customer walkthrough, use [DEMO.md](./DEMO.md).

## Deploy to Vercel

The repo is Vercel-ready: `public/` is served statically, and the Express app is exposed as a
serverless function (`api/index.ts`) that `vercel.json` rewrites `/config.js`, `/quote`, and
`/charge` to.

1. Import the repo in Vercel (framework preset **Other**, no build command).
2. Set the environment variables: `OB_SECRET_KEY`, `OB_PUBLISHABLE_KEY` (and `OB_API_URL` only
   if you need to override the default API host for the key's rail).
3. Deploy.

Use test keys only. A custom `OB_API_URL` is accepted only for localhost or an approved Open
Border staging/dev API host. The `/health` endpoint should return
`{"ok":true,"mode":"test"}` after deployment.

### Enable Apple Pay / Google Pay

Wallet buttons render only on a domain registered with Open Border. Register the deployed
domain once:

```
curl -X POST <api-base>/v1/payment_method_domains \
  -H "Authorization: Bearer sk_test_…" \
  -H "Content-Type: application/json" \
  -d '{"domain":"your-store.vercel.app"}'
```

The button then appears in a wallet-capable browser with an enrolled card (Safari + Apple
Wallet, or Chrome + Google Pay).
