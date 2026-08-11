import { SELLER_MODULE } from '../modules/seller'
import type SellerModuleService from '../modules/seller/service'
import { requireSellerOperatingMarket } from './seller-market'

type Scope = { resolve: (key: string) => any }

/** ML commerce rails are Mexico-only. Prove that fact from the owning seller row. */
export async function isMxSeller(scope: Scope, sellerId: string): Promise<boolean> {
  if (!sellerId) return false
  const sellers: SellerModuleService = scope.resolve(SELLER_MODULE)
  const [seller] = await sellers.listSellers({ id: sellerId }, { take: 1 })
  if (!seller) return false
  try {
    return requireSellerOperatingMarket(seller) === 'mx'
  } catch {
    return false
  }
}
