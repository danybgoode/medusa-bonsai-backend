import {
  resolveFlagDefinitionSyncConfiguration,
  syncBackendFlagDefinitionCatalog,
} from '../src/lib/flag-definition-sync'

async function main(): Promise<void> {
  const configuration = resolveFlagDefinitionSyncConfiguration(process.env)
  const result = await syncBackendFlagDefinitionCatalog(configuration)
  const created = result.entries.filter((entry) => entry.created).length
  console.log(`Golden flag catalog synced: ${result.entries.length} definitions (${created} created).`)
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown flag definition sync failure'
  console.error(`flags:sync failed: ${message}`)
  process.exitCode = 1
})
