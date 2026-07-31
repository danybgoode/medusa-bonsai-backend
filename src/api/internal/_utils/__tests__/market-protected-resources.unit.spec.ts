import { readFileSync } from 'fs'
import { join } from 'path'
import {
  describeRegionKeep,
  unconfiguredOperatingChannelReasons,
  planProtectedSalesChannels,
  planRegionDeletions,
} from '../market-protected-resources'

/**
 * The registry allow-list on the two destructive setup paths (build contract item 5,
 * D6). Neither has ever run against production for the channel path — these are
 * latent-landmine fixes, so the specs are the only place their behaviour is
 * observable at all.
 */

const PROD_ENV = {
  MEDUSA_MXN_REGION_ID: 'reg_01KSK1HZAWN5ZCSPZ74ER97HD9',
  MEDUSA_SALES_CHANNEL_ID: 'sc_01KSK1J0V81P4EPY9G0JAPX353',
}
const MEXICO = { id: 'reg_01KSK1HZAWN5ZCSPZ74ER97HD9', name: 'Mexico', currency_code: 'mxn' }
const EUROPE = { id: 'reg_eur_seeded', name: 'Europe', currency_code: 'eur' }
const US = { id: 'reg_us_future', name: 'United States', currency_code: 'usd' }

describe('planRegionDeletions', () => {
  it('still removes the seeded Europe region — the behaviour this step exists for', () => {
    const plan = planRegionDeletions([MEXICO, EUROPE], {
      mexicoRegionId: MEXICO.id,
      env: PROD_ENV,
      currenciesInUse: new Set(['mxn']),
    })
    expect(plan.remove.map((r) => r.id)).toEqual([EUROPE.id])
    expect(plan.keep.map((r) => r.reason)).toEqual(['mexico_region'])
  })

  it('NEVER removes the Mexico region — by id or by name', () => {
    const byName = planRegionDeletions([{ ...MEXICO, id: 'reg_other' }], {
      mexicoRegionId: null,
      env: {},
      currenciesInUse: new Set(),
    })
    expect(byName.remove).toEqual([])
    expect(byName.keep[0].reason).toBe('mexico_region')
  })

  it('never removes a region a registry market resolves to by id', () => {
    const plan = planRegionDeletions([{ ...MEXICO, name: 'MX (renamed)' }], {
      mexicoRegionId: null,
      env: PROD_ENV,
      currenciesInUse: new Set(),
    })
    expect(plan.remove).toEqual([])
    expect(plan.keep[0].reason).toBe('registry_region_id')
  })

  it('never removes a region whose CURRENCY belongs to a registry market', () => {
    // This is the one that matters in this repo: the backend has no
    // MEDUSA_*_REGION_ID in its environment, so the id-based protection resolves to
    // an empty set and a hand-created US region would otherwise be deletable.
    const plan = planRegionDeletions([MEXICO, US, EUROPE], {
      mexicoRegionId: MEXICO.id,
      env: {},
      currenciesInUse: new Set(),
    })
    expect(plan.remove.map((r) => r.id)).toEqual([EUROPE.id])
    expect(plan.keep.find((r) => r.id === US.id)?.reason).toBe('registry_currency')
  })

  it('keeps the pre-existing price-safety re-check for a non-registry currency', () => {
    const plan = planRegionDeletions([MEXICO, EUROPE], {
      mexicoRegionId: MEXICO.id,
      env: PROD_ENV,
      currenciesInUse: new Set(['eur']),
    })
    expect(plan.remove).toEqual([])
    expect(plan.keep.find((r) => r.id === EUROPE.id)?.reason).toBe('price_in_use')
  })

  it('is case-insensitive about currency codes', () => {
    const plan = planRegionDeletions([{ ...US, currency_code: 'USD' }], {
      mexicoRegionId: null, env: {}, currenciesInUse: new Set(),
    })
    expect(plan.remove).toEqual([])
  })

  it('every keep reason renders an operator-readable line', () => {
    const plan = planRegionDeletions([MEXICO, US, EUROPE], {
      mexicoRegionId: MEXICO.id, env: PROD_ENV, currenciesInUse: new Set(['eur']),
    })
    for (const kept of plan.keep) {
      expect(describeRegionKeep(kept)).toMatch(/kept|NOT deleted/)
    }
  })
})

