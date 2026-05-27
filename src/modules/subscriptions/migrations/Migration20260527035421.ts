import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260527035421 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "subscription" ("id" text not null, "plan_id" text not null, "customer_id" text null, "clerk_user_id" text null, "buyer_email" text not null, "status" text check ("status" in ('pending', 'active', 'trialing', 'past_due', 'canceled', 'pending_confirmation')) not null default 'pending', "payment_method" text check ("payment_method" in ('stripe', 'mercadopago', 'spei', 'manual')) not null default 'stripe', "stripe_subscription_id" text null, "stripe_customer_id" text null, "mp_preapproval_id" text null, "current_period_start" timestamptz null, "current_period_end" timestamptz null, "cancel_at_period_end" boolean not null default false, "seller_id" text not null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "subscription_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_subscription_deleted_at" ON "subscription" ("deleted_at") WHERE deleted_at IS NULL;`);

    this.addSql(`create table if not exists "subscription_plan" ("id" text not null, "seller_id" text not null, "product_id" text null, "label" text not null, "description" text null, "price_cents" integer not null, "currency" text not null default 'mxn', "interval" text check ("interval" in ('month', 'year')) not null default 'month', "stripe_price_id" text null, "mp_plan_id" text null, "is_active" boolean not null default true, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "subscription_plan_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_subscription_plan_deleted_at" ON "subscription_plan" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "subscription" cascade;`);

    this.addSql(`drop table if exists "subscription_plan" cascade;`);
  }

}
