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
 *
 * Sprint 2 · S2.2 — `isCoordinatedListing` is the canonical "must this listing pay
 * manually" signal, now shared by `checkout-options` (below) AND `start-checkout`'s
 * 422 guard, so both re-derive from the same product truth instead of the guard
 * trusting client input. It is DELIBERATELY broader than `effectiveArranged`:
 * service/rental listings are coordinated UNCONDITIONALLY (independent of the
 * `arranged_only` flag) because `OPTION_KEY_BY_METHOD` has always routed their
 * fulfillment to the `coord` option — card-payability for them was a pre-existing
 * bug, not gated epic scope, so this branch closes it live on merge. The
 * `delivery_mode === 'arranged'` branch stays flag-gated, preserving S1.1's
 * "flag off ⇒ byte-identical to today" contract for the new capability.
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

/**
 * Canonical "does this listing require manual (non-instant) payment" signal.
 * See the file-header note (Sprint 2 · S2.2) for why service/rental is
 * unconditional while `arranged` stays behind the kill-switch.
 *
 * Known cross-epic tension (flagged, not resolved here): the (dark, OFF)
 * `checkout.rental_pricing_enabled` capability (Rental line-item pricing
 * epic) was designed to let rentals be safely CARD-paid via a server-
 * recomputed total (see `lib/rental-checkout.ts` / `app/api/ucp/checkout-
 * session/route.ts`'s `rentalCheckoutUrl`/`mpAvailable`/`stripeAvailable`
 * rental branches, frontend repo). This function's `rental` branch
 * unconditionally requires manual payment instead — a deliberate scope
 * choice from THIS epic's Sprint 2 story ("service and rental listings...
 * enforce manual payment like any coordinated delivery"), confirmed with
 * Daniel. Since `rental_pricing_enabled` is off/dark today this changes
 * nothing live, but whoever activates that flag later must reconcile the
 * two: either rentals stay manual-only (retire the card-rental branch) or
 * this function needs a carve-out for a rental with a valid server quote.
 */
export function isCoordinatedListing(input: {
  listingType: string
  deliveryMode: DeliveryMode
  arrangedOnlyEnabled: boolean
  isDigital: boolean
}): boolean {
  const { listingType, deliveryMode, arrangedOnlyEnabled, isDigital } = input
  if (isDigital) return false
  if (listingType === 'service' || listingType === 'rental') return true
  return deliveryMode === 'arranged' && arrangedOnlyEnabled
}

export function buildDeliveryCatalog(input: BuildDeliveryCatalogInput): DeliveryCatalogResult {
  const { listingType, isDigital, deliveryMode, arrangedOnlyEnabled, localPickup, pickupSpots, hasLiveShipping } = input

  // Drives the coord-method-push + carrier-shipping-suppression below — the
  // NEW `arranged` capability only, gated by the kill-switch (unchanged from
  // S1.1). Service/rental already get their own 'service'/'rental' delivery
  // method entries further down, independent of this flag.
  const effectiveArranged = deliveryMode === 'arranged' && arrangedOnlyEnabled && !isDigital
  // Drives `onlyCoordinated` (payment filtering) — the canonical, broader signal.
  const onlyCoordinated = isCoordinatedListing({ listingType, deliveryMode, arrangedOnlyEnabled, isDigital })

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

  return { deliveryMethods, onlyCoordinated }
}

export type ResolveDeliveryModeForWriteResult =
  | { ok: true; value: DeliveryMode }
  | { ok: false; message: string }

/**
 * S1.2 — the write-path rule shared by createSellerProduct and
 * updateSellerProduct: validate the requested delivery_mode, then force
 * 'arranged' for service/rental listings regardless of what was requested
 * (checkout-options already treats those types as never-carrier-shippable —
 * an independent carrier/arranged choice for a haircut has no coherent
 * meaning, and forcing it server-side, not just hiding the UI, protects
 * against a direct API/MCP write bypassing the listing-editor toggle).
 * `requested: null` resets to the default ('carrier') for non-service/rental.
 */
export function resolveDeliveryModeForWrite(input: {
  listingType: string
  requested: DeliveryMode | null | undefined
}): ResolveDeliveryModeForWriteResult {
  const { listingType, requested } = input
  if (requested != null && requested !== 'carrier' && requested !== 'arranged') {
    return { ok: false, message: "delivery_mode must be 'carrier' or 'arranged'" }
  }
  if (listingType === 'service' || listingType === 'rental') {
    return { ok: true, value: 'arranged' }
  }
  return { ok: true, value: requested ?? 'carrier' }
}
