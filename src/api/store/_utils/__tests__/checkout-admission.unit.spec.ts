import {
  decideCheckoutAdmission,
  resolveCheckoutAdmissionGate,
  type AdmissionProductRow,
  type CheckoutAdmissionInput,
} from '../checkout-admission'

/**
 * S2.3 — the checkout admission boundary (D7). This is the anti-IDOR gate on the
 * money path, so every spec here is either "a thing that must be admitted" or "a
 * thing that must not be", and there is no third category.
 *
 * Pure over injected rows and an injected env — no container, no database.
 */

const MARKETPLACE = 'sc_01KSK1J0V81P4EPY9G0JAPX353'
const OPERATING = 'sc_01KYWNQ0C0PFFM0K0V2EMC24AP'
const PROD_ENV = {
  MEDUSA_SALES_CHANNEL_ID: MARKETPLACE,
  MEDUSA_MX_OPERATING_CHANNEL_ID: OPERATING,
}
const PRODUCT_ID = 'prod_01KYWOWNEDSHOPONLY'

function product(overrides: Partial<AdmissionProductRow> = {}): AdmissionProductRow {
  return {
    id: PRODUCT_ID,
    status: 'published',
    metadata: {},
    sales_channels: [{ id: OPERATING }],
    ...overrides,
  }
}

function decide(overrides: Partial<CheckoutAdmissionInput> = {}) {
  return decideCheckoutAdmission({
    requested_product_id: PRODUCT_ID,
    product: product(),
    operating_channel_id: OPERATING,
    marketplace_channel_id: MARKETPLACE,
    owner_market: 'mx',
    owner_status: 'active',
    market: 'mx',
    owned_shop_only_enabled: true,
    ...overrides,
  })
}

describe('resolveCheckoutAdmissionGate — three states, never two', () => {
  it('mx with both channels configured is OPEN and reports both ids', () => {
    const gate = resolveCheckoutAdmissionGate('mx', PROD_ENV)
    expect(gate).toEqual({
      ok: true,
      market: 'mx',
      operating_channel_id: OPERATING,
      marketplace_channel_id: MARKETPLACE,
    })
  })

  it('an absent market parameter defaults to mx — the pre-launch compatibility window', () => {
    expect(resolveCheckoutAdmissionGate(undefined, PROD_ENV).ok).toBe(true)
    expect(resolveCheckoutAdmissionGate('', PROD_ENV).ok).toBe(true)
  })

  it('UNKNOWN market ⇒ 400, and it is never silently answered as mx', () => {
    const gate = resolveCheckoutAdmissionGate('ca', PROD_ENV)
    expect(gate.ok).toBe(false)
    if (gate.ok) throw new Error('unreachable')
    expect(gate.status).toBe(400)
    expect(gate.body.reason).toBe('unknown_market')
    expect(JSON.stringify(gate)).not.toContain(OPERATING)
  })

  it('a LOCALE is refused with the registry\'s own loud hint', () => {
    const gate = resolveCheckoutAdmissionGate('es-MX', PROD_ENV)
    expect(gate.ok).toBe(false)
    if (gate.ok) throw new Error('unreachable')
    expect(gate.body.message).toMatch(/LOCALE/)
  })

  it('us ⇒ 503 CLOSED while its expected operating-channel env is unconfigured', () => {
    // S1 makes this an expected resource. Missing config is an operator outage,
    // distinct from structural absence and from invitation publication status.
    const gate = resolveCheckoutAdmissionGate('us', PROD_ENV)
    expect(gate.ok).toBe(false)
    if (gate.ok) throw new Error('unreachable')
    expect(gate.status).toBe(503)
    expect(gate.body.reason).toBe('operating_channel_unavailable')
    expect(gate.body.message).toMatch(/MEDUSA_US_OPERATING_CHANNEL_ID/)
    expect(JSON.stringify(gate)).not.toContain(OPERATING)
    expect(JSON.stringify(gate)).not.toContain(MARKETPLACE)
  })

  it('mx with the operating channel UNCONFIGURED ⇒ 503, never "admit everything"', () => {
    // The failure this file exists to make impossible: an unfiltered answer on a
    // money path is indistinguishable from a correct one.
    const gate = resolveCheckoutAdmissionGate('mx', { MEDUSA_SALES_CHANNEL_ID: MARKETPLACE })
    expect(gate.ok).toBe(false)
    if (gate.ok) throw new Error('unreachable')
    expect(gate.status).toBe(503)
    expect(gate.body.reason).toBe('operating_channel_unavailable')
    expect(gate.body.message).toMatch(/MEDUSA_MX_OPERATING_CHANNEL_ID/)
  })

  it('an unaddressable MARKETPLACE channel does not close the gate — it is not the admission rule', () => {
    const gate = resolveCheckoutAdmissionGate('mx', { MEDUSA_MX_OPERATING_CHANNEL_ID: OPERATING })
    expect(gate.ok).toBe(true)
    if (!gate.ok) throw new Error('unreachable')
    expect(gate.marketplace_channel_id).toBeNull()
  })
})

