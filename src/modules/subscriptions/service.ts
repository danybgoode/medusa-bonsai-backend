import { MedusaService } from '@medusajs/framework/utils'
import SubscriptionPlan from './models/subscription-plan'
import Subscription from './models/subscription'

class SubscriptionsModuleService extends MedusaService({
  SubscriptionPlan,
  Subscription,
}) {}

export default SubscriptionsModuleService
