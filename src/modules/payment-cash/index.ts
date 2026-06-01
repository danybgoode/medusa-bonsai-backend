import { ModuleProvider, Modules } from '@medusajs/framework/utils'
import CashProviderService from './service'

export default ModuleProvider(Modules.PAYMENT, {
  services: [CashProviderService as any],
})
