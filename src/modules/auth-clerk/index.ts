import { ModuleProvider, Modules } from '@medusajs/framework/utils'
import ClerkAuthProviderService from './service'

export default ModuleProvider(Modules.AUTH, {
  services: [ClerkAuthProviderService],
})
