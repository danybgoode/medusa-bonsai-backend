import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Deploy-pipeline-tuning · Sprint 2 — locks in the buildx registry-cache
 * switch in cloudbuild.yaml, and guards the load-bearing image-only-deploy
 * contract against a future edit accidentally reintroducing full-deploy
 * semantics (env vars/secrets/scaling flags) into the CI deploy step.
 *
 * A plain `docker build --build-arg BUILDKIT_INLINE_CACHE=1` was tried
 * first and measured (locally AND against real Cloud Build) to cache
 * almost nothing for this multi-stage Dockerfile — inline cache only
 * covers layers reachable from the FINAL stage's own graph, and the
 * npm-ci layer this build wants to skip lives in the discarded `builder`
 * stage. `--cache-to type=registry,...,mode=max` (via buildx) exports
 * every stage's layers instead — confirmed live against real Cloud Build
 * (`gcloud builds submit`, ad hoc, throwaway tags): an identical
 * resubmission dropped from ~12 minutes to ~15 seconds with `CACHED`
 * markers on the builder stage's `npm ci`.
 *
 * Plain string/regex checks on the YAML text: no YAML-parser dependency,
 * mirrors dockerfile-lockfile.unit.spec.ts's shape.
 *
 * See Roadmap/09-platform-infra/deploy-pipeline-tuning/sprint-2.md.
 */

const ROOT = process.cwd()
const cloudbuildFull = readFileSync(join(ROOT, 'cloudbuild.yaml'), 'utf8')
// Assertions about the ACTIVE config must not trip on the header comment's
// prose, which legitimately explains (and quotes) the rejected inline-cache
// approach for context. Scope to the machine-read part: from `steps:` on.
const cloudbuild = cloudbuildFull.slice(cloudbuildFull.indexOf('\nsteps:'))
const preamble = cloudbuildFull.slice(0, cloudbuildFull.indexOf('\nsteps:'))

describe('cloudbuild.yaml — deploy-pipeline-tuning S2 self-check', () => {
  it('bootstraps a docker-container buildx builder (the classic docker driver cannot export cache)', () => {
    expect(cloudbuild).toMatch(/buildx\s*\n\s*-\s*create/)
    expect(cloudbuild).toMatch(/--driver\s*\n\s*-\s*docker-container/)
    expect(cloudbuild).toMatch(/--name\s*\n\s*-\s*cloudbuildx/)
  })

  it('the build step explicitly selects the bootstrapped builder by name (cross-review, Codex) — each Cloud Build step is its own container, so a bare `docker buildx create --use` in a PRIOR step may not leave the "current builder" selection visible to a later step\'s buildx CLI invocation; passing `--builder cloudbuildx` removes any reliance on that implicit cross-step state', () => {
    expect(cloudbuild).toMatch(/buildx\s*\n\s*-\s*build\s*\n\s*-\s*--builder\s*\n\s*-\s*cloudbuildx/)
  })

  it('builds with buildx using a registry-backed mode=max cache (not the weaker inline-cache method)', () => {
    expect(cloudbuild).toMatch(/type=registry,ref=.*buildcache/)
    expect(cloudbuild).toMatch(/mode=max/)
    expect(cloudbuild).not.toMatch(/--build-arg/)
  })

  it('pushes directly via buildx build --push (not a separate docker push step)', () => {
    expect(cloudbuild).toMatch(/--push/)
    expect(cloudbuild).not.toMatch(/\n\s*-\s*push\s*\n\s*name:\s*gcr\.io\/cloud-builders\/docker/)
  })

  it('has no top-level images: list (buildx --push already pushes both tags; a stale images: list would try to re-push from the buildx-isolated daemon and fail)', () => {
    // Independent pr-reviewer catch (flagged on the sibling frontend PR, same
    // pattern here): a top-level `images:` block conventionally sits BEFORE
    // `steps:` (that's where it lived pre-S2) — asserting against the
    // post-`steps:` `cloudbuild` slice wouldn't catch it reappearing in its
    // normal position. Check the FULL file.
    expect(cloudbuildFull).not.toMatch(/^images:/m)
  })

  it('the preamble comment still explains why inline cache was rejected (context for the next reader)', () => {
    expect(preamble).toMatch(/BUILDKIT_INLINE_CACHE/)
    expect(preamble).toMatch(/mode=max/)
  })

  it('the deploy step remains image-only — no env/secrets/scaling flags reintroduced into CI', () => {
    const deployStepMatch = cloudbuild.match(/- id: deploy[\s\S]*$/)
    expect(deployStepMatch).toBeTruthy()
    const deployStep = deployStepMatch![0]
    expect(deployStep).toMatch(/--image=/)
    expect(deployStep).not.toMatch(/--set-env-vars/)
    expect(deployStep).not.toMatch(/--set-secrets/)
    expect(deployStep).not.toMatch(/--min-instances/)
    expect(deployStep).not.toMatch(/--max-instances/)
    expect(deployStep).not.toMatch(/--concurrency/)
  })

  it('still deploys to the same service/region substitutions as before', () => {
    expect(cloudbuildFull).toMatch(/_SERVICE:\s*medusa-web/)
    expect(cloudbuildFull).toMatch(/_REGION:\s*us-east4/)
  })
})
