CREATE INDEX sample_store_orders_utc_day_idx
  ON sample_store_orders (created_at);

CREATE UNIQUE INDEX sample_store_orders_single_active_idx
  ON sample_store_orders ((1))
  WHERE status IN ('awaiting_payment', 'payment_submitted');
