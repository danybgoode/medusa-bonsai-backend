import { admitUsDelivery, manualCarrierShipmentGap } from '../us-delivery-admission'
import { buildDeliveryCatalog } from '../delivery-catalog'

/**
 * S4.2 (D16) — the US delivery/payment admission matrix, and the catalog that offers
 * it. The storefront has its own copy of these rules so it can grey out an option;
 * this is the authorization half, which agents and stale checkout pages hit directly.
 */

const base = {
  market: 'us' as const,
  fulfillmentMethod: 'manual_carrier',
  provider: 'stripe',
  hasClientShippingQuote: false,
  hasShippingAddress: true,
}

describe('admitUsDelivery', () => {
  it('admits the US manual-carrier + card path, with seller-funded $0 shipping', () => {
    const result = admitUsDelivery(base)
    expect(result).toEqual({ ok: true, shipping_amount_cents: 0 })
  })

  it('refuses carrier-rated shipping — there is no US carrier to quote', () => {
    // Envía and Correos are Mexican and S6 is stopped at its evidence gate. Offering
    // `shipping` would promise a rate at the quote seam that nothing can produce.
    const result = admitUsDelivery({ ...base, fulfillmentMethod: 'shipping' })
    expect(result).toMatchObject({ ok: false, status: 422, code: 'US_CARRIER_UNAVAILABLE' })
  })

  it('refuses a client-supplied shipping quote — money is server-authoritative', () => {
    const result = admitUsDelivery({ ...base, hasClientShippingQuote: true })
    expect(result).toMatchObject({ ok: false, status: 422, code: 'US_CLIENT_SHIPPING_FORBIDDEN' })
  })

  it('refuses an addressed delivery with no address', () => {
    const result = admitUsDelivery({ ...base, hasShippingAddress: false })
    expect(result).toMatchObject({ ok: false, status: 422, code: 'US_ADDRESS_REQUIRED' })
  })

  it.each(['mercadopago', 'spei', 'cash', 'manual'])(
    'refuses %s on a US order — the manual rails are Mexico-only and cannot settle USD',
    (provider) => {
      expect(admitUsDelivery({ ...base, provider })).toMatchObject({
        ok: false, status: 422, code: 'US_ONLINE_PAYMENT_REQUIRED',
      })
    },
  )

  it('leaves coord to the older manual-pay rule rather than restating it', () => {
    // Two copies of one rule drift. `coord` is manual-pay in both markets by a
    // broader guard that runs upstream, so this function must not have an opinion.
    expect(admitUsDelivery({ ...base, fulfillmentMethod: 'coord', provider: 'manual' }))
      .toMatchObject({ ok: true })
  })

  it.each([
    ['shipping', true, true],
    ['shipping', false, false],
    ['manual_carrier', true, false],
    ['coord', false, false],
  ])('MX is untouched: %s is admitted regardless (quote=%s, address=%s)', (method, quote, addr) => {
    // The MX branch returns before any US rule is consulted, so nothing added to the
    // US matrix can ever change an MX checkout. That is the epic's hardest constraint
    // and it is structural here, not a matter of care.
    expect(admitUsDelivery({
      market: 'mx',
      fulfillmentMethod: method as string,
      provider: 'mercadopago',
      hasClientShippingQuote: quote as boolean,
      hasShippingAddress: addr as boolean,
    })).toEqual({ ok: true, shipping_amount_cents: null })
  })
})

