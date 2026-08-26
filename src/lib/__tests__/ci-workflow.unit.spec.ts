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

  it('pins Node 24 to match package.json engines', () => {
    expect(workflow).toMatch(/node-version:\s*24/)
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

  // The intent here is unchanged and still right — the UNIT job must stay DB-free and fast — but the
  // assertion was written when no job in this file had services at all, so a bare "no `services:`
  // anywhere" was a fine proxy. It stopped being one on 2026-08-25, when the money-path integration
  // job arrived with real Postgres and Redis. Scoped to the job it is actually about, rather than
  // deleted: a guard that fires on correct output gets bypassed, and one deleted for firing loses
  // the invariant entirely.
  it('the unit job stays DB-free — no service container on type-check-build', () => {
    const unitJob = workflow.slice(
      workflow.indexOf('  type-check-build:'),
      workflow.indexOf('  money-path:'),
    )
    expect(unitJob.length).toBeGreaterThan(0)   // the slice must actually find the job
    expect(unitJob).not.toMatch(/^\s*services:/m)
  })

  // Engine bumps auto-merge from 2026-08-26, and the ONLY thing making that safe is that the
  // money-path job is a REQUIRED check on main — `--auto` holds the merge until a required check
  // passes and drops it if the check fails. A non-required job would let dependabot merge on the
  // build check alone while the money-path result was merely advisory, which is the pre-gate world
  // with extra steps.
  //
  // Branch protection is server-side config this repo cannot read from a unit test, so this asserts
  // the two halves that ARE in the tree and must not drift apart: the job exists under the exact
  // name registered as required, and the workflow no longer excludes @medusajs from auto-merge.
  // The check name is the coupling — renaming the job silently un-requires it.
  // This workflow has now broken SILENTLY twice, both times in the same shape: it ran, reported a
  // step, and merged nothing.
  //   1. `gh pr review --approve` always failed ("GitHub Actions is not permitted to approve pull
  //      requests"), and under `bash -e` that aborted the step BEFORE the merge was queued.
  //   2. Removing that line collapsed the two-command `run: |` into a one-liner and took the `env:`
  //      block with it, so GH_TOKEN was unset — `gh` exited 4 and, again, nothing merged.
  // A workflow that fails loudly is fine. One that runs and quietly does nothing is how a
  // dependency queue silently goes stale, which is the whole failure this automation exists to fix.
  it('every gh command in the auto-merge workflow carries GH_TOKEN', () => {
    const automerge = readFileSync(
      join(process.cwd(), '.github/workflows/dependabot-automerge.yml'),
      'utf8',
    )
    // Each `run:` invoking gh must be followed by an env block providing GH_TOKEN before the next
    // step begins. Asserted per-command rather than "the file contains GH_TOKEN somewhere", which
    // would pass with the token attached to the wrong step.
    const steps = automerge.split(/^      - name: /m).slice(1)
    const ghSteps = steps.filter((step) => /^\s*run:.*\bgh /m.test(step))
    expect(ghSteps.length).toBeGreaterThan(0)   // never pass by finding no gh commands at all
    for (const step of ghSteps) {
      expect(step).toMatch(/GH_TOKEN:/)
    }

    // And the approve that cannot work must not come back — it is not a permission we can grant.
    // Matched against EXECUTABLE lines only: the comments deliberately name the command to explain
    // why it is banned, and a guard that fires on its own documentation is a guard people delete.
    // (Caught by this assertion failing on its own explanation, which is the check working.)
    const executable = automerge
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(executable).not.toContain('gh pr review --approve')
  })

  it('the auto-merge policy and the money-path job agree — the name is the coupling', () => {
    const REQUIRED_CHECK_NAME = 'Money path (integration)'
    expect(workflow).toContain(`name: ${REQUIRED_CHECK_NAME}`)

    const automerge = readFileSync(
      join(process.cwd(), '.github/workflows/dependabot-automerge.yml'),
      'utf8',
    )
    // Majors stay human-reviewed...
    expect(automerge).toContain("steps.meta.outputs.update-type != 'version-update:semver-major'")
    // ...and the engine exclusion is gone, deliberately, now that the gate exists.
    expect(automerge).not.toMatch(/!\s*contains\(steps\.meta\.outputs\.dependency-names, '@medusajs\/'\)/)
    expect(automerge).not.toMatch(/dependency-group != 'medusa-framework'/)
  })

  it('the money-path job DOES bring a real Postgres, and fails on an empty match', () => {
    // The consumer-side gate. Its absence is what let a 68-package engine upgrade go green through
    // a CI that had never created a cart. And `--passWithNoTests=false` is load-bearing: the
    // PREVIOUS integration tier matched a directory that never existed and exited 0 for its whole
    // life, reading as a green gate (see jest.config.js).
    expect(workflow).toMatch(/^\s{2}money-path:/m)
    expect(workflow).toContain('postgres:16-alpine')
    expect(workflow).toContain('npm run test:integration:http')

    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    expect(pkg.scripts['test:integration:http']).toContain('--passWithNoTests=false')
  })
})
