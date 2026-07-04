import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260704010000 extends Migration {

  override async up(): Promise<void> {
    // getAppliedOrderByMedusaOrderId (US-4 cancel path) is now a hot lookup keyed
    // by this column, called once per reconcile candidate every 30 min — without
    // an index this is a sequential scan that only grows worse over time.
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_ml_applied_order_medusa_order_id" ON "ml_applied_order" ("medusa_order_id") WHERE medusa_order_id IS NOT NULL AND deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP INDEX IF EXISTS "IDX_ml_applied_order_medusa_order_id";`);
  }

}
