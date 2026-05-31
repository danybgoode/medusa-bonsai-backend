import { ModuleProvider, Modules } from '@medusajs/framework/utils'
import { EnviaFulfillmentService } from './service'

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [EnviaFulfillmentService],
})
