import {
  createSellerCollection,
  renameSellerCollection,
  reorderSellerCollections,
  deleteSellerCollection,
  listSellerCollections,
} from '../seller-collections'

function fakeScope(opts: {
  existingHandles?: string[]
  ownedCategories?: Array<{ id: string; handle: string; name: string; metadata?: unknown }>
}) {
  const existingHandles = new Set(opts.existingHandles ?? [])
  const ownedCategories = opts.ownedCategories ?? []
  const createCalls: unknown[] = []
  const updateCalls: Array<{ id: string; data: unknown }> = []
  const deleteCalls: string[][] = []
  const linkCreateCalls: unknown[] = []
  const linkDismissCalls: unknown[] = []

  const productService = {
    listProductCategories: jest.fn(async (filters?: { handle?: string }) => {
      if (filters?.handle && existingHandles.has(filters.handle)) {
        return [{ id: `cat_${filters.handle}`, handle: filters.handle }]
      }
      return []
    }),
    createProductCategories: jest.fn(async (data: { name: string; handle: string; metadata?: unknown }) => {
      createCalls.push(data)
      return { id: 'cat_new', handle: data.handle, name: data.name, metadata: data.metadata }
    }),
    updateProductCategories: jest.fn(async (id: string, data: unknown) => {
      updateCalls.push({ id, data })
      return { id }
    }),
    deleteProductCategories: jest.fn(async (ids: string[]) => {
      deleteCalls.push(ids)
    }),
    retrieveProductCategory: jest.fn(async (id: string) => {
      const found = ownedCategories.find((c) => c.id === id)
      return { id, metadata: found?.metadata ?? {} }
    }),
  }

  const remoteQuery = {
    graph: jest.fn(async (query: { entity: string }) => {
      if (query.entity === 'seller') {
        return { data: [{ id: 'seller_1', product_categories: ownedCategories }] }
      }
      return { data: [] }
    }),
  }

  const remoteLink = {
    create: jest.fn(async (input: unknown) => { linkCreateCalls.push(input) }),
    dismiss: jest.fn(async (input: unknown) => { linkDismissCalls.push(input) }),
  }

  const scope = {
    resolve: jest.fn((key: string) => {
      if (key === 'remoteQuery') return remoteQuery
      if (key === 'product') return productService
      // ContainerRegistrationKeys.LINK resolves to a symbol/string; accept any key containing "link"
      if (typeof key === 'string' && key.toLowerCase().includes('link')) return remoteLink
      return productService
    }),
  }

  return { scope, productService, remoteLink, createCalls, updateCalls, deleteCalls, linkCreateCalls, linkDismissCalls }
}

describe('createSellerCollection', () => {
  it('namespaces the handle with the seller slug', async () => {
    const { scope, createCalls } = fakeScope({})
    const result = await createSellerCollection(scope as any, 'seller_1', 'miyagiprints', 'Die-cut')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.collection.handle).toBe('miyagiprints-die-cut')
    expect(createCalls).toHaveLength(1)
  })

  it('suffixes the handle on a collision against the global unique index', async () => {
    const { scope } = fakeScope({ existingHandles: ['miyagiprints-zines'] })
    const result = await createSellerCollection(scope as any, 'seller_1', 'miyagiprints', 'Zines')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.collection.handle).toBe('miyagiprints-zines-2')
  })

  it('rejects a name shorter than 2 characters', async () => {
    const { scope } = fakeScope({})
    const result = await createSellerCollection(scope as any, 'seller_1', 'miyagiprints', 'a')
    expect(result.ok).toBe(false)
  })

  it('assigns sort_order after existing collections', async () => {
    const { scope, createCalls } = fakeScope({
      ownedCategories: [{ id: 'cat_a', handle: 'miyagiprints-a', name: 'A', metadata: { sort_order: 0 } }],
    })
    await createSellerCollection(scope as any, 'seller_1', 'miyagiprints', 'Bordados')
    expect((createCalls[0] as { metadata: { sort_order: number } }).metadata.sort_order).toBe(1)
  })
})

