import {
  FLAG_CUTOVER_CONTRACT_VERSION,
  parseFlagCutoverManifest,
} from '../flag-provider-mode'

const KEYS = [
  'checkout.stripe_enabled',
  'catalog.bulk_enabled',
  'ml.sync_paywall_enabled',
] as const

function expectAllLocal(
  result: ReturnType<typeof parseFlagCutoverManifest<(typeof KEYS)[number]>>,
): void {
  expect(result.baseline).toBe('local')
  expect(result.modes).toEqual({
    'checkout.stripe_enabled': 'local',
    'catalog.bulk_enabled': 'local',
    'ml.sync_paywall_enabled': 'local',
  })
}

describe('per-flag Golden Beans cutover manifest', () => {
  it('has a pinned cross-repo contract version', () => {
    expect(FLAG_CUTOVER_CONTRACT_VERSION).toBe(1)
  })

  it('requires an explicit all-keys baseline and applies trimmed per-key overrides', () => {
    const result = parseFlagCutoverManifest(
      ' *=local , catalog.bulk_enabled = shadow, checkout.stripe_enabled=golden ',
      KEYS,
      'golden',
    )

    expect(result).toEqual({
      source: 'manifest',
      valid: true,
      baseline: 'local',
      modes: {
        'checkout.stripe_enabled': 'golden',
        'catalog.bulk_enabled': 'shadow',
        'ml.sync_paywall_enabled': 'local',
      },
      errors: [],
    })
  })

  it('uses the legacy global mode only when the manifest is truly absent', () => {
    expect(parseFlagCutoverManifest(undefined, KEYS, 'shadow')).toMatchObject({
      source: 'legacy',
      valid: true,
      baseline: 'shadow',
      modes: {
        'checkout.stripe_enabled': 'shadow',
        'catalog.bulk_enabled': 'shadow',
        'ml.sync_paywall_enabled': 'shadow',
      },
    })

    const presentButEmpty = parseFlagCutoverManifest('', KEYS, 'golden')
    expect(presentButEmpty).toMatchObject({
      source: 'manifest',
      valid: false,
      errors: ['empty_manifest'],
    })
    expectAllLocal(presentButEmpty)
  })

  it.each([
    ['missing all selector', 'catalog.bulk_enabled=golden', 'missing_all_selector'],
    ['unknown flag', '*=local,does.not.exist=golden', 'unknown_flag'],
    [
      'duplicate override',
      '*=local,catalog.bulk_enabled=shadow,catalog.bulk_enabled=golden',
      'duplicate_selector',
    ],
    ['duplicate all selector', '*=local,*=golden', 'duplicate_selector'],
    ['invalid mode', '*=local,catalog.bulk_enabled=remote', 'invalid_mode'],
    ['malformed entry', '*=local,catalog.bulk_enabled', 'malformed_entry'],
    ['multiple equals', '*=local,catalog.bulk_enabled==golden', 'malformed_entry'],
    ['empty segment', '*=local,', 'empty_segment'],
  ])('fails the entire manifest local on %s', (_label, value, error) => {
    const result = parseFlagCutoverManifest(value, KEYS, 'golden')

    expect(result.valid).toBe(false)
    expect(result.errors).toContain(error)
    expectAllLocal(result)
  })

  it('fails local when the known inventory itself contains a duplicate', () => {
    const result = parseFlagCutoverManifest('*=golden', [...KEYS, KEYS[0]], 'golden')
    expect(result).toMatchObject({
      valid: false,
      errors: ['duplicate_known_flag'],
    })
    expect(new Set(Object.values(result.modes))).toEqual(new Set(['local']))
  })

  it('fails a malformed legacy mode local without consulting any manifest fallback', () => {
    const result = parseFlagCutoverManifest(undefined, KEYS, 'GOLDEN')
    expect(result).toMatchObject({
      source: 'legacy',
      valid: false,
      errors: ['invalid_legacy_mode'],
    })
    expectAllLocal(result)
  })
})
