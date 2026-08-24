import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8")
  .then((text) => text.replace(/\r\n?/g, "\n"));
const [sql, propose, run, aiProxy, config, runtimeSql] = await Promise.all([
  read("MyPersonas.Online_v0/sql-updates/053-agent-board-hardening.sql"),
  read("supabase/functions/agent-board-propose/index.ts"),
  read("supabase/functions/agent-board-run/index.ts"),
  read("supabase/functions/ai-proxy/index.ts"),
  read("supabase/config.toml"),
  read("tests/sql/053-agent-board-secure-runtime.sql"),
]);
const functionBody = (name) => sql.match(
  new RegExp(`(?:create|create or replace) function public\\.${name}\\b[\\s\\S]*?\\n\\$\\$;`, "i"),
)?.[0] || "";

test("board defaults stay dormant and approval is an immutable database invariant", () => {
  assert.match(sql, /does not enable proposals,[\s\S]*enable execution[\s\S]*schedule a runner/i);
  assert.match(sql, /approval_required=true/);
  assert.match(sql, /agent_board_settings_approval_required_check[\s\S]*approval_required=true/);
  assert.match(sql, /create trigger guard_agent_board_settings/);
  assert.match(functionBody("save_agent_board_settings"), /perform public\.require_aal2\(\)/);
  assert.match(functionBody("save_agent_board_settings"), /approval_required=true/);
  assert.match(sql, /agent_board_settings_enabled_allowlist_check[\s\S]*cardinality\(allowed_task_types\)>0/);
  assert.match(functionBody("propose_agent_board_request"), /cardinality\(v_settings\.allowed_task_types\)=0/);
});

test("direct board writes are revoked and owner RPCs are bounded", () => {
  assert.match(sql, /revoke insert,update,delete on public\.agent_board_settings,[\s\S]*from authenticated,service_role/);
  const proposal = functionBody("propose_agent_board_request");
  assert.match(proposal, /char_length\(coalesce\(p_instructions,''\)\)>12000/);
  assert.match(proposal, /octet_length\(coalesce\(p_context,'\{\}'::jsonb\)::text\)>20000/);
  assert.match(proposal, /account_ledger_text_has_secret/);
  assert.match(proposal, /Agent board request storage limit reached \(5000\)/);
  assert.match(proposal, /Agent board active queue limit reached \(1000\)/);
  assert.match(proposal, /consume_owner_daily_rate/);
  assert.match(sql, /owner_agent_board_queue_page[\s\S]*limit least\(greatest\(coalesce\(p_limit,25\),1\),25\)/);
  assert.match(sql, /revoke all on function public\.owner_agent_board_queue\(text\)/);
});

