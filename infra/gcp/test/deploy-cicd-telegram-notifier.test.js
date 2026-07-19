// deploy-cicd-telegram-notifier.test.js — current-project guard for the shared
// Telegram notifier deploy script. Pure fs read; no live gcloud calls.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const GCP_DIR = path.join(__dirname, '..')
const src = fs.readFileSync(path.join(GCP_DIR, 'deploy-cicd-telegram-notifier.sh'), 'utf8')

test('shared notifier deploy defaults to the current production project', () => {
  assert.match(src, /PROJECT_ID="\$\{PROJECT_ID:-miyagisanchez-prod\}"/)
  assert.doesNotMatch(src, /miyagisanchezback-497722/)
})

test('shared notifier deploy never mutates the caller gcloud configuration', () => {
  assert.doesNotMatch(src, /gcloud\s+config\s+set\s+project/)
})

test('required API enablement is explicitly scoped to the selected project', () => {
  const servicesEnable = src.match(/gcloud services enable[\s\S]*?>\/dev\/null/)
  assert.ok(servicesEnable, 'expected the required API enablement command')
  assert.match(servicesEnable[0], /--project="\$\{PROJECT_ID\}"/)
})
