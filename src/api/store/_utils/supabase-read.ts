/**
 * Read-only Supabase client for GCP-hosted personalization reads.
 *
 * Boundary note (AGENTS rule #2): Supabase owns the non-commerce marketplace data
 * (favorites / offers / conversations) and the FRONTEND owns all WRITES to it. This
 * client is READ-ONLY — the marketplace-static-shell epic moved the homepage's
 * personalization read onto Cloud Run, so the backend reads (never writes) that data
 * here, with the frontend's service-role key. Supabase stays the source of truth.
 *
 * Lazy singleton + missing-config stub mirror the frontend `lib/supabase.ts`, so a
 * build/runtime without the env vars degrades to "no rows" instead of crashing.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js'

let _db: SupabaseClient | null = null

function makeMissingConfigQuery(): unknown {
  const result = { data: null, error: { message: 'supabase not configured' } }
  const query: Record<string, unknown> = {
    select: () => query,
    eq: () => query,
    in: () => query,
    order: () => query,
    limit: () => query,
    maybeSingle: () => Promise.resolve(result),
    single: () => Promise.resolve(result),
    then: (
      resolve: (value: typeof result) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(resolve, reject),
  }
  return query
}

function getSupabase(): SupabaseClient {
  if (_db) return _db
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.warn('[supabase-read] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — using stub')
    _db = { from: () => makeMissingConfigQuery() } as unknown as SupabaseClient
    return _db
  }
  _db = createClient(url, key, { auth: { persistSession: false } })
  return _db
}

/** Read-only Supabase accessor (proxied so the client is built on first use). */
export const supabaseRead = new Proxy({} as SupabaseClient, {
  get(_t, prop) {
    const client = getSupabase()
    const val = (client as unknown as Record<string | symbol, unknown>)[prop]
    return typeof val === 'function' ? val.bind(client) : val
  },
})
