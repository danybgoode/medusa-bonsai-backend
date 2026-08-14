import { model } from '@medusajs/framework/utils'

const Seller = model.define('seller', {
  id: model.id({ prefix: 'sel' }).primaryKey(),
  // Clerk user ID — the authenticated seller identity.
  // NULL = unclaimed (supply-imported) shop awaiting its real owner via the claim flow.
  clerk_user_id: model.text().unique().nullable(),
  // URL slug for the storefront (/s/[slug])
  slug: model.text().unique(),
  name: model.text(),
  description: model.text().nullable(),
  location: model.text().nullable(),
  logo_url: model.text().nullable(),
  // source: 'scraped' | 'claimed' | 'registered' (for supply pipeline)
  source: model.text().nullable(),
  source_url: model.text().nullable(),
  verified: model.boolean().default(false),
  // Lifecycle state — 'active' | 'paused' | 'deleted' (tenant-lifecycle-admin · D1).
  //
  // `model.text()` with a validated parser at the seam rather than a DB enum, matching
  // how `source` is already modelled here: adding a state to a Postgres enum needs a
  // migration and a deploy, and the parser is what every caller goes through anyway.
  // Unrecognised values are REFUSED by `parseSellerStatus`, never coerced to 'active' —
  // a shop whose status we cannot read must not silently read as open for business.
  //
  // Visibility is NOT enforced by this column alone. Pausing also unlinks the seller's
  // products from every market sales channel (Medusa's own publication truth), and the
  // checkout admission seam re-checks this status per object. Belt and braces: the
  // unlink is the mechanism, the status check is the guarantee.
  status: model.text().default('active'),
  // All shop settings: stripe connect, checkout prefs, shipping, offers, theme, calcom
  // Same shape as the old marketplace_shops.metadata JSONB
  metadata: model.json().nullable(),
})

export default Seller
