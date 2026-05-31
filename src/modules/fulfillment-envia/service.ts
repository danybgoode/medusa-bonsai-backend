/**
 * Envia.com Medusa Fulfillment Provider.
 *
 * Phase A: registered + quoting via /store/envia/rates endpoint.
 *          canCalculate() → false so Medusa does not invoke calculatePrice
 *          in cart flows — rates are selected at payment time via the
 *          dedicated endpoint.
 *
 * Phase B: createFulfillment() uses the rateId stored in order metadata
 *          to generate an Envia label and return tracking + label URL.
 */

import {
  AbstractFulfillmentProviderService,
} from '@medusajs/framework/utils'
import type {
  CalculatedShippingOptionPrice,
  CalculateShippingOptionPriceDTO,
  CreateFulfillmentResult,
  CreateShippingOptionDTO,
  FulfillmentDTO,
  FulfillmentItemDTO,
  FulfillmentOption,
  FulfillmentOrderDTO,
} from '@medusajs/framework/types'
import { createShipment, type EnviaAddress, type EnviaPackage } from './envia-client'

type FulfillmentData = Record<string, unknown> & {
  rateId?: string
  carrier?: string
  service?: string
  trackingNumber?: string
  labelUrl?: string
  enviaShipmentId?: string
  estimatedDeliveryDate?: string
}

export class EnviaFulfillmentService extends AbstractFulfillmentProviderService {
  static identifier = 'envia'

  // ── Fulfillment options ─────────────────────────────────────────────────────

  async getFulfillmentOptions(): Promise<FulfillmentOption[]> {
    return [
      { id: 'envia-dhl',           carrier: 'dhl',           name: 'DHL' },
      { id: 'envia-fedex',         carrier: 'fedex',         name: 'FedEx' },
      { id: 'envia-estafeta',      carrier: 'estafeta',      name: 'Estafeta' },
      { id: 'envia-ups',           carrier: 'ups',           name: 'UPS' },
      { id: 'envia-redpack',       carrier: 'redpack',       name: 'Redpack' },
      { id: 'envia-paquetexpress', carrier: 'paquetexpress', name: 'Paquetexpress' },
      { id: 'envia-auto',          carrier: 'auto',          name: 'Envia (cualquier paquetería)' },
    ] as FulfillmentOption[]
  }

  async validateFulfillmentData(
    _optionData: Record<string, unknown>,
    data: Record<string, unknown>,
    _context: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return data
  }

  async validateOption(_data: Record<string, unknown>): Promise<boolean> {
    return true
  }

  // Rates are selected at payment time via /store/envia/rates — not via
  // Medusa cart's calculate flow. Return false so admin cannot create
  // a price_type:calculated shipping option that would call calculatePrice.
  async canCalculate(_data: CreateShippingOptionDTO): Promise<boolean> {
    return false
  }

  async calculatePrice(
    _optionData: CalculateShippingOptionPriceDTO['optionData'],
    _data: CalculateShippingOptionPriceDTO['data'],
    _context: CalculateShippingOptionPriceDTO['context'],
  ): Promise<CalculatedShippingOptionPrice> {
    throw new Error(
      'EnviaFulfillmentService: calculatePrice is not used — rates are quoted via /store/envia/rates'
    )
  }

  // ── Phase B: label creation ─────────────────────────────────────────────────

  async createFulfillment(
    data: Record<string, unknown>,
    _items: Partial<Omit<FulfillmentItemDTO, 'fulfillment'>>[],
    _order: Partial<FulfillmentOrderDTO> | undefined,
    fulfillment: Partial<Omit<FulfillmentDTO, 'provider_id' | 'data' | 'items'>>,
  ): Promise<CreateFulfillmentResult> {
    // ── Fast path: shipment already created by the /ship endpoint ────────────
    // The backend ship route calls createShipment() first, then passes the result
    // in fulfillment.metadata.envia_pre_built_shipment so we don't call Envia twice.
    const meta = (fulfillment as any).metadata as Record<string, any> | undefined
    const preBuilt = meta?.envia_pre_built_shipment as Record<string, any> | undefined

    if (preBuilt?.enviaShipmentId || preBuilt?.trackingNumber) {
      return {
        data: {
          enviaShipmentId: preBuilt.enviaShipmentId ?? '',
          carrier: preBuilt.carrier ?? '',
          trackingNumber: preBuilt.trackingNumber ?? null,
          labelUrl: preBuilt.labelUrl ?? null,
          estimatedDeliveryDate: preBuilt.estimatedDeliveryDate ?? null,
          rateId: preBuilt.rateId ?? null,
          status: 'label_created',
          source: 'envia_ship_endpoint',
        },
        labels: preBuilt.trackingNumber
          ? [{
              tracking_number: preBuilt.trackingNumber as string,
              tracking_url: '',
              label_url: (preBuilt.labelUrl ?? '') as string,
            }]
          : [],
      }
    }

    // ── Standard path: create shipment directly (future cart-native flow) ─────
    const d = data as FulfillmentData
    const origin = d.origin as EnviaAddress | undefined
    const destination = d.destination as EnviaAddress | undefined
    const packages = d.packages as EnviaPackage[] | undefined

    if (!d.rateId || !origin || !destination || !packages?.length) {
      console.warn(
        '[envia-fulfillment] createFulfillment: no pre-built shipment and no quote context — label_pending'
      )
      return {
        data: { ...data, status: 'label_pending' },
        labels: [],
      }
    }

    const shipment = await createShipment({
      origin,
      destination,
      packages,
      rateId: d.rateId,
      reference: fulfillment.id,
    })

    return {
      data: {
        ...data,
        enviaShipmentId: shipment.enviaShipmentId,
        carrier: shipment.carrier,
        trackingNumber: shipment.trackingNumber ?? undefined,
        labelUrl: shipment.labelUrl ?? undefined,
        estimatedDeliveryDate: shipment.estimatedDeliveryDate ?? undefined,
        status: 'label_created',
        source: 'envia_provider_direct',
      },
      labels: shipment.trackingNumber
        ? [{
            tracking_number: shipment.trackingNumber,
            tracking_url: '',
            label_url: shipment.labelUrl ?? '',
          }]
        : [],
    }
  }

  async cancelFulfillment(_data: Record<string, unknown>): Promise<any> {
    // Envia shipment cancellation is a manual admin operation for now.
  }

  async createReturnFulfillment(
    _fulfillment: Record<string, unknown>,
  ): Promise<CreateFulfillmentResult> {
    return { data: {}, labels: [] }
  }

  async retrieveDocuments(
    fulfillmentData: Record<string, unknown>,
    _documentType: string,
  ): Promise<any> {
    const d = fulfillmentData as FulfillmentData
    if (d.labelUrl) return [{ url: d.labelUrl, mimeType: 'application/pdf' }]
    return []
  }
}
