# CI/CD Telegram Cloud Build Notifier

Small Google Cloud Function subscribed to the project-level `cloud-builds` Pub/Sub topic.
It forwards terminal backend Cloud Build statuses to the dedicated CI/CD Telegram channel.

It is intentionally outside the Medusa app runtime. A Telegram outage is logged and swallowed,
so it cannot affect the backend Cloud Build or Cloud Run deploy.

## Message

`medusa-bonsai-backend · 🚀 · <short SHA> · <commit header> · ✅ SUCCESS/❌ FAILURE · build-log link`

The Telegram payload uses `parse_mode=HTML` and escapes `&`, `<`, and `>`.

## Secrets

Required Secret Manager entries in the production project `miyagisanchez-prod`
(gcloud configuration `lolis-profile`):

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CICD_CHAT_ID`

Create/update them from a secure shell session. Do not paste values into source-controlled files.

```bash
printf '%s' "$TELEGRAM_BOT_TOKEN" | gcloud secrets create TELEGRAM_BOT_TOKEN \
  --project=miyagisanchez-prod \
  --replication-policy=automatic \
  --data-file=-

printf '%s' "$TELEGRAM_CICD_CHAT_ID" | gcloud secrets create TELEGRAM_CICD_CHAT_ID \
  --project=miyagisanchez-prod \
  --replication-policy=automatic \
  --data-file=-
```

For rotation, use `gcloud secrets versions add ... --data-file=-` with the same `printf` pattern.

## Deploy

From `apps/backend`:

```bash
gcloud config configurations activate lolis-profile
PROJECT_ID=miyagisanchez-prod bash infra/gcp/deploy-cicd-telegram-notifier.sh
```

Defaults:

- Project: `miyagisanchez-prod`
- Function region: `us-east4`
- Runtime: Node.js 22
- Cloud Build trigger region: `us-east4`
- Trigger name: `backend-main-deploy`
- Repo: `danybgoode/medusa-bonsai-backend`
- Branch: `main`

The deploy script:

1. Enables its required APIs in the explicitly selected project (it does not alter the active
   gcloud project).
2. Verifies the two Secret Manager secrets exist.
3. Creates service account `cicd-telegram-notifier` if needed and waits up to 60 seconds for IAM
   visibility (fresh principals are eventually consistent).
4. Grants that service account `roles/secretmanager.secretAccessor` on only the Telegram secrets.
5. Discovers the regional `backend-main-deploy` trigger ID.
6. Deploys the Node.js 22 Gen2 function with a `cloud-builds` Pub/Sub trigger.

## Local Tests

```bash
cd infra/gcp/cicd-telegram-notifier
npm test
```

Tests cover terminal status filtering, wrong-trigger filtering, formatting, HTML escaping,
CloudEvent Pub/Sub payload parsing, and Telegram failure swallowing.

## Rollback

```bash
gcloud functions delete cicd-telegram-build-notifier \
  --gen2 \
  --project=miyagisanchez-prod \
  --region=us-east4
```

Deleting the function removes the subscriber path. It does not affect `cloudbuild.yaml`, the backend
Cloud Build trigger, or the Cloud Run service.

## Migration boundary

`miyagisanchezback-497722` retains its old notifier only as a rollback path while the new
production project is observed. Do not deploy or update notifier resources there during normal
operations. All current production provisioning uses `miyagisanchez-prod` under `lolis-profile`.
