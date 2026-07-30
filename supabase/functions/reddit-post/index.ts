// reddit-post — publish one approved draft through the owner's connected
// Reddit account (official OAuth API, scope "submit").
//
// Frontend contract (POST, signed-in user's Supabase bearer token required):
//   { draftId } -> { published:true, url, fullname } | { error }
//
// Destination rule: if the draft's tags contain "r/<subreddit>", the post goes
// to that subreddit; otherwise it posts to the account's own profile
// (u_<username>). Link posts are used when the draft has a media URL and no
// body text; otherwise a self/text post.
//
// Same guard order as discord-post: global pause → owned approved non-terminal
// draft → Discord/Reddit account + share-aware persona check → connected state
// → atomic publishing lease → provider call → published/failed with a
// human-readable reason. Tokens come from Vault via service-role RPCs and are
// refreshed once on expiry.
//
// Deploy with default gateway JWT verification:
//   supabase functions deploy reddit-post
// Required secrets: REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET (for refresh).
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const REDDIT_CLIENT_ID = Deno.env.get("REDDIT_CLIENT_ID") || "";
const REDDIT_CLIENT_SECRET = Deno.env.get("REDDIT_CLIENT_SECRET") || "";
const APP_ORIGIN = Deno.env.get("REDDIT_OAUTH_APP_ORIGIN") || "https://mypersonas.online";
const USER_AGENT = "web:online.mypersonas:v0.5 (MyPersonas publisher)";

