# Security

This repository is a public test-mode reference application.

- Never commit `.env` files or Open Border credentials.
- Order state, the UTC-day count, the active-checkout claim and webhook delivery evidence are held
  in the serving process's memory; there is no database. On a serverless host these are per
  instance, so the cap and the one-checkout limit are a brake rather than a store-wide ceiling, and
  a platform-level rate-limit rule is the control that does not depend on instance identity.
- The hosted server starts at a transaction cap of zero and accepts only exact integer caps from
  zero through 50. Positive caps count orders per UTC day, and only one unresolved checkout is
  admitted at a time; a claim nothing has advanced for 15 minutes is reclaimed by the next
  admission, so a dropped delivery costs one order rather than the store. The server refuses Live
  keys and accepts only an API host on its explicit allowlist: the production-dashboard Sandbox
  host and the staging host. Each must match exactly, with no path, query, fragment or credentials,
  and Test credentials are refused independently of the host, so every reachable target is a
  Test-rail host.
- The secret key stays server-side; only the publishable key is returned to the browser.
- Public product prices and tariff codes are resolved against the server catalog.
- Displayed quotes are signed and bound to one checkout before payment creation.
- Orders and HMAC-bound stable idempotency keys are recorded before payment creation. The key is
  derived from the submission rather than stored, so it is stable across instances and restarts
  even though the order record is not. It fingerprints the exact provider submission, so a changed retry is rejected before
  payment-intent I/O and an ambiguous provider response remains nonterminal for authentic reconciliation.
- Provider and webhook delivery references are stored only as keyed hashes.
- Terminal order state changes require a timestamped, authentic raw-body webhook whose signed
  event declares Test mode, and trusted `custom_api` provenance wherever the target attests it
  (see the accepted risk below). Duplicate deliveries are
  ignored, while signed non-Test or foreign-demo events are acknowledged without reconciliation
  or delivery retention. An early owned terminal delivery may be staged only while one checkout
  is active; that hash-only staging area is capped at eight entries and expires after 15 minutes.
- Accepted delivery evidence uses local receipt time for retention; signed provider occurrence
  time is retained separately only while an early delivery is pending.
- Public deployments must enforce a platform-level rate limit: serverless instances share no
  state, so every in-process limit above is per instance.
- Cap-preserving upgrades require an edge maintenance rule that blocks only transaction POSTs
  while keeping authentic webhooks reachable until deployment and aggregate checks finish.

## Accepted risk: the public store runs against staging

The public demo store is deployed against the **staging** API, and staging does not issue demo
provenance. `demo_store: 'custom_api'` is returned only by the demo stage, so the attestation the
store would verify does not exist on any other target — requiring it against staging would leave
products visible and checkout permanently dead. Provenance therefore follows the HOST rather than a
separate switch, which is what keeps the two from drifting, and `/health` reports
`trustedDemoProvenanceRequired: false` rather than hiding the relaxation.

**This is a deliberate, accepted risk, not a side effect.** The guard exists to stop a public demo
transacting somewhere unintended, and it is off whenever the target is staging.

What still holds when it is off:

- The API host must match the allowlist exactly, and every entry on that allowlist is a Test-rail
  host.
- Test credentials are refused independently of the host, so a Live key cannot be used at all.
- The transaction cap, the one-unresolved-checkout limit, quote signing, and webhook authenticity
  and Test-mode checks are all unaffected.

What no longer holds: the store does not verify it is talking to a recognised demo merchant on the
demo rail. A misconfigured `OB_API_URL` pointing at another allowlisted Test-rail host would be
transacted against rather than refused.

Report security concerns privately to the Open Border engineering team. Do not include keys,
customer information, or exploitable payment details in a public issue.
