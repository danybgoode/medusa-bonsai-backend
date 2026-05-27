import { Module } from '@medusajs/framework/utils'
import SubscriptionsModuleService from './service'

export const SUBSCRIPTIONS_MODULE = 'subscriptions'

export default Module(SUBSCRIPTIONS_MODULE, {
  service: SubscriptionsModuleService,
})
