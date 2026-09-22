import type { FlagSnapshot } from '@golden-frijoles/sdk'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * flag-provider-mandate S2.2/S2.3 — the backend `isEnabled()` has ONE authority (Golden) and no
 * second lane: live snapshot → durable mirror → compile default. No env var can move a decision
 * onto `platform_flags`, and a source sweep proves nothing reads that table any more.
 */

const mockEvaluateGolden = jest.fn()
const mockGetDurable = jest.fn()
const mockFrom = jest.fn()

jest.mock('../golden-flag-provider', () => ({
  evaluateGoldenBooleanFlag: mockEvaluateGolden,
}))

jest.mock('../golden-flag-mirror-store', () => ({
  getDurableGoldenSnapshot: mockGetDurable,
}))

jest.mock('../../api/store/_utils/supabase-read', () => ({
  supabaseRead: { from: mockFrom },
}))

function durableSnapshot(defaultVariantKey: 'on' | 'off'): FlagSnapshot {
  return {
    contractVersion: 1,
    environment: 'production',
    snapshotVersion: 44,
    flags: [
      {
        key: 'checkout.stripe_enabled',
        definitionVersion: 2,
        definition: {
          valueType: 'boolean',
          description: 'durable fixture',
          defaultVariantKey,
          variants: [
            { key: 'off', value: false },
            { key: 'on', value: true },
          ],
          rules: [],
        },
      },
    ],
  }
}

function loadFlags(): typeof import('../flags') {
  jest.resetModules()
  return require('../flags')
}

function decisions(stdout: jest.SpyInstance): Array<Record<string, unknown>> {
  return stdout.mock.calls
    .map(([line]) => String(line))
    .filter((line) => line.startsWith('[golden-beans:flag-decision] '))
    .map((line) => JSON.parse(line.slice('[golden-beans:flag-decision] '.length)))
}

describe('backend isEnabled — one authority', () => {
  const originalEnv = process.env
  let stdout: jest.SpyInstance

  beforeEach(() => {
    process.env = { ...originalEnv, GOLDEN_BEANS_FLAG_ENVIRONMENT: 'production' }
    jest.clearAllMocks()
    stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    stdout.mockRestore()
    process.env = originalEnv
  })

  it('a live Golden answer decides — even against the compile default — and is reported as golden', async () => {
    mockEvaluateGolden.mockReturnValue({ value: false, snapshotVersion: 44, flagVersion: 2, reason: 'STATIC' })
    const { isEnabled } = loadFlags()

    await expect(isEnabled('checkout.stripe_enabled')).resolves.toBe(false)
    expect(mockGetDurable).not.toHaveBeenCalled()
    expect(decisions(stdout)).toEqual([
      { flagKey: 'checkout.stripe_enabled', source: 'golden', snapshotVersion: 44, flagVersion: 2, reason: 'STATIC' },
    ])
  })

  it('passes the COMPILE default to Golden — there is no local store left to consult', async () => {
    mockEvaluateGolden.mockReturnValue(undefined)
    mockGetDurable.mockResolvedValue(undefined)
    const { isEnabled } = loadFlags()

    await isEnabled('checkout.stripe_enabled')
    await isEnabled('shipping.envia_enabled')
    expect(mockEvaluateGolden.mock.calls).toEqual([
      ['checkout.stripe_enabled', true],
      ['shipping.envia_enabled', false],
    ])
  })

  it('an outage (or an expired read key) falls to the durable mirror, reported as durable', async () => {
    mockEvaluateGolden.mockReturnValue(undefined)
    mockGetDurable.mockResolvedValue(durableSnapshot('off'))
    const { isEnabled } = loadFlags()

    await expect(isEnabled('checkout.stripe_enabled')).resolves.toBe(false)
    expect(decisions(stdout).map((d) => [d.source, d.snapshotVersion])).toEqual([['durable', 44]])
  })

  it('with nothing to read, both polarities resolve to their fail-safe default and never throw', async () => {
    mockEvaluateGolden.mockImplementation(() => {
      throw new Error('provider exploded')
    })
    mockGetDurable.mockRejectedValue(new Error('mirror exploded'))
    const { isEnabled } = loadFlags()

    await expect(isEnabled('checkout.stripe_enabled')).resolves.toBe(true)
    await expect(isEnabled('shipping.envia_enabled')).resolves.toBe(false)
    expect(decisions(stdout).map((d) => d.source)).toEqual(['default', 'default'])
  })

  it.each([
    ['unset', undefined],
    ['local', 'local'],
    ['a typo', '*=locall'],
  ])('GOLDEN_BEANS_FLAG_CUTOVER %s changes nothing and never reads platform_flags', async (_label, value) => {
    if (value === undefined) delete process.env.GOLDEN_BEANS_FLAG_CUTOVER
    else process.env.GOLDEN_BEANS_FLAG_CUTOVER = value
    process.env.GOLDEN_BEANS_FLAG_PROVIDER_MODE = 'local'
    mockEvaluateGolden.mockReturnValue({ value: false, snapshotVersion: 44, reason: 'STATIC' })
    const { isEnabled } = loadFlags()

    await expect(isEnabled('checkout.stripe_enabled')).resolves.toBe(false)
    expect(mockFrom).not.toHaveBeenCalled()
  })
})

describe('source sweep — nothing reads the parked second lane', () => {
  const SRC = join(__dirname, '..', '..')

  function walk(dir: string, out: string[]): void {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) {
        if (name !== '__tests__' && name !== 'migrations') walk(path, out)
      } else if (/\.(ts|js|mjs)$/.test(name) && !/\.spec\.ts$/.test(name)) out.push(path)
    }
  }

  const files: string[] = []
  walk(SRC, files)
  const code = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')

  it('visits the runtime (a guard over an empty set passes forever)', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((file) => file.endsWith(join('lib', 'flags.ts')))).toBe(true)
  })

  it('no runtime code reads platform_flags or the legacy mirror table', () => {
    const offenders = files.filter((file) =>
      /['"`](?:platform_flags|golden_flag_snapshot_mirror)['"`]/.test(code(readFileSync(file, 'utf8'))),
    )
    expect(offenders.map((file) => relative(SRC, file))).toEqual([])
  })

  it('no runtime code reads an env var that could move a decision off Golden', () => {
    const offenders = files.filter((file) =>
      /GOLDEN_BEANS_FLAG_CUTOVER|GOLDEN_BEANS_FLAG_PROVIDER_MODE/.test(code(readFileSync(file, 'utf8'))),
    )
    expect(offenders.map((file) => relative(SRC, file))).toEqual([])
  })
})
