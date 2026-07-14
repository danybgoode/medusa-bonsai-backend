/**
 * Structured logging, first batch (deploy-pipeline-tuning S5). Emits single-line JSON to
 * stdout — Cloud Run/Cloud Logging auto-parses that into a filterable `jsonPayload`, and a
 * field literally named `severity` with one of GCP's LogSeverity strings gets promoted onto
 * the LogEntry itself (not just nested in jsonPayload), which is what makes it filterable by
 * severity, not just full-text search. No new dependency — plain `process.stdout.write`.
 */

export type LogSeverity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR'

export type LogFields = Record<string, unknown>

interface LogEntry {
  severity: LogSeverity
  message: string
  tag: string
  [key: string]: unknown
}

// JSON.stringify(new Error('x')) === '{}' -- Error's own properties (message/name/stack)
// aren't enumerable, so a raw Error passed through untouched silently disappears. Every
// Error-valued field gets flattened to a plain object first so the info survives serialization.
function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return { message: value.message, name: value.name, stack: value.stack }
  }
  return value
}

function serializeFields(fields?: LogFields): LogFields | undefined {
  if (!fields) return undefined
  const out: LogFields = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = serializeValue(value)
  }
  return out
}

export function buildLogEntry(
  severity: LogSeverity,
  tag: string,
  message: string,
  fields?: LogFields,
): LogEntry {
  return {
    severity,
    message: `[${tag}] ${message}`,
    tag,
    ...serializeFields(fields),
  }
}

function emit(severity: LogSeverity, tag: string, message: string, fields?: LogFields): void {
  process.stdout.write(JSON.stringify(buildLogEntry(severity, tag, message, fields)) + '\n')
}

export const logger = {
  info: (tag: string, message: string, fields?: LogFields) => emit('INFO', tag, message, fields),
  warn: (tag: string, message: string, fields?: LogFields) => emit('WARNING', tag, message, fields),
  error: (tag: string, message: string, fields?: LogFields) => emit('ERROR', tag, message, fields),
}
