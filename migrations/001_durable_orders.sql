CREATE TABLE sample_store_orders (
  checkout_id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  payment_reference_hash text UNIQUE,
  status text NOT NULL CHECK (
    status IN ('awaiting_payment', 'payment_submitted', 'paid', 'payment_failed')
  ),
  product_id text NOT NULL,
  amount integer NOT NULL CHECK (amount > 0),
  currency text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sample_store_webhook_deliveries (
  delivery_hash text PRIMARY KEY,
  checkout_id text NOT NULL REFERENCES sample_store_orders(checkout_id),
  received_at timestamptz NOT NULL
);

CREATE INDEX sample_store_webhook_deliveries_retention_idx
  ON sample_store_webhook_deliveries (received_at);
