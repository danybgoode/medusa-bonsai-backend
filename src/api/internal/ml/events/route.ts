/**
 * Internal service route — the per-seller Mercado Libre sync activity log
 * (Sprint 5 · US-13).
 *
 *   GET  /internal/ml/events?seller_slug=…&limit=50   → { events: [...] }
 *   POST /internal/ml/events   body:{ seller_slug, kind, outcome, ... }  → { ok }
 *
 * GET lists recent events newest-first (bounded). POST appends one event — used by
 * the FE import route to record an `import` event (the other event kinds are
 * recorded backend-side at their source). Events carry NO tokens (the module
 * redacts `message` on write); this route only ever emits the stored, safe shape.
 *
 * Auth: x-internal-secret must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { MERCADOLIBRE_MODULE } from '../../../../modules/mercadolibre'
import MercadolibreModuleService from '../../../../modules/mercadolibre/service'

function unauthorized(req: MedusaRequest): boolean {
  const expected = process.env.MEDUSA_INTERNAL_SECRET
  const got = req.headers['x-internal-secret'] as string | undefined
  return !expected || got !== expected
}

function firstString(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined
  return typeof v === 'string' ? v : undefined
}

async function resolveSeller(req: MedusaRequest, slug: string) {
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ slug } as never, { take: 1 })
  return seller ?? null
}

type EventRow = {
  id: string
  kind: string
  outcome: string
  code: string | null
  message: string | null
  product_id: string | null
  ml_item_id: string | null
  metadata: Record<string, unknown> | null
  created_at: Date | string | null
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const slug = firstString(req.query.seller_slug)
  if (!slug) return res.status(400).json({ message: 'seller_slug required' })

  const seller = await resolveSeller(req, slug)
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const limit = Math.min(200, Math.max(1, Number(firstString(req.query.limit)) || 50))
  const ml: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)
  const rows = (await ml.listSyncEvents(seller.id, { limit })) as EventRow[]
  const events = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    outcome: r.outcome,
    code: r.code ?? null,
    message: r.message ?? null,
    product_id: r.product_id ?? null,
    ml_item_id: r.ml_item_id ?? null,
    metadata: r.metadata ?? null,
    created_at: r.created_at ? new Date(r.created_at as string).toISOString() : null,
  }))
  return res.status(200).json({ events })
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (unauthorized(req)) return res.status(401).json({ message: 'Unauthorized' })

  const { seller_slug, kind, outcome, product_id, ml_item_id, code, message, metadata } =
    (req.body ?? {}) as {
      seller_slug?: string
      kind?: string
      outcome?: string
      product_id?: string | null
      ml_item_id?: string | null
      code?: string | null
      message?: unknown
      metadata?: Record<string, unknown> | null
    }
  if (!seller_slug || !kind) return res.status(400).json({ message: 'seller_slug and kind required' })

  const seller = await resolveSeller(req, seller_slug)
  if (!seller) return res.status(404).json({ message: 'Seller not found' })

  const ml: MercadolibreModuleService = req.scope.resolve(MERCADOLIBRE_MODULE)
  // Best-effort append (summarizeSyncEvent validates + redacts; an unknown kind is
  // silently dropped). Never throws into the caller.
  await ml.recordSyncEvent({
    sellerId: seller.id,
    kind: String(kind),
    outcome: outcome === 'fail' ? 'fail' : 'ok',
    productId: product_id ?? null,
    mlItemId: ml_item_id ?? null,
    code: code ?? null,
    message,
    metadata: metadata ?? null,
  })
  return res.status(200).json({ ok: true })
}