test("approval is by an authoritative frozen payload hash and sensitive owner actions require AAL2", () => {
  for (const name of [
    "approve_agent_board_request", "reject_agent_board_request",
    "cancel_agent_board_request", "delete_terminal_agent_board_request",
  ]) {
    assert.match(functionBody(name), /perform public\.require_aal2\(\)/, name);
  }
  const review = functionBody("agent_board_review_payload");
  const approval = functionBody("approve_agent_board_request");
  assert.match(review, /'prompt_schema','agent-board-v1'/);
  assert.match(review, /'system_prompt',v_system_prompt,'user_prompt',v_prompt/);
  assert.match(review, /'credential_revision',v_credential_revision/);
  assert.match(review, /v_backend_extra:=jsonb_strip_nulls\(jsonb_build_object/);
  assert.doesNotMatch(review, /'extra',v_backend\.extra/);
  assert.match(approval, /v_hash<>p_review_hash/);
  assert.match(approval, /approved_review_payload=v_payload,approved_review_hash=v_hash/);
  assert.match(approval, /status='approved',approved_by=v_owner/);
  assert.match(functionBody("cancel_agent_board_request"), /Only pre-execution requests can be cancelled/);
});

test("runner RPCs enforce exact idempotent claims, one-use capabilities, and safe recovery", () => {
  const claim = functionBody("claim_agent_board_request_service");
  const consume = functionBody("consume_agent_board_run_capability_service");
  const mark = functionBody("mark_agent_board_provider_started_service");
  const release = functionBody("release_agent_board_run_pre_provider");
  const reconcile = functionBody("reconcile_agent_board_runs_for_owner");
  const complete = functionBody("complete_agent_board_run");
  assert.match(claim, /auth\.role\(\)[\s\S]*service_role/);
  assert.match(claim, /request\.id=p_request_id and request\.owner=p_owner/);
  assert.match(claim, /request\.approved_by=p_owner[\s\S]*request\.approved_at is not null/);
  assert.match(claim, /request\.approved_review_hash=p_approval_hash/);
  assert.match(claim, /idempotency_key=p_idempotency_key for update/);
  assert.match(claim, /credential changed; owner re-review is required/);
  assert.match(claim, /setting\.execution_enabled and setting\.approval_required/);
  assert.match(claim, /capability_expires_at[\s\S]*now\(\)\+interval '2 minutes'/);
  assert.match(claim, /v_exact_attempt_limit constant integer:=10/);
  assert.match(claim, /v_owner_retained_attempt_limit constant integer:=10000/);
  assert.match(claim, /v_claim_window_limit constant integer:=60/);
  assert.match(claim, /v_claim_window constant interval:=interval '10 minutes'/);
  assert.match(claim, /Agent Board exact approval attempt limit reached \(10\)/);
  assert.match(claim, /Agent Board secure retained attempt limit reached \(10000\)/);
  assert.match(claim, /Agent Board short-window claim limit reached \(60 per 10 minutes\)/);
  assert.match(consume, /capability_consumed_at is not null/);
  assert.match(consume, /extensions\.digest\(convert_to\(p_capability,'UTF8'\),'sha256'\)/);
  assert.match(mark, /agent_owner_settings[\s\S]*not setting\.automation_paused/);
  assert.match(mark, /agent_bindings[\s\S]*binding\.status='active'/);
  assert.match(mark, /agent_board_settings[\s\S]*setting\.execution_enabled/);
  assert.match(mark, /agent_board_backend_credential_revision/);
  assert.match(release, /run\.provider_started_at is null for update/);
  assert.match(release, /agent_board_requests set status='approved'/);
  assert.match(reconcile, /provider_started_at is null[\s\S]*status='approved'/);
  assert.match(reconcile, /status='failed'/);
  assert.match(complete, /auth\.role\(\)[\s\S]*service_role/);
  assert.match(complete, /char_length\(coalesce\(p_result_text,''\)\)>100000/);
  const normalizedComplete = complete.replace(/\r\n?/g, "\n");
  const ownerLookup = normalizedComplete.indexOf("select request.owner into v_owner");
  const ownerLock = normalizedComplete.indexOf("51051120");
  const requestLock = normalizedComplete.indexOf("request.status='running'\n  for update");
  const runLock = normalizedComplete.indexOf("run.status='running' and run.provider_started_at is not null for update");
  assert.ok(ownerLookup >= 0 && ownerLookup < ownerLock);
  assert.ok(ownerLock < requestLock && requestLock < runLock);
});

test("proposal edge function keeps auth.uid and rejects unbounded or malformed input", () => {
  assert.match(propose, /admin\.auth\.getUser\(token\)/);
  assert.match(propose, /const userClient = createClient\(SUPABASE_URL, ANON_KEY/);
  assert.match(propose, /Authorization: `Bearer \$\{token\}`/);
  assert.match(propose, /userClient\.rpc\("propose_agent_board_request"/);
  assert.match(propose, /MAX_REQUEST_CHARS = 64_000/);
  assert.match(propose, /JSON\.stringify\(context\)\.length > 20_000/);
  assert.doesNotMatch(propose, /admin\.rpc\("propose_agent_board_request"/);
});

test("manual runner exact-claims one approval and delegates only a server capability", () => {
  assert.match(run, /admin\.auth\.getUser\(token\)/);
  assert.match(run, /jwtAal\(token\) !== "aal2"/);
  assert.match(run, /allowedKeys = new Set\(\["requestId", "approvalHash", "idempotencyKey"\]\)/);
  assert.match(run, /p_owner: userData\.user\.id/);
  assert.match(run, /claim_agent_board_request_service/);
  assert.match(run, /p_request_id: requestId/);
  assert.match(run, /p_approval_hash: approvalHash/);
  assert.match(run, /p_idempotency_key: idempotencyKey/);
  assert.match(run, /functions\/v1\/ai-proxy/);
  assert.match(run, /Authorization: `Bearer \$\{SERVICE_ROLE_KEY\}`/);
  assert.match(run, /mode: "agent_board"/);
  assert.match(run, /runId,[\s\S]*capability/);
  assert.match(run, /release_agent_board_run_pre_provider/);
  assert.match(run, /idempotent_replay: true/);
  assert.match(run, /agent_board_exact_attempt_limit/);
  assert.match(run, /agent_board_retained_attempt_limit/);
  assert.match(run, /agent_board_claim_rate_limit/);
  assert.match(run, /async function readRequestBody\(req: Request\)[\s\S]*req\.body\.getReader\(\)/);
  assert.match(run, /totalBytes > MAX_REQUEST_BYTES[\s\S]*reader\.cancel\(\)/);
  assert.match(run, /rawBody = await readRequestBody\(req\)/);
  assert.doesNotMatch(run, /await req\.text\(\)/);
  assert.doesNotMatch(run, /mode: "owner_chat"/);
  assert.doesNotMatch(run, /vault\.decrypted_secrets|ai_backend_credentials|decrypted_secret/);
  assert.doesNotMatch(run, /body\.owner|ownerFilter/);
  assert.match(config, /\[functions\.agent-board-propose\][\s\S]*verify_jwt = true/);
  assert.match(config, /\[functions\.agent-board-run\][\s\S]*verify_jwt = true/);
});

test("manual runner cancels a chunked body as soon as its byte ceiling is crossed", async () => {
  const block = run.match(/class RequestTooLargeError extends Error \{\}[\s\S]*?^\}/m)?.[0];
  assert.ok(block, "stream reader source is present");
  const maxBytes = run.match(/const MAX_REQUEST_BYTES = ([\d_]+);/)?.[1];
  assert.ok(maxBytes, "stream byte ceiling is present");
  const executable = block.replace("req: Request", "req");
  const { RequestTooLargeError, readRequestBody } = new Function(
    `const MAX_REQUEST_BYTES=${maxBytes};${executable}; return { RequestTooLargeError, readRequestBody };`,
  )();
  const chunks = [new Uint8Array(3_000), new Uint8Array(2_000)];
  let cancelled = false;
  const req = {
    body: {
      getReader() {
        return {
          async read() {
            return chunks.length ? { done: false, value: chunks.shift() } : { done: true };
          },
          async cancel() {
            cancelled = true;
          },
        };
      },
    },
  };
  await assert.rejects(readRequestBody(req), RequestTooLargeError);
  assert.equal(cancelled, true);
});

test("ai-proxy rejects browser automated modes and executes the frozen reviewed prompts", () => {
  assert.match(aiProxy, /mode !== "agent_board" \|\| !constantTimeEqual\(jwt, SERVICE_ROLE_KEY\)/);
  assert.match(aiProxy, /consume_agent_board_run_capability_service/);
  assert.match(aiProxy, /if \(approvedInput\) \{[\s\S]*serverSystemPrompt = approvedInput\.systemPrompt;[\s\S]*\} else if \(context\) \{/);
  assert.match(aiProxy, /mark_agent_board_provider_started_service/);
  assert.match(aiProxy, /p_credential_revision: approvedInput\?\.credentialRevision/);
  assert.match(aiProxy, /"cancelled",\s*0,\s*"agent_board_provider_start_unavailable"/);
  assert.match(aiProxy, /let providerStartRecorded = false;[\s\S]*let fetchIssued = false;/);
  assert.match(aiProxy, /providerStartRecorded = true;[\s\S]*const providerController = new AbortController\(\);[\s\S]*fetchIssued = true;[\s\S]*fetch\(endpoint\.url/);
  assert.match(aiProxy, /preFetchFailure \? 0 : null/);
  assert.ok(
    aiProxy.indexOf("mark_agent_board_provider_started_service") <
      aiProxy.indexOf("const providerController = new AbortController()"),
  );
});

test("rollback-only PostgreSQL probe covers drift, idempotency, capability, and recovery", () => {
  for (const phrase of [
    "approval rejected review drift",
    "credential rotation invalidated the approved packet",
    "run capability is one-use",
    "pre-provider denial preserved approval",
    "expired pre-provider run restored",
    "expired provider-started run was quarantined",
    "exact approval retry ceiling rejected without insert",
    "short-window claim ceiling rejected without inserting a run",
    "owner retained attempt ceiling ignored legacy shape",
  ]) assert.match(runtimeSql, new RegExp(phrase, "i"));
  assert.match(runtimeSql, /begin;[\s\S]*rollback;/i);
});
