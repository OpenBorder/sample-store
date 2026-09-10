BEGIN;

-- `abandoned` releases the single-active-checkout claim without asserting an outcome.
--
-- The claim is held by `sample_store_orders_single_active_idx`, whose predicate can
-- never be bounded by age: PostgreSQL requires an index predicate to be IMMUTABLE and
-- rejects `now()` outright ("functions in index predicate must be marked IMMUTABLE").
-- So the claim is only ever released by a write, and this is the status that write
-- sets: outside the claim predicate, and deliberately NOT terminal, so a late terminal
-- webhook still reconciles the order to `paid` or `payment_failed`. Calling an
-- unreconciled order `payment_failed` instead would release the claim just as well and
-- lie whenever the payment had in fact succeeded and only its webhook was late.
ALTER TABLE sample_store_orders
  DROP CONSTRAINT sample_store_orders_status_check;

ALTER TABLE sample_store_orders
  ADD CONSTRAINT sample_store_orders_status_check CHECK (
    status IN ('awaiting_payment', 'payment_submitted', 'abandoned', 'paid', 'payment_failed')
  );

COMMIT;
