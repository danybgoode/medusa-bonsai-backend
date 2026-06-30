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
