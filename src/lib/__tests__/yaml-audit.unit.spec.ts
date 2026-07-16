import { findYamlParseOffenders, findYamlParseOffendersInFiles, formatYamlOffense } from '../yaml-audit'

/**
 * YAML lint, Phase 2 (backend) — a pure structural check, not style or GitHub-Actions semantics
 * (that's actionlint's job in .github/workflows/yaml-guard.yml). Protects the deploy-critical
 * cloudbuild.yaml + .github/dependabot.yml: a malformed one fails silently until the next deploy /
 * dependency-update run, and nothing in tsc/build/jest would otherwise catch it. cwd is the package
 * root (apps/backend) under jest, matching ci-workflow.unit.spec.ts's own convention.
 */

describe('YAML integrity guard', () => {
  it('the canonical deploy-critical YAML files (cloudbuild.yaml, dependabot.yml) parse cleanly', () => {
    const offenders = findYamlParseOffenders(process.cwd())
    expect(offenders.map(formatYamlOffense)).toEqual([])
  })

  it('negative fixture: malformed YAML goes red', () => {
    const offenders = findYamlParseOffendersInFiles([
      { filePath: 'cloudbuild.yaml', content: 'steps:\n  - name: gcr.io/cloud-builders/docker\n    args: [\n' },
    ])
    expect(offenders).toHaveLength(1)
    expect(offenders[0].filePath).toBe('cloudbuild.yaml')
  })

  it('positive fixture: well-formed YAML stays green', () => {
    const offenders = findYamlParseOffendersInFiles([
      { filePath: 'cloudbuild.yaml', content: 'steps:\n  - name: gcr.io/cloud-builders/docker\n    args: ["build", "."]\n' },
    ])
    expect(offenders).toEqual([])
  })
})
