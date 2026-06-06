'use strict'

let functions = { cloudEvent: () => {} }
try {
  functions = require('@google-cloud/functions-framework')
} catch {
  // Local unit tests exercise the pure helpers without installing deploy deps.
}

const TERMINAL_STATUSES = new Set([
  'SUCCESS',
  'FAILURE',
  'INTERNAL_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'EXPIRED',
])

const FAILURE_STATUSES = new Set([
  'FAILURE',
  'INTERNAL_ERROR',
  'TIMEOUT',
  'CANCELLED',
  'EXPIRED',
])

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || '').toUpperCase())
}

function statusLabel(status) {
  const normalized = String(status || 'UNKNOWN').toUpperCase()
  if (normalized === 'SUCCESS') return '✅ SUCCESS'
  if (FAILURE_STATUSES.has(normalized)) return `❌ ${normalized}`
  return `⚠️ ${normalized}`
}

function firstPresent(...values) {
  return values.find((value) => typeof value === 'string' && value.trim() !== '') || ''
}

function shortShaFor(build) {
  const substitutions = build.substitutions || {}
  const sha = firstPresent(
    substitutions.SHORT_SHA,
    substitutions.COMMIT_SHA,
    substitutions.REVISION_ID,
    build.sourceProvenance?.resolvedRepoSource?.commitSha,
  )
  return sha ? sha.slice(0, 7) : 'unknown'
}

function commitShaFor(build) {
  const substitutions = build.substitutions || {}
  return firstPresent(
    substitutions.COMMIT_SHA,
    substitutions.REVISION_ID,
    build.sourceProvenance?.resolvedRepoSource?.commitSha,
    substitutions.SHORT_SHA,
  )
}

function repoNameFor(build, env = process.env) {
  const substitutions = build.substitutions || {}
  return firstPresent(
    env.BACKEND_REPO_NAME,
    substitutions.REPO_NAME,
    substitutions.REPO_FULL_NAME?.split('/').pop(),
    build.source?.repoSource?.repoName,
    'medusa-bonsai-backend',
  )
}

function repoOwnerFor(build, env = process.env) {
  const substitutions = build.substitutions || {}
  return firstPresent(
    env.BACKEND_REPO_OWNER,
    substitutions.REPO_FULL_NAME?.split('/')[0],
    'danybgoode',
  )
}

function buildLogUrlFor(build, env = process.env) {
  if (build.logUrl) return build.logUrl
  const projectId = firstPresent(build.projectId, env.GOOGLE_CLOUD_PROJECT, env.PROJECT_ID)
  const region = firstPresent(env.BUILD_REGION, env.FUNCTION_REGION, 'us-east4')
  if (projectId && build.id) {
    return `https://console.cloud.google.com/cloud-build/builds;region=${encodeURIComponent(region)}/${encodeURIComponent(build.id)}?project=${encodeURIComponent(projectId)}`
  }
  return 'https://console.cloud.google.com/cloud-build/builds'
}

function triggerNameFor(build) {
  const substitutions = build.substitutions || {}
  return firstPresent(
    substitutions.TRIGGER_NAME,
    substitutions.BUILD_TRIGGER_NAME,
    build.tags?.find((tag) => tag.startsWith('trigger-'))?.replace(/^trigger-/, ''),
  )
}

