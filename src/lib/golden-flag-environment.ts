/**
 * The Golden Frijoles environment this process serves. Pure (testable without Next.js).
 *
 * Explicit configuration is required: production is never inferred from NODE_ENV, because a
 * wrongly inferred environment would silently serve another environment's decisions.
 */
export type GoldenFlagEnvironment = 'development' | 'preview' | 'production'

const GOLDEN_FLAG_ENVIRONMENTS: ReadonlySet<string> = new Set(['development', 'preview', 'production'])

export function parseGoldenFlagEnvironment(value: string | undefined): GoldenFlagEnvironment | undefined {
  return value && GOLDEN_FLAG_ENVIRONMENTS.has(value) ? (value as GoldenFlagEnvironment) : undefined
}
