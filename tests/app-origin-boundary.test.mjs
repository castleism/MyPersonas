import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEPLOYMENT_ENVIRONMENT_ENV,
  LEGACY_APP_ORIGINS_ENV,
  loadAppOrigins,
  PRODUCTION_APP_ORIGINS,
  PRODUCTION_SUPABASE_PROJECT_REF,
  PRODUCTION_SUPABASE_URL,
  STAGING_APP_ORIGINS,
  STAGING_PROJECT_REF_ENV,
} from "../supabase/functions/_shared/app-origin.ts";

const STAGING_REF = "abcdefghijklmnopqrst";
const STAGING_URL = `https://${STAGING_REF}.supabase.co`;
const CONFIG_ERROR = /Invalid MyPersonas app origin environment configuration/;
const values = (entries = {}) => (name) => entries[name];
const production = (extra = {}) =>
  values({
    [DEPLOYMENT_ENVIRONMENT_ENV]: "production",
    SUPABASE_URL: PRODUCTION_SUPABASE_URL,
    ...extra,
  });
const staging = (extra = {}) =>
  values({
    [DEPLOYMENT_ENVIRONMENT_ENV]: "staging",
    SUPABASE_URL: STAGING_URL,
    [STAGING_PROJECT_REF_ENV]: STAGING_REF,
    ...extra,
  });

test("production is bound to the reviewed Supabase project and rejects staging", () => {
  const origins = loadAppOrigins(production());
  assert.deepEqual([...origins], [...PRODUCTION_APP_ORIGINS]);
  for (const origin of STAGING_APP_ORIGINS) {
    assert.equal(origins.has(origin), false);
  }
});

test("staging is bound to its declared project and accepts only two reviewed origins", () => {
  const origins = loadAppOrigins(staging());
  assert.deepEqual([...origins], [...STAGING_APP_ORIGINS]);
  for (const origin of PRODUCTION_APP_ORIGINS) {
    assert.equal(origins.has(origin), false);
  }
  assert.equal(origins.has("https://other-project.pages.dev"), false);
});

test("missing, malformed, and legacy free-form configuration fails closed", () => {
  const rejected = [
    {},
    { SUPABASE_URL: PRODUCTION_SUPABASE_URL },
    { [DEPLOYMENT_ENVIRONMENT_ENV]: "production" },
    {
      [DEPLOYMENT_ENVIRONMENT_ENV]: "Production",
      SUPABASE_URL: PRODUCTION_SUPABASE_URL,
    },
    { [DEPLOYMENT_ENVIRONMENT_ENV]: "preview", SUPABASE_URL: STAGING_URL },
    {
      [DEPLOYMENT_ENVIRONMENT_ENV]: " production",
      SUPABASE_URL: PRODUCTION_SUPABASE_URL,
    },
    {
      [DEPLOYMENT_ENVIRONMENT_ENV]: "production",
      SUPABASE_URL: `${PRODUCTION_SUPABASE_URL}/`,
    },
    {
      [DEPLOYMENT_ENVIRONMENT_ENV]: "production",
      SUPABASE_URL: PRODUCTION_SUPABASE_URL,
      [LEGACY_APP_ORIGINS_ENV]: "https://mypersonas.online",
    },
    { [DEPLOYMENT_ENVIRONMENT_ENV]: "staging", SUPABASE_URL: STAGING_URL },
    {
      [DEPLOYMENT_ENVIRONMENT_ENV]: "staging",
      SUPABASE_URL: STAGING_URL,
      [STAGING_PROJECT_REF_ENV]: "short",
    },
    {
      [DEPLOYMENT_ENVIRONMENT_ENV]: "staging",
      SUPABASE_URL: "http://abcdefghijklmnopqrst.supabase.co",
      [STAGING_PROJECT_REF_ENV]: STAGING_REF,
    },
    {
      [DEPLOYMENT_ENVIRONMENT_ENV]: "staging",
      SUPABASE_URL: "https://user:pass@abcdefghijklmnopqrst.supabase.co",
      [STAGING_PROJECT_REF_ENV]: STAGING_REF,
    },
    {
      [DEPLOYMENT_ENVIRONMENT_ENV]: "staging",
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co/path",
      [STAGING_PROJECT_REF_ENV]: STAGING_REF,
    },
    {
      [DEPLOYMENT_ENVIRONMENT_ENV]: "staging",
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co?x=1",
      [STAGING_PROJECT_REF_ENV]: STAGING_REF,
    },
    {
      [DEPLOYMENT_ENVIRONMENT_ENV]: "staging",
      SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co#x",
      [STAGING_PROJECT_REF_ENV]: STAGING_REF,
    },
    {
      [DEPLOYMENT_ENVIRONMENT_ENV]: "staging",
      SUPABASE_URL: "https://ABCDEFGHIJKLMNOPQRST.supabase.co",
      [STAGING_PROJECT_REF_ENV]: STAGING_REF,
    },
  ];
  for (const environment of rejected) {
    assert.throws(
      () => loadAppOrigins(values(environment)),
      CONFIG_ERROR,
      JSON.stringify(environment),
    );
  }
});

