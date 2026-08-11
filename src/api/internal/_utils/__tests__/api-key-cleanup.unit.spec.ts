import { planApiKeyCleanup, isRevoked } from '../api-key-cleanup'

/**
 * Publishable-key cleanup planner. Pure — no DB, no Medusa container.
 *
 * The fixtures mirror the real production shape measured on 2026-07-27:
 * 72 publishable keys, exactly ONE with a live sales-channel link, and 70
 * dangling link rows expanded by `query.graph` into null-ish entries with no
 * `id`. See `../api-key-cleanup.ts` for why deleting the keys clears the links.
 */

const live = (id = 'sc_live') => ({ id, name: 'Miyagi Sánchez Storefront' })

/** How `query.graph` renders a link row whose sales_channel row is gone. */
const DANGLING = undefined

describe('planApiKeyCleanup · the production shape', () => {
  // One healthy key + 71 orphans, 70 of which carry a dangling link row.
  const productionRows = [
    { id: 'apk_keep', title: 'Default Publishable API Key', token: 'pk_live_abc', sales_channels: [live()] },
    // 70 orphans each holding one dangling link
    ...Array.from({ length: 70 }, (_, i) => ({
      id: `apk_orphan_${i}`,
      title: 'Default Publishable API Key',
      token: `pk_orphan_${i}`,
      sales_channels: [DANGLING],
    })),
    // the 72nd key: an orphan with NO link row at all — the state the old
    // diagnostic could not tell apart from the 70 above
    { id: 'apk_no_links', title: 'Storefront', token: 'pk_nolinks', sales_channels: [] },
  ]

  const plan = planApiKeyCleanup(productionRows)

  it('reproduces the measured live numbers: 72 keys, 70 dangling, 1 live', () => {
    expect(plan.total_keys).toBe(72)
    expect(plan.total_dangling_links).toBe(70)
    expect(plan.total_live_links).toBe(1)
  })

  it('keeps exactly the one key with a live sales-channel link', () => {
    expect(plan.keep.map(k => k.id)).toEqual(['apk_keep'])
    expect(plan.keep[0].keep_reason).toBe('live_sales_channel_link')
  })

  it('deletes the other 71 — and does not refuse', () => {
    expect(plan.delete).toHaveLength(71)
    expect(plan.delete.map(k => k.id)).not.toContain('apk_keep')
    expect(plan.refuse).toBeNull()
  })

  it('distinguishes a dangling link from no link at all (three states, never two)', () => {
    const dangling = plan.delete.find(k => k.id === 'apk_orphan_0')!
    const none = plan.delete.find(k => k.id === 'apk_no_links')!
    expect(dangling.dangling_links).toBe(1)
    expect(none.dangling_links).toBe(0)
  })

  it('echoes only a token PREFIX, never the whole token', () => {
    // A real publishable token is far longer than the prefix, so the fixture
    // must be too — an 11-char token would pass this whether or not the code
    // truncates at all (caught by the DoD mutation sweep).
    const long = 'pk_0123456789abcdefghijklmnop'
    const p = planApiKeyCleanup([{ id: 'apk_long', token: long, sales_channels: [live()] }])
    expect(p.keep[0].token_prefix).toBe('pk_012345678')
    expect(p.keep[0].token_prefix!.length).toBeLessThan(long.length)
    expect(JSON.stringify(p)).not.toContain(long)
  })
})

