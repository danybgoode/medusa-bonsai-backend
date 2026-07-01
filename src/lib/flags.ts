/**
 * src/lib/flags.ts
 *
 * Backend (Medusa) half of the platform feature-flag / kill-switch layer, now backed
 * by an OWNED Supabase table (`platform_flags`) — replaces Flagsmith (epic 09 ·
 * feature-flags-inhouse). Reads the SAME rows the frontend reads, so a single flip
 * governs BOTH apps. See the scope: Roadmap/09-platform-infra/feature-flags-inhouse/.
 *
 * This is the ENFORCEMENT half: the frontend hides a killed rail in the UI, but
 * agents/UCP and stale in-flight checkout pages hit the backend directly — so the
 * real kill must live here (checkout-options catalog + start-checkout guard).
 *
 * Design rules (non-negotiable — carried over from the Flagsmith spike):
 *  1. FAIL-OPEN. Every read falls back to DEFAULT_FLAGS. Supabase being unreachable,
 *     slow, or the table empty/missing must NEVER break checkout. A kill-switch
 *     defaults to ENABLED (the feature stays on if the read fails).
 *  2. IN-PROCESS CACHE, fast fail. All rows are cached module-side for 60 s
 *     (FLAG_CACHE_TTL_MS) → ~0 ms/request when fresh; a stale cache triggers ONE
 *     bounded refresh (≤2 s, no retries) so a hung read can't stall a checkout.
 *
 * Reads via the existing read-only `supabaseRead` (SUPABASE_URL + SERVICE_ROLE_KEY,
 * already in the Cloud Run env). Absent creds → the client's stub returns "no rows"
 * → isEnabled() runs on DEFAULT_FLAGS (never throws).
 */
import { supabaseRead } from '../api/store/_utils/supabase-read'
import {
  resolveFlag,
  isCacheStale,
  FLAG_CACHE_TTL_MS,
  FLAG_FETCH_TIMEOUT_MS,
  type FlagRow,
} from './flags-cache'

export type FlagKey = 'checkout.stripe_enabled' | 'shipping.envia_enabled' | 'ml.sync_enabled'

/**
 * Fail-open defaults. Three polarities live here — all fail SAFE, to the value
 * that can't cause harm on a read outage (Supabase unreachable / table empty):
 *  - KILL-SWITCH (`checkout.stripe_enabled`): default `true`. The feature keeps
 *    working if the read is down (disabling is the deliberate action).
 *  - ENABLEMENT (`shipping.envia_enabled`): default `false`. The Envia.com
 *    integration stays OFF if Supabase is unreachable — so a flag outage can never
 *    push checkout/fulfillment at an unfunded carrier; OFF ⇒ arranged-delivery /
 *    manual-carrier fallback. Enabling is the deliberate action (flip ON the instant
 *    the platform Envía account is funded).
 *  - KILL-SWITCH, FAIL-CLOSED (`ml.sync_enabled`): default `false`. This is a
 *    kill-switch by function (flip OFF to instantly halt the two-way ML stock
 *    sync) but deliberately defaults to `false` — UNLIKE the usual kill-switch
 *    default-`true`. The blast radius of sync running unsupervised (overselling
 *    on ML or in Miyagi) is worse than the feature being off, so a read outage
 *    must HALT sync, not run it uncontrolled. Enabling is the deliberate
 *    action, and a per-seller enable (on the ML connection) must ALSO be on.
 */
const DEFAULT_FLAGS: Record<FlagKey, boolean> = {
  'checkout.stripe_enabled': true,
  'shipping.envia_enabled': false,
  'ml.sync_enabled': false,
}

const TABLE = 'platform_flags'

// Module-level in-process cache. Single-threaded module evaluation → no init race.
// `rows: null` → resolveFlag() falls open to DEFAULT_FLAGS. `fetchedAt` gates the 60 s
// staleness; `inflight` de-dupes concurrent refreshes to ONE read on a cold instance.
let cache: { rows: FlagRow[] | null; fetchedAt: number | null } = { rows: null, fetchedAt: null }
let inflight: Promise<void> | null = null

/**
 * Read every flag row from Supabase, bounded to ~2 s (no retries) so a hung read can't
 * stall checkout. Returns null on timeout / error (an EMPTY table returns [] →
 * resolveFlag then falls open per-flag) — either way the caller fails open. Uses
 * Promise.race (not .abortSignal) so the missing-config stub — which has no abortSignal
 * — is handled uniformly. Note: Promise.race bounds CALLER latency, not the underlying
 * request; a hung read is abandoned (GC'd when it settles), and the 60 s inflight
 * de-dup caps abandoned reads to ~1/min.
 */
async function fetchRows(): Promise<FlagRow[] | null> {
  try {
    const query = supabaseRead.from(TABLE).select('key, enabled')
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('platform_flags fetch timeout')), FLAG_FETCH_TIMEOUT_MS),
    )
    const { data, error } = (await Promise.race([query, timeout])) as {
      data: Array<{ key: unknown; enabled: unknown }> | null
      error: unknown
    }
    if (error || !data) return null
    // Preserve the raw `enabled` — do NOT Boolean()-coerce. resolveFlag's
    // `typeof === 'boolean'` guard is the SINGLE validation point, so a malformed row
    // (e.g. the string 'false', which Boolean() would flip to true) fails OPEN to
    // DEFAULT_FLAGS instead of coercing to a wrong definite state — critical here,
    // where a wrong value silently enables/disables a commerce rail. `enabled` is
    // `boolean NOT NULL` in Postgres, so this is defense-in-depth, not an expected path.
    return data.map((r) => ({ key: String(r.key), enabled: r.enabled as boolean }))
  } catch {
    return null
  }
}

/**
 * Refresh the cache if stale. Never throws. On a successful read the rows + timestamp
 * are replaced; on failure the rows are cleared to null (fail open to DEFAULT_FLAGS)
 * and the timestamp is still bumped so an outage doesn't hammer the DB every request.
 */
async function refreshIfStale(): Promise<void> {
  if (!isCacheStale(cache.fetchedAt, Date.now(), FLAG_CACHE_TTL_MS)) return
  if (inflight) return inflight
  inflight = fetchRows()
    .then((rows) => {
      cache = { rows, fetchedAt: Date.now() }
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/**
 * Is a feature enabled? Never throws — returns the fail-open DEFAULT_FLAGS value on any
 * error, timeout, or when the table is unreadable/empty. A fresh cache resolves with no
 * DB hit; a stale cache awaits one bounded (≤2 s) refresh first.
 */
export async function isEnabled(flag: FlagKey): Promise<boolean> {
  try {
    await refreshIfStale()
  } catch {
    // Defensive: refreshIfStale already swallows errors, but never let a flag read throw.
  }
  return resolveFlag(cache.rows, flag, DEFAULT_FLAGS)
}
