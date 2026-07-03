/**
 * Apply an ML → Medusa fulfillment transition to an already-materialized order
 * (ml-orders-native S1 · US-2). The pure decision (which transition, whether it's
 * a forward move) lives in `sync-utils.ts`; this is the I/O side that actually
 * moves Medusa's fulfillment state, reusing the SAME core-flows workflows the
 * seller's own manual "ship" action already uses
 * (`sellers/me/orders/[id]/ship/route.ts`) and the Envia tracking webhook already
 * uses for delivery (`envia/tracking-update/route.ts`) — no new fulfillment
 * primitive.
 *
 * `shipped` uses the `coord` (seller-coordinated / manual delivery) shipping
 * option rather than Miyagi's Envia-backed option — an ML sale is fulfilled by
 * Mercado Libre's own carrier, not Miyagi's, so nothing here should imply Miyagi
 * generated a label. IMPORTANT: `createOrderFulfillmentWorkflow` alone only
 * advances `fulfillment_status` to `fulfilled`/`partially_fulfilled` — reaching
 * `shipped` needs `createOrderShipmentWorkflow` too (confirmed against Medusa's
 * own docs: "a shipment... marks the fulfillment as shipped"), so this calls
 * both in sequence, mirroring `ship/route.ts`'s exact two-step order. (Cross-
 * review caught an earlier draft that called only the fulfillment step, which
 * would have left `fulfillment_status` stuck at `fulfilled` and made the
 * reconcile job retry the same "shipped" transition forever.) `delivered` needs
 * an existing fulfillment (created by the `shipped` step) — a delivered target
 * with no fulfillment yet is a no-op; the next reconcile pass catches up once
 * `shipped` has landed.
 */

import {
  createOrderFulfillmentWorkflow,
  createOrderShipmentWorkflow,
  markOrderFulfillmentAsDeliveredWorkflow,
} from '@medusajs/medusa/core-flows'
import { resolveShippingOptionIds } from '../api/store/_utils/fulfillment'
import { resolveStockLocationId } from '../api/store/_utils/inventory'
import type { MlFulfillmentTransition } from '../modules/mercadolibre/sync-utils'

type Scope = { resolve: (key: string) => any }

export async function applyMlFulfillmentTransition(
  scope: Scope,
  args: {
    orderId: string
    target: MlFulfillmentTransition
    items: { id: string; quantity: number }[]
    fulfillmentId: string | null
  },
): Promise<{ applied: boolean }> {
  if (args.target === 'shipped') {
    const [optionIds, locationId] = await Promise.all([
      resolveShippingOptionIds(scope as never),
      resolveStockLocationId(scope as never),
    ])
    const shippingOptionId = optionIds.coord
    if (!shippingOptionId || args.items.length === 0) return { applied: false } // config/data gap → retry next pass

    const { result: fulfillment } = await createOrderFulfillmentWorkflow(scope as any).run({
      input: {
        order_id: args.orderId,
        items: args.items,
        shipping_option_id: shippingOptionId,
        ...(locationId ? { location_id: locationId } : {}),
        no_notification: true,
        metadata: { source: 'mercadolibre_sync' },
      } as any,
    })
    const fulfillmentId = (fulfillment as { id?: string } | undefined)?.id
    if (!fulfillmentId) return { applied: false } // couldn't resolve the new fulfillment id → retry next pass

    // The shipment step is what actually moves fulfillment_status → 'shipped'
    // (see the file doc comment) — no tracking label needed for the status
    // transition itself; attaching the ML tracking number is a clean follow-up.
    await createOrderShipmentWorkflow(scope as any).run({
      input: {
        order_id: args.orderId,
        fulfillment_id: fulfillmentId,
        items: args.items,
        no_notification: true,
      } as any,
    })
    return { applied: true }
  }

  // target === 'delivered' — needs an existing fulfillment to mark delivered.
  if (!args.fulfillmentId) return { applied: false } // no fulfillment yet → retry once 'shipped' has landed
  await markOrderFulfillmentAsDeliveredWorkflow(scope as any).run({
    input: { orderId: args.orderId, fulfillmentId: args.fulfillmentId, no_notification: true } as any,
  })
  return { applied: true }
}
