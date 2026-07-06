/**
 * Config guard (profit-analyzer S1 · US-2): the financial_event migration must
 * keep its append-only Postgres trigger — the DB-level enforcement that no
 * code path (present or future) can UPDATE/DELETE ledger rows. Same
 * anti-erosion shape as the deploy-invariants/raw-color guards: a pure read
 * of the artifact, failing CI if the guarantee is quietly removed.
 */
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations')

function migrationSources(): string {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
    .join('\n')
}

describe('financial_event migration — append-only trigger guard', () => {
  const sql = migrationSources()

  it('creates the financial_event table with the unique dedupe_key index', () => {
    expect(sql).toContain('create table if not exists "financial_event"')
    expect(sql).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "IDX_financial_event_dedupe_key_unique"/)
  })

  it('installs a trigger that raises on UPDATE and DELETE', () => {
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION financial_event_append_only\(\) RETURNS trigger/)
    expect(sql).toMatch(/RAISE EXCEPTION/)
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON "financial_event"/)
    expect(sql).toMatch(/EXECUTE FUNCTION financial_event_append_only\(\)/)
  })
})