describe('renameSellerCollection', () => {
  it('rejects renaming a collection this seller does not own', async () => {
    const { scope } = fakeScope({ ownedCategories: [{ id: 'cat_a', handle: 'miyagiprints-a', name: 'A' }] })
    const result = await renameSellerCollection(scope as any, 'seller_1', 'cat_other', 'New name')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(404)
  })

  it('updates only the name, never the handle', async () => {
    const { scope, updateCalls } = fakeScope({ ownedCategories: [{ id: 'cat_a', handle: 'miyagiprints-a', name: 'A' }] })
    const result = await renameSellerCollection(scope as any, 'seller_1', 'cat_a', 'Renamed')
    expect(result.ok).toBe(true)
    expect(updateCalls[0].data).toEqual({ name: 'Renamed' })
  })
})

describe('reorderSellerCollections', () => {
  it('rejects if any id is not owned by this seller', async () => {
    const { scope } = fakeScope({
      ownedCategories: [{ id: 'cat_a', handle: 'miyagiprints-a', name: 'A' }],
    })
    const result = await reorderSellerCollections(scope as any, 'seller_1', ['cat_a', 'cat_foreign'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(403)
  })

  it('writes sort_order in the given order for owned ids', async () => {
    const { scope, updateCalls } = fakeScope({
      ownedCategories: [
        { id: 'cat_a', handle: 'miyagiprints-a', name: 'A', metadata: { sort_order: 0 } },
        { id: 'cat_b', handle: 'miyagiprints-b', name: 'B', metadata: { sort_order: 1 } },
      ],
    })
    const result = await reorderSellerCollections(scope as any, 'seller_1', ['cat_b', 'cat_a'])
    expect(result.ok).toBe(true)
    const orders = updateCalls.map((c) => [c.id, (c.data as { metadata: { sort_order: number } }).metadata.sort_order])
    expect(orders).toEqual(expect.arrayContaining([['cat_b', 0], ['cat_a', 1]]))
  })

  it('rejects a PARTIAL list — a live smoke test found this silently collides sort_order with the omitted item', async () => {
    const { scope } = fakeScope({
      ownedCategories: [
        { id: 'cat_a', handle: 'miyagiprints-a', name: 'A', metadata: { sort_order: 0 } },
        { id: 'cat_b', handle: 'miyagiprints-b', name: 'B', metadata: { sort_order: 1 } },
        { id: 'cat_c', handle: 'miyagiprints-c', name: 'C', metadata: { sort_order: 2 } },
      ],
    })
    // Omits cat_c entirely.
    const result = await reorderSellerCollections(scope as any, 'seller_1', ['cat_b', 'cat_a'])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.status).toBe(422)
  })

  it('rejects a list with a duplicate id', async () => {
    const { scope } = fakeScope({
      ownedCategories: [
        { id: 'cat_a', handle: 'miyagiprints-a', name: 'A' },
        { id: 'cat_b', handle: 'miyagiprints-b', name: 'B' },
      ],
    })
    const result = await reorderSellerCollections(scope as any, 'seller_1', ['cat_a', 'cat_a'])
    expect(result.ok).toBe(false)
  })
})

describe('deleteSellerCollection', () => {
  it('rejects deleting a collection this seller does not own', async () => {
    const { scope } = fakeScope({ ownedCategories: [{ id: 'cat_a', handle: 'miyagiprints-a', name: 'A' }] })
    const result = await deleteSellerCollection(scope as any, 'seller_1', 'cat_other')
    expect(result.ok).toBe(false)
  })

  it('dismisses the link before deleting the category', async () => {
    const { scope, linkDismissCalls, deleteCalls } = fakeScope({
      ownedCategories: [{ id: 'cat_a', handle: 'miyagiprints-a', name: 'A' }],
    })
    const result = await deleteSellerCollection(scope as any, 'seller_1', 'cat_a')
    expect(result.ok).toBe(true)
    expect(linkDismissCalls).toHaveLength(1)
    expect(deleteCalls).toEqual([['cat_a']])
  })
})

describe('listSellerCollections', () => {
  it('sorts by sort_order', async () => {
    const { scope } = fakeScope({
      ownedCategories: [
        { id: 'cat_b', handle: 'miyagiprints-b', name: 'B', metadata: { sort_order: 1 } },
        { id: 'cat_a', handle: 'miyagiprints-a', name: 'A', metadata: { sort_order: 0 } },
      ],
    })
    const collections = await listSellerCollections(scope as any, 'seller_1')
    expect(collections.map((c) => c.handle)).toEqual(['miyagiprints-a', 'miyagiprints-b'])
  })
})
