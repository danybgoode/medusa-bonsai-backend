/**
 * Mercado Libre API client — ported from the despachobonsai reference
 * (`references/despachobonsai/lib/mercadolibre.ts`) as the OAuth + API shape
 * reference. Backend-only: `ML_APP_SECRET` lives here and never reaches the
 * frontend. The frontend builds only the public authorization URL (app id +
 * redirect uri).
 */

const ML_API = process.env.ML_API_BASE ?? 'https://api.mercadolibre.com'

export type MlTokenResponse = {
  access_token: string
  token_type: string
  expires_in: number
  scope: string
  user_id: number
  refresh_token: string
}

export type MlUser = {
  id: number
  nickname: string
  email?: string
  country_id?: string
  site_id?: string
}

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

/** Exchange an authorization code for tokens (OAuth authorization_code grant). */
export async function exchangeCode(code: string): Promise<MlTokenResponse> {
  const res = await fetch(`${ML_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: requireEnv('ML_APP_ID'),
      client_secret: requireEnv('ML_APP_SECRET'),
      code,
      redirect_uri: requireEnv('ML_REDIRECT_URI'),
    }),
  })
  if (!res.ok) throw new Error(`ML token exchange failed: ${res.status}`)
  return res.json()
}

/**
 * Swap a refresh token for a fresh access + refresh token pair. On rejection the
 * thrown error carries `.httpStatus` (same pattern as `updateMlItem`'s
 * `.mlCode`/`.mlMessage`) so the caller can tell a transient ML-side failure
 * (5xx/429) apart from a non-retryable one (400/401 — the refresh token is
 * genuinely dead/already used) without re-parsing the message string.
 */
export async function refreshMlToken(refreshToken: string): Promise<MlTokenResponse> {
  const res = await fetch(`${ML_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: requireEnv('ML_APP_ID'),
      client_secret: requireEnv('ML_APP_SECRET'),
      refresh_token: refreshToken,
    }),
  })
  if (!res.ok) {
    throw Object.assign(new Error(`ML token refresh failed: ${res.status}`), { httpStatus: res.status })
  }
  return res.json()
}

/** Fetch the connected ML user's profile (nickname, country). */
export async function getMlUser(accessToken: string): Promise<MlUser> {
  const res = await fetch(`${ML_API}/users/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`ML /users/me failed: ${res.status}`)
  return res.json()
}

// ── Item fetch (Sprint 2 · import) ────────────────────────────────────────────
// The reference client only published outward; importing the seller's existing
// catalog needs the read side: list the user's active item ids, then fetch each
// item's detail + description. All backend-only (uses the seller's access token).

export type MlPicture = { url?: string; secure_url?: string }
export type MlAttribute = { id?: string; name?: string | null; value_name?: string | null }

/** The raw item shape returned by GET /items/{id} (the fields import cares about). */
export type MlItemDetail = {
  id: string
  title?: string
  category_id?: string
  price?: number | null
  currency_id?: string
  available_quantity?: number
  condition?: string // 'new' | 'used' | ...
  permalink?: string
  status?: string
  pictures?: MlPicture[]
  attributes?: MlAttribute[]
}

export type MlItemsSearchPage = {
  results: string[]
  paging: { total: number; offset: number; limit: number }
}

/**
 * List the seller's active item ids (paginated). `mlUserId` is the ML user id
 * stored on the connection. GET /users/{id}/items/search?status=active.
 */
export async function getSellerItems(
  accessToken: string,
  mlUserId: string,
  opts: { offset?: number; limit?: number } = {},
): Promise<MlItemsSearchPage> {
  const offset = Math.max(0, opts.offset ?? 0)
  const limit = Math.min(50, Math.max(1, opts.limit ?? 50))
  const url = `${ML_API}/users/${encodeURIComponent(mlUserId)}/items/search?status=active&offset=${offset}&limit=${limit}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`ML items/search failed: ${res.status}`)
  const data = (await res.json()) as Partial<MlItemsSearchPage>
  return {
    results: Array.isArray(data.results) ? (data.results.filter((x) => typeof x === 'string') as string[]) : [],
    paging: {
      total: data.paging?.total ?? 0,
      offset: data.paging?.offset ?? offset,
      limit: data.paging?.limit ?? limit,
    },
  }
}

