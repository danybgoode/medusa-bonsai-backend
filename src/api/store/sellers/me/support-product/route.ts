import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../../modules/seller'
import SellerModuleService from '../../../../../modules/seller/service'
import { extractClerkUserId } from '../../../_utils/clerk-auth'
import { ensureSupportProductForSeller } from '../../../_utils/support-product-ensure'

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

  // Reuse-first provisioning core shared with /internal/support-product
  // (mcp-parity-core S4) — see _utils/support-product-ensure.ts.
  const result = await ensureSupportProductForSeller(req.scope, seller)
  if (!result.ok) {
    return res.status(result.status).json({ message: result.message })
  }

  return res.status(result.reused ? 200 : 201).json({ product_id: result.product_id, reused: result.reused })
}

// GET/POST /store/sellers/me/support-product — provision/reuse the hidden support primitive.
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  return ensureSupportProduct(req, res)
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  return ensureSupportProduct(req, res)
}
