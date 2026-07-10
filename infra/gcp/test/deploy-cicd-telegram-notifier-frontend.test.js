// deploy-cicd-telegram-notifier-frontend.test.js — frontend-vercel-to-cloudrun Sprint 3,
// Story 3.5: static drift guard for the frontend Telegram-notifier wrapper. Pure fs read,
// zero deps, no live gcloud calls. Run: `node --test infra/gcp/test/` from apps/backend.
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
