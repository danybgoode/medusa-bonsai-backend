import { defineLink } from '@medusajs/framework/utils'
import SellerModule from '../modules/seller'
import ProductModule from '@medusajs/medusa/product'

// One seller has many seller-DEFINED product categories (own-shop-premium-
// presentation S2 "collections" — Die-cut, Zines, …). The platform's fixed
// 14-key taxonomy categories are never linked here; only categories a seller
// creates via seller-collections.ts get this link.
// Creates a pivot table: seller_id ↔ product_category_id
export default defineLink(
  SellerModule.linkable.seller,
  {
    linkable: ProductModule.linkable.productCategory,
    isList: true,
  }
)
