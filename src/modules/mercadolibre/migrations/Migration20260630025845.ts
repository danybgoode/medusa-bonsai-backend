import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260630025845 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "product_ml_link" drop constraint if exists "product_ml_link_product_id_ml_item_id_unique";`);
    this.addSql(`alter table if exists "ml_connection" drop constraint if exists "ml_connection_seller_id_unique";`);
    this.addSql(`create table if not exists "ml_connection" ("id" text not null, "seller_id" text not null, "ml_user_id" text not null, "ml_nickname" text null, "country_code" text not null default 'MX', "access_token_enc" text not null, "refresh_token_enc" text not null, "expires_at" timestamptz not null, "status" text check ("status" in ('connected', 'disconnected')) not null default 'connected', "last_refreshed_at" timestamptz null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "ml_connection_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_ml_connection_deleted_at" ON "ml_connection" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_ml_connection_seller_id_unique" ON "ml_connection" ("seller_id") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "product_ml_link" ("id" text not null, "seller_id" text not null, "product_id" text not null, "variant_id" text null, "ml_item_id" text not null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "product_ml_link_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_product_ml_link_deleted_at" ON "product_ml_link" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_product_ml_link_product_id_ml_item_id_unique" ON "product_ml_link" ("product_id", "ml_item_id") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "ml_connection" cascade;`);

    this.addSql(`drop table if exists "product_ml_link" cascade;`);
  }

}
