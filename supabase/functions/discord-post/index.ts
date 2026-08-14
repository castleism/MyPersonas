// discord-post — publish one approved draft to an owner-connected Discord
// channel webhook.
//
// Frontend contract (POST, signed-in user's Supabase bearer token required):
//   { draftId }
//     -> { published:true, messageId, channelId }
//     -> { error } with 4xx/5xx otherwise
//
// Safety model:
// - Channel webhooks are Discord's official inbound posting mechanism for a
//   channel the owner controls. No user-account automation, no password, no
//   message reading, no scraping.
// - The webhook URL lives only in Supabase Vault (migration 019). It is read
//   here through a service-role-only RPC and never returned to a browser.
// - Only the draft's owner can publish it, only when the draft is approved,
//   not already publishing/published, assigned to a connected Discord ledger
//   record, and the global automation pause is off.
// - This endpoint is owner-pressed only. Scheduled/L3 auto-posting to Discord
//   is intentionally NOT implemented here; it requires the destination-mode
//   review path like the native bridge.
//
// Deploy with default gateway JWT verification:
//   supabase functions deploy discord-post
// No new function secrets are required.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const DISCORD_CONTENT_LIMIT = 2000;
// This endpoint is deliberately dormant in the coordinated 2026-08-13 release.
// Do not replace this with an environment toggle: re-enabling requires a reviewed
// claim/hash/destination-fingerprint migration, provider-ID checkpointing,
// uncertain-outcome reconciliation, and transactional finalization/audit.
const DISCORD_POST_RELEASE_ENABLED = false;
const ALLOWED_ORIGINS = new Set([
  "https://mypersonas.online",
  "https://www.mypersonas.online",
  "http://localhost:8000",
  "http://localhost:5500",
  "http://127.0.0.1:8000",
  "http://127.0.0.1:5500",
]);

function corsHeaders(origin: string): HeadersInit {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://mypersonas.online",
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(origin: string, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json" },
  });
}

function composeContent(draft: {
  title?: string | null;
  body?: string | null;
  tags?: string | null;
  media_url?: string | null;
}): string {
  const parts: string[] = [];
  const title = (draft.title || "").trim();
  const body = (draft.body || "").trim();
  const tags = (draft.tags || "").trim();
  const media = (draft.media_url || "").trim();
  if (title) parts.push(`**${title}**`);
  if (body) parts.push(body);
  if (tags) parts.push(tags);
  if (media && /^https:\/\/[^\s]+$/i.test(media)) parts.push(media);
  let content = parts.join("\n\n").trim();
  if (content.length > DISCORD_CONTENT_LIMIT) {
    content = content.slice(0, DISCORD_CONTENT_LIMIT - 1).trimEnd() + "…";
  }
  return content;
}

serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json(origin, 405, { error: "POST only" });
  if (!DISCORD_POST_RELEASE_ENABLED) {
    return json(origin, 503, {
      status: "disabled",
      error: "Discord publishing is dormant while its exact approval, reconciliation, and erasure safeguards are rebuilt.",
    });
  }

  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    return json(origin, 401, { error: "Sign in again before publishing" });
  }
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userError } = await userClient.auth.getUser();
  const uid = userData?.user?.id || "";
  if (userError || !uid) return json(origin, 401, { error: "Sign in again before publishing" });

  let draftId = "";
  try {
    const body = await req.json();
    draftId = String(body?.draftId || "");
  } catch (_e) {
    return json(origin, 400, { error: "Invalid request body" });
  }
  if (!/^[0-9a-f-]{36}$/i.test(draftId)) return json(origin, 400, { error: "A draft id is required" });

  const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: settings } = await service
    .from("agent_settings").select("automation_paused").eq("owner", uid).maybeSingle();
  if (settings?.automation_paused) {
    return json(origin, 409, { error: "The global automation pause is on. Resume it before publishing." });
  }

  const { data: draft, error: draftError } = await service
    .from("drafts")
    .select("id,owner,persona_id,account_id,platform,title,body,tags,media_url,approval_state,publish_state")
    .eq("id", draftId).eq("owner", uid).maybeSingle();
  if (draftError || !draft) return json(origin, 404, { error: "Owned draft not found" });
  if (!draft.account_id || draft.platform !== "discord") {
    return json(origin, 409, { error: "This draft is not assigned to a Discord account" });
  }
  if ((draft.approval_state || "draft") !== "approved") {
    return json(origin, 409, { error: "Approve this exact draft before publishing it to Discord" });
  }
  if (["publishing", "published"].includes(draft.publish_state || "")) {
    return json(origin, 409, { error: "This draft is already publishing or published" });
  }

  const { data: ledger } = await service
    .from("account_ledger").select("id,owner,provider,persona_id")
    .eq("id", draft.account_id).eq("owner", uid).eq("provider", "discord").maybeSingle();
  if (!ledger) return json(origin, 409, { error: "The Discord account for this draft is no longer in your ledger" });
  if (draft.persona_id && ledger.persona_id !== draft.persona_id) {
    // Shared co-managers (migration 020) may also publish through this account.
    const { data: shareLink } = await service
      .from("account_persona_links").select("ledger_id")
      .eq("ledger_id", ledger.id).eq("persona_id", draft.persona_id).eq("owner", uid).maybeSingle();
    if (!shareLink) {
      return json(origin, 409, { error: "That Discord account is no longer assigned to this draft's persona" });
    }
  }

  const { data: connection } = await service
    .from("account_connections").select("ledger_id,connection_state,verification_method")
    .eq("ledger_id", ledger.id).eq("owner", uid).maybeSingle();
  if (!connection || connection.connection_state !== "connected" || connection.verification_method !== "discord_webhook") {
    return json(origin, 409, { error: "Connect this Discord account's channel webhook first" });
  }

  const { data: webhookUrl, error: webhookError } = await service
    .rpc("discord_get_webhook_service", { p_ledger_id: ledger.id });
  if (webhookError || !webhookUrl) {
    return json(origin, 409, { error: "The stored webhook could not be read. Reconnect the webhook." });
  }

  const content = composeContent(draft);
  if (!content) return json(origin, 409, { error: "This draft has no text to post" });

  // Atomic lease: only one caller may move the draft into publishing.
  const { data: leased } = await service
    .from("drafts")
    .update({ publish_state: "publishing", publish_error: "" })
    .eq("id", draft.id).eq("owner", uid)
    .not("publish_state", "in", '("publishing","published")')
    .select("id");
  if (!leased || !leased.length) {
    return json(origin, 409, { error: "This draft is already being published" });
  }

  let messageId = "", channelId = "", failure = "";
  try {
    const response = await fetch(`${webhookUrl}?wait=true`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
    });
    if (response.ok) {
      const message = await response.json().catch(() => ({}));
      messageId = String(message?.id || "");
      channelId = String(message?.channel_id || "");
    } else if (response.status === 404 || response.status === 401) {
      failure = "Discord rejected the webhook (deleted or revoked). Reconnect a current webhook.";
    } else if (response.status === 429) {
      failure = "Discord rate-limited this webhook. Try again in a minute.";
    } else {
      failure = `Discord returned HTTP ${response.status}`;
    }
  } catch (_e) {
    failure = "Discord could not be reached";
  }

  if (failure) {
    await service.from("drafts")
      .update({ publish_state: "failed", publish_error: failure })
      .eq("id", draft.id).eq("owner", uid).eq("publish_state", "publishing");
    return json(origin, 502, { error: failure });
  }

  await service.from("drafts")
    .update({ publish_state: "published", publish_error: "" })
    .eq("id", draft.id).eq("owner", uid).eq("publish_state", "publishing");
  return json(origin, 200, { published: true, messageId, channelId });
});
