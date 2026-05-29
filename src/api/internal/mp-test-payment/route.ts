/**
 * POST /internal/mp-test-payment  (x-internal-secret)
 *
 * Headless marketplace payment test: tokenizes a test card with the connected
 * seller's PUBLIC key and creates a Payments-API payment with the seller's
 * ACCESS token as collector (the exact marketplace/split path), returning MP's
 * raw status_detail. Lets us reproduce the sandbox checkout failure server-side
 * and iterate (buyer email, amount, application_fee, card) via curl — no redeploy.
 *
 * Body: { seller_slug?|seller_id?, buyer_email, amount_cents?, application_fee?,
 *         payment_method_id?, card? }
 *
 * DELETE this endpoint (+ the other /internal/* diagnostics) at go-live.
 */

import { randomUUID } from 'crypto'
import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import { resolveSellerMpToken, getSellerMp } from '../../store/_utils/mp'

const DEFAULT_CARD = {
  card_number: '4075595716483764', // MX Visa test card
  security_code: '123',
  expiration_month: 11,
  expiration_year: 2030,
  cardholder: { name: 'APRO', identification: { type: 'DNI', number: '12345678' } },
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const internalSecret = process.env.MEDUSA_INTERNAL_SECRET
  if (internalSecret && (req.headers['x-internal-secret'] as string | undefined) !== internalSecret) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const body = (req.body ?? {}) as any
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  let seller: any
  if (body.seller_id) {
    const r = await sellerService.listSellers({ id: body.seller_id } as any, { take: 1 })
    seller = r[0]
  } else if (body.seller_slug) {
    const r = await sellerService.listSellers({ slug: body.seller_slug } as any, { take: 1 })
    seller = r[0]
  }
  if (!seller) return res.status(404).json({ message: 'seller not found (pass seller_slug or seller_id)' })

  const token = await resolveSellerMpToken(sellerService, seller)
  const publicKey = getSellerMp(seller).public_key as string | undefined
  if (!token || !publicKey) return res.status(422).json({ message: 'seller missing MP token/public_key', has_token: !!token, has_pk: !!publicKey })

  // 1) tokenize card with the seller's public key
  const ctRes = await fetch(`https://api.mercadopago.com/v1/card_tokens?public_key=${encodeURIComponent(publicKey)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body.card ?? DEFAULT_CARD),
  })
  const ct = await ctRes.json().catch(() => null) as any
  if (!ct?.id) return res.json({ step: 'card_token', http: ctRes.status, response: ct })

  // 2) create the payment as the seller (collector); application_fee = marketplace split
  const payload: Record<string, unknown> = {
    transaction_amount: body.amount_cents ? Number(body.amount_cents) / 100 : 100,
    token: ct.id,
    description: 'mp-test-payment',
    installments: 1,
    payment_method_id: body.payment_method_id ?? 'visa',
    payer: { email: body.buyer_email },
    ...(body.application_fee != null ? { application_fee: Number(body.application_fee) } : {}),
  }
  const payRes = await fetch('https://api.mercadopago.com/v1/payments', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Idempotency-Key': randomUUID() },
    body: JSON.stringify(payload),
  })
  const pay = await payRes.json().catch(() => null) as any

  return res.json({
    seller: { id: seller.id, slug: seller.slug, mp_user_id: getSellerMp(seller).user_id, live_mode: getSellerMp(seller).live_mode },
    card_token: ct.id,
    payment_http: payRes.status,
    payment: pay ? {
      id: pay.id, status: pay.status, status_detail: pay.status_detail,
      error: pay.error, message: pay.message, cause: pay.cause,
    } : null,
  })
}
