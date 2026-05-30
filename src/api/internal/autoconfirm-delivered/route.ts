/**
 * POST /internal/autoconfirm-delivered
 *
 * Auto-confirms delivered Medusa orders whose delivery window has elapsed:
 * metadata.fulfillment_state 'delivered' → 'completed'. The Medusa counterpart
 * of the Supabase order-autoconfirm cron; called by the frontend cron
 * (/api/cron/order-autoconfirm) so both stores stay in sync.
 *
 * Lifecycle state lives on order.metadata (see sellers/me/orders PATCH) — we set
 * 'completed' there rather than calling completeOrderWorkflow, to avoid closing
 * the Medusa order while payments/returns may still need it.
 *
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 * Body (optional): { days?: number } — confirm window, default 7.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'

const DEFAULT_AUTO_CONFIRM_DAYS = 7

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const internalSecret = process.env.MEDUSA_INTERNAL_SECRET
  const headerSecret = req.headers['x-internal-secret'] as string | undefined
  if (internalSecret && headerSecret !== internalSecret) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const days = Number((req.body as any)?.days) || DEFAULT_AUTO_CONFIRM_DAYS
  const windowMs = days * 24 * 60 * 60 * 1000
  const now = Date.now()

  const orderService = req.scope.resolve(Modules.ORDER) as any

  let orders: any[] = []
  try {
    orders = await orderService.listOrders(
      {},
      { select: ['id', 'metadata', 'updated_at'], take: 300, order: { updated_at: 'DESC' } },
    )
  } catch (e) {
    console.error('[autoconfirm-delivered] listOrders error:', e)
    return res.status(500).json({ message: 'list failed' })
  }

  const toComplete = orders.filter((o) => {
    const m = (o.metadata ?? {}) as Record<string, any>
    if (m.fulfillment_state !== 'delivered') return false
    const deliveredAt = m.delivered_at ? new Date(m.delivered_at).getTime() : new Date(o.updated_at).getTime()
    return now - deliveredAt >= windowMs
  })

  const confirmed: string[] = []
  for (const o of toComplete) {
    try {
      await orderService.updateOrders(o.id, {
        metadata: {
          ...((o.metadata ?? {}) as Record<string, any>),
          fulfillment_state: 'completed',
          completed_at: new Date().toISOString(),
          auto_confirmed: true,
        },
      })
      confirmed.push(o.id)
    } catch (e) {
      console.error('[autoconfirm-delivered] update error:', o.id, e)
    }
  }

  return res.json({ confirmed: confirmed.length, orderIds: confirmed })
}
