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

/** Swap a refresh token for a fresh access + refresh token pair. */
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
  if (!res.ok) throw new Error(`ML token refresh failed: ${res.status}`)
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
