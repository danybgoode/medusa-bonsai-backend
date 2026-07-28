/**
 * The migration switch for the Golden Beans flag provider.
 *
 * This stays deliberately pure (and therefore testable without Medusa): the
 * adapter owns credential handling and provider construction. An unset or
 * malformed value is `local`, so configuration mistakes cannot change a
 * commerce-path decision.
 */
export type FlagProviderMode = 'local' | 'shadow' | 'golden'

const FLAG_PROVIDER_MODES: ReadonlySet<string> = new Set(['local', 'shadow', 'golden'])

export function parseFlagProviderMode(value: string | undefined): FlagProviderMode {
  return value && FLAG_PROVIDER_MODES.has(value) ? (value as FlagProviderMode) : 'local'
}
