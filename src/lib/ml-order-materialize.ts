/**
 * Materialize a paid ML order as a real Medusa order (ml-orders-native S1 · US-1).
 * Called from `applyMlOrderToLink` (webhook + reconcile), inside the same
 * per-link Redis lock that owns the S4 stock decrement, only when
 * `decideMlOrderApply` says `materializeOrder`.
 *
 * Inventory-neutral by construction (the Sprint 1 plan's decision): composes
 * `createOrdersStep` directly (`CreateOrderDTO[]` in, `OrderDTO[]` out — a pure
 * order-row write, confirmed against the installed
 * `@medusajs/core-flows/dist/order/steps/create-orders.d.ts`) instead of the
 * full `createOrderWorkflow`, which additionally runs
 * `confirmVariantInventoryWorkflow` (a stock-availability check that could throw
 * on a product the S4 sync already decremented for this very sale) and
 * `findOrCreateCustomerStep` (a Clerk-linked customer — AGENTS rule #4 says ML
 * buyers get none). `customer_id` is optional on `CreateOrderDTO` (confirmed
 * against `@medusajs/types/dist/order/mutations.d.ts`), so this omits it rather
 * than stand up a separate guest-customer subsystem. The ONLY inventory mutation
 * anywhere in the ML sync pipeline stays `decrementProductStock` in
 * `ml-sync-apply.ts`.
 *
 * Scope note: keyed per LINK (mirrors S4's existing per-link stock-sync grain —
 * `product_ml_link` is a 1:1 product↔item join). An ML order that sells items
 * from two different linked products materializes as two separate single-item
 * Medusa orders (both carrying the same `ml_order_id`/`ml_pack_id` metadata so
 * they're still cross-referenceable), not one combined order. True
 * multi-product-order aggregation is deferred — flag it if it proves confusing
 * in practice.
 *
 * Fee/shipping capture: the FULL raw `GET /orders/:id` and `GET /shipments/:id`
 * responses are stored verbatim on order metadata (`ml_raw_order`,
 * `ml_raw_shipment`) rather than parsed into typed fields — Mercado Libre's exact
 * fee/shipping field names couldn't be confirmed against a live sandbox from this
 * session (see the Sprint 1 plan's decision #2). Epic B (profit-analyzer, out of
 * this epic's scope) parses these.
 */

import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { createWorkflow, WorkflowResponse } from '@medusajs/framework/workflows-sdk'
import { createOrdersStep } from '@medusajs/medusa/core-flows'
import type { CreateOrderDTO, OrderDTO } from '@medusajs/framework/types'
import { getShipmentDetail, type MlOrder } from '../modules/mercadolibre/client'

type Scope = { resolve: (key: string) => any }
type LinkRef = { id: string; seller_id: string; product_id: string; variant_id?: string | null; ml_item_id: string }

const ML_SALES_CHANNEL_NAME = 'Mercado Libre'

// Process-lifetime caches — both are effectively static per deployment (one ML
// sales channel, one MXN region), so re-resolving on every sale is wasted work.
let cachedMlSalesChannelId: string | null = null
let cachedMxnRegionId: string | null = null

/** Idempotent find-or-create the dedicated ML sales channel (pattern: `internal/backfill-sales-channel`). */
async function resolveMlSalesChannelId(scope: Scope): Promise<string> {
  if (cachedMlSalesChannelId) return cachedMlSalesChannelId
  const scService = scope.resolve(Modules.SALES_CHANNEL)
  const [existing] = await scService.listSalesChannels({ name: ML_SALES_CHANNEL_NAME }, { take: 1 })
  if (existing) {
    cachedMlSalesChannelId = existing.id
    return existing.id
  }
  const created = await scService.createSalesChannels({
    name: ML_SALES_CHANNEL_NAME,
    description: 'Ventas importadas de Mercado Libre',
  })
  const row = Array.isArray(created) ? created[0] : created
  cachedMlSalesChannelId = row.id
  return row.id
}

/** The MXN region every marketplace order resolves through (mirrors `checkout-options`' own lookup). */
async function resolveMxnRegionId(scope: Scope): Promise<string | null> {
  if (cachedMxnRegionId) return cachedMxnRegionId
  const regionService: any = scope.resolve(Modules.REGION)
  const [region] = await regionService.listRegions({ currency_code: 'mxn' }, { take: 1 })
  cachedMxnRegionId = region?.id ?? null
  return cachedMxnRegionId
}

type MaterializeWorkflowInput = { orders: CreateOrderDTO[] }

const materializeMlOrderWorkflow = createWorkflow(
  'ml-materialize-order',
  (input: MaterializeWorkflowInput) => {
    const orders = createOrdersStep(input.orders)
    return new WorkflowResponse(orders)
  },
)

