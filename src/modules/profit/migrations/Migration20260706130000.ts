import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * financial_event — the append-only profit ledger (profit-analyzer S1 · US-2).
 *
 * The APPEND-ONLY guarantee is enforced IN THE DATABASE: a trigger raises on
 * any UPDATE or DELETE, so no future code path (including Medusa's own
 * auto-generated update/soft-delete service methods) can rewrite financial
 * history — a COGS/fee change lands as a new event, never a mutation. This is
 * the epic's non-negotiable ("changing COGS later must not rewrite history").
 * The unit spec `profit-ledger-migration.unit.spec.ts` guards this file's
 * trigger SQL against accidental removal.
 */
export class Migration20260706130000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "financial_event" ("id" text not null, "order_id" text not null, "order_line_id" text null, "seller_id" text null, "source" text not null, "event_type" text not null, "amount_cents" integer not null, "currency_code" text not null, "dedupe_key" text not null, "captured_at" timestamptz not null, "metadata" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "financial_event_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_financial_event_deleted_at" ON "financial_event" ("deleted_at") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_financial_event_dedupe_key_unique" ON "financial_event" ("dedupe_key") WHERE deleted_at IS NULL;`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_financial_event_seller_id" ON "financial_event" ("seller_id");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_financial_event_order_id" ON "financial_event" ("order_id");`);
    // Append-only enforcement: any UPDATE or DELETE raises. Includes Medusa's
    // soft-delete (an UPDATE of deleted_at) — deliberate: ledger rows are never
    // removed, corrections are new events.
    this.addSql(`
      CREATE OR REPLACE FUNCTION financial_event_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'financial_event is append-only — % is not allowed (write a new event instead)', TG_OP;
      END
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`DROP TRIGGER IF EXISTS financial_event_no_mutation ON "financial_event";`);
    this.addSql(`
      CREATE TRIGGER financial_event_no_mutation
      BEFORE UPDATE OR DELETE ON "financial_event"
      FOR EACH ROW EXECUTE FUNCTION financial_event_append_only();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TRIGGER IF EXISTS financial_event_no_mutation ON "financial_event";`);
    this.addSql(`DROP FUNCTION IF EXISTS financial_event_append_only();`);
    this.addSql(`drop table if exists "financial_event" cascade;`);
  }

}