describe('manualCarrierShipmentGap', () => {
  const ship = { fulfillmentMethod: 'manual_carrier', newStatus: 'shipped' }

  it('requires both a carrier and a tracking number', () => {
    expect(manualCarrierShipmentGap({ ...ship, carrier: null, trackingNumber: null }).missing)
      .toEqual(['carrier', 'tracking_number'])
  })

  it('rejects the generic `manual` carrier default — a buyer cannot track a parcel with it', () => {
    expect(manualCarrierShipmentGap({ ...ship, carrier: 'manual', trackingNumber: '1Z999' }).missing)
      .toEqual(['carrier'])
  })

  it('rejects whitespace as a tracking number', () => {
    expect(manualCarrierShipmentGap({ ...ship, carrier: 'USPS', trackingNumber: '   ' }).missing)
      .toEqual(['tracking_number'])
  })

  it('passes a real carrier and tracking number', () => {
    expect(manualCarrierShipmentGap({ ...ship, carrier: 'USPS', trackingNumber: '9400111899223' }).missing)
      .toEqual([])
  })

  it('holds for in_transit as well as shipped', () => {
    expect(manualCarrierShipmentGap({ ...ship, newStatus: 'in_transit', carrier: null, trackingNumber: null }).missing.length)
      .toBeGreaterThan(0)
  })

  it('says nothing about other fulfillment methods or other transitions', () => {
    // Always allow the negation of what you ban: an MX arranged delivery may
    // genuinely have no tracking, and this rule must not reach it.
    expect(manualCarrierShipmentGap({ fulfillmentMethod: 'coord', newStatus: 'shipped', carrier: null, trackingNumber: null }).missing).toEqual([])
    expect(manualCarrierShipmentGap({ fulfillmentMethod: 'shipping', newStatus: 'shipped', carrier: null, trackingNumber: null }).missing).toEqual([])
    expect(manualCarrierShipmentGap({ ...ship, newStatus: 'delivered', carrier: null, trackingNumber: null }).missing).toEqual([])
  })
})

describe('buildDeliveryCatalog — market shape', () => {
  const product = {
    listingType: 'product',
    isDigital: false,
    deliveryMode: 'carrier' as const,
    arrangedOnlyEnabled: false,
    localPickup: false,
    pickupSpots: [],
  }

  it('offers US manual_carrier even with no shipping origin or carrier opt-in', () => {
    // Zero-account, zero-funding is the whole point: manual carrier must not depend
    // on `hasLiveShipping`, which is an Envía/Correos signal.
    const { deliveryMethods } = buildDeliveryCatalog({ ...product, hasLiveShipping: false, market: 'us' })
    expect(deliveryMethods.map((m) => m.id)).toEqual(['manual_carrier'])
    expect(deliveryMethods[0].requires_address).toBe(true)
  })

  it('never offers carrier `shipping` in the US, even when live shipping looks available', () => {
    const { deliveryMethods } = buildDeliveryCatalog({ ...product, hasLiveShipping: true, market: 'us' })
    expect(deliveryMethods.map((m) => m.id)).not.toContain('shipping')
  })

  it('US copy is English and promises no rate or label', () => {
    const { deliveryMethods } = buildDeliveryCatalog({ ...product, hasLiveShipping: false, market: 'us' })
    const note = deliveryMethods[0].note
    expect(note).toMatch(/tracking number/i)
    // The honesty assertion: it must not talk about quoting or choosing a carrier,
    // which is what the MX `shipping` note does.
    expect(note).not.toMatch(/rate|quote|label/i)
    // …and no Spanish leaks into a US buyer's chrome (D9).
    expect(`${deliveryMethods[0].label} ${note}`).not.toMatch(/[áéíóúñ¿¡]/i)
  })

  it('MX is byte-identical to before the market parameter existed', () => {
    // No `market` at all — every existing call site.
    const before = buildDeliveryCatalog({ ...product, hasLiveShipping: true })
    expect(before.deliveryMethods).toEqual([{
      id: 'shipping',
      label: 'Envío a domicilio',
      note: 'Cotiza y elige paquetería antes de pagar.',
      requires_address: true,
    }])
    // …and explicitly passing `mx` is the same thing.
    expect(buildDeliveryCatalog({ ...product, hasLiveShipping: true, market: 'mx' })).toEqual(before)
  })

  it('MX with no live shipping still offers nothing, as before', () => {
    expect(buildDeliveryCatalog({ ...product, hasLiveShipping: false, market: 'mx' }).deliveryMethods).toEqual([])
  })
})
