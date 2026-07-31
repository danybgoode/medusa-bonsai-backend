/**
 * GET /store/checkout-admission/:id?market=mx
 *
 * The CHECKOUT admission seam (owned-shop-operating-channel epic, D7 · S2.3). It
 * answers exactly one question: *is this product a member of this market's OPERATING
 * channel, and therefore buyable?* The rules, the three fail-closed states and the
 * reasoning all live in `../../_utils/checkout-admission.ts` — read that header
 * before changing anything here. This file is only the I/O shell.
 *
 * ── WHO CALLS IT ───────────────────────────────────────────────────────────────
 * The storefront's `lib/cart.ts` → `resolveCheckoutLines`, in place of
 * `GET /store/listings/:id?market=mx`, when `catalog.owned_shop_only_enabled` is ON.
 * `GET /store/listings/:id` is UNTOUCHED and still means marketplace-publication
 * truth (epic E3).
 *
 * ── RESPONSE (200) ─────────────────────────────────────────────────────────────
 *   {
 *     "market_code": "mx",              // the market echo the storefront confirms
 *     "admitted": true,
 *     "owned_shop_only_enabled": true,  // which rule actually ran
 *     "product": {
 *       "id": "prod_…",
 *       "medusa_product_id": "prod_…",  // same value; see below
 *       "status": "published",
 *       "in_operating_channel": true,
 *       "in_marketplace_channel": false
 *     }
 *   }
 *
 * `medusa_product_id` duplicates `id` because the caller's admission proof compares
 * BOTH against the id it asked about — the productId/variantId divergence lesson in
 * `resolveCheckoutLines`' own comments is why the proof checks two fields rather than
 * trusting one. Keeping the pair here means the storefront's predicate stays the same
 * shape when it swaps endpoints.
 *
 * Every product-level refusal is one indistinguishable **404 `{"message":"Listing not
 * found"}`** — the same body and the same reasoning as `/store/listings/:id`: a
 * checkout gate is not entitled to tell a caller which of its rules it tripped, and a
 * refusal that named the rule would turn this into a catalog-enumeration oracle.
 * Market-level refusals return the structured `unavailable` body (400 / 404 / 503).
 *
 * ── IS THIS AN IDOR? NO — AND HERE IS THE ARGUMENT ─────────────────────────────
 * The route takes a caller-supplied product id, so the check must be per-object, and
 * it is: publish state, hidden-product state, OPERATING-channel membership and the
 * OWNING SELLER's market are all proven against the row itself, never against
 * anything the caller asserted. What a successful answer reveals — "this product is
 * buyable in mx" — is precisely what `GET /store/products/:id` already reveals under
 * the same publishable key once the key resolves through the operating channel (D3).
 * It is not new information; it is the same information with the rule stated. Nothing
 * seller-private is read out: the owning seller's row is consulted ONLY for
 * `metadata.operating_market`, through `readSellerOperatingMarket`, and never echoed.
 *
 * ── THE FLAG IS NOT THE AUTHORIZATION (AGENTS rule 5) ──────────────────────────
 * `catalog.owned_shop_only_enabled` decides WHICH RULE runs (operating-only, or
 * operating AND marketplace as today). Both rules are per-object authorization
 * checks. Flags fail OPEN to `DEFAULT_FLAGS`, and this one is an ENABLEMENT
 * defaulting to `false`, so a flag-store outage lands on the STRICTER rule.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { isEnabled } from '../../../../lib/flags'
import { readSellerOperatingMarket } from '../../../../lib/seller-market'
import type { MarketCode } from '../../../../lib/markets'
import {
  ADMISSION_NOT_FOUND_MESSAGE,
  CHECKOUT_ADMISSION_FIELDS,
  decideCheckoutAdmission,
  resolveCheckoutAdmissionGate,
  type AdmissionProductRow,
} from '../../_utils/checkout-admission'

/**
 * The owning seller's operating market, or `null` when it cannot be resolved.
 *
 * Uses the product→seller edge of the `seller ↔ product` module link directly
 * (`src/links/seller-product.ts`) — the same read `profit-ledger-write.ts` runs in
 * production. The alternative, looping every seller and asking for its product ids
 * (what `/store/listings/:id` does), is N graph queries per checkout line on the
 * money path; this is one.
 *
 * A THROWN error resolves to `null`, i.e. REFUSED. That is deliberate: "the ownership
 * read failed" and "this product has no owner" must both fail closed here, and the
 * caller cannot tell them apart anyway.
 */
async function ownerMarketFor(
  query: { graph: (args: any) => Promise<any> },
  productId: string,
): Promise<MarketCode | null> {
  try {
    const { data } = await query.graph({
      entity: 'product',
      // `seller.metadata` is read ONLY by `readSellerOperatingMarket` below and is
      // never echoed — the bag also carries Stripe Connect ids and payout config.
      fields: ['id', 'seller.id', 'seller.metadata'],
      filters: { id: productId },
    })
    const seller = (data?.[0] as { seller?: unknown } | undefined)?.seller
    if (!seller) return null
    return readSellerOperatingMarket(seller).market
  } catch {
    return null
  }
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const { id } = req.params

  const gate = resolveCheckoutAdmissionGate(
    (req.query as Record<string, string>)?.market,
    process.env,
  )
  if (!gate.ok) {
    return res.status(gate.status).json(gate.body)
  }

  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)

  let product: AdmissionProductRow | null = null
  try {
    const { data } = await query.graph({
      entity: 'product',
      fields: [...CHECKOUT_ADMISSION_FIELDS],
      filters: { id },
    })
    product = ((data ?? [])[0] as AdmissionProductRow | undefined) ?? null
  } catch {
    // A read failure on a money path is an outage, not a refusal — 503 so the caller
    // retries rather than telling a buyer their product does not exist.
    return res.status(503).json({
      unavailable: true,
      market_code: gate.market,
      reason: 'admission_read_failed',
      message: 'No se pudo verificar el producto. Intenta de nuevo.',
    })
  }

  const ownedShopOnly = await isEnabled('catalog.owned_shop_only_enabled')
  const ownerMarket = product ? await ownerMarketFor(query, id) : null

  const decision = decideCheckoutAdmission({
    requested_product_id: id,
    product,
    operating_channel_id: gate.operating_channel_id,
    marketplace_channel_id: gate.marketplace_channel_id,
    owner_market: ownerMarket,
    market: gate.market,
    owned_shop_only_enabled: ownedShopOnly,
  })

  if (!decision.admitted) {
    // Uniform, on purpose — see the header.
    return res.status(404).json({ message: ADMISSION_NOT_FOUND_MESSAGE })
  }

  return res.json({
    market_code: gate.market,
    admitted: true,
    owned_shop_only_enabled: ownedShopOnly,
    product: {
      id: decision.product_id,
      medusa_product_id: decision.product_id,
      status: 'published',
      in_operating_channel: decision.in_operating_channel,
      in_marketplace_channel: decision.in_marketplace_channel,
    },
  })
}
