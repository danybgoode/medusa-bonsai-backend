/**
 * Seller-defined product collections (own-shop-premium-presentation S2).
 *
 * A "collection" is a Medusa Product Category (many-to-many with products —
 * see category-split.ts for why Category, not Collection, is the right
 * primitive) owned by exactly one seller via the seller-product-category
 * module link. Handles are namespaced `${seller.slug}-${slug}` because
 * `product_category.handle` carries a GLOBAL unique index shared with the
 * platform's 14-key taxonomy — an unnamespaced "zines" from two different
 * sellers (or matching a platform category like "moda") would collide.
 */

import { Modules, ContainerRegistrationKeys } from '@medusajs/framework/utils'
import type { IProductModuleService } from '@medusajs/framework/types'
import { SELLER_MODULE } from '../../../modules/seller'

export interface SellerCollection {
  id: string
  handle: string
  name: string
  sort_order: number
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

function sortOrder(metadata: unknown): number {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.sort_order
  return typeof raw === 'number' ? raw : Number.MAX_SAFE_INTEGER
}

function toSellerCollection(row: { id: string; handle: string; name: string; metadata?: unknown }): SellerCollection {
  return { id: row.id, handle: row.handle, name: row.name, sort_order: sortOrder(row.metadata) }
}

/** Every collection this seller owns, via the seller↔product_category link, ordered by sort_order. */
export async function listSellerCollections(
  scope: import('@medusajs/framework/http').MedusaRequest['scope'],
  sellerId: string,
): Promise<SellerCollection[]> {
  const remoteQuery = scope.resolve('remoteQuery')
  const { data } = await remoteQuery.graph({
    entity: 'seller',
    fields: ['id', 'product_categories.id', 'product_categories.handle', 'product_categories.name', 'product_categories.metadata'],
    filters: { id: sellerId },
  })
  const rows = (data?.[0] as { product_categories?: Array<{ id: string; handle: string; name: string; metadata?: unknown }> } | undefined)?.product_categories ?? []
  return rows.map(toSellerCollection).sort((a, b) => a.sort_order - b.sort_order)
}

/** Just the id set — the authorization boundary for collection_ids writes on a product. */
export async function resolveOwnedCollectionIds(
  scope: import('@medusajs/framework/http').MedusaRequest['scope'],
  sellerId: string,
): Promise<Set<string>> {
  const collections = await listSellerCollections(scope, sellerId)
  return new Set(collections.map((c) => c.id))
}

export type CreateSellerCollectionResult =
  | { ok: true; collection: SellerCollection }
  | { ok: false; status: number; message: string }

/** Creates a namespaced-handle category and links it to the seller. Collision-suffixes the handle against the global unique index. */
export async function createSellerCollection(
  scope: import('@medusajs/framework/http').MedusaRequest['scope'],
  sellerId: string,
  sellerSlug: string,
  name: string,
): Promise<CreateSellerCollectionResult> {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length < 2) {
    return { ok: false, status: 400, message: 'El nombre de la colección debe tener al menos 2 caracteres.' }
  }
  if (trimmed.length > 60) {
    return { ok: false, status: 400, message: 'El nombre de la colección es demasiado largo.' }
  }

  const productService: IProductModuleService = scope.resolve(Modules.PRODUCT)
  const remoteLink = scope.resolve(ContainerRegistrationKeys.LINK)

  const base = `${sellerSlug}-${slugify(trimmed)}`
  let handle = base
  for (let suffix = 2; suffix <= 20; suffix++) {
    const [existing] = await productService.listProductCategories({ handle })
    if (!existing) break
    handle = `${base}-${suffix}`
  }

  const existingCollections = await listSellerCollections(scope, sellerId)
  const nextSortOrder = existingCollections.length > 0
    ? Math.max(...existingCollections.map((c) => c.sort_order)) + 1
    : 0

  const created = await productService.createProductCategories({
    name: trimmed,
    handle,
    is_active: true,
    metadata: { sort_order: nextSortOrder },
  })

