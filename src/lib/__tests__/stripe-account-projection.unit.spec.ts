import {
  blockingRequirementsFor,
  outstandingRequirementsFor,
  projectStripeV2Account,
} from '../stripe-account-projection'
import { resolveStripeReadiness } from '../stripe-market-strategy'

/**
 * VERBATIM shapes captured from live test-mode Accounts v2 responses on 2026-08-11.
 * Keeping them literal is the point: the bug this module was written after was a
 * fixture that asserted a field the real API never returns.
 */
const ONBOARDED_ACCOUNT = {
  id: 'acct_1U3RtJLloZe3XdZ1',
  identity: { country: 'US' },
  dashboard: 'full',
  configuration: {
    customer: {},
    recipient: {},
    merchant: { capabilities: { card_payments: { status: 'active', status_details: [] }, stripe_balance: {} } },
  },
  requirements: { summary: null, entries: [] },
}

const requirementEntry = (description: string, capabilities: string[]) => ({
  awaiting_action_from: 'user',
  description,
  errors: [],
  impact: {
    restricts_capabilities: capabilities.map((capability) => ({
      capability, configuration: 'merchant', deadline: { status: 'past_due' },
    })),
  },
  minimum_deadline: { status: 'past_due' },
  reference: null,
  requested_reasons: [{ code: 'routine_onboarding' }],
})

const FRESH_ACCOUNT = {
  id: 'acct_fresh',
  identity: { country: 'US' },
  configuration: { merchant: { capabilities: { card_payments: { status: 'restricted' } } } },
  requirements: {
    summary: { minimum_deadline: { status: 'past_due' } },
    entries: [
      requirementEntry('configuration.merchant.mcc', ['card_payments', 'stripe_balance.payouts']),
      requirementEntry('configuration.merchant.statement_descriptor.descriptor', ['card_payments', 'stripe_balance.payouts']),
    ],
  },
}

describe('projectStripeV2Account — measured shapes', () => {
  it('projects a fully onboarded US account into a READY settings block', () => {
    const p = projectStripeV2Account(ONBOARDED_ACCOUNT)
    expect(p).toMatchObject({
      account_id: 'acct_1U3RtJLloZe3XdZ1',
      api_generation: 'v2',
      account_country: 'us',
      merchant_configuration: 'active',
      card_payments_status: 'active',
      blocking_requirements: [],
    })
  })

  // The whole point of the module: what it emits must satisfy the gate that reads it.
  it('an onboarded account projects into settings that resolveStripeReadiness accepts', () => {
    const seller = {
      metadata: { operating_market: 'us', settings: { stripe: projectStripeV2Account(ONBOARDED_ACCOUNT) } },
    }
    expect(resolveStripeReadiness(seller)).toMatchObject({ ready: true, reason: null })
  })

  it('a fresh account projects into settings the gate REFUSES, naming the requirement', () => {
    const projection = projectStripeV2Account(FRESH_ACCOUNT)!
    expect(projection.card_payments_status).toBe('restricted')
    expect(projection.blocking_requirements).toEqual([
      'configuration.merchant.mcc',
      'configuration.merchant.statement_descriptor.descriptor',
    ])
    const seller = { metadata: { operating_market: 'us', settings: { stripe: projection } } }
    expect(resolveStripeReadiness(seller).ready).toBe(false)
  })

  it('lowercases the country — the API says "US", the registry says "us"', () => {
    expect(projectStripeV2Account(ONBOARDED_ACCOUNT)?.account_country).toBe('us')
  })

  it('returns null without an account id rather than inventing one', () => {
    expect(projectStripeV2Account({ identity: { country: 'US' } })).toBeNull()
    expect(projectStripeV2Account(null)).toBeNull()
    expect(projectStripeV2Account('nonsense')).toBeNull()
  })

  it('reports an absent merchant configuration as absent, not active', () => {
    expect(projectStripeV2Account({ id: 'acct_x', configuration: {} })).toMatchObject({
      merchant_configuration: 'absent', card_payments_status: null,
    })
  })
})

describe('blockingRequirementsFor — only what restricts CHARGING blocks', () => {
  it('ignores an entry that restricts payouts alone', () => {
    const payoutsOnly = {
      requirements: { entries: [requirementEntry('configuration.merchant.bank_account', ['stripe_balance.payouts'])] },
    }
    expect(blockingRequirementsFor(payoutsOnly)).toEqual([])
    // …but it is still owed, and honest seller copy should be able to say so.
    expect(outstandingRequirementsFor(payoutsOnly)).toEqual(['configuration.merchant.bank_account'])
  })

  it('blocks on an entry that restricts card_payments', () => {
    expect(blockingRequirementsFor(FRESH_ACCOUNT)).toContain('configuration.merchant.mcc')
  })

  it('de-duplicates a requirement named by two entries', () => {
    const dupes = { requirements: { entries: [
      requirementEntry('configuration.merchant.mcc', ['card_payments']),
      requirementEntry('configuration.merchant.mcc', ['card_payments']),
    ] } }
    expect(blockingRequirementsFor(dupes)).toEqual(['configuration.merchant.mcc'])
  })

  it('names an unidentifiable entry rather than dropping it silently', () => {
    const noDescription = { requirements: { entries: [
      { impact: { restricts_capabilities: [{ capability: 'card_payments' }] } },
    ] } }
    expect(blockingRequirementsFor(noDescription)).toEqual(['unknown_requirement'])
  })

  it.each([
    ['no requirements key', { id: 'a' }],
    ['null entries', { requirements: { entries: null } }],
    ['entries not an array', { requirements: { entries: 'nope' } }],
    ['entry without impact', { requirements: { entries: [{ description: 'x' }] } }],
  ])('tolerates %s without throwing', (_label, account) => {
    expect(blockingRequirementsFor(account)).toEqual([])
  })
})
