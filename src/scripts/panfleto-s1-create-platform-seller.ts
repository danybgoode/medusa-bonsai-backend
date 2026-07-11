/**
 * Panfleto Sprint 1 (Story 1.1) — create the platform-owned seller that print-ad
 * placements sell through going forward, and transplant the OLD `miyagiprints`
 * seller's Stripe Connect account onto it (same connected account, same real
 * payout destination — no new onboarding, no payment-code change).
 *
 * Idempotent: safe to re-run. If the platform seller row already exists, this
 * only merges in `metadata.settings.stripe` (diffing first) rather than
 * erroring or creating a duplicate.
 *
 *   DRY RUN (default — prints, writes nothing):
 *     npx medusa exec ./src/scripts/panfleto-s1-create-platform-seller.ts
 *   APPLY:
 *     PANFLETO_S1_APPLY=1 npx medusa exec ./src/scripts/panfleto-s1-create-platform-seller.ts
 *
 * This touches production money/entitlement data (a live Stripe Connect account
 * id, copied onto a new seller row). Do NOT run the APPLY form without an
 * explicit, named go from Daniel at the moment of execution — a prior "you're
 * authorized" on the sprint plan does not cover this specific action.
 */

import { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { SELLER_MODULE } from '../modules/seller'
import SellerModuleService from '../modules/seller/service'

const OLD_SELLER_SLUG = 'miyagiprints'
const NEW_SELLER_SLUG = 'miyagi-plataforma'
const NEW_SELLER_NAME = 'Miyagi Sánchez — Plataforma'

export default async function createPlatformSeller({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const sellerService: SellerModuleService = container.resolve(SELLER_MODULE)
  const apply = process.env.PANFLETO_S1_APPLY === '1'

  const [oldSeller] = await sellerService.listSellers({ slug: OLD_SELLER_SLUG } as never, { take: 1 })
  if (!oldSeller) {
    logger.error(`[panfleto-s1] old seller "${OLD_SELLER_SLUG}" not found — ABORT`)
    return
  }

  const oldMeta = (oldSeller.metadata ?? {}) as Record<string, unknown>
  const oldStripe = (oldMeta.settings as Record<string, unknown> | undefined)?.stripe ?? null
  if (!oldStripe) {
    logger.error(`[panfleto-s1] old seller "${OLD_SELLER_SLUG}" has no metadata.settings.stripe to transplant — ABORT`)
    return
  }

  logger.info(`[panfleto-s1] old seller: id=${oldSeller.id} slug=${oldSeller.slug}`)
  logger.info(`[panfleto-s1] stripe to transplant: ${JSON.stringify(oldStripe)}`)

  const [existingNew] = await sellerService.listSellers({ slug: NEW_SELLER_SLUG } as never, { take: 1 })

  if (existingNew) {
    const newMeta = (existingNew.metadata ?? {}) as Record<string, unknown>
    const newStripe = (newMeta.settings as Record<string, unknown> | undefined)?.stripe ?? null
    const inSync = JSON.stringify(newStripe) === JSON.stringify(oldStripe)
    logger.info(`[panfleto-s1] new seller already exists: id=${existingNew.id} slug=${existingNew.slug}`)
    logger.info(`[panfleto-s1] new seller's current stripe metadata: ${JSON.stringify(newStripe)}`)
    logger.info(`[panfleto-s1] in sync with old seller: ${inSync}`)

    if (inSync) {
      logger.info('[panfleto-s1] nothing to do — already up to date.')
      return
    }

    if (!apply) {
      logger.info('[panfleto-s1] DRY RUN — would MERGE stripe metadata onto the existing new seller row. Re-run with PANFLETO_S1_APPLY=1 to apply.')
      return
    }

    const existingSettings = (newMeta.settings as Record<string, unknown>) ?? {}
    await sellerService.updateSellers({
      id: existingNew.id,
      metadata: { ...newMeta, is_platform_seller: true, settings: { ...existingSettings, stripe: oldStripe } },
    })
    logger.info(`[panfleto-s1] DONE — merged stripe metadata onto ${existingNew.id}`)
    return
  }

  const plannedRow = {
    clerk_user_id: null,
    slug: NEW_SELLER_SLUG,
    name: NEW_SELLER_NAME,
    description: null,
    location: null,
    logo_url: null,
    source: 'registered',
    source_url: null,
    verified: false,
    metadata: { is_platform_seller: true, settings: { stripe: oldStripe } },
  }

  logger.info(`[panfleto-s1] would CREATE new seller: ${JSON.stringify(plannedRow, null, 2)}`)

  if (!apply) {
    logger.info('[panfleto-s1] DRY RUN — nothing written. Re-run with PANFLETO_S1_APPLY=1 to apply.')
    return
  }

  const created = await sellerService.createSellers(plannedRow as never)
  logger.info(`[panfleto-s1] DONE — created seller id=${(created as { id: string }).id} slug=${NEW_SELLER_SLUG}`)
}
