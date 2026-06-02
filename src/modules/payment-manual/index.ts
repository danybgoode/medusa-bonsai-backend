import { ModuleProvider, Modules } from '@medusajs/framework/utils'
import ManualProviderService from './service'

export default ModuleProvider(Modules.PAYMENT, {
  services: [ManualProviderService as any],
})
