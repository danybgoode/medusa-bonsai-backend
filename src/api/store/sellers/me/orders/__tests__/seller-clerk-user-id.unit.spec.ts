import { normalizeMedusaOrder, listOrdersForSeller } from '../route'

/**
 * `marketplace_shops.clerk_user_id` — the address a seller notification is sent to.
 *
 * The bug this guards against was live and silent. `normalizeMedusaOrder` hardcoded
 * `clerk_user_id: null`, and the storefront's `resolveSellerForOrder` reads exactly
 * that field before calling `dispatchToSeller`. So for every `order_`-prefixed id the
 * lookup returned null, the whole dispatch block was skipped, and a buyer could press
 * "ya hice el pago" while the seller was told nothing on any channel — while the admin
 * Telegram nudge on the very next line fired normally, which is what made it look like
 * the notification system worked (2026-08-15 audit of order_01M012T6FW6BYP8C5S8JBQ8R37).
 *
 * The assertion that matters is the FIRST one: it fails against the pre-fix code.
 */

function order(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order_test',
    status: 'pending',
    currency_code: 'mxn',
    total: 10_000,
    items: [],
    metadata: {},
    ...overrides,
  }
}

const shopOf = (o: ReturnType<typeof normalizeMedusaOrder>) =>
  (o as unknown as { marketplace_shops: { clerk_user_id: string | null } }).marketplace_shops

describe('normalizeMedusaOrder · marketplace_shops.clerk_user_id', () => {
  it('carries the seller Clerk id through so the seller can be NOTIFIED', () => {
    const out = normalizeMedusaOrder(order(), 'sel_1', 'Ylai Studio', 'user_abc')
    expect(shopOf(out).clerk_user_id).toBe('user_abc')
  })

  it('is null — not an empty string — when the caller does not know it', () => {
    // An unclaimed supply-imported shop genuinely has no Clerk owner. "Nobody to
    // notify" must stay distinguishable from "" so a caller cannot address a
    // dispatch at a falsy id and believe it delivered.
    expect(shopOf(normalizeMedusaOrder(order(), 'sel_1', 'Tienda')).clerk_user_id).toBeNull()
    expect(shopOf(normalizeMedusaOrder(order(), 'sel_1', 'Tienda', null)).clerk_user_id).toBeNull()
  })

  it('does not disturb the id/name it already carried', () => {
    const shop = shopOf(normalizeMedusaOrder(order(), 'sel_1', 'Ylai Studio', 'user_abc')) as unknown as
      { id: string; name: string }
    expect(shop.id).toBe('sel_1')
    expect(shop.name).toBe('Ylai Studio')
  })
})

/**
 * The trace. `listOrdersForSeller` degrades to `[]` at four points and used to do it
 * with a bare `catch {}` — so "this seller has no orders" and "I could not find out"
 * rendered identically on the one screen a merchant uses to see they made a sale.
 * Three states, never two.
 */
describe('listOrdersForSeller · trace', () => {
  const scopeThatThrows = {
    resolve: (key: string) => {
      if (key === 'remoteQuery') {
        return { graph: async () => { throw new Error('boom') } }
      }
      throw new Error(`unexpected resolve(${key})`)
    },
  } as never

  it('NAMES the failure instead of reporting an empty order list', async () => {
    const trace: Record<string, unknown> = {}
    const orders = await listOrdersForSeller(scopeThatThrows, 'sel_1', 'Tienda', { trace })

    expect(orders).toEqual([])
    // The point of the whole change: empty, but not silent.
    expect(String(trace.seller_product_error)).toContain('boom')
    expect(trace.seller_product_ids).toBeUndefined()
  })

  it('is entirely optional — the production call path passes no collector', async () => {
    await expect(listOrdersForSeller(scopeThatThrows, 'sel_1', 'Tienda')).resolves.toEqual([])
  })

  it('records a genuinely empty catalog as zero, WITHOUT an error', async () => {
    const emptyScope = {
      resolve: (key: string) =>
        key === 'remoteQuery' ? { graph: async () => ({ data: [{ id: 'sel_1', products: [] }] }) } : null,
    } as never

    const trace: Record<string, unknown> = {}
    await listOrdersForSeller(emptyScope, 'sel_1', 'Tienda', { trace })

    expect(trace.seller_product_ids).toBe(0)
    expect(trace.seller_product_error).toBeUndefined()
  })
})
