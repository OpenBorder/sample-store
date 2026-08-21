CREATE TABLE sample_store_pending_webhooks (
  delivery_hash text PRIMARY KEY,
  payment_reference_hash text NOT NULL,
  terminal_status text NOT NULL CHECK (
    terminal_status IN ('paid', 'payment_failed')
  ),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sample_store_pending_webhooks_reference_idx
  ON sample_store_pending_webhooks (payment_reference_hash, occurred_at);

CREATE INDEX sample_store_pending_webhooks_retention_idx
  ON sample_store_pending_webhooks (received_at);