/** Fetch one item's detail. GET /items/{id}. */
export async function getItemDetail(accessToken: string, itemId: string): Promise<MlItemDetail> {
  const res = await fetch(`${ML_API}/items/${encodeURIComponent(itemId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`ML /items/${itemId} failed: ${res.status}`)
  return res.json()
}

/**
 * The order shape the stock sync reads: which ML items a sale touched, and **how
 * many units** of each (the delta we apply to Medusa). `id` is the exactly-once
 * key. Widened (ml-orders-native S1 · US-1) with the fields order materialization
 * needs — `unit_price`/`sale_fee` per line, `buyer`, `pack_id`, `shipping.id`, and
 * `payments[]` — plus an index signature so the FULL raw response round-trips
 * through this type untouched (we persist it verbatim; see the Sprint 1 plan's
 * decision to capture raw payloads rather than guess ML's exact fee/shipping
 * field names from outside a live sandbox).
 */
export type MlOrder = {
  id: string | number
  status?: string
  date_created?: string
  pack_id?: string | number | null
  currency_id?: string
  total_amount?: number
  buyer?: { id?: number | string; nickname?: string; email?: string | null }
  shipping?: { id?: number | string | null }
  order_items?: {
    item?: { id?: string; title?: string }
    quantity?: number
    unit_price?: number
    sale_fee?: number
  }[]
  payments?: Record<string, unknown>[]
  [key: string]: unknown
}

/**
 * Fetch one ML order (Sprint 4 · inbound stock webhook; widened for order
 * materialization in S1). An `orders_v2` notification carries `/orders/{id}`; we
 * read its line items to learn which ML items sold and how many, and (S1) the
 * full response is what gets persisted as `ml_raw_order`. GET /orders/{id}.
 */
export async function getMlOrder(accessToken: string, orderId: string): Promise<MlOrder> {
  const res = await fetch(`${ML_API}/orders/${encodeURIComponent(orderId)}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`ML /orders/${orderId} failed: ${res.status}`)
  return res.json()
}

/**
 * Fetch one ML shipment's detail (ml-orders-native S1 · US-1). An order's
 * `shipping.id` only — the real cost/status lives here. `x-format-new: true` is
 * ML's documented header for the current response shape. Best-effort by
 * contract: the caller must not let a failed shipment fetch block order
 * materialization, so this returns `null` on any failure rather than throwing.
 * GET /shipments/{id}.
 */
