/**
 * src/lib/flags-cache.ts
 *
 * The PURE half of the backend in-house feature-flag reader (epic 09 ·
 * feature-flags-inhouse). Kept free of the Supabase client + Medusa runtime so the
 * fail-open decision is unit-testable with zero network (jest `*.unit.spec.ts`). The
 * stateful cache + the actual `platform_flags` read live in `src/lib/flags.ts`.
 *
 * Mirror of the frontend `apps/miyagisanchez/lib/flags-cache.ts` — separate packages,
 * so the logic is duplicated rather than shared. Keep the two in lockstep.
 */

/** One row of the `platform_flags` table (only the columns the reader needs). */
export type FlagRow = { key: string; enabled: boolean }

/** In-process cache TTL — how long a successful read is trusted before a refresh. */
export const FLAG_CACHE_TTL_MS = 60_000

/** Bounded fetch budget — a hung Supabase read gives up after this and fails open. */
export const FLAG_FETCH_TIMEOUT_MS = 2_000

/**
 * Resolve a single flag from cached rows, FAIL-OPEN to `defaults`.
 * Returns the row's value when the key is present with a boolean `enabled`; on any
 * miss/empty/null rows (or a non-boolean value) returns `defaults[key]`. Never throws.
 */
export function resolveFlag<K extends string>(
  rows: readonly FlagRow[] | null | undefined,
  key: K,
  defaults: Record<K, boolean>,
): boolean {
  if (rows) {
    const row = rows.find((r) => r.key === key)
    if (row && typeof row.enabled === 'boolean') return row.enabled
  }
  return defaults[key]
}

/**
 * Is the cache stale (needs a refresh)? True when never fetched (`fetchedAt === null`)
 * or when it has aged past `ttlMs`. A fresh cache short-circuits any DB read.
 */
export function isCacheStale(fetchedAt: number | null, now: number, ttlMs: number): boolean {
  if (fetchedAt === null) return true
  return now - fetchedAt >= ttlMs
}
