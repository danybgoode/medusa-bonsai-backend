import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260703120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "ml_applied_order" ("id" text not null, "link_id" text not null, "ml_order_id" text not null, "medusa_order_id" text null, "inventory_delta" integer not null, "applied_at" timestamptz not null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "ml_applied_order_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_ml_applied_order_deleted_at" ON "ml_applied_order" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ml_applied_order_link_id_ml_order_id_unique" ON "ml_applied_order" ("link_id", "ml_order_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "ml_applied_order" cascade;`);
  }

}
