/**
 * Where a flag decision came from. `golden` is the only healthy steady state: `durable` means the
 * live snapshot is unavailable (an outage, or an expired/revoked read key), `default` means even the
 * mirror was empty. This replaced the cutover-era "authority" record when flag-provider-mandate S2.2
 * retired the modes. It survives because it is what exposed the silently expired production read
 * key; without it that outage has no signal at all.
 */
export type FlagDecisionSource = 'golden' | 'durable' | 'default'

/** Control-plane-only record. No request, actor, shop or credential data is accepted. */
export type FlagDecisionObservation<K extends string = string> = {
  flagKey: K
  source: FlagDecisionSource
  snapshotVersion?: number
  flagVersion?: number
  reason?: string
}

/** Bounded once-per-snapshot/source/flag reporter, so steady traffic writes nothing new. */
export function createFlagDecisionObserver<K extends string>(
  write: (observation: FlagDecisionObservation<K>) => void,
  maxEntries = 1_024,
) {
  const observed = new Set<string>()

  return (observation: FlagDecisionObservation<K>): boolean => {
    const key = [
      observation.snapshotVersion ?? 'none',
      observation.source,
      observation.flagKey,
    ].join(':')
    if (observed.has(key)) return false
    if (observed.size >= maxEntries) {
      const oldest = observed.values().next().value
      if (oldest) observed.delete(oldest)
    }
    observed.add(key)
    write(observation)
    return true
  }
}
