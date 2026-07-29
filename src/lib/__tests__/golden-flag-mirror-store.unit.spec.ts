import type { FlagSnapshot } from '@golden-beans/sdk'

type RpcResult = {
  data: { accepted: boolean; current_snapshot_version: number }[] | null
  error: unknown
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

const mockRpc = jest.fn<Promise<RpcResult>, [string, Record<string, unknown>]>()
const mockMaybeSingle = jest.fn()
const mockQuery = {
  select: jest.fn(),
  eq: jest.fn(),
  maybeSingle: mockMaybeSingle,
}
const mockFrom = jest.fn(() => mockQuery)

mockQuery.select.mockReturnValue(mockQuery)
mockQuery.eq.mockReturnValue(mockQuery)

jest.mock('../../api/store/_utils/supabase-read', () => ({
  supabaseRead: {
    from: mockFrom,
    rpc: mockRpc,
  },
}))

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function snapshot(snapshotVersion: number): FlagSnapshot {
  return {
    contractVersion: 1,
    environment: 'production',
    snapshotVersion,
    flags: [
      {
        key: 'checkout.stripe_enabled',
        definitionVersion: snapshotVersion,
        definition: {
          valueType: 'boolean',
          description: `Snapshot ${snapshotVersion}`,
          defaultVariantKey: 'off',
          variants: [
            { key: 'off', value: false },
            { key: 'on', value: true },
          ],
          rules: [],
        },
      },
    ],
  }
}

function accepted(snapshotVersion: number): RpcResult {
  return {
    data: [{ accepted: true, current_snapshot_version: snapshotVersion }],
    error: null,
  }
}

function rejected(currentSnapshotVersion: number): RpcResult {
  return {
    data: [{ accepted: false, current_snapshot_version: currentSnapshotVersion }],
    error: null,
  }
}

function loadStore(): typeof import('../golden-flag-mirror-store') {
  jest.resetModules()
  return require('../golden-flag-mirror-store')
}

async function flushPersistence(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('Golden flag durable mirror store monotonicity', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      GOLDEN_BEANS_FLAG_ENVIRONMENT: 'production',
    }
    jest.clearAllMocks()
    mockQuery.select.mockReturnValue(mockQuery)
    mockQuery.eq.mockReturnValue(mockQuery)
    mockRpc.mockResolvedValue(accepted(1))
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it('never lets an older provider snapshot replace a newer in-memory snapshot', async () => {
    const store = loadStore()
    mockRpc.mockResolvedValue(accepted(12))

    store.scheduleDurableGoldenSnapshot(snapshot(12))
    store.scheduleDurableGoldenSnapshot(snapshot(11))

    await expect(store.getDurableGoldenSnapshot()).resolves.toMatchObject({
      snapshotVersion: 12,
    })
  })

  it('never lets an older database read completing late replace a newer provider snapshot', async () => {
    const read = deferred<{
      data: { snapshot: FlagSnapshot; snapshot_version: number }
      error: null
    }>()
    mockMaybeSingle.mockReturnValueOnce(read.promise)
    const store = loadStore()

    const pendingRead = store.getDurableGoldenSnapshot()
    expect(mockMaybeSingle).toHaveBeenCalledTimes(1)

    store.scheduleDurableGoldenSnapshot(snapshot(9))
    read.resolve({
      data: { snapshot: snapshot(8), snapshot_version: 8 },
      error: null,
    })

    await expect(pendingRead).resolves.toMatchObject({
      snapshotVersion: 9,
    })
    await expect(store.getDurableGoldenSnapshot()).resolves.toMatchObject({
      snapshotVersion: 9,
    })
  })

  it('does not remember accepted:false as a successful durable replacement', async () => {
    mockRpc.mockResolvedValue(rejected(10))
    const store = loadStore()
    const staleSnapshot = snapshot(7)

    store.scheduleDurableGoldenSnapshot(staleSnapshot)
    await flushPersistence()
    store.scheduleDurableGoldenSnapshot(staleSnapshot)

    expect(mockRpc).toHaveBeenCalledTimes(2)
  })

  it('keeps persistence acknowledgements monotonic when accepted responses complete out of order', async () => {
    const olderWrite = deferred<RpcResult>()
    const newerWrite = deferred<RpcResult>()
    mockRpc
      .mockImplementationOnce(() => olderWrite.promise)
      .mockImplementationOnce(() => newerWrite.promise)
      .mockResolvedValue(accepted(8))
    const store = loadStore()

    store.scheduleDurableGoldenSnapshot(snapshot(8))
    store.scheduleDurableGoldenSnapshot(snapshot(9))

    newerWrite.resolve(accepted(9))
    await flushPersistence()
    olderWrite.resolve(accepted(8))
    await flushPersistence()
    store.scheduleDurableGoldenSnapshot(snapshot(8))

    expect(mockRpc).toHaveBeenCalledTimes(3)
  })

  it('does not let a delayed rejected write become the successful version', async () => {
    const acceptedWrite = deferred<RpcResult>()
    const rejectedWrite = deferred<RpcResult>()
    mockRpc
      .mockImplementationOnce(() => acceptedWrite.promise)
      .mockImplementationOnce(() => rejectedWrite.promise)
      .mockResolvedValue(accepted(10))
    const store = loadStore()

    store.scheduleDurableGoldenSnapshot(snapshot(9))
    store.scheduleDurableGoldenSnapshot(snapshot(10))

    acceptedWrite.resolve(accepted(9))
    await flushPersistence()
    // Another process has already committed v11, so this attempted v10 write
    // is rejected even though its response arrives after our accepted v9.
    rejectedWrite.resolve(rejected(11))
    await flushPersistence()
    store.scheduleDurableGoldenSnapshot(snapshot(10))

    expect(mockRpc).toHaveBeenCalledTimes(3)
  })

  it('deduplicates a genuinely accepted snapshot during the bounded success TTL', async () => {
    mockRpc.mockResolvedValue(accepted(6))
    const store = loadStore()
    const durableSnapshot = snapshot(6)

    store.scheduleDurableGoldenSnapshot(durableSnapshot)
    await flushPersistence()
    store.scheduleDurableGoldenSnapshot(durableSnapshot)

    expect(mockRpc).toHaveBeenCalledTimes(1)
  })
})