  await remoteLink.create({
    [SELLER_MODULE]: { seller_id: sellerId },
    [Modules.PRODUCT]: { product_category_id: created.id },
  })

  return { ok: true, collection: toSellerCollection(created) }
}

export type MutateSellerCollectionResult =
  | { ok: true }
  | { ok: false; status: number; message: string }

/** Renames a collection this seller owns. The handle is NEVER regenerated — /c/... URLs stay stable across a rename. */
export async function renameSellerCollection(
  scope: import('@medusajs/framework/http').MedusaRequest['scope'],
  sellerId: string,
  collectionId: string,
  name: string,
): Promise<MutateSellerCollectionResult> {
  const trimmed = name.trim()
  if (!trimmed || trimmed.length < 2 || trimmed.length > 60) {
    return { ok: false, status: 400, message: 'El nombre de la colección debe tener entre 2 y 60 caracteres.' }
  }
  const owned = await resolveOwnedCollectionIds(scope, sellerId)
  if (!owned.has(collectionId)) return { ok: false, status: 404, message: 'Colección no encontrada.' }

  const productService: IProductModuleService = scope.resolve(Modules.PRODUCT)
  await productService.updateProductCategories(collectionId, { name: trimmed })
  return { ok: true }
}

/**
 * Batch-writes sort_order for every collection this seller owns, in the
 * given order. `orderedIds` must be exactly this seller's full owned set —
 * rejects on a foreign id AND on a partial list (a live-verified smoke test
 * found that omitting an owned id leaves its old sort_order untouched, which
 * can silently collide with a newly-assigned index from the partial list).
 * The manage UI always sends the complete array (`move()` reorders the full
 * `collections` state), so this is a defense-in-depth guard, not a UX limit.
 */
export async function reorderSellerCollections(
  scope: import('@medusajs/framework/http').MedusaRequest['scope'],
  sellerId: string,
  orderedIds: string[],
): Promise<MutateSellerCollectionResult> {
  const owned = await resolveOwnedCollectionIds(scope, sellerId)
  if (orderedIds.some((id) => !owned.has(id))) {
    return { ok: false, status: 403, message: 'No puedes reordenar una colección que no es tuya.' }
  }
  if (orderedIds.length !== owned.size || new Set(orderedIds).size !== orderedIds.length) {
    return { ok: false, status: 422, message: 'El reordenamiento debe incluir cada colección exactamente una vez.' }
  }

  const productService: IProductModuleService = scope.resolve(Modules.PRODUCT)
  await Promise.all(orderedIds.map((id, index) => {
    const category = productService.retrieveProductCategory(id, { select: ['id', 'metadata'] })
    return category.then((c) =>
      productService.updateProductCategories(id, { metadata: { ...(c.metadata ?? {}), sort_order: index } }),
    )
  }))
  return { ok: true }
}

/** Deletes a collection this seller owns. Only removes the category + its link to products/seller — NEVER touches the products themselves. */
export async function deleteSellerCollection(
  scope: import('@medusajs/framework/http').MedusaRequest['scope'],
  sellerId: string,
  collectionId: string,
): Promise<MutateSellerCollectionResult> {
  const owned = await resolveOwnedCollectionIds(scope, sellerId)
  if (!owned.has(collectionId)) return { ok: false, status: 404, message: 'Colección no encontrada.' }

  const productService: IProductModuleService = scope.resolve(Modules.PRODUCT)
  const remoteLink = scope.resolve(ContainerRegistrationKeys.LINK)

  // Dismiss the seller↔category link BEFORE deleting the category — deleting
  // the category first then dismissing a link to an id that no longer exists
  // is the riskier order.
  await remoteLink.dismiss({
    [SELLER_MODULE]: { seller_id: sellerId },
    [Modules.PRODUCT]: { product_category_id: collectionId },
  })
  await productService.deleteProductCategories([collectionId])
  return { ok: true }
}
