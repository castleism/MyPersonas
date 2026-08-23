// agent-board-run: exact, owner-triggered execution of one immutable approval.
// A verified AAL2 owner session selects the request/hash/idempotency tuple. A
// one-use capability is passed service-to-service to ai-proxy; neither browser
// input nor mutable persona/model records can replace the approved snapshot.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAX_REQUEST_BYTES = 4_096;
const ALLOWED_ORIGINS = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type ClaimRow = {
  request_id?: unknown;
  run_id?: unknown;
  claimed_new?: unknown;
  run_status?: unknown;
  request_status?: unknown;
  result_text?: unknown;
  result_json?: unknown;
  error?: unknown;
};

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, origin = "") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...(origin && ALLOWED_ORIGINS.has(origin) ? cors(origin) : {}),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function bearerToken(req: Request) {
  return (req.headers.get("Authorization") ?? "")
    .match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";
}

function jwtAal(token: string) {
  try {
    const segment = token.split(".")[1] ?? "";
    const padded = segment.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(segment.length / 4) * 4, "=");
    return String((JSON.parse(atob(padded)) as Record<string, unknown>).aal ?? "");
  } catch {
    return "";
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      .test(value);
}

function bounded(value: unknown, max: number) {
  return String(value ?? "").replaceAll("\0", "").slice(0, max);
}

class RequestTooLargeError extends Error {}

async function readRequestBody(req: Request) {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES) {
        throw new RequestTooLargeError("request body exceeded the safe limit");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock?.();
  }
}

function exactClaimFailure(message: unknown) {
  const detail = bounded(message, 1_000);
  if (detail.includes("Agent Board exact approval attempt limit reached (10)")) {
    return {
      status: 409,
      body: {
        error: "This exact approval has reached its 10-attempt safety limit. Cancel it and submit a freshly reviewed request before trying again.",
        code: "agent_board_exact_attempt_limit",
      },
    };
  }
  if (detail.includes("Agent Board secure retained attempt limit reached (10000)")) {
    return {
      status: 409,
      body: {
        error: "This account has reached its 10,000 retained secure Agent Board attempt limit. Remove retained board history before claiming new work.",
        code: "agent_board_retained_attempt_limit",
      },
    };
  }
  if (detail.includes("Agent Board short-window claim limit reached (60 per 10 minutes)")) {
    return {
      status: 429,
      body: {
        error: "Agent Board is limited to 60 new claims per 10 minutes. Wait before claiming more work.",
        code: "agent_board_claim_rate_limit",
      },
    };
  }
  return {
    status: 409,
    body: { error: "The exact approved request could not be claimed" },
  };
}

function randomCapability() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function finish(
  requestId: string,
  runId: string,
  status: "completed" | "failed" | "timeout",
  resultText = "",
  resultJson: Record<string, unknown> = {},
  error = "",
) {
  return await admin.rpc("complete_agent_board_run", {
    p_request_id: requestId,
    p_run_id: runId,
    p_status: status,
    p_result_text: bounded(resultText, 100_000),
    p_result_json: resultJson,
    p_error: bounded(error, 4_000),
  });
}

