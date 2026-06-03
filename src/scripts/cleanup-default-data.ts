/**
 * One-time cleanup of duplicate default Store / Sales Channel / Publishable Key
 * rows created by repeated seed runs against the DB (see Phase 3.3).
 *
 *   DRY RUN (default — prints, deletes nothing):
 *     npx medusa exec ./src/scripts/cleanup-default-data.ts
 *   APPLY:
 *     CLEANUP_APPLY=1 npx medusa exec ./src/scripts/cleanup-default-data.ts
 *
 * Keeps exactly: store "Bonsai Commerce", channel "Miyagi Sánchez Storefront",
 * and the publishable key pk_bac9d8ced544f. Consolidates ALL product↔channel
 * links onto the kept channel first, runs inside a transaction (rolls back on any
 * FK surprise), and sets the kept store's default_sales_channel_id.
 */

import { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'

const KEEP_CHANNEL_ID = 'sc_01KSK1J0V81P4EPY9G0JAPX353' // Miyagi Sánchez Storefront
const KEEP_KEY_PREFIX = 'pk_bac9d8ced544'               // active storefront publishable key
const KEEP_STORE_NAME = 'Bonsai Commerce'

export default async function cleanupDefaultData({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION) as any
  const apply = process.env.CLEANUP_APPLY === '1'

  const one = async (sql: string, b: any[] = []) => (await knex.raw(sql, b)).rows?.[0]
  const all = async (sql: string, b: any[] = []) => (await knex.raw(sql, b)).rows ?? []

  // Resolve the survivors.
  const keepKey = await one(`select id from api_key where type='publishable' and token like ? limit 1`, [`${KEEP_KEY_PREFIX}%`])
  const keepStore = await one(`select id from store where name = ? limit 1`, [KEEP_STORE_NAME])
  const keepChannel = await one(`select id, name from sales_channel where id = ?`, [KEEP_CHANNEL_ID])
  if (!keepKey || !keepStore || !keepChannel) {
    logger.error(`[cleanup] cannot resolve survivors: key=${keepKey?.id} store=${keepStore?.id} channel=${keepChannel?.id} — ABORT`)
    return
  }
  const keepKeyId = keepKey.id as string
  const keepStoreId = keepStore.id as string

  const counts = {
    stores: (await one(`select count(*)::int n from store where id <> ?`, [keepStoreId])).n,
    channels: (await one(`select count(*)::int n from sales_channel where id <> ?`, [KEEP_CHANNEL_ID])).n,
    keys: (await one(`select count(*)::int n from api_key where type='publishable' and id <> ?`, [keepKeyId])).n,
    productsToMove: (await one(`select count(*)::int n from product_sales_channel where sales_channel_id <> ?`, [KEEP_CHANNEL_ID])).n,
  }

  // Show every table that FK-references sales_channel / store (catch surprises).
  const refTables = await all(`
    select table_name, column_name from information_schema.columns
    where column_name in ('sales_channel_id','store_id')
      and table_name not in ('sales_channel','store')
    order by column_name, table_name`)

  logger.info(`[cleanup] survivors → store=${keepStoreId} channel=${KEEP_CHANNEL_ID} key=${keepKeyId}`)
  logger.info(`[cleanup] orphans → stores=${counts.stores} channels=${counts.channels} pub_keys=${counts.keys} product-links-to-move=${counts.productsToMove}`)
  logger.info(`[cleanup] FK ref tables: ${refTables.map((r: any) => `${r.table_name}.${r.column_name}`).join(', ')}`)

  if (!apply) {
    logger.info('[cleanup] DRY RUN — nothing deleted. Re-run with CLEANUP_APPLY=1 to apply.')
    return
  }

  await knex.transaction(async (trx: any) => {
    // 1. Consolidate products onto the kept channel (dedupe, then move the rest).
    await trx.raw(
      `delete from product_sales_channel psc where psc.sales_channel_id <> ?
         and exists (select 1 from product_sales_channel k where k.product_id = psc.product_id and k.sales_channel_id = ?)`,
      [KEEP_CHANNEL_ID, KEEP_CHANNEL_ID],
    )
    await trx.raw(`update product_sales_channel set sales_channel_id = ? where sales_channel_id <> ?`, [KEEP_CHANNEL_ID, KEEP_CHANNEL_ID])

    // 2. Drop orphan channel/key link rows.
    await trx.raw(`delete from publishable_api_key_sales_channel where publishable_key_id <> ? or sales_channel_id <> ?`, [keepKeyId, KEEP_CHANNEL_ID])
    await trx.raw(`delete from sales_channel_stock_location where sales_channel_id <> ?`, [KEEP_CHANNEL_ID])

    // 3. Delete orphan publishable keys + sales channels.
    await trx.raw(`delete from api_key where type='publishable' and id <> ?`, [keepKeyId])
    await trx.raw(`delete from sales_channel where id <> ?`, [KEEP_CHANNEL_ID])

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
