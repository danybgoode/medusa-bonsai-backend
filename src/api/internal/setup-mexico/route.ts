/**
 * POST /internal/setup-mexico
 *
 * Idempotent one-time configuration to make this a Mexico-native Medusa instance:
 *   1. Add MXN to the store's supported currencies (set as default)
 *   2. Create a "Mexico" region with currency MXN + country mx
 *   3. Create a Mexico tax region
 *   4. Rename the seeded "European Warehouse" stock location → "México"
 *
 * Run once after deploy. Safe to re-run — each step checks before acting.
 * Auth: x-internal-secret header must match MEDUSA_INTERNAL_SECRET.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'
import {
  createRegionsWorkflow,
  updateRegionsWorkflow,
  createTaxRegionsWorkflow,
} from '@medusajs/medusa/core-flows'

// All payment providers that should be enabled on the Mexico region. Keeping
// pp_system_default for backward-compat with any legacy sessions.
const MX_PAYMENT_PROVIDERS = [
  'pp_system_default',
  'pp_stripe-connect_stripe-connect',
  'pp_mercadopago_mercadopago',
  'pp_spei_spei',
  'pp_cash_cash',
]

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const secret = req.headers['x-internal-secret']
  if (!secret || secret !== process.env.MEDUSA_INTERNAL_SECRET) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const report: string[] = []

  // ── 1. Store: add MXN + set as default ───────────────────────────────────
  const storeService: any = req.scope.resolve(Modules.STORE)
  const [store] = await storeService.listStores({}, { select: ['id', 'supported_currencies'], take: 1 })

  if (!store) {
    return res.status(500).json({ message: 'No store found — seed first' })
  }

  const currencies: Array<{ currency_code: string; is_default?: boolean }> =
    store.supported_currencies ?? []
  const mxnEntry = currencies.find(c => c.currency_code === 'mxn')

  if (!mxnEntry) {
    await storeService.updateStores(store.id, {
      supported_currencies: [
        ...currencies.map(c => ({ ...c, is_default: false })),
        { currency_code: 'mxn', is_default: true },
      ],
    })
    report.push('✓ Added MXN to store currencies (default)')
  } else if (!mxnEntry.is_default) {
    await storeService.updateStores(store.id, {
      supported_currencies: currencies.map(c => ({
        ...c,
        is_default: c.currency_code === 'mxn',
      })),
    })
    report.push('✓ Set MXN as default store currency')
  } else {
    report.push('○ MXN already default — skipped')
  }

  // ── 2. Region: create Mexico / MXN ──────────────────────────────────────
  const regionService: any = req.scope.resolve(Modules.REGION)
  const regions = await regionService.listRegions({})
  const mexicoRegion = regions.find(
    (r: any) => r.name === 'Mexico' || r.currency_code === 'mxn'
  )

  if (!mexicoRegion) {
    await createRegionsWorkflow(req.scope).run({
      input: {
        regions: [{
          name: 'Mexico',
          currency_code: 'mxn',
          countries: ['mx'],
          payment_providers: MX_PAYMENT_PROVIDERS,
        }],
      },
    })
    report.push(`✓ Created Mexico region (MXN, country: mx) with providers: ${MX_PAYMENT_PROVIDERS.join(', ')}`)
  } else {
    // Idempotently ensure ALL providers are enabled on the existing region —
    // prod was created with only pp_system_default, so this is the migration
    // path that turns Stripe/MP/SPEI/Cash into first-class region providers.
    await updateRegionsWorkflow(req.scope).run({
      input: {
        selector: { id: mexicoRegion.id },
        update: { payment_providers: MX_PAYMENT_PROVIDERS },
      },
    })
    report.push(`✓ Mexico region (${mexicoRegion.id}) providers ensured: ${MX_PAYMENT_PROVIDERS.join(', ')}`)
  }

  // ── 3. Tax region: mx ────────────────────────────────────────────────────
  const taxService: any = req.scope.resolve(Modules.TAX)
  const taxRegions = await taxService.listTaxRegions({ country_code: 'mx' })

  if (!taxRegions.length) {
    await createTaxRegionsWorkflow(req.scope).run({
      input: [{ country_code: 'mx', provider_id: 'tp_system' }],
    })
    report.push('✓ Created Mexico tax region')
  } else {
    report.push('○ Mexico tax region already exists — skipped')
  }

  // ── 4. Stock location: rename to México ───────────────────────────────────
  const stockLocationService: any = req.scope.resolve(Modules.STOCK_LOCATION)
  const [location] = await stockLocationService.listStockLocations(
    {},
    { select: ['id', 'name'], take: 1, order: { created_at: 'ASC' } }
  )

  if (!location) {
    report.push('○ No stock location found — run inventory backfill first')
  } else if (location.name !== 'México') {
    await stockLocationService.updateStockLocations(location.id, {
      name: 'México',
      address: {
        city: 'Ciudad de México',
        country_code: 'mx',
        address_1: '',
      },
    })
    report.push(`✓ Renamed stock location "${location.name}" → "México"`)
  } else {
    report.push('○ Stock location already "México" — skipped')
  }

  // ── 5. Update store name ──────────────────────────────────────────────────
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data: storeData } = await query.graph({
    entity: 'store',
    fields: ['id', 'name'],
  })
  const storeRecord = storeData?.[0] as any
  if (storeRecord?.name === 'Default Store') {
    await storeService.updateStores(storeRecord.id, { name: 'Miyagi Sánchez' })
    report.push('✓ Renamed store "Default Store" → "Miyagi Sánchez"')
  } else {
    report.push(`○ Store name "${storeRecord?.name}" — not changed`)
  }

  return res.json({ ok: true, report })
}
