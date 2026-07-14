# Customer demo: Custom API checkout

Target length: 5 minutes. Start with the working buyer flow, then explain the integration.

## Before recording

- Open the deployed sample store in a clean browser profile.
- Confirm `/health` reports test mode.
- Use a dedicated demo buyer and non-sensitive shipping address.
- Open the staging merchant **Transactions** page in a second tab.
- Hide bookmarks, notifications, environment settings, and all secret-key screens.

## Recording flow

1. **Show the outcome first.** Choose GBP and open the hoodie. Point out `GBP → obmor_uk`.
2. **Open checkout.** Use a UK address and show the tax, duty, and final total before payment.
3. **Complete a test payment.** Use the standard test card. Do not show or paste any API key.
4. **Read the receipt.** Show the succeeded status, Open Border intent ID, entity, and matching
   subtotal/tax/duty/total.
5. **Show monitoring.** Copy the intent ID, switch to the staging merchant dashboard, search it,
   and confirm the transaction matches the receipt.
6. **Explain the integration in one minute.** The browser uses the publishable key with
   `@open-border/js`; the backend keeps the secret key and uses `@open-border/node` for the tax
   quote and payment intent.
7. **Close with safety.** Mention that the displayed quote is signed, retries reuse one checkout
   key, public inputs are catalog-validated, and live keys are refused.

## Optional failure clip

- Submit without a complete buyer address to show the clear validation message, or use an
  approved decline test card.
- Show only the safe customer message and request ID. Do not open provider logs in the video.

## Final sentence

“This is the same public integration a developer can clone: test-mode checkout, tax and duty,
entity routing, safe retries, and transaction monitoring end to end.”
