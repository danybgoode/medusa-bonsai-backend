/**
 * Print-proof restatement — custom-print-products epic, Sprint 4 · Story 4.1.
 *
 * Pure derivation of the size/quantity/price a proof restates, straight from
 * the order's own first line item. Deliberately the ONLY place this
 * computation happens: the seller-facing route calls this instead of reading
 * anything from the request body, so a seller can never send a proof that
 * understates/overstates what the buyer actually ordered (the
 * StickerJunkie-pitfall guard).
 */

export interface ProofRestatementItem {
  variant_title?: string | null
  subtitle?: string | null
  product_title?: string | null
  title?: string | null
  quantity?: number | null
  unit_price?: number | null
}

export interface ProofRestatement {
  size: string
  quantity: number
  priceCents: number
}

export function deriveProofRestatement(item: ProofRestatementItem): ProofRestatement {
  const size = item.variant_title ?? item.subtitle ?? item.product_title ?? item.title ?? ''
  const quantity = Number(item.quantity) || 1
  const unitPriceCents = Math.round(Number(item.unit_price) || 0)
  return { size, quantity, priceCents: unitPriceCents * quantity }
}
