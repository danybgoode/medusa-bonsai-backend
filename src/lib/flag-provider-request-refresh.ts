const DEFAULT_REQUEST_REFRESH_INTERVAL_MS = 60_000

/**
 * Serverless runtimes may throttle periodic timers between requests. This gate
 * lets a request kick the provider's already-deduplicated refresh at most once
 * per interval without awaiting it or putting network latency on the decision.
 */
export function createFlagProviderRequestRefreshGate(
  intervalMs = DEFAULT_REQUEST_REFRESH_INTERVAL_MS,
  now: () => number = Date.now,
) {
  let nextEligibleAt: number | undefined

  return {
    markAttempt(): void {
      nextEligibleAt = now() + intervalMs
    },
    takeIfDue(): boolean {
      const current = now()
      if (nextEligibleAt === undefined || current < nextEligibleAt) return false
      nextEligibleAt = current + intervalMs
      return true
    },
    reset(): void {
      nextEligibleAt = undefined
    },
  }
}