describe('planApiKeyCleanup · the keep rule', () => {
  it('protects every configured market token, not only the MX singleton', () => {
    const plan = planApiKeyCleanup([
      { id: 'apk_mx', token: 'pk_mx', sales_channels: [live('sc_mx')] },
      { id: 'apk_us', token: 'pk_us', sales_channels: [DANGLING] },
    ], { protectedTokens: ['pk_mx', 'pk_us'] })
    expect(plan.refuse).toBeNull()
    expect(plan.keep.map((key) => key.id)).toEqual(['apk_mx', 'apk_us'])
    expect(plan.storefront_token_check).toBe('matched')
  })

  it('keeps the configured storefront key even when its channel link is broken', () => {
    const plan = planApiKeyCleanup(
      [
        { id: 'apk_store', token: 'pk_storefront', sales_channels: [DANGLING] },
        { id: 'apk_other', token: 'pk_other', sales_channels: [live()] },
      ],
      { storefrontToken: 'pk_storefront' },
    )
    expect(plan.keep.map(k => k.id).sort()).toEqual(['apk_other', 'apk_store'])
    expect(plan.keep.find(k => k.id === 'apk_store')!.keep_reason).toBe('configured_storefront_token')
    expect(plan.delete).toHaveLength(0)
  })

  it('a live link outranks the token as the stated reason when both hold', () => {
    const plan = planApiKeyCleanup(
      [{ id: 'apk_both', token: 'pk_storefront', sales_channels: [live()] }],
      { storefrontToken: 'pk_storefront' },
    )
    expect(plan.keep[0].keep_reason).toBe('live_sales_channel_link')
  })

  it('a whitespace-padded configured token still matches', () => {
    const plan = planApiKeyCleanup(
      [{ id: 'apk_store', token: 'pk_storefront', sales_channels: [DANGLING] }],
      { storefrontToken: '  pk_storefront  ' },
    )
    expect(plan.storefront_token_check).toBe('matched')
    expect(plan.refuse).toBeNull()
  })

  it('several live keys are all kept — keeping extra is never unsafe', () => {
    const plan = planApiKeyCleanup([
      { id: 'a', sales_channels: [live('sc_1')] },
      { id: 'b', sales_channels: [live('sc_2')] },
      { id: 'c', sales_channels: [DANGLING] },
    ])
    expect(plan.keep.map(k => k.id)).toEqual(['a', 'b'])
    expect(plan.delete.map(k => k.id)).toEqual(['c'])
  })
})

describe('planApiKeyCleanup · refusals (this deletes production credentials)', () => {
  it('refuses an EMPTY read — "no keys" and "the query failed" look identical', () => {
    expect(planApiKeyCleanup([]).refuse).toMatch(/empty read/)
    expect(planApiKeyCleanup(null).refuse).toMatch(/empty read/)
    expect(planApiKeyCleanup(undefined).refuse).toMatch(/empty read/)
  })

  it('refuses when NO key qualifies — never deletes every publishable key', () => {
    const plan = planApiKeyCleanup([
      { id: 'a', sales_channels: [DANGLING] },
      { id: 'b', sales_channels: [] },
    ])
    expect(plan.keep).toHaveLength(0)
    expect(plan.delete).toHaveLength(2)
    expect(plan.refuse).toMatch(/every publishable key/)
  })

  it('refuses while any row is unreadable — a key with no id cannot be reasoned about', () => {
    const plan = planApiKeyCleanup([
      { id: 'apk_keep', sales_channels: [live()] },
      { id: null, sales_channels: [DANGLING] },
    ])
    expect(plan.unusable_rows).toBe(1)
    expect(plan.refuse).toMatch(/no id/)
  })

  it('refuses when a storefront token IS configured but matches nothing', () => {
    const plan = planApiKeyCleanup(
      [{ id: 'apk_keep', token: 'pk_something_else', sales_channels: [live()] }],
      { storefrontToken: 'pk_storefront' },
    )
    expect(plan.storefront_token_check).toBe('not_found')
    expect(plan.refuse).toMatch(/unaccounted for/)
  })

  it('does NOT refuse when the token check is merely UNAVAILABLE — unknown is not "missing"', () => {
    // no configured token at all (today's backend: the env var is unset)
    const noConfig = planApiKeyCleanup([{ id: 'a', token: 'pk_x', sales_channels: [live()] }])
    expect(noConfig.storefront_token_check).toBe('unavailable')
    expect(noConfig.refuse).toBeNull()

    // configured, but the token field came back empty on EVERY row (e.g. a
    // field-selection change) — indistinguishable from "not found" if collapsed
    const noTokens = planApiKeyCleanup(
      [{ id: 'a', sales_channels: [live()] }],
      { storefrontToken: 'pk_storefront' },
    )
    expect(noTokens.storefront_token_check).toBe('unavailable')
    expect(noTokens.refuse).toBeNull()
  })
})

