/**
 * src/lib/flags.ts
 *
 * Backend (Medusa) half of the platform feature-flag / kill-switch seam — the ENFORCEMENT half: the
 * frontend hides a killed rail in the UI, but agents/UCP and stale in-flight checkout pages hit the
 * backend directly, so the real kill must live here (checkout-options catalog + start-checkout
 * guard).
 *
 * ONE authority: Golden Frijoles, project `miyagisanchez` — the same project and console as the
 * frontend, so a single change in Golden governs BOTH apps (flag-provider-mandate). The
 * `local`/`shadow` modes, the `GOLDEN_BEANS_FLAG_CUTOVER` manifest and the `platform_flags` read
 * are deleted: the manifest parser resolved any malformed OR unset value to `local`, so one env-var
 * typo silently moved every commerce decision back onto a second store. `platform_flags` is parked,
 * unread, for one wave as the rollback.
 *
 * The chain: live snapshot → durable mirror (the OUTAGE fallback) → compile default. `isEnabled()`
 * never throws.
 */
import {
  BACKEND_FLAG_DEFAULTS,
  type FlagKey,
} from './flag-catalog'
import { evaluateGoldenBooleanFlag } from './golden-flag-provider'
import { evaluateDurableGoldenBooleanFlag } from './golden-flag-mirror'
import { getDurableGoldenSnapshot } from './golden-flag-mirror-store'
import {
  createFlagDecisionObserver,
  type FlagDecisionSource,
} from './flag-decision-observation'

export type { FlagKey } from './flag-catalog'

/**
/**
 * The compile-time defaults — the LAST rung, used only when neither the live Golden snapshot nor
 * the durable mirror can answer. Three polarities live here — all fail SAFE, to the value that
 * can't cause harm on an outage:
 *  - KILL-SWITCH (`checkout.stripe_enabled`): default `true`. The feature keeps
 *    working if the read is down (disabling is the deliberate action).
 *  - ENABLEMENT (`shipping.envia_enabled`): default `false`. The Envia.com
 *    integration stays OFF if Supabase is unreachable — so a flag outage can never
 *    push checkout/fulfillment at an unfunded carrier; OFF ⇒ arranged-delivery /
 *    manual-carrier fallback. Enabling is the deliberate action (flip ON the instant
 *    the platform Envía account is funded).
 *  - KILL-SWITCH, FAIL-CLOSED (`ml.sync_enabled`): default `false`. This is a
 *    kill-switch by function (flip OFF to instantly halt the two-way ML stock
 *    sync) but deliberately defaults to `false` — UNLIKE the usual kill-switch
 *    default-`true`. The blast radius of sync running unsupervised (overselling
 *    on ML or in Miyagi) is worse than the feature being off, so a read outage
 *    must HALT sync, not run it uncontrolled. Enabling is the deliberate
 *    action, and a per-seller enable (on the ML connection) must ALSO be on.
 *  - ENABLEMENT (`ml.orders_enabled`): default `false` (ml-orders-native epic,
 *    Sprint 1). Materializing a paid ML sale as a real Medusa order is new write
 *    surface on the same critical path as the stock sync above — a flag-read
 *    outage must not start creating orders unsupervised, so this fails to the
 *    "today's behavior exactly" side (stock sync only, no order) like
 *    `ml.sync_enabled`, not to the usual kill-switch default-`true`. Sprint 1
 *    gated this GLOBAL flag only; Sprint 2 · US-6 additionally gates on the
 *    per-seller `ml_sync` entitlement below.
 *  - ENABLEMENT (`ops.profit_enabled`): default `false` (profit-analyzer epic,
 *    Sprint 1). Gates the financial-events ledger writes + the seller profit
 *    read API — the whole surface ships dark and a flag-read outage must not
 *    start writing ledger rows unsupervised. The ledger is append-only, so
 *    rows written while ON are never mutated by a later OFF; the backfill
 *    route heals any gap when it comes back ON.
 *  - ENABLEMENT (`ml.sync_paywall_enabled`): default `false`, mirrors the
 *    frontend's own key of the same name (`lib/flags.ts`) — the paid/promoter-SKU
 *    entitlement gate for ML sync/orders (epic 03 · mercadolibre-sync Sprint 5;
 *    reused here for order materialization, ml-orders-native S2 · US-6). A
 *    flag-read outage must not silently ungate a paid feature, so this fails to
 *    "paywall off" (today's — pre-paywall — behavior), not to "everyone entitled."
 *  - ENABLEMENT (`ml.publish_enabled`): default `false`, mirrors the frontend's
 *    own key of the same name (mercadolibre-sync epic Sprint 3) — until now
 *    only ever checked on the FRONTEND before it called the internal publish
 *    route. Apply-price (profit-analyzer S2 · US-5) checks it directly on the
 *    backend too, since it calls `publishOrSyncProduct` in-process rather
 *    than through that frontend-gated route — a flag-read outage must not
 *    silently push a price to Mercado Libre, so this fails to "publish rail
 *    off" (no ML write), never to "always push."
 *  - ENABLEMENT (`catalog.inventory_channels_enabled`): default `false`
 *    (catalog-management epic, Sprint 2). Gates the whole S2 mutation surface:
 *    the sin-límite/sobre-pedido inventory-mode write (`unlimited`/`backorder`
 *    values only — `tracked` is always allowed, it's today's behavior), the
 *    buyer-facing backorder-unblocks-the-buy-box behavior, the
 *    `miyagi_visible` marketplace-browse filter + its toggle write, the
 *    per-product `ml_enabled` toggle write, and the `ml_price_cents`
 *    override write. Reading any of the new fields (`allow_backorder`,
 *    `reserved_quantity`, `dispatch_estimate`, channel badges) is NEVER
 *    gated — only mutating/acting on them is. A flag-read outage must not
 *    silently unlock an unreviewed backorder-purchase path or an unreviewed
 *    ML mass-unpublish/republish surface, so this fails to "today's exact
 *    behavior" (tracked-only inventory, coupled ML publish state, no price
 *    override). Flip ON only after Daniel's live money-path smoke (buy a
 *    sin-límite + a sobre-pedido product end-to-end) and an ML toggle
 *    round-trip on a real ML test listing both pass.
 *  - ENABLEMENT (`checkout.rental_pricing_enabled`): default `false`
 *    (rental-backend-line-item-pricing epic, Sprint 1). Gates the start-checkout
 *    rental branch that charges a server-recomputed nights × rate + deposit total.
 *    A flag-read outage must never let a rental charge a computed multi-night total
 *    unsupervised, so it fails to OFF ⇒ the request 422s and the buyer is routed to
 *    today's coordination flow (AskSeller). Enabling is the deliberate action.
 *  - KILL-SWITCH, FAIL-CLOSED (`catalog.bulk_enabled`): default `false`
 *    (catalog-management epic, Sprint 3). Gates `bulk-stage`/`bulk-apply` and
 *    the MCP `stage_bulk_action`/`apply_bulk_action` tools — a bulk action can
 *    mutate hundreds of products in one call, so this follows `ml.sync_enabled`'s
 *    fail-CLOSED shape (not the usual kill-switch default-`true`): the blast
 *    radius of bulk mutations running unsupervised (a bad staged batch applying
 *    itself, or an agent bulk-editing without the flag having been deliberately
 *    flipped) is worse than the feature being off. Enabling is the deliberate
 *    action, done only after Daniel's live smoke (50+ product bulk price change
 *    incl. one deliberately invalid row, idempotent re-apply, MCP agent flow).
 *  - ENABLEMENT (`shipping.correos_enabled`): default `false`
 *    (shipping-provider-expansion epic, Sprint 3). Gates the Correos de México
 *    Impresos manual-economy rate at checkout (`envia/rates` + `checkout-options`
 *    routes) — independent of `shipping.envia_enabled`/the Envía comp-grant (a
 *    different provider, no funding gate, no grant). A flag-read outage must not
 *    surface an unreviewed manual-economy rate at checkout, so this fails to OFF
 *    (the option never appears, on web or via agents). Enabling is the
 *    deliberate action, and additionally requires the seller's own per-shop
 *    opt-in (`seller.metadata.settings.shipping.correos_enabled`) — see
 *    `lib/correos-gate.ts`.
 *  - ENABLEMENT (`shipping.arranged_only_enabled`): default `false`
 *    (arranged-only-delivery epic, Sprint 1). Gates the per-listing
 *    `delivery_mode: 'arranged'` branch in `checkout-options` (pushes a `coord`
 *    delivery method, suppresses carrier `shipping`, sets `only_coordinated`)
 *    and the seller-facing "Entrega" toggle that writes `delivery_mode` to
 *    product metadata. A flag-read outage must not silently strip carrier
 *    shipping / card payment from a listing that happens to carry
 *    `delivery_mode: 'arranged'` metadata — this fails to OFF, i.e. today's
 *    carrier-required behavior, never to arranged. Enabling is the deliberate
 *    action, done only after Daniel's live money-path smoke (placing a real
 *    arranged order via pago directo).
 */
