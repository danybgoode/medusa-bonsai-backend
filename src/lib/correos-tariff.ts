/**
 * src/lib/correos-tariff.ts
 *
 * Shipping-provider-expansion · Sprint 3 · Story 3.1 — Correos de México, Impresos en
 * General tariff (depósitos individuales, nacional). Pure, no Medusa/DB imports, so it's
 * directly unit-testable and safe to import from a settings-page preview with no round trip.
 *
 * Source: `references/correos-de-mexico-impresos.pdf` (sheet titled "TARIFA POSTAL
 * 2026") — tracked in the monorepo-ROOT repo (product docs / research materials live
 * there, not in this app repo; see the root `Roadmap/WAYS-OF-WORKING.md` repo-structure
 * note), NOT inside `apps/backend`. Auditable at that path in a full monorepo checkout.
 * The Impresos band schedule's own printed vigencia is 24 de febrero de 2010 — it has
 * been stable since (the "2026" in the sheet title is the current in-force publication
 * year, not a rate change). Flat NATIONAL rate — no zones. IVA (16%) is already included
 * in each band's total. A tariff republication is a one-constant PR; spec-locked
 * band-by-band in `__tests__/correos-tariff.unit.spec.ts`.
 *
 * `maxGrams` is the inclusive upper edge of each "hasta" band (peso en gramos por pieza).
 */

export type CorreosTariffBand = {
  /** Inclusive upper edge, grams ("hasta X gramos"). */
  maxGrams: number
  /** IVA-inclusive total, in cents. */
  totalCents: number
}

export const CORREOS_IMPRESOS_VIGENCIA = '2010-02-24'

export const CORREOS_IMPRESOS_BANDS_2026: ReadonlyArray<CorreosTariffBand> = [
  { maxGrams: 20, totalCents: 600 },
  { maxGrams: 40, totalCents: 700 },
  { maxGrams: 60, totalCents: 800 },
  { maxGrams: 80, totalCents: 900 },
  { maxGrams: 100, totalCents: 950 },
  { maxGrams: 150, totalCents: 1050 },
  { maxGrams: 200, totalCents: 1150 },
  { maxGrams: 250, totalCents: 1350 },
  { maxGrams: 300, totalCents: 1450 },
  { maxGrams: 350, totalCents: 1550 },
  { maxGrams: 400, totalCents: 1700 },
  { maxGrams: 450, totalCents: 1800 },
  { maxGrams: 500, totalCents: 1850 },
  { maxGrams: 600, totalCents: 1900 },
  { maxGrams: 700, totalCents: 2000 },
  { maxGrams: 800, totalCents: 2050 },
  { maxGrams: 900, totalCents: 2150 },
  { maxGrams: 1000, totalCents: 2250 },
  { maxGrams: 1100, totalCents: 2300 },
  { maxGrams: 1200, totalCents: 2350 },
  { maxGrams: 1300, totalCents: 2400 },
  { maxGrams: 1400, totalCents: 2450 },
  { maxGrams: 1500, totalCents: 2500 },
  { maxGrams: 1600, totalCents: 2600 },
  { maxGrams: 1700, totalCents: 2650 },
  { maxGrams: 1800, totalCents: 2700 },
  { maxGrams: 1900, totalCents: 2800 },
  { maxGrams: 2000, totalCents: 2900 },
] as const

/** The heaviest weight the Impresos table prices — over this, there is no quote (v1). */
export const CORREOS_IMPRESOS_MAX_GRAMS = CORREOS_IMPRESOS_BANDS_2026[CORREOS_IMPRESOS_BANDS_2026.length - 1].maxGrams

export type CorreosQuote = {
  totalCents: number
  /** The matched band's upper edge, grams — informational (e.g. for UI copy). */
  maxGrams: number
}

/**
 * Quote the Impresos en General rate for a SINGLE PIECE of the given weight. Pure,
 * never throws. `null` when the weight is non-positive/non-finite or exceeds the
 * table's max band (2000 g) — the caller must never invent a price outside the
 * published table. The tariff is priced "por pieza" (per piece) — a multi-piece
 * shipment is NOT one combined weight; see `quoteCorreosForPieces` for that case.
 */
export function quoteCorreos(weightGrams: number): CorreosQuote | null {
  if (!Number.isFinite(weightGrams) || weightGrams <= 0) return null
  const band = CORREOS_IMPRESOS_BANDS_2026.find((b) => weightGrams <= b.maxGrams)
  return band ? { totalCents: band.totalCents, maxGrams: band.maxGrams } : null
}

/**
 * Quote a multi-piece shipment: each item is quoted SEPARATELY (the table is
 * "peso en gramos por pieza," not a combined-weight schedule — a cart summing all
 * items into one weight would either undercharge or wrongly reject an otherwise
 * eligible order once the sum crosses 2000 g). Sums the per-piece totals. `null`
 * if the list is empty, or if ANY single piece can't be quoted (over the 2000 g
 * max, or non-positive/non-finite) — Correos can't ship an assortment when one
 * piece in it is out of the table, so the whole quote fails rather than silently
 * dropping that piece's cost.
 */
export function quoteCorreosForPieces(weightsGrams: ReadonlyArray<number>): CorreosQuote | null {
  if (weightsGrams.length === 0) return null
  let totalCents = 0
  let maxGrams = 0
  for (const w of weightsGrams) {
    const quote = quoteCorreos(w)
    if (!quote) return null
    totalCents += quote.totalCents
    maxGrams = Math.max(maxGrams, quote.maxGrams)
  }
  return { totalCents, maxGrams }
}
