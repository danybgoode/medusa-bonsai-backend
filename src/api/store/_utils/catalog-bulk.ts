/**
 * Staged bulk-action core — catalog-management epic, Sprint 3 · Story 3.1.
 *
 * Pure diff computation: given a resolved product (`CatalogPair` from
 * `seller-catalog-query.ts`) and a `BulkActionPayload`, produces the
 * `SellerProductUpdateBody` patch to send to `updateSellerProduct()`, plus a
 * human-readable before/after pair for the diff-preview UI — or a validation
 * error if the action can't apply to this product. No I/O here — the
 * bulk-stage route calls this per resolved product; the bulk-apply route
 * (also I/O) sends the already-computed patch straight to
 * `updateSellerProduct()`.
 *
 * Action set grows across Sprint 3: 3.1 wires `price_set`/`price_pct`/
 * `pause_activate` (enough to prove the stage→preview→apply pipeline end to
 * end); 3.2 adds `publish_channel`/`category`/`collection_assign`/
 * `inventory_mode`/`delete`.
 */
import type { SellerProductUpdateBody } from './seller-product-update'
import type { CatalogPair } from './seller-catalog-query'

/** A batch can target at most this many products — matches the epic's own
 * stated scale (500-title bookshops, 60-car lots) with headroom; larger
 * catalogs need a follow-up async design, out of scope for v1. */
export const MAX_BULK_ITEMS = 1000

export type BulkActionPayload =
  | { type: 'price_set'; price_cents: number }
  | { type: 'price_pct'; percent: number } // e.g. 10 = +10%, -10 = -10%
  | { type: 'pause_activate'; status: 'active' | 'paused' }
  | { type: 'publish_channel'; channel: 'miyagi' | 'ml'; enabled: boolean }
  | { type: 'category'; category_handle: string; category_label: string }
  | { type: 'collection_assign'; collection_ids: string[]; collection_labels: string[] }
  | { type: 'inventory_mode'; mode: 'tracked' | 'unlimited' | 'backorder'; dispatch_estimate?: string | null }
  | { type: 'delete' }
  // catalog-management S4 · Story 4.2. Unlike every other action type, the
  // target price is NOT re-derived here — it's computed ONCE, frontend-side,
  // via lib/profit.ts's solveForPrice() (the same seam the profit dashboard's
  // PricingCard already uses for the single-item Apply control), from that
  // page's own already-fetched ledger + a live ML fee-estimate call. This
  // route intentionally does NOT re-implement solveForPrice — doing so here
  // would be exactly the "forked formula" the sprint's acceptance forbids.
  // Each `items[]` entry is one seller-approved suggested price; this diff
  // step only validates + previews it (variant count, ownership, sanity),
  // mirroring how /store/sellers/me/profit/apply-price ALREADY trusts a
  // caller-computed `new_price_cents` with no server-side re-derivation.
  | { type: 'apply_suggested_price'; target_margin_pct: number; items: Array<{ id: string; price_cents: number }> }

export interface BulkDiffItem {
  id: string
  title: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  patch: SellerProductUpdateBody | null
  valid: boolean
  error: string | null
  /** Only set for `apply_suggested_price` (S4 · 4.2) — new minus old Miyagi
   * price, for the confirm dialog's total. Null for every other action type. */
  delta_cents?: number | null
}

function centsToDisplay(cents: number | null): string {
  if (cents === null) return 'Precio a convenir'
  return `$${(cents / 100).toFixed(2)}`
}

/**
 * Compute the diff for one product + one action. Never throws — an
 * inapplicable/invalid combination returns `valid: false` with an es-MX
 * `error` message, matching the eBay-pitfall design goal (every row
 * individually validated, never a silent skip).
 */
