/**
 * GET /internal/mp-debug?seller_slug=...|seller_id=...&preference_id=...
 *
 * Diagnostic (x-internal-secret): inspects a MercadoPago preference + its
 * merchant orders / payments using the SELLER's token, to surface why a
 * checkout failed at MP (status_detail, stored preference config). Read-only.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import { resolveSellerMpToken } from '../../store/_utils/mp'

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const internalSecret = process.env.MEDUSA_INTERNAL_SECRET
  if (internalSecret && (req.headers['x-internal-secret'] as string | undefined) !== internalSecret) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const q = req.query as Record<string, string | undefined>
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  let seller: any
  if (q.seller_id) {
    ;[seller] = await sellerService.listSellers({ id: q.seller_id } as any, { take: 1 })
  } else if (q.seller_slug) {
    ;[seller] = await sellerService.listSellers({ slug: q.seller_slug } as any, { take: 1 })
  }
  if (!seller) return res.status(404).json({ message: 'seller not found (pass seller_slug or seller_id)' })

  const token = await resolveSellerMpToken(sellerService, seller)
  if (!token) return res.status(422).json({ message: 'seller has no MP token' })

  const mp = ((seller.metadata?.settings as any)?.mercadopago ?? {}) as Record<string, any>
  const out: Record<string, unknown> = {
    seller: { id: seller.id, slug: seller.slug },
    seller_mp: {
      user_id: mp.user_id,
      connected: mp.connected,
      enabled: mp.enabled,
      live_mode: mp.live_mode,
      expires_at: mp.expires_at,
      has_access_token: !!mp.access_token,
      public_key_prefix: String(mp.public_key ?? '').slice(0, 14),
    },
  }

  const headers = { Authorization: `Bearer ${token}` }

  // Account status of the connected seller — reveals if MP considers the account
  // able to COLLECT (site_status, restrictions, identification, etc.).
  try {
    const me = await fetch('https://api.mercadopago.com/users/me', { headers })
    const meData = await me.json().catch(() => null) as any
    out.account = meData ? {
      http: me.status,
      id: meData.id,
      nickname: meData.nickname,
      site_id: meData.site_id,
      user_type: meData.user_type,
      site_status: meData.site_status,
      status: meData.status,
      tags: meData.tags,
      seller_experience: meData.seller_experience,
      registration_identifiers: meData.registration_identifiers,
    } : { http: me.status }
  } catch (e) { out.account_error = String(e) }

  // Recent payment attempts on this seller's account — shows MP's status_detail
  // (the real reason a checkout failed), no preference_id needed.
  try {
    const ps = await fetch(
      'https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&range=date_created&begin_date=NOW-1DAYS&end_date=NOW&limit=10',
      { headers },
    )
    const psData = await ps.json().catch(() => null) as any
    out.recent_payments_http = ps.status
    out.recent_payments = (psData?.results ?? []).map((p: any) => ({
      id: p.id,
      status: p.status,
      status_detail: p.status_detail,
      amount: p.transaction_amount,
      payment_method: p.payment_method_id,
      payment_type: p.payment_type_id,
      payer_email: p.payer?.email,
      date_created: p.date_created,
      external_reference: p.external_reference,
    }))
    if (psData && !psData.results) out.recent_payments_raw = JSON.stringify(psData).slice(0, 600)
  } catch (e) { out.recent_payments_error = String(e) }

  if (q.preference_id) {
    try {
      const pr = await fetch(`https://api.mercadopago.com/checkout/preferences/${q.preference_id}`, { headers })
      const pref = await pr.json().catch(() => null) as any
      out.preference = pref ? {
        status: pr.status,
        collector_id: pref.collector_id,
        marketplace: pref.marketplace,
        marketplace_fee: pref.marketplace_fee,
        notification_url: pref.notification_url,
        auto_return: pref.auto_return,
        back_urls: pref.back_urls,
        items: pref.items,
        payer: pref.payer,
      } : { status: pr.status, error: 'no body' }
    } catch (e) { out.preference_error = String(e) }

    try {
      const mo = await fetch(`https://api.mercadopago.com/merchant_orders/search?preference_id=${encodeURIComponent(q.preference_id)}`, { headers })
      const data = await mo.json().catch(() => null) as any
      out.merchant_orders = (data?.elements ?? []).map((el: any) => ({
        id: el.id,
        status: el.status,
        order_status: el.order_status,
        total_amount: el.total_amount,
        paid_amount: el.paid_amount,
        payments: (el.payments ?? []).map((p: any) => ({
          id: p.id, status: p.status, status_detail: p.status_detail, amount: p.transaction_amount,
        })),
      }))
    } catch (e) { out.merchant_orders_error = String(e) }
  }

  return res.json(out)
}
