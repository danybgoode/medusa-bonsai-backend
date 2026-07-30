import { readFileSync } from 'fs'
import { join } from 'path'
import {
  describeRegionKeep,
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

describe('planProtectedSalesChannels — destructive plans require known protection', () => {
  it('keeps the store default and every active marketplace channel', () => {
    expect(planProtectedSalesChannels(PROD_ENV, 'sc_default')).toEqual({
      ok: true,
      ids: ['sc_default', PROD_ENV.MEDUSA_SALES_CHANNEL_ID],
    })
  })

  it('blocks when the active MX channel is unconfigured', () => {
    const plan = planProtectedSalesChannels({}, 'sc_default')
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('unreachable')
    expect(plan.blocked_by.join(' ')).toMatch(/MEDUSA_SALES_CHANNEL_ID/)
  })

  it('blocks when the store default is unavailable', () => {
    const plan = planProtectedSalesChannels(PROD_ENV, null)
    expect(plan.ok).toBe(false)
    if (plan.ok) throw new Error('unreachable')
    expect(plan.blocked_by.join(' ')).toMatch(/store default/)
  })
})
