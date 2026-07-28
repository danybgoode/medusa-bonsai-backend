/**
 * Server-only bridge to Golden Beans' snapshot-backed flag provider.
 *
 * `flag_read` is a distinct, revocable credential: never reuse the telemetry
 * ingest key here. Construction and refresh are intentionally non-blocking;
 * callers keep their local result whenever a snapshot is unavailable or stale.
 */
import { createFlagProvider, type FlagProvider, type FlagResolutionReason } from '@golden-beans/sdk'
import { parseGoldenFlagEnvironment } from './flag-provider-mode'
import { scheduleDurableGoldenSnapshot } from './golden-flag-mirror-store'

export type GoldenBooleanEvaluation = {
  value: boolean
  snapshotVersion: number
  flagVersion?: number
  reason: FlagResolutionReason
}

let provider: FlagProvider | undefined
let started = false

function getProvider(): FlagProvider | undefined {
  // Read configuration lazily so runtime setup cannot permanently cache an
  // absent credential during module evaluation.
  const baseUrl = process.env.GROWTH_ENGINE_URL?.replace(/\/+$/, '')
  const flagReadKey = process.env.GOLDEN_BEANS_FLAG_READ_KEY
  const environment = parseGoldenFlagEnvironment(process.env.GOLDEN_BEANS_FLAG_ENVIRONMENT)
  if (!baseUrl || !flagReadKey || !environment) {
    try {
      provider?.shutdown()
    } catch {
      // A flag check must never fail because cleanup did.
    }
    provider = undefined
    started = false
    return undefined
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
  }

  if (!started) {
    started = true
    // SDK initialize starts its bounded periodic refresh before its initial
    // attempt. Preserve `started` after failure to avoid request-path retry
    // storms; the provider performs the next retry on that timer.
    void provider.initialize().catch(() => undefined)
  }

  return provider
}

/** Resolves only from a fresh snapshot; no remote request happens per flag check. */
export function evaluateGoldenBooleanFlag(
  flagKey: string,
  defaultValue: boolean,
): GoldenBooleanEvaluation | undefined {
  try {
    const currentProvider = getProvider()
    if (!currentProvider) return undefined

    const snapshot = currentProvider.getSnapshot()
    if (!snapshot) return undefined
    scheduleDurableGoldenSnapshot(snapshot)

    const details = currentProvider.resolveBooleanEvaluation(flagKey, defaultValue)
    return {
      value: details.value,
      snapshotVersion: snapshot.snapshotVersion,
      flagVersion: details.flagVersion,
      reason: details.reason,
    }
  } catch {
    // The caller keeps its local result on every unexpected provider failure.
    return undefined
  }
}
