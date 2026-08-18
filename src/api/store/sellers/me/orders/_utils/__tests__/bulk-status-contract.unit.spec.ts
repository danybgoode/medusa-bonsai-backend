import { parseBulkStatusRequest } from '../bulk-status-contract'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('parseBulkStatusRequest', () => {
  it('deduplicates ids and keeps only string review baselines', () => {
    expect(parseBulkStatusRequest({
      order_ids: ['order_1', 'order_1', 7, 'order_2'],
      status: 'shipped',
      expected_statuses: { order_1: 'paid', order_2: 7 },
    })).toEqual({
      orderIds: ['order_1', 'order_2'],
      newStatus: 'shipped',
      expectedStatuses: { order_1: 'paid' },
    })
  })

  it('degrades malformed input to an explicit empty request', () => {
    expect(parseBulkStatusRequest(null)).toEqual({ orderIds: [], newStatus: null, expectedStatuses: {} })
  })
})

describe('bulk-status preview route source contract', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/api/store/sellers/me/orders/bulk-status/preview/route.ts'),
    'utf8',
  )

  it('proves per-object ownership before adding an identified plan', () => {
    expect(source).toContain('sellerOwnsEveryOrderItem')
    expect(source.indexOf('sellerOwnsEveryOrderItem')).toBeLessThan(source.indexOf('title: typeof firstTitle'))
    expect(source).toContain('Pedido no encontrado o no disponible.')
  })

  it('cannot import or invoke the mutation/workflow seam', () => {
    expect(source).not.toMatch(/applyOrderStatusTransition|updateOrders|createOrder\w+Workflow/)
    expect(source).toContain('planOrderStatusTransition')
  })
})

describe('bulk-status apply route source contract', () => {
  const source = readFileSync(
    join(process.cwd(), 'src/api/store/sellers/me/orders/bulk-status/route.ts'),
    'utf8',
  )

  it('re-checks ownership without distinguishing a foreign id from a missing id', () => {
    expect(source).toContain('sellerOwnsEveryOrderItem')
    expect(source).not.toContain('Este pedido no te pertenece.')
    expect(source.match(/Pedido no encontrado o no disponible\./g)).toHaveLength(2)
  })

  it('passes the reviewed current state into the shared apply planner', () => {
    expect(source).toContain('expectedStatus: expectedStatuses[orderId]')
    expect(source).toContain('applyOrderStatusTransition')
  })
})
