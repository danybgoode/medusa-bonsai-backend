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
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { capturePaymentWorkflow } from '@medusajs/medusa/core-flows'

const DEFAULT_AUTO_CONFIRM_DAYS = 7
// Escrow auto-capture window: if buyer hasn't confirmed in 3 days post-delivery, auto-capture
const ESCROW_AUTO_CAPTURE_DAYS = 3

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

  // Also auto-capture escrow orders where buyer hasn't confirmed within the window
  const escrowWindowMs = ESCROW_AUTO_CAPTURE_DAYS * 24 * 60 * 60 * 1000
  const toAutoCapture = orders.filter((o) => {
    const m = (o.metadata ?? {}) as Record<string, any>
    if (!m.escrow_mode || m.escrow_captured) return false
    if (m.fulfillment_state !== 'delivered') return false
    const deliveredAt = m.delivered_at ? new Date(m.delivered_at).getTime() : new Date(o.updated_at).getTime()
    return now - deliveredAt >= escrowWindowMs
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

  // Auto-capture escrow payments whose delivery confirmation window expired
  const escrowCaptured: string[] = []
  for (const o of toAutoCapture) {
    try {
      const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
      const { data } = await (query as any).graph({
        entity: 'order',
        fields: ['id', 'payment_collections.payments.id'],
        filters: { id: o.id },
      })
      const paymentId = (data?.[0] as any)?.payment_collections?.[0]?.payments?.[0]?.id ?? null
      if (!paymentId) continue

      await capturePaymentWorkflow(req.scope).run({ input: { payment_id: paymentId } })

      const nowIso = new Date().toISOString()
      await orderService.updateOrders(o.id, {
        metadata: {
          ...((o.metadata ?? {}) as Record<string, any>),
          escrow_captured: true,
          escrow_captured_at: nowIso,
          escrow_released_by: 'autoconfirm',
          delivery_confirmed_at: nowIso,
          delivery_confirmed_by: 'autoconfirm',
        },
      })
      escrowCaptured.push(o.id)
    } catch (e) {
      console.error('[autoconfirm-delivered] escrow capture error:', o.id, e)
    }
  }

  return res.json({ confirmed: confirmed.length, orderIds: confirmed, escrowCaptured: escrowCaptured.length, escrowOrderIds: escrowCaptured })
}
