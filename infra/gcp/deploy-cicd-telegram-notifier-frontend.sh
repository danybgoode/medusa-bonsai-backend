#!/usr/bin/env bash
# deploy-cicd-telegram-notifier-frontend.sh — Frontend off Vercel → Cloud Run, Sprint 3,
# Story 3.5.
#
# Deploys a SECOND, independent instance of the SAME, unmodified cicd-telegram-notifier
# Cloud Function (source unchanged — see cicd-telegram-notifier/index.js), subscribed to the
# same shared `cloud-builds` Pub/Sub topic (every Cloud Build event, project-wide, already
# lands there), but configured via env vars to watch the frontend's `frontend-main-deploy`
# trigger instead of the backend's.
#
# Why a second function instance rather than generalizing index.js's filter to a list:
# shouldNotifyBuild() already reads a single BACKEND_TRIGGER_ID/BACKEND_REPO_NAME/
# BACKEND_TRIGGER_NAME/BACKEND_BRANCH_NAME per deployed instance — deploy-cicd-telegram-
# notifier.sh is ALREADY fully parametrized via those exact env vars, so reusing it here is
# zero code changes to a working notifier's filter logic, for a LOW-risk story. Two Cloud
# Function instances reading the same topic, filtering independently, is the established
# "one function per trigger" shape this script already supports.
#
# Usage: bash infra/gcp/deploy-cicd-telegram-notifier-frontend.sh (run from this repo's root)
# (Provisions real, billable GCP resources — a new Cloud Function + service account. Confirm
# before running against prod.)

set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

FUNCTION_NAME="cicd-telegram-build-notifier-frontend" \
SERVICE_ACCOUNT_NAME="cicd-telegram-notifier-frontend" \
BACKEND_REPO_OWNER="danybgoode" \
BACKEND_REPO_NAME="miyagisanchezcommerce" \
BACKEND_BRANCH_NAME="main" \
BACKEND_TRIGGER_NAME="frontend-main-deploy" \
  bash "${SOURCE_DIR}/deploy-cicd-telegram-notifier.sh"
