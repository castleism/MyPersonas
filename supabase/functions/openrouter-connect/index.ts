// OpenRouter OAuth exchange and Vault-backed model connection.
// The provider key exists only inside this AAL2-authenticated server request and
// is passed directly to the owner-scoped create_ai_backend RPC. It is never
// returned to the browser or written to logs.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const USER_API_KEY = Deno.env.get("SUPABASE_ANON_KEY") ||
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";

const OPENROUTER_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024;
const ALLOWED_ORIGINS = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, origin = "") {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(origin && ALLOWED_ORIGINS.has(origin) ? cors(origin) : {}),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function boundedText(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error("Provider response exceeded the safe limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("Provider response exceeded the safe limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return json(null, 204, origin);
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return json({ error: "Origin not allowed" }, 403);
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return json({ error: "Request body is too large" }, 413, origin);
  }
  if (!USER_API_KEY) {
    return json({ error: "OpenRouter connection storage is unavailable" }, 503, origin);
  }

  const guard = await requireAal2(req, admin);
  if (!guard.ok) {
    return json({ error: guard.error, code: guard.code }, guard.status, origin);
  }

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: "A JSON request body is required" }, 400, origin);
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const codeVerifier = typeof body.codeVerifier === "string"
    ? body.codeVerifier.trim()
    : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!code || code.length > 2048) {
    return json({ error: "A valid OpenRouter authorization code is required" }, 400, origin);
  }
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) {
    return json({ error: "A valid PKCE verifier is required" }, 400, origin);
  }
  if (model.length > 300) {
    return json({ error: "Model id is too long" }, 400, origin);
  }

  let providerResponse: Response;
  try {
    providerResponse = await fetch(OPENROUTER_EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code,
        code_verifier: codeVerifier,
        code_challenge_method: "S256",
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return json({ error: "OpenRouter could not complete authorization" }, 502, origin);
  }

  let providerBody: Record<string, unknown> = {};
  try {
    const text = await boundedText(providerResponse, MAX_PROVIDER_RESPONSE_BYTES);
    const parsed = text ? JSON.parse(text) : {};
    providerBody = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return json({ error: "OpenRouter returned an invalid response" }, 502, origin);
  }
  const providerKey = typeof providerBody.key === "string"
    ? providerBody.key.trim()
    : "";
  if (!providerResponse.ok || !providerKey) {
    return json({ error: "OpenRouter could not complete authorization" }, 502, origin);
  }

  const ownerClient = createClient(SUPABASE_URL, USER_API_KEY, {
    global: { headers: { Authorization: `Bearer ${guard.token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const stored = await ownerClient.rpc("create_ai_backend", {
    p_provider: "openrouter",
    p_name: "OpenRouter",
    p_base_url: OPENROUTER_BASE_URL,
    p_api_key: providerKey,
    p_model: model,
    p_extra: { auth_method: "openrouter_oauth" },
  });
  if (stored.error || !stored.data) {
    return json({
      error: "OpenRouter issued a key, but secure storage did not accept it",
      providerKeyIssued: true,
      manualRevocationRequired: true,
    }, 502, origin);
  }
  return json({
    connected: true,
    backendId: stored.data,
    modelConfigured: !!model,
  }, 200, origin);
});
