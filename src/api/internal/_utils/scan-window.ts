/**
 * scan-window.ts — "did I see the whole population, or just the first page?"
 *
 * Every capped read in this codebase looks like `{ take: 5000 }` and every caller then
 * reports the row count as if it were the total. That is inferring "is there more?"
 * from how many rows came back, which `LEARNINGS.md` names explicitly: you cannot.
 * A backfill that scans the first 5000 of 6000 products and reports `applied: true`
 * has silently skipped a thousand rows and told you it was done.
 *
 * THREE STATES, NEVER TWO — complete / truncated / (the caller's own) unavailable.
 * The honest test is whether the result FILLED the window: if it did, there may be
 * more and the count is not authoritative. It can be conservative (a population of
 * exactly `cap` reads as truncated), and conservative is the correct direction: it
 * costs one re-run with a bigger window, versus a partial apply nobody notices.
 */

export interface ScanWindow {
  /** How many rows came back. */
  readonly scanned: number
  /** The `take` that produced them. */
  readonly cap: number
  /** False when the window was filled — counts derived from it are NOT authoritative. */
  readonly complete: boolean
  /** Operator-facing explanation, present only when truncated. */
  readonly reason?: string
}

export function describeScan(scanned: number, cap: number, what: string): ScanWindow {
  if (scanned < cap) return { scanned, cap, complete: true }
  return {
    scanned,
    cap,
    complete: false,
    reason: `Scanned ${scanned} ${what}, which FILLED the ${cap}-row window — there may be more. ` +
      'Counts from this run are not authoritative and no write may be applied against it. ' +
      'Raise the cap (and paginate) before re-running.',
  }
}

/** True when every window in the run was complete. Used to gate an apply. */
export function everyScanComplete(...windows: ScanWindow[]): boolean {
  return windows.every((w) => w.complete)
}
