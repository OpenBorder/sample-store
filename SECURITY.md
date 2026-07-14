# Security

This repository is a public test-mode reference application.

- Never commit `.env` files or Open Border credentials.
- The server refuses live keys and restricts custom API URLs to local or staging/dev hosts.
- The secret key stays server-side; only the publishable key is returned to the browser.
- Public product prices and tariff codes are resolved against the server catalog.
- Displayed quotes are signed and bound to one checkout before payment creation.
- Payment creation has a best-effort per-instance throttle and uses a stable idempotency key.
- Public deployments should also enforce a platform-level rate limit because serverless instances
  do not share in-memory counters.

Report security concerns privately to the Open Border engineering team. Do not include keys,
customer information, or exploitable payment details in a public issue.
