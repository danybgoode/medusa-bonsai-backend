import fs from 'node:fs'
import path from 'node:path'
import {
  planPublishableKeyChannelMove,
  type PublishableKeyRow,
} from '../publishable-key-channel-move'

/**
 * S2.1 — moving the storefront publishable key onto the operating channel.
 *
 * Pure over injected rows: no container, no database, no network. The live baseline
 * these fixtures mirror is D1, measured 2026-07-31: ONE publishable key
 * (`apk_01KRVSGHN5KMCJSAMMYHRBD42W`) with EXACTLY ONE link row, pointing at the MX
 * marketplace channel, `skipped_links: 0`.
 */

const KEY_ID = 'apk_01KRVSGHN5KMCJSAMMYHRBD42W'
const TOKEN = 'pk_live_storefront_token_value'
const MARKETPLACE = 'sc_01KSK1J0V81P4EPY9G0JAPX353'
const OPERATING = 'sc_01KYWNQ0C0PFFM0K0V2EMC24AP'
const STORE_DEFAULT = 'sc_01KRVSGTDJ50SW7TF83M192ZNQ'

/** The live D1 shape: one key, one link, pointing at the marketplace channel. */
function liveRows(overrides: Partial<PublishableKeyRow> = {}): PublishableKeyRow[] {
  return [{
    id: KEY_ID,
    title: 'Default Publishable API Key',
    token: TOKEN,
    sales_channels: [{ id: MARKETPLACE, name: 'Miyagi Markets MX' }],
    ...overrides,
  }]
}

const moveToOperating = (rows: unknown, storefrontToken: string | null = TOKEN) =>
  planPublishableKeyChannelMove(rows, { desiredChannelIds: [OPERATING], storefrontToken })

describe('planPublishableKeyChannelMove — the move itself (D3)', () => {
  it('unlinks the marketplace channel and links the operating one: 1 → 1', () => {
    const plan = moveToOperating(liveRows())
    expect(plan.refuse).toBeNull()
    expect(plan.target?.key_id).toBe(KEY_ID)
    expect(plan.storefront_token_check).toBe('matched')
    expect(plan.links_before).toBe(1)
    expect(plan.links_after_predicted).toBe(1)
    expect(plan.add).toEqual([OPERATING])
    expect(plan.remove).toEqual([MARKETPLACE])
    expect(plan.already_satisfied).toBe(false)
  })

  it('is idempotent — a key already on the operating channel is a no-op, not a re-link', () => {
    const plan = moveToOperating(liveRows({ sales_channels: [{ id: OPERATING }] }))
    expect(plan.refuse).toBeNull()
    expect(plan.add).toEqual([])
    expect(plan.remove).toEqual([])
    expect(plan.already_satisfied).toBe(true)
    expect(plan.links_after_predicted).toBe(1)
  })

  it('D9 rollback is the same planner with the marketplace channel as the desired set', () => {
    // Rollback is two link operations, not a deploy. Stated as a spec so it is known
    // to work BEFORE it is needed at 3am.
    const moved = liveRows({ sales_channels: [{ id: OPERATING }] })
    const plan = planPublishableKeyChannelMove(moved, {
      desiredChannelIds: [MARKETPLACE],
      storefrontToken: TOKEN,
    })
    expect(plan.refuse).toBeNull()
    expect(plan.add).toEqual([MARKETPLACE])
    expect(plan.remove).toEqual([OPERATING])
    expect(plan.links_after_predicted).toBe(1)
  })

  it('removes EVERY foreign channel, not only the one it expected to find', () => {
    // A key that somehow accumulated an extra link must still land on exactly one.
    const plan = moveToOperating(
      liveRows({ sales_channels: [{ id: MARKETPLACE }, { id: STORE_DEFAULT }] }),
    )
    expect(plan.refuse).toBeNull()
    expect(plan.links_before).toBe(2)
    expect([...plan.remove].sort()).toEqual([MARKETPLACE, STORE_DEFAULT].sort())
    expect(plan.links_after_predicted).toBe(1)
  })

  it('REFUSES duplicate link rows naming ONE channel — a key with 2 rows still 400s', () => {
    // This spec previously asserted the OPPOSITE ("counts two link rows naming one
    // channel as one channel ... refuse toBeNull"), on the reasoning that a guard
    // rejecting correct output is worse than one missing a fault. That reasoning was
    // sound in general and wrong here, because the premise was wrong: Medusa does
    // NOT dedupe. `maybeAttachPublishableKeyScopes` does
    // `apiKey.sales_channels.map((sc) => sc.id)` with no Set, so two rows naming one
    // channel yield a length-2 array and trip the `> 1` branch — 400 on every cart.
    //
    // So a duplicate row is NOT a healthy key, and `remove` (computed per channel id)
    // cannot clear the surplus. Refusing is the correct output here, not an
    // over-strict guard. Caught by the codex cross-family review on PR 130; the
    // precedent is real — 70 duplicate api_key link rows existed in this database in
    // July 2026.
    const plan = moveToOperating(liveRows({ sales_channels: [{ id: MARKETPLACE }, { id: MARKETPLACE }] }))
    expect(plan.refuse).toMatch(/DUPLICATE link row/)
    expect(plan.refuse).toMatch(/2 rows naming 1 distinct channel/)
  })

  it('a single link row per channel is NOT treated as a duplicate', () => {
    // Guard the guard: the refusal above must not fire on the healthy shape, or it
    // would block every legitimate move.
    const plan = moveToOperating(liveRows({ sales_channels: [{ id: MARKETPLACE }] }))
    expect(plan.refuse).toBeNull()
    expect(plan.links_before).toBe(1)
  })
})

