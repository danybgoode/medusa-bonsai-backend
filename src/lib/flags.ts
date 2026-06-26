/**
 * src/lib/flags.ts
 *
 * Backend (Medusa) half of the platform feature-flag / kill-switch layer, backed
 * by Flagsmith (SaaS, project "miyagisanchezmarketplace"). Mirrors the frontend
 * lib/flags.ts so a single Flagsmith flag governs BOTH apps. See the spike
 * decision: Roadmap/00-ideas/2. readyforscope/spikeflagsmith.md.
 *
 * This is the ENFORCEMENT half: the frontend hides a killed rail in the UI, but
 * agents/UCP and stale in-flight checkout pages hit the backend directly — so the
 * real kill must live here (checkout-options catalog + start-checkout guard).
 *
 * Design rules (non-negotiable — from the spike):
 *  1. FAIL-OPEN. Every read falls back to DEFAULT_FLAGS. Flagsmith being
 *     unreachable, slow, or missing the flag must NEVER break checkout. A
 *     kill-switch defaults to ENABLED (the feature stays on if Flagsmith is down).
 *  2. LOCAL EVALUATION, fast fail. The SDK evaluates the environment document
 *     in-memory (~0 ms/request, refreshed every 60 s); we bound the cold-start
 *     fetch to ~2 s (no retries) so a hung Flagsmith can't stall a checkout.
 *
 * Requires FLAGSMITH_ENVIRONMENT_KEY (the PRODUCTION server-side key) in the
 * Cloud Run env. Absent → runs on DEFAULT_FLAGS (never throws).
 */
import { Flagsmith, DefaultFlag } from 'flagsmith-nodejs'

export type FlagKey = 'checkout.stripe_enabled' | 'shipping.envia_enabled'

/**
 * Fail-open defaults. Two polarities live here — both fail-open, to opposite values:
 *  - KILL-SWITCH (`checkout.stripe_enabled`): default `true`. The feature keeps
 *    working if Flagsmith is down (disabling is the deliberate action).
 *  - ENABLEMENT (`shipping.envia_enabled`): default `false`. The Envia.com
 *    integration stays OFF if Flagsmith is unreachable — so a flag outage can never
 *    push checkout/fulfillment at an unfunded carrier; OFF ⇒ arranged-delivery /
 *    manual-carrier fallback. Enabling is the deliberate action (flip ON in
 *    Flagsmith the instant the platform Envía account is funded).
 */
const DEFAULT_FLAGS: Record<FlagKey, boolean> = {
  'checkout.stripe_enabled': true,
  'shipping.envia_enabled': false,
}

const ENV_KEY = process.env.FLAGSMITH_ENVIRONMENT_KEY

// Built once at module load (single-threaded → no init race / timer leak). null
// when no server-side key is configured → isEnabled() runs on DEFAULT_FLAGS.
const client: Flagsmith | null = ENV_KEY
  ? new Flagsmith({
      environmentKey: ENV_KEY,
      enableLocalEvaluation: true,
      // Refresh the Environment Document every 5 min, not the SDK default 60 s. Each
      // refresh is one Flagsmith API call, and the always-on Cloud Run instance
      // (min-instances=1) polls 24/7 regardless of traffic: 60 s ≈ 43k calls/mo (blew
      // the free tier with zero users), 300 s ≈ 8.6k. These flags are deliberate
      // kill-switches — a ~5 min flip-propagation delay is fine.
      environmentRefreshIntervalSeconds: 300,
      // Fail FAST on the checkout path: bound a hung Flagsmith to ~2 s instead of
      // the SDK default 3 retries × 10 s (+ delays) ≈ 33 s.
      requestTimeoutSeconds: 2,
      retries: 0,
      defaultFlagHandler: (flagKey: string) =>
        new DefaultFlag(null, DEFAULT_FLAGS[flagKey as FlagKey] ?? true),
    })
  : null

/**
 * Is a feature enabled? Never throws — returns the fail-open default on any error
 * or when Flagsmith isn't configured.
 */
export async function isEnabled(flag: FlagKey): Promise<boolean> {
  const fallback = DEFAULT_FLAGS[flag]
  if (!client) return fallback
  try {
    const flags = await client.getEnvironmentFlags()
    return flags.isFeatureEnabled(flag)
  } catch {
    return fallback
  }
}
