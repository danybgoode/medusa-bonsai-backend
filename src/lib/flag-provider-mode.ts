/**
 * The migration switch for the Golden Beans flag provider.
 *
 * This stays deliberately pure (and therefore testable without Medusa): the
 * adapter owns credential handling and provider construction. An unset or
 * malformed value is `local`, so configuration mistakes cannot change a
 * commerce-path decision.
 */
export type FlagProviderMode = 'local' | 'shadow' | 'golden'
export type GoldenFlagEnvironment = 'development' | 'preview' | 'production'

const FLAG_PROVIDER_MODES: ReadonlySet<string> = new Set(['local', 'shadow', 'golden'])
const GOLDEN_FLAG_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'preview', 'production'])

export function parseFlagProviderMode(value: string | undefined): FlagProviderMode {
  return value && FLAG_PROVIDER_MODES.has(value) ? (value as FlagProviderMode) : 'local'
}

/** Explicit environment is required: never infer production from NODE_ENV. */
export function parseGoldenFlagEnvironment(value: string | undefined): GoldenFlagEnvironment | undefined {
  return value && GOLDEN_FLAG_ENVIRONMENTS.has(value) ? (value as GoldenFlagEnvironment) : undefined
}
