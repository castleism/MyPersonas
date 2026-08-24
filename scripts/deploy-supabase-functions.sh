#!/usr/bin/env bash
set -euo pipefail

required() {
  local name="$1"
  test -n "${!name:-}" || {
    echo "Deployment blocked: required protected value ${name} is unavailable."
    exit 1
  }
}

for name in DEPLOYMENT_TARGET RELEASE_SCOPE RELEASE_CONFIRMATION \
  PROJECT_REF_CONFIRMATION APPROVED_PROJECT_REF SUPABASE_ACCESS_TOKEN; do
  required "$name"
done

echo "${PROJECT_REF_CONFIRMATION}" | grep -Eq '^[a-z0-9]{20}$' || {
  echo "Deployment blocked: dispatch must confirm one exact 20-character project ref."
  exit 1
}
echo "${APPROVED_PROJECT_REF}" | grep -Eq '^[a-z0-9]{20}$' || {
  echo "Deployment blocked: the selected protected environment must pin one exact project ref."
  exit 1
}
test "${PROJECT_REF_CONFIRMATION}" = "${APPROVED_PROJECT_REF}" || {
  echo "Deployment blocked: dispatch and protected-environment project refs disagree."
  exit 1
}

production_ref=$(grep -E '^project_id' supabase/config.toml | head -1 | sed -E 's/.*"([^"]+)".*/\1/')
echo "${production_ref}" | grep -Eq '^[a-z0-9]{20}$' || {
  echo "Deployment blocked: reviewed production project ref is malformed."
  exit 1
}
case "${DEPLOYMENT_TARGET}" in
  staging)
    test "${APPROVED_PROJECT_REF}" != "${production_ref}" || {
      echo "Deployment blocked: staging may not target the configured production project."
      exit 1
    }
    ;;
  production)
    test "${APPROVED_PROJECT_REF}" = "${production_ref}" || {
      echo "Deployment blocked: protected production ref and reviewed config.toml disagree."
      exit 1
    }
    ;;
  *)
    echo "Deployment blocked: unknown deployment target."
    exit 1
    ;;
esac

expected_confirmation=""
functions=()
case "${DEPLOYMENT_TARGET}:${RELEASE_SCOPE}" in
  staging:opaque-media-foundation)
    expected_confirmation="STAGING-062-064+068-SHADOW+069+GATEWAY-VERIFIED"
    functions=(public-media approved-media owner-media-preview legacy-media-remediation compose-post approve-post-draft meta-post run-post-queue delete-account erase-content)
    ;;
  production:opaque-media-foundation)
    expected_confirmation="MIGRATIONS-062-064-GATEWAY-VERIFIED+BILLING-068-SHADOW-VERIFIED"
    functions=(public-media approved-media owner-media-preview legacy-media-remediation compose-post approve-post-draft meta-post run-post-queue delete-account erase-content)
    ;;
  staging:opaque-media-intake-pilot)
    expected_confirmation="STAGING-OPAQUE-FOUNDATION+FRONTEND-SHELL+INTAKE-PILOT-APPROVED"
    functions=(media-ingest)
    ;;
  staging:opaque-media-producers)
    expected_confirmation="STAGING-FRONTEND+OPAQUE-GATEWAY+SIGNED-IN-QA-VERIFIED"
    functions=(gemini-image)
    ;;
  production:opaque-media-producers)
    expected_confirmation="OPAQUE-FRONTEND-VERIFIED+BILLING-068-SHADOW-VERIFIED"
    functions=(gemini-image media-ingest)
    ;;
  staging:billing-test-boundary)
    expected_confirmation="BILLING-068-TESTMODE-VERIFIED"
    functions=(billing-create-checkout billing-create-portal billing-admin-refund-duplicate stripe-webhook billing-reconcile ai-proxy research-brief-run agent-board-run fan-chat run-tasks run-mailbox-jobs run-publish-queue delete-account)
    ;;
  staging:billing-entitlement-consumers)
    expected_confirmation="STAGING-BILLING-068-SHADOW-VERIFIED"
    functions=(ai-proxy research-brief-run agent-board-run fan-chat run-tasks run-mailbox-jobs run-post-queue run-publish-queue delete-account)
    ;;
  production:billing-entitlement-consumers)
    expected_confirmation="BILLING-068-SHADOW-VERIFIED"
    functions=(ai-proxy research-brief-run agent-board-run fan-chat run-tasks run-mailbox-jobs run-post-queue run-publish-queue delete-account)
    ;;
  staging:public-intake)
    expected_confirmation="STAGING-PUBLIC-INTAKE+TURNSTILE+SMTP-VERIFIED"
    functions=(request-review)
    ;;
  production:public-intake)
    expected_confirmation="PUBLIC-INTAKE+TURNSTILE+SMTP+WAF-VERIFIED"
    functions=(request-review)
    ;;
  staging:operations-maintenance)
    expected_confirmation="STAGING-OPS-069+CRON-SECRET-VERIFIED"
    functions=(run-operations-maintenance)
    ;;
  production:operations-maintenance)
    expected_confirmation="OPS-069+CRON-SECRET-VERIFIED"
    functions=(run-operations-maintenance)
    ;;
  *)
    echo "Deployment blocked: unreviewed target and release-scope combination."
    exit 1
    ;;
esac

test "${RELEASE_CONFIRMATION}" = "${expected_confirmation}" || {
  echo "Deployment blocked: release evidence token does not match the reviewed target and scope."
  exit 1
}

suffix="${APPROVED_PROJECT_REF: -6}"
echo "Selected reviewed ${DEPLOYMENT_TARGET} project ending in ${suffix}."
for function_name in "${functions[@]}"; do
  supabase functions deploy "${function_name}" --project-ref "${APPROVED_PROJECT_REF}"
done
