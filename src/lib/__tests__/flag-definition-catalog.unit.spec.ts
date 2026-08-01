import {
  BACKEND_FLAG_DEFINITION_CATALOG,
  BACKEND_FLAG_DEFINITION_SHARED_KEYS,
  buildBackendFlagDefinition,
} from '../flag-definition-catalog'
import { BACKEND_FLAG_CATALOG } from '../flag-catalog'

describe('backend Golden flag-definition catalog', () => {
  it('publishes one deterministic entry for every backend-owned flag', () => {
    expect(BACKEND_FLAG_DEFINITION_CATALOG).toHaveLength(13)
    expect(BACKEND_FLAG_CATALOG).toHaveLength(13)
    expect(BACKEND_FLAG_DEFINITION_CATALOG.map((entry) => entry.key)).toEqual([
      ...BACKEND_FLAG_DEFINITION_CATALOG.map((entry) => entry.key),
    ].sort())
    expect(new Set(BACKEND_FLAG_DEFINITION_CATALOG.map((entry) => entry.key)).size).toBe(13)
    expect(BACKEND_FLAG_DEFINITION_CATALOG.map((entry) => entry.key)).toEqual(
      BACKEND_FLAG_CATALOG.map((entry) => entry.key),
    )

    for (const source of BACKEND_FLAG_CATALOG) {
      const published = BACKEND_FLAG_DEFINITION_CATALOG.find((entry) => entry.key === source.key)
      expect(published?.definition).toEqual(buildBackendFlagDefinition(source))
      expect(published?.definition.defaultVariantKey).toBe(source.compileDefault ? 'on' : 'off')
      expect(published?.definition.metadata).toEqual({
        source: 'miyagi',
        polarity: source.polarity,
        criticality: source.criticality,
        enforcement: source.enforcement,
      })
    }
  })

  it('keeps the eleven ordinary shared definitions canonical across services', () => {
    expect(BACKEND_FLAG_DEFINITION_SHARED_KEYS).toEqual([
      'catalog.bulk_enabled',
      'catalog.inventory_channels_enabled',
      'checkout.rental_pricing_enabled',
      'checkout.stripe_enabled',
      'ml.publish_enabled',
      'ml.sync_enabled',
      'ml.sync_paywall_enabled',
      'ops.profit_enabled',
      'shipping.arranged_only_enabled',
      'shipping.correos_enabled',
      'shipping.envia_enabled',
    ])

    const sharedKeys = new Set<string>(BACKEND_FLAG_DEFINITION_SHARED_KEYS)
    for (const entry of BACKEND_FLAG_DEFINITION_CATALOG) {
      if (!sharedKeys.has(entry.key)) continue
      expect(entry.definition).toEqual({
        valueType: 'boolean',
        description: `Miyagi flag: ${entry.key}.`,
        defaultVariantKey: entry.definition.defaultVariantKey,
        variants: [
          { key: 'off', value: false },
          { key: 'on', value: true },
        ],
        rules: [],
        metadata: expect.objectContaining({
          source: 'miyagi',
          enforcement: 'both',
        }),
      })
    }
  })

  it('keeps the backend-only ML-orders flag out of the shared fragment', () => {
    const mlOrders = BACKEND_FLAG_DEFINITION_CATALOG.find(
      (entry) => entry.key === 'ml.orders_enabled',
    )
    expect(mlOrders?.definition.metadata).toEqual({
      source: 'miyagi',
      polarity: 'enablement',
      criticality: 'high',
      enforcement: 'backend',
    })
    expect(BACKEND_FLAG_DEFINITION_SHARED_KEYS).not.toContain('ml.orders_enabled')
  })

  it('pins the live owned-shop kill-switch definition exactly', () => {
    expect(buildBackendFlagDefinition({
      key: 'catalog.owned_shop_only_enabled',
      compileDefault: true,
      polarity: 'killswitch',
      criticality: 'high',
      enforcement: 'both',
      description: 'ignored by the sync definition',
      owners: [],
    })).toEqual({
      valueType: 'boolean',
      description:
        'Owned-shop-only buyability and publication controls. The capability is live by default; turning this flag OFF is the deliberate kill switch.',
      defaultVariantKey: 'on',
      variants: [
        { key: 'off', value: false },
        { key: 'on', value: true },
      ],
      rules: [],
      metadata: {
        source: 'miyagi',
        polarity: 'killswitch',
        criticality: 'high',
        enforcement: 'both',
      },
    })
  })
})
