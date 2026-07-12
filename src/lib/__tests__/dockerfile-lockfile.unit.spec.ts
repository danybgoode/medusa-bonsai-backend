import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

/**
 * Deploy-pipeline-tuning · Sprint 1 — locks in the lockfile + `npm ci` switch.
 *
 * Before this: no committed `package-lock.json`, both Dockerfile stages ran
 * `npm install` against caret-pinned deps — a rebuild of the identical commit
 * could resolve a different transitive dependency tree, and no Docker layer
 * cache (Sprint 2) could have a stable key. This spec guards against either
 * regressing silently. Plain string/regex checks on the Dockerfile text: no
 * Docker parser dependency, mirrors ci-workflow.unit.spec.ts's shape.
 *
 * See Roadmap/09-platform-infra/deploy-pipeline-tuning/sprint-1.md.
 */

const ROOT = process.cwd()
const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

describe('backend Dockerfile + lockfile — deploy-pipeline-tuning S1 self-check', () => {
  it('package-lock.json is committed', () => {
    expect(existsSync(join(ROOT, 'package-lock.json'))).toBe(true)
  })

  it('package-lock.json name matches package.json name', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'))
    expect(lock.name).toBe(pkg.name)
  })

  it('builder stage copies the lockfile before install and uses npm ci', () => {
    expect(dockerfile).toMatch(/COPY package\.json package-lock\.json .*\n\s*RUN npm ci\b/)
  })

  it('runner stage also copies the lockfile and uses npm ci --omit=dev', () => {
    expect(dockerfile).toMatch(/COPY --from=builder \/app\/package-lock\.json/)
    expect(dockerfile).toMatch(/RUN npm ci --omit=dev/)
  })

  it('neither stage regresses to a bare npm install', () => {
    expect(dockerfile).not.toMatch(/RUN npm install\b/)
  })

  it('CI also installs via npm ci (with the lockfile-hash cache), not npm install', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
    expect(workflow).toMatch(/run: npm ci\b/)
    expect(workflow).not.toMatch(/run: npm install\b/)
    expect(workflow).toMatch(/cache:\s*npm/)
  })
})
