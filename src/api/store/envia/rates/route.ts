/**
 * POST /store/envia/rates
 *
 * Quotes Envia.com shipping rates for a listing.
 * All Envia API calls originate from this backend route — the Next.js
 * checkout/shipping-rates route proxies here.
 *
 * No auth required — rate quoting is public commerce functionality.
 *
 * Body:
 *   listingId   string          Medusa product ID
 *   items?      string[]        Multiple listing IDs (bundle)
 *   address     {
 *     name, phone, line1, line2,
 *     city, state, state_code, postal_code
 *   }
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../../modules/seller'
import SellerModuleService from '../../../../modules/seller/service'
import { quoteShipments, mapEnviaError, type EnviaAddress, type EnviaPackage } from '../../../../modules/fulfillment-envia/envia-client'
import { toEnviaStateCode } from '../../../../modules/fulfillment-envia/mx-state-codes'

const DEFAULT_CARRIERS = ['dhl', 'fedex', 'estafeta', 'ups', 'redpack', 'paquetexpress']

type IncomingAddress = {
  name?: string
  phone?: string
  line1?: string
  line2?: string
  city?: string
  state?: string
  state_code?: string
  postal_code?: string
}

type ShippingSettings = {
  envia_enabled?: boolean
  allowed_carriers?: string[]
  rate_display?: 'recommended' | 'cheapest' | 'all'
  handling_fee_cents?: number
  package_defaults?: {
    weight_grams?: number
    length_cm?: number
    width_cm?: number
    height_cm?: number
  }
  origin_address?: {
    name?: string | null
    street?: string | null
    number?: string | null
    colonia?: string | null
    city?: string | null
    state?: string | null
    state_code?: string | null
    postal_code?: string | null
  }
}

function addressReady(a: IncomingAddress) {
  return Boolean(
    a.name?.trim() &&
    a.line1?.trim() &&
    a.city?.trim() &&
    (a.state_code?.trim() || a.state?.trim()) &&
    a.postal_code?.trim()
  )
}

function deliveryLabel(days: number | null) {
  if (!days || days <= 0) return null
  return days === 1 ? '1 dia habil' : `${days} dias habiles`
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const body = req.body as {
    listingId?: string
    items?: string[]
    address?: IncomingAddress
  }

  if (!body.address || !addressReady(body.address)) {
    return res.status(422).json({ error: 'Completa la dirección de entrega.' })
  }

  const listingIds: string[] = body.items?.length
    ? body.items
    : body.listingId
      ? [body.listingId]
      : []

  if (!listingIds.length) {
    return res.status(400).json({ error: 'listingId o items requerido.' })
  }

  const remoteQuery = req.scope.resolve('remoteQuery') as any
  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)

  // ── Resolve products from Medusa ──────────────────────────────────────────
  let products: any[] = []
  try {
    const { data } = await remoteQuery.graph({
      entity: 'product',
      fields: ['id', 'title', 'metadata', 'variants.prices.*'],
      filters: { id: listingIds },
    })
    products = data ?? []
  } catch (err) {
    console.error('[envia/rates] product lookup failed:', err)
    return res.status(404).json({ error: 'Anuncio no encontrado.' })
  }

  // Filter to physical products (listing_type = product)
  const shippable = products.filter((p: any) => {
    const meta = (p.metadata ?? {}) as Record<string, unknown>
    const t = meta.listing_type as string | undefined
    return !t || t === 'product'
  })

  if (!shippable.length) {
    return res.status(422).json({ error: 'Ningún artículo requiere envío por paquetería.' })
  }

  // ── Resolve seller + shipping settings via first product ──────────────────
  let sellerMeta: Record<string, unknown> = {}
  try {
    const allSellers = await sellerService.listSellers({}, { take: 1000 })
    // Find which seller owns the first product
    for (const seller of allSellers) {
      const { data: rows } = await remoteQuery.graph({
        entity: 'seller',
        fields: ['id', 'products.id'],
        filters: { id: seller.id },
      })
      const productIds = ((rows?.[0] as any)?.products ?? []).map((p: any) => p.id as string)
      if (productIds.includes(shippable[0].id)) {
        sellerMeta = (seller.metadata ?? {}) as Record<string, unknown>
        break
      }
    }
  } catch (err) {
    console.warn('[envia/rates] seller lookup failed:', err)
  }

  const settings = (sellerMeta.settings ?? {}) as Record<string, unknown>
  const shipping = (settings.shipping ?? {}) as ShippingSettings
  const originRaw = shipping.origin_address

  if (shipping.envia_enabled === false) {
    return res.status(422).json({ error: 'El vendedor no tiene envío a domicilio activo.' })
  }
  if (!originRaw?.street || !originRaw.city || !originRaw.postal_code) {
    return res.status(422).json({ error: 'El vendedor todavía no completó su dirección de origen. Coordina la entrega directamente.' })
  }
  if (!originRaw.state && !originRaw.state_code) {
    return res.status(422).json({ error: 'El vendedor todavía no completó su dirección de origen. Coordina la entrega directamente.' })
  }

  const origin: EnviaAddress = {
    name: originRaw.name ?? 'Vendedor',
    street: originRaw.street,
    number: originRaw.number ?? undefined,
    district: originRaw.colonia ?? undefined,
    city: originRaw.city,
    state: toEnviaStateCode(originRaw.state_code ?? originRaw.state ?? ''),
    country: 'MX',
    postalCode: originRaw.postal_code,
  }

  const destStateCode = body.address.state_code
    ? body.address.state_code
    : toEnviaStateCode(body.address.state ?? '')

  const destination: EnviaAddress = {
    name: body.address.name ?? 'Comprador',
    phone: body.address.phone,
    street: body.address.line1 ?? '',
    district: body.address.line2,
    city: body.address.city ?? '',
    state: destStateCode,
    country: 'MX',
    postalCode: body.address.postal_code ?? '',
  }

  const pkgDefaults = shipping.package_defaults ?? {}
  const carriers = shipping.allowed_carriers?.length ? shipping.allowed_carriers : DEFAULT_CARRIERS
  const handlingFeeCents = Math.max(0, Math.round(shipping.handling_fee_cents ?? 0))
  const rateDisplay = shipping.rate_display ?? 'recommended'

  const packages: EnviaPackage[] = shippable.map((p: any) => {
    const meta = (p.metadata ?? {}) as Record<string, unknown>
    const weightGrams = (meta.weight_grams as number | undefined) ?? pkgDefaults.weight_grams ?? 500
    const priceVariant = (p.variants?.[0]?.prices?.[0]?.amount as number | undefined)
    return {
      content: String(p.title ?? 'Producto').slice(0, 80),
      weight: Math.max(0.1, weightGrams / 1000),
      declaredValue: priceVariant ? Math.round(priceVariant / 100) : 0,
      dimensions: {
        length: Math.max(1, pkgDefaults.length_cm ?? 20),
        width:  Math.max(1, pkgDefaults.width_cm  ?? 15),
        height: Math.max(1, pkgDefaults.height_cm ?? 10),
      },
    }
  })

  try {
    const rates = await quoteShipments({ origin, destination, carriers, packages })

    const normalized = rates
      .filter(r => r.rateId && r.carrier && r.service && r.totalPrice > 0)
      .map(r => ({
        id: `${r.carrier}:${r.service}:${r.rateId}`,
        rateId: r.rateId,
        carrier: r.carrier,
        service: r.service,
        baseAmountCents: Math.round(r.totalPrice * 100),
        handlingFeeCents,
        amountCents: Math.round(r.totalPrice * 100) + handlingFeeCents,
        currency: r.currency || 'MXN',
        deliveryEstimate: r.deliveryEstimate,
        deliveryLabel: deliveryLabel(r.deliveryEstimate),
        logoUrl: r.logoUrl ?? null,
      }))
      .sort((a, b) =>
        a.amountCents !== b.amountCents
          ? a.amountCents - b.amountCents
          : (a.deliveryEstimate ?? 99) - (b.deliveryEstimate ?? 99)
      )

    if (normalized.length === 0) {
      return res.json({
        rates: [],
        package_count: packages.length,
        message: 'Las paqueterías no tienen cobertura para ese destino. Puedes coordinar la entrega directamente con el vendedor.',
      })
    }

    const visible = rateDisplay === 'cheapest'
      ? normalized.slice(0, 1)
      : rateDisplay === 'all'
        ? normalized.slice(0, 8)
        : normalized.slice(0, 3)

    return res.json({ rates: visible, package_count: packages.length })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[envia/rates] quote failed:', msg)
    return res.status(502).json({ error: mapEnviaError(msg) })
  }
}
