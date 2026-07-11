/**
 * src/api/store/_utils/delivery-catalog.ts
 *
 * Pure derivation seam for the `checkout-options` delivery catalog (arranged-only
 * delivery epic, Sprint 1 · S1.1). Kept free of Medusa/`next` imports so it is
 * directly unit-testable — mirrors the `payment-methods.ts` / `envia-killswitch.ts`
 * pattern in this codebase.
 *
 * Rebuilds the `delivery_methods[]` + `only_coordinated` logic that used to be
 * inlined in the route, adding exactly one new branch: when a listing declares
 * `delivery_mode: 'arranged'` (and the `shipping.arranged_only_enabled` kill-switch
 * is ON), push a `coord` delivery method, suppress the carrier `shipping` method,
 * and set `onlyCoordinated = true`. Everything else reproduces today's behavior
 * byte-for-byte — flag OFF or `deliveryMode` absent/`'carrier'` must yield an
 * identical result to before this seam existed.
 */

export type DeliveryMode = 'carrier' | 'arranged'

export interface PickupSpot {
  id?: string
  name?: string
  address?: string
  hours?: string
  scheduling_url?: string
  notes?: string
  instructions?: string
}

export interface DeliveryMethod {
  id: 'local_pickup' | 'shipping' | 'digital' | 'service' | 'rental' | 'coord'
  label: string
  note: string
  requires_address?: boolean
  requires_pickup_spot?: boolean
  pickup_spots?: PickupSpot[]
}

export interface BuildDeliveryCatalogInput {
  listingType: string
  isDigital: boolean
  /** Parsed from the `delivery_mode` query param; default `'carrier'`. */
  deliveryMode: DeliveryMode
  /** Pre-resolved `isEnabled('shipping.arranged_only_enabled')`. */
  arrangedOnlyEnabled: boolean
  localPickup: boolean
  pickupSpots: PickupSpot[]
  hasLiveShipping: boolean
}

export interface DeliveryCatalogResult {
  deliveryMethods: DeliveryMethod[]
  onlyCoordinated: boolean
}

/**
 * `coord`'s label mirrors the already-seeded ShippingOption text verbatim
 * (`_utils/fulfillment.ts` → `SHIPPING_OPTION_NAMES.coord` / the option's
 * `label`), so the buyer sees identical copy at checkout-options time and at
 * the seeded-fulfillment level.
 */
const COORD_LABEL = 'Entrega acordada con vendedor'
const COORD_NOTE = 'Coordinas fecha, lugar y pago directamente con el vendedor.'

export function buildDeliveryCatalog(input: BuildDeliveryCatalogInput): DeliveryCatalogResult {
  const { listingType, isDigital, deliveryMode, arrangedOnlyEnabled, localPickup, pickupSpots, hasLiveShipping } = input

  // A digital listing's delivery+payment path already works correctly — never
  // let a stray/incorrect delivery_mode force it into manual-only payment.
  const effectiveArranged = deliveryMode === 'arranged' && arrangedOnlyEnabled && !isDigital

  const deliveryMethods: DeliveryMethod[] = []

  if (localPickup) {
    deliveryMethods.push({
      id: 'local_pickup',
      label: 'Recolección en mano',
      note: pickupSpots.length
        ? 'Elige dónde recoger tu pedido.'
        : 'Coordina el punto de entrega con la tienda.',
      requires_pickup_spot: pickupSpots.length > 0,
      pickup_spots: pickupSpots.map((s, i) => ({
        id: s.id ?? s.name ?? `spot-${i}`,
        name: s.name,
        address: s.address,
        hours: s.hours,
        scheduling_url: s.scheduling_url,
        notes: s.notes ?? s.instructions,
      })),
    })
  }

  if (!effectiveArranged && !isDigital && listingType === 'product' && hasLiveShipping) {
    deliveryMethods.push({
      id: 'shipping',
      label: 'Envío a domicilio',
      note: 'Cotiza y elige paquetería antes de pagar.',
      requires_address: true,
    })
  }

  if (isDigital) {
    deliveryMethods.push({ id: 'digital', label: 'Entrega digital', note: 'Recibirás acceso o archivo después del pago.' })
  }

  if (listingType === 'service') {
    deliveryMethods.push({ id: 'service', label: 'Servicio', note: 'Coordina el horario con el vendedor.' })
  }

  if (listingType === 'rental') {
    deliveryMethods.push({ id: 'rental', label: 'Renta', note: 'Coordina las fechas con el vendedor.' })
  }

  if (effectiveArranged) {
    deliveryMethods.push({ id: 'coord', label: COORD_LABEL, note: COORD_NOTE })
  }

  return { deliveryMethods, onlyCoordinated: effectiveArranged }
}
