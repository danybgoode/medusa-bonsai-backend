/**
 * PATCH /store/sellers/me/orders/:id/tags
 *
 * Add or remove ONE free-form tag on an order (ml-orders-native S3 · US-7).
 * Single-op (not a full-array replace) — safer under concurrent edits from two
 * tabs/agents than a last-write-wins full replace. Tags ride `order.metadata.tags`
 * (no native Medusa order-tags concept exists — see `orders/route.ts`'s
 * `normalizeMedusaOrder`, which curates this same field for reads).
 *
 * Auth: Clerk JWT — must be the seller who owns the order's product.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import { resolveSeller } from '../../../../../_utils/clerk-auth'

const MAX_TAG_LENGTH = 30

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
  // touch any such order.
  const productIds = ((order.items ?? []) as any[]).map((i: any) => i.product_id).filter(Boolean)
  if (productIds.length === 0) return { order: null, code: 403 as const }

  const { data: sellerRows } = await (remoteQuery as any).graph({
    entity: 'seller',
    fields: ['id', 'products.id'],
    filters: { id: sellerAuth.sellerId },
  })
  const sellerProductIds = new Set(((sellerRows?.[0] as any)?.products ?? []).map((p: any) => p.id as string))
  // Require ownership of EVERY item, not just one — this write is ORDER-level
  // (tags apply to the whole order), so a seller who owns only some items
  // must not be able to mutate state that also covers another seller's item
  // (cross-agent review catch, 2026-07-07). A cart can only ever hold one
  // seller's items in normal use (lib/cart.ts on the frontend enforces this
  // at checkout), so this is a no-op for every real order today — pure
  // defense-in-depth against that invariant ever weakening elsewhere.
  const owns = productIds.every((pid: string) => sellerProductIds.has(pid))
  if (!owns) return { order: null, code: 403 as const }

  return { order, code: 200 as const }
}

/** Trim + collapse whitespace + cap length. Empty/whitespace-only → null (reject). */
function normalizeTag(raw: string): string | null {
  const trimmed = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH)
  return trimmed.length ? trimmed : null
}

function addTag(tags: string[], raw: string): string[] {
  const tag = normalizeTag(raw)
  if (!tag) return tags
  const exists = tags.some((t) => t.toLowerCase() === tag.toLowerCase())
  return exists ? tags : [...tags, tag]
}

function removeTag(tags: string[], raw: string): string[] {
  const target = raw.trim().toLowerCase()
  return tags.filter((t) => t.toLowerCase() !== target)
}

export async function PATCH(req: MedusaRequest, res: MedusaResponse) {
  const { id: orderId } = req.params
  const { order, code } = await resolveOrderForSeller(req, orderId)
  if (!order) {
    return res.status(code).json({ message: code === 401 ? 'Unauthorized' : code === 403 ? 'Forbidden' : 'Order not found' })
  }

  const body = req.body as { add?: unknown; remove?: unknown }
  const meta = (order.metadata ?? {}) as Record<string, unknown>
  const currentTags = Array.isArray(meta.tags) ? (meta.tags as string[]).filter((t) => typeof t === 'string') : []

  let nextTags: string[]
  if (typeof body.add === 'string') {
    if (!normalizeTag(body.add)) {
      return res.status(422).json({ message: 'La etiqueta no puede estar vacía.' })
    }
    nextTags = addTag(currentTags, body.add)
  } else if (typeof body.remove === 'string') {
    nextTags = removeTag(currentTags, body.remove)
  } else {
    return res.status(400).json({ message: 'add o remove son requeridos.' })
  }

  const orderService: any = req.scope.resolve(Modules.ORDER)
  await orderService.updateOrders(orderId, { metadata: { ...meta, tags: nextTags } })

  return res.json({ tags: nextTags })
}