export async function getShipmentDetail(
  accessToken: string,
  shippingId: string | number,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${ML_API}/shipments/${encodeURIComponent(String(shippingId))}`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'x-format-new': 'true' },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Aggregate an ML order into per-item sold quantities (summing multiple line
 * items for the same item). Pure — the delta the inbound sync applies to Medusa.
 */
export function normalizeOrderItems(order: MlOrder): { mlItemId: string; quantity: number }[] {
  const byItem = new Map<string, number>()
  for (const oi of order.order_items ?? []) {
    const id = oi?.item?.id
    if (typeof id !== 'string' || !id) continue
    const qty = typeof oi.quantity === 'number' && Number.isFinite(oi.quantity) ? Math.max(0, Math.trunc(oi.quantity)) : 0
    byItem.set(id, (byItem.get(id) ?? 0) + qty)
  }
  return [...byItem.entries()].map(([mlItemId, quantity]) => ({ mlItemId, quantity }))
}

/**
 * Search a seller's recent ML orders (Sprint 4 · reconcile job — the missed-
 * webhook recovery). Returns paid/confirmed orders created since `sinceIso`, most
 * recent first, so the reconcile job can apply any sale whose webhook never
 * arrived (idempotent per order id). GET /orders/search.
 */
export async function searchSellerOrders(
  accessToken: string,
  mlUserId: string,
  sinceIso: string,
  pageLimit = 50,
  maxPages = 10,
): Promise<{ orders: MlOrder[]; truncated: boolean }> {
  const orders: MlOrder[] = []
  let truncated = false
  for (let page = 0; page < maxPages; page++) {
    const url =
      `${ML_API}/orders/search?seller=${encodeURIComponent(mlUserId)}` +
      `&order.date_created.from=${encodeURIComponent(sinceIso)}&sort=date_asc` +
      `&limit=${pageLimit}&offset=${page * pageLimit}`
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) throw new Error(`ML orders/search failed: ${res.status}`)
    const data = (await res.json()) as { results?: MlOrder[] }
    const results = Array.isArray(data.results) ? data.results : []
    orders.push(...results)
    if (results.length < pageLimit) return { orders, truncated: false }
    if (page === maxPages - 1) truncated = true // more orders exist than we paged
  }
  return { orders, truncated }
}

/** Fetch one item's long description (plain text). GET /items/{id}/description. */
export async function getItemDescription(accessToken: string, itemId: string): Promise<string> {
  const res = await fetch(`${ML_API}/items/${encodeURIComponent(itemId)}/description`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) return ''
  const data = (await res.json()) as { plain_text?: string }
  return typeof data.plain_text === 'string' ? data.plain_text : ''
}

/**
 * The sanitised, import-ready item the internal route emits to the frontend —
 * just the fields the supply mapper consumes, plus the dedupe flag. No tokens,
 * no raw ML envelope.
 */
export type MlImportItem = {
  id: string
  title: string
  category_id: string | null
  price: number | null
  currency_id: string | null
  available_quantity: number | null
  condition: string | null
  permalink: string | null
  description: string
  pictures: { url: string }[]
  attributes: { id: string | null; name: string | null; value_name: string | null }[]
  already_linked: boolean
}

// ── Item write (Sprint 3 · publish) ───────────────────────────────────────────
// The reference client only PUBLISHED (create); Sprint 3 adds the write verbs the
// linkage needs to keep an ML item in step with Miyagi: update, status (close /
// pause / reactivate), relist, and the category predictor publish validation needs.
// All backend-only (uses the seller's access token); never logs the token.

/** The free/default ML listing type used when none is configured. */
export const ML_DEFAULT_LISTING_TYPE = process.env.ML_DEFAULT_LISTING_TYPE ?? 'bronze'

/** The payload POST /items accepts (ported from the despachobonsai reference). */
export type MlItemPayload = {
  title: string
  category_id: string
  price: number
  currency_id: string
  available_quantity: number
  buying_mode: 'buy_it_now'
  condition: 'new' | 'used'
  listing_type_id: string
  description?: { plain_text: string }
  pictures?: { source: string }[]
}

/** The fields of an ML item the publish/sync flow reads back + persists. */
export type MlItem = {
  id: string
  title?: string
  permalink?: string
  status?: string
  price?: number
  currency_id?: string
}

/** A ranked ML category candidate from the domain-discovery predictor (US-9). */
export type MlCategoryCandidate = {
  category_id: string
  category_name: string
  /** 0..1 prediction confidence; ML calls it `prediction_probability`. */
  score: number
}

/** Create an ML item. POST /items. (Ported from the reference `publishItem`.) */
export async function publishItem(accessToken: string, item: MlItemPayload): Promise<MlItem> {
  const res = await fetch(`${ML_API}/items`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  })
  if (!res.ok) throw new Error(`ML publish failed: ${res.status}`)
  return res.json()
}

/**
 * ML's error body shape on a rejected write (e.g. `{ message, error, cause:
 * [{ code, message }] }` — a price change ML blocks for an active promotion
 * comes back this way). Best-effort parse: any shape mismatch degrades to
 * `null` rather than throwing while already handling an error.
 */
async function parseMlErrorBody(res: Response): Promise<{ message: string | null; code: string | null } | null> {
  try {
    const body = (await res.json()) as {
      message?: unknown
      error?: unknown
      cause?: Array<{ code?: unknown; message?: unknown }>
    }
    const firstCause = Array.isArray(body.cause) ? body.cause[0] : null
    const message = typeof body.message === 'string' ? body.message
      : typeof firstCause?.message === 'string' ? firstCause.message
      : null
    const code = typeof firstCause?.code === 'string' ? firstCause.code
      : typeof body.error === 'string' ? body.error
      : null
    if (!message && !code) return null
    return { message, code }
  } catch {
    return null
  }
}

/**
 * Update mutable fields of an existing ML item. PUT /items/{id}. A rejection
 * (e.g. price change blocked by an active promotion) surfaces ML's own
 * message/code on the thrown error's `.mlCode`/`.mlMessage` — Apply-price
 * (Sprint 2 · US-5) reports this honestly rather than a generic failure.
 */
export async function updateMlItem(
  accessToken: string,
  itemId: string,
  partial: Partial<Pick<MlItemPayload, 'title' | 'price' | 'available_quantity' | 'pictures'>>,
): Promise<MlItem> {
  const res = await fetch(`${ML_API}/items/${encodeURIComponent(itemId)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(partial),
  })
  if (!res.ok) {
    const parsed = await parseMlErrorBody(res)
    const err = new Error(parsed?.message ? `ML item update rejected: ${parsed.message}` : `ML item update failed: ${res.status}`)
    throw Object.assign(err, { mlCode: parsed?.code ?? null, mlMessage: parsed?.message ?? null })
  }
  return res.json()
}

/** Update an ML item's long description. PUT /items/{id}/description. Best-effort. */
export async function updateMlItemDescription(
  accessToken: string,
  itemId: string,
  plainText: string,
): Promise<void> {
  await fetch(`${ML_API}/items/${encodeURIComponent(itemId)}/description`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ plain_text: plainText }),
  }).catch(() => {})
}

