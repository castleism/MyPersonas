// compose-post — stage a 3-part post draft for a persona.
//
// Given a brief + a source image, this drafts the three platform-tailored captions
// in the persona's voice (by calling the hardened ai-proxy with the persona's linked
// model). No-AI imagery may use Supabase image transforms; AI-used imagery must
// arrive with separately registered, visibly watermarked final crops so a transform
// cannot crop the mark away. It writes an
// owner-scoped row to post_drafts with status='draft' — nothing is published here;
// the weekly approval flow + the publisher handle that. See POSTING-3PART-SPEC.md.
//
// Contract (POST, owner bearer token):
//   { action:"compose", personaId, brief, sourceImageUrl, sourceImageVariants?,
//     scheduledFor?, targets?, captions?({fb,ig,x}) }
//   -> { draft: <post_drafts row> }
// If captions are supplied they are used verbatim; otherwise the persona's model
// writes them. A persona with no linked model + no supplied captions -> 422.
//
// Deploy: supabase functions deploy compose-post --project-ref nwsqyuucwzihruszocge
// Required secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const X_CAPTION_MAX = 280;
const IG_CAPTION_MAX = 2200;
const FB_CAPTION_MAX = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Platform image crops (width x height, cover). FB 1.91:1, IG 1:1, X 4:5.
const CROPS = {
  fb: { w: 1200, h: 628 },
  ig: { w: 1080, h: 1080 },
  x: { w: 1080, h: 1350 },
} as const;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ORIGINS = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);

function json(body: unknown, status = 200, origin = "") {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(origin && ORIGINS.has(origin)
        ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Headers":
            "authorization, x-client-info, apikey, content-type",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Vary": "Origin",
        }
        : {}),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function caller(req: Request) {
  const auth = req.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(auth)) return null;
  const { data, error } = await admin.auth.getUser(
    auth.replace(/^Bearer\s+/i, ""),
  );
  return error ? null : data.user;
}

// Turn a Supabase Storage public object URL into an on-the-fly image-transform URL
// at the requested size. Non-Storage URLs are returned unchanged (no crop).
function transformUrl(source: string, w: number, h: number) {
  const marker = "/storage/v1/object/public/";
  if (!source.includes(marker)) return source;
  const base = source.split("?")[0].replace(
    marker,
    "/storage/v1/render/image/public/",
  );
  return `${base}?width=${w}&height=${h}&resize=cover&quality=82`;
}

function mondayOf(d: Date): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = (x.getUTCDay() + 6) % 7; // 0 = Monday
  x.setUTCDate(x.getUTCDate() - day);
  return x.toISOString().slice(0, 10);
}

function composePrompt(brief: string) {
  return [
    "Write three social media captions for the post described below, IN YOUR OWN",
    "persona voice. Return ONLY a JSON object, no code fences, no extra text:",
    '{"fb":"...","ig":"...","x":"..."}',
    "",
    "- fb: a detailed Facebook caption — a full, engaging description of the event or",
    "  product (a few sentences). This is the most thorough of the three.",
    "- ig: an optimal-length Instagram caption — one or two punchy sentences plus up to",
    "  3 relevant hashtags.",
    `- x: a single very short line for X, strictly under ${X_CAPTION_MAX} characters.`,
    "",
    "Brief: " + brief,
  ].join("\n");
}

function extractCaptions(content: string) {
  let obj: Record<string, unknown> | null = null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      obj = JSON.parse(content.slice(start, end + 1));
    } catch { /* fall through */ }
  }
  const clip = (v: unknown, n: number) =>
    (typeof v === "string" ? v : "").trim().slice(0, n);
  if (obj) {
    return {
      fb: clip(obj.fb ?? obj.facebook, FB_CAPTION_MAX),
      ig: clip(obj.ig ?? obj.instagram, IG_CAPTION_MAX),
      x: clip(obj.x ?? obj.twitter, X_CAPTION_MAX),
    };
  }
  // No parseable JSON — use the whole reply for FB and derive shorter variants.
  const flat = content.trim();
  return {
    fb: flat.slice(0, FB_CAPTION_MAX),
    ig: flat.slice(0, 300),
    x: flat.slice(0, X_CAPTION_MAX),
  };
}