describe('cleanup-default-data.ts — the channel allow-list is wired in (source-level)', () => {
  // The script is a `medusa exec` entry point with a knex connection: there is no
  // container-free way to run it. Assert the SHAPE of what it deletes instead, so a
  // future edit cannot quietly restore `where id <> KEEP`.
  const source = readFileSync(join(process.cwd(), 'src/scripts/cleanup-default-data.ts'), 'utf8')

  it('derives its protected set from the registry, not from a literal', () => {
    expect(source).toMatch(/protectedSalesChannelIds\(/)
    expect(source).toMatch(/notProtected\(/)
  })

  it('no longer deletes every sales channel that is not the one kept id', () => {
    expect(source).not.toMatch(/delete from sales_channel where id <> \?/)
    expect(source).toMatch(/delete from sales_channel where \$\{notProtected\('id'\)\}/)
  })

  it('keeps the stable MX marketplace channel id unchanged', () => {
    // The id is load-bearing: the storefront's only publishable key is linked to it.
    expect(source).toContain('sc_01KSK1J0V81P4EPY9G0JAPX353')
  })
})

describe('prune-sales-channels — the sibling write primitive uses the same list', () => {
  const source = readFileSync(join(process.cwd(), 'src/api/internal/prune-sales-channels/route.ts'), 'utf8')

  it('keeps every registry-declared channel, not just the env one', () => {
    expect(source).toMatch(/planProtectedSalesChannels\(/)
    expect(source).not.toMatch(/process\.env\.MEDUSA_SALES_CHANNEL_ID \?\? ''/)
  })

  it('does not collapse a failed Sales Channel list into an empty success', () => {
    expect(source).not.toMatch(/listSalesChannels[\s\S]{0,200}\.catch\(\(\) => \[\]/)
    expect(source).toMatch(/Could not list Sales Channels/)
  })
})

// owned-shop-operating-channel epic, S1.3: the operating channel joins the same
// allow-list, protected with the same strictness as the marketplace channel. This is
// the env shape AFTER provisioning (both channel env vars configured) — the
// unconfigured-operating-channel case (the shape production is in immediately after
// THIS PR deploys, per D10 step 1) gets its own tests below.
const PROD_ENV_PROVISIONED = {
  ...PROD_ENV,
  MEDUSA_MX_OPERATING_CHANNEL_ID: 'sc_operating_mx_placeholder',
}

describe('planProtectedSalesChannels — destructive plans require known protection', () => {
  it('keeps the store default and every active marketplace channel — operating ' +
    'channel unconfigured (D10 step 1: allow-list deploys before the channel exists)', () => {
    // PROD_ENV carries no MEDUSA_MX_OPERATING_CHANNEL_ID. Before this epic's
    // provisioning step runs, the destructive prune correctly refuses (see the
    // dedicated "blocks" test below) rather than running short-listed — this test
    // documents the ids/ok:true shape once provisioning has happened.
    expect(planProtectedSalesChannels(PROD_ENV_PROVISIONED, 'sc_default')).toEqual({
      ok: true,
      ids: [
        'sc_default',
        PROD_ENV.MEDUSA_SALES_CHANNEL_ID,
        PROD_ENV_PROVISIONED.MEDUSA_MX_OPERATING_CHANNEL_ID,
      ],
    })
  })

  it('blocks when the active MX marketplace channel is unconfigured', () => {
    const plan = planProtectedSalesChannels({}, 'sc_default')
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('unreachable')
    expect(plan.blocked_by.join(' ')).toMatch(/MEDUSA_SALES_CHANNEL_ID/)
  })

  it('blocks when the active MX OPERATING channel is unconfigured — the exact ' +
    'production shape the moment this epic\'s allow-list entry deploys, before the ' +
    'channel is created (epic README, D10)', () => {
    const plan = planProtectedSalesChannels(PROD_ENV, 'sc_default')
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('unreachable')
    expect(plan.blocked_by.join(' ')).toMatch(/MEDUSA_MX_OPERATING_CHANNEL_ID/)
  })

  it('never blocks on the US operating channel — structurally no_resource, not ' +
    'unconfigured', () => {
    // `us` has no operating_channel entry in MARKET_MEDUSA_ENV_KEYS at all (this
    // epic's explicit non-goal), and its marketplace_status is "invitation" so the
    // loop skips it before ever resolving either channel kind — confirmed by the
    // fact that the ONLY blocking reason present is the MX one.
    const plan = planProtectedSalesChannels(PROD_ENV, 'sc_default')
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('unreachable')
    expect(plan.blocked_by).toHaveLength(1)
  })

  it('blocks when the store default is unavailable', () => {
    const plan = planProtectedSalesChannels(PROD_ENV_PROVISIONED, null)
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('unreachable')
    expect(plan.blocked_by.join(' ')).toMatch(/store default/)
  })
})

describe('unconfiguredOperatingChannelReasons — cleanup-default-data must fail CLOSED', () => {
  // The gap this closes (D10): once the operating channel EXISTS in the database but
  // MEDUSA_MX_OPERATING_CHANNEL_ID is unset in the environment running
  // `cleanup-default-data.ts`, `protectedSalesChannelIds` omits it SILENTLY and the
  // delete takes the channel plus every product_sales_channel row pointing at it.
  // The marketplace channel is spared by that script's hardcoded KEEP_CHANNEL_ID
  // backstop; the operating channel has none, and deliberately gets none.
  it('reports the active market whose operating channel is unconfigured', () => {
    const reasons = unconfiguredOperatingChannelReasons(PROD_ENV)
    expect(reasons).toHaveLength(1)
    expect(reasons.join(' ')).toMatch(/MEDUSA_MX_OPERATING_CHANNEL_ID/)
  })

  it('is empty once the operating channel is configured — nothing to refuse on', () => {
    expect(unconfiguredOperatingChannelReasons(PROD_ENV_PROVISIONED)).toEqual([])
  })

  it('never blocks on a market that has no operating channel in ANY environment', () => {
    // `us` is `no_resource`, not `unconfigured` — genuinely absent, never an outage.
    // Collapsing the two is exactly the "unknown vs none" error this guard exists for.
    const reasons = unconfiguredOperatingChannelReasons(PROD_ENV_PROVISIONED)
    expect(reasons.join(' ')).not.toMatch(/"us"/)
  })
})

describe('cleanup-default-data.ts — the operating-channel refusal is wired in', () => {
  const source = readFileSync(join(process.cwd(), 'src/scripts/cleanup-default-data.ts'), 'utf8')

  it('aborts before deleting anything when the operating channel is unresolvable', () => {
    // Assert the ORDERING property, not a proximity window. An earlier version of
    // this spec matched /operatingBlockers[\s\S]{0,400}?return/, which encoded two
    // accidents of layout — the local variable's NAME and how many characters
    // separate it from the return — so renaming the variable or adding a comment
    // would have silently passed it. The real contract is: the guard's early return
    // happens BEFORE any delete can run. (Cross-agent review, claude-opus-4-6.)
    const guardAt = source.indexOf('unconfiguredOperatingChannelReasons(')
    expect(guardAt).toBeGreaterThan(-1)

    const returnAfterGuard = source.indexOf('return', guardAt)
    const firstDelete = source.indexOf('delete from')
    expect(returnAfterGuard).toBeGreaterThan(-1)
    expect(firstDelete).toBeGreaterThan(-1)
    expect(returnAfterGuard).toBeLessThan(firstDelete)
  })
})
