/**
 * Project a Stripe Accounts v2 account into the seller `settings.stripe` fields that
 * `resolveStripeReadiness` reads. This is the missing link in the US money path:
 * without it nothing ever populates `api_generation`, `account_country`,
 * `merchant_configuration`, `card_payments_status` or `blocking_requirements`, and
 * every US seller stays permanently un-ready.
 *
 * SHAPES ARE MEASURED, NOT GUESSED (2026-08-11, live test-mode accounts). This module
 * exists because an earlier readiness gate asserted a `payouts_status` field the API
 * never returns for this account shape — the fixtures agreed with the code about a
 * world that did not exist, and every test passed. Anything read here was observed on
 * a real response:
 *
 *   identity.country                                        → "US"
 *   configuration.merchant.capabilities.card_payments.status → "active"
 *   requirements.entries[].description                       → "configuration.merchant.mcc"
 *   requirements.entries[].reference                         → null  (so it is NOT the id)
 *   requirements.entries[].awaiting_action_from              → "user"
 *   requirements.entries[].impact.restricts_capabilities[]   → [{ capability: "card_payments" },
 *                                                               { capability: "stripe_balance.payouts" }]
 *
 * Pure: no Stripe client, no I/O. The caller fetches, this decides.
 */

export interface SellerStripeProjection {
  readonly account_id: string
  readonly api_generation: 'v2'
  readonly account_country: string
  readonly merchant_configuration: 'active' | 'absent'
  readonly card_payments_status: string | null
  readonly blocking_requirements: string[]
  /** Everything still owed, including items that do not block card payments. */
  readonly outstanding_requirements: string[]
}

/** The capability that actually gates taking a charge. */
export const CHARGE_CAPABILITY = 'card_payments'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Requirement entries that restrict the charge capability, identified by
 * `description` — the only stable identifier on the entry, since `reference` is null.
 *
 * An entry restricting only `stripe_balance.payouts` is deliberately NOT blocking:
 * payouts are the connected account's own concern in this model, and treating them
 * as blocking would reintroduce the unsatisfiable gate this module was built after.
 */
export function blockingRequirementsFor(account: unknown, capability: string = CHARGE_CAPABILITY): string[] {
  const entries = asArray(asRecord(asRecord(account).requirements).entries)
  const blocking: string[] = []
  for (const raw of entries) {
    const entry = asRecord(raw)
    const restricts = asArray(asRecord(entry.impact).restricts_capabilities)
    const hitsCapability = restricts.some((r) => asRecord(r).capability === capability)
    if (!hitsCapability) continue
    const id = typeof entry.description === 'string' && entry.description ? entry.description : 'unknown_requirement'
    if (!blocking.includes(id)) blocking.push(id)
  }
  return blocking
}

/** Every outstanding entry, blocking or not — useful for honest seller-facing copy. */
export function outstandingRequirementsFor(account: unknown): string[] {
  return asArray(asRecord(asRecord(account).requirements).entries)
    .map((raw) => asRecord(raw).description)
    .filter((d): d is string => typeof d === 'string' && d.length > 0)
    .filter((d, i, all) => all.indexOf(d) === i)
}

export function projectStripeV2Account(account: unknown): SellerStripeProjection | null {
  const root = asRecord(account)
  const id = typeof root.id === 'string' && root.id ? root.id : null
  if (!id) return null

  const country = asRecord(root.identity).country
  const merchant = asRecord(root.configuration).merchant
  // `configuration.merchant` present at all is what "has a merchant configuration"
  // means; its capabilities are graded separately below.
  const hasMerchant = Object.prototype.hasOwnProperty.call(asRecord(root.configuration), 'merchant')
  const cardPayments = asRecord(asRecord(merchant).capabilities)[CHARGE_CAPABILITY]
  const cardStatus = asRecord(cardPayments).status

  return Object.freeze({
    account_id: id,
    api_generation: 'v2' as const,
    // Lowercased because readiness compares against a lowercase market country;
    // the API returns "US" and the registry stores "us".
    account_country: typeof country === 'string' ? country.toLowerCase() : '',
    merchant_configuration: hasMerchant ? 'active' : 'absent',
    card_payments_status: typeof cardStatus === 'string' ? cardStatus : null,
    blocking_requirements: blockingRequirementsFor(account),
    outstanding_requirements: outstandingRequirementsFor(account),
  })
}
