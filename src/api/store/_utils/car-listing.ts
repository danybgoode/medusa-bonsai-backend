/**
 * Autos facet accessors — the ONE place `/store/listings` reads a car's
 * marca / modelo / año / km / transmisión / combustible, reconciling the two
 * product-metadata namespaces that had drifted apart (cars-vertical S1.1):
 *
 *  - `metadata.attrs.*` — the AUTHORITATIVE specs the seller capture form writes
 *    (`make` / `model` / `year` / `km` / `fuel_type` / `transmission`). Every
 *    real seller-listed car lives here.
 *  - `metadata.*` (top-level) — the legacy filter keys only the seed / bulk-import
 *    pipeline writes (`brand` / `year` / `km` / `transmission` / `fuel`).
 *
 * Before this, the route filtered ONLY the top-level keys, so real
 * seller-captured cars (which populate `attrs.*`, never the top-level keys) were
 * effectively unfilterable. Each accessor reads `attrs` first and falls back to
 * the top-level key, so BOTH populations filter correctly. Note the one key that
 * differs across namespaces: attrs uses `fuel_type`, the legacy key is `fuel`.
 *
 * Pure — no DB, no remoteQuery; unit-tested (`__tests__/car-listing.unit.spec.ts`).
 */

export interface CarListingLike {
  /** Structured specs bag (toListingShape exposes this as a top-level field). */
  attrs?: Record<string, unknown> | null
  /** Full product metadata (also carries `metadata.attrs` as a fallback source). */
  metadata?: Record<string, unknown> | null
  price_cents?: number | null
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

/** Numeric spec (año / km) → a finite number, or null when absent/non-numeric. */
function num(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10)
  return Number.isFinite(n) ? n : null
}

function attrsOf(l: CarListingLike): Record<string, unknown> {
  return (l.attrs ?? (l.metadata?.attrs as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>
}

export function carMake(l: CarListingLike): string {
  return str(attrsOf(l).make) || str(l.metadata?.brand)
}

// ── Brand canonicalization (cars-vertical S1.1) ───────────────────────────────
// MIRROR of the frontend lib/car-brands.ts — keep the alias keys in sync across
// repos (same pattern as isPrintPlacementListing / isFeaturedPin mirrors). The
// filter is the source of truth: the facet rail merges e.g. "VW" and
// "Volkswagen" into one option, so the `brand` filter must match that whole
// group for the option's count to stay honest. Only ABBREVIATION aliases need a
// map entry — everything else canonicalizes to its own accent-stripped, lowercased
// form (which a case-insensitive match already unifies).
const BRAND_ALIAS_TO_KEY: Record<string, string> = {
  vw: 'volkswagen',
  chevy: 'chevrolet',
  mercedes: 'mercedes-benz',
  'mercedes benz': 'mercedes-benz',
  mercedesbenz: 'mercedes-benz',
  'general motors': 'gmc',
  'great wall': 'gwm',
  'land rover': 'land rover',
}

function normalizeBrand(input: string): string {
  return input.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ')
}

/** Stable comparison key for a brand — merges abbreviations + casing/accents. */
export function canonicalBrandKey(input: unknown): string {
  const k = normalizeBrand(str(input))
  if (!k) return ''
  return BRAND_ALIAS_TO_KEY[k] ?? k
}

export function carModel(l: CarListingLike): string {
  // No legacy top-level equivalent — modelo only ever lived in attrs.
  return str(attrsOf(l).model)
}

export function carYear(l: CarListingLike): number | null {
  return num(attrsOf(l).year) ?? num(l.metadata?.year)
}

export function carKm(l: CarListingLike): number | null {
  return num(attrsOf(l).km) ?? num(l.metadata?.km)
}

export function carTransmission(l: CarListingLike): string {
  return str(attrsOf(l).transmission) || str(l.metadata?.transmission)
}

export function carFuel(l: CarListingLike): string {
  return str(attrsOf(l).fuel_type) || str(l.metadata?.fuel)
}

// ── Filter predicates (parity with the route's inline checks) ─────────────────
// Each returns true when the listing satisfies the given bound. A missing numeric
// spec (year/km unknown) is EXCLUDED from a bounded search — we can't confirm it
// matches — rather than silently passing as it did under the old default-value
// scheme.

export function matchesBrand(l: CarListingLike, brand: string): boolean {
  const reqKey = canonicalBrandKey(brand)
  const makeKey = canonicalBrandKey(carMake(l))
  // Exact canonical-group match (what a facet click sends) keeps the option's
  // count honest — "Volkswagen" catches both "Volkswagen" and "VW".
  if (reqKey && makeKey && reqKey === makeKey) return true
  // Substring fallback for free-text partial typing ("volk") + unknown brands.
  return carMake(l).toLowerCase().includes(brand.toLowerCase())
}

export function matchesModel(l: CarListingLike, model: string): boolean {
  return carModel(l).toLowerCase().includes(model.toLowerCase())
}

export function matchesYearFrom(l: CarListingLike, from: number): boolean {
  const y = carYear(l)
  return y != null && y >= from
}

export function matchesYearTo(l: CarListingLike, to: number): boolean {
  const y = carYear(l)
  return y != null && y <= to
}

export function matchesKmFrom(l: CarListingLike, from: number): boolean {
  const k = carKm(l)
  return k != null && k >= from
}

export function matchesKmTo(l: CarListingLike, to: number): boolean {
  const k = carKm(l)
  return k != null && k <= to
}

// ── Facet pool (cars-vertical S1.1) ───────────────────────────────────────────
// A compact per-car projection over the full visibility-filtered autos set,
// returned when `?category=autos&facets=1`. The frontend's pure `deriveCarFacets`
// turns this pool into the facet rail (marca/modelo options + counts, año/precio/km
// ranges). Kept minimal so the payload is tiny even for a large catalog.

export interface CarFacetPoolEntry {
  make: string
  model: string
  year: number | null
  km: number | null
  price_cents: number | null
}

export function toCarFacetPoolEntry(l: CarListingLike): CarFacetPoolEntry {
  return {
    make: carMake(l),
    model: carModel(l),
    year: carYear(l),
    km: carKm(l),
    price_cents: l.price_cents ?? null,
  }
}
