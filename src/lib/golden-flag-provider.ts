/**
 * Server-only bridge to Golden Beans' snapshot-backed flag provider.
 *
 * `flag_read` is a distinct, revocable credential: never reuse the telemetry
 * ingest key here. Construction and refresh are intentionally non-blocking;
 * callers keep their local result whenever a snapshot is unavailable or stale.
 */
import {
  createFlagProvider,
  type FlagProvider,
  type FlagResolutionReason,
} from '@golden-frijoles/sdk'
import { parseGoldenFlagEnvironment } from './golden-flag-environment'
import { createFlagProviderRequestRefreshGate } from './flag-provider-request-refresh'
import { scheduleDurableGoldenSnapshot } from './golden-flag-mirror-store'
import { trackGoldenFlagEvaluation } from './golden-flag-telemetry'

export type GoldenBooleanEvaluation = {
  value: boolean
  snapshotVersion: number
  flagVersion?: number
  variant?: string
  reason: FlagResolutionReason
}

let provider: FlagProvider | undefined
let started = false
// The SDK's already-started, bounded (refreshTimeoutMs) initial fetch. A cold instance awaits it ONCE
// (shared by concurrent callers) before a flag may fall to its compile default — see recoverGolden.
let initialization: Promise<void> | undefined
const requestRefreshGate = createFlagProviderRequestRefreshGate()
let configuration:
  | {
      baseUrl: string
      flagReadKey: string
      environment: string
    }
  | undefined

function getProvider(): FlagProvider | undefined {
  // Read configuration lazily so runtime setup cannot permanently cache an
  // absent credential during module evaluation.
  const baseUrl = process.env.GROWTH_ENGINE_URL?.replace(/\/+$/, '')
  const flagReadKey = process.env.GOLDEN_BEANS_FLAG_READ_KEY
  const environment = parseGoldenFlagEnvironment(
    process.env.GOLDEN_BEANS_FLAG_ENVIRONMENT,
  )
  if (!baseUrl || !flagReadKey || !environment) {
    try {
      provider?.shutdown()
    } catch {
      // A flag check must never fail because cleanup did.
    }
    provider = undefined
    started = false
    initialization = undefined
    requestRefreshGate.reset()
    configuration = undefined
    return undefined
  }

  if (
    provider &&
    (configuration?.baseUrl !== baseUrl ||
      configuration.flagReadKey !== flagReadKey ||
      configuration.environment !== environment)
  ) {
    try {
      provider.shutdown()
    } catch {
      // Replacing a rotated credential must not affect a flag decision.
    }
    provider = undefined
    started = false
    initialization = undefined
    requestRefreshGate.reset()
  }

  if (!provider) {
    provider = createFlagProvider({
      baseUrl,
      flagReadKey,
      environment,
      refreshIntervalMs: 60_000,
      maxStaleMs: 300_000,
      refreshTimeoutMs: 2_000,
    })
    configuration = { baseUrl, flagReadKey, environment }
  }

  if (!started) {
    started = true
    requestRefreshGate.markAttempt()
    // SDK initialize starts its bounded periodic refresh before its initial
    // attempt. Preserve `started` after failure to avoid request-path retry
    // storms; the provider performs the next retry on that timer.
    try {
      initialization = provider.initialize().then(() => undefined).catch(() => undefined)
    } catch {
      initialization = Promise.resolve()
    }
  } else if (requestRefreshGate.takeIfDue()) {
    // Cloud Run can throttle the SDK's periodic timer between requests. Kick
    // the same deduplicated refresh from live traffic, but never await it: this
    // request keeps resolving synchronously from the accepted snapshot/LKG.
    void provider.refresh().catch(() => undefined)
  }

  return provider
}

function evaluateFromProvider(
  currentProvider: FlagProvider,
  flagKey: string,
  defaultValue: boolean,
): GoldenBooleanEvaluation | undefined {
  const snapshot = currentProvider.getSnapshot()
  if (!snapshot) return undefined
  scheduleDurableGoldenSnapshot(snapshot)

  const details = currentProvider.resolveBooleanEvaluation(
    flagKey,
    defaultValue,
  )
  if (details.flagVersion !== undefined && details.variant) {
    void trackGoldenFlagEvaluation({
      flagKey,
      flagVersion: details.flagVersion,
      variant: details.variant,
      reason: details.reason,
      snapshotVersion: snapshot.snapshotVersion,
      environment: snapshot.environment,
    })
  }
  return {
    value: details.value,
    snapshotVersion: snapshot.snapshotVersion,
    flagVersion: details.flagVersion,
    variant: details.variant,
    reason: details.reason,
  }
}

/** Resolves only from a fresh snapshot; no remote request happens per flag check. */
export function evaluateGoldenBooleanFlag(
  flagKey: string,
  defaultValue: boolean,
): GoldenBooleanEvaluation | undefined {
  try {
    const currentProvider = getProvider()
    if (!currentProvider) return undefined
    return evaluateFromProvider(currentProvider, flagKey, defaultValue)
  } catch {
    // The caller keeps its fallback on every unexpected provider failure.
    return undefined
  }
}

/**
 * A cold instance can meet an EMPTY durable lane (a fresh deploy, or the first run after the mirror
 * moved to the `miyagisanchez` scope). Without this, its first requests would resolve enforcement
 * flags to their compile defaults — `ml.orders_enabled` and `catalog.inventory_channels_enabled`
 * default OFF while production serves them ON. Await only the SDK's already-started initial fetch,
 * bounded by `refreshTimeoutMs`; concurrent callers share the one promise and nothing retries.
 */
export async function recoverGoldenBooleanFlag(
  flagKey: string,
  defaultValue: boolean,
): Promise<GoldenBooleanEvaluation | undefined> {
  try {
    const currentProvider = getProvider()
    if (!currentProvider) return undefined
    await initialization
    return evaluateFromProvider(currentProvider, flagKey, defaultValue)
  } catch {
    return undefined
  }
}
