import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CLICK_HMAC_SECRET = Deno.env.get("AFFILIATE_CLICK_HMAC_SECRET") ?? "";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

type AffiliateDestination = {
  offer_id: string;
  persona_id: string;
  affiliate_url: string;
};

async function hmacHex(secret: string, text: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(text));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function boundedAttribution(value: string | null): string {
  const normalized = (value ?? "").trim();
  return normalized.length <= 120 && !/[\u0000-\u001f\u007f<>]/.test(normalized)
    ? normalized
    : "";
}

function referrerHost(req: Request): string {
  const raw = req.headers.get("referer") ?? "";
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username &&
        !parsed.password
      ? parsed.hostname.toLowerCase().slice(0, 253)
      : "";
  } catch {
    return "";
  }
}

function clientIp(req: Request): string {
  return (req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for")?.split(",")[0] ?? "").trim();
}

function isPublicHttpsDestination(value: string): URL | null {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (
      parsed.protocol !== "https:" || parsed.username || parsed.password ||
      !hostname.includes(".") || /^[0-9.]+$/.test(hostname) ||
      hostname.includes(":") || hostname === "localhost" ||
      hostname === "localhost.localdomain" ||
      [".localhost", ".local", ".internal", ".lan"].some((suffix) =>
        hostname.endsWith(suffix)
      )
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseQuery(url: URL) {
  const requestedSource = (url.searchParams.get("source") ?? "unknown").toLowerCase();
  return {
    offerId: url.searchParams.get("offer") ?? url.searchParams.get("offer_id") ?? "",
    source: ["persona_page", "album", "campaign"].includes(requestedSource)
      ? requestedSource
      : "unknown",
    utmSource: boundedAttribution(url.searchParams.get("utm_source")),
    utmMedium: boundedAttribution(url.searchParams.get("utm_medium")),
    utmCampaign: boundedAttribution(url.searchParams.get("utm_campaign")),
  };
}

Deno.serve(async (req: Request) => {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || CLICK_HMAC_SECRET.length < 32) {
    return new Response(JSON.stringify({ error: "Service temporarily unavailable" }), {
      status: 503,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  if (req.url.length > 8192) {
    return new Response(JSON.stringify({ error: "Request URL is too long" }), {
      status: 414,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  const url = new URL(req.url);
  const params = parseQuery(url);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.offerId)) {
    return new Response(JSON.stringify({ error: "Missing offer parameter" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const ip = clientIp(req);
  if (!ip) {
    return new Response(JSON.stringify({ error: "Service temporarily unavailable" }), {
      status: 503,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 1024);
  const rotation = new Date().toISOString().slice(0, 10);
  const [fingerprintHash, userAgentHash] = await Promise.all([
    hmacHex(CLICK_HMAC_SECRET, `affiliate-click:fingerprint:v1:${rotation}:${ip}:${userAgent}`),
    userAgent
      ? hmacHex(CLICK_HMAC_SECRET, `affiliate-click:user-agent:v1:${rotation}:${userAgent}`)
      : Promise.resolve(""),
  ]);

  // Destination resolution, publication recheck, bounded dedupe, and optional
  // analytics insertion are one service-side transaction. A replay can still
  // redirect, but cannot create unbounded click rows or bypass page review.
  const { data: destinationRows, error: offerError } = await admin.rpc(
    "resolve_affiliate_redirect_service",
    {
      p_offer_id: params.offerId,
      p_source: params.source,
      p_referrer_host: referrerHost(req),
      p_utm_source: params.utmSource,
      p_utm_medium: params.utmMedium,
      p_utm_campaign: params.utmCampaign,
      p_fingerprint_hash: fingerprintHash,
      p_user_agent_hash: userAgentHash,
    },
  );
  const destination = (Array.isArray(destinationRows)
    ? destinationRows[0]
    : destinationRows) as AffiliateDestination | null | undefined;

  if (offerError || !destination) {
    return new Response(JSON.stringify({ error: "Offer not found or inactive" }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const redirect = isPublicHttpsDestination(destination.affiliate_url);
  if (!redirect) {
    return new Response(JSON.stringify({ error: "Invalid redirect URL" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // 302 redirect to the affiliate URL
  return new Response(null, {
    status: 302,
    headers: {
      Location: redirect.href,
      "Cache-Control": "no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
});
