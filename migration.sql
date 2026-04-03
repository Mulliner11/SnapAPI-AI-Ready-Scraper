ALTER TABLE "app_orders" ADD COLUMN IF NOT EXISTS "order_ref" TEXT;
CREATE INDEX IF NOT EXISTS "app_orders_order_ref_idx" ON "app_orders"("order_ref");
