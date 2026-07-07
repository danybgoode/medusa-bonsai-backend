/**
 * Splits a product's Medusa Product Categories (a many-to-many relation) into
 * the ONE platform-taxonomy category (Autos, Moda, …) and the seller-defined
 * collections (Die-cut, Zines, …) attached to the same product.
 *
 * Every product carried at most one category until Sprint 2 of
 * own-shop-premium-presentation attached seller collections to the same
 * `product_category_product` pivot — after which a positional `categories[0]`
 * read (the prior convention) can silently return a seller collection instead
 * of the platform category. Seller collection handles are always namespaced
 * `{seller.slug}-{slug}` (see seller-collections.ts), so the prefix check
 * below is what actually disambiguates them — never array order.
 */

export interface CategoryRow {
  id: string
  handle: string
  name?: string
  metadata?: unknown
}

export interface SplitCategories {
  platformCategory: CategoryRow | null
  collections: CategoryRow[]
}

function sortOrder(metadata: unknown): number {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.sort_order
  return typeof raw === 'number' ? raw : Number.MAX_SAFE_INTEGER
}

/**
 * `sellerSlug` is the owning seller's slug (or null/undefined for a product
 * with no resolvable seller, e.g. a support/system product) — a category is a
 * seller collection iff its handle starts with `${sellerSlug}-`; every other
 * attached category is treated as the platform category (if more than one
 * non-prefixed category is ever attached, the first one found wins, same
 * tolerance the prior `[0]` read had — but now a rare edge case instead of a
 * structural guarantee to break).
 */
export function splitCategories(
  categories: CategoryRow[] | null | undefined,
  sellerSlug?: string | null,
): SplitCategories {
  const rows = categories ?? []
  const prefix = sellerSlug ? `${sellerSlug}-` : null

  let platformCategory: CategoryRow | null = null
  const collections: CategoryRow[] = []

  for (const row of rows) {
    if (prefix && row.handle.startsWith(prefix)) {
      collections.push(row)
    } else if (!platformCategory) {
      platformCategory = row
    }
  }

  collections.sort((a, b) => sortOrder(a.metadata) - sortOrder(b.metadata))

  return { platformCategory, collections }
}
