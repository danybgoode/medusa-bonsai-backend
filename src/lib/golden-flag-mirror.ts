/** Pure validation/evaluation for the local durable Golden Beans snapshot. */
import {
  evaluateFlag,
  parseFlagSnapshot,
  type FlagResolutionReason,
  type FlagSnapshot,
} from '@golden-frijoles/sdk'
import type { GoldenFlagEnvironment } from './flag-provider-mode'

export type DurableGoldenBooleanEvaluation = {
  value: boolean
  snapshotVersion: number
  flagVersion?: number
  reason: FlagResolutionReason
}

export function parseDurableGoldenSnapshot(
  input: unknown,
  environment: GoldenFlagEnvironment,
): FlagSnapshot | undefined {
  const parsed = parseFlagSnapshot(input)
  if (!parsed.ok || parsed.snapshot.environment !== environment) return undefined
  return parsed.snapshot
}

/** Evaluates locally; no network call or request-derived data is involved. */
export function evaluateDurableGoldenBooleanFlag(
  snapshot: FlagSnapshot,
  flagKey: string,
  defaultValue: boolean,
): DurableGoldenBooleanEvaluation {
  const details = evaluateFlag({
    flag: snapshot.flags.find((flag) => flag.key === flagKey),
    defaultValue,
    expectedType: 'boolean',
  })
  return {
    value: details.value,
    snapshotVersion: snapshot.snapshotVersion,
    flagVersion: details.flagVersion,
    reason: details.reason,
  }
}
