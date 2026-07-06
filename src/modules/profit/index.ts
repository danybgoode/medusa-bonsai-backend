import { Module } from '@medusajs/framework/utils'
import ProfitModuleService from './service'

export const PROFIT_MODULE = 'profit'

export default Module(PROFIT_MODULE, {
  service: ProfitModuleService,
})
