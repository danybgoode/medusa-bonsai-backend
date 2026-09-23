import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The container entrypoint must never run an INTERACTIVE migration. `medusa db:migrate` prompts on
 * any link-table UPDATE/DELETE; with no TTY the prompt hangs, the server never binds :8080 and
 * Cloud Run kills the revision after its 4-minute startup probe. It happened on every backend
 * deploy for 11 days (2026-09-11 → 09-22) while production silently stayed on an old revision.
 */
const ROOT = join(__dirname, '..', '..', '..')
const entrypoint = readFileSync(join(ROOT, 'docker-entrypoint.sh'), 'utf8')
const executable = entrypoint
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n')

describe('docker-entrypoint.sh — non-interactive migrations', () => {
  it('every `medusa db:migrate` it runs passes --execute-safe-links', () => {
    const migrates = executable.match(/medusa db:migrate[^\n]*/g) ?? []
    expect(migrates.length).toBeGreaterThan(0)
    for (const call of migrates) expect(call).toContain('--execute-safe-links')
  })

  it('never auto-executes UNSAFE link actions (a boot must not drop link tables)', () => {
    expect(executable).not.toContain('--execute-all-links')
  })

  it('the installed Medusa CLI still recognises the flag — a renamed flag must fail here, not in prod', () => {
    const cli = readFileSync(
      join(ROOT, 'node_modules', '@medusajs', 'cli', 'dist', 'create-cli.js'),
      'utf8',
    )
    expect(cli).toContain('"execute-safe-links"')
  })
})
