import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root=path.resolve(import.meta.dirname,"..");
const pairs=[
  ["MyPersonas.Online_v0/sql-updates/047-persona-full-name-canon.sql","supabase/migrations/20260822113925_persona_full_name_canon.sql"],
  ["MyPersonas.Online_v0/sql-updates/048-persona-backup-relationships.sql","supabase/migrations/20260822130000_persona_backup_relationships.sql"],
  ["MyPersonas.Online_v0/sql-updates/049-persona-relationships-projects-businesses.sql","supabase/migrations/20260822140000_persona_relationships_projects_businesses.sql"],
  ["MyPersonas.Online_v0/sql-updates/050-persona-page-layout-builder.sql","supabase/migrations/20260822150000_persona_page_layout_builder.sql"],
  ["MyPersonas.Online_v0/sql-updates/043-request-review-phase1.sql","supabase/migrations/20260822160000_request_review_phase1.sql"],
  ["MyPersonas.Online_v0/sql-updates/051-publication-social-security-governance.sql","supabase/migrations/20260822170000_publication_social_security_governance.sql"],
  ["MyPersonas.Online_v0/sql-updates/052-reviewed-business-publication.sql","supabase/migrations/20260822180000_reviewed_business_publication.sql"],
  ["MyPersonas.Online_v0/sql-updates/053-agent-board-hardening.sql","supabase/migrations/20260822190000_agent_board_hardening.sql"],
  ["MyPersonas.Online_v0/sql-updates/054-owner-research-content-hardening.sql","supabase/migrations/20260822200000_owner_research_content_hardening.sql"],
  ["MyPersonas.Online_v0/sql-updates/055-agent-action-retention-hardening.sql","supabase/migrations/20260822210000_agent_action_retention_hardening.sql"],
  ["MyPersonas.Online_v0/sql-updates/056-auth-email-attestation-hardening.sql","supabase/migrations/20260822220000_auth_email_attestation_hardening.sql"],
  ["MyPersonas.Online_v0/sql-updates/057-ai-backend-budget-guard.sql","supabase/migrations/20260822230000_ai_backend_budget_guard.sql"],
  ["MyPersonas.Online_v0/sql-updates/058-persona-view-mode.sql","supabase/migrations/20260823000000_persona_view_mode.sql"],
  ["MyPersonas.Online_v0/sql-updates/062-opaque-public-media-delivery.sql","supabase/migrations/20260823040000_opaque_public_media_delivery.sql"],
  ["MyPersonas.Online_v0/sql-updates/063-opaque-approved-media-delivery.sql","supabase/migrations/20260823050000_opaque_approved_media_delivery.sql"],
  ["MyPersonas.Online_v0/sql-updates/064-legacy-media-remediation.sql","supabase/migrations/20260823060000_legacy_media_remediation.sql"],
  ["MyPersonas.Online_v0/sql-updates/066-custom-persona-field-boxes.sql","supabase/migrations/20260823080000_custom_persona_field_boxes.sql"],
  ["MyPersonas.Online_v0/sql-updates/067-project-resource-editor-hardening.sql","supabase/migrations/20260823090000_project_resource_editor_hardening.sql"],
  ["MyPersonas.Online_v0/sql-updates/068-account-subscription-entitlements.sql","supabase/migrations/20260823100000_account_subscription_entitlements.sql"],
  ["MyPersonas.Online_v0/sql-updates/069-operational-alert-inbox.sql","supabase/migrations/20260823110000_operational_alert_inbox.sql"],
  ["MyPersonas.Online_v0/sql-updates/070-persona-source-library.sql","supabase/migrations/20260823120000_persona_source_library.sql"],
];

test("reviewed canonical migrations and timestamped release mirrors are byte-identical",async()=>{
  for(const[canonical,mirror]of pairs){
    const[a,b]=await Promise.all([readFile(path.join(root,canonical)),readFile(path.join(root,mirror))]);
    assert.deepEqual(b,a,`${mirror} drifted from ${canonical}`);
  }
});

test("timestamped release mirror order is strict and unique",()=>{
  const names=pairs.map(([,mirror])=>path.basename(mirror));
  const stamps=names.map(name=>name.slice(0,14));
  assert.equal(new Set(stamps).size,stamps.length);
  assert.deepEqual(stamps,[...stamps].sort());
});
