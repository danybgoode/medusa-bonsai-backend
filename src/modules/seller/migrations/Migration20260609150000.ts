import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260609150000 extends Migration {

  override async up(): Promise<void> {
    // Unclaimed (supply-imported) sellers have no Clerk identity until claimed.
    // The partial unique index (IDX_seller_clerk_user_id_unique) tolerates NULLs.
    this.addSql(`alter table if exists "seller" alter column "clerk_user_id" drop not null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "seller" alter column "clerk_user_id" set not null;`);
  }

}
