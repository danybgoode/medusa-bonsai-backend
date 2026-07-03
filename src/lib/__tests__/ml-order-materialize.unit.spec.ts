import { buildMlOrderLineItems } from '../ml-order-materialize'
import type { MlOrder } from '../../modules/mercadolibre/client'

/**
 * ml-orders-native S1 · US-1 — the pure line-item construction seam. No DB, no
 * network: proves the "this link's contribution only" filter (a multi-item ML
 * order's other lines belong to a different link/materialization) and that
 * multiple ML lines for the same item stay SEPARATE Medusa line items, each
 * with its own price — never blended into one combined-quantity/last-price
 * line (cross-review caught that as a real order-total bug).
 */

const link = { id: 'mll_1', seller_id: 'sel_1', product_id: 'prod_1', ml_item_id: 'MLM1' }
const variant = { id: 'variant_1', title: 'Talla M' }

describe('buildMlOrderLineItems', () => {
  it('builds one line item from a matching order_items entry', () => {
    const order: MlOrder = {
      id: 'ord_1',
      order_items: [{ item: { id: 'MLM1', title: 'Playera' }, quantity: 2, unit_price: 150 }],
    }
    expect(buildMlOrderLineItems(link, order, variant, 'Playera producto')).toEqual([
      { title: 'Playera', quantity: 2, unit_price: 150, variant_id: 'variant_1', product_id: 'prod_1' },
    ])
  })

  it('ignores order lines that belong to a DIFFERENT linked item', () => {
    const order: MlOrder = {
      id: 'ord_2',
      order_items: [
        { item: { id: 'MLM1' }, quantity: 1, unit_price: 100 },
        { item: { id: 'MLM_OTHER' }, quantity: 5, unit_price: 999 },
      ],
    }
    const items = buildMlOrderLineItems(link, order, variant, null)
    expect(items).toHaveLength(1)
    expect(items[0].quantity).toBe(1)
  })

  it('emits SEPARATE line items for multiple ML lines of the same item — never a blended quantity/price', () => {
    const order: MlOrder = {
      id: 'ord_3',
      order_items: [
        { item: { id: 'MLM1' }, quantity: 1, unit_price: 100 },
        { item: { id: 'MLM1' }, quantity: 2, unit_price: 80 }, // e.g. a promo on the second line
      ],
    }
    const items = buildMlOrderLineItems(link, order, variant, null)
    expect(items).toEqual([
      { title: 'Talla M', quantity: 1, unit_price: 100, variant_id: 'variant_1', product_id: 'prod_1' },
      { title: 'Talla M', quantity: 2, unit_price: 80, variant_id: 'variant_1', product_id: 'prod_1' },
    ])
    // The total Medusa will compute (Σ quantity × unit_price) matches the real
    // ML total exactly — a blended single line could not represent this.
    const total = items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0)
    expect(total).toBe(1 * 100 + 2 * 80)
  })

  it('falls back title → variant title → product title → a generic default', () => {
    const order: MlOrder = { id: 'ord_4', order_items: [{ item: { id: 'MLM1' }, quantity: 1, unit_price: 10 }] }
    expect(buildMlOrderLineItems(link, order, { id: 'v' }, 'Producto genérico')[0].title).toBe('Producto genérico')
    expect(buildMlOrderLineItems(link, order, { id: 'v' }, null)[0].title).toBe('Producto de Mercado Libre')
  })

  it('returns [] when this link has no matching sold line (0 quantity or absent)', () => {
    expect(buildMlOrderLineItems(link, { id: 'ord_5', order_items: [] }, variant, null)).toEqual([])
    expect(
      buildMlOrderLineItems(link, { id: 'ord_6', order_items: [{ item: { id: 'MLM1' }, quantity: 0 }] }, variant, null),
    ).toEqual([])
  })
})
