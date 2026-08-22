import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

type AffiliateProduct = {
  id: string;
  title: string;
  affiliate_url: string;
  status: string;
  disclosure: string;
  merchant: string;
};

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parseQuery(url: URL) {
  return {
    offerId: url.searchParams.get("offer") ?? url.searchParams.get("offer_id") ?? "",
    personaHandle: url.searchParams.get("persona") ?? url.searchParams.get("handle") ?? "",
    source: url.searchParams.get("source") ?? "unknown",
    referrer: url.searchParams.get("referrer") ?? "",
    utmSource: url.searchParams.get("utm_source") ?? "",
    utmMedium: url.searchParams.get("utm_medium") ?? "",
    utmCampaign: url.searchParams.get("utm_campaign") ?? "",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const url = new URL(req.url);
  const params = parseQuery(url);

  if (!params.offerId) {
    return new Response(JSON.stringify({ error: "Missing offer parameter" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Fetch the offer + product + persona details
  const { data: offer, error: offerError } = await admin
    .from("persona_affiliate_offers")
    .select(
      `id, owner, persona_id, product_id, status,
       affiliate_products!inner(id, title, affiliate_url, status, disclosure, merchant),
       personas!inner(id, handle)`
    )
    .eq("id", params.offerId)
    .eq("status", "active")
    .single();

  if (offerError || !offer) {
    return new Response(JSON.stringify({ error: "Offer not found or inactive" }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // PostgREST relationship inference can type an inner join as an array even
  // when this relationship is singular. Normalize both response shapes.
  const productRelation = offer.affiliate_products as unknown;
  const product = (Array.isArray(productRelation)
    ? productRelation[0]
    : productRelation) as AffiliateProduct | null | undefined;
  if (!product || product.status !== "active" || !product.affiliate_url) {
    return new Response(JSON.stringify({ error: "Product unavailable" }), {
      status: 404,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Validate redirect URL is http/https to prevent open redirect
  if (!/^https?:\/\//i.test(product.affiliate_url)) {
    return new Response(JSON.stringify({ error: "Invalid redirect URL" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  // Log the click (fire-and-forget, never block the redirect)
  try {
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
    const userAgent = req.headers.get("user-agent") ?? "";

    const [ipHash, uaHash] = await Promise.all([
      clientIp ? sha256(clientIp) : "",
      userAgent ? sha256(userAgent) : "",
    ]);

    await admin.rpc("record_affiliate_click", {
      p_persona_id: offer.persona_id,
      p_offer_id: offer.id,
      p_source: params.source,
      p_referrer: params.referrer,
      p_utm_source: params.utmSource,
      p_utm_medium: params.utmMedium,
      p_utm_campaign: params.utmCampaign,
      p_ip_hash: ipHash,
      p_user_agent_hash: uaHash,
    });
  } catch (e) {
    console.error(
      "Click logging failed (non-blocking):",
      e instanceof Error ? e.message : String(e),
    );
  }

  // 302 redirect to the affiliate URL
  return new Response(null, {
    status: 302,
    headers: {
      Location: product.affiliate_url,
      "Cache-Control": "no-store, max-age=0",
    },
  });
});
