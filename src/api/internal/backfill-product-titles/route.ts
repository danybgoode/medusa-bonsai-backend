/**
 * POST /internal/backfill-product-titles
 *
 * Idempotent backfill: for existing seller products created before the
 * feat/product-model update, sets:
 *   - variant title → product title (was hardcoded "Default")
 *   - variant SKU → auto-generated MIYAGI-{ts36}-{rand} (if missing)
 *
 * Auth: x-internal-secret header.
 * Body (optional): { dry_run?: boolean, limit?: number }
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'

function generateSku(): string {
  const ts = Date.now().toString(36).toUpperCase()
  const rand = Math.random().toString(36).slice(2, 5).toUpperCase()
  return `MIYAGI-${ts}-${rand}`
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = req.headers['x-internal-secret']
  if (!secret || secret !== process.env.MEDUSA_INTERNAL_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const body = (req.body ?? {}) as { dry_run?: boolean; limit?: number }
  const dryRun = body.dry_run === true
  const limit = Math.min(body.limit ?? 500, 1000)

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const productService: any = req.scope.resolve(Modules.PRODUCT)

  const { data: products } = await query.graph({
    entity: 'product',
    fields: ['id', 'title', 'variants.id', 'variants.title', 'variants.sku'],
    pagination: { take: limit, skip: 0 },
  })

  let updatedTitles = 0
  let updatedSkus = 0
  let skipped = 0

  for (const product of (products ?? []) as any[]) {
    const variant = product.variants?.[0]
    if (!variant) { skipped++; continue }

    const needsTitleFix = variant.title === 'Default'
    const needsSku = !variant.sku

    if (!needsTitleFix && !needsSku) { skipped++; continue }

    if (!dryRun) {
      const update: Record<string, unknown> = { id: variant.id }
      if (needsTitleFix) update.title = product.title
      if (needsSku) update.sku = generateSku()
      await productService.updateProductVariants(variant.id, update)
    }

    if (needsTitleFix) updatedTitles++
    if (needsSku) updatedSkus++
  }

  return res.json({
    ok: true,
    dry_run: dryRun,
    scanned: (products ?? []).length,
    updated_titles: updatedTitles,
    updated_skus: updatedSkus,
    skipped,
  })
}
