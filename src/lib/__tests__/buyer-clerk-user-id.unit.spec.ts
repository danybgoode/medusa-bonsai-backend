import { normalizeMedusaOrder } from '../../api/store/sellers/me/orders/route'

/**
 * Buyer notifications — money path (epic 05), Sprint 1, Story 1.1.
 *
 * Proves normalizeMedusaOrder resolves the buyer's Clerk id from
 * customer.metadata.clerk_user_id (the existing checkout-time stamp — see
 * resolveOrCreateBuyerCustomer in start-checkout/route.ts), null-safely for
 * guest orders and malformed metadata, and leaves the rest of the shape
 * byte-for-byte unchanged.
 */

const baseOrder = (customer?: Record<string, unknown>) => ({
  id: 'order_1',
  items: [{ product_id: 'prod_1', title: 'Producto', unit_price: 100000, quantity: 1 }],
  metadata: { payment_method: 'stripe' },
  total: 100000,
  currency_code: 'mxn',
  created_at: '2026-07-08T00:00:00Z',
  updated_at: '2026-07-08T00:00:00Z',
  email: 'buyer@example.com',
  ...(customer ? { customer } : {}),
})

describe('normalizeMedusaOrder · buyer_clerk_user_id resolution', () => {
  it('resolves the buyer Clerk id for a signed-in buyer', () => {
    const out = normalizeMedusaOrder(
      baseOrder({ email: 'buyer@example.com', metadata: { clerk_user_id: 'user_abc123' } }),
      'seller_1',
      'Tienda',
    )
    expect(out.buyer_clerk_user_id).toBe('user_abc123')
  })

  it('returns null for a guest order (customer present, no clerk metadata)', () => {
    const out = normalizeMedusaOrder(
      baseOrder({ email: 'buyer@example.com' }),
      'seller_1',
      'Tienda',
    )
    expect(out.buyer_clerk_user_id).toBeNull()
  })

  it('returns null, does not throw, when customer is entirely absent', () => {
    const out = normalizeMedusaOrder(baseOrder(undefined), 'seller_1', 'Tienda')
    expect(out.buyer_clerk_user_id).toBeNull()
  })

  it('returns null for malformed metadata.clerk_user_id (non-string / empty)', () => {
    const nonString = normalizeMedusaOrder(
      baseOrder({ metadata: { clerk_user_id: 12345 } }),
      'seller_1',
      'Tienda',
    )
    expect(nonString.buyer_clerk_user_id).toBeNull()

    const empty = normalizeMedusaOrder(
      baseOrder({ metadata: { clerk_user_id: '' } }),
      'seller_1',
      'Tienda',
    )
    expect(empty.buyer_clerk_user_id).toBeNull()
  })

  it('leaves unrelated normalization untouched', () => {
    const out = normalizeMedusaOrder(
      baseOrder({ email: 'buyer@example.com', metadata: { clerk_user_id: 'user_abc123' } }),
      'seller_1',
      'Tienda',
    )
    expect(out.id).toBe('order_1')
    expect(out.amount_cents).toBe(100000)
    expect(out.buyer_email).toBe('buyer@example.com')
  })
})
