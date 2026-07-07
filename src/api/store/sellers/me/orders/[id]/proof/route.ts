/**
 * POST /store/sellers/me/orders/:id/proof
 *
 * Seller sends a proof photo into the buyer-seller conversation before printing
 * (custom-print-products epic, Sprint 4 · Story 4.1). Body is JUST the photo
 * URL — size/quantity/price are derived HERE from the order's own first line
 * item, never trusted from the request body, so a seller cannot silently
 * understate/overstate what the buyer is approving (the StickerJunkie-pitfall
 * guard: a proof must always restate the true size/qty/price).
 *
 * Mirrors the confirm-payment / tags write pattern: an order-metadata PATCH,
 * no new table. `normalizeMedusaOrder` (../route.ts) curates these fields for
 * reads the same way it already does for `tags`/`refund_state`.
 *
 * Known v1 scope limit: proof state is ORDER-level, derived from only the
 * first line item — a cart can only ever hold items from ONE seller
 * (`lib/cart.ts`'s own doc comment on the frontend), so ownership is never
 * ambiguous, but an order with MULTIPLE configurator items from that same
 * seller only gets one proof/approval covering the first item. Fine for the
 * sprint's single-item buy-now case; a true multi-item proof would need
 * per-line-item metadata, out of scope here.
 *
 * Auth: Clerk JWT — must be the seller who owns the order's product.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { resolveSeller } from '../../../../../_utils/clerk-auth'
import { deriveProofRestatement } from '../../../../../../../lib/proof-restatement'

async function resolveOrderForSeller(req: MedusaRequest, orderId: string) {
  const sellerAuth = await resolveSeller(req)
  if (!sellerAuth) return { order: null, code: 401 as const }

  const orderService: any = req.scope.resolve(Modules.ORDER)
  const remoteQuery = req.scope.resolve(ContainerRegistrationKeys.REMOTE_QUERY)

  const [order] = await orderService.listOrders(
    { id: orderId },
    { select: ['id', 'metadata'], relations: ['items'] },
  )
  if (!order) return { order: null, code: 404 as const }

  // Reject outright when ownership can't be established at all (no resolvable
  // product ids on the order) — this route writes order-level metadata, so
  // silently allowing it through here would let any authenticated seller
  // touch any such order (cross-agent review catch, 2026-07-07; unlike
  // tags/confirm-payment, which only tag/confirm-payment an order the
  // seller already reached some other way, this is a NEW write surface).
  const productIds = ((order.items ?? []) as any[]).map((i: any) => i.product_id).filter(Boolean)
  if (productIds.length === 0) return { order: null, code: 403 as const }

  const { data: sellerRows } = await (remoteQuery as any).graph({
    entity: 'seller',
    fields: ['id', 'products.id'],
    filters: { id: sellerAuth.sellerId },
  })
  const sellerProductIds = new Set(((sellerRows?.[0] as any)?.products ?? []).map((p: any) => p.id as string))
  // Require ownership of EVERY item, not just one — this write is ORDER-level,
  // so a seller who owns only some items must not be able to send/replace a
  // proof affecting another seller's item (cross-agent review catch,
  // 2026-07-07). A cart can only ever hold one seller's items in normal use
  // (lib/cart.ts on the frontend enforces this at checkout), so this is a
  // no-op for every real order today — pure defense-in-depth.
  const owns = productIds.every((pid: string) => sellerProductIds.has(pid))
  if (!owns) return { order: null, code: 403 as const }

  return { order, code: 200 as const }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params
  const { order, code } = await resolveOrderForSeller(req, orderId)
  if (!order) {
    return res.status(code).json({ message: code === 401 ? 'Unauthorized' : code === 403 ? 'Forbidden' : 'Order not found' })
  }

  const body = req.body as { image_url?: unknown }
  const imageUrl = typeof body.image_url === 'string' ? body.image_url.trim() : ''
  if (!imageUrl) {
    return res.status(422).json({ message: 'image_url es requerido.' })
  }

  const item = ((order.items as any[]) ?? [])[0]
  if (!item) {
    return res.status(422).json({ message: 'Este pedido no tiene artículos.' })
  }

  // The restatement — the buyer-facing "what am I approving" — always comes
  // from the order's OWN line item, never the request body.
  const { size, quantity, priceCents } = deriveProofRestatement(item)

  const meta = (order.metadata ?? {}) as Record<string, unknown>
  const now = new Date().toISOString()

  const orderService: any = req.scope.resolve(Modules.ORDER)
  await orderService.updateOrders(orderId, {
    metadata: {
      ...meta,
      proof_sent: true,
      proof_sent_at: now,
      proof_image_url: imageUrl,
      proof_size: size,
      proof_quantity: quantity,
      proof_price_cents: priceCents,
      // Cleared on a re-send so a stale approval never survives a new proof.
      proof_approved: false,
      proof_approved_at: null,
    },
  })

  return res.json({
    sent: true,
    proof_sent_at: now,
    proof_image_url: imageUrl,
    proof_size: size,
    proof_quantity: quantity,
    proof_price_cents: priceCents,
  })
}
