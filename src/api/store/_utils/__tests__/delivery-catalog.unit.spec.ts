import { buildDeliveryCatalog } from '../delivery-catalog'

/**
 * Arranged-only delivery · Sprint 1 · S1.1 (backend enforcement).
 * The `shipping.arranged_only_enabled` flag (enablement polarity / default OFF),
 * applied at the single seam that decides delivery_methods + only_coordinated.
 * Pure function — no flag store, no DB, no Medusa. The flag *value* is resolved
 * by src/lib/flags.ts (fail-open); this proves the derivation.
 */

const baseInput = {
  listingType: 'product',
  isDigital: false,
  localPickup: false,
  pickupSpots: [],
  hasLiveShipping: true,
}

describe('buildDeliveryCatalog · flag OFF or delivery_mode carrier ⇒ byte-identical to today', () => {
  it('flag OFF + deliveryMode carrier: shipping present, no coord, onlyCoordinated false', () => {
    const { deliveryMethods, onlyCoordinated } = buildDeliveryCatalog({
      ...baseInput, deliveryMode: 'carrier', arrangedOnlyEnabled: false,
    })
    expect(deliveryMethods.map(m => m.id)).toEqual(['shipping'])
    expect(onlyCoordinated).toBe(false)
  })

  it('flag OFF + deliveryMode arranged: arranged is ignored entirely (flag gates it)', () => {
    const { deliveryMethods, onlyCoordinated } = buildDeliveryCatalog({
      ...baseInput, deliveryMode: 'arranged', arrangedOnlyEnabled: false,
    })
    expect(deliveryMethods.map(m => m.id)).toEqual(['shipping'])
    expect(onlyCoordinated).toBe(false)
  })

  it('flag ON + deliveryMode carrier (default): unchanged from today', () => {
    const { deliveryMethods, onlyCoordinated } = buildDeliveryCatalog({
      ...baseInput, deliveryMode: 'carrier', arrangedOnlyEnabled: true,
    })
    expect(deliveryMethods.map(m => m.id)).toEqual(['shipping'])
    expect(onlyCoordinated).toBe(false)
  })
})

describe('buildDeliveryCatalog · flag ON + deliveryMode arranged', () => {
  it('pushes coord, suppresses shipping, sets onlyCoordinated true', () => {
    const { deliveryMethods, onlyCoordinated } = buildDeliveryCatalog({
      ...baseInput, deliveryMode: 'arranged', arrangedOnlyEnabled: true,
    })
    expect(deliveryMethods).toEqual([
      { id: 'coord', label: 'Entrega acordada con vendedor', note: 'Coordinas fecha, lugar y pago directamente con el vendedor.' },
    ])
    expect(onlyCoordinated).toBe(true)
  })

  it('local_pickup is unaffected by arranged — both can coexist', () => {
    const { deliveryMethods } = buildDeliveryCatalog({
      ...baseInput, deliveryMode: 'arranged', arrangedOnlyEnabled: true, localPickup: true,
    })
    expect(deliveryMethods.map(m => m.id)).toEqual(['local_pickup', 'coord'])
  })

  it('service listing: coord is pushed alongside the existing service method', () => {
    const { deliveryMethods } = buildDeliveryCatalog({
      ...baseInput, listingType: 'service', deliveryMode: 'arranged', arrangedOnlyEnabled: true,
    })
    expect(deliveryMethods.map(m => m.id)).toEqual(['service', 'coord'])
  })

  it('rental listing: coord is pushed alongside the existing rental method', () => {
    const { deliveryMethods } = buildDeliveryCatalog({
      ...baseInput, listingType: 'rental', deliveryMode: 'arranged', arrangedOnlyEnabled: true,
    })
    expect(deliveryMethods.map(m => m.id)).toEqual(['rental', 'coord'])
  })
})

describe('buildDeliveryCatalog · digital-listing defensive guard', () => {
  it('arranged is ignored for a digital listing even with the flag ON (digital path stays intact)', () => {
    const { deliveryMethods, onlyCoordinated } = buildDeliveryCatalog({
      ...baseInput, isDigital: true, deliveryMode: 'arranged', arrangedOnlyEnabled: true,
    })
    expect(deliveryMethods.map(m => m.id)).toEqual(['digital'])
    expect(onlyCoordinated).toBe(false)
  })
})

describe('buildDeliveryCatalog · pickup spot mapping (unchanged behavior)', () => {
  it('falls back to instructions when notes is absent', () => {
    const { deliveryMethods } = buildDeliveryCatalog({
      ...baseInput,
      deliveryMode: 'carrier',
      arrangedOnlyEnabled: false,
      localPickup: true,
      pickupSpots: [{ name: 'Tienda Centro', instructions: 'Toca el timbre' }],
    })
    const pickup = deliveryMethods.find(m => m.id === 'local_pickup')
    expect(pickup?.pickup_spots?.[0]).toMatchObject({ id: 'Tienda Centro', notes: 'Toca el timbre' })
  })
})
