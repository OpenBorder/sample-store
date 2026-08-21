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
   → fetches branding + config                    → SDK.createTaxQuote({ ship_from_country,
                                                                         destination_country, … })
   → collects the card, returns pm_  ── pm_ ─▶    → SDK.createPaymentIntent({ payment_method: pm_,
                                                       tax_quote_id })
                                                  → Open Border charges + returns the intent
```

## What it demonstrates

- **Local-currency pricing.** Each product has a list price in USD, GBP, EUR, CAD, and AUD; the
  shopper's chosen currency selects the matching settlement region without exposing internal
  routing references.
- **Duties & taxes follow the ship-to destination.** The checkout drawer quotes them before
  payment (`/quote`) and attaches the server-issued `tax_quote_id` to the payment intent. The
  quote is fail-closed — no quote, no charge — for both domestic and cross-border routes.
- **Wallets ride the same flow.** The embed is mounted with the quoted landed-cost total, which
  is what the Apple Pay / Google Pay sheet shows; a failed charge closes the sheet as failed.
- **Key separation.** The secret key never reaches the browser, and a publishable key cannot
  move money.
- **Retry-safe payment creation.** One checkout gets one stable reference and idempotency key.
  The order and key are persisted before the payment request, so a lost browser response can be
  replayed without creating a second payment intent.
- **Authentic Test-only terminal reconciliation.** Raw signed webhooks are timestamp-checked,
  replay-safe, durably deduplicated, and projected onto the persisted order only when the signed
  event declares Test mode. External delivery and payment references are stored only as keyed
  hashes. An owned terminal event that wins the response/attachment race is staged during the
  single active-checkout window, then consumed atomically when the payment reference attaches.
  Pending evidence is short-lived and bounded, and terminal orders never regress on retries or
  contradictory later deliveries.
- **Displayed-total integrity.** The server signs the exact quote shown in the payment element.
  The charge must use that same unexpired quote; changed or tampered checkout data is rejected.
- **Safe public-demo behavior.** The hosted runtime starts at a cap of zero and accepts only exact
  integer caps from `0` through `50`. Positive caps count new orders per UTC day under a global
  PostgreSQL advisory lock, while a database constraint permits only one unresolved checkout at a
  time. Same-checkout retries keep their stable order and idempotency key. The runtime refuses Live
  keys or any API host except the production-dashboard Sandbox rail and requires server-attested
  `custom_api` provenance before quote or payment I/O. It also validates the five catalog products,
  throttles per instance, and sanitizes upstream errors.

This is a reference demo, not a production commerce application. It deliberately omits accounts,
fulfilment, inventory, and live payments.

## Run locally

Requires Node 20+ and an Open Border **test** key pair.

```
cp .env.example .env    # fill in OB_SECRET_KEY + OB_PUBLISHABLE_KEY
npm install
npm start               # http://localhost:4000
```

Open the store, pick a **currency** in the top bar (the price and settlement region change
with it), open a product, and click **Add to bag**. In the checkout drawer, fill in the buyer
details, then click **Review order total** exactly once to quote duties and taxes. Buyer or currency
changes before that action only reset local state; after a successful quote, the final fields and
total remain locked for that checkout. The ships-from origin is the US, so a US address is domestic
and shows no duties/taxes; pick e.g. United Kingdom or Canada to see them. Only after the separate
provider-delivery approval, complete the approved synthetic Sandbox checkout. The receipt shows
the commercial breakdown and retry-safe checkout reference without exposing provider or routing
identifiers.

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

The tests cover catalog tampering, signed displayed quotes, same-key retries, atomic UTC-day cap
admission through the 50th/51st boundary, single-active-checkout enforcement, UTC reset, cap-zero
readiness, secret-safe cap usage health, current trade-lane quoting, trusted Custom API provenance,
bounded early-webhook staging, monotonic terminal reconciliation, changed-request rejection,
provider-safe errors, malformed JSON, the local throttle, and Live-key refusal. CI provisions a
dedicated disposable PostgreSQL database for real multi-connection admission, attachment/webhook
interleaving, restart durability, deduplication, and UTC-cap tests. It also runs the repository
secret scanner on every tracked and untracked source file.

For a sustained public deployment, add a platform-level rate-limit rule for `/quote` and
`/charge`. An in-process limiter resets with serverless instances and is only a local safety net.

## Reconcile an approved Sandbox transaction

After a separately approved synthetic checkout and authentic terminal webhook, verify the
aggregate status and commercial totals in the production dashboard's Sandbox view. Keep provider,
merchant, account, payment, customer, and delivery identifiers out of screenshots and evidence.
This monitoring step is intentionally outside the public storefront.

For the short customer walkthrough, use [DEMO.md](./DEMO.md).

## Deploy to Vercel

The repo is Vercel-ready: `public/` is served statically, and the Express app is exposed as a
serverless function (`api/index.ts`) that `vercel.json` rewrites `/config.js`, `/quote`, and
`/charge` to.

1. Import the repo in Vercel (framework preset **Other**, no build command).
2. Apply `migrations/001_durable_orders.sql`, `migrations/002_daily_transaction_cap.sql`, then
   `migrations/003_webhook_reconciliation.sql`, in that order to an owned durable Postgres
   database.
3. Configure the Test credential pair, exact Sandbox API host, webhook signing secret, database
   connection, and private-reference HMAC secret in the hosting platform.
4. Leave `DEMO_TRANSACTION_CAP=0` until credential provisioning, database readiness, deployment,
   and provider delivery have each received their own explicit approval.
5. Deploy and verify `/health` reports cap `0`, usage `0`, no active checkout, durable storage,
   authentic webhooks, and trusted Custom API provenance.
6. After a separately approved activation, set `DEMO_TRANSACTION_CAP=50`; never reset the daily
   count or bypass an unresolved checkout to finish a demo.

For an upgrade of the maintained `sample-store-ten.vercel.app` production demo, the approved cap
is already `50`. Preserve that value throughout the upgrade; do not use the fresh-install cap-zero
transition above. Before migration or deployment, separately approve and enable a reversible edge
maintenance rule that blocks only `POST /quote` and `POST /charge`, while leaving static/health GETs
and `POST /webhooks/openborder` reachable. Verify both transaction routes fail closed without
provider I/O, then record the UTC-day usage, active-checkout state, and pending-webhook count.

Apply only `migrations/003_webhook_reconciliation.sql`; it is transaction-wrapped and must run with
stop-on-error. Deploy the exact approved commit while the edge block remains enabled. Recheck the
same aggregates and every readiness boolean before lifting the block under a separate approval.
If any usage, active-checkout, or pending evidence drifts, keep new admissions blocked and
reconcile on the new code. Roll application code back only when no checkout or pending evidence is
active, and leave the additive migration installed. Changing the cap, creating a quote, starting a
checkout, or replaying a webhook requires its own explicit approval.

The hosted runtime accepts Test keys only and pins `OB_API_URL` to
`https://api-sandbox.openborderpayments.com`. With `DEMO_TRANSACTION_CAP=0`, transaction routes
remain closed while `/health` can independently prove durable-order, authentic-webhook, and
trusted Custom API provenance readiness. Missing prerequisites remain visible only as false
readiness booleans.

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
