// deploy-cicd-telegram-notifier-frontend.test.js — frontend-vercel-to-cloudrun Sprint 3,
// Story 3.5: static drift guard for the frontend Telegram-notifier wrapper. Pure fs read,
// zero deps, no live gcloud calls. Run: `node --test infra/gcp/test/` from this repo's root.
//
// Locks in the "zero code duplication" decision: the wrapper must call the SAME shared
// deploy-cicd-telegram-notifier.sh (index.js unmodified), only overriding env vars, rather
// than forking a second copy of the script/source.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const GCP_DIR = path.join(__dirname, '..')
const src = fs.readFileSync(path.join(GCP_DIR, 'deploy-cicd-telegram-notifier-frontend.sh'), 'utf8')

test('wrapper calls the shared deploy-cicd-telegram-notifier.sh, not a forked copy', () => {
  assert.match(src, /bash "\$\{SOURCE_DIR\}\/deploy-cicd-telegram-notifier\.sh"/)
})

test('wrapper unsets BACKEND_TRIGGER_ID before invoking the shared script (env-leak guard)', () => {
  // BACKEND_TRIGGER_ID's default in the shared script is a live lookup keyed on
  // BACKEND_TRIGGER_NAME -- but `${VAR:-default}` only applies when VAR is genuinely unset, so a
  // value left exported from an earlier backend-deploy invocation in the same shell would
  // silently win and point this frontend function at the BACKEND's trigger instead. Regression
  // guard for a real finding from Codex cross-review (PR #75).
  const unsetIdx = src.indexOf('unset BACKEND_TRIGGER_ID')
  const invokeIdx = src.indexOf('bash "${SOURCE_DIR}/deploy-cicd-telegram-notifier.sh"')
  assert.ok(unsetIdx !== -1, 'expected an explicit `unset BACKEND_TRIGGER_ID`')
  assert.ok(unsetIdx < invokeIdx, 'the unset must happen BEFORE the shared script is invoked')
})

test('wrapper uses a distinct FUNCTION_NAME + SERVICE_ACCOUNT_NAME from the backend defaults', () => {
  assert.match(src, /FUNCTION_NAME="cicd-telegram-build-notifier-frontend"/)
  assert.match(src, /SERVICE_ACCOUNT_NAME="cicd-telegram-notifier-frontend"/)
  assert.doesNotMatch(src, /FUNCTION_NAME="cicd-telegram-build-notifier"\s*$/m, 'must not reuse the backend function name — would collide/overwrite it')
})

test('wrapper points at the frontend repo + its own Cloud Build trigger, not the backend\'s', () => {
  assert.match(src, /BACKEND_REPO_NAME="miyagisanchezcommerce"/)
  assert.match(src, /BACKEND_TRIGGER_NAME="frontend-main-deploy"/)
})

test('the notifier source (index.js) is untouched by this story — zero code changes', () => {
  const indexSrc = fs.readFileSync(path.join(GCP_DIR, 'cicd-telegram-notifier', 'index.js'), 'utf8')
  // shouldNotifyBuild must still read the singular env vars (not a list/array shape) --
  // if this ever changes, it means someone generalized the filter instead of using the
  // two-instances-of-one-function approach this wrapper depends on.
  assert.match(indexSrc, /firstPresent\(env\.BACKEND_TRIGGER_ID\)/)
  assert.doesNotMatch(indexSrc, /WATCHED_TRIGGER_IDS/, 'if this exists, the filter was generalized to a list -- update this wrapper/test accordingly')
})
