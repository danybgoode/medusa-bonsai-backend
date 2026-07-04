import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260703180000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "ml_applied_order" add column if not exists "cancelled_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "ml_applied_order" drop column if exists "cancelled_at";`);
  }

}