export function computeBulkDiff(pair: CatalogPair, action: BulkActionPayload): BulkDiffItem {
  const { listing } = pair
  const base = { id: listing.id, title: listing.title }

  switch (action.type) {
    case 'price_set': {
      if (!Number.isInteger(action.price_cents) || action.price_cents <= 0) {
        return {
          ...base,
          before: { price_cents: listing.price_cents },
          after: {},
          patch: null,
          valid: false,
          error: 'El precio debe ser mayor a $0.',
        }
      }
      return {
        ...base,
        before: { price: centsToDisplay(listing.price_cents) },
        after: { price: centsToDisplay(action.price_cents) },
        patch: { price_cents: action.price_cents },
        valid: true,
        error: null,
      }
    }
    case 'price_pct': {
      // Defense in depth: a malformed/non-numeric `percent` (e.g. sent
      // directly to bulk-stage, bypassing the frontend's own Number.isFinite
      // check) must never produce a NaN patch — NaN fails every `<= 0`
      // comparison (always false), so a naive floor check alone would let it
      // through and `updateSellerProduct` has no NaN guard of its own on
      // `price_cents` (cross-agent review catch).
      if (!Number.isFinite(action.percent) || action.percent === 0) {
        return {
          ...base,
          before: { price_cents: listing.price_cents },
          after: {},
          patch: null,
          valid: false,
          error: 'Porcentaje inválido.',
        }
      }
      if (listing.price_cents === null) {
        return {
          ...base,
          before: { price: 'Precio a convenir' },
          after: {},
          patch: null,
          valid: false,
          error: 'Este producto no tiene precio fijo — no se puede aplicar un cambio porcentual.',
        }
      }
      const nextCents = Math.round(listing.price_cents * (1 + action.percent / 100))
      if (!Number.isFinite(nextCents) || nextCents <= 0) {
        return {
          ...base,
          before: { price: centsToDisplay(listing.price_cents) },
          after: {},
          patch: null,
          valid: false,
          error: 'El precio resultante debe ser mayor a $0.',
        }
      }
      return {
        ...base,
        before: { price: centsToDisplay(listing.price_cents) },
        after: { price: centsToDisplay(nextCents) },
        patch: { price_cents: nextCents },
        valid: true,
        error: null,
      }
    }
    case 'pause_activate': {
      const currentlyPaused = listing.status === 'paused'
      const targetPaused = action.status === 'paused'
      if (currentlyPaused === targetPaused) {
        return {
          ...base,
          before: { status: listing.status },
          after: { status: listing.status },
          patch: null,
          valid: false,
          error: targetPaused ? 'Ya está pausado.' : 'Ya está activo.',
        }
      }
      // Mirrors app/api/sell/listing/[id]/route.ts PATCH exactly: "paused" and a
      // never-published draft both land on Medusa's native status:'draft' —
      // metadata.paused is the only thing that tells them apart (toListingShape
      // reads it), so it MUST be set in the same patch that flips status, never
      // a separate call (this is the Sprint 1.3 pausado/borrador regression fix
      // — a bulk action bypassing it would silently reintroduce that bug).
      return {
        ...base,
        before: { status: listing.status },
        after: { status: action.status === 'paused' ? 'paused' : 'active' },
        patch: {
          status: action.status === 'paused' ? 'draft' : 'published',
          metadata: { paused: action.status === 'paused' },
        },
        valid: true,
        error: null,
      }
    }
    case 'publish_channel': {
      const currentlyOn = action.channel === 'ml' ? pair.mlLinked : (pair.raw.metadata as Record<string, unknown> | undefined)?.miyagi_visible !== false
      if (currentlyOn === action.enabled) {
        return {
          ...base,
          before: { [action.channel]: currentlyOn },
          after: { [action.channel]: currentlyOn },
          patch: null,
          valid: false,
          error: action.enabled ? 'Ya está publicado en este canal.' : 'Ya está oculto en este canal.',
        }
      }
      return {
        ...base,
        before: { [action.channel]: currentlyOn },
        after: { [action.channel]: action.enabled },
        patch: action.channel === 'miyagi' ? { miyagi_visible: action.enabled } : { ml_enabled: action.enabled },
        valid: true,
        error: null,
      }
    }
    case 'category': {
      return {
        ...base,
        before: { category: listing.category ?? '—' },
        after: { category: action.category_label },
        patch: { category_handle: action.category_handle },
        valid: true,
        error: null,
      }
    }
    case 'collection_assign': {
      return {
        ...base,
        before: { collections: listing.collections.length > 0 ? listing.collections.join(', ') : '—' },
        after: { collections: action.collection_labels.length > 0 ? action.collection_labels.join(', ') : '—' },
        patch: { collection_ids: action.collection_ids },
        valid: true,
        error: null,
      }
    }
    case 'inventory_mode': {
      const modeLabel = { tracked: 'Rastreado', unlimited: 'Sin límite', backorder: 'Sobre pedido' }
      const currentMode = !listing.manage_inventory ? 'unlimited' : listing.allow_backorder ? 'backorder' : 'tracked'
      if (currentMode === action.mode) {
        return {
          ...base,
          before: { modo: modeLabel[currentMode] },
          after: { modo: modeLabel[currentMode] },
          patch: null,
          valid: false,
          error: 'Ya está en este modo de inventario.',
        }
      }
      return {
        ...base,
        before: { modo: modeLabel[currentMode] },
        after: { modo: modeLabel[action.mode] },
        patch: {
          inventory_mode: action.mode,
          ...(action.mode === 'backorder' && { dispatch_estimate: action.dispatch_estimate ?? null }),
        },
        valid: true,
        error: null,
      }
    }
    case 'apply_suggested_price': {
      // Defense in depth (cross-agent review catch): `items` is required by
      // the TS type, but a malformed/adversarial request body isn't type-checked
      // at runtime — an absent/non-array `items` must produce a clean invalid
      // row per product, never an unhandled TypeError from `.find()`.
      if (!Array.isArray(action.items)) {
        return {
          ...base,
          before: { price: centsToDisplay(listing.price_cents) },
          after: {},
          patch: null,
          valid: false,
          error: 'Lote inválido — falta la lista de precios sugeridos.',
          delta_cents: null,
        }
      }
      const item = action.items.find((i) => i.id === listing.id)
      if (!item) {
        return {
          ...base,
          before: { price: centsToDisplay(listing.price_cents) },
          after: {},
          patch: null,
          valid: false,
          error: 'No se encontró un precio sugerido para este producto.',
          delta_cents: null,
        }
      }
      // Multi-variant products' price_cents is the MIN across variants
      // ("desde $X") — using it as "before," and writing a single price_cents
      // patch with no variant_id, would silently mis-price every OTHER
      // variant. Reject at stage time (visible in the preview) rather than
      // failing invisibly at apply time — updateSellerProduct already 422s a
      // multi-variant price patch with no variant_id, so this sharpens an
      // existing gap rather than adding a new restriction.
      const variants = (pair.raw?.variants ?? []) as Array<{ id: string }>
      if (variants.length !== 1) {
        return {
          ...base,
          before: { price: centsToDisplay(listing.price_cents) },
          after: {},
          patch: null,
          valid: false,
          error: 'Este producto tiene varias variantes — el precio sugerido no aplica a nivel producto.',
          delta_cents: null,
        }
      }
      if (!Number.isInteger(item.price_cents) || item.price_cents <= 0) {
        return {
          ...base,
          before: { price: centsToDisplay(listing.price_cents) },
          after: {},
          patch: null,
          valid: false,
          error: 'El precio sugerido no es válido.',
          delta_cents: null,
        }
      }
      const deltaCents = listing.price_cents != null ? item.price_cents - listing.price_cents : null
      return {
        ...base,
        before: { price: centsToDisplay(listing.price_cents) },
        after: { price: centsToDisplay(item.price_cents) },
        patch: { variant_id: variants[0].id, price_cents: item.price_cents },
        valid: true,
        error: null,
        delta_cents: deltaCents,
      }
    }
    case 'delete': {
      // No SellerProductUpdateBody patch — soft-delete has no field-patch
      // shape (`productService.softDeleteProducts`, a different call
      // entirely). `patch: null` here is a signal to the caller: this batch's
      // apply step must route through the delete path, not the generic
      // patch-apply one (see the Sprint 3 plan's frontend-orchestration note).
      return {
        ...base,
        before: { status: listing.status },
        after: { status: 'eliminado' },
        patch: null,
        valid: true,
        error: null,
      }
    }
    default:
      return {
        ...base,
        before: {},
        after: {},
        patch: null,
        valid: false,
        error: 'Acción no reconocida.',
      }
  }
}

