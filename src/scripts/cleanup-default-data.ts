/**
 * One-time cleanup of duplicate default Store / Sales Channel / Publishable Key
 * rows created by repeated seed runs against the DB (see Phase 3.3).
 *
 *   DRY RUN (default — prints, deletes nothing):
 *     npx medusa exec ./src/scripts/cleanup-default-data.ts
 *   APPLY:
 *     CLEANUP_APPLY=1 npx medusa exec ./src/scripts/cleanup-default-data.ts
 *
 * Keeps exactly: store "Bonsai Commerce", every configured market publishable key,
 * and EVERY protected sales channel — each registry-declared marketplace/operating
 * channel plus the kept store's default channel (D6 of the market-architecture-
 * foundation epic). Consolidates the remaining product↔channel links onto the kept
 * channel first, runs inside a transaction (rolls back on any FK surprise), and sets
 * the kept store's default_sales_channel_id.
 */

import { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import {
  planProtectedSalesChannels,
  planProtectedPublishableKeys,
} from '../api/internal/_utils/market-protected-resources'

// The MX marketplace channel. Its DISPLAY NAME became "Miyagi Markets MX" in the
// market-architecture-foundation epic; the id is stable and must never change — the
// storefront's only publishable key is linked to it and every product↔channel link
// row points at it.
const KEEP_CHANNEL_ID = 'sc_01KSK1J0V81P4EPY9G0JAPX353' // Miyagi Markets MX (MX marketplace)
const KEEP_STORE_NAME = 'Bonsai Commerce'

export default async function cleanupDefaultData({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
  const apply = process.env.CLEANUP_APPLY === '1'

  const one = async (sql: string, b: any[] = []) => (await knex.raw(sql, b)).rows?.[0]
  const all = async (sql: string, b: any[] = []) => (await knex.raw(sql, b)).rows ?? []

  // Resolve the survivors.
  const keepStore = await one(`select id from store where name = ? limit 1`, [KEEP_STORE_NAME])
  const keepChannel = await one(`select id, name from sales_channel where id = ?`, [KEEP_CHANNEL_ID])
  if (!keepStore || !keepChannel) {
    logger.error(`[cleanup] cannot resolve survivors: store=${keepStore?.id} channel=${keepChannel?.id} — ABORT`)
    return
  }
  const keepStoreId = keepStore.id as string

  const protectedKeys = planProtectedPublishableKeys(process.env)
  if (!protectedKeys.ok) {
    logger.error(`[cleanup] publishable-key population unresolvable — ABORT: ${protectedKeys.blocked_by.join(' | ')}`)
    return
  }
  const protectedKeyRows = await all(
    `select id, token from api_key where type='publishable' and token in (${protectedKeys.tokens.map(() => '?').join(', ')})`,
    [...protectedKeys.tokens],
  )
  if (protectedKeyRows.length !== protectedKeys.tokens.length) {
    logger.error(`[cleanup] only ${protectedKeyRows.length}/${protectedKeys.tokens.length} configured publishable keys resolve — ABORT`)
    return
  }
  const protectedKeyIds = protectedKeyRows.map((row: any) => row.id as string)

  // ── Protected sales channels (epic market-architecture-foundation, D6) ──────
  // This script used to be `delete from sales_channel where id <> KEEP` — one
  // channel survives, everything else goes. That is only correct while exactly one
  // market exists: the moment a second country marketplace has its own channel, a
  // re-run silently deletes it and every product↔channel link row with it.
  //
  // The allow-list is derived from the market registry (never hand-maintained) plus
  // the kept store's own default channel — Medusa refuses to delete a channel that
  // is still a store default, and in production that is a DIFFERENT channel from the
  // marketplace one (a known, harmless divergence). Note this script has never been
  // run against production, so this is a latent-landmine fix, not a live change.
  const [storeDefaultRow] = await all(`select default_sales_channel_id from store where id = ?`, [keepStoreId])
  const channelProtection = planProtectedSalesChannels(
    process.env,
    storeDefaultRow?.default_sales_channel_id ?? null,
  )
  if (!channelProtection.ok) {
    logger.error(`[cleanup] channel population unresolvable — ABORT: ${channelProtection.blocked_by.join(' | ')}`)
    return
  }
  const protectedChannelIds = [...new Set([
    KEEP_CHANNEL_ID,
    ...channelProtection.ids,
  ])]
  // Postgres `not in (?, ?, …)` — one placeholder per protected id.
  const notProtected = (column: string) =>
    `${column} not in (${protectedChannelIds.map(() => '?').join(', ')})`
  const keyNotProtected = (column: string) =>
    `${column} not in (${protectedKeyIds.map(() => '?').join(', ')})`

  const counts = {
    stores: (await one(`select count(*)::int n from store where id <> ?`, [keepStoreId])).n,
    channels: (await one(`select count(*)::int n from sales_channel where ${notProtected('id')}`, protectedChannelIds)).n,
    keys: (await one(`select count(*)::int n from api_key where type='publishable' and ${keyNotProtected('id')}`, protectedKeyIds)).n,
    productsToMove: (await one(`select count(*)::int n from product_sales_channel where ${notProtected('sales_channel_id')}`, protectedChannelIds)).n,
  }

  // Show every table that FK-references sales_channel / store (catch surprises).
  const refTables = await all(`
    select table_name, column_name from information_schema.columns
    where column_name in ('sales_channel_id','store_id')
      and table_name not in ('sales_channel','store')
    order by column_name, table_name`)

  logger.info(`[cleanup] survivors → store=${keepStoreId} channels=[${protectedChannelIds.join(', ')}] keys=[${protectedKeyIds.join(', ')}]`)
  logger.info(`[cleanup] orphans → stores=${counts.stores} channels=${counts.channels} pub_keys=${counts.keys} product-links-to-move=${counts.productsToMove}`)
  logger.info(`[cleanup] FK ref tables: ${refTables.map((r: any) => `${r.table_name}.${r.column_name}`).join(', ')}`)

  if (!apply) {
    logger.info('[cleanup] DRY RUN — nothing deleted. Re-run with CLEANUP_APPLY=1 to apply.')
    return
  }

  await knex.transaction(async (trx: any) => {
    // 1. Consolidate products onto the kept channel (dedupe, then move the rest).
    //    Link rows on a PROTECTED channel are left alone — moving them would strip a
    //    product's membership of another market's marketplace, which is precisely
    //    the publication truth this epic makes load-bearing.
    await trx.raw(
      `delete from product_sales_channel psc where ${notProtected('psc.sales_channel_id')}
         and exists (select 1 from product_sales_channel k where k.product_id = psc.product_id and k.sales_channel_id = ?)`,
      [...protectedChannelIds, KEEP_CHANNEL_ID],
    )
    await trx.raw(
      `update product_sales_channel set sales_channel_id = ? where ${notProtected('sales_channel_id')}`,
      [KEEP_CHANNEL_ID, ...protectedChannelIds],
    )

    // 2. Drop orphan channel/key link rows.
    await trx.raw(
      `delete from publishable_api_key_sales_channel where ${keyNotProtected('publishable_key_id')} or ${notProtected('sales_channel_id')}`,
      [...protectedKeyIds, ...protectedChannelIds],
    )
    await trx.raw(
      `delete from sales_channel_stock_location where ${notProtected('sales_channel_id')}`,
      protectedChannelIds,
    )

    // 3. Delete orphan publishable keys + sales channels.
    await trx.raw(`delete from api_key where type='publishable' and ${keyNotProtected('id')}`, protectedKeyIds)
    await trx.raw(`delete from sales_channel where ${notProtected('id')}`, protectedChannelIds)

    // 4. Delete orphan stores (children first).
    await trx.raw(`delete from store_currency where store_id <> ?`, [keepStoreId])
    await trx.raw(`delete from store_locale where store_id <> ?`, [keepStoreId])
    await trx.raw(`delete from store where id <> ?`, [keepStoreId])

    // 5. Pin the kept store's default channel.
    await trx.raw(`update store set default_sales_channel_id = ? where id = ?`, [KEEP_CHANNEL_ID, keepStoreId])
  })

  const after = {
    stores: (await one(`select count(*)::int n from store`)).n,
    channels: (await one(`select count(*)::int n from sales_channel`)).n,
    keys: (await one(`select count(*)::int n from api_key where type='publishable'`)).n,
    storefrontProducts: (await one(`select count(*)::int n from product_sales_channel where sales_channel_id = ?`, [KEEP_CHANNEL_ID])).n,
  }
  logger.info(`[cleanup] DONE → stores=${after.stores} channels=${after.channels} pub_keys=${after.keys} storefront_products=${after.storefrontProducts}`)
}
