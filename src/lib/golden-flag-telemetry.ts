import {
  createGrowthEngineClient,
  type FlagEvaluationTelemetryInput,
} from '@golden-beans/sdk'

const TELEMETRY_TIMEOUT_MS = 5_000

function configuredSampleRate(): number {
  const configured = Number(
    process.env.GOLDEN_BEANS_FLAG_EVALUATION_SAMPLE_RATE ?? '0.1',
  )
  return Number.isFinite(configured) ? configured : 0.1
}

/**
 * Sampled, non-personal Golden flag-evaluation fact. This helper owns every
 * transport failure so telemetry can never change a commerce decision.
 */
export async function trackGoldenFlagEvaluation(
  input: Omit<FlagEvaluationTelemetryInput, 'subject'>,
): Promise<void> {
  try {
    const baseUrl = process.env.GROWTH_ENGINE_URL?.replace(/\/+$/, '')
    const apiKey = process.env.GROWTH_ENGINE_API_KEY
    if (!baseUrl || !apiKey) return

    const client = createGrowthEngineClient({
      baseUrl,
      apiKey,
      userId: 'medusa_backend_flag_provider',
      flagEvaluationSampleRate: configuredSampleRate(),
      fetchImpl: (request, init) =>
        fetch(request, {
          ...init,
          signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
        }),
    })
    await client.trackFlagEvaluation({
      ...input,
      subject: { type: 'service', id: 'medusa_backend' },
    })
  } catch {
    // Analytics can never affect the flag result that has already been computed.
  }
}
