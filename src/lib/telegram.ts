/**
 * Backend admin Telegram alerts (observability only).
 *
 * A tiny, self-contained mirror of the frontend `lib/telegram.ts` admin path —
 * the backend can't import the frontend module. Used by the ML stock-sync
 * reconciliation job to raise a **drift alert** when it can't self-heal a
 * Medusa↔ML quantity divergence.
 *
 * Fire-and-forget: never throws, never blocks the caller. If the bot token / chat
 * id aren't configured (they live in the frontend env today — adding them to the
 * Cloud Run env is owed), every call is a silent no-op. That is deliberate: a
 * missing alert channel must never break the money/inventory path.
 *
 * Env vars (Cloud Run): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const CHAT_ID = process.env.TELEGRAM_CHAT_ID

/** Escape the HTML special chars Telegram's `parse_mode: 'HTML'` reserves. */
export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Send an admin alert. No-ops when unconfigured; swallows all errors and bounds
 * the request so a hung Telegram can never stall the job.
 */
export async function tgNotifyAdmin(text: string): Promise<void> {
  if (!BOT_TOKEN || !CHAT_ID) return
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(5000),
    })
    // A bad bot token / chat id returns 4xx with a 200-shaped fetch — log a bounded
    // warning so a silently-broken alert channel is diagnosable (never throws).
    if (!res.ok) console.warn(`[telegram] sendMessage failed: ${res.status}`)
  } catch {
    // observability only — never surface to the caller
  }
}
