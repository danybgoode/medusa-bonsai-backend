import { MedusaService } from '@medusajs/framework/utils'
import Seller from './models/seller'

class SellerModuleService extends MedusaService({ Seller }) {}

export default SellerModuleService
