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
// `needs_reauth` is the Sprint-5 addition: a token refresh actually FAILED (the
// refresh token was revoked/expired), so the seller must reconnect. It outranks
// every time-derived state — a `connected`-looking `expires_at` is meaningless
// once the refresh token is dead, and this is exactly the silent-failure this
// sprint fixes.
export type MlHealthState = 'connected' | 'stale' | 'expired' | 'needs_reauth' | 'disconnected'
export type MlHealth = { state: MlHealthState; label_es: string }

/** True when the connection metadata flags a failed refresh (needs re-auth). */
export function connectionNeedsReauth(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return !!metadata && (metadata as Record<string, unknown>).needs_reauth === true
}

export function deriveConnectionHealth(
  conn:
    | { status?: string | null; expires_at?: Date | string | number | null; metadata?: Record<string, unknown> | null }
    | null
    | undefined,
  now: number = Date.now(),
): MlHealth {
  if (!conn || conn.status === 'disconnected' || conn.expires_at == null) {
    return { state: 'disconnected', label_es: 'No conectado' }
  }
  // A failed refresh outranks the time-derived states: the tokens look valid but
  // aren't, and only a reconnect fixes it.
  if (connectionNeedsReauth(conn.metadata)) {
    return { state: 'needs_reauth', label_es: 'Reconecta tu cuenta de Mercado Libre' }
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

// ── Publish: payload build + action decision (Sprint 3) ────────────────────────
import type { MlItemPayload } from './client'
import { ML_DEFAULT_LISTING_TYPE } from './client'

/** Map an ML country code → its site id (the predictor + publish are per-site). */
export function mlSiteForCountry(countryCode: string | null | undefined): string {
  const map: Record<string, string> = {
    MX: 'MLM', AR: 'MLA', BR: 'MLB', CL: 'MLC', CO: 'MCO', UY: 'MLU', PE: 'MPE',
  }
  return map[(countryCode ?? 'MX').toUpperCase()] ?? 'MLM'
}

/** The minimal product shape `buildMlItemPayload` needs (a subset of ListingShape). */
export type MlPublishInput = {
  title: string
  price_cents: number | null
  currency: string
  description: string | null
  condition: string | null
  available_quantity: number | null
  images: { url: string }[]
}

/**
 * Build the `MlItemPayload` POST /items expects from a normalised Miyagi product.
 * Pure + degrades gracefully: price → major units (ML quotes pesos), condition →
 * ML's `new`/`used` binary (anything not `new` is `used`), quantity clamped to ≥1
 * (ML rejects 0 on an active item; stock accuracy is Sprint 4's job), pictures as
 * `{source}`. `category_id` is supplied by the caller (predicted/overridden, US-9).
 */
export function buildMlItemPayload(
  input: MlPublishInput,
  opts: { categoryId: string; listingTypeId?: string },
): MlItemPayload {
  const title = (input.title ?? '').trim()
  const price = input.price_cents != null && Number.isFinite(input.price_cents)
    ? Math.round((input.price_cents / 100) * 100) / 100
    : 0
  const qty = input.available_quantity != null && Number.isFinite(input.available_quantity)
    ? Math.max(1, Math.trunc(input.available_quantity))
    : 1
  const pictures = (Array.isArray(input.images) ? input.images : [])
    .map((i) => i?.url)
    .filter((u): u is string => typeof u === 'string' && u.length > 0)
    .map((source) => ({ source }))

  const payload: MlItemPayload = {
    title,
    category_id: opts.categoryId,
    price,
    currency_id: (input.currency || 'MXN').toUpperCase(),
    available_quantity: qty,
    buying_mode: 'buy_it_now',
    condition: input.condition === 'new' ? 'new' : 'used',
    listing_type_id: opts.listingTypeId || ML_DEFAULT_LISTING_TYPE,
  }
  const desc = (input.description ?? '').trim()
  if (desc) payload.description = { plain_text: desc }
  if (pictures.length) payload.pictures = pictures
  return payload
}

export type MlPublishAction = 'create' | 'update' | 'close' | 'relist' | 'noop'

/**
 * Decide what the explicit "Sincronizar con Mercado Libre" action should do,
 * given the current linkage + the live ML/Miyagi statuses. This is the single
 * authoritative reconcile decision (US-7 + US-8); the Sprint-4 inventory
 * subscriber will drive the same outbound seam.
 *
 *  - not linked            → create (publish) — unless the seller has since
 *    turned the per-product ML toggle off (`mlEnabled: false`), a reachable
 *    state since catalog-management S2 · 2.2 introduced it: clean no-op, not
 *    a validation error surfaced as if it were a mistake.
 *  - linked, effectively unpublished (Miyagi closed OR ml_enabled:false)
 *                           → close the ML item (archive/draft propagates)
 *  - linked, ML closed, effectively published → relist
 *  - linked, both active    → update (title/price/images propagate)
 *
 * `mlEnabled` defaults to `true` when omitted — preserves every call site's
 * existing behavior (today's product-status-only coupling) until a caller
 * explicitly threads the new per-product toggle (catalog-management S2 · 2.2).
 * `productPublished && mlEnabled !== false` composes the two independent
 * signals with an AND, so "Miyagi paused always force-closes ML" falls out
 * for free — no special-casing needed (a paused product has
 * `productPublished: false` regardless of the toggle's value).
 */
export function decidePublishAction(args: {
  linked: boolean
  mlStatus?: string | null
  productPublished: boolean
  mlEnabled?: boolean
}): MlPublishAction {
  // Not-yet-linked + explicitly toggled off is the ONE new reachable state
  // (S2 · 2.2) — every other `!linked` case (including `productPublished:
  // false`) preserves today's EXACT 'create' behavior, unchanged.
  if (!args.linked) return args.mlEnabled === false ? 'noop' : 'create'
  const effectivelyPublished = args.productPublished && args.mlEnabled !== false
  if (!effectivelyPublished) {
    return args.mlStatus === 'closed' ? 'noop' : 'close'
  }
  if (args.mlStatus === 'closed') return 'relist'
  return 'update'
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

// ── Sync activity log — event shaping (Sprint 5 · US-13) ────────────────────────
// Pure, framework-free: validate + normalise + REDACT a sync event before it is
// appended. Observability only — never read to make a sync decision.

export const SYNC_EVENT_KINDS = [
  'token_refresh',
  'publish',
  'close',
  'stock_push',
  'sale_applied',
  'reconcile',
  'import',
  'price_apply',
] as const
export type SyncEventKind = (typeof SYNC_EVENT_KINDS)[number]
export type SyncEventOutcome = 'ok' | 'fail'

export const MAX_SYNC_MESSAGE_LEN = 300

export type SyncEventInput = {
  sellerId: string
  kind: string
  outcome: string
  productId?: string | null
  mlItemId?: string | null
  code?: string | null
  message?: unknown
  metadata?: Record<string, unknown> | null
}

export type ShapedSyncEvent = {
  seller_id: string
  product_id: string | null
  ml_item_id: string | null
  kind: SyncEventKind
  outcome: SyncEventOutcome
  code: string | null
  message: string | null
  metadata: Record<string, unknown> | null
}

/**
 * Strip anything token-shaped out of a free-text message. ML access/refresh tokens
 * are `APP_USR-…` / `TG-…` / `APP-…` strings; a bearer header or a raw JWT could
 * also leak into an error string. Belt-and-suspenders: even though we never log the
 * token, an upstream error body could echo it.
 */
export function redactSyncMessage(raw: unknown): string | null {
  if (raw == null) return null
  let s = typeof raw === 'string' ? raw : String(raw)
  s = s
    .replace(/\bAPP[_-]USR-[\w-]+/gi, '[redacted]')
    .replace(/\bTG-[\w-]+/gi, '[redacted]')
    .replace(/\bBearer\s+[\w.\-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[redacted]') // JWT
    .trim()
  if (!s) return null
  return s.length > MAX_SYNC_MESSAGE_LEN ? `${s.slice(0, MAX_SYNC_MESSAGE_LEN - 1)}…` : s
}

/**
 * Redact any string VALUE inside a (shallow) metadata object — so a caller-provided
 * metadata field (the POST /internal/ml/events path accepts arbitrary metadata) can
 * never bypass the "no tokens" guarantee that `redactSyncMessage` enforces for the
 * message. Non-string values (numbers/booleans — the only shape our own callers use)
 * pass through untouched; nested objects are dropped (kept flat + safe).
 */
export function redactSyncMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== 'object') return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(metadata)) {
    if (typeof v === 'string') out[k] = redactSyncMessage(v)
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k] = v
    // objects/arrays/functions are dropped — metadata stays a flat scalar bag
  }
  return out
}

/**
 * Validate + normalise a sync event for append. Returns null when the input is
 * unusable (missing seller, unknown kind) so the caller silently drops it rather
 * than writing garbage — the log must never itself throw into a sync path.
 */
export function summarizeSyncEvent(input: SyncEventInput): ShapedSyncEvent | null {
  const sellerId = (input.sellerId ?? '').trim()
  if (!sellerId) return null
  if (!SYNC_EVENT_KINDS.includes(input.kind as SyncEventKind)) return null
  const outcome: SyncEventOutcome = input.outcome === 'fail' ? 'fail' : 'ok'
  const code = input.code ? String(input.code).slice(0, 80) : null
  return {
    seller_id: sellerId,
    product_id: input.productId ? String(input.productId) : null,
    ml_item_id: input.mlItemId ? String(input.mlItemId) : null,
    kind: input.kind as SyncEventKind,
    outcome,
    code,
    message: redactSyncMessage(input.message),
    metadata: redactSyncMetadata(input.metadata),
  }
}
