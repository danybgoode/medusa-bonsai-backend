import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260526212516 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "seller" drop constraint if exists "seller_slug_unique";`);
    this.addSql(`alter table if exists "seller" drop constraint if exists "seller_clerk_user_id_unique";`);
    this.addSql(`create table if not exists "seller" ("id" text not null, "clerk_user_id" text not null, "slug" text not null, "name" text not null, "description" text null, "location" text null, "logo_url" text null, "source" text null, "source_url" text null, "verified" boolean not null default false, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "seller_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_seller_clerk_user_id_unique" ON "seller" ("clerk_user_id") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_seller_slug_unique" ON "seller" ("slug") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_seller_deleted_at" ON "seller" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "seller" cascade;`);
  }

}
