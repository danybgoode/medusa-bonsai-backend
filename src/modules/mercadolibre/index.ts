import { Module } from '@medusajs/framework/utils'
import MercadolibreModuleService from './service'

export const MERCADOLIBRE_MODULE = 'mercadolibre'

export default Module(MERCADOLIBRE_MODULE, {
  service: MercadolibreModuleService,
})
