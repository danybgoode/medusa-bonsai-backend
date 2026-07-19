#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-miyagisanchez-prod}"
REGION="${REGION:-us-east4}"
BUILD_TRIGGER_REGION="${BUILD_TRIGGER_REGION:-us-east4}"
FUNCTION_NAME="${FUNCTION_NAME:-cicd-telegram-build-notifier}"
SERVICE_ACCOUNT_NAME="${SERVICE_ACCOUNT_NAME:-cicd-telegram-notifier}"
BACKEND_REPO_OWNER="${BACKEND_REPO_OWNER:-danybgoode}"
BACKEND_REPO_NAME="${BACKEND_REPO_NAME:-medusa-bonsai-backend}"
BACKEND_BRANCH_NAME="${BACKEND_BRANCH_NAME:-main}"
BACKEND_TRIGGER_NAME="${BACKEND_TRIGGER_NAME:-backend-main-deploy}"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/cicd-telegram-notifier" && pwd)"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

echo "Preparing CI/CD Telegram notifier in project ${PROJECT_ID} (${REGION})"
echo "Function: ${FUNCTION_NAME}"
echo "Backend trigger: ${BACKEND_TRIGGER_NAME} (${BUILD_TRIGGER_REGION})"

echo "Enabling required APIs..."
gcloud services enable \
  cloudbuild.googleapis.com \
  cloudfunctions.googleapis.com \
  eventarc.googleapis.com \
  pubsub.googleapis.com \
  run.googleapis.com \
  secretmanager.googleapis.com \
  --project="${PROJECT_ID}" \
  >/dev/null

if ! gcloud pubsub topics describe cloud-builds --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Creating Pub/Sub topic cloud-builds..."
  gcloud pubsub topics create cloud-builds \
    --project="${PROJECT_ID}" \
    >/dev/null
fi

for secret in TELEGRAM_BOT_TOKEN TELEGRAM_CICD_CHAT_ID; do
  if ! gcloud secrets describe "${secret}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
    echo "Missing Secret Manager secret: ${secret}" >&2
    echo "Create it before deploying; do not put secret values in source control." >&2
    exit 1
  fi
done

if ! gcloud iam service-accounts describe "${SERVICE_ACCOUNT_EMAIL}" --project="${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Creating service account ${SERVICE_ACCOUNT_EMAIL}..."
  gcloud iam service-accounts create "${SERVICE_ACCOUNT_NAME}" \
    --project="${PROJECT_ID}" \
    --display-name="CI/CD Telegram notifier" \
    >/dev/null
fi

echo "Granting notifier access to Telegram secrets..."
for secret in TELEGRAM_BOT_TOKEN TELEGRAM_CICD_CHAT_ID; do
  gcloud secrets add-iam-policy-binding "${secret}" \
    --project="${PROJECT_ID}" \
    --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --condition=None \
    --quiet \
    >/dev/null
done

BACKEND_TRIGGER_ID="${BACKEND_TRIGGER_ID:-$(gcloud builds triggers list \
  --project="${PROJECT_ID}" \
  --region="${BUILD_TRIGGER_REGION}" \
  --filter="name=${BACKEND_TRIGGER_NAME}" \
  --format="value(id)" \
  --limit=1)}"

if [ -z "${BACKEND_TRIGGER_ID}" ]; then
  echo "Could not find Cloud Build trigger ${BACKEND_TRIGGER_NAME} in ${BUILD_TRIGGER_REGION}." >&2
  exit 1
fi

echo "Deploying ${FUNCTION_NAME} for Cloud Build trigger ${BACKEND_TRIGGER_ID}..."
gcloud functions deploy "${FUNCTION_NAME}" \
  --gen2 \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --runtime=nodejs20 \
  --source="${SOURCE_DIR}" \
  --entry-point=notifyCloudBuild \
  --trigger-topic=cloud-builds \
  --service-account="${SERVICE_ACCOUNT_EMAIL}" \
  --memory=256Mi \
  --timeout=30s \
  --max-instances=1 \
  --set-env-vars="BACKEND_REPO_OWNER=${BACKEND_REPO_OWNER},BACKEND_REPO_NAME=${BACKEND_REPO_NAME},BACKEND_BRANCH_NAME=${BACKEND_BRANCH_NAME},BACKEND_TRIGGER_NAME=${BACKEND_TRIGGER_NAME},BACKEND_TRIGGER_ID=${BACKEND_TRIGGER_ID},BUILD_REGION=${BUILD_TRIGGER_REGION}" \
  --set-secrets="TELEGRAM_BOT_TOKEN=TELEGRAM_BOT_TOKEN:latest,TELEGRAM_CICD_CHAT_ID=TELEGRAM_CICD_CHAT_ID:latest" \
  --quiet

echo "Granting Eventarc invoke access to ${FUNCTION_NAME}..."
gcloud run services add-iam-policy-binding "${FUNCTION_NAME}" \
  --project="${PROJECT_ID}" \
  --region="${REGION}" \
  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
  --role="roles/run.invoker" \
  --quiet \
  >/dev/null

echo "Done. Live smoke is a backend main build: ${BACKEND_REPO_OWNER}/${BACKEND_REPO_NAME} -> ${BACKEND_TRIGGER_NAME}."
