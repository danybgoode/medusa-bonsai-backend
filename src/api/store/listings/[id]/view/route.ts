import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { IProductModuleService } from '@medusajs/framework/types'

// POST /store/listings/:id/view — update lightweight PDP view metadata
export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params
  const productService: IProductModuleService = req.scope.resolve(Modules.PRODUCT)
  const remoteQuery = req.scope.resolve('remoteQuery')

  const { data: rows } = await remoteQuery.graph({
    entity: 'product',
    fields: ['id', 'metadata'],
    filters: { id, status: 'published' },
  })

  const product = rows?.[0] as { metadata?: Record<string, unknown> } | undefined
  if (!product) {
    return res.status(404).json({ message: 'Listing not found' })
  }

  const current = product.metadata ?? {}
  const requestedViews = Number((req.body as { views?: unknown })?.views)
  const currentViews = typeof current.views === 'number' ? current.views : 0
  const nextViews = Number.isFinite(requestedViews) && requestedViews > 0
    ? Math.max(currentViews, Math.floor(requestedViews))
    : currentViews + 1

  // Two-arg (id, data) form — a single merged object is read as a selector.
  await (productService as any).updateProducts(id, {
    metadata: {
      ...current,
      views: nextViews,
    },
  })

  res.status(204).send()
}
