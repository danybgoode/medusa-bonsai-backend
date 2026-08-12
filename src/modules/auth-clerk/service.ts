import {
  AbstractAuthModuleProvider,
  MedusaError,
} from '@medusajs/framework/utils'
import { AuthIdentityProviderService, AuthenticationInput, AuthenticationResponse, AuthIdentityDTO } from '@medusajs/framework/types'
// ONE copy of the instance-identity seam — see lib/clerk-issuer.ts for why.
import { getFrontendApiFromKey, jwksUrl, logIssuerMismatch, resolveClerkIssuer } from '../../lib/clerk-issuer'

type ClerkOptions = {
  clerkPublishableKey: string
  clerkSecretKey: string
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
    return jwksUrl(getFrontendApiFromKey(this.clerkOptions.clerkPublishableKey))
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

    // The SECOND copy of the issuer bug fixed in `api/store/_utils/clerk-verify.ts`
    // (PR #148). `https://clerk.${frontendApi}` is wrong for both key shapes — the live
    // key already decodes to `clerk.miyagisanchez.com`, so this asked for
    // `https://clerk.clerk.miyagisanchez.com`, always threw, and the catch below
    // retried with NO issuer check. Every token this provider ever accepted was
    // therefore unbound to an issuer.
    //
    // Fixing one copy and leaving the other is how a class of bug survives its own
    // fix, so both move together. The signature check here was always sound (the JWKS
    // URL is right), so no `sub` was forgeable through this provider — but a token
    // minted by any Clerk instance would have passed.
    const issuer = await resolveClerkIssuer(getFrontendApiFromKey(this.clerkOptions.clerkPublishableKey))
    try {
      const { payload: p } = await jwtVerify(token, jwks, { issuer, clockTolerance: 30 })
      payload = p as typeof payload
    } catch (e) {
      // Diagnose, then refuse. No retry without the issuer check: that retry was the
      // only path this code ever took.
      logIssuerMismatch('auth-clerk', token, issuer)
      return { success: false, error: `Invalid Clerk JWT: ${(e as Error).message}` }
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
