import { loadEnv, defineConfig } from '@medusajs/framework/utils'

loadEnv(process.env.NODE_ENV || 'development', process.cwd())

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || 'supersecret',
      cookieSecret: process.env.COOKIE_SECRET || 'supersecret',
    },
  },

  modules: [
    // ── Payment providers ──────────────────────────────────────────────────────
    {
      resolve: '@medusajs/medusa/payment',
      options: {
        providers: [
          // Stripe Connect Express — sellers get paid directly, 0% platform fee
          // Custom provider: handles Stripe Checkout redirect + transfer_data
          {
            resolve: './src/modules/payment-stripe-connect',
            id: 'stripe-connect',
            options: {
              apiKey: process.env.STRIPE_SECRET_KEY,
              webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
            },
          },
          // MercadoPago — preferred payment method in Mexico
          {
            resolve: './src/modules/payment-mercadopago',
            id: 'mercadopago',
            options: {
              accessToken: process.env.MP_ACCESS_TOKEN,
            },
          },
        ],
      },
    },

    // ── Seller module (custom multi-vendor) ────────────────────────────────────
    {
      resolve: './src/modules/seller',
    },

    // ── Subscriptions module (recurring billing — Stripe + MP + SPEI) ─────────
    {
      resolve: './src/modules/subscriptions',
    },

    // ── Auth providers ─────────────────────────────────────────────────────────
    {
      resolve: '@medusajs/medusa/auth',
      options: {
        providers: [
          // Default email+password provider — required for admin login
          {
            resolve: '@medusajs/auth-emailpass',
            id: 'emailpass',
            options: {},
          },
          // Clerk JWT bridge — validates Clerk tokens so the frontend can call
          // Medusa Store API without a separate Medusa login.
          {
            resolve: './src/modules/auth-clerk',
            id: 'clerk',
            options: {
              clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
              clerkSecretKey: process.env.CLERK_SECRET_KEY,
            },
          },
        ],
      },
    },
  ],
})