/**
 * This link's contribution to `mlOrder` as Medusa order line item(s) — filters to
 * ONLY the sold lines matching `link.ml_item_id` (a multi-item ML order's other
 * items belong to a different link/materialization, see the scope note above).
 *
 * Emits ONE Medusa line item PER matching ML `order_items` entry, preserving
 * each entry's own `unit_price` — it does NOT aggregate multiple lines into one
 * combined quantity at a single blended price. Cross-review (second pass) caught
 * an earlier version that summed quantities but kept only the LAST line's price,
 * silently misstating the order total whenever ML splits the same item across
 * lines at different prices (a promotion applied to only some units, a listing
 * price change mid-cart). Medusa sums the order total across all line items
 * regardless of how many there are, so multiple lines for "the same" ML item is
 * exactly as correct as one — and is the only representation that keeps the
 * total accurate. Pure — no I/O.
 */
export function buildMlOrderLineItems(
  link: LinkRef,
  mlOrder: MlOrder,
  variant: { id: string; title?: string | null },
  productTitle: string | null,
): { title: string; quantity: number; unit_price: number; variant_id: string; product_id: string }[] {
  const lines: { title: string; quantity: number; unit_price: number; variant_id: string; product_id: string }[] = []
  for (const oi of mlOrder.order_items ?? []) {
    if (oi?.item?.id !== link.ml_item_id) continue
    const qty =
      typeof oi.quantity === 'number' && Number.isFinite(oi.quantity) ? Math.max(0, Math.trunc(oi.quantity)) : 0
    if (qty <= 0) continue
    lines.push({
      title: oi.item?.title || variant.title || productTitle || 'Producto de Mercado Libre',
      quantity: qty,
      unit_price: typeof oi.unit_price === 'number' ? oi.unit_price : 0,
      variant_id: variant.id,
      product_id: link.product_id,
    })
  }
  return lines
}

/**
 * Materialize one link's contribution to a paid ML order as a Medusa order.
 * Returns `null` when materialization can't proceed (unresolved product/variant/
 * region, or no matching sold line for this link) — the caller must NOT record
 * this as applied in that case, mirroring `decrementProductStock`'s
 * null-means-retry contract so the reconcile job gets another chance.
 */
export async function materializeMlOrder(
  scope: Scope,
  link: LinkRef,
  sellerAccessToken: string,
  mlOrder: MlOrder,
): Promise<{ medusaOrderId: string } | null> {
  const query = scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: 'product',
    fields: ['id', 'title', 'variants.id', 'variants.title'],
    filters: { id: link.product_id },
  })
  const product = data?.[0] as { title?: string; variants?: { id: string; title?: string }[] } | undefined
  const variant = link.variant_id
    ? product?.variants?.find((v) => v.id === link.variant_id)
    : product?.variants?.[0]
  if (!variant) return null // unresolved product/variant → retry via reconcile

  const [regionId, salesChannelId] = await Promise.all([resolveMxnRegionId(scope), resolveMlSalesChannelId(scope)])
  if (!regionId) return null // no MXN region provisioned → retry (config gap, not a data gap)

  const items = buildMlOrderLineItems(link, mlOrder, variant, product?.title ?? null)
  if (items.length === 0) return null // this link had no matching sold line in this order

  // A blank token means the caller (e.g. the debug/backfill internal route) chose
  // not to supply one — skip the fetch rather than making a doomed unauthorized
  // ML call (cross-review caught this: it wasted a request and, worse, made the
  // internal route's optional `seller_access_token` silently degrade in a way
  // that wasn't obvious from its own contract).
  const rawShipment =
    mlOrder.shipping?.id != null && sellerAccessToken
      ? await getShipmentDetail(sellerAccessToken, mlOrder.shipping.id)
      : null

  const email =
    mlOrder.buyer?.email?.trim().toLowerCase() ||
    `ml-${mlOrder.buyer?.id ?? mlOrder.id}@mercadolibre.miyagisanchez.com`

  const { result } = await materializeMlOrderWorkflow(scope as any).run({
    input: {
      orders: [
        {
          region_id: regionId,
          sales_channel_id: salesChannelId,
          email,
          currency_code: (mlOrder.currency_id || 'MXN').toLowerCase(),
          status: 'completed',
          no_notification: true, // an ML buyer has no Miyagi account/inbox to notify
          items,
          metadata: {
            source: 'mercadolibre',
            ml_order_id: String(mlOrder.id),
            // The seller who owns this order — the reconcile-ml-order-status job
            // (US-2) reads this to fetch the ML shipment with the right token
            // without a second lookup.
            ml_seller_id: link.seller_id,
            ml_pack_id: mlOrder.pack_id != null ? String(mlOrder.pack_id) : null,
            ml_buyer: mlOrder.buyer
              ? { id: mlOrder.buyer.id ?? null, nickname: mlOrder.buyer.nickname ?? null }
              : null,
            ml_raw_order: mlOrder,
            ml_raw_shipment: rawShipment,
          },
        },
      ],
    },
  })
  const row = (Array.isArray(result) ? result[0] : result) as OrderDTO | undefined
  return row?.id ? { medusaOrderId: row.id } : null
}
