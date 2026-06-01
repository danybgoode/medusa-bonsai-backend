import { ModuleProvider, Modules } from '@medusajs/framework/utils'
import SpeiProviderService from './service'

export default ModuleProvider(Modules.PAYMENT, {
  services: [SpeiProviderService as any],
})
