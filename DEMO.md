# Customer demo: Custom API checkout

Target length: 5 minutes. Start with the working buyer flow, then explain the integration.

## Before recording

- Open the local tutorial store at `http://127.0.0.1:4000` in a clean browser profile.
- Confirm `/health` reports `local-tutorial`, cap `1`, zero usage, no active checkout, and
  `trustedDemoProvenanceRequired: false`. It truthfully reports non-durable orders and no authentic
  webhooks; do not describe the local tutorial as production-ready or reconciled.
- Use a dedicated demo buyer and non-sensitive shipping address.
- Open the production dashboard's **Sandbox Transactions** view in a second tab.
- Hide bookmarks, notifications, environment settings, and all secret-key screens.

## Recording flow

1. **Show the outcome first.** Choose GBP and open the hoodie. Point out the United Kingdom
   settlement region without showing an internal routing identifier.
2. **Open checkout.** Use a UK address and show the tax, duty, and final total before payment.
3. **Complete one synthetic Test payment.** Do not show or paste any credential or provider
   identifier.
4. **Read the receipt.** Show the submitted state and matching subtotal/tax/duty/total. Explain
   that this local tutorial has no webhook reconciliation and does not prove a terminal order.
5. **Show monitoring.** Switch to the production dashboard's Sandbox view and confirm the
   aggregate transaction status without recording identifiers or customer details.
6. **Explain the integration in one minute.** The browser uses the publishable key with
   `@open-border/js`; the backend keeps the secret key and uses `@open-border/node` for the tax
   quote and payment intent.
7. **Close with safety.** Mention that the displayed quote is signed, retries reuse one checkout
   key, the local server admits one in-memory Test checkout per restart, public inputs are
   catalog-validated, and live keys are refused.

## Optional failure clip

- Never record this clip during the exactly-one production lifecycle proof. It requires separate
  approval and a separate evidence window.
- Submit without a complete buyer address to show the clear validation message, or use an
  approved decline test card.
- Show only the safe customer message and request ID. Do not open provider logs in the video.

## Final sentence

“This local tutorial uses the same Test API integration a developer can clone, with safe retries
and one in-memory checkout; production requires durable orders and authentic reconciliation.”
