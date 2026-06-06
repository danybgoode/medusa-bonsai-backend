'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  esc,
  extractBuildFromPubSubEvent,
  formatTelegramMessage,
  handleBuildEvent,
  shouldNotifyBuild,
  statusLabel,
} = require('../index')

const env = {
  BACKEND_REPO_OWNER: 'danybgoode',
  BACKEND_REPO_NAME: 'medusa-bonsai-backend',
  BACKEND_BRANCH_NAME: 'main',
  BACKEND_TRIGGER_NAME: 'backend-main-deploy',
  BACKEND_TRIGGER_ID: 'trigger-123',
  BUILD_REGION: 'us-east4',
  GOOGLE_CLOUD_PROJECT: 'miyagisanchezback-497722',
  TELEGRAM_BOT_TOKEN: 'test-token',
  TELEGRAM_CICD_CHAT_ID: '-100123',
}

function build(overrides = {}) {
  return {
    id: 'build-123',
    projectId: 'miyagisanchezback-497722',
    buildTriggerId: 'trigger-123',
    status: 'SUCCESS',
    logUrl: 'https://console.cloud.google.com/cloud-build/builds;region=us-east4/build-123',
    substitutions: {
      BRANCH_NAME: 'main',
      COMMIT_SHA: 'abc1234def5678',
      REPO_FULL_NAME: 'danybgoode/medusa-bonsai-backend',
      REPO_NAME: 'medusa-bonsai-backend',
      SHORT_SHA: 'abc1234',
      TRIGGER_NAME: 'backend-main-deploy',
      ...overrides.substitutions,
    },
    ...overrides,
  }
}

function eventFor(payload) {
  return {
    data: {
      message: {
        data: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
      },
    },
  }
}

test('esc mirrors the Telegram HTML escape style', () => {
  assert.equal(esc('a & <b>'), 'a &amp; &lt;b&gt;')
})

test('status labels use success and failure emoji', () => {
  assert.equal(statusLabel('SUCCESS'), '✅ SUCCESS')
  assert.equal(statusLabel('FAILURE'), '❌ FAILURE')
  assert.equal(statusLabel('TIMEOUT'), '❌ TIMEOUT')
})

test('formats success message with repo, rocket, sha, header, status, and log URL', () => {
  const message = formatTelegramMessage({
    build: build(),
    commitHeader: 'feat: deploy backend',
    env,
  })

  assert.match(message, /<b>medusa-bonsai-backend<\/b> · 🚀 · <code>abc1234<\/code>/)
  assert.match(message, /feat: deploy backend/)
  assert.match(message, /<b>Status:<\/b> ✅ SUCCESS/)
  assert.match(message, /View build logs/)
})

test('formats failed builds and escapes commit headers', () => {
  const message = formatTelegramMessage({
    build: build({ status: 'FAILURE' }),
    commitHeader: 'fix: handle <oops> & retry',
    env,
  })

  assert.match(message, /❌ FAILURE/)
  assert.match(message, /fix: handle &lt;oops&gt; &amp; retry/)
})

test('extracts the Cloud Build object from a Pub/Sub CloudEvent', () => {
  const payload = build()
  assert.deepEqual(extractBuildFromPubSubEvent(eventFor(payload)), payload)
})

test('ignores non-terminal builds', () => {
  assert.equal(shouldNotifyBuild(build({ status: 'WORKING' }), env), false)
})

test('ignores builds from the wrong trigger', () => {
  assert.equal(shouldNotifyBuild(build({ buildTriggerId: 'other-trigger' }), env), false)
})

test('ignores builds from the wrong repo', () => {
  assert.equal(shouldNotifyBuild(build({
    substitutions: {
      REPO_NAME: 'some-other-repo',
      REPO_FULL_NAME: 'danybgoode/some-other-repo',
    },
  }), env), false)
})

test('sends one Telegram message for a terminal backend build', async () => {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options })
    if (String(url).includes('api.github.com')) {
      return {
        ok: true,
        async json() {
          return { commit: { message: 'deploy: backend <done> & live\n\nbody' } }
        },
      }
    }
    return { ok: true, async json() { return {} } }
  }

  const result = await handleBuildEvent(eventFor(build()), { env, fetchImpl })

  assert.equal(result.notified, true)
  assert.equal(calls.length, 2)
  assert.match(String(calls[1].url), /api\.telegram\.org/)
  assert.match(result.text, /deploy: backend &lt;done&gt; &amp; live/)
})

test('swallows Telegram failures', async () => {
  const originalWarn = console.warn
  console.warn = () => {}
  const fetchImpl = async (url) => {
    if (String(url).includes('api.github.com')) {
      return {
        ok: true,
        async json() {
          return { commit: { message: 'deploy: backend' } }
        },
      }
    }
    throw new Error('telegram down')
  }

  try {
    const result = await handleBuildEvent(eventFor(build()), { env, fetchImpl })
    assert.equal(result.notified, true)
  } finally {
    console.warn = originalWarn
  }
})
