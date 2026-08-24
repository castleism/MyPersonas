// run-operations-maintenance — bounded retention batches plus one safe heartbeat.
//
// Deploy without gateway JWT verification only when X-Cron-Secret is configured
// to the existing high-entropy CRON_SECRET. This source does not create a
// schedule. Provider activation remains a separate owner-approved operation.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const BATCH_LIMIT = 500;
const MAX_REPORTED_DELETIONS = 50_000;

type MaintenanceTask = Readonly<{
  name: string;
  rpc: string;
  args: Readonly<Record<string, number>>;
}>;

const MAINTENANCE_TASKS: readonly MaintenanceTask[] = Object.freeze([
  Object.freeze({
    name: "product_review_rate_limits",
    rpc: "prune_product_review_rate_limits_batch_service",
    args: Object.freeze({ p_limit: BATCH_LIMIT }),
  }),
  Object.freeze({
    name: "affiliate_click_retention",
    rpc: "purge_affiliate_click_retention_batch_service",
    args: Object.freeze({ p_limit: BATCH_LIMIT }),
  }),
  Object.freeze({
    name: "governance_security_retention",
    rpc: "purge_governance_security_retention_batch_service",
    args: Object.freeze({ p_limit: BATCH_LIMIT }),
  }),
  Object.freeze({
    name: "ai_backend_budget_retention",
    rpc: "purge_ai_backend_budget_retention",
    args: Object.freeze({ p_limit: BATCH_LIMIT }),
  }),
  Object.freeze({
    name: "billing_retention",
    rpc: "billing_run_retention",
    args: Object.freeze({ p_limit: BATCH_LIMIT }),
  }),
]);

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function boundedInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return 0;
  }
  return Math.min(value, MAX_REPORTED_DELETIONS);
}

function boundedDeletionCount(value: unknown): number {
  if (typeof value === "number") return boundedInteger(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  let total = 0;
  for (const candidate of Object.values(value as Record<string, unknown>)) {
    total = Math.min(
      MAX_REPORTED_DELETIONS,
      total + boundedInteger(candidate),
    );
  }
  return total;
}

serve(async (request) => {
  if (request.method !== "POST") return response({ error: "POST only" }, 405);
  if (
    !SUPABASE_URL || !SERVICE_ROLE_KEY || !CRON_SECRET ||
    request.headers.get("X-Cron-Secret") !== CRON_SECRET
  ) {
    return response({ error: "forbidden" }, 403);
  }
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const counts: Record<string, number> = {};
  const failedTasks: string[] = [];
  for (const task of MAINTENANCE_TASKS) {
    const result = await admin.rpc(task.rpc, task.args);
    if (result.error) {
      // Never persist or print a database message; it can contain identifiers.
      console.error(`Operations maintenance task failed: ${task.name}`);
      failedTasks.push(task.name);
      counts[task.name] = 0;
      continue;
    }
    counts[task.name] = boundedDeletionCount(result.data);
  }

  const deletedCount = Math.min(
    MAX_REPORTED_DELETIONS,
    Object.values(counts).reduce((sum, count) => sum + count, 0),
  );
  const succeeded = failedTasks.length === 0;
  const heartbeat = await admin.from("platform_security_events").insert({
    actor_id: null,
    event_type: succeeded
      ? "operations_maintenance_completed"
      : "operations_maintenance_failed",
    severity: succeeded ? "info" : "high",
    source: "edge_function",
    subject_type: "operations",
    subject_id: "retention",
    identifier_hash: "",
    metadata: {
      schema_version: 1,
      task_count: MAINTENANCE_TASKS.length,
      failed_count: failedTasks.length,
      failed_tasks: failedTasks,
      deleted_count: deletedCount,
      counts,
    },
  });
  if (heartbeat.error) {
    console.error("Operations maintenance heartbeat could not be recorded");
    return response({ error: "maintenance_heartbeat_unavailable" }, 500);
  }

  return response({
    ok: succeeded,
    task_count: MAINTENANCE_TASKS.length,
    failed_count: failedTasks.length,
    failed_tasks: failedTasks,
    deleted_count: deletedCount,
    counts,
  }, succeeded ? 200 : 500);
});
