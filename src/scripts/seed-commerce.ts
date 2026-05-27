import { ExecArgs } from '@medusajs/framework/types'
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils'

export default async function seedCommerce({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const salesChannelService = container.resolve(Modules.SALES_CHANNEL)
  const storeService = container.resolve(Modules.STORE)

  logger.info('Seeding Bonsai Commerce channels...')

  // Default channels representing each marketplace
  const channels = [
    { name: 'Bonsai Storefront', description: 'Bonsai marketplace storefront' },
    { name: 'MercadoLibre', description: 'MercadoLibre marketplace listings' },
    { name: 'Facebook Marketplace', description: 'Facebook Marketplace listings' },
    { name: 'Amazon', description: 'Amazon marketplace listings' },
    { name: 'POS', description: 'Point of sale — offline in-person sales' },
    { name: 'WhatsApp', description: 'Direct WhatsApp catalog sales' },
  ]

  for (const channel of channels) {
    try {
      const existing = await salesChannelService.listSalesChannels({ name: [channel.name] })
      if (existing.length === 0) {
        await salesChannelService.createSalesChannels(channel)
        logger.info(`Created channel: ${channel.name}`)
      } else {
        logger.info(`Channel already exists: ${channel.name}`)
      }
    } catch (err) {
      logger.warn(`Failed to create channel ${channel.name}: ${(err as Error).message}`)
    }
  }

  // Update store name and default currency
  try {
    const [store] = await storeService.listStores({})
    if (store) {
      await storeService.updateStores(store.id, {
        name: 'Bonsai Commerce',
        default_sales_channel_id: undefined,
        supported_currencies: [
          { currency_code: 'usd', is_default: true },
          { currency_code: 'mxn', is_default: false },
          { currency_code: 'ars', is_default: false },
          { currency_code: 'cop', is_default: false },
          { currency_code: 'brl', is_default: false },
          { currency_code: 'clp', is_default: false },
        ],
      })
      logger.info('Store configured: Bonsai Commerce')
    }
  } catch (err) {
    logger.warn(`Store update skipped: ${(err as Error).message}`)
  }

  logger.info('Seed complete.')
}