/** Set an ML item's status (close on archive, pause, or reactivate). PUT /items/{id}. */
export async function setMlItemStatus(
  accessToken: string,
  itemId: string,
  status: 'active' | 'paused' | 'closed',
): Promise<MlItem> {
  const res = await fetch(`${ML_API}/items/${encodeURIComponent(itemId)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status }),
  })
  if (!res.ok) throw new Error(`ML item status change failed: ${res.status}`)
  return res.json()
}

/**
 * Relist a previously-closed ML item. The modern path is to reactivate via the
 * status verb (`closed` → `active`); a closed item can be reopened while it has
 * stock. We reuse `setMlItemStatus` so there is one code path for the verb.
 */
export async function relistMlItem(accessToken: string, itemId: string): Promise<MlItem> {
  return setMlItemStatus(accessToken, itemId, 'active')
}

/**
 * Predict valid ML categories for a title (US-9). GET
 * /sites/{site}/domain_discovery/search?q=... returns ranked candidates with a
 * `prediction_probability`. Returns [] on any failure so publish can fall back to
 * the safe default rather than hard-failing.
 */
export async function predictCategory(
  accessToken: string,
  siteId: string,
  query: string,
  limit = 8,
): Promise<MlCategoryCandidate[]> {
  const q = query.trim()
  if (!q) return []
  const url = `${ML_API}/sites/${encodeURIComponent(siteId)}/domain_discovery/search?limit=${limit}&q=${encodeURIComponent(q)}`
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
    if (!res.ok) return []
    const data = (await res.json()) as Array<{
      category_id?: string
      category_name?: string
      prediction_probability?: number
    }>
    if (!Array.isArray(data)) return []
    return data
      .filter((c) => typeof c.category_id === 'string' && c.category_id.length > 0)
      .map((c) => ({
        category_id: c.category_id as string,
        category_name: c.category_name ?? '',
        score: typeof c.prediction_probability === 'number' ? c.prediction_probability : 0,
      }))
  } catch {
    return []
  }
}

// ── Fee estimate (Sprint 2 · US-4, profit-analyzer) ──────────────────────────
// The suggester needs ML's OWN fee rate for a category/listing-type so the
// solve-for-price formula uses a real, not guessed, fee%. GET
// /sites/{site}/listing_prices returns the fee breakdown for a given
// category + listing type (+ a reference price ML evaluates it at).

/** The fee breakdown `GET /sites/{site}/listing_prices` returns for one listing type. */
export type MlListingPrice = {
  listing_type_id?: string
  listing_type_name?: string
  currency_id?: string
  sale_fee_amount?: number
  sale_fee_details?: {
    percentage_fee?: number
    fixed_fee?: number
  }
}

/**
 * Fetch ML's fee breakdown for a category/listing-type at a reference price.
 * GET /sites/{site}/listing_prices?price=&category_id=&listing_type_id=.
 * ML returns EITHER a single object (when `listing_type_id` is given) or an
 * array of per-listing-type objects (when it's omitted) — normalise to the
 * single object the caller asked for (or the first array entry as a
 * fallback, defensively, since the exact shape is unconfirmed against a live
 * sandbox — see LEARNINGS on ML raw-payload verification).
 */
export async function getListingPrices(
  accessToken: string,
  siteId: string,
  opts: { price: number; categoryId: string; listingTypeId: string },
): Promise<MlListingPrice> {
  const url =
    `${ML_API}/sites/${encodeURIComponent(siteId)}/listing_prices` +
    `?price=${encodeURIComponent(String(opts.price))}` +
    `&category_id=${encodeURIComponent(opts.categoryId)}` +
    `&listing_type_id=${encodeURIComponent(opts.listingTypeId)}`
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } })
  if (!res.ok) throw new Error(`ML listing_prices failed: ${res.status}`)
  const data = await res.json()
  if (Array.isArray(data)) return (data[0] ?? {}) as MlListingPrice
  return (data ?? {}) as MlListingPrice
}

/** Narrow a raw ML item detail (+ description, link flag) to the wire shape. */
export function toMlImportItem(
  detail: MlItemDetail,
  description: string,
  alreadyLinked: boolean,
): MlImportItem {
  const pictures = Array.isArray(detail.pictures)
    ? detail.pictures
        .map((p) => p?.secure_url || p?.url)
        .filter((u): u is string => typeof u === 'string' && u.length > 0)
        .map((url) => ({ url }))
    : []
  const attributes = Array.isArray(detail.attributes)
    ? detail.attributes.map((a) => ({
        id: a?.id ?? null,
        name: a?.name ?? null,
        value_name: a?.value_name ?? null,
      }))
    : []
  return {
    id: detail.id,
    title: detail.title ?? '',
    category_id: detail.category_id ?? null,
    price: typeof detail.price === 'number' ? detail.price : null,
    currency_id: detail.currency_id ?? null,
    available_quantity: typeof detail.available_quantity === 'number' ? detail.available_quantity : null,
    condition: detail.condition ?? null,
    permalink: detail.permalink ?? null,
    description: description ?? '',
    pictures,
    attributes,
    already_linked: alreadyLinked,
  }
}
