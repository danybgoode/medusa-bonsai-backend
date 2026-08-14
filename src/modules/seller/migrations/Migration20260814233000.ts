import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Seller lifecycle status (tenant-lifecycle-admin · D1).
 *
 * Additive and safe on a populated table: the column is NOT NULL with a default, so
 * every existing seller reads 'active' the moment it lands — there is no window in
 * which a live shop has an unreadable status.
 *
 * Deliberately `text` + a CHECK rather than a Postgres enum. Adding a state to an
 * enum requires its own migration and a deploy; a CHECK constraint states the same
 * invariant at the database while the authoritative parser lives in
 * `src/lib/seller-status.ts`, which every caller goes through. The CHECK is the
 * backstop for a direct SQL write, not the primary gate.
 */
export class Migration20260814233000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "seller" add column if not exists "status" text not null default 'active';`);
    this.addSql(`alter table if exists "seller" drop constraint if exists "seller_status_check";`);
    this.addSql(`alter table if exists "seller" add constraint "seller_status_check" check ("status" in ('active','paused','deleted'));`);
    // Partial index: the admin directory filters on the non-active states, which are
    // the rare ones. Indexing only those keeps it small and keeps the common
    // status='active' catalog reads on their existing plans.
    this.addSql(`create index if not exists "IDX_seller_status_not_active" on "seller" ("status") where "status" <> 'active';`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index if exists "IDX_seller_status_not_active";`);
    this.addSql(`alter table if exists "seller" drop constraint if exists "seller_status_check";`);
    this.addSql(`alter table if exists "seller" drop column if exists "status";`);
  }

}
