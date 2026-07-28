/**
 * Server-only bridge to Golden Beans' snapshot-backed flag provider.
 *
 * `flag_read` is a distinct, revocable credential: never reuse the telemetry
 * ingest key here. Construction and refresh are intentionally non-blocking;
 * callers keep their local result whenever a snapshot is unavailable or stale.
 */
import { createFlagProvider, type FlagProvider, type FlagResolutionReason } from '@golden-beans/sdk'

export type GoldenBooleanEvaluation = {
  value: boolean
  snapshotVersion: number
  flagVersion?: number
  reason: FlagResolutionReason
}

const baseUrl = process.env.GROWTH_ENGINE_URL?.replace(/\/+$/, '')
const flagReadKey = process.env.GOLDEN_BEANS_FLAG_READ_KEY

let provider: FlagProvider | undefined
let started = false

function getProvider(): FlagProvider | undefined {
  if (!baseUrl || !flagReadKey) return undefined

  if (!provider) {
    provider = createFlagProvider({
      baseUrl,
      flagReadKey,
      environment: 'production',
      refreshIntervalMs: 60_000,
      maxStaleMs: 300_000,
      refreshTimeoutMs: 2_000,
    })
  }

  if (!started) {
    started = true
    void provider.initialize().catch(() => undefined)
  }

  return provider
}

/** Resolves only from a fresh snapshot; no remote request happens per flag check. */
export function evaluateGoldenBooleanFlag(
  flagKey: string,
  defaultValue: boolean,
): GoldenBooleanEvaluation | undefined {
  const currentProvider = getProvider()
  if (!currentProvider) return undefined

  const snapshot = currentProvider.getSnapshot()
  if (!snapshot) return undefined

  const details = currentProvider.resolveBooleanEvaluation(flagKey, defaultValue)
  return {
    value: details.value,
    snapshotVersion: snapshot.snapshotVersion,
    flagVersion: details.flagVersion,
    reason: details.reason,
  }
}
