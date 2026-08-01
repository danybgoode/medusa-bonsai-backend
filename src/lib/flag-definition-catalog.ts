import type { FlagDefinition, FlagDefinitionSyncEntry } from '@golden-beans/sdk'
import { BACKEND_FLAG_CATALOG, type BackendFlagCatalogEntry } from './flag-catalog'

/**
 * Builds Golden's immutable boolean-definition shape from the backend's typed
 * source-of-truth catalog. Publishing is intentionally separate from runtime
 * evaluation: this is consumed only by the explicit `npm run flags:sync` rail.
 */
export function buildBackendFlagDefinition(
  entry: BackendFlagCatalogEntry,
): FlagDefinition {
  return {
    valueType: 'boolean',
    description: entry.description,
    defaultVariantKey: entry.goldenDefault ? 'on' : 'off',
    variants: [
      { key: 'off', value: false },
      { key: 'on', value: true },
    ],
    rules: [],
    metadata: {
      source: 'miyagi',
      polarity: entry.polarity,
      criticality: entry.criticality,
      enforcement: entry.goldenEnforcement,
    },
  }
}

/** The eleven pre-existing flags governed by both deployed Miyagi services. */
export const BACKEND_FLAG_DEFINITION_SHARED_KEYS = Object.freeze(
  BACKEND_FLAG_CATALOG.filter(
    (entry) => entry.enforcement === 'both' && entry.key !== 'catalog.owned_shop_only_enabled',
  ).map((entry) => entry.key),
)

/**
 * Deterministic, app-owned fragment. Omitting a Golden definition from this
 * list never deletes it; the control plane only creates a missing v1 or
 * verifies an identical no-op.
 */
export const BACKEND_FLAG_DEFINITION_CATALOG: readonly FlagDefinitionSyncEntry[] =
  Object.freeze(
    BACKEND_FLAG_CATALOG.map((entry) => ({
      key: entry.key,
      definition: buildBackendFlagDefinition(entry),
    })),
  )
