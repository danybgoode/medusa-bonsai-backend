/**
 * Regression test for the Node-20-WebSocket bug (found live via the
 * catalog-management epic's Sprint 3 smoke test): `createClient()`
 * unconditionally constructs a `RealtimeClient`, which looks up a native
 * `WebSocket` global and throws if none exists (absent on Node < 22) unless
 * a `transport` option is given. Doesn't require running under real Node 20
 * to catch a regression: the fix works by skipping the native-WebSocket
 * lookup entirely, regardless of Node version (separately verified against
 * real Node 20.20.2 locally, see PR #73). `jest.isolateModules` + `require`
 * (not a reconstructed inline call) so this exercises the ACTUAL
 * `getSupabase()`/`supabaseRead` construction path — deleting the
 * `realtime.transport` line from the real module fails this test, unlike a
 * test that reconstructs the `createClient()` call shape separately.
 */
import { NoopWebSocketTransport } from '../supabase-read'

describe('NoopWebSocketTransport', () => {
  it('throws if ever instantiated (the realtime channel this client must never open)', () => {
    expect(() => new NoopWebSocketTransport()).toThrow(/should never be instantiated/)
  })
})

describe('supabaseRead (the real getSupabase() construction path)', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  afterEach(() => {
    process.env = ORIGINAL_ENV
  })

  it('constructs without throwing when SUPABASE_URL/SERVICE_ROLE_KEY are set — the actual bug: this used to throw on Node < 22 before the transport stub', () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { supabaseRead } = require('../supabase-read')
      expect(() => supabaseRead.from).not.toThrow()
      expect(typeof supabaseRead.from).toBe('function')
    })
  })

  it('degrades to the missing-config stub (no rows, never throws) when env vars are absent', async () => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    // jest.isolateModules' callback must be synchronous — capture the fresh
    // module reference inside it, then await outside.
    let supabaseRead: typeof import('../supabase-read').supabaseRead
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      supabaseRead = require('../supabase-read').supabaseRead
    })
    const result = await supabaseRead!.from('platform_flags').select('key, enabled')
    expect(result.data).toBeNull()
    expect(result.error).toBeTruthy()
  })
})