describe('planPublishableKeyChannelMove — the D3 cap: never more than one channel', () => {
  it('REFUSES the scaffold\'s original plan (operating IN ADDITION TO marketplace)', () => {
    // This is the exact plan Sprint 2 was scaffolded with. Building it would have
    // made every storefront cart creation fail — see the module header for the
    // traced Medusa 2.15.3 mechanism.
    const plan = planPublishableKeyChannelMove(liveRows(), {
      desiredChannelIds: [MARKETPLACE, OPERATING],
      storefrontToken: TOKEN,
    })
    expect(plan.refuse).toMatch(/2 sales channel/)
    expect(plan.refuse).toMatch(/Exactly one link row/)
  })

  it('refuses a desired set of ZERO channels — an unscoped key serves an empty catalog', () => {
    const plan = planPublishableKeyChannelMove(liveRows(), {
      desiredChannelIds: [],
      storefrontToken: TOKEN,
    })
    expect(plan.refuse).toMatch(/0 sales channel/)
  })

  it('names its sources instead of paraphrasing the mechanism', () => {
    const plan = planPublishableKeyChannelMove(liveRows(), {
      desiredChannelIds: [MARKETPLACE, OPERATING],
      storefrontToken: TOKEN,
    })
    // Sprint acceptance: cite the files, do not restate the rule. A paraphrased
    // contract drifts permissive.
    expect(plan.refuse).toContain('ensure-pub-key-sales-channel-match.js')
    expect(plan.refuse).toContain('wrap-handler.js')
  })
})

describe('planPublishableKeyChannelMove — refusals that keep the credential safe', () => {
  it('refuses an empty read rather than reporting a clean no-op', () => {
    expect(moveToOperating([]).refuse).toMatch(/empty read/)
    expect(moveToOperating(null).refuse).toMatch(/empty read/)
    expect(moveToOperating(undefined).refuse).toMatch(/empty read/)
  })

  it('refuses while any key row is unreadable', () => {
    const plan = moveToOperating([...liveRows(), { id: null, token: null }])
    expect(plan.refuse).toMatch(/no id/)
  })

  it('refuses when the configured storefront token matches no key', () => {
    const plan = moveToOperating(liveRows(), 'pk_live_some_other_token')
    expect(plan.storefront_token_check).toBe('not_found')
    expect(plan.refuse).toMatch(/unaccounted for/)
    expect(plan.target).toBeNull()
  })

  it('refuses to guess when the token check is unavailable and several keys exist', () => {
    const rows = [
      { id: KEY_ID, sales_channels: [{ id: MARKETPLACE }] },
      { id: 'apk_other', sales_channels: [{ id: STORE_DEFAULT }] },
    ]
    const plan = moveToOperating(rows, null)
    expect(plan.storefront_token_check).toBe('unavailable')
    expect(plan.refuse).toMatch(/refusing to guess/)
  })

  it('proceeds on arithmetic when the token check is unavailable and exactly one key exists', () => {
    // `unavailable` is not a failure — it means we fell back to a rule that is sound.
    // Three states, never two.
    const plan = moveToOperating([{ id: KEY_ID, sales_channels: [{ id: MARKETPLACE }] }], null)
    expect(plan.storefront_token_check).toBe('unavailable')
    expect(plan.refuse).toBeNull()
    expect(plan.target?.key_id).toBe(KEY_ID)
  })

  it('refuses while the key carries DANGLING link rows', () => {
    // A link whose channel id we cannot read cannot be dismissed by id, so the key
    // would end up holding more than one row however careful the arithmetic is.
    // 70 such rows existed in production in July 2026.
    const plan = moveToOperating(liveRows({ sales_channels: [{ id: MARKETPLACE }, null, { id: null }] }))
    expect(plan.target?.unusable_link_rows).toBe(2)
    expect(plan.refuse).toMatch(/dangling/)
  })

  it('reports the WHOLE key population, not only the one it picked', () => {
    const plan = moveToOperating([...liveRows(), { id: 'apk_other', sales_channels: [] }])
    expect(plan.all_keys.map((k) => k.key_id)).toEqual([KEY_ID, 'apk_other'])
  })

  it('never echoes a whole token', () => {
    const plan = moveToOperating(liveRows())
    expect(JSON.stringify(plan)).not.toContain(TOKEN)
    expect(plan.target?.token_prefix).toBe(TOKEN.slice(0, 12))
  })
})

