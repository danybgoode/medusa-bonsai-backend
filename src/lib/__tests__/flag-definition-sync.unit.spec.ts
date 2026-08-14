import type { FlagDefinitionSyncClient } from '@golden-frijoles/sdk'
import {
  resolveFlagDefinitionSyncConfiguration,
  syncBackendFlagDefinitionCatalog,
} from '../flag-definition-sync'

describe('backend flag-definition sync operator seam', () => {
  it('fails loudly before any network call when its dedicated operator config is absent', () => {
    expect(() => resolveFlagDefinitionSyncConfiguration({})).toThrow(
      'GROWTH_ENGINE_URL is required for the explicit flags:sync command',
    )
    expect(() =>
      resolveFlagDefinitionSyncConfiguration({ GROWTH_ENGINE_URL: 'https://golden.example' }),
    ).toThrow('GOLDEN_BEANS_FLAG_SYNC_KEY is required for the explicit flags:sync command')
    expect(() =>
      resolveFlagDefinitionSyncConfiguration({
        GROWTH_ENGINE_URL: 'file:///not-golden',
        GOLDEN_BEANS_FLAG_SYNC_KEY: 'dedicated-key',
      }),
    ).toThrow('GROWTH_ENGINE_URL must be an absolute http(s) URL')
  })

  it('normalizes the endpoint and sends the full catalog only through the explicit client', async () => {
    const syncFlagDefinitions = jest.fn().mockResolvedValue({
      ok: true,
      contractVersion: 1,
      entries: [],
    })
    const configuration = resolveFlagDefinitionSyncConfiguration({
      GROWTH_ENGINE_URL: 'https://golden.example///',
      GOLDEN_BEANS_FLAG_SYNC_KEY: 'dedicated-key',
    })
    expect(configuration).toEqual({
      baseUrl: 'https://golden.example',
      flagSyncKey: 'dedicated-key',
    })

    const result = await syncBackendFlagDefinitionCatalog(
      configuration,
      { syncFlagDefinitions } as unknown as FlagDefinitionSyncClient,
    )

    expect(result.ok).toBe(true)
    expect(syncFlagDefinitions).toHaveBeenCalledTimes(1)
    expect(syncFlagDefinitions.mock.calls[0][0]).toHaveLength(13)
  })

  it('propagates a typed sync failure loudly instead of masking a control-plane write error', async () => {
    const syncFlagDefinitions = jest.fn().mockResolvedValue({
      ok: false,
      kind: 'http',
      error: 'Definition conflicts with version 1',
      status: 409,
    })

    await expect(
      syncBackendFlagDefinitionCatalog(
        { baseUrl: 'https://golden.example', flagSyncKey: 'dedicated-key' },
        { syncFlagDefinitions } as unknown as FlagDefinitionSyncClient,
      ),
    ).rejects.toThrow('flag definition sync http failure: Definition conflicts with version 1')
  })
})
