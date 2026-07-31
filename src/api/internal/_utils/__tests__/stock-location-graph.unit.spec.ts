import { planStockLocationLinks } from '../stock-location-graph'

/**
 * D5 (owned-shop-operating-channel epic): the moment Sprint 2 moves the cart onto
 * the operating channel, `reserveInventoryStep` reserves against IT — so every
 * marketplace-linked stock location must also be linked to the operating channel
 * before that happens, or every managed-inventory purchase fails at completion.
 */
describe('planStockLocationLinks — the stock-location ↔ channel diff', () => {
  it('reports every marketplace location missing on a brand-new operating channel', () => {
    const plan = planStockLocationLinks(['loc_mx_1'], [])
    expect(plan.marketplace_location_ids).toEqual(['loc_mx_1'])
    expect(plan.operating_location_ids).toEqual([])
    expect(plan.missing_on_operating).toEqual(['loc_mx_1'])
  })

  it('reports nothing missing once the graphs already match — idempotent re-run', () => {
    const plan = planStockLocationLinks(['loc_mx_1'], ['loc_mx_1'])
    expect(plan.missing_on_operating).toEqual([])
  })

  it('only reports locations the marketplace channel actually has — an operating-only ' +
    'location is not something this backfill should ever remove or flag', () => {
    const plan = planStockLocationLinks(['loc_mx_1'], ['loc_mx_1', 'loc_operating_only'])
    expect(plan.missing_on_operating).toEqual([])
    expect(plan.operating_location_ids).toEqual(['loc_mx_1', 'loc_operating_only'])
  })

  it('handles multiple marketplace locations, linking only the ones not yet shared', () => {
    const plan = planStockLocationLinks(['loc_1', 'loc_2', 'loc_3'], ['loc_2'])
    expect(plan.missing_on_operating).toEqual(['loc_1', 'loc_3'])
  })

  it('an empty marketplace graph reports nothing missing — nothing to protect against yet', () => {
    const plan = planStockLocationLinks([], [])
    expect(plan.missing_on_operating).toEqual([])
  })
})
