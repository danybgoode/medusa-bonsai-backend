const { loadEnv } = require("@medusajs/utils");
loadEnv("test", process.cwd());

module.exports = {
  transform: {
    "^.+\\.[jt]s$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "typescript", decorators: true },
        },
      },
    ],
  },
  testEnvironment: "node",
  moduleFileExtensions: ["js", "ts", "json"],
  // `.worktrees/` is load-bearing, not tidiness. Without it jest's `**/src/**/__tests__/**` glob walks
  // into any git worktree checked out under this repo and runs ANOTHER BRANCH's specs alongside this
  // one. Measured 2026-07-27: 96 test files locally, 48 of them from `.worktrees/lint-in-ci` — so a
  // local "922 passing" was really ~455 for this branch plus a different branch's suite. Every local
  // count quoted in a PR body was inflated roughly 2x, and a spec deleted on this branch could still
  // "pass" from the worktree copy. CI never saw it because CI has no worktrees.
  modulePathIgnorePatterns: ["dist/", "<rootDir>/.medusa/", "<rootDir>/.worktrees/"],
  // Kept even though the integration tiers are gone: this is the setupFiles hook for EVERY test
  // type, including unit. Deleting the directory would break `npm run test:unit`.
  setupFiles: ["./integration-tests/setup.js"],
};

// ── Why there is only one tier here (qa-guardrail-hardening S2, 2026-07-26) ──────────────────
// There used to be two more: `TEST_TYPE=integration:http` matched
// `**/integration-tests/http/*.spec.[jt]s` — a directory that has never existed, so the script found
// zero tests and exited 0. A script that passes by running nothing is worse than no script, because
// it reads as a green gate. `TEST_TYPE=integration:modules` matched `src/modules/*/__tests__/`,
// which is the same files the unit suite already runs — a second label on one tier, not a second tier.
//
// Both were removed rather than repaired. Writing a real HTTP integration tier needs a Postgres (and
// Redis) service in CI and is genuine scope; inventing tests to justify an existing script is not a
// reason to write them. So: this repo had NO integration tier, and that absence was made visible
// instead of disguised, which was the whole point of removing them.
//
// ── The tier that absence was waiting for (2026-08-25) ──────────────────────────────────────────
// `integration:http` is now REAL: `integration-tests/http/*.integration.spec.ts`, run against the
// Postgres + Redis service containers in ci.yml via `@medusajs/test-utils`. It exists because the
// Medusa 2.17.2 -> 2.19.0 upgrade (68 packages, the whole engine) went green through a gate that had
// never created a cart — and auto-merge had already queued it for an unattended production deploy.
//
// The earlier version of this label matched a directory that did not exist and exited 0. This one
// must never be allowed to do that: `npm run test:integration:http` passes `--passWithNoTests=false`
// so an empty match is a FAILURE, not a green gate. That is the whole lesson of the paragraph above.
if (process.env.TEST_TYPE === "unit") {
  module.exports.testMatch = ["**/src/**/__tests__/**/*.unit.spec.[jt]s"];
}

if (process.env.TEST_TYPE === "integration:http") {
  module.exports.testMatch = ["**/integration-tests/http/**/*.integration.spec.[jt]s"];
}
