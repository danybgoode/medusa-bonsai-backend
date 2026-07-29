/** Bounded, PII-free shadow comparison reporting for the provider migration. */
export type FlagShadowObservation = {
  flagKey: string
  defaultValue: boolean
  localValue: boolean
  goldenValue: boolean
  snapshotVersion: number
  flagVersion?: number
  reason: string
}

export type FlagAuthority = 'local' | 'golden_live' | 'golden_durable'

/**
 * One control-plane record for proving the configured authority and snapshot.
 * The closed shape deliberately has no request, actor, subject or arbitrary
 * metadata field, so callers cannot accidentally turn it into request telemetry.
 */
export type FlagAuthorityObservation = {
  flagKey: string
  configuredMode: 'local' | 'shadow' | 'golden'
  manifestSource: 'manifest' | 'legacy'
  manifestValid: boolean
  authority: FlagAuthority
  defaultValue: boolean
  localValue: boolean
  resolvedValue: boolean
  goldenValue?: boolean
  snapshotVersion?: number
  flagVersion?: number
  reason?: string
}

export function createFlagShadowObserver(
  write: (observation: FlagShadowObservation) => void,
  maxEntries = 512,
) {
  const observed = new Set<string>()

  return (observation: FlagShadowObservation): boolean => {
    const key = `${observation.snapshotVersion}:${observation.flagKey}`
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

export function createFlagAuthorityObserver(
  write: (observation: FlagAuthorityObservation) => void,
  maxEntries = 512,
) {
  const observed = new Set<string>()

  return (observation: FlagAuthorityObservation): boolean => {
    const key = [
      observation.manifestSource,
      observation.manifestValid,
      observation.configuredMode,
      observation.authority,
      observation.snapshotVersion ?? 'none',
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
