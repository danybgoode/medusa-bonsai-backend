import { buildPriceGrid } from '../price-grid'
import { sanitizeSellerMetadata, toListingShape, toSellerShape } from '../listing'

describe('public seller market projection', () => {
  const seller = {
    id: 'sel_1',
    slug: 'shop',
    name: 'Shop',
    clerk_user_id: 'user_owner_private',
    metadata: {
      operating_market: 'us',
      calcom_api_key: 'private-calcom-key',
      stripe_account_id: 'acct_private',
      payout_bank: 'private-bank',
      internal_note: 'never public',
      mp_enabled: true,
      settings: {
        theme: { accent_color: '#123456' },
        stripe: {
          account_id: 'acct_live_nested',
          enabled: true,
          charges_enabled: true,
          details_submitted: true,
        },
        checkout: {
          show_phone: true,
          phone: '5551234567',
          bank_transfer: {
            enabled: true,
            clabe: '012345678901234567',
            bank_name: 'Private Bank',
            account_holder: 'Private Person',
          },
          dimo: { enabled: true, phone: '5559876543' },
        },
        calcom: {
          connected: true,
          booking_url: 'https://cal.example/shop',
          api_key: 'private-nested-calcom-key',
        },
        mercadopago: {
          connected: true,
          user_id: 'mp-private-identity',
          public_key: 'APP_USR-public-but-unused',
          access_token: 'secret-access',
          refresh_token: 'secret-refresh',
        },
      },
    },
    created_at: '2026-01-01',
  }

  it('promotes market facts and removes the private metadata key and OAuth tokens', () => {
    const projected = toSellerShape(seller)
    expect(projected).toMatchObject({
      market_code: 'us',
      country_code: 'us',
      currency_code: 'usd',
      marketplace_status: 'active',
    })
    expect(projected.metadata).toEqual({
      mp_enabled: true,
      settings: {
        theme: { accent_color: '#123456' },
        stripe: {
          enabled: true,
          charges_enabled: true,
          details_submitted: true,
          connected: true,
        },
        checkout: {
          show_phone: true,
          phone: '5551234567',
          bank_transfer: { enabled: true, configured: true },
          dimo: { enabled: true, configured: true },
        },
        calcom: {
          connected: true,
          booking_url: 'https://cal.example/shop',
        },
        mercadopago: { connected: true },
      },
    })
    expect(JSON.stringify(projected.metadata)).not.toMatch(
      /acct_live_nested|012345678901234567|Private Bank|Private Person|mp-private-identity|APP_USR|secret-access|secret-refresh|api_key/,
    )
  })

  it('does not mutate the seller metadata bag while sanitizing it', () => {
    sanitizeSellerMetadata(seller.metadata)
    expect(seller.metadata.operating_market).toBe('us')
    expect(seller.metadata.settings.mercadopago.access_token).toBe('secret-access')
    expect(seller.metadata.settings.checkout.bank_transfer.clabe).toBe('012345678901234567')
  })
})

describe('buildPriceGrid — currency comes from the caller market', () => {
  const product = {
    id: 'prod_1',
    variants: [{
      id: 'var_1',
      prices: [
        { amount: 100, currency_code: 'mxn', min_quantity: 1 },
        { amount: 20, currency_code: 'usd', min_quantity: 1 },
        { amount: 18, currency_code: 'usd', min_quantity: 10 },
      ],
    }],
  }

  it('returns only the requested market currency and preserves quantity order', () => {
    expect(buildPriceGrid(product, 'usd').variants[0].tiers).toEqual([
      { amount: 20, min_quantity: 1, max_quantity: null },
      { amount: 18, min_quantity: 10, max_quantity: null },
    ])
  })

  it('listing display selects the registry currency, not the cheapest foreign price', () => {
    const listing = toListingShape({
      ...product,
      title: 'Market item',
      status: 'published',
      created_at: '2026-01-01',
      metadata: { price_cents: 100, currency: 'mxn' },
    }, { id: 'sel_us', slug: 'us-shop', metadata: { operating_market: 'us' } })
    expect(listing.price_cents).toBe(20)
    expect(listing.currency).toBe('USD')
  })
})