/**
 * The sprint's acceptance asks that a spec ENCODE WHY, citing the Medusa source
 * rather than paraphrasing it. This reads the installed packages, so it reddens if a
 * Medusa upgrade changes the mechanism the whole decision rests on — the one thing a
 * fixture-based spec could never notice.
 *
 * ⚠️ IT ALSO CORRECTS THE EPIC README. D3 states the >1-channel case falls back
 * SILENTLY to `store.default_sales_channel_id` because `req.errors` is "read nowhere
 * in the entire Medusa dist". `req.errors` IS read — in `@medusajs/framework`, not in
 * `@medusajs/medusa` — by `wrapHandler`, which every route handler is wrapped in. So
 * the real behaviour is a LOUD 400 on every cart creation, not a quiet misroute. D3's
 * CONCLUSION is unchanged and, if anything, better supported: two channels on this
 * key means nobody can check out at all.
 */
describe('WHY exactly one channel — read from the installed Medusa, not restated', () => {
  const pkg = (rel: string) => path.join(process.cwd(), 'node_modules', rel)
  const read = (rel: string) => fs.readFileSync(pkg(rel), 'utf8')

  const MIDDLEWARE = '@medusajs/medusa/dist/api/utils/middlewares/common/ensure-pub-key-sales-channel-match.js'
  const CART_MIDDLEWARES = '@medusajs/medusa/dist/api/store/carts/middlewares.js'
  const WRAP_HANDLER = '@medusajs/framework/dist/http/utils/wrap-handler.js'
  const FIND_SALES_CHANNEL = '@medusajs/core-flows/dist/cart/steps/find-sales-channel.js'

  it('POST /store/carts runs ensurePublishableKeyAndSalesChannelMatch', () => {
    expect(read(CART_MIDDLEWARES)).toContain('ensurePublishableKeyAndSalesChannelMatch')
  })

  it('>1 channel and no sales_channel_id ⇒ an error is pushed and the id is left UNSET', () => {
    const source = read(MIDDLEWARE)
    expect(source).toContain('pubKeySalesChannels.length > 1')
    expect(source).toContain('Cannot assign sales channel to cart')
    // The single-channel branch — the one that makes a one-channel key work — assigns
    // the id. This is the behaviour the move preserves.
    expect(source).toContain('req.validatedBody.sales_channel_id = pubKeySalesChannels[0]')
  })

  it('wrapHandler turns a populated req.errors into a 400 — the cart is never created', () => {
    const source = read(WRAP_HANDLER)
    expect(source).toContain('req_?.errors?.length')
    expect(source).toContain('res.status(400)')
  })

  it('findSalesChannelStep DOES hold the store-default fallback — it is simply unreachable here', () => {
    // Kept as a spec so a future Medusa version that stops short-circuiting in
    // wrapHandler surfaces the OTHER failure mode (a silent misroute onto a channel
    // holding none of the catalog) instead of it being rediscovered in production.
    expect(read(FIND_SALES_CHANNEL)).toContain('store?.default_sales_channel_id')
  })
})
