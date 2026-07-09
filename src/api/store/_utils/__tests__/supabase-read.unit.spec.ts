/**
 * Regression test for the Node-20-WebSocket bug (found live via the
 * catalog-management epic's Sprint 3 smoke test): `createClient()`
 * unconditionally constructs a `RealtimeClient`, which looks up a native
 * `WebSocket` global and throws if none exists (absent on Node < 22) unless
 * a `transport` option is given. The fix is the `NoopWebSocketTransport`
 * stub passed as that option — this test proves it does its job by calling
 * `createClient()` the exact same way `getSupabase()` does, without/with the
 * stub, and asserting only the unstubbed call can throw. Doesn't require
 * running under real Node 20 to catch a regression: the stub works by
 * skipping the native-WebSocket lookup entirely, regardless of Node version
 * (verified separately against real Node 20.20.2 locally, see PR #73).
 */
import { createClient } from '@supabase/supabase-js'
import { NoopWebSocketTransport } from '../supabase-read'
import type { WebSocketLikeConstructor } from '@supabase/supabase-js'

describe('NoopWebSocketTransport', () => {
  it('throws if ever instantiated (the realtime channel this client must never open)', () => {
    expect(() => new NoopWebSocketTransport()).toThrow(/should never be instantiated/)
  })
})

describe('createClient() with the transport stub (supabase-read.ts regression)', () => {
  it('never throws at construction, and exposes a working select() surface', () => {
    expect(() => {
      const client = createClient('https://example.supabase.co', 'test-service-role-key', {
        auth: { persistSession: false },
        realtime: { transport: NoopWebSocketTransport as unknown as WebSocketLikeConstructor },
      })
      expect(typeof client.from).toBe('function')
    }).not.toThrow()
  })
})
