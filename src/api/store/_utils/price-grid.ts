export interface PriceGridTier {
  min_quantity: number
  max_quantity: number | null
  amount: number
}

export interface PriceGridVariant {
  id: string
  options: Record<string, string>
  manage_inventory: boolean
  tiers: PriceGridTier[]
}

export interface PriceGridResponse {
  product_id: string
  variants: PriceGridVariant[]
}

/** Project Medusa-native price rows into one market's currency, never a global default. */
export function buildPriceGrid(product: any, currencyCode: string): PriceGridResponse {
  const variants: PriceGridVariant[] = ((product.variants ?? []) as any[])
    .filter((variant) => variant?.metadata?.disabled !== true)
    .map((variant) => {
      const options: Record<string, string> = {}
      for (const value of (variant.options ?? []) as Array<{ value?: string; option?: { title?: string } }>) {
        if (value?.option?.title && value.value != null) options[value.option.title] = value.value
      }
      const tiers = ((variant.prices ?? []) as any[])
        .filter((price) => price.currency_code === currencyCode)
        .map((price) => ({
          min_quantity: price.min_quantity ?? 1,
          max_quantity: price.max_quantity ?? null,
          amount: price.amount,
        }))
        .sort((a, b) => a.min_quantity - b.min_quantity)
      return { id: variant.id, options, manage_inventory: !!variant.manage_inventory, tiers }
    })
  return { product_id: product.id, variants }
}
