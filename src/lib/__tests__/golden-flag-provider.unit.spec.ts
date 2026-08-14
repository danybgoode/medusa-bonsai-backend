const mockInitialize = jest.fn()
const mockRefresh = jest.fn()
const mockShutdown = jest.fn()
const mockGetSnapshot = jest.fn()
const mockResolveBooleanEvaluation = jest.fn()
const mockCreateFlagProvider = jest.fn(() => ({
  initialize: mockInitialize,
  refresh: mockRefresh,
  shutdown: mockShutdown,
  getSnapshot: mockGetSnapshot,
  resolveBooleanEvaluation: mockResolveBooleanEvaluation,
}))
const mockScheduleDurableSnapshot = jest.fn()
const mockTrackFlagEvaluation = jest.fn()

jest.mock('@golden-frijoles/sdk', () => ({
  createFlagProvider: mockCreateFlagProvider,
}))

jest.mock('../golden-flag-mirror-store', () => ({
  scheduleDurableGoldenSnapshot: mockScheduleDurableSnapshot,
}))

jest.mock('../golden-flag-telemetry', () => ({
  trackGoldenFlagEvaluation: mockTrackFlagEvaluation,
}))

describe('Golden flag provider telemetry', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    process.env = {
      ...originalEnv,
      GROWTH_ENGINE_URL: 'https://golden.example',
      GOLDEN_BEANS_FLAG_READ_KEY: 'gb_flag_read_test',
      GOLDEN_BEANS_FLAG_ENVIRONMENT: 'production',
    }
    mockInitialize.mockResolvedValue({
      ok: true,
      changed: true,
      snapshotVersion: 41,
    })
    mockRefresh.mockResolvedValue({
      ok: true,
      changed: false,
      notModified: true,
      snapshotVersion: 41,
    })
    mockGetSnapshot.mockReturnValue({
      contractVersion: 1,
      environment: 'production',
      snapshotVersion: 41,
      flags: [],
    })
    mockResolveBooleanEvaluation.mockReturnValue({
      value: true,
      flagVersion: 9,
      variant: 'enabled',
      reason: 'STATIC',
    })
    mockTrackFlagEvaluation.mockResolvedValue(undefined)
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('emits the canonical versioned fact after resolving from a snapshot', () => {
    const { evaluateGoldenBooleanFlag } = require('../golden-flag-provider')

    expect(evaluateGoldenBooleanFlag('checkout.stripe_enabled', false)).toEqual(
      {
        value: true,
        snapshotVersion: 41,
        flagVersion: 9,
        variant: 'enabled',
        reason: 'STATIC',
      },
    )
    expect(mockTrackFlagEvaluation).toHaveBeenCalledWith({
      flagKey: 'checkout.stripe_enabled',
      flagVersion: 9,
      variant: 'enabled',
      reason: 'STATIC',
      snapshotVersion: 41,
      environment: 'production',
    })
  })

  it('does not invent telemetry when the snapshot cannot identify a versioned variant', () => {
    mockResolveBooleanEvaluation.mockReturnValue({
      value: false,
      reason: 'DEFAULT',
    })
    const { evaluateGoldenBooleanFlag } = require('../golden-flag-provider')

    expect(evaluateGoldenBooleanFlag('checkout.stripe_enabled', false)).toEqual(
      {
        value: false,
        snapshotVersion: 41,
        flagVersion: undefined,
        variant: undefined,
        reason: 'DEFAULT',
      },
    )
    expect(mockTrackFlagEvaluation).not.toHaveBeenCalled()
  })

  it('replaces the provider after a non-empty credential rotation', () => {
    const { evaluateGoldenBooleanFlag } = require('../golden-flag-provider')

    expect(evaluateGoldenBooleanFlag('checkout.stripe_enabled', false)?.value).toBe(true)
    process.env.GOLDEN_BEANS_FLAG_READ_KEY = 'gb_flag_read_rotated'
    expect(evaluateGoldenBooleanFlag('checkout.stripe_enabled', false)?.value).toBe(true)

    expect(mockCreateFlagProvider).toHaveBeenCalledTimes(2)
    expect(mockShutdown).toHaveBeenCalledTimes(1)
    expect(mockCreateFlagProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ flagReadKey: 'gb_flag_read_rotated' }),
    )
  })

  it('kicks one bounded refresh from a later request when periodic timers are throttled', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000)
    const { evaluateGoldenBooleanFlag } = require('../golden-flag-provider')

    evaluateGoldenBooleanFlag('checkout.stripe_enabled', false)
    now.mockReturnValue(60_999)
    evaluateGoldenBooleanFlag('checkout.stripe_enabled', false)
    expect(mockRefresh).not.toHaveBeenCalled()

    now.mockReturnValue(61_000)
    evaluateGoldenBooleanFlag('checkout.stripe_enabled', false)
    evaluateGoldenBooleanFlag('checkout.stripe_enabled', false)
    expect(mockRefresh).toHaveBeenCalledTimes(1)

    now.mockRestore()
  })
})
