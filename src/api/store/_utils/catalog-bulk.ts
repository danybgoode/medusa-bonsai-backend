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
  | { type: 'category'; category_id: string; category_label: string }
  | { type: 'collection_assign'; collection_ids: string[]; collection_labels: string[] }
  | { type: 'inventory_mode'; mode: 'tracked' | 'unlimited' | 'backorder'; dispatch_estimate?: string | null }
  | { type: 'delete' }

export interface BulkDiffItem {
  id: string
  title: string
  before: Record<string, unknown>
  after: Record<string, unknown>
  patch: SellerProductUpdateBody | null
  valid: boolean
  error: string | null
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
      if (nextCents <= 0) {
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
        patch: { category_id: action.category_id },
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
