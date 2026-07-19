/**
 * POST /store/sellers/me/orders/:id/ship
 *
 * Phase B: generate an Envia.com label for a Medusa order and record the
 * fulfillment natively in Medusa (tracking number + label URL in the
 * fulfillment record).
 *
 * Flow:
 *  1. Resolve seller + verify ownership
 *  2. Load order (shipping_address, metadata, items) + seller origin address
 *  3. Call envia-client createShipment() → gets tracking / label
 *  4. createOrderFulfillmentWorkflow (passes pre-built shipment in metadata
 *     so the EnviaFulfillmentService.createFulfillment() just echoes it back)
 *  5. createOrderShipmentWorkflow (attaches tracking label to fulfillment)
 *  6. Persist shipment snapshot in order.metadata for normalizeMedusaOrder
 *
 * Body: { weightGrams: number, dimensions?: { lengthCm, widthCm, heightCm } }
 *       rateId is read from order.metadata.shipping_rate_id (set at checkout).
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import {
  createOrderFulfillmentWorkflow,
  createOrderShipmentWorkflow,
} from '@medusajs/medusa/core-flows'
import { resolveSeller } from '../../../../../_utils/clerk-auth'
import { resolveShippingOptionIds, resolveStockLocationId } from '../../../../../_utils/fulfillment'
import {
  resolveSellerProductIds,
  sellerOwnsEveryOrderItem,
} from '../../../../../_utils/seller-catalog-query'
import { SELLER_MODULE } from '../../../../../../../modules/seller'
import SellerModuleService from '../../../../../../../modules/seller/service'
import {
  createShipment,
  mapEnviaError,
  type EnviaAddress,
  type EnviaPackage,
} from '../../../../../../../modules/fulfillment-envia/envia-client'
import { toEnviaStateCode } from '../../../../../../../modules/fulfillment-envia/mx-state-codes'
import { isEnabled } from '../../../../../../../lib/flags'
import { enviaKillGate, ENVIA_LABEL_DISABLED_MESSAGE } from '../../../../../../../lib/envia-killswitch'
import { parseEnviaLabelCost } from '../../../../../../../lib/profit-ledger'
import { appendNativeShippingLedger } from '../../../../../../../lib/profit-ledger-write'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const seller = await resolveSeller(req)
  if (!seller) return res.status(401).json({ message: 'Unauthorized' })

  // Resolve the seller record up front — needed both for the comp-grant check
  // below (Sprint 2: seller.metadata.envia_grant) and, further down, for the
  // origin address (reused there, no duplicate fetch).
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [sellerRecord] = await sellerService.listSellers({ id: seller.sellerId })
  const sellerMeta = (sellerRecord?.metadata ?? {}) as Record<string, any>
  const sellerGranted = Boolean(sellerMeta.envia_grant)

  // Platform Envía kill-switch (shipping.envia_enabled, default OFF / fail-open),
  // widened by a per-seller comp grant (Sprint 2: seller.metadata.envia_grant).
  // This whole route is the Envía label path; when neither applies, reject so
  // the UI steers to the existing manual-carrier flow. Server-side gate —
  // agents / stale ship screens can't bypass it.
  if (enviaKillGate({ enviaEnabled: await isEnabled('shipping.envia_enabled'), sellerGranted }).blocked) {
    return res.status(422).json({ message: ENVIA_LABEL_DISABLED_MESSAGE })
  }

  const { id: orderId } = req.params
  const body = req.body as {
    weightGrams?: number
    dimensions?: { lengthCm: number; widthCm: number; heightCm: number }
  }

  if (!body.weightGrams) {
    return res.status(400).json({ message: 'weightGrams is required' })
  }

  // ── 1. Load order ─────────────────────────────────────────────────────────
  const orderService = req.scope.resolve(Modules.ORDER) as any
  let order: Record<string, unknown>
  try {
    order = await orderService.retrieveOrder(orderId, {
      select: ['id', 'status', 'metadata', 'email'],
      relations: ['items', 'shipping_address', 'customer', 'fulfillments'],
    })
  } catch {
    return res.status(404).json({ message: 'Order not found' })
  }

  // Ownership check
  const productIds = await resolveSellerProductIds(
    req.scope,
    seller.sellerId,
    { includeDeleted: true },
  )
  if (!sellerOwnsEveryOrderItem(productIds, order.items)) {
    return res.status(403).json({ message: 'Forbidden' })
  }

  const meta = (order.metadata ?? {}) as Record<string, any>

  // Guard: must not already be shipped
  if (['shipped', 'delivered'].includes(meta.fulfillment_state ?? '')) {
    return res.status(422).json({ message: `Order is already ${meta.fulfillment_state}.` })
  }

  // Guard: a manual (SPEI/DiMo/cash) order cannot ship before payment is confirmed
  // (S2.2 — server gate, foolproof even if the UI is bypassed). Card/MP are captured.
  if (['manual', 'spei', 'cash', 'dimo'].includes((meta.payment_method as string) ?? '') && meta.payment_received !== true) {
    return res.status(422).json({ message: 'Aún no confirmas el pago de este pedido.' })
  }

  // ── 2. Resolve Envia context ──────────────────────────────────────────────
  const rateId = meta.shipping_rate_id as string | undefined
  if (!rateId) {
    return res.status(422).json({
      message: 'Este pedido no tiene una tarifa de envío seleccionada. El comprador no eligió paquetería al pagar.',
    })
  }

  // Destination from Medusa shipping_address
  const sa = (order.shipping_address ?? {}) as Record<string, any>
  if (!sa.postal_code && !sa.province) {
    return res.status(422).json({ message: 'El pedido no tiene dirección de entrega registrada.' })
  }

  const buyerName = [sa.first_name, sa.last_name].filter(Boolean).join(' ') || 'Comprador'
  const destination: EnviaAddress = {
    name: buyerName,
    phone: sa.phone ?? undefined,
    street: sa.address_1 ?? '',
    district: sa.address_2 ?? undefined,
    city: sa.city ?? '',
    state: toEnviaStateCode((sa as any).state_code ?? sa.province ?? ''),
    country: 'MX',
    postalCode: sa.postal_code ?? '',
    email: (order.email as string | undefined) ?? undefined,
  }

  // Origin from seller metadata (sellerRecord/sellerMeta resolved above, at the gate check)
  const sellerSettings = (sellerMeta.settings ?? {}) as Record<string, any>
  const shippingSettings = (sellerSettings.shipping ?? {}) as Record<string, any>
  const originRaw = (shippingSettings.origin_address ?? {}) as Record<string, any>

  if (!originRaw.street || !originRaw.postal_code) {
    return res.status(422).json({
      message: 'Configura tu dirección de origen en Ajustes antes de generar etiquetas.',
      code: 'MISSING_ORIGIN_ADDRESS',
    })
  }

  const origin: EnviaAddress = {
    name: originRaw.name ?? sellerRecord?.name ?? 'Vendedor',
    street: originRaw.street,
    number: originRaw.number ?? undefined,
    district: originRaw.colonia ?? undefined,
    city: originRaw.city ?? '',
    state: toEnviaStateCode(originRaw.state_code ?? originRaw.state ?? ''),
    country: 'MX',
    postalCode: originRaw.postal_code,
  }

  // Package from order item(s) + seller defaults
  const items = (order.items as any[]) ?? []
  const listingTitle = items[0]?.title ?? 'Producto'
  const weightKg = Math.max(0.1, body.weightGrams / 1000)
  const pkgDefaults = (shippingSettings.package_defaults ?? {}) as Record<string, any>

  const packages: EnviaPackage[] = [{
    content: String(listingTitle).slice(0, 80),
    weight: weightKg,
    dimensions: body.dimensions
      ? { length: body.dimensions.lengthCm, width: body.dimensions.widthCm, height: body.dimensions.heightCm }
      : {
          length: pkgDefaults.length_cm ?? 20,
          width:  pkgDefaults.width_cm  ?? 15,
          height: pkgDefaults.height_cm ?? 10,
        },
  }]

  // ── 3. Create Envia shipment ──────────────────────────────────────────────
  let shipment: Awaited<ReturnType<typeof createShipment>>
  try {
    shipment = await createShipment({ origin, destination, packages, rateId, reference: orderId })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[ship] Envia createShipment failed:', msg)
    return res.status(502).json({ message: mapEnviaError(msg) })
  }

  const now = new Date().toISOString()

  // ── 4. createOrderFulfillmentWorkflow ─────────────────────────────────────
  // Passes the pre-built shipment in metadata so the provider echoes it back
  // without calling Envia a second time.
  const [optionIds, locationId] = await Promise.all([
    resolveShippingOptionIds(req.scope),
    resolveStockLocationId(req.scope),
  ])
  const shippingOptionId = optionIds.shipping

  let fulfillmentId: string | undefined
  if (shippingOptionId) {
    const fulfillmentItems = items.map((i: any) => ({ id: i.id, quantity: i.quantity ?? 1 }))
    try {
      const { result: fulfillment } = await createOrderFulfillmentWorkflow(req.scope).run({
        input: {
          order_id: orderId,
          items: fulfillmentItems,
          shipping_option_id: shippingOptionId,
          ...(locationId ? { location_id: locationId } : {}),
          no_notification: true,
          metadata: {
            source: 'envia_ship',
            envia_pre_built_shipment: {
              enviaShipmentId: shipment.enviaShipmentId,
              carrier: shipment.carrier,
              trackingNumber: shipment.trackingNumber,
              labelUrl: shipment.labelUrl,
              estimatedDeliveryDate: shipment.estimatedDeliveryDate,
              rateId,
              created_at: now,
            },
          },
        } as any,
      })
      fulfillmentId = (fulfillment as any)?.id
    } catch (e) {
      // Non-fatal — metadata path still records the shipment
      console.error('[ship] createOrderFulfillmentWorkflow failed (non-fatal):', e)
    }
  } else {
    console.warn('[ship] shipping option not found — skipping Medusa fulfillment workflow')
  }

  // ── 5. createOrderShipmentWorkflow — attach tracking to fulfillment ────────
  if (fulfillmentId && shipment.trackingNumber) {
    const fulfillmentItems = items.map((i: any) => ({ id: i.id, quantity: i.quantity ?? 1 }))
    try {
      await createOrderShipmentWorkflow(req.scope).run({
        input: {
          order_id: orderId,
          fulfillment_id: fulfillmentId,
          items: fulfillmentItems,
          no_notification: true,
          labels: [{
            tracking_number: shipment.trackingNumber,
            tracking_url: '',
            label_url: shipment.labelUrl ?? '',
          }],
        } as any,
      })
    } catch (e) {
      console.error('[ship] createOrderShipmentWorkflow failed (non-fatal):', e)
    }
  }

  // ── 6. Persist shipment snapshot on order.metadata ────────────────────────
  // The label COST is captured here too (profit-analyzer S1 · US-2): parsed
  // defensively from the raw Envia response — previously discarded, which
  // left native margins shipping-blind. Null when unparseable (the profit
  // dashboard renders "envío pendiente" honestly).
  const labelCost = parseEnviaLabelCost(shipment.raw)
  const shipmentSnapshot = {
    carrier: shipment.carrier || meta.shipping_carrier || 'envia',
    carrier_label: shipment.carrier?.toUpperCase() ?? null,
    tracking_number: shipment.trackingNumber ?? null,
    label_url: shipment.labelUrl ?? null,
    envia_shipment_id: shipment.enviaShipmentId || null,
    rate_id: rateId,
    status: 'label_created',
    estimated_delivery_date: shipment.estimatedDeliveryDate ?? null,
    shipped_at: now,
    created_at: now,
    cost_cents: labelCost?.amount_cents ?? null,
    cost_source_field: labelCost?.source_field ?? null,
  }

  try {
    await orderService.updateOrders(orderId, {
      metadata: {
        ...meta,
        fulfillment_state: 'shipped',
        shipment: shipmentSnapshot,
      },
    })
  } catch (e) {
    console.error('[ship] metadata update failed:', e)
    // Return success anyway — the shipment was created in Envia
  }

  // Profit ledger follow-up event (US-2): the label cost completes the sale's
  // partial row. Flag-gated + best-effort + idempotent inside the helper.
  if (labelCost) {
    await appendNativeShippingLedger(req.scope, {
      orderId,
      amountCents: labelCost.amount_cents,
      metadata: { rate_id: rateId, source_field: labelCost.source_field, envia_shipment_id: shipment.enviaShipmentId || null },
    })
  }

  return res.json({
    trackingNumber: shipment.trackingNumber,
    labelUrl: shipment.labelUrl,
    carrier: shipment.carrier,
    estimatedDeliveryDate: shipment.estimatedDeliveryDate,
    fulfillmentId,
  })
}
