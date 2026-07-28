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

export function createFlagShadowObserver(write: (observation: FlagShadowObservation) => void) {
  const observed = new Set<string>()

  return (observation: FlagShadowObservation): boolean => {
    const key = `${observation.snapshotVersion}:${observation.flagKey}`
    if (observed.has(key)) return false
    observed.add(key)
    write(observation)
    return true
  }
}
