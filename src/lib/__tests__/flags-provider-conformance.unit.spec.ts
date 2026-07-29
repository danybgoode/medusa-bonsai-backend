import type { FlagSnapshot } from '@golden-beans/sdk'

const mockEvaluateGolden = jest.fn()
const mockEvaluateDurable = jest.fn()
const mockGetDurable = jest.fn()
const mockSelect = jest.fn()
const mockFrom = jest.fn(() => ({ select: mockSelect }))

jest.mock('../golden-flag-provider', () => ({
  evaluateGoldenBooleanFlag: mockEvaluateGolden,
}))

jest.mock('../golden-flag-mirror', () => ({
  evaluateDurableGoldenBooleanFlag: mockEvaluateDurable,
}))

jest.mock('../golden-flag-mirror-store', () => ({
  getDurableGoldenSnapshot: mockGetDurable,
}))

jest.mock('../../api/store/_utils/supabase-read', () => ({
  supabaseRead: { from: mockFrom },
}))

const DURABLE_SNAPSHOT = {
  contractVersion: 1,
  environment: 'production',
  snapshotVersion: 39,
  flags: [],
} as FlagSnapshot

function loadFlags(): typeof import('../flags') {
  jest.resetModules()
  return require('../flags')
}

describe('isEnabled provider conformance', () => {
  const originalEnv = process.env
  let stdout: jest.SpyInstance

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GOLDEN_BEANS_FLAG_ENVIRONMENT: 'production',
      GOLDEN_BEANS_FLAG_PROVIDER_MODE: 'golden',
    }
    delete process.env.GOLDEN_BEANS_FLAG_CUTOVER
    jest.clearAllMocks()
    stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true)
    mockSelect.mockResolvedValue({
      data: [
        { key: 'checkout.stripe_enabled', enabled: false },
        { key: 'catalog.bulk_enabled', enabled: true },
      ],
      error: null,
    })
    mockEvaluateGolden.mockReturnValue({
      value: true,
      snapshotVersion: 40,
      flagVersion: 1,
      reason: 'STATIC',
    })
    mockGetDurable.mockResolvedValue(undefined)
    mockEvaluateDurable.mockReturnValue({
      value: false,
      snapshotVersion: 39,
      flagVersion: 1,
      reason: 'STATIC',
    })
  })

  afterEach(() => {
    stdout.mockRestore()
    process.env = originalEnv
  })

  it('routes each key through its manifest authority without changing the public seam', async () => {
    process.env.GOLDEN_BEANS_FLAG_CUTOVER =
      '*=local,checkout.stripe_enabled=golden,catalog.bulk_enabled=shadow'
    const { isEnabled } = loadFlags()

    await expect(isEnabled('checkout.stripe_enabled')).resolves.toBe(true)
    await expect(isEnabled('catalog.bulk_enabled')).resolves.toBe(true)
    expect(mockEvaluateGolden).toHaveBeenNthCalledWith(
      1,
      'checkout.stripe_enabled',
      false,
    )
    expect(mockEvaluateGolden).toHaveBeenNthCalledWith(
      2,
      'catalog.bulk_enabled',
      true,
    )
  })

  it('keeps local authoritative in shadow while comparing the exact Golden snapshot', async () => {
    process.env.GOLDEN_BEANS_FLAG_CUTOVER = '*=local,checkout.stripe_enabled=shadow'
    const { isEnabled } = loadFlags()

    await expect(isEnabled('checkout.stripe_enabled')).resolves.toBe(false)
    expect(mockEvaluateGolden).toHaveBeenCalledWith(
      'checkout.stripe_enabled',
      false,
    )
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining('"snapshotVersion":40'),
    )
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining('"authority":"local"'),
    )
  })

  it('invalidates the whole manifest and never consults Golden even when legacy says golden', async () => {
    process.env.GOLDEN_BEANS_FLAG_CUTOVER =
      '*=golden,catalog.bulk_enabled=shadow,catalog.bulk_enabled=golden'
    const { isEnabled } = loadFlags()

    await expect(isEnabled('checkout.stripe_enabled')).resolves.toBe(false)
    await expect(isEnabled('catalog.bulk_enabled')).resolves.toBe(true)
    expect(mockEvaluateGolden).not.toHaveBeenCalled()
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining('"manifestValid":false'),
    )
  })

  it('uses the monotonic durable snapshot when golden is configured but live is unavailable', async () => {
    process.env.GOLDEN_BEANS_FLAG_CUTOVER = '*=local,checkout.stripe_enabled=golden'
    mockEvaluateGolden.mockReturnValue(undefined)
    mockGetDurable.mockResolvedValue(DURABLE_SNAPSHOT)
    const { isEnabled } = loadFlags()

    await expect(isEnabled('checkout.stripe_enabled')).resolves.toBe(false)
    expect(mockEvaluateDurable).toHaveBeenCalledWith(
      DURABLE_SNAPSHOT,
      'checkout.stripe_enabled',
      false,
    )
    expect(stdout).toHaveBeenCalledWith(
      expect.stringContaining('"authority":"golden_durable"'),
    )
  })

  it('falls back to the current local value when neither live nor durable Golden is available', async () => {
    process.env.GOLDEN_BEANS_FLAG_CUTOVER = '*=golden'
    mockEvaluateGolden.mockReturnValue(undefined)
    mockGetDurable.mockResolvedValue(undefined)
    const { isEnabled } = loadFlags()

    await expect(isEnabled('checkout.stripe_enabled')).resolves.toBe(false)
    await expect(isEnabled('catalog.bulk_enabled')).resolves.toBe(true)
  })

  it('emits a serializable PII-free inventory, authority, and snapshot report', async () => {
    process.env.GOLDEN_BEANS_FLAG_CUTOVER =
      '*=local,checkout.stripe_enabled=golden,catalog.bulk_enabled=shadow'
    const { getFlagAuthorityReport } = loadFlags()

    const report = await getFlagAuthorityReport()
    expect(report).toMatchObject({
      contractVersion: 1,
      service: 'medusa-backend',
      environment: 'production',
      manifest: {
        source: 'manifest',
        valid: true,
        baseline: 'local',
        errors: [],
      },
      snapshotVersions: [40],
      snapshotCoverage: {
        required: 2,
        observed: 2,
        complete: true,
      },
      consistentSnapshot: true,
      parityMismatches: ['checkout.stripe_enabled'],
    })
    expect(report.flags).toHaveLength(12)
    expect(
      report.flags.find((flag) => flag.key === 'checkout.stripe_enabled'),
    ).toMatchObject({
      compileDefault: true,
      polarity: 'killswitch',
      criticality: 'high',
      configuredMode: 'golden',
      authority: 'golden_live',
      localValue: false,
      resolvedValue: true,
      goldenValue: true,
      snapshotVersion: 40,
      flagVersion: 1,
      matchesLocal: false,
    })
    const serialized = JSON.stringify(report)
    for (const forbidden of [
      'credential',
      'apiKey',
      'flagReadKey',
      'baseUrl',
      'targetingKey',
      'actor',
      'subject',
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('does not call an unavailable Golden snapshot consistent or complete', async () => {
    process.env.GOLDEN_BEANS_FLAG_CUTOVER = '*=local,checkout.stripe_enabled=golden'
    mockEvaluateGolden.mockReturnValue(undefined)
    mockGetDurable.mockResolvedValue(undefined)
    const { getFlagAuthorityReport } = loadFlags()

    const report = await getFlagAuthorityReport()
    expect(report.snapshotVersions).toEqual([])
    expect(report.snapshotCoverage).toEqual({
      required: 1,
      observed: 0,
      complete: false,
    })
    expect(report.consistentSnapshot).toBe(false)
  })

  it('keeps isEnabled never-throw even if an adapter violates its own contract', async () => {
    process.env.GOLDEN_BEANS_FLAG_CUTOVER = '*=golden'
    mockEvaluateGolden.mockImplementation(() => {
      throw new Error('unexpected adapter failure')
    })
    const { isEnabled } = loadFlags()

    // The compile-time default is the last line of defense after an unexpected
    // internal exception; no commerce request observes the exception.
    await expect(isEnabled('checkout.stripe_enabled')).resolves.toBe(true)
  })
})
