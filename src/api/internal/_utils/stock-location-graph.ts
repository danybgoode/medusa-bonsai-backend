/**
 * stock-location-graph.ts — the stock-location ↔ sales-channel diff the owned-shop-
 * operating-channel epic's D5 requires reported and closed.
 *
 * WHY THIS EXISTS: Medusa reserves inventory at order completion AGAINST THE CART'S
 * SALES CHANNEL (`reserveInventoryStep`), and a channel with no linked stock location
 * cannot reserve — it throws "sales channel not associated with any stock location".
 * Today the seeded stock location is linked to the MARKETPLACE channel only. The
 * moment Sprint 2 moves the cart onto the OPERATING channel (D3), every
 * managed-inventory purchase fails at completion unless the operating channel
 * carries the same link. This is pure diffing logic only — the actual link is made
 * with the existing `ensureSalesChannelLocationLink`
 * (`src/api/store/_utils/inventory.ts`); this file does not duplicate it.
 */

export interface StockLocationLinkPlan {
  /** Every stock location id the MARKETPLACE channel is linked to. */
  readonly marketplace_location_ids: readonly string[]
  /** Every stock location id the OPERATING channel is linked to, before any write. */
  readonly operating_location_ids: readonly string[]
  /**
   * Marketplace-linked locations the operating channel does NOT yet carry — exactly
   * the set `ensureSalesChannelLocationLink` must be called for. Empty means the
   * graphs already match (idempotent re-run, or provisioning already ran).
   */
  readonly missing_on_operating: readonly string[]
}

/**
 * Diff the two channels' stock-location links — PURE, so the dry-run report and the
 * apply step read the exact same plan and can never disagree about what is missing.
 */
export function planStockLocationLinks(
  marketplaceLocationIds: readonly string[],
  operatingLocationIds: readonly string[],
): StockLocationLinkPlan {
  const operatingSet = new Set(operatingLocationIds)
  return {
    marketplace_location_ids: [...marketplaceLocationIds],
    operating_location_ids: [...operatingLocationIds],
    missing_on_operating: marketplaceLocationIds.filter((id) => !operatingSet.has(id)),
  }
}

/**
 * Read every stock location id a Sales Channel is linked to.
 *
 * Lives HERE, beside the diff it feeds, because it was originally written twice —
 * once in `/internal/operating-channel-backfill` and once in
 * `src/scripts/provision-mx-operating-channel.ts` — and the two copies had ALREADY
 * drifted before either shipped (different `fields` lists, one casting `filters` and
 * one not). Two readers of the same graph that disagree about what they ask for is
 * how one of them gets a fix the other never does; the dry-run report and the
 * provisioning script must see the identical link set or D5's before/after numbers
 * mean nothing.
 *
 * `query` is Medusa's container-resolved QUERY. Typed loosely because
 * `ContainerRegistrationKeys.QUERY` resolves differently in a route (`req.scope`) and
 * in a `medusa exec` script (`container`), and both call this.
 */
export async function locationIdsForChannel(
  query: { graph: (args: unknown) => Promise<{ data?: Array<{ stock_locations?: Array<{ id: string }> | null }> }> },
  channelId: string,
): Promise<string[]> {
  const { data } = await query.graph({
    entity: 'sales_channel',
    fields: ['id', 'stock_locations.id'],
    filters: { id: channelId },
  })
  return (data?.[0]?.stock_locations ?? []).map((l) => l.id)
}