/**
 * The revoke precondition. Measured in production 2026-07-27: the first apply
 * attempt returned HTTP 400 `Cannot delete api keys that are not revoked` for
 * all 71 keys and deleted nothing. The dry run had happily predicted
 * "delete 71" — a prediction the apply could not deliver.
 */
describe('isRevoked · mirrors the module delete precondition, never paraphrases it', () => {
  const NOW = new Date('2026-07-27T12:00:00.000Z')

  it('null / undefined revoked_at ⇒ NOT revoked (the live state of all 72 keys)', () => {
    expect(isRevoked(null, NOW)).toBe(false)
    expect(isRevoked(undefined, NOW)).toBe(false)
  })

  it('a past revoked_at ⇒ revoked', () => {
    expect(isRevoked('2026-07-01T00:00:00.000Z', NOW)).toBe(true)
    expect(isRevoked(new Date('2026-07-01T00:00:00.000Z'), NOW)).toBe(true)
  })

  it('a FUTURE revoked_at ⇒ NOT revoked — the module compares, it does not null-check', () => {
    // `deleteApiKeys_` rejects `revoked_at > now()`. Restating the rule as
    // "has a revoked_at" would fork it permissively and let this key through.
    expect(isRevoked('2099-01-01T00:00:00.000Z', NOW)).toBe(false)
  })

  it('exactly now ⇒ revoked (the guard is strictly-greater-than)', () => {
    expect(isRevoked(NOW, NOW)).toBe(true)
  })

  it('an unparseable value ⇒ NOT revoked — never claim revoked on garbage', () => {
    expect(isRevoked('not-a-date', NOW)).toBe(false)
  })
})

describe('planApiKeyCleanup · requires_revoke drives the apply path', () => {
  it('counts the unrevoked members of the DELETE set only', () => {
    const plan = planApiKeyCleanup([
      { id: 'keep', sales_channels: [live()] },                                  // kept, unrevoked
      { id: 'del_fresh', sales_channels: [DANGLING] },                           // needs revoke
      { id: 'del_already', revoked_at: '2026-01-01T00:00:00.000Z', sales_channels: [DANGLING] },
    ])
    expect(plan.requires_revoke).toBe(1)
    expect(plan.delete.find(k => k.id === 'del_fresh')!.revoked).toBe(false)
    expect(plan.delete.find(k => k.id === 'del_already')!.revoked).toBe(true)
    // the kept key's revoked flag is reported but never acted on
    expect(plan.keep[0].revoked).toBe(false)
  })

  it('reproduces the live shape: 71 to delete, all 71 needing revocation first', () => {
    const rows = [
      { id: 'apk_keep', sales_channels: [live()] },
      ...Array.from({ length: 71 }, (_, i) => ({ id: `apk_o${i}`, sales_channels: [DANGLING] })),
    ]
    const plan = planApiKeyCleanup(rows)
    expect(plan.delete).toHaveLength(71)
    expect(plan.requires_revoke).toBe(71)
    expect(plan.refuse).toBeNull()
  })
})

describe('planApiKeyCleanup · malformed input never throws', () => {
  it('survives null-ish links, a non-array sales_channels, and junk rows', () => {
    const plan = planApiKeyCleanup([
      { id: 'apk_keep', sales_channels: [live(), null, undefined, { id: '  ' }] },
      { id: 'apk_junk', sales_channels: 'not-an-array' as any },
      { id: 'apk_missing' },
    ])
    expect(plan.refuse).toBeNull()
    expect(plan.keep.map(k => k.id)).toEqual(['apk_keep'])
    // null, undefined and a blank-id link all count as dangling
    expect(plan.keep[0].dangling_links).toBe(3)
    expect(plan.delete.map(k => k.id)).toEqual(['apk_junk', 'apk_missing'])
  })

  it('a non-array top-level input is treated as an empty read, not a crash', () => {
    expect(() => planApiKeyCleanup('nope' as any)).not.toThrow()
    expect(planApiKeyCleanup({ data: [] } as any).refuse).toMatch(/empty read/)
  })
})
