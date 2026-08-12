import MercadoPagoProviderService from '../service'

/**
 * A caller-supplied `status` must never authorize a payment.
 *
 * `POST /store/carts/:id/mp-authorize` writes `status: 'approved'` into the session
 * data and takes no authentication, so anyone could mark any cart approved and then
 * call `/complete`. The provider trusting that value was the half that turned a
 * sloppy route into FREE ORDERS: an order placed with nothing paid.
 *
 * Authorization is now always decided by MercadoPago's own answer for a payment id.
 */
/**
 * `mpFetch` is private, so intersecting it with the class type collapses to `never`.
 * Going through `unknown` to a structural shape keeps the stub honest — it still runs
 * the REAL prototype's authorizePayment, only the network call is replaced.
 */
type AuthorizeInput = { data: Record<string, unknown> }
type StubbedService = {
  mpFetch: (path: string) => Promise<{ status: string }>
  authorizePayment: (input: AuthorizeInput) => Promise<{ status: string }>
}

function serviceWith(paymentStatus: string | null): StubbedService {
  const svc = Object.create(MercadoPagoProviderService.prototype) as unknown as StubbedService
  svc.mpFetch = async () => {
    if (paymentStatus === null) throw new Error('MercadoPago unreachable')
    return { status: paymentStatus }
  }
  return svc
}

describe('MercadoPago authorizePayment — the caller is not the authority', () => {
  it('does NOT authorize on caller-supplied status alone (the free-order hole)', async () => {
    const svc = serviceWith('pending')
    const out = await svc.authorizePayment({ data: { status: 'approved', mp_payment_id: '1' } })
    expect(out.status).toBe('pending')
  })

  it('does NOT authorize without a payment id — absence of evidence is not proof of payment', async () => {
    const svc = serviceWith('approved')
    const out = await svc.authorizePayment({ data: { status: 'approved' } })
    expect(out.status).toBe('pending')
  })

  it('authorizes only when MercadoPago itself reports approved', async () => {
    const svc = serviceWith('approved')
    const out = await svc.authorizePayment({ data: { mp_payment_id: '123' } })
    expect(out.status).toBe('authorized')
  })

  it('cancels on a rejected payment even though the caller claimed approved', async () => {
    const svc = serviceWith('rejected')
    const out = await svc.authorizePayment({ data: { status: 'approved', mp_payment_id: '9' } })
    expect(out.status).toBe('canceled')
  })

  it('an unreachable MercadoPago is an error, never an authorization', async () => {
    const svc = serviceWith(null)
    const out = await svc.authorizePayment({ data: { status: 'approved', mp_payment_id: '9' } })
    expect(out.status).toBe('error')
  })
})