/**
 * Guard for the generic `bulk-apply` routes (both the Clerk-authed store
 * route and the internal agent route) — rejects a patch shaped like one of
 * the THREE action types that need frontend-only orchestration
 * (`pause_activate`'s `metadata.paused` write, `publish_channel`'s
 * `ml_enabled` write, `delete`'s null patch) instead of silently applying
 * it. Without this, any direct caller of the generic apply endpoint
 * (bypassing the frontend's `lib/catalog-bulk.ts` routing that always sends
 * these three through `setListingStatus()`/`toggleMlChannel()`/
 * `deleteListing()` instead) could reintroduce exactly the bug those
 * extractions exist to prevent — a pause that never syncs the Supabase
 * mirror or closes the linked ML item, or an ML toggle that flips the
 * stored flag without ever calling Mercado Libre (cross-agent review catch).
 * Returns null when the patch is safe to apply generically.
 */
export function rejectOrchestrationOnlyPatch(patch: SellerProductUpdateBody | null): string | null {
  if (patch === null) {
    return 'Esta acción requiere el flujo de eliminación (delete) — no se puede aplicar como patch genérico.'
  }
  if (patch.ml_enabled !== undefined) {
    return 'El cambio de canal Mercado Libre requiere el flujo de publicación dedicado — no se puede aplicar como patch genérico.'
  }
  if (patch.metadata && typeof patch.metadata === 'object' && 'paused' in patch.metadata) {
    return 'Pausar/activar requiere el flujo de estado de anuncio dedicado — no se puede aplicar como patch genérico.'
  }
  // apply_suggested_price (S4 · 4.2) is the ONLY action type whose patch
  // carries both variant_id AND price_cents together — plain price_set/
  // price_pct never set variant_id. A patch shaped like this must route
  // through profit-analyzer's apply-price (Miyagi write + ML publish parity
  // + audit event), never the generic bulk-apply path, or a staged
  // suggested-price batch would silently Miyagi-only-apply and never push
  // to Mercado Libre — the exact acceptance this story exists to satisfy.
  if (patch.variant_id !== undefined && patch.price_cents !== undefined) {
    return 'El precio sugerido requiere el flujo de aplicación de precios (con Mercado Libre) — no se puede aplicar como patch genérico.'
  }
  return null
}
