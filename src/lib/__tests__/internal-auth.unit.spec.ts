import { readFileSync, readdirSync } from 'fs'
import { join, relative, sep } from 'path'
import { INTERNAL_SECRET_HEADER, internalSecretMissing, internalSecretOk } from '../internal-auth'

/**
 * The internal-route auth guard, and the POPULATION it has to hold for.
 *
 * Fifteen guards across fourteen files were fail-OPEN — "if the secret is not
 * configured, let everyone in" — in three different spellings. The behavioural specs
 * below pin the rule; the source-level sweep at the bottom pins that no file has
 * drifted back to any of the three shapes, because the shape is what spread.
 */

const SECRET = 's3cr3t'
const req = (value?: unknown) => ({
  headers: value === undefined ? {} : { [INTERNAL_SECRET_HEADER]: value },
})

describe('internalSecretOk — absent configuration DENIES', () => {
  it('denies when the env var is unset (the whole point)', () => {
    expect(internalSecretOk(req(SECRET), {})).toBe(false)
    expect(internalSecretOk(req(), {})).toBe(false)
    expect(internalSecretOk(req(undefined), {})).toBe(false)
  })

  it('denies when the env var is empty or whitespace', () => {
    expect(internalSecretOk(req(''), { MEDUSA_INTERNAL_SECRET: '' })).toBe(false)
    expect(internalSecretOk(req('   '), { MEDUSA_INTERNAL_SECRET: '   ' })).toBe(false)
    // …including the case where header and (blank) env would otherwise be "equal".
    expect(internalSecretOk(req(''), {})).toBe(false)
  })

  it('denies a missing, non-string or mismatched header', () => {
    const env = { MEDUSA_INTERNAL_SECRET: SECRET }
    expect(internalSecretOk(req(), env)).toBe(false)
    expect(internalSecretOk(req(''), env)).toBe(false)
    expect(internalSecretOk(req('wrong'), env)).toBe(false)
    expect(internalSecretOk(req(['s3cr3t']), env)).toBe(false)
    expect(internalSecretOk(req(42), env)).toBe(false)
    expect(internalSecretOk(req(` ${SECRET} `), env)).toBe(false)
  })

  it('allows exactly one case: configured AND matching', () => {
    expect(internalSecretOk(req(SECRET), { MEDUSA_INTERNAL_SECRET: SECRET })).toBe(true)
    // Surrounding whitespace on the CONFIGURED value is tolerated (a secret pasted
    // into a console picks up a newline); the presented header is compared exactly.
    expect(internalSecretOk(req(SECRET), { MEDUSA_INTERNAL_SECRET: `${SECRET}\n` })).toBe(true)
  })

  it('internalSecretMissing is the exact negation', () => {
    for (const env of [{}, { MEDUSA_INTERNAL_SECRET: SECRET }]) {
      for (const header of [undefined, '', 'wrong', SECRET]) {
        expect(internalSecretMissing(req(header), env)).toBe(!internalSecretOk(req(header), env))
      }
    }
  })

  it('survives a malformed request object rather than throwing past the guard', () => {
    // A guard that throws is a 500, not a 401 — and a 500 in a `catch` somewhere
    // upstream can become a success. Deny instead.
    expect(internalSecretOk({ headers: {} }, { MEDUSA_INTERNAL_SECRET: SECRET })).toBe(false)
  })
})

/**
 * ── POPULATION GUARD ────────────────────────────────────────────────────────
 * Every file in `src/api` that reads MEDUSA_INTERNAL_SECRET, checked against the
 * three fail-open spellings that were actually found live. Grep the population, not
 * the door a reviewer happened to open.
 */
describe('no /internal or /store route re-implements a fail-open secret check', () => {
  const API_ROOT = join(process.cwd(), 'src/api')

  const files = readdirSync(API_ROOT, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.includes(`__tests__${sep}`))
    .map((entry) => join(API_ROOT, entry))
    .filter((file) => readFileSync(file, 'utf8').includes('MEDUSA_INTERNAL_SECRET'))

  it('finds the population (a sweep over zero files is not a gate)', () => {
    expect(files.length).toBeGreaterThan(25)
  })

  /** The three shapes that were live, each of which authorizes everyone when unset. */
  const FAIL_OPEN = [
    // `return !secret || provided === secret` inside an authed()-style helper
    /return\s+!\w+\s*\|\|\s*\w+\s*===\s*\w+/,
    // `return !!expected && got !== expected` inside an unauthorized()-style helper
    /return\s+!!\w+\s*&&\s*\w+\s*!==\s*\w+/,
    // `if (internalSecret && headerSecret !== internalSecret)`
    /if\s*\(\s*\w*[sS]ecret\w*\s*&&\s*\w+\s*!==\s*\w+\s*\)/,
  ]

  it.each(files.map((file) => [relative(process.cwd(), file), file]))(
    '%s has no fail-open guard shape',
    (_name, file) => {
      const source = readFileSync(file as string, 'utf8')
      for (const shape of FAIL_OPEN) {
        expect({ file: _name, shape: String(shape), matched: shape.test(source) })
          .toEqual({ file: _name, shape: String(shape), matched: false })
      }
    },
  )

  it('the two known-good inline spellings are still accepted (no false positive)', () => {
    // `setup-mexico` guards inline and correctly: header falsy OR mismatched ⇒ 401.
    // A guard that reddens correct code teaches people to bypass it, so prove the
    // regexes above tolerate the shape we want people to copy.
    const good = readFileSync(join(API_ROOT, 'internal/setup-mexico/route.ts'), 'utf8')
    for (const shape of FAIL_OPEN) expect(shape.test(good)).toBe(false)
    expect(good).toMatch(/if \(!secret \|\| secret !== process\.env\.MEDUSA_INTERNAL_SECRET\)/)
  })
})
