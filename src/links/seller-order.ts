import { defineLink } from '@medusajs/framework/utils'
import SellerModule from '../modules/seller'
import OrderModule from '@medusajs/medusa/order'

// One seller has many orders.
// Creates a pivot table: seller_id ↔ order_id
export default defineLink(
  SellerModule.linkable.seller,
  OrderModule.linkable.order
)
