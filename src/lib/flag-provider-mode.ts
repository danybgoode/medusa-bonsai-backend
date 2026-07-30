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
export const FLAG_CUTOVER_CONTRACT_VERSION = 1 as const
export type FlagCutoverManifestSource = 'manifest' | 'legacy'
export type FlagCutoverManifestError =
  | 'duplicate_known_flag'
  | 'empty_manifest'
  | 'empty_segment'
  | 'malformed_entry'
  | 'duplicate_selector'
  | 'missing_all_selector'
  | 'unknown_flag'
  | 'invalid_mode'
  | 'invalid_legacy_mode'

export type FlagCutoverManifest<K extends string> = {
  source: FlagCutoverManifestSource
  valid: boolean
  baseline: FlagProviderMode
  modes: Readonly<Record<K, FlagProviderMode>>
  errors: readonly FlagCutoverManifestError[]
}

const FLAG_PROVIDER_MODES: ReadonlySet<string> = new Set(['local', 'shadow', 'golden'])
const GOLDEN_FLAG_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'preview', 'production'])

export function parseFlagProviderMode(value: string | undefined): FlagProviderMode {
  return value && FLAG_PROVIDER_MODES.has(value) ? (value as FlagProviderMode) : 'local'
}

function allLocal<K extends string>(
  keys: readonly K[],
  source: FlagCutoverManifestSource,
  errors: readonly FlagCutoverManifestError[],
): FlagCutoverManifest<K> {
  return {
    source,
    valid: errors.length === 0,
    baseline: 'local',
    modes: Object.freeze(
      Object.fromEntries(keys.map((key) => [key, 'local'])) as Record<K, FlagProviderMode>,
    ),
    errors,
  }
}

function uniqueErrors(
  errors: readonly FlagCutoverManifestError[],
): readonly FlagCutoverManifestError[] {
  return [...new Set(errors)].sort((left, right) => left.localeCompare(right))
}

/**
 * Resolves the cross-repo staged-cutover contract.
 *
 * A present manifest is a comma-separated list with a required all-keys
 * selector, for example `*=local,catalog.bulk_enabled=shadow`. Whitespace
 * around entries, selectors and values is ignored. Any malformed, duplicate or
 * unknown entry invalidates the WHOLE manifest and resolves every flag local.
 *
 * The legacy global mode is consulted only when the manifest variable is truly
 * absent. An empty-but-present manifest is therefore a fail-closed
 * configuration error, not an invitation to fall through to the legacy mode.
 */
export function parseFlagCutoverManifest<K extends string>(
  manifestValue: string | undefined,
  knownKeys: readonly K[],
  legacyModeValue?: string,
): FlagCutoverManifest<K> {
  const keySet = new Set<string>()
  const catalogErrors: FlagCutoverManifestError[] = []
  for (const key of knownKeys) {
    if (keySet.has(key)) catalogErrors.push('duplicate_known_flag')
    keySet.add(key)
  }
  if (catalogErrors.length > 0) {
    return allLocal(knownKeys, manifestValue === undefined ? 'legacy' : 'manifest', uniqueErrors(catalogErrors))
  }

  if (manifestValue === undefined) {
    const legacyValid =
      legacyModeValue === undefined ||
      (legacyModeValue.length > 0 && FLAG_PROVIDER_MODES.has(legacyModeValue))
    const baseline = parseFlagProviderMode(legacyModeValue)
    if (!legacyValid) return allLocal(knownKeys, 'legacy', ['invalid_legacy_mode'])
    return {
      source: 'legacy',
      valid: true,
      baseline,
      modes: Object.freeze(
        Object.fromEntries(knownKeys.map((key) => [key, baseline])) as Record<
          K,
          FlagProviderMode
        >,
      ),
      errors: [],
    }
  }

  if (manifestValue.trim().length === 0) {
    return allLocal(knownKeys, 'manifest', ['empty_manifest'])
  }

  const errors: FlagCutoverManifestError[] = []
  const parsed = new Map<string, FlagProviderMode>()
  for (const rawSegment of manifestValue.split(',')) {
    const segment = rawSegment.trim()
    if (segment.length === 0) {
      errors.push('empty_segment')
      continue
    }
    const firstEquals = segment.indexOf('=')
    if (
      firstEquals <= 0 ||
      firstEquals !== segment.lastIndexOf('=') ||
      firstEquals === segment.length - 1
    ) {
      errors.push('malformed_entry')
      continue
    }

    const selector = segment.slice(0, firstEquals).trim()
    const rawMode = segment.slice(firstEquals + 1).trim()
    if (selector.length === 0 || rawMode.length === 0) {
      errors.push('malformed_entry')
      continue
    }
    if (parsed.has(selector)) {
      errors.push('duplicate_selector')
      continue
    }
    if (selector !== '*' && !keySet.has(selector)) {
      errors.push('unknown_flag')
      continue
    }
    if (!FLAG_PROVIDER_MODES.has(rawMode)) {
      errors.push('invalid_mode')
      continue
    }
    parsed.set(selector, rawMode as FlagProviderMode)
  }

  if (!parsed.has('*')) errors.push('missing_all_selector')
  if (errors.length > 0) {
    return allLocal(knownKeys, 'manifest', uniqueErrors(errors))
  }

  const baseline = parsed.get('*')!
  return {
    source: 'manifest',
    valid: true,
    baseline,
    modes: Object.freeze(
      Object.fromEntries(
        knownKeys.map((key) => [key, parsed.get(key) ?? baseline]),
      ) as Record<K, FlagProviderMode>,
    ),
    errors: [],
  }
}

/** Explicit environment is required: never infer production from NODE_ENV. */
export function parseGoldenFlagEnvironment(value: string | undefined): GoldenFlagEnvironment | undefined {
  return value && GOLDEN_FLAG_ENVIRONMENTS.has(value) ? (value as GoldenFlagEnvironment) : undefined
}
