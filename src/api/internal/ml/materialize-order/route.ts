/**
 * Internal service route — direct wrapper around `materializeMlOrder`
 * (ml-orders-native S1 · US-1). Exists for two purposes: (1) the "materialization
 * contract" api spec exercises order creation without needing a live ML sandbox
 * order, and (2) manual backfill/debugging (re-materialize a specific link+order).
 *
 *   POST /internal/ml/materialize-order   body: { link_id, ml_order, seller_access_token? }
 *   → 200 { medusa_order_id: string | null }
 *
 * `seller_access_token` is optional but SHAPES the result, not just an
 * auth nicety: omitting it means `materializeMlOrder` skips the ML shipment-
 * detail fetch entirely (no token, no call) and the resulting order's
 * `ml_raw_shipment` metadata is `null`, even if `ml_order.shipping.id` is set.
 * Supply a real token to test/backfill with the shipment payload captured.
 *
 * NOT idempotent by itself — the production path is always
 * `applyMlOrderToLink` (webhook + reconcile), which owns the exactly-once
 * guarantee via the `ml_applied_order` table + the per-link lock. Calling this
 * route twice with the same `ml_order.id` creates two Medusa orders; that's
 * expected for a low-level debug wrapper, not a bug.
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { MERCADOLIBRE_MODULE } from '../../../../modules/mercadolibre'
import MercadolibreModuleService from '../../../../modules/mercadolibre/service'
import { materializeMlOrder } from '../../../../lib/ml-order-materialize'
import type { MlOrder } from '../../../../modules/mercadolibre/client'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { link_id, ml_order, seller_access_token } = (req.body ?? {}) as {
    link_id?: string
    ml_order?: MlOrder
    seller_access_token?: string
  }
  if (!link_id || !ml_order || typeof ml_order !== 'object') {
    return res.status(400).json({ message: 'link_id and ml_order are required' })
  }

  const ml: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)
  const link = await ml.getLink(link_id)
  if (!link) return res.status(404).json({ message: 'Link not found' })

  const result = await materializeMlOrder(
    req.scope,
    link as { id: string; seller_id: string; product_id: string; variant_id?: string | null; ml_item_id: string },
    seller_access_token || '',
    ml_order,
  )
  return res.status(200).json({ medusa_order_id: result?.medusaOrderId ?? null })
}
