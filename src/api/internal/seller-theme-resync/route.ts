/**
 * /internal/seller-theme-resync — repair a shop whose CHOSEN look never reached
 * its storefront.
 *
 * ── THE FAILURE THIS REPAIRS ─────────────────────────────────────────────────
 *
 * A shop's settings live in TWO places. The seller portal writes
 * `marketplace_shops.metadata.settings` (Supabase) and then syncs the whole blob
 * into this seller's `metadata.settings`. The PUBLIC storefront reads only the
 * copy here. Until 2026-08-19 that sync was wrapped in a swallowing try/catch and
 * the portal answered "saved" either way — so any failure left the merchant's
 * choice stranded in Supabase, invisible, with a success message on screen.
 *
 * Found in production: `theme_preset` was set for three shops in Supabase and
 * present here for one. Two merchants had been served a storefront that ignored
 * the look they picked, for weeks. The portal now reports the sync outcome
 * honestly, which stops NEW divergence; this route closes the ones already there.
 *
 * ── WHY IT IS THIS NARROW ────────────────────────────────────────────────────
 *
 * It writes exactly one key — `settings.theme_preset` — and nothing else. A
 * general "overwrite this seller's settings" endpoint would be a far larger
 * blast radius for a one-field repair, and the next divergence deserves its own
 * deliberate route rather than a loaded gun left lying around.
 *
 *   GET  — read-only. Reports the current value for the named slugs. No writes.
 *   POST — sets `settings.theme_preset` for each named slug, idempotently.
 *
 * Metadata is merged, never replaced: `updateSellers` MERGES metadata (a known
 * trap in this codebase — a `delete` on a key does not clear it), so the whole
 * `settings` object is read, one key is changed, and the result is written back.
 *
 * Auth: `x-internal-secret` must match `MEDUSA_INTERNAL_SECRET`, and a MISSING
 * secret DENIES. This route changes what a merchant's public storefront looks
 * like; "the deploy is misconfigured" is exactly when it must not be open.
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { SELLER_MODULE } from '../../../modules/seller'
import SellerModuleService from '../../../modules/seller/service'
import { internalSecretOk } from '../../../lib/internal-auth'

/** The complete set of looks a shop may have. Anything else is refused. */
const KNOWN_PRESETS = new Set(['papel', 'pizarra', 'lienzo', 'terracota', 'retro'])

interface ResyncEntry {
  slug: string
  /** A known preset key, or null to clear the look back to the default. */
  theme_preset: string | null
}

function readSettings(seller: { metadata?: unknown }): Record<string, unknown> {
  const meta = (seller.metadata ?? {}) as Record<string, unknown>
  const settings = meta.settings
  return settings && typeof settings === 'object' && !Array.isArray(settings)
    ? { ...(settings as Record<string, unknown>) }
    : {}
}

export async function GET(req: MedusaRequest, res: MedusaResponse) {
  if (!internalSecretOk(req)) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  const slugs = String((req.query.slugs as string) ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (slugs.length === 0) return res.status(400).json({ error: 'slugs query parameter is required' })

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const report = await Promise.all(slugs.map(async (slug) => {
    const [seller] = await sellerService.listSellers({ slug }, { take: 1 })
    if (!seller) return { slug, found: false as const }
    return { slug, found: true as const, theme_preset: readSettings(seller).theme_preset ?? null }
  }))
  return res.json({ dry_run: true, sellers: report })
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  if (!internalSecretOk(req)) {
    return res.status(401).json({ error: 'unauthorized' })
  }

  const body = req.body as { entries?: ResyncEntry[] }
  const entries = Array.isArray(body?.entries) ? body.entries : []
  if (entries.length === 0) return res.status(400).json({ error: 'entries[] is required' })

  // VALIDATE FIRST, APPLY SECOND — validation is pure, so nothing is written
  // until every entry is known good. A half-applied repair is worse than none.
  for (const entry of entries) {
    if (!entry?.slug || typeof entry.slug !== 'string') {
      return res.status(422).json({ error: 'each entry needs a slug' })
    }
    if (entry.theme_preset !== null && !KNOWN_PRESETS.has(entry.theme_preset)) {
      return res.status(422).json({
        error: `unknown theme_preset "${entry.theme_preset}" for ${entry.slug}`,
        known: [...KNOWN_PRESETS],
      })
    }
  }

  const sellerService: SellerModuleService = req.scope.resolve(SELLER_MODULE)
  const applied: Array<Record<string, unknown>> = []

  for (const entry of entries) {
    const [seller] = await sellerService.listSellers({ slug: entry.slug }, { take: 1 })
    if (!seller) {
      applied.push({ slug: entry.slug, ok: false, reason: 'seller_not_found' })
      continue
    }
    const before = readSettings(seller).theme_preset ?? null
    const settings = readSettings(seller)
    if (entry.theme_preset === null) delete settings.theme_preset
    else settings.theme_preset = entry.theme_preset

    await sellerService.updateSellers({
      id: seller.id,
      // Merge, do not replace: `updateSellers` merges metadata, and the seller's
      // other metadata (operating market, medusa ids) must survive untouched.
      metadata: { ...((seller.metadata ?? {}) as Record<string, unknown>), settings },
    })

    // Read back rather than trusting the write — the whole reason this route
    // exists is that a write nobody verified was reported as success.
    const [after] = await sellerService.listSellers({ slug: entry.slug }, { take: 1 })
    const now = readSettings(after ?? {}).theme_preset ?? null
    applied.push({
      slug: entry.slug,
      ok: now === entry.theme_preset,
      before,
      after: now,
      requested: entry.theme_preset,
    })
  }

  const complete = applied.every((a) => a.ok === true)
  return res.status(complete ? 200 : 207).json({ complete, applied })
}
