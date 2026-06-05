export const SUPPORT_PRODUCT_METADATA = {
  is_support_product: true,
  hidden_from_catalog: true,
  support_widget: true,
} as const

export type SupportVisibility = 'public' | 'private'

export interface NormalizedSupportCheckout {
  amount_cents: number
  supporter_name: string | null
  supporter_email: string
  message: string | null
  visibility: SupportVisibility
  embed_key: string | null
  channel: string
}

export function isSupportProductMetadata(metadata: unknown): boolean {
  const meta = (metadata ?? {}) as Record<string, unknown>
  return meta.is_support_product === true || meta.support_widget === true || meta.listing_type === 'support'
}

export function isHiddenCatalogProduct(metadata: unknown): boolean {
  const meta = (metadata ?? {}) as Record<string, unknown>
  return meta.hidden_from_catalog === true || meta.is_support_product === true || meta.support_widget === true
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed.slice(0, max) : null
}

function cleanEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return null
  return email
}

export function normalizeSupportCheckout(input: unknown):
  | { ok: true; support: NormalizedSupportCheckout }
  | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: 'support payload is required' }
  }

  const payload = input as Record<string, unknown>
  const amount = Math.round(Number(payload.amount_cents ?? 0))
  if (!Number.isFinite(amount) || amount < 100 || amount > 500_000) {
    return { ok: false, message: 'support amount must be between $1 and $5,000 MXN' }
  }

  const supporterEmail = cleanEmail(payload.supporter_email)
  if (!supporterEmail) {
    return { ok: false, message: 'supporter_email is required for receipts' }
  }

  const visibility = payload.visibility === 'private' ? 'private' : 'public'
  const rawMessage = typeof payload.message === 'string' ? payload.message.trim() : ''
  if (rawMessage.length > 250) {
    return { ok: false, message: 'support message must be 250 characters or less' }
  }
  const message = rawMessage || null
  const supporterName = cleanText(payload.supporter_name, 80)
  const embedKey = cleanText(payload.embed_key, 80)
  const channel = cleanText(payload.channel, 24) ?? 'embed'

  return {
    ok: true,
    support: {
      amount_cents: amount,
      supporter_email: supporterEmail,
      supporter_name: supporterName,
      message,
      visibility,
      embed_key: embedKey,
      channel,
    },
  }
}
