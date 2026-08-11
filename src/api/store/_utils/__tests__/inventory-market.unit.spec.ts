import { resolveStockLocationId } from '../inventory'

const scope = { resolve: jest.fn(() => { throw new Error('database fallback must never run') }) }

describe('market-scoped stock location', () => {
  it('resolves MX and US from distinct configured ids', async () => {
    const env = {
      MEDUSA_STOCK_LOCATION_ID: 'sloc_mx',
      MEDUSA_US_STOCK_LOCATION_ID: 'sloc_us',
    }
    await expect(resolveStockLocationId(scope, 'mx', env)).resolves.toBe('sloc_mx')
    await expect(resolveStockLocationId(scope, 'us', env)).resolves.toBe('sloc_us')
    expect(scope.resolve).not.toHaveBeenCalled()
  })

  it('fails closed when that market is unconfigured and never borrows the other market', async () => {
    await expect(resolveStockLocationId(scope, 'us', {
      MEDUSA_STOCK_LOCATION_ID: 'sloc_mx',
    })).resolves.toBeUndefined()
    await expect(resolveStockLocationId(scope, 'mx', {
      MEDUSA_US_STOCK_LOCATION_ID: 'sloc_us',
    })).resolves.toBeUndefined()
    expect(scope.resolve).not.toHaveBeenCalled()
  })
})
