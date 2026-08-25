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
    // Match the INVARIANT (a production-only install in the runner stage), not the exact spelling.
    // A BuildKit cache mount was added to this step and the old literal `RUN npm ci --omit=dev`
    // pattern read a correct change as a regression — the same trap LEARNINGS records: pin what must
    // be true, not how it is currently written.
    expect(dockerfile).toMatch(/RUN (?:--mount=\S+ )*npm ci --omit=dev/)
  })

  it('neither stage regresses to a bare npm install', () => {
    // The mount prefix must be part of the NEGATIVE pattern too, or `RUN --mount=... npm install`
    // slips straight past the guard that exists to keep caret-pinned installs out of the image.
    expect(dockerfile).not.toMatch(/RUN (?:--mount=\S+ )*npm install\b/)
  })

  // Node 24 is "Krypton", the ACTIVE LTS. The `<25` ceiling is deliberate and predates this bump:
  // odd-numbered Node lines are never LTS, so it says "no Current-line Node in production" rather
  // than naming a version. Moved 22 -> 24 on 2026-08-25; 22 ("Jod") is the PREVIOUS LTS and we were
  // a full line behind. Node 26 is not LTS until 2026-10, which is why this stops at 24.
  //
  // All four move together or none do — a Dockerfile on one line, CI on another and `engines` on a
  // third is the shape where a build passes and the deployed image is something else.
  it('builder, runner, package engine, and CI stay on the Node 24 runtime floor', () => {
    expect(dockerfile.match(/^FROM node:24-slim AS /gm)).toHaveLength(2)
    expect(pkg.engines.node).toBe('>=24 <25')
    expect(pkg.devDependencies['@types/node']).toMatch(/^\^24\./)   // types must describe the runtime we ship

    const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
    expect(workflow).toMatch(/node-version:\s*24/)
  })

  it('CI also installs via npm ci (with the lockfile-hash cache), not npm install', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
    expect(workflow).toMatch(/run: npm ci\b/)
    expect(workflow).not.toMatch(/run: npm install\b/)
    expect(workflow).toMatch(/cache:\s*npm/)
  })

  // The runner Dockerfile stage runs `npm ci --omit=dev` against `medusa
  // build`'s GENERATED .medusa/server/package.json, not this file — but it
  // copies the SAME package-lock.json (generated against THIS package.json)
  // into that stage. That only works if the two dependency sets are
  // identical. CI's own gate runs `npm run build` (Build step) before `npm
  // run test:unit` (Unit tests step) — see .github/workflows/ci.yml — so
  // .medusa/server/package.json is guaranteed to exist here, letting this
  // assert the real claim instead of just the Dockerfile's text shape. A
  // future Medusa version that changes what medusa build emits would fail
  // this test in CI, well before it could break a live Cloud Run deploy.
  it('.medusa/server/package.json (medusa build output) has IDENTICAL deps to package.json — the lockfile-reuse premise', () => {
    const builtPkgPath = join(ROOT, '.medusa/server/package.json')
    if (!existsSync(builtPkgPath)) {
      throw new Error(
        '.medusa/server/package.json not found — this test must run AFTER `npm run build` ' +
        '(medusa build), exactly as CI does (Build step precedes Unit tests step in ci.yml).',
      )
    }
    const built = JSON.parse(readFileSync(builtPkgPath, 'utf8'))
    expect(built.dependencies).toEqual(pkg.dependencies)
    expect(built.devDependencies).toEqual(pkg.devDependencies)
  })
})
