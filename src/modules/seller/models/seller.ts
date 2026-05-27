import { model } from '@medusajs/framework/utils'

const Seller = model.define('seller', {
  id: model.id({ prefix: 'sel' }).primaryKey(),
  // Clerk user ID — the authenticated seller identity
  clerk_user_id: model.text().unique(),
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
  // All shop settings: stripe connect, checkout prefs, shipping, offers, theme, calcom
  // Same shape as the old marketplace_shops.metadata JSONB
  metadata: model.json().nullable(),
})

export default Seller
