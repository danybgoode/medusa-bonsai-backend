import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { isHiddenCatalogProduct } from '../../../_utils/support'
import {
  MARKETPLACE_CHANNEL_FIELDS,
  productInMarketplaceChannel,
  resolveMarketReadGate,
} from '../../../_utils/market-read'
import { MARKETS } from '../../../../../lib/markets'
import { buildPriceGrid } from '../../../_utils/price-grid'

/**
 * GET /store/listings/:id/price-grid — each buyable variant's quantity price
 * ladder, read directly from Medusa's own Price rows (min_quantity/
 * max_quantity), never from a metadata mirror — the money source of truth,
 * zero drift risk (custom-print-products Sprint 2, Story 2.3). The frontend's
 * `lib/price-grid.ts` derives display prices from this fetched-once ladder.
 *
 * Excludes any variant flagged `metadata.disabled` (hidden/non-purchasable)
 * — defensive; nothing sets this today (see the comment on the same filter
 * in `_utils/listing.ts`).
 */
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params
  // Same market boundary as the PDP (D1). This is a sub-resource of a listing, but
  // it is independently addressable and it returns PRICES — an agent that cannot see
  // the listing must not be able to read its price ladder by asking for the child.
  const gate = resolveMarketReadGate((req.query as Record<string, string>)?.market, process.env)
  if (!gate.ok) {
    return res.status(gate.status).json(gate.body)
  }
  const remoteQuery = req.scope.resolve('remoteQuery')

  const { data: products } = await remoteQuery.graph({
    entity: 'product',
    fields: [
      'id', 'status', 'metadata',
      ...MARKETPLACE_CHANNEL_FIELDS,
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
  if (!productInMarketplaceChannel(product, gate.channel_id)) {
    return res.status(404).json({ message: 'Listing not found' })
  }

  const response = buildPriceGrid(product, MARKETS[gate.market].currency_code)
  res.json({ price_grid: response, market_code: gate.market })
}
