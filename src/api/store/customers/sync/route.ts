/**
 * POST /store/customers/sync
 *
 * Finds-or-creates a Medusa Customer record for the Clerk-authenticated user.
 * Call this from the frontend on checkout start so orders are linked to the
 * correct Medusa customer (and thus appear in /account/orders from Medusa).
 *
 * Auth: Clerk JWT in Authorization header.
 *
 * Body: { email: string; first_name?: string; last_name?: string }
 *
 * Response: { customer_id: string }
 */

import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http'
import { Modules } from '@medusajs/framework/utils'
import { extractClerkUserId } from '../../_utils/clerk-auth'

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const clerkUserId = extractClerkUserId(req)
  if (!clerkUserId) {
    return res.status(401).json({ message: 'Unauthorized' })
  }

  const body = req.body as {
    email?: string
    first_name?: string
    last_name?: string
  }

  if (!body.email) {
    return res.status(400).json({ message: 'email is required' })
  }

  const customerService = req.scope.resolve(Modules.CUSTOMER) as any

  // Find existing customer by email or external_id (Clerk user ID)
  let customers: any[] = []
  try {
    customers = await customerService.listCustomers({
      email: body.email,
    }, { select: ['id', 'email', 'external_id', 'first_name', 'last_name'] })
  } catch (e) {
    console.error('[customer-sync] listCustomers error:', e)
  }

  // Prefer one that's already linked to this Clerk user
  let customer = customers.find((c: any) => c.external_id === clerkUserId)
    ?? customers[0]
    ?? null

  if (!customer) {
    // Create new Medusa customer
    try {
      customer = await customerService.createCustomers({
        email: body.email,
        first_name: body.first_name ?? '',
        last_name: body.last_name ?? '',
        external_id: clerkUserId,
      })
    } catch (e) {
      console.error('[customer-sync] createCustomers error:', e)
      return res.status(500).json({ message: 'Failed to create customer' })
    }
  } else if (!customer.external_id) {
    // Backfill external_id on an existing customer
    try {
      await customerService.updateCustomers(customer.id, {
        external_id: clerkUserId,
      })
    } catch {
      // Non-fatal — customer exists, just couldn't link
    }
  }

  return res.json({ customer_id: customer.id })
}
