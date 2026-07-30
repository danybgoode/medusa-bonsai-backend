const mockTrackFlagEvaluation = jest.fn()
const mockCreateGrowthEngineClient = jest.fn(() => ({
  trackFlagEvaluation: mockTrackFlagEvaluation,
}))

jest.mock('@golden-beans/sdk', () => ({
  createGrowthEngineClient: mockCreateGrowthEngineClient,
}))

describe('Golden flag telemetry client', () => {
  const originalEnv = process.env

  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    process.env = {
      ...originalEnv,
      GROWTH_ENGINE_URL: 'https://golden.example/',
      GROWTH_ENGINE_API_KEY: 'gb_test_ingest',
      GOLDEN_BEANS_FLAG_EVALUATION_SAMPLE_RATE: '1',
    }
    mockTrackFlagEvaluation.mockResolvedValue({ ok: true, id: 'fixture' })
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('reuses one configured SDK client across hot-path evaluations', async () => {
    const { trackGoldenFlagEvaluation } = require('../golden-flag-telemetry')
    const input = {
      flagKey: 'checkout.stripe_enabled',
      flagVersion: 2,
      variant: 'enabled',
      reason: 'STATIC',
      snapshotVersion: 11,
      environment: 'production',
    }

    await trackGoldenFlagEvaluation(input)
    await trackGoldenFlagEvaluation(input)

    expect(mockCreateGrowthEngineClient).toHaveBeenCalledTimes(1)
    expect(mockTrackFlagEvaluation).toHaveBeenCalledTimes(2)
    expect(mockTrackFlagEvaluation).toHaveBeenCalledWith({
      ...input,
      subject: { type: 'service', id: 'medusa_backend' },
    })
  })

  it('rebuilds the client after credential rotation', async () => {
    const { trackGoldenFlagEvaluation } = require('../golden-flag-telemetry')
    const input = {
      flagKey: 'checkout.stripe_enabled',
      flagVersion: 2,
      variant: 'enabled',
      reason: 'STATIC',
      snapshotVersion: 11,
      environment: 'production',
    }

    await trackGoldenFlagEvaluation(input)
    process.env.GROWTH_ENGINE_API_KEY = 'gb_rotated_ingest'
    await trackGoldenFlagEvaluation(input)

    expect(mockCreateGrowthEngineClient).toHaveBeenCalledTimes(2)
  })
})
