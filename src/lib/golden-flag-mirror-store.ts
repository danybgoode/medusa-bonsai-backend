/**
 * Bounded service-role seam for the durable Golden snapshot mirror.
 *
 * Direct writes remain prohibited: persistence calls the database's narrowly
 * granted monotonic RPC, while normal reads remain ordinary service-role reads.
 */
import type { FlagSnapshot } from '@golden-beans/sdk'
import { parseGoldenFlagEnvironment, type GoldenFlagEnvironment } from './flag-provider-mode'
import { parseDurableGoldenSnapshot } from './golden-flag-mirror'
import { supabaseRead } from '../api/store/_utils/supabase-read'

const TABLE = 'golden_flag_snapshot_mirror'
const MIRROR_CACHE_TTL_MS = 60_000
const MIRROR_FETCH_TIMEOUT_MS = 2_000

const cache: { snapshot: FlagSnapshot | undefined; environment: GoldenFlagEnvironment | undefined; fetchedAt: number | undefined } = {
  snapshot: undefined,
  environment: undefined,
  fetchedAt: undefined,
}
let inflight: Promise<FlagSnapshot | undefined> | undefined
const lastSuccessfulPersistByEnvironment = new Map<string, { snapshotVersion: number; at: number }>()
const persistenceInflightByEnvironment = new Map<string, { snapshotVersion: number; token: symbol }>()

export function scheduleDurableGoldenSnapshot(snapshot: FlagSnapshot): void {
  // A snapshot which reached the live provider is already contract-validated. Retain it in-process
  // immediately; the RPC below makes that same last-known-good value durable without making a flag
  // decision wait for database I/O.
  cache.snapshot = snapshot
  cache.environment = snapshot.environment
  cache.fetchedAt = Date.now()

  const previous = lastSuccessfulPersistByEnvironment.get(snapshot.environment)
  const now = Date.now()
  if (previous && previous.snapshotVersion === snapshot.snapshotVersion && now - previous.at < MIRROR_CACHE_TTL_MS)
    return
  if (persistenceInflightByEnvironment.get(snapshot.environment)?.snapshotVersion === snapshot.snapshotVersion)
    return

  try {
    const token = Symbol('golden-snapshot-persistence')
    const request = Promise.resolve(supabaseRead.rpc('persist_golden_flag_snapshot', {
        p_environment: snapshot.environment,
        p_snapshot_version: snapshot.snapshotVersion,
        p_snapshot: snapshot,
      }))
      .then(({ error }) => {
        if (!error) {
          lastSuccessfulPersistByEnvironment.set(snapshot.environment, {
            snapshotVersion: snapshot.snapshotVersion,
            at: Date.now(),
          })
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (persistenceInflightByEnvironment.get(snapshot.environment)?.token === token) {
          persistenceInflightByEnvironment.delete(snapshot.environment)
        }
      })
    persistenceInflightByEnvironment.set(snapshot.environment, { snapshotVersion: snapshot.snapshotVersion, token })
    void request
  } catch {
    // Missing local configuration and client construction are both non-fatal.
  }
}

async function fetchDurableGoldenSnapshot(
  environment: GoldenFlagEnvironment,
): Promise<FlagSnapshot | undefined> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const query = supabaseRead
      .from(TABLE)
      .select('snapshot, snapshot_version')
      .eq('environment', environment)
      .maybeSingle()
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('golden snapshot mirror fetch timeout')), MIRROR_FETCH_TIMEOUT_MS)
    })
    const { data, error } = (await Promise.race([query, timeout])) as {
      data: { snapshot?: unknown; snapshot_version?: unknown } | null
      error: unknown
    }
    if (error || !data) return undefined
    const snapshot = parseDurableGoldenSnapshot(data.snapshot, environment)
    if (
      !snapshot ||
      typeof data.snapshot_version !== 'number' ||
      !Number.isSafeInteger(data.snapshot_version) ||
      snapshot.snapshotVersion !== data.snapshot_version
    )
      return undefined
    return snapshot
  } catch {
    return undefined
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export async function getDurableGoldenSnapshot(): Promise<FlagSnapshot | undefined> {
  const environment = parseGoldenFlagEnvironment(process.env.GOLDEN_BEANS_FLAG_ENVIRONMENT)
  if (!environment) return undefined
  const now = Date.now()
  if (
    cache.environment === environment &&
    cache.fetchedAt !== undefined &&
    now - cache.fetchedAt < MIRROR_CACHE_TTL_MS
  )
    return cache.snapshot
  if (inflight) return inflight

  inflight = fetchDurableGoldenSnapshot(environment)
    .then((snapshot) => {
      if (snapshot) {
        cache.snapshot = snapshot
        cache.environment = environment
      } else if (cache.environment !== environment) {
        cache.snapshot = undefined
        cache.environment = environment
      }
      cache.fetchedAt = Date.now()
      return cache.snapshot
    })
    .finally(() => {
      inflight = undefined
    })
  return inflight
}
