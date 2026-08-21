# Security

This repository is a public test-mode reference application.

- Never commit `.env` files or Open Border credentials.
- The hosted server starts at a transaction cap of zero and accepts only exact integer caps from
  zero through 50. Positive caps count orders per UTC day under a global PostgreSQL lock, and the
  database permits only one unresolved checkout. The server refuses Live keys and accepts only the
  exact production-dashboard Sandbox API host.
- The secret key stays server-side; only the publishable key is returned to the browser.
- Public product prices and tariff codes are resolved against the server catalog.
- Displayed quotes are signed and bound to one checkout before payment creation.
- Orders and stable idempotency keys are durably persisted before payment creation.
- Provider and webhook delivery references are stored only as keyed hashes.
- Terminal order state changes require a timestamped, authentic raw-body webhook whose signed
  event declares Test mode; duplicate deliveries are durably ignored, while signed non-Test
  events are acknowledged without reconciliation or delivery retention.
- Public deployments should also enforce a platform-level rate limit because serverless instances
  do not share in-memory counters.

Report security concerns privately to the Open Border engineering team. Do not include keys,
customer information, or exploitable payment details in a public issue.
