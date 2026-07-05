import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { isHiddenCatalogProduct } from '../../../_utils/support'

export interface PriceGridTier {
  min_quantity: number
  max_quantity: number | null
  amount: number
}

export interface PriceGridVariant {
  id: string
  options: Record<string, string>
  manage_inventory: boolean
  tiers: PriceGridTier[]
}

export interface PriceGridResponse {
  product_id: string
  variants: PriceGridVariant[]
}

/**
 * GET /store/listings/:id/price-grid — each buyable variant's quantity price
 * ladder, read directly from Medusa's own Price rows (min_quantity/
 * max_quantity), never from a metadata mirror — the money source of truth,
 * zero drift risk (custom-print-products Sprint 2, Story 2.3). The frontend's
 * `lib/price-grid.ts` derives display prices from this fetched-once ladder.
 *
 * Excludes variants disabled by the option-dimensions order-safety guard
 * (`metadata.disabled === true` on the old Default variant — see
 * `seller-product-update.ts`'s `applyOptionDimensions`).
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params
  const remoteQuery = req.scope.resolve('remoteQuery')

  const { data: products } = await remoteQuery.graph({
    entity: 'product',
    fields: [
      'id', 'status', 'metadata',
      'variants.id', 'variants.manage_inventory', 'variants.metadata',
      'variants.options.value', 'variants.options.option.title',
      'variants.prices.amount', 'variants.prices.currency_code',
      'variants.prices.min_quantity', 'variants.prices.max_quantity',
    ],
    filters: { id, status: 'published' },
  })

  const product = products?.[0] as any
  if (!product || product.metadata?.is_print_placement || isHiddenCatalogProduct(product.metadata)) {
    return res.status(404).json({ message: 'Listing not found' })
  }

  const variants: PriceGridVariant[] = ((product.variants ?? []) as any[])
    .filter((v) => v?.metadata?.disabled !== true)
    .map((v) => {
      const options: Record<string, string> = {}
      for (const ov of (v.options ?? []) as Array<{ value?: string; option?: { title?: string } }>) {
        if (ov?.option?.title && ov.value != null) options[ov.option.title] = ov.value
      }
      const tiers: PriceGridTier[] = ((v.prices ?? []) as any[])
        .filter((p) => p.currency_code === 'mxn')
        .map((p) => ({
          min_quantity: p.min_quantity ?? 1,
          max_quantity: p.max_quantity ?? null,
          amount: p.amount,
        }))
        .sort((a, b) => a.min_quantity - b.min_quantity)
      return { id: v.id, options, manage_inventory: !!v.manage_inventory, tiers }
    })

  const response: PriceGridResponse = { product_id: product.id, variants }
  res.json({ price_grid: response })
}
