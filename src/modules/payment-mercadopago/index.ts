import { ModuleProvider, Modules } from '@medusajs/framework/utils'
import MercadoPagoProviderService from './service'

export default ModuleProvider(Modules.PAYMENT, {
  services: [MercadoPagoProviderService as any],
})
