import { POST } from '../route'
import { SELLER_MODULE } from '../../../../../../modules/seller'

function capture() {
  const out: { status: number; body: any } = { status: 200, body: null }
  const res: any = {
    status(code: number) { out.status = code; return res },
    json(body: any) { out.body = body; return res },
  }
  return { out, res }
}

describe('shop claim ownership serialization', () => {
  it('awards one first transfer when two invited accounts race, then identifies a retry', async () => {
    const priorSecret = process.env.MEDUSA_INTERNAL_SECRET
    process.env.MEDUSA_INTERNAL_SECRET = 'unit-test-secret'
    try {
      const seller = { id: 'sel_one', slug: 'example', verified: true, status: 'active', clerk_user_id: null as string | null }
      const service = {
        listSellers: async (filter: { id?: string; clerk_user_id?: string }) => {
          // Force competing reads onto separate microtasks. Without the lock,
          // both callers can observe NULL before either one writes.
          await Promise.resolve()
          if (filter.id) return [{ ...seller }]
          return seller.clerk_user_id === filter.clerk_user_id ? [{ ...seller }] : []
        },
        updateSellers: async (update: { clerk_user_id: string }) => {
          await Promise.resolve()
          seller.clerk_user_id = update.clerk_user_id
          return { ...seller }
        },
      }
      let tail: Promise<unknown> = Promise.resolve()
      const locking = {
        execute: <T>(_key: string, fn: () => Promise<T>): Promise<T> => {
          const task = tail.then(fn)
          tail = task.then(() => undefined, () => undefined)
          return task
        },
      }
      const request = (user: string): any => ({
        params: { id: 'sel_one' }, body: { clerk_user_id: user },
        headers: { 'x-internal-secret': 'unit-test-secret' },
        scope: { resolve: (token: string) => token === SELLER_MODULE ? service : locking },
      })
      const first = capture()
      const second = capture()
      await Promise.all([
        POST(request('user_one'), first.res),
        POST(request('user_two'), second.res),
      ])
      expect([first.out.status, second.out.status].sort()).toEqual([200, 409])
      expect([first.out.body.newly_claimed, second.out.body.newly_claimed].filter(Boolean)).toHaveLength(1)
      expect(seller.clerk_user_id).toBe('user_one')

      const retry = capture()
      await POST(request('user_one'), retry.res)
      expect(retry.out.status).toBe(200)
      expect(retry.out.body.newly_claimed).toBe(false)
    } finally {
      if (priorSecret === undefined) delete process.env.MEDUSA_INTERNAL_SECRET
      else process.env.MEDUSA_INTERNAL_SECRET = priorSecret
    }
  })
})
