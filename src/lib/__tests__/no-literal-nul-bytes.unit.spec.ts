import fs from 'node:fs'
import path from 'node:path'

/**
 * No source file may contain a LITERAL NUL byte.
 *
 * This is not style. A NUL in any changed file lands in the PR diff, and
 * `child_process.spawnSync` refuses an argv string containing one:
 *
 *   TypeError [ERR_INVALID_ARG_VALUE]: The argument 'args[1]' must be a string
 *   without null bytes
 *
 * `scripts/cross-review.mjs` passes the diff to the reviewer CLI through argv, so a
 * single literal NUL **crashes the mandatory cross-agent review layer** instead of
 * reviewing. Measured on PR 130 (2026-07-31): the review died on exactly this and,
 * because the runner's output was tailed, very nearly read as "no findings" on a
 * HIGH-tier money-path diff. A missing review layer that looks like a clean one is
 * the worst possible failure mode — `WAYS-OF-WORKING` says a missing layer must be
 * loud.
 *
 * Git also stops diffing a file once it sniffs a NUL in the first 8 KB, so the file
 * becomes un-reviewable and un-blameable. That is how this got in twice: the SPEC
 * tripped git's sniffer and got fixed, while the SOURCE file's NULs sat past the
 * 8 KB window and were missed — the "guard the population, not the door you found"
 * trap, in a single PR.
 *
 * NUL is a legitimate composite-key delimiter. Write it as the ESCAPE SEQUENCE
 * (backslash-u-0000) — identical at runtime, and the file stays text.
 */
const SRC = path.join(process.cwd(), 'src')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.medusa') continue
      walk(full, out)
    } else if (/\.(ts|tsx|js|mjs|json)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

describe('no literal NUL bytes in source', () => {
  it('every source file is free of literal NUL bytes (they crash cross-review)', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const buf = fs.readFileSync(file)
      // `buf.includes(0)` first: it short-circuits and, for the overwhelmingly
      // common clean file, avoids allocating anything. Only a real offender pays
      // for the count. (The earlier `buf.filter(...).length` allocated a filtered
      // copy of every one of 200+ files on every CI run.)
      if (!buf.includes(0)) continue
      let count = 0
      for (const b of buf) if (b === 0) count += 1
      offenders.push(`${path.relative(process.cwd(), file)} (${count})`)
    }
    expect(offenders).toEqual([])
  })

  it('scans a non-trivial population — a guard over an empty set proves nothing', () => {
    // Guard the guard: if the walk silently stopped matching files, the assertion
    // above would pass vacuously forever.
    expect(walk(SRC).length).toBeGreaterThan(200)
  })
})