test("production/staging crossover and project-ref mismatch fail closed", () => {
  const alternateRef = "bcdefghijklmnopqrstu";
  const rejected = [
    production({ SUPABASE_URL: STAGING_URL }),
    production({ [STAGING_PROJECT_REF_ENV]: STAGING_REF }),
    staging({ SUPABASE_URL: PRODUCTION_SUPABASE_URL }),
    staging({
      [STAGING_PROJECT_REF_ENV]: PRODUCTION_SUPABASE_PROJECT_REF,
      SUPABASE_URL: PRODUCTION_SUPABASE_URL,
    }),
    staging({ [STAGING_PROJECT_REF_ENV]: alternateRef }),
    staging({ SUPABASE_URL: `https://${alternateRef}.supabase.co` }),
  ];
  for (const environment of rejected) {
    assert.throws(() => loadAppOrigins(environment), CONFIG_ERROR);
  }
});

test("every browser-facing function in protected release scopes uses the shared boundary", () => {
  const appOriginFunctions = [
    "owner-media-preview",
    "legacy-media-remediation",
    "compose-post",
    "approve-post-draft",
    "meta-post",
    "delete-account",
    "media-ingest",
    "gemini-image",
    "ai-proxy",
    "research-brief-run",
    "agent-board-run",
    "fan-chat",
  ];
  for (const name of appOriginFunctions) {
    const source = readFileSync(
      new URL(`../supabase/functions/${name}/index.ts`, import.meta.url),
      "utf8",
    );
    assert.match(source, /_shared\/app-origin\.ts/, name);
    assert.match(source, /loadAppOrigins\(/, name);
    assert.doesNotMatch(
      source,
      /const (?:ALLOWED_ORIGINS|ORIGINS|ALLOWED) = new Set\(\[\s*"https:\/\//,
      name,
    );
  }

  const fanChat = readFileSync(
    new URL("../supabase/functions/fan-chat/index.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(fanChat, /FAN_CHAT_ALLOWED_ORIGINS/);

  const eraseContent = readFileSync(
    new URL("../supabase/functions/erase-content/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    eraseContent,
    /createErasureHandler.*delete-account\/index\.ts/s,
  );

  for (
    const name of [
      "billing-create-checkout",
      "billing-create-portal",
      "billing-admin-refund-duplicate",
    ]
  ) {
    const source = readFileSync(
      new URL(`../supabase/functions/${name}/index.ts`, import.meta.url),
      "utf8",
    );
    assert.match(source, /requireBillingOrigin\(/, name);
  }

  const requestReview = readFileSync(
    new URL("../supabase/functions/request-review/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(requestReview, /REQUEST_REVIEW_ALLOWED_ORIGIN/);
});

test("reviewed production project ref stays synchronized with Supabase config", () => {
  const config = readFileSync(
    new URL("../supabase/config.toml", import.meta.url),
    "utf8",
  );
  assert.match(
    config,
    new RegExp(`^project_id = "${PRODUCTION_SUPABASE_PROJECT_REF}"$`, "m"),
  );
});

test("deployment instructions require the explicit environment and staging ref", () => {
  const sources = [
    "../supabase/DEPLOY.md",
    "../supabase/STAGING-BOOTSTRAP-RUNBOOK.md",
    "../MyPersonas.Online_v0/RELEASE-MANIFEST-2026-08-23-MONETIZATION-SECURITY.md",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
  for (const source of sources) {
    assert.match(source, /MYPERSONAS_DEPLOYMENT_ENVIRONMENT/);
    assert.match(source, /MYPERSONAS_STAGING_PROJECT_REF/);
    assert.match(source, /mypersonas-staging\.pages\.dev/);
    assert.match(source, /staging\.mypersonas\.online/);
    assert.match(source, /SUPABASE_URL/);
    assert.match(source, /fail(?:s|ed)? closed|fail-closed/i);
  }

  const deployScript = readFileSync(
    new URL("../scripts/deploy-supabase-functions.sh", import.meta.url),
    "utf8",
  );
  assert.match(
    deployScript,
    /MYPERSONAS_DEPLOYMENT_ENVIRONMENT=\$\{DEPLOYMENT_TARGET\}/,
  );
  assert.match(
    deployScript,
    /MYPERSONAS_STAGING_PROJECT_REF=\$\{APPROVED_PROJECT_REF\}/,
  );
  assert.match(
    deployScript,
    /supabase secrets set "\$\{origin_boundary_secrets\[@\]\}"/,
  );
  assert.match(deployScript, /--project-ref "\$\{APPROVED_PROJECT_REF\}"/);
});
