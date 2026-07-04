import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260704000000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "ml_applied_order" add column if not exists "edge_logged_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "ml_applied_order" drop column if exists "edge_logged_at";`);
  }

}
