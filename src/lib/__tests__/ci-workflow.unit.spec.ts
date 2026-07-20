import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Dev-tooling reliability · Sprint 1 — the CI gate's self-check.
 *
 * The backend's pre-merge gate (.github/workflows/ci.yml) tests the source; this spec tests
 * the gate, so it can't be silently gutted (e.g. a step deleted, the trigger narrowed, a DB
 * service quietly added). It runs INSIDE `npm run test:unit` — the same gate it guards — so a
 * green local `test:unit` also proves the workflow shape. Plain string/regex checks: no YAML
 * parser dependency. cwd is the package root (apps/backend) under jest.
 *
 * See Roadmap/09-platform-infra/dev-tooling-reliability/sprint-1.md.
 */

const workflow = readFileSync(
  join(process.cwd(), '.github/workflows/ci.yml'),
  'utf8',
)

describe('backend CI workflow (ci.yml) — self-check', () => {
  it('triggers on pull_request for opened/synchronize/reopened', () => {
    expect(workflow).toMatch(/on:\s*\n\s*pull_request:/)
    expect(workflow).toMatch(/types:\s*\[opened,\s*synchronize,\s*reopened\]/)
  })

  it('cancels superseded runs (concurrency)', () => {
    expect(workflow).toMatch(/cancel-in-progress:\s*true/)
  })

  it('pins Node 22 to match package.json engines', () => {
    expect(workflow).toMatch(/node-version:\s*22/)
  })

  it('runs build, then type-check, then unit tests', () => {
    expect(workflow).toContain('npm run build')
    expect(workflow).toContain('npx tsc --noEmit')
    expect(workflow).toContain('npm run test:unit')
    // build must precede tsc — it generates the .medusa/types tsc resolves against.
    expect(workflow.indexOf('npm run build')).toBeLessThan(
      workflow.indexOf('npx tsc --noEmit'),
    )
  })

  it('does NOT run an e2e/Playwright step (the backend has no preview)', () => {
    // Guard the executable steps, not prose — the header comment legitimately
    // explains *why* there's no e2e, so we ban the commands, not the word.
    expect(workflow).not.toContain('test:e2e')
    expect(workflow).not.toMatch(/run:.*playwright/i)
    expect(workflow).not.toMatch(/playwright\s+install/i)
  })

  it('does NOT spin up a DB/Redis service container (unit specs are DB-free)', () => {
    expect(workflow).not.toMatch(/^\s*services:/m)
  })
})