function branchNameFor(build) {
  const substitutions = build.substitutions || {}
  return firstPresent(
    substitutions.BRANCH_NAME,
    build.source?.repoSource?.branchName?.replace(/^refs\/heads\//, ''),
  )
}

function shouldNotifyBuild(build, env = process.env) {
  if (!build || typeof build !== 'object') return false
  if (!isTerminalStatus(build.status)) return false

  const expectedTriggerId = firstPresent(env.BACKEND_TRIGGER_ID)
  if (expectedTriggerId && build.buildTriggerId !== expectedTriggerId) {
    return false
  }

  const expectedRepo = firstPresent(env.BACKEND_REPO_NAME, 'medusa-bonsai-backend')
  const substitutions = build.substitutions || {}
  const repoCandidates = [
    substitutions.REPO_NAME,
    substitutions.REPO_FULL_NAME?.split('/').pop(),
    build.source?.repoSource?.repoName,
  ].filter(Boolean)
  if (repoCandidates.length > 0 && !repoCandidates.includes(expectedRepo)) {
    return false
  }

  const expectedTriggerName = firstPresent(env.BACKEND_TRIGGER_NAME)
  const actualTriggerName = triggerNameFor(build)
  if (expectedTriggerName && actualTriggerName && actualTriggerName !== expectedTriggerName) {
    return false
  }

  const expectedBranch = firstPresent(env.BACKEND_BRANCH_NAME, 'main')
  const actualBranch = branchNameFor(build)
  if (expectedBranch && actualBranch && actualBranch !== expectedBranch) {
    return false
  }

  return true
}

function extractBuildFromPubSubEvent(event) {
  const data = event?.data?.message?.data || event?.message?.data || event?.data
  if (!data) return null

  try {
    const json = Buffer.from(data, 'base64').toString('utf8')
    return JSON.parse(json)
  } catch (error) {
    console.warn('Could not parse Cloud Build Pub/Sub payload.', error)
    return null
  }
}

function formatTelegramMessage({ build, commitHeader, env = process.env }) {
  const repo = repoNameFor(build, env)
  const sha = shortShaFor(build)
  const header = commitHeader || `Commit ${sha}`
  const logUrl = buildLogUrlFor(build, env)

  return [
    `<b>${esc(repo)}</b> · 🚀 · <code>${esc(sha)}</code>`,
    esc(header),
    `<b>Status:</b> ${esc(statusLabel(build.status))}`,
    `<a href="${esc(logUrl)}">View build logs</a>`,
  ].join('\n')
}

async function fetchCommitHeader({ owner, repo, sha, fetchImpl = fetch, timeoutMs = 5000 }) {
  if (!owner || !repo || !sha || sha === 'unknown') return ''

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetchImpl(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'miyagi-cicd-telegram-notifier',
      },
      signal: controller.signal,
    })
    if (!response.ok) return ''
    const payload = await response.json()
    return String(payload?.commit?.message || '').split('\n')[0]
  } catch (error) {
    console.warn('Could not resolve GitHub commit header; using fallback.', error)
    return ''
  } finally {
    clearTimeout(timeout)
  }
}

async function sendTelegramMessage({ text, env = process.env, fetchImpl = fetch }) {
  const token = env.TELEGRAM_BOT_TOKEN
  const chatId = env.TELEGRAM_CICD_CHAT_ID
  if (!token || !chatId) {
    console.warn('Telegram CI/CD secrets are not configured; skipping notification.')
    return
  }

  const body = new URLSearchParams({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: 'true',
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)

  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      body,
      signal: controller.signal,
    })
    if (response && response.ok === false) {
      console.warn(`Telegram notification returned HTTP ${response.status}; deploy result is unaffected.`)
    }
  } catch (error) {
    console.warn('Telegram notification failed; deploy result is unaffected.', error)
  } finally {
    clearTimeout(timeout)
  }
}

async function handleBuildEvent(event, { env = process.env, fetchImpl = fetch } = {}) {
  const build = extractBuildFromPubSubEvent(event)
  if (!shouldNotifyBuild(build, env)) return { notified: false }

  const repo = repoNameFor(build, env)
  const owner = repoOwnerFor(build, env)
  const sha = commitShaFor(build)
  const commitHeader = await fetchCommitHeader({ owner, repo, sha, fetchImpl })
  const text = formatTelegramMessage({ build, commitHeader, env })

  await sendTelegramMessage({ text, env, fetchImpl })
  return { notified: true, text }
}

functions.cloudEvent('notifyCloudBuild', async (cloudEvent) => {
  try {
    await handleBuildEvent(cloudEvent)
  } catch (error) {
    console.error('Unexpected notifier error; swallowing so Pub/Sub does not retry forever.', error)
  }
})

module.exports = {
  branchNameFor,
  buildLogUrlFor,
  commitShaFor,
  esc,
  extractBuildFromPubSubEvent,
  fetchCommitHeader,
  formatTelegramMessage,
  handleBuildEvent,
  isTerminalStatus,
  repoNameFor,
  repoOwnerFor,
  sendTelegramMessage,
  shouldNotifyBuild,
  shortShaFor,
  statusLabel,
  triggerNameFor,
}