describe('decideCheckoutAdmission — what gets in', () => {
  it('admits an OPERATING-CHANNEL-ONLY product: the capability the epic exists for', () => {
    const decision = decide()
    expect(decision).toEqual({
      admitted: true,
      product_id: PRODUCT_ID,
      in_operating_channel: true,
      in_marketplace_channel: false,
    })
  })

  it('admits an ordinary both-channel product and reports both memberships', () => {
    const decision = decide({
      product: product({ sales_channels: [{ id: OPERATING }, { id: MARKETPLACE }] }),
    })
    expect(decision).toEqual({
      admitted: true,
      product_id: PRODUCT_ID,
      in_operating_channel: true,
      in_marketplace_channel: true,
    })
  })
})

describe('decideCheckoutAdmission — what stays out', () => {
  it('a DRAFT is refused — membership is not publish state (D6 links drafts on purpose)', () => {
    // Without this, D6's deliberate decision to link drafts into the operating
    // channel would make every unpublished listing buyable.
    expect(decide({ product: product({ status: 'draft' }) }))
      .toEqual({ admitted: false, refusal: 'not_published' })
  })

  it('a product NOT in the operating channel is refused even with marketplace membership', () => {
    expect(decide({ product: product({ sales_channels: [{ id: MARKETPLACE }] }) }))
      .toEqual({ admitted: false, refusal: 'not_in_operating_channel' })
  })

  it('a product in NO channel is refused', () => {
    expect(decide({ product: product({ sales_channels: [] }) }).admitted).toBe(false)
    expect(decide({ product: product({ sales_channels: null }) }).admitted).toBe(false)
  })

  it('a DANGLING link row is "not this channel", not a free pass', () => {
    // `query.graph` expands a link to a deleted channel into a null-ish entry with
    // no id. 15 such rows existed in production in July 2026.
    expect(decide({ product: product({ sales_channels: [null, { id: undefined }] }) }).admitted)
      .toBe(false)
  })

  it('a product owned by ANOTHER market\'s seller is refused', () => {
    expect(decide({ owner_market: 'us' }))
      .toEqual({ admitted: false, refusal: 'owner_other_market' })
  })

  it('a product whose owner cannot be resolved is refused, never adopted', () => {
    // Fail closed: an orphaned product is a data-repair job, not something a money
    // path quietly takes ownership of.
    expect(decide({ owner_market: null }))
      .toEqual({ admitted: false, refusal: 'owner_unresolved' })
  })

  it('a missing product is refused', () => {
    expect(decide({ product: null }).admitted).toBe(false)
    expect(decide({ product: undefined }).admitted).toBe(false)
    expect(decide({ product: { id: '', status: 'published' } }).admitted).toBe(false)
  })

  it('the row returned must BE the row that was asked about', () => {
    // The whole class of admission bug this codebase has shipped is "the proof and
    // the purchase named different objects".
    expect(decide({ requested_product_id: 'prod_something_else' }))
      .toEqual({ admitted: false, refusal: 'id_mismatch' })
  })

  it('hidden, support and print-placement products are refused, exactly as today', () => {
    for (const metadata of [
      { is_print_placement: true },
      // Truthy, not strictly `true` — `/store/listings/:id` refuses these too, and a
      // stricter comparison here would quietly admit them.
      { is_print_placement: 1 },
      { is_print_placement: 'true' },
      { hidden_from_catalog: true },
      { is_support_product: true },
      { support_widget: true },
    ]) {
      expect(decide({ product: product({ metadata }) }))
        .toEqual({ admitted: false, refusal: 'hidden_product' })
    }
  })
})