async function generateCaptions(
  authHeader: string,
  backendId: string,
  personaId: string,
  brief: string,
) {
  const r = await fetch(
    `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/ai-proxy`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader,
      },
      body: JSON.stringify({
        backendId,
        personaId,
        mode: "owner_chat",
        max_tokens: 900,
        messages: [{ role: "user", content: composePrompt(brief) }],
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(
      (j as { error?: { message?: string } | string })?.error
        ? (typeof (j as { error: unknown }).error === "string"
          ? String((j as { error: string }).error)
          : ((j as { error: { message?: string } }).error.message ||
            "model error"))
        : `The persona model failed (HTTP ${r.status}).`,
    );
  }
  return String((j as { content?: string }).content || "");
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return json(null, 204, origin);
  if (origin && !ORIGINS.has(origin)) return json({ error: "Origin not allowed" }, 403);
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);

  const user = await caller(req);
  if (!user) return json({ error: "Sign in first" }, 401, origin);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  if (body.action !== "compose") {
    return json({ error: "Unknown action" }, 400, origin);
  }

  const personaId = String(body.personaId || "");
  const brief = String(body.brief || "").trim();
  const sourceImageUrl = String(body.sourceImageUrl || "").trim();
  if (!SAFE_ID.test(personaId)) {
    return json({ error: "A valid personaId is required." }, 400, origin);
  }
  if (!brief || brief.length > 4000) {
    return json({ error: "A brief (1–4000 chars) is required." }, 400, origin);
  }
  if (sourceImageUrl && !/^https:\/\/\S+$/i.test(sourceImageUrl)) {
    return json({ error: "sourceImageUrl must be a public https URL." }, 400, origin);
  }
  const suppliedVariants = body.sourceImageVariants && typeof body.sourceImageVariants === "object"
    ? body.sourceImageVariants as Record<string, unknown>
    : {};
  const targets = Array.isArray(body.targets)
    ? body.targets.map((t) => String(t)).filter((t) =>
      ["facebook", "instagram", "twitter"].includes(t)
    )
    : ["facebook", "instagram", "twitter"];
  const scheduledFor = typeof body.scheduledFor === "string" && body.scheduledFor
    ? body.scheduledFor
    : null;
  const facebookLedgerId = String(body.facebookLedgerId || "");
  if (facebookLedgerId && !SAFE_ID.test(facebookLedgerId)) {
    return json({ error: "facebookLedgerId must be a valid id." }, 400, origin);
  }

  // Owner-scoped persona.
  const { data: persona, error: pErr } = await admin.from("personas")
    .select("id,owner,ai_backend")
    .eq("id", personaId)
    .eq("owner", user.id)
    .maybeSingle();
  if (pErr) return json({ error: "Could not load the persona." }, 500, origin);
  if (!persona) {
    return json({ error: "Persona not found for your account." }, 404, origin);
  }

  // The browser can prepare bytes, but only the service-authored registry is
  // provenance authority. This also rejects a hand-edited or pasted URL.
  let sourceAsset: Record<string, unknown> | null = null;
  let registeredVariants: Record<string, Record<string, unknown>> = {};
  if (sourceImageUrl) {
    const sourceResult = await admin.from("persona_media_assets")
      .select("id,public_url,source_sha256,content_sha256,ai_use,declaration_source,watermark_state,provenance_sha256,rendition,status")
      .eq("owner", user.id)
      .eq("persona_id", personaId)
      .eq("public_url", sourceImageUrl)
      .eq("status", "active")
      .maybeSingle();
    if (sourceResult.error) return json({ error: "Could not verify source media provenance." }, 500, origin);
    if (!sourceResult.data || sourceResult.data.declaration_source === "legacy") {
      return json({ error: "Prepare this image through the secure media intake first." }, 422, origin);
    }
    sourceAsset = sourceResult.data as Record<string, unknown>;
    if (sourceAsset.ai_use !== "none") {
      const urls = {
        facebook: String(suppliedVariants.facebook || ""),
        instagram: String(suppliedVariants.instagram || ""),
        x: String(suppliedVariants.x || ""),
      };
      if (Object.values(urls).some((value) => !/^https:\/\/\S+$/i.test(value)) || new Set(Object.values(urls)).size !== 3) {
        return json({ error: "AI-used media requires three distinct registered final crops." }, 422, origin);
      }
      const variantsResult = await admin.from("persona_media_assets")
        .select("id,public_url,source_sha256,ai_use,declaration_source,watermark_state,provenance_sha256,rendition,status")
        .eq("owner", user.id)
        .eq("persona_id", personaId)
        .eq("status", "active")
        .in("public_url", Object.values(urls));
      if (variantsResult.error) return json({ error: "Could not verify final crop provenance." }, 500, origin);
      const byUrl = new Map((variantsResult.data || []).map((asset) => [asset.public_url, asset]));
      const expectedRenditions: Record<string, string> = { facebook: "facebook", instagram: "instagram", x: "x" };
      for (const [platform, url] of Object.entries(urls)) {
        const asset = byUrl.get(url) as Record<string, unknown> | undefined;
        if (!asset || asset.source_sha256 !== sourceAsset.source_sha256 || asset.ai_use !== sourceAsset.ai_use ||
            asset.declaration_source === "legacy" || asset.watermark_state !== "system_applied" ||
            asset.rendition !== expectedRenditions[platform] || !UUID.test(String(asset.id || ""))) {
          return json({ error: `The ${platform} crop is not an exact registered watermarked rendition.` }, 422, origin);
        }
        registeredVariants[platform] = asset;
      }
    }
  }

  // Captions: use supplied, else generate with the persona's linked model.
  const supplied = body.captions && typeof body.captions === "object"
    ? body.captions as Record<string, unknown>
    : null;
  let captions: { fb: string; ig: string; x: string };
  if (supplied && (supplied.fb || supplied.ig || supplied.x)) {
    captions = {
      fb: String(supplied.fb || "").slice(0, FB_CAPTION_MAX),
      ig: String(supplied.ig || "").slice(0, IG_CAPTION_MAX),
      x: String(supplied.x || "").slice(0, X_CAPTION_MAX),
    };
  } else if (persona.ai_backend) {
    try {
      const content = await generateCaptions(
        req.headers.get("Authorization") || "",
        String(persona.ai_backend),
        personaId,
        brief,
      );
      captions = extractCaptions(content || "");
      if (!captions.fb && !captions.ig && !captions.x) {
        return json(
          { error: "The persona model returned an empty draft." },
          502,
          origin,
        );
      }
    } catch (e) {
      return json({ error: (e as Error).message }, 502, origin);
    }
  } else {
    return json({
      error:
        "Link an AI model to this persona to auto-write captions, or supply captions.",
      needsModel: true,
    }, 422, origin);
  }

  const aiUsed = !!sourceAsset && sourceAsset.ai_use !== "none";
  const fbImg = sourceImageUrl ? (aiUsed ? String(registeredVariants.facebook.public_url) : transformUrl(sourceImageUrl, CROPS.fb.w, CROPS.fb.h)) : "";
  const igImg = sourceImageUrl ? (aiUsed ? String(registeredVariants.instagram.public_url) : transformUrl(sourceImageUrl, CROPS.ig.w, CROPS.ig.h)) : "";
  const xImg = sourceImageUrl ? (aiUsed ? String(registeredVariants.x.public_url) : transformUrl(sourceImageUrl, CROPS.x.w, CROPS.x.h)) : "";
  const weekStart = mondayOf(scheduledFor ? new Date(scheduledFor) : new Date());

  const { data: draft, error: insErr } = await admin.from("post_drafts")
    .insert({
      owner: user.id,
      persona_id: personaId,
      week_start: weekStart,
      status: "draft",
      scheduled_for: scheduledFor,
      brief,
      source_image_url: sourceImageUrl,
      fb_caption: captions.fb,
      ig_caption: captions.ig,
      x_caption: captions.x,
      fb_image_url: fbImg,
      ig_image_url: igImg,
      x_image_url: xImg,
      media_provenance_required: true,
      targets,
      facebook_ledger_id: facebookLedgerId,
    })
    .select()
    .single();
  if (insErr) {
    return json({ error: "Could not save the draft: " + insErr.message }, 500, origin);
  }
  return json({ draft }, 200, origin);
});