async function releaseBeforeProvider(
  requestId: string,
  runId: string,
  code: string,
  error: string,
) {
  return await admin.rpc("release_agent_board_run_pre_provider", {
    p_request_id: requestId,
    p_run_id: runId,
    p_code: bounded(code, 80).toLowerCase().replace(/[^a-z0-9_:-]/g, "_") ||
      "pre_provider_failure",
    p_error: bounded(error, 4_000),
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") ?? "";
  if (req.method === "OPTIONS") {
    return ALLOWED_ORIGINS.has(origin)
      ? new Response(null, { status: 204, headers: cors(origin) })
      : new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return json({ error: "Origin not allowed" }, 403, origin);
  }
  const declaredLength = Number(req.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    return json({ error: "Request is too large" }, 413, origin);
  }
  const token = bearerToken(req);
  if (!token) return json({ error: "Missing bearer session" }, 401, origin);
  const { data: userData, error: userError } = await admin.auth.getUser(token);
  if (userError || !userData?.user) {
    return json({ error: "Invalid or expired session" }, 401, origin);
  }
  if (jwtAal(token) !== "aal2") {
    return json({ error: "Multi-factor authentication is required" }, 403, origin);
  }

  let rawBody = "";
  try {
    rawBody = await readRequestBody(req);
  } catch (error) {
    return error instanceof RequestTooLargeError
      ? json({ error: "Request is too large" }, 413, origin)
      : json({ error: "Invalid request body" }, 400, origin);
  }
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid object");
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON request" }, 400, origin);
  }
  const allowedKeys = new Set(["requestId", "approvalHash", "idempotencyKey"]);
  if (Object.keys(payload).some((key) => !allowedKeys.has(key))) {
    return json({ error: "Unexpected execution parameter" }, 400, origin);
  }
  const requestId = payload.requestId;
  const approvalHash = typeof payload.approvalHash === "string"
    ? payload.approvalHash.trim().toLowerCase()
    : "";
  const idempotencyKey = payload.idempotencyKey;
  if (!isUuid(requestId) || !isUuid(idempotencyKey) ||
    !/^[0-9a-f]{64}$/.test(approvalHash)) {
    return json({ error: "Exact request, approval hash, and idempotency key are required" }, 400, origin);
  }

  const reconciled = await admin.rpc("reconcile_expired_agent_board_runs_service", {
    p_owner: userData.user.id,
  });
  if (reconciled.error) {
    return json({ error: "Expired Agent Board work could not be reconciled" }, 503, origin);
  }

  const capability = randomCapability();
  const capabilityHash = await sha256Hex(capability);
  const { data: claimData, error: claimError } = await admin.rpc(
    "claim_agent_board_request_service",
    {
      p_owner: userData.user.id,
      p_request_id: requestId,
      p_approval_hash: approvalHash,
      p_idempotency_key: idempotencyKey,
      p_capability_hash: capabilityHash,
    },
  );
  if (claimError) {
    const denied = exactClaimFailure(claimError.message);
    return json(denied.body, denied.status, origin);
  }
  const rawClaim = Array.isArray(claimData) ? claimData[0] : claimData;
  if (!rawClaim || typeof rawClaim !== "object") {
    return json({ error: "The claim response was malformed" }, 503, origin);
  }
  const claim = rawClaim as ClaimRow;
  const runId = claim.run_id;
  if (!isUuid(runId)) return json({ error: "The claim response was malformed" }, 503, origin);

  if (claim.claimed_new !== true) {
    const replayStatus = bounded(claim.run_status, 40) || "unknown";
    const replayRequestStatus = bounded(claim.request_status, 40) || "unknown";
    const replayResult = claim.result_json && typeof claim.result_json === "object" &&
        !Array.isArray(claim.result_json)
      ? claim.result_json as Record<string, unknown>
      : {};
    const replaySuccess = replayStatus === "completed";
    return json({
      success: replaySuccess,
      executed: 0,
      request_id: requestId,
      run_id: runId,
      status: replayStatus,
      request_status: replayRequestStatus,
      result: replaySuccess ? bounded(claim.result_text, 2_000) : undefined,
      error: replaySuccess ? undefined : bounded(claim.error, 4_000),
      pre_provider: replayResult.pre_provider === true,
      code: bounded(replayResult.code, 80) || undefined,
      idempotent_replay: true,
    }, replaySuccess ? 200 : 409, origin);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 70_000);
  let proxyResponse: Response;
  let proxyText = "";
  try {
    proxyResponse = await fetch(
      `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/ai-proxy`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          apikey: SERVICE_ROLE_KEY,
          "Content-Type": "application/json",
        },
        redirect: "error",
        signal: controller.signal,
        body: JSON.stringify({
          action: "chat",
          mode: "agent_board",
          runId,
          capability,
        }),
      },
    );
    proxyText = await proxyResponse.text();
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "AbortError";
    return json({
      success: false,
      executed: 1,
      request_id: requestId,
      run_id: runId,
      status: "running",
      error: timedOut
        ? "The secure proxy timed out; reconcile this run after its capability expires"
        : "The secure proxy connection failed; reconcile this run after its capability expires",
      reconciliation_required: true,
    }, 504, origin);
  } finally {
    clearTimeout(timeout);
  }

  let parsed: Record<string, unknown> = {};
  try {
    const value = JSON.parse(proxyText);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }

  if (!proxyResponse.ok) {
    const proxyError = bounded(parsed.error, 4_000) ||
      `AI proxy returned HTTP ${proxyResponse.status}`;
    const code = bounded(parsed.code, 80) || `proxy_http_${proxyResponse.status}`;
    const released = await releaseBeforeProvider(requestId, runId, code, proxyError);
    if (!released.error) {
      return json({
        success: false,
        executed: 1,
        request_id: requestId,
        run_id: runId,
        status: "failed",
        request_status: "approved",
        error: proxyError,
        code,
        pre_provider: true,
      }, proxyResponse.status, origin);
    }
    const completion = await finish(requestId, runId,
      proxyResponse.status === 504 ? "timeout" : "failed", "", {}, proxyError);
    if (completion.error) {
      return json({
        error: "The run state could not be safely recorded",
        request_id: requestId,
        run_id: runId,
        reconciliation_required: true,
      }, 503, origin);
    }
    return json({
      success: false,
      executed: 1,
      request_id: requestId,
      run_id: runId,
      status: proxyResponse.status === 504 ? "timeout" : "failed",
      request_status: "failed",
      error: proxyError,
      code,
      pre_provider: false,
    }, 502, origin);
  }

  const resultText = bounded(parsed.content, 100_000);
  if (!resultText) {
    const completion = await finish(
      requestId, runId, "failed", "", {}, "AI proxy returned no assistant text",
    );
    if (completion.error) {
      return json({ error: "The empty provider result could not be recorded" }, 503, origin);
    }
    return json({
      success: false, executed: 1, request_id: requestId, run_id: runId,
      status: "failed", request_status: "failed",
      error: "AI proxy returned no assistant text",
    }, 502, origin);
  }
  const completion = await finish(requestId, runId, "completed", resultText);
  if (completion.error) {
    return json({ error: "The run result could not be recorded" }, 503, origin);
  }
  return json({
    success: true,
    executed: 1,
    request_id: requestId,
    run_id: runId,
    status: "completed",
    request_status: "completed",
    result: resultText.slice(0, 2_000),
    idempotent_replay: false,
  }, 200, origin);
});