describe('decideCheckoutAdmission — the flag decides WHICH RULE, never whether one runs (D8)', () => {
  it('flag OFF ⇒ an operating-only product is REFUSED: exactly today\'s behaviour', () => {
    expect(decide({ owned_shop_only_enabled: false }))
      .toEqual({ admitted: false, refusal: 'not_in_marketplace_channel' })
  })

  it('flag OFF ⇒ a both-channel product is still admitted — no regression for the live catalog', () => {
    const decision = decide({
      owned_shop_only_enabled: false,
      product: product({ sales_channels: [{ id: OPERATING }, { id: MARKETPLACE }] }),
    })
    expect(decision.admitted).toBe(true)
  })

  it('flag OFF with an unaddressable marketplace channel refuses — "cannot prove" is "no"', () => {
    expect(decide({ owned_shop_only_enabled: false, marketplace_channel_id: null }).admitted)
      .toBe(false)
  })

  it('the flag NEVER relaxes the non-channel proofs', () => {
    // Admission widens by exactly ONE fact — buyable on its own shop. Turning the
    // flag on must not turn off publish state, ownership or hidden-product checks.
    for (const overrides of [
      { product: product({ status: 'draft' }) },
      { owner_market: 'us' as const },
      { owner_market: null },
      { product: product({ metadata: { is_support_product: true } }) },
      { requested_product_id: 'prod_other' },
      { owner_status: 'paused' as const },
      { owner_status: 'deleted' as const },
      { owner_status: null },
    ]) {
      expect(decide({ owned_shop_only_enabled: true, ...overrides }).admitted).toBe(false)
    }
  })
})

describe('the owning seller must be ACTIVE (tenant-lifecycle-admin · D2b)', () => {
  it('admits a product whose owner is active', () => {
    expect(decide({ owner_status: 'active' }).admitted).toBe(true)
  })

  it('REFUSES a paused owner, naming the rule internally', () => {
    expect(decide({ owner_status: 'paused' }))
      .toEqual({ admitted: false, refusal: 'owner_not_active' })
  })

  it('REFUSES a deleted owner', () => {
    expect(decide({ owner_status: 'deleted' }))
      .toEqual({ admitted: false, refusal: 'owner_not_active' })
  })

  it('REFUSES an UNREADABLE status rather than assuming active', () => {
    // "I could not read the status" is not "the shop is open". The route passes null
    // when parseSellerStatus refuses the stored value.
    expect(decide({ owner_status: null }))
      .toEqual({ admitted: false, refusal: 'owner_not_active' })
  })

  it('refuses a paused owner EVEN WHEN the product is still in both channels', () => {
    // This is the whole point of the belt-and-braces design (D2). Pausing unlinks the
    // products; if a link lingers — a partial unlink, or one recreated by another
    // path — the money path must still refuse. A test that only paused a seller with
    // no links would prove nothing about the guarantee.
    const stillLinked = product({ sales_channels: [{ id: OPERATING }, { id: MARKETPLACE }] })
    expect(decide({ product: stillLinked, owner_status: 'paused' }))
      .toEqual({ admitted: false, refusal: 'owner_not_active' })
  })

  it('the status proof survives the flag being OFF', () => {
    // The flag chooses WHICH channel rule runs; it must never gate the owner proofs.
    const inBoth = product({ sales_channels: [{ id: OPERATING }, { id: MARKETPLACE }] })
    expect(decide({ product: inBoth, owned_shop_only_enabled: false, owner_status: 'paused' }))
      .toEqual({ admitted: false, refusal: 'owner_not_active' })
  })
})
