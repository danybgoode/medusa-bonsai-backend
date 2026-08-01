import {
  BACKEND_FLAG_DEFINITION_CATALOG,
  BACKEND_FLAG_DEFINITION_SHARED_KEYS,
  buildBackendFlagDefinition,
} from '../flag-definition-catalog'
import { BACKEND_FLAG_CATALOG } from '../flag-catalog'

const SHARED_DEFINITION_CONTRACT = [
  {
    key: 'catalog.bulk_enabled',
    defaultVariantKey: 'on',
    polarity: 'killswitch',
    criticality: 'high',
    description:
      'Editar muchos productos a la vez (selección masiva). Actívala para permitir cambios masivos de precio, categoría, etc.; por seguridad empieza apagada, ya que un error afectaría muchos productos de golpe.',
  },
  {
    key: 'catalog.inventory_channels_enabled',
    defaultVariantKey: 'on',
    polarity: 'enablement',
    criticality: 'high',
    description:
      'Modos de inventario (sin límite / sobre pedido), publicar o no cada producto en Mercado Libre, y precio distinto para ML. Actívala para desbloquear estas opciones por producto; apagada, todo producto usa inventario normal con existencias contadas.',
  },
  {
    key: 'checkout.rental_pricing_enabled',
    defaultVariantKey: 'on',
    polarity: 'enablement',
    criticality: 'high',
    description:
      'Cobro automático de rentas (noches × tarifa + depósito). Actívala para que el checkout calcule el cobro completo de una renta; apagada, las rentas se coordinan directamente con el vendedor.',
  },
  {
    key: 'checkout.stripe_enabled',
    defaultVariantKey: 'on',
    polarity: 'killswitch',
    criticality: 'high',
    description:
      'Pagos con tarjeta vía Stripe. Actívala para permitir pagos con tarjeta; apágala para quitar Stripe de todo el checkout (los demás métodos de pago siguen funcionando).',
  },
  {
    key: 'ml.publish_enabled',
    defaultVariantKey: 'on',
    polarity: 'enablement',
    criticality: 'high',
    description:
      'Publicar productos en Mercado Libre, paso 3. Actívala para permitir publicar y editar productos en ML desde aquí; apagada, esa opción no aparece.',
  },
  {
    key: 'ml.sync_enabled',
    defaultVariantKey: 'on',
    polarity: 'killswitch',
    criticality: 'high',
    description:
      'Sincronización de inventario con Mercado Libre en ambos sentidos. Actívala para mantener el stock igual en los dos lados automáticamente; apágala para detener la sincronización al instante si algo sale mal. Por seguridad, empieza apagada.',
  },
  {
    key: 'ml.sync_paywall_enabled',
    defaultVariantKey: 'on',
    polarity: 'enablement',
    criticality: 'low',
    description:
      'Cobro por activar la sincronización de inventario con ML. Actívala para que activar la sincronización requiera un plan de pago; apagada, cualquier vendedor conectado puede sincronizar gratis.',
  },
  {
    key: 'ops.profit_enabled',
    defaultVariantKey: 'on',
    polarity: 'enablement',
    criticality: 'medium',
    description:
      'Panel de ganancias y márgenes para vendedores. Actívala para mostrar el panel y empezar a registrar cada venta; apagada, no hay panel ni registro.',
  },
  {
    key: 'shipping.arranged_only_enabled',
    defaultVariantKey: 'on',
    polarity: 'enablement',
    criticality: 'high',
    description:
      'Entrega acordada por vendedor, anuncio por anuncio. Actívala para que un vendedor pueda marcar un anuncio como "solo entrega acordada" (oculta la paquetería automática y el comprador coordina directo); apagada, todos los anuncios se comportan como hoy (paquetería normal).',
  },
  {
    key: 'shipping.correos_enabled',
    defaultVariantKey: 'on',
    polarity: 'enablement',
    criticality: 'high',
    description:
      'Tarifa económica de Correos de México en el checkout. Actívala para ofrecer esta opción de envío económico; apagada, esta tarifa nunca aparece (independiente de Envía).',
  },
  {
    key: 'shipping.envia_enabled',
    defaultVariantKey: 'off',
    polarity: 'enablement',
    criticality: 'high',
    description:
      'Cotización y envío automático con Envía.com. Actívala cuando la cuenta de Envía esté lista para usarse; apagada, los compradores solo ven entrega acordada o recolección en tienda.',
  },
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
      expect(published?.definition.defaultVariantKey).toBe(source.goldenDefault ? 'on' : 'off')
      expect(published?.definition.metadata).toEqual({
        source: 'miyagi',
        polarity: source.polarity,
        criticality: source.criticality,
        enforcement: source.goldenEnforcement,
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
          description: contract.description,
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
    expect(mlOrders).toEqual({
      key: 'ml.orders_enabled',
      definition: {
        valueType: 'boolean',
        description:
          'Crear un pedido real cuando se vende en Mercado Libre. Actívala para que una venta en ML también cree un pedido en Miyagi; apagada, solo se actualiza el stock, sin crear pedido.',
        defaultVariantKey: 'on',
        variants: [
          { key: 'off', value: false },
          { key: 'on', value: true },
        ],
        rules: [],
        metadata: {
          source: 'miyagi',
          polarity: 'enablement',
          criticality: 'high',
          enforcement: 'both',
        },
      },
    })
    expect(BACKEND_FLAG_DEFINITION_SHARED_KEYS).not.toContain('ml.orders_enabled')
  })

  it('keeps Golden definition defaults separate from fail-open runtime defaults', () => {
    const bulk = BACKEND_FLAG_CATALOG.find((entry) => entry.key === 'catalog.bulk_enabled')
    const envía = BACKEND_FLAG_CATALOG.find((entry) => entry.key === 'shipping.envia_enabled')
    expect(bulk).toMatchObject({ compileDefault: false, goldenDefault: true })
    expect(envía).toMatchObject({ compileDefault: false, goldenDefault: false })
  })

  it('pins the live owned-shop kill-switch definition exactly', () => {
    expect(
      BACKEND_FLAG_DEFINITION_CATALOG.find(
        (entry) => entry.key === 'catalog.owned_shop_only_enabled',
      ),
    ).toEqual({
      key: 'catalog.owned_shop_only_enabled',
      definition: {
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
      },
    })
  })
})
