import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Simple in-memory rate limiting (per Deno isolate)
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 5; // 5 requests per minute per IP

function checkRateLimit(ipHash: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(ipHash);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ipHash, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Rate limiting
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const ipHash = await sha256(clientIp);
  if (!checkRateLimit(ipHash)) {
    return new Response(
      JSON.stringify({ error: "Too many requests. Please try again in a minute." }),
      { status: 429, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  // Parse request body
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  const personaHandle = String(body.persona_handle ?? body.handle ?? "").trim();
  const productName = String(body.product_name ?? "").trim();
  const productUrl = String(body.product_url ?? "").trim();
  const requesterName = String(body.requester_name ?? "").trim();
  const requesterEmail = String(body.requester_email ?? "").trim();
  const notes = String(body.notes ?? "").trim();

  if (!personaHandle) {
    return new Response(
      JSON.stringify({ error: "Persona handle is required" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  if (!productName) {
    return new Response(
      JSON.stringify({ error: "Product name is required" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  // Call the RPC to create the review request
  const { data, error } = await admin.rpc("create_review_request", {
    p_persona_handle: personaHandle,
    p_product_name: productName,
    p_product_url: productUrl,
    p_requester_name: requesterName,
    p_requester_email: requesterEmail,
    p_notes: notes,
  });

  if (error) {
    const message = error.message ?? "Failed to create review request";
    const status = message.includes("not found") ? 404
      : message.includes("not enabled") ? 403
      : message.includes("required") || message.includes("too long") || message.includes("must start") ? 422
      : 500;

    return new Response(
      JSON.stringify({ error: message }),
      { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      request_id: data,
      message: "Review request submitted. The persona's owner will review it.",
    }),
    { status: 201, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
  );
});
