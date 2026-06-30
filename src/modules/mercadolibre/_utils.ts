import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'

/**
 * Pure, framework-free helpers for the Mercado Libre module. Everything here is
 * unit-tested (no DB, no network) — the deterministic backend gate.
 */

// ── Token encryption (AES-256-GCM, authenticated) ──────────────────────────────
// Improves on the reference's AES-256-CBC: GCM is tamper-evident, so a corrupted
// or forged ciphertext fails the auth tag and `decryptToken` returns ''.
const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

function getKey(): Buffer {
  const secret = process.env.ML_TOKEN_ENCRYPTION_KEY
  if (!secret) throw new Error('ML_TOKEN_ENCRYPTION_KEY is not set')
  // sha256 → exactly 32 bytes, regardless of the secret's length.
  return createHash('sha256').update(secret).digest()
}

/** Encrypt a token for at-rest storage. Layout: base64(iv[12] | tag[16] | ciphertext). */
export function encryptToken(plain: string): string {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, getKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64')
}

/** Decrypt a token. Returns '' on any failure (missing key, tamper, garbage). */
export function decryptToken(payload: string): string {
  try {
    const buf = Buffer.from(payload, 'base64')
    if (buf.length <= IV_LEN + TAG_LEN) return ''
    const iv = buf.subarray(0, IV_LEN)
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
    const data = buf.subarray(IV_LEN + TAG_LEN)
    const decipher = createDecipheriv(ALGO, getKey(), iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  } catch {
    return ''
  }
}

// ── Token-refresh decision ──────────────────────────────────────────────────────
export const REFRESH_SKEW_MS = 5 * 60 * 1000 // refresh if expiring within 5 minutes

function toMillis(v: Date | string | number | null | undefined): number {
  if (v == null) return NaN
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  return new Date(v).getTime()
}

/** True when the access token is expired or within the refresh skew window. */
export function shouldRefresh(
  expiresAt: Date | string | number | null | undefined,
  now: number = Date.now(),
  skewMs: number = REFRESH_SKEW_MS,
): boolean {
  const exp = toMillis(expiresAt)
  if (Number.isNaN(exp)) return true
  return exp - now < skewMs
}

// ── Connection health (for the seller status surface) ──────────────────────────
export type MlHealthState = 'connected' | 'stale' | 'expired' | 'disconnected'
export type MlHealth = { state: MlHealthState; label_es: string }

export function deriveConnectionHealth(
  conn: { status?: string | null; expires_at?: Date | string | number | null } | null | undefined,
  now: number = Date.now(),
): MlHealth {
  if (!conn || conn.status === 'disconnected' || conn.expires_at == null) {
    return { state: 'disconnected', label_es: 'No conectado' }
  }
  const exp = toMillis(conn.expires_at)
  if (Number.isNaN(exp) || exp <= now) {
    return { state: 'expired', label_es: 'Conexión expirada — vuelve a conectar' }
  }
  if (shouldRefresh(exp, now)) {
    return { state: 'stale', label_es: 'Conexión por renovar' }
  }
  return { state: 'connected', label_es: 'Conectado' }
}

// ── Sanitisation (the ONLY shape routes may emit) ──────────────────────────────
export type SanitizedMlConnection = {
  id: string
  seller_id: string
  ml_user_id: string
  ml_nickname: string | null
  country_code: string
  status: string
  expires_at: string | null
  last_refreshed_at: string | null
}

/** Strip every token field. A route/log may only ever see this shape. */
export function sanitizeConnection(row: unknown): SanitizedMlConnection | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  const iso = (v: unknown): string | null => (v ? new Date(v as string).toISOString() : null)
  return {
    id: String(r.id ?? ''),
    seller_id: String(r.seller_id ?? ''),
    ml_user_id: String(r.ml_user_id ?? ''),
    ml_nickname: (r.ml_nickname as string | null) ?? null,
    country_code: (r.country_code as string) ?? 'MX',
    status: (r.status as string) ?? 'connected',
    expires_at: iso(r.expires_at),
    last_refreshed_at: iso(r.last_refreshed_at),
  }
}

// ── Linkage conflict guard (enforces the 1:1 join) ─────────────────────────────
// `existing` is the set of links that already match the candidate's product_id OR
// ml_item_id (the caller queries both directions). A conflict means linking would
// violate the 1:1 constraint — the product is already linked, or the ML item is.
type LinkPair = { product_id: string; ml_item_id: string }

export function isDuplicateLink(existing: LinkPair[], candidate: LinkPair): boolean {
  return existing.some(
    (l) => l.product_id === candidate.product_id || l.ml_item_id === candidate.ml_item_id,
  )
}
