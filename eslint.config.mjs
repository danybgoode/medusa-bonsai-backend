// eslint.config.mjs — the backend's FIRST static analysis of any kind.
//
// Until now this was the only one of the three repos with no ESLint or Prettier config at all — not
// disabled, not unwired, simply absent (external audit, 2026-07-24; confirmed against the tree
// 2026-07-26). Its entire CI gate was `medusa build` → `tsc --noEmit` → `npm run test:unit`.
//
// ── Deliberately minimal, and that is the point ───────────────────────────────────────────────
// The temptation with a first config is to enable a recommended preset wholesale and feel thorough.
// That produces hundreds of findings on a mature codebase, which then get downgraded or the whole
// gate gets skipped — and a rule set nobody keeps green is worse than none, because it looks like
// coverage. The frontend is living proof: it HAS a full config and 124 errors nobody could act on,
// which is exactly why its gate had to be made incremental.
//
// So this starts from the rules that catch genuine mistakes rather than style opinions, runs green
// today, and is meant to GROW deliberately. Adding a rule is a normal PR; the bar is that the tree
// stays green when you add it.
//
// NOT eslint-config-next: there is no React and no Next.js here. Importing the frontend's config
// would pull in rules that cannot apply, which is how a config starts lying about what it checks.
//
// Type-aware linting (typescript-eslint's `recommendedTypeChecked`) is deliberately NOT enabled: it
// needs a full type-graph build on every run, and `medusa build` already generates the `.medusa/types`
// that `tsc --noEmit` consumes in CI. Duplicating that cost buys little the type-check does not
// already catch.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Build output, generated types, deps, and coverage artifacts. `.medusa/` is emitted by
    // `medusa build` and is not ours to lint.
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      '.medusa/**',
      'coverage/**',
      '*.config.js',
      'jest.config.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: {
      // ── Relaxed, with reasons ────────────────────────────────────────────────────────────────
      // Medusa's module/workflow APIs surface a lot of loosely-typed container and step payloads,
      // and `tsc --noEmit` already runs in this repo's CI against generated types. Turning this to
      // an error today would produce a large mechanical diff through commerce code with no
      // correctness gain — the same trade the frontend got wrong. Warn keeps it visible.
      '@typescript-eslint/no-explicit-any': 'warn',

      // Unused vars are worth seeing but are not a reason to block a merge, and the leading-underscore
      // convention is how intentionally-ignored params are already written here.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // ── Kept as errors: these catch real mistakes, not style ─────────────────────────────────
      // An empty block is nearly always an unfinished thought or a swallowed error. `catch {}` is
      // the one legitimate case and is allowed.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // `==` against null/undefined is idiomatic; every other loose comparison is a latent bug.
      eqeqeq: ['error', 'smart'],

      // A promise-returning call whose rejection nobody handles is a silent failure in a service —
      // the exact class of defect that is invisible until production.
      'no-async-promise-executor': 'error',

      // WARN, not error — and this one deserves its reason recorded, because the finding is real.
      //
      // On its very first run it flagged SIX genuine read-then-write cache patterns:
      //   src/api/internal/backfill-sales-channel/route.ts (channelId)
      //   src/api/store/_utils/fulfillment.ts (cachedOptions, cachedDefaultProfileId)
      //   src/lib/ml-order-materialize.ts (cachedMlSalesChannelId ×2, cachedMxnRegionId)
      // Each awaits between reading a module-level cache and writing it, so two concurrent requests
      // can both miss and both write — the same shape as "a read is not a claim" in LEARNINGS.
      //
      // They are almost certainly benign here (the cached values are stable ids, so a duplicated
      // fetch costs a round trip rather than correctness), but "almost certainly" is not a thing to
      // resolve blind while wiring up a lint config: each fix changes caching behaviour on live
      // commerce paths. Blocking the gate on them would force exactly the rushed judgement this
      // repo's escalation rule exists to prevent, and deleting the rule would throw away a real
      // signal. Warn keeps it visible and tracked as follow-up.
      'require-atomic-updates': 'warn',

      // Added 2026-08-19 to unblock the @eslint/js 10 bump (dependabot #139), which had been
      // red for twelve days on this one rule. v10 promotes `no-useless-assignment` into
      // `js.configs.recommended`; naming it here means the bump is a no-op instead of a
      // surprise, and the rule is enforced on v9 today rather than the day someone merges v10.
      //
      // It found exactly three sites, all the same deliberate shape:
      //   let x: T | null = null; try { x = await … } catch { return 5xx }
      // The seed is genuinely dead — every path assigns or returns — and on two of the three
      // (the portal write gate, the checkout admission read) `null` is the PERMISSIVE value.
      // Dropping the seed hands the job to TypeScript's definite-assignment check, which fails
      // a future branch that forgets to assign instead of quietly taking the lenient default.
      // That is the rare lint rule that made a fail-closed path more fail-closed.
      'no-useless-assignment': 'error',
    },
  },

  {
    // Tests legitimately reach for loose types and long fixtures.
    files: ['**/__tests__/**/*.ts', '**/*.spec.ts', 'integration-tests/**'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Jest module mocking legitimately uses require() inside a factory.
      '@typescript-eslint/no-require-imports': 'off',
    },
  }
);
