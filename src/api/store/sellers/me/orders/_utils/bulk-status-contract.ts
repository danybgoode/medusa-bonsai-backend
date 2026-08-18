export const MAX_BULK_ORDERS = 50
export const BULK_ALLOWED_STATUSES = new Set(['processing', 'shipped', 'delivered'])

export type BulkStatusRequest = {
  orderIds: string[]
  newStatus: string | null
  expectedStatuses: Record<string, string>
}

export function parseBulkStatusRequest(body: unknown): BulkStatusRequest {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {}
  const orderIds = Array.isArray(record.order_ids)
    ? [...new Set(record.order_ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
    : []
  const expected = record.expected_statuses && typeof record.expected_statuses === 'object'
    ? record.expected_statuses as Record<string, unknown>
    : {}
  const expectedStatuses = Object.fromEntries(
    Object.entries(expected).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  return {
    orderIds,
    newStatus: typeof record.status === 'string' ? record.status : null,
    expectedStatuses,
  }
}
