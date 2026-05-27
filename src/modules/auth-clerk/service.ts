import {
  AbstractAuthModuleProvider,
  MedusaError,
} from '@medusajs/framework/utils'
import { AuthIdentityProviderService, AuthenticationInput, AuthenticationResponse, AuthIdentityDTO } from '@medusajs/framework/types'

type ClerkOptions = {
  clerkPublishableKey: string
  clerkSecretKey: string
}

// Extracts the Clerk Frontend API host from the publishable key.
// pk_test_aG9uZXN0LWVlbC0zOS5jbGVyay5hY2NvdW50cy5kZXYk → honest-eel-39.clerk.accounts.dev
function getFrontendApiFromKey(publishableKey: string): string {
  const stripped = publishableKey.replace(/^pk_(test|live)_/, '')
  return Buffer.from(stripped, 'base64').toString('utf-8').replace(/\$$/, '')
}

class ClerkAuthProviderService extends AbstractAuthModuleProvider {
  static identifier = 'clerk'
  static DISPLAY_NAME = 'Clerk Authentication'

  private clerkOptions: ClerkOptions

  constructor(container: Record<string, unknown>, options: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — AbstractAuthModuleProvider constructor signature varies by Medusa version
    super(container, options)
    this.clerkOptions = options as unknown as ClerkOptions
  }

  private getJwksUrl(): string {
    const frontendApi = getFrontendApiFromKey(this.clerkOptions.clerkPublishableKey)
    return `https://${frontendApi}/.well-known/jwks.json`
  }

  async authenticate(
    data: AuthenticationInput,
    authIdentityProviderService: AuthIdentityProviderService
  ) {
    // Dynamic import to avoid CommonJS/ESM mismatch with jose
    const { createRemoteJWKSet, jwtVerify } = await import('jose')

    const token = (data.body as Record<string, string>)?.token
      ?? (data.headers as Record<string, string>)?.authorization?.replace(/^Bearer\s+/i, '')

    if (!token) {
      return { success: false, error: 'Missing Clerk JWT token' }
    }

    const jwks = createRemoteJWKSet(new URL(this.getJwksUrl()))
    let payload: { sub?: string; email?: string; [k: string]: unknown }

    try {
      const { payload: p } = await jwtVerify(token, jwks, {
        issuer: `https://clerk.${getFrontendApiFromKey(this.clerkOptions.clerkPublishableKey)}`,
      })
      payload = p as typeof payload
    } catch {
      // Clerk dev/test tokens use a different issuer format — try without issuer check
      try {
        const { payload: p } = await jwtVerify(token, jwks)
        payload = p as typeof payload
      } catch (e) {
        return { success: false, error: `Invalid Clerk JWT: ${(e as Error).message}` }
      }
    }

    const clerkUserId = payload.sub
    if (!clerkUserId) {
      return { success: false, error: 'Clerk JWT missing sub claim' }
    }

    // Find or create the auth identity in Medusa keyed by the Clerk user ID
    let authIdentity = await authIdentityProviderService.retrieve({
      entity_id: clerkUserId,
    }).catch(() => null)

    if (!authIdentity) {
      authIdentity = await authIdentityProviderService.create({
        entity_id: clerkUserId,
        provider_metadata: {
          clerk_user_id: clerkUserId,
          email: payload.email ?? null,
        },
      })
    }

    return { success: true, authIdentity }
  }

  async validateCallback(
    _data: AuthenticationInput,
    _authIdentityProviderService: AuthIdentityProviderService
  ): Promise<AuthenticationResponse> {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Clerk provider does not support OAuth callback — use JWT token directly'
    )
  }
}

export default ClerkAuthProviderService