function corsHeaders(origin: string): HeadersInit {
  const allowed = new Set([APP_ORIGIN, "http://localhost:8000", "http://127.0.0.1:8000"]);
  return {
    "Access-Control-Allow-Origin": allowed.has(origin) ? origin : APP_ORIGIN,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(origin: string, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
}
function normalizeUsername(v: string): string {
  return (v || "").normalize("NFKC").trim().toLowerCase().replace(/^\/?u\//, "").replace(/^@/, "");
}
function pickSubreddit(tags: string, username: string): string {
  const match = (tags || "").match(/(?:^|[\s,])r\/([A-Za-z0-9_]{2,21})/);
  return match ? match[1] : `u_${username}`;
}

serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin) });
  if (req.method !== "POST") return json(origin, 405, { error: "POST only" });

  const authorization = req.headers.get("Authorization") || "";
  if (!authorization.startsWith("Bearer ")) return json(origin, 401, { error: "Sign in again before publishing" });
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } }, auth: { persistSession: false },
  });
  const { data: userData } = await userClient.auth.getUser();
  const uid = userData?.user?.id || "";
  if (!uid) return json(origin, 401, { error: "Sign in again before publishing" });

  let draftId = "";
  try { draftId = String((await req.json())?.draftId || ""); }
  catch (_e) { return json(origin, 400, { error: "Invalid request body" }); }
  if (!/^[0-9a-f-]{36}$/i.test(draftId)) return json(origin, 400, { error: "A draft id is required" });

  const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: settings } = await service.from("agent_settings").select("automation_paused").eq("owner", uid).maybeSingle();
  if (settings?.automation_paused) return json(origin, 409, { error: "The global automation pause is on. Resume it before publishing." });

  const { data: draft } = await service.from("drafts")
    .select("id,owner,persona_id,account_id,platform,title,body,tags,media_url,approval_state,publish_state")
    .eq("id", draftId).eq("owner", uid).maybeSingle();
  if (!draft) return json(origin, 404, { error: "Owned draft not found" });
  if (!draft.account_id || draft.platform !== "reddit") return json(origin, 409, { error: "This draft is not assigned to a Reddit account" });
  if ((draft.approval_state || "draft") !== "approved") return json(origin, 409, { error: "Approve this exact draft before publishing it to Reddit" });
  if (["publishing", "published"].includes(draft.publish_state || "")) return json(origin, 409, { error: "This draft is already publishing or published" });

  const { data: ledger } = await service.from("account_ledger")
    .select("id,owner,provider,persona_id,username")
    .eq("id", draft.account_id).eq("owner", uid).eq("provider", "reddit").maybeSingle();
  if (!ledger) return json(origin, 409, { error: "The Reddit account for this draft is no longer in your ledger" });
  if (draft.persona_id && ledger.persona_id !== draft.persona_id) {
    const { data: shareLink } = await service.from("account_persona_links").select("ledger_id")
      .eq("ledger_id", ledger.id).eq("persona_id", draft.persona_id).eq("owner", uid).maybeSingle();
    if (!shareLink) return json(origin, 409, { error: "That Reddit account is no longer assigned to this draft's persona" });
  }
  const username = normalizeUsername(ledger.username || "");
  if (!username) return json(origin, 409, { error: "This Reddit record has no username" });

  const { data: connection } = await service.from("account_connections")
    .select("ledger_id,connection_state,verification_method,granted_scopes")
    .eq("ledger_id", ledger.id).eq("owner", uid).maybeSingle();
  if (!connection || connection.connection_state !== "connected" || connection.verification_method !== "reddit_oauth") {
    return json(origin, 409, { error: "Connect this Reddit account with the official authorization first" });
  }
  const scopes = Array.isArray(connection.granted_scopes) ? connection.granted_scopes : [];
  if (!scopes.includes("submit")) return json(origin, 409, { error: "This Reddit grant has no submit permission. Reconnect the account." });

  const { data: tokenRows, error: tokenError } = await service.rpc("reddit_get_tokens_service", { p_ledger_id: ledger.id });
  const tokenRow = Array.isArray(tokenRows) ? tokenRows[0] : tokenRows;
  let accessToken = String(tokenRow?.access_token || "");
  const refreshToken = String(tokenRow?.refresh_token || "");
  if (tokenError || !accessToken) return json(origin, 409, { error: "Stored Reddit access could not be read. Reconnect the account." });

  const title = (draft.title || "").trim() || (draft.body || "").trim().slice(0, 250) || "Untitled post";
  const media = (draft.media_url || "").trim();
  const bodyText = [(draft.body || "").trim(), (draft.tags || "").trim()].filter(Boolean).join("\n\n");
  const isLink = Boolean(media && /^https:\/\/[^\s]+$/i.test(media) && !(draft.body || "").trim());
  const subreddit = pickSubreddit(draft.tags || "", username);

  // Atomic lease.
  const { data: leased } = await service.from("drafts")
    .update({ publish_state: "publishing", publish_error: "" })
    .eq("id", draft.id).eq("owner", uid)
    .not("publish_state", "in", '("publishing","published")').select("id");
  if (!leased || !leased.length) return json(origin, 409, { error: "This draft is already being published" });

  async function submit(token: string): Promise<Response> {
    const form = new URLSearchParams({
      api_type: "json", sr: subreddit, title: title.slice(0, 300),
      kind: isLink ? "link" : "self", sendreplies: "true",
    });
    if (isLink) form.set("url", media); else form.set("text", bodyText);
    return fetch("https://oauth.reddit.com/api/submit", {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT },
      body: form,
    });
  }

  let response = await submit(accessToken);
  if (response.status === 401 && refreshToken && REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET) {
    const refreshResponse = await fetch("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + btoa(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`),
        "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
    });
    const refreshed = await refreshResponse.json().catch(() => ({}));
    if (refreshResponse.ok && refreshed.access_token) {
      accessToken = String(refreshed.access_token);
      const expiresAt = new Date(Date.now() + Math.max(60, Number(refreshed.expires_in || 3600)) * 1000).toISOString();
      await service.rpc("reddit_update_access_token_service", {
        p_ledger_id: ledger.id, p_access_token: accessToken, p_expires_at: expiresAt,
      });
      response = await submit(accessToken);
    }
  }

  let failure = "", postUrl = "", fullname = "";
  if (!response.ok) {
    failure = response.status === 401
      ? "Reddit access expired and could not refresh. Reconnect the account."
      : response.status === 429
        ? "Reddit rate-limited this account. Try again later."
        : `Reddit returned HTTP ${response.status}`;
  } else {
    const result = await response.json().catch(() => ({}));
    const errors = result?.json?.errors;
    if (Array.isArray(errors) && errors.length) {
      failure = errors.map((e: unknown[]) => (Array.isArray(e) ? e.slice(0, 2).join(": ") : String(e))).join("; ").slice(0, 400);
    } else {
      postUrl = String(result?.json?.data?.url || "");
      fullname = String(result?.json?.data?.name || "");
    }
  }

  if (failure) {
    await service.from("drafts").update({ publish_state: "failed", publish_error: failure })
      .eq("id", draft.id).eq("owner", uid).eq("publish_state", "publishing");
    return json(origin, 502, { error: failure });
  }
  await service.from("drafts").update({ publish_state: "published", publish_error: "" })
    .eq("id", draft.id).eq("owner", uid).eq("publish_state", "publishing");
  return json(origin, 200, { published: true, url: postUrl, fullname });
});
