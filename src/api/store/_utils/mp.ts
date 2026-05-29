/**
 * MercadoPago marketplace helpers (backend).
 *
 * Seller MP credentials live in seller.metadata.settings.mercadopago (synced
 * from the frontend OAuth flow). Checkout, the IPN handler, reconciliation, and
 * refunds all create/verify payments ON BEHALF OF the seller using the seller's
 * access token — never the platform token — so funds settle to the seller's
 * own MP account. The token never leaves the backend.
 */

const MP_OAUTH_TOKEN_URL = 'https://api.mercadopago.com/oauth/token'

/** Platform commission as a fraction of the order total. 0 = match Stripe (0% fee). */
export const MP_MARKETPLACE_FEE_RATE = 0

export interface SellerMpSettings {
  user_id?: string | number
  access_token?: string
  refresh_token?: string
  public_key?: string
  expires_at?: string
  connected?: boolean
  enabled?: boolean
  live_mode?: boolean
}

export function getSellerMp(seller: any): SellerMpSettings {
  const settings = (seller?.metadata?.settings ?? {}) as Record<string, any>
  return (settings.mercadopago ?? {}) as SellerMpSettings
}

export function sellerMpConnected(seller: any): boolean {
  const mp = getSellerMp(seller)
  // Gate on connected + token only. No pause-MP UI exists; the legacy `enabled`
  // flag (set false by Desconectar) only caused reconnects to be wrongly blocked.
  return !!(mp.connected && mp.access_token)
}

/**
 * Returns a valid MP access token for the seller, transparently refreshing and
 * persisting it when within 7 days of expiry. Returns null if the seller has no
 * token. Falls back to the existing token if refresh isn't possible.
 */
export async function resolveSellerMpToken(sellerService: any, seller: any): Promise<string | null> {
  const mp = getSellerMp(seller)
  if (!mp.access_token) return null

  const expMs = mp.expires_at ? Date.parse(mp.expires_at) : 0
  const needsRefresh = expMs > 0 && expMs - Date.now() < 7 * 24 * 60 * 60 * 1000
  if (!needsRefresh || !mp.refresh_token) return mp.access_token

  const clientId = process.env.MP_CLIENT_ID
  const clientSecret = process.env.MP_CLIENT_SECRET
  if (!clientId || !clientSecret) return mp.access_token // can't refresh — use existing

  try {
    const res = await fetch(MP_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: mp.refresh_token,
      }),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok || !json?.access_token) {
      console.error('[mp] token refresh failed:', json)
      return mp.access_token
    }
    const updated: SellerMpSettings = {
      ...mp,
      access_token: json.access_token,
      refresh_token: json.refresh_token ?? mp.refresh_token,
      expires_at: new Date(Date.now() + (json.expires_in ?? 0) * 1000).toISOString(),
    }
    const settings = { ...((seller.metadata as any)?.settings ?? {}), mercadopago: updated }
    await sellerService.updateSellers(seller.id, { metadata: { ...(seller.metadata ?? {}), settings } })
    return updated.access_token ?? null
  } catch (e) {
    console.error('[mp] token refresh error:', e)
    return mp.access_token
  }
}

/** Fetch a payment by id using a specific seller access token. */
export async function getMpPaymentWithToken(paymentId: string, accessToken: string): Promise<any | null> {
  try {
    const res = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}
