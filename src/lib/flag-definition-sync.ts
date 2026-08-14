import {
  createFlagDefinitionSyncClient,
  type FlagDefinitionSyncClient,
  type FlagDefinitionSyncResult,
} from '@golden-frijoles/sdk'
import { BACKEND_FLAG_DEFINITION_CATALOG } from './flag-definition-catalog'

export type FlagDefinitionSyncEnvironment = {
  GROWTH_ENGINE_URL?: string
  GOLDEN_BEANS_FLAG_SYNC_KEY?: string
}

export type FlagDefinitionSyncConfiguration = {
  baseUrl: string
  flagSyncKey: string
}

function requireOperatorEnvironment(
  value: string | undefined,
  name: keyof FlagDefinitionSyncEnvironment,
): string {
  const normalized = value?.trim()
  if (!normalized) {
    throw new Error(`${name} is required for the explicit flags:sync command`)
  }
  return normalized
}

/**
 * Reads only the explicit operator command's environment. This deliberately
 * does not load dotenv files or participate in Medusa startup configuration.
 */
export function resolveFlagDefinitionSyncConfiguration(
  env: FlagDefinitionSyncEnvironment,
): FlagDefinitionSyncConfiguration {
  const baseUrl = requireOperatorEnvironment(env.GROWTH_ENGINE_URL, 'GROWTH_ENGINE_URL')
  const flagSyncKey = requireOperatorEnvironment(
    env.GOLDEN_BEANS_FLAG_SYNC_KEY,
    'GOLDEN_BEANS_FLAG_SYNC_KEY',
  )

  let parsedUrl: URL
  try {
    parsedUrl = new URL(baseUrl)
  } catch {
    throw new Error('GROWTH_ENGINE_URL must be an absolute http(s) URL')
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new Error('GROWTH_ENGINE_URL must be an absolute http(s) URL')
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ''), flagSyncKey }
}

export async function syncBackendFlagDefinitionCatalog(
  configuration: FlagDefinitionSyncConfiguration,
  client: FlagDefinitionSyncClient = createFlagDefinitionSyncClient(configuration),
): Promise<Extract<FlagDefinitionSyncResult, { ok: true }>> {
  const result = await client.syncFlagDefinitions(BACKEND_FLAG_DEFINITION_CATALOG)
  if (!result.ok) {
    // Never include credentials in an operator error. The SDK's typed failure
    // gives the caller enough context to decide whether to fix config, retry a
    // network failure, or resolve a deliberate 409 definition conflict.
    throw new Error(`flag definition sync ${result.kind} failure: ${result.error}`)
  }
  return result
}
