import {
  BACKEND_FLAG_DEFINITION_CATALOG,
  BACKEND_FLAG_DEFINITION_SHARED_KEYS,
  buildBackendFlagDefinition,
} from '../flag-definition-catalog'
import { BACKEND_FLAG_CATALOG } from '../flag-catalog'

const SHARED_DEFINITION_CONTRACT = [
  { key: 'catalog.bulk_enabled', defaultVariantKey: 'off', polarity: 'killswitch', criticality: 'high' },
  {
    key: 'catalog.inventory_channels_enabled',
    defaultVariantKey: 'off',
    polarity: 'enablement',
    criticality: 'high',
  },
  {
    key: 'checkout.rental_pricing_enabled',
    defaultVariantKey: 'off',
    polarity: 'enablement',
    criticality: 'high',
  },
  { key: 'checkout.stripe_enabled', defaultVariantKey: 'on', polarity: 'killswitch', criticality: 'high' },
  { key: 'ml.publish_enabled', defaultVariantKey: 'off', polarity: 'enablement', criticality: 'high' },
  { key: 'ml.sync_enabled', defaultVariantKey: 'off', polarity: 'killswitch', criticality: 'high' },
  { key: 'ml.sync_paywall_enabled', defaultVariantKey: 'off', polarity: 'enablement', criticality: 'low' },
  { key: 'ops.profit_enabled', defaultVariantKey: 'off', polarity: 'enablement', criticality: 'medium' },
  {
    key: 'shipping.arranged_only_enabled',
    defaultVariantKey: 'off',
    polarity: 'enablement',
    criticality: 'high',
  },
  { key: 'shipping.correos_enabled', defaultVariantKey: 'off', polarity: 'enablement', criticality: 'high' },
  { key: 'shipping.envia_enabled', defaultVariantKey: 'off', polarity: 'enablement', criticality: 'high' },
] as const

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
    expect(BACKEND_FLAG_DEFINITION_SHARED_KEYS).toEqual(
      SHARED_DEFINITION_CONTRACT.map((entry) => entry.key),
    )

    for (const contract of SHARED_DEFINITION_CONTRACT) {
      const entry = BACKEND_FLAG_DEFINITION_CATALOG.find((entry) => entry.key === contract.key)
      expect(entry).toEqual({
        key: contract.key,
        definition: {
          valueType: 'boolean',
          description: `Miyagi flag: ${contract.key}.`,
          defaultVariantKey: contract.defaultVariantKey,
          variants: [
            { key: 'off', value: false },
            { key: 'on', value: true },
          ],
          rules: [],
          metadata: {
            source: 'miyagi',
            polarity: contract.polarity,
            criticality: contract.criticality,
            enforcement: 'both',
          },
        },
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
