import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260701200527 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "ml_sync_event" ("id" text not null, "seller_id" text not null, "product_id" text null, "ml_item_id" text null, "kind" text not null, "outcome" text not null, "code" text null, "message" text null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "ml_sync_event_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_ml_sync_event_deleted_at" ON "ml_sync_event" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_ml_sync_event_seller_id_created_at" ON "ml_sync_event" ("seller_id", "created_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "ml_sync_event" cascade;`);
  }

}
