import {
  createGrowthEngineClient,
  type FlagEvaluationTelemetryInput,
} from '@golden-beans/sdk'

const TELEMETRY_TIMEOUT_MS = 5_000
let cachedClient:
  | {
      baseUrl: string
      apiKey: string
      sampleRate: number
      client: ReturnType<typeof createGrowthEngineClient>
    }
  | undefined

function configuredSampleRate(): number {
  const configured = Number(
    process.env.GOLDEN_BEANS_FLAG_EVALUATION_SAMPLE_RATE ?? '0.1',
  )
  return Number.isFinite(configured) ? configured : 0.1
}

function growthClient() {
  const baseUrl = process.env.GROWTH_ENGINE_URL?.replace(/\/+$/, '')
  const apiKey = process.env.GROWTH_ENGINE_API_KEY
  if (!baseUrl || !apiKey) {
    cachedClient = undefined
    return undefined
  }
  const sampleRate = configuredSampleRate()
  if (
    !cachedClient ||
    cachedClient.baseUrl !== baseUrl ||
    cachedClient.apiKey !== apiKey ||
    cachedClient.sampleRate !== sampleRate
  ) {
    cachedClient = {
      baseUrl,
      apiKey,
      sampleRate,
      client: createGrowthEngineClient({
        baseUrl,
        apiKey,
        userId: 'medusa_backend_flag_provider',
        flagEvaluationSampleRate: sampleRate,
        fetchImpl: (request, init) =>
          fetch(request, {
            ...init,
            signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
          }),
      }),
    }
  }
  return cachedClient.client
}

/**
 * Sampled, non-personal Golden flag-evaluation fact. This helper owns every
 * transport failure so telemetry can never change a commerce decision.
 */
export async function trackGoldenFlagEvaluation(
  input: Omit<FlagEvaluationTelemetryInput, 'subject'>,
): Promise<void> {
  try {
    const client = growthClient()
    if (!client) return
    await client.trackFlagEvaluation({
      ...input,
      subject: { type: 'service', id: 'medusa_backend' },
    })
  } catch {
    // Analytics can never affect the flag result that has already been computed.
  }
}
