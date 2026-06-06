# CI/CD Telegram Cloud Build Notifier

Small Google Cloud Function subscribed to the project-level `cloud-builds` Pub/Sub topic.
It forwards terminal backend Cloud Build statuses to the dedicated CI/CD Telegram channel.

It is intentionally outside the Medusa app runtime. A Telegram outage is logged and swallowed,
so it cannot affect the backend Cloud Build or Cloud Run deploy.

## Message

`medusa-bonsai-backend · 🚀 · <short SHA> · <commit header> · ✅ SUCCESS/❌ FAILURE · build-log link`

The Telegram payload uses `parse_mode=HTML` and escapes `&`, `<`, and `>`.

## Secrets

Required Secret Manager entries in project `miyagisanchezback-497722`:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CICD_CHAT_ID`

Create/update them from a secure shell session. Do not paste values into source-controlled files.

```bash
printf '%s' "$TELEGRAM_BOT_TOKEN" | gcloud secrets create TELEGRAM_BOT_TOKEN \
  --project=miyagisanchezback-497722 \
  --replication-policy=automatic \
  --data-file=-

printf '%s' "$TELEGRAM_CICD_CHAT_ID" | gcloud secrets create TELEGRAM_CICD_CHAT_ID \
  --project=miyagisanchezback-497722 \
  --replication-policy=automatic \
  --data-file=-
```

For rotation, use `gcloud secrets versions add ... --data-file=-` with the same `printf` pattern.

## Deploy

From `apps/backend`:

```bash
bash infra/gcp/deploy-cicd-telegram-notifier.sh
```

Defaults:

- Project: `miyagisanchezback-497722`
- Function region: `us-east4`
- Cloud Build trigger region: `us-east4`
- Trigger name: `backend-main-deploy`
- Repo: `danybgoode/medusa-bonsai-backend`
- Branch: `main`

The deploy script:

1. Verifies the two Secret Manager secrets exist.
2. Creates service account `cicd-telegram-notifier` if needed.
3. Grants that service account `roles/secretmanager.secretAccessor` on only the Telegram secrets.
4. Discovers the regional `backend-main-deploy` trigger ID.
5. Deploys the Gen2 function with a `cloud-builds` Pub/Sub trigger.

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
  --project=miyagisanchezback-497722 \
  --region=us-east4
```

Deleting the function removes the subscriber path. It does not affect `cloudbuild.yaml`, the backend
Cloud Build trigger, or the Cloud Run service.