const DEFAULT_FLAGS = BACKEND_FLAG_DEFAULTS

// One PII-free record per flag/snapshot/source per process. A `source` other than `golden` in
// production means Golden is NOT deciding — from ~2026-08-27 to 2026-09-22 the read key had expired
// (401) and every decision came from the mirror while the console looked healthy. Sentry's
// production build strips console debug logging, so this writes to stdout directly.
const recordDecision = createFlagDecisionObserver((observation) => {
  try {
    const line = `[golden-beans:flag-decision] ${JSON.stringify(observation)}`
    if (typeof process !== 'undefined' && typeof process.stdout?.write === 'function') {
      process.stdout.write(`${line}\n`)
      return
    }
    console.info(line)
  } catch {
    // Decision evidence must never affect a feature decision.
  }
})

function report(
  flag: FlagKey,
  source: FlagDecisionSource,
  evaluation?: { snapshotVersion: number; flagVersion?: number; reason: string },
): void {
  try {
    recordDecision({
      flagKey: flag,
      source,
      snapshotVersion: evaluation?.snapshotVersion,
      flagVersion: evaluation?.flagVersion,
      reason: evaluation?.reason,
    })
  } catch {
    // Operational reporting is never part of the decision.
  }
}

/**
 * Is a feature enabled? Never throws. Live Golden snapshot first; on a miss (outage, expired key,
 * cold instance) the durable mirror; the compile-time default only when both are empty.
 */
export async function isEnabled(flag: FlagKey): Promise<boolean> {
  const defaultValue = DEFAULT_FLAGS[flag]
  try {
    const golden = evaluateGoldenBooleanFlag(flag, defaultValue)
    if (golden) {
      report(flag, 'golden', golden)
      return golden.value
    }
  } catch {
    // The provider adapter must never break a request; fall to the mirror.
  }
  try {
    const durableSnapshot = await getDurableGoldenSnapshot()
    if (durableSnapshot) {
      const durable = evaluateDurableGoldenBooleanFlag(durableSnapshot, flag, defaultValue)
      report(flag, 'durable', durable)
      return durable.value
    }
  } catch {
    // A mirror failure falls to the compile default.
  }
  report(flag, 'default')
  return defaultValue
}
