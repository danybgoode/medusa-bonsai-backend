import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../_utils/clerk-auth'
import { createSellerProduct } from '../../../_utils/seller-product-create'
import { isSupportProductMetadata, SUPPORT_PRODUCT_METADATA } from '../../../_utils/support'

async function findLinkedSupportProduct(scope: MedusaRequest['scope'], sellerId: string, configuredProductId?: string | null) {
  const remoteQuery = scope.resolve('remoteQuery')

  if (configuredProductId) {
    try {
      const { data: rows } = await remoteQuery.graph({
        entity: 'seller',
        fields: ['id', 'products.id', 'products.metadata'],
        filters: { id: sellerId },
      })
      const products = ((rows?.[0] as any)?.products ?? []) as Array<{ id: string; metadata?: unknown }>
      const configured = products.find((product) => product.id === configuredProductId)
      if (configured && isSupportProductMetadata(configured.metadata)) {
        return configured.id
      }
    } catch {
      // Fall through to a broader linked-product lookup.
    }
  }

  try {
    const { data: rows } = await remoteQuery.graph({
      entity: 'seller',
      fields: ['id', 'products.id', 'products.metadata'],
      filters: { id: sellerId },
    })
    const products = ((rows?.[0] as any)?.products ?? []) as Array<{ id: string; metadata?: unknown }>
    return products.find((product) => isSupportProductMetadata(product.metadata))?.id ?? null
  } catch {
    return null
  }
}

async function ensureSupportProduct(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) {
    return res.status(401).json({ message: 'Authentication required' })
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const [seller] = await sellerService.listSellers({ clerk_user_id: clerkUserId })
  if (!seller) {
    return res.status(404).json({ message: 'Seller profile not found' })
  }

  const sellerMeta = (seller.metadata ?? {}) as Record<string, unknown>
  const settings = (sellerMeta.settings ?? {}) as Record<string, unknown>
  const supportSettings = (settings.support ?? {}) as Record<string, unknown>
  const configuredProductId = typeof supportSettings.support_product_id === 'string'
    ? supportSettings.support_product_id
    : null

  const existingProductId = await findLinkedSupportProduct(req.scope, seller.id, configuredProductId)
  if (existingProductId) {
    const nextSettings = {
      ...settings,
      support: {
        ...supportSettings,
        support_product_id: existingProductId,
      },
    }
    await sellerService.updateSellers({
      id: seller.id,
      metadata: { ...sellerMeta, settings: nextSettings },
    })
    return res.json({ product_id: existingProductId, reused: true })
  }

  const result = await createSellerProduct(req.scope, seller.id, {
    title: `Apoyo para ${seller.name}`,
    description: `Contribuciones de apoyo para ${seller.name}.`,
    price_cents: 100,
    currency: 'MXN',
    listing_type: 'support',
    status: 'published',
    metadata: {
      ...SUPPORT_PRODUCT_METADATA,
      support_seller_id: seller.id,
      support_seller_slug: seller.slug,
    },
  })

  if (!result.ok) {
    return res.status(result.status).json({ message: result.message })
  }

  const nextSettings = {
    ...settings,
    support: {
      ...supportSettings,
      support_product_id: result.product_id,
    },
  }
  await sellerService.updateSellers({
    id: seller.id,
    metadata: { ...sellerMeta, settings: nextSettings },
  })

  return res.status(201).json({ product_id: result.product_id, reused: false })
}

// GET/POST /store/sellers/me/support-product — provision/reuse the hidden support primitive.
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  return ensureSupportProduct(req, res)
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  return ensureSupportProduct(req, res)
}
