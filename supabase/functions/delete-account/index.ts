// delete-account — full GDPR/CCPA account erasure. The browser can delete the
// user's content, but only the service role can remove the auth.users + profiles
// rows. This closes the deletion gap flagged in VERIFICATION.md.
//
// The caller must send their JWT AND confirm=true. Deletes all owned data, storage
// objects, the profile row, then the auth user itself.
//
// Deploy:  supabase functions deploy delete-account
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);
const cors = (req: Request) => {
  const o = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED.has(o) ? o : "https://aliaspaces.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
};

async function revokeGoogleToken(token: string) {
  try {
    const response = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    if (response.ok) return true;
    const failure = await response.json().catch(() => ({})) as { error?: string };
    return failure.error === "invalid_token";
  } catch {
    return false;
  }
}

serve(async (req) => {
  const CORS = cors(req);
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
  if (!jwt) return json({ error: "missing auth" }, 401);
  let body: { confirm?: boolean };
  try { body = await req.json(); } catch { body = {}; }
  if (body.confirm !== true) return json({ error: "confirm:true required" }, 400);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: u, error: uErr } = await admin.auth.getUser(jwt);
  if (uErr || !u?.user) return json({ error: "invalid session" }, 401);
  const uid = u.user.id;

  // Revoke Gmail grants before deleting anything. The database blocks ledger
  // deletion while a Vault credential still exists so an external grant can
  // never be orphaned by account erasure.
  const { data: gmailLedgers, error: gmailListError } = await admin.from("account_ledger")
    .select("id")
    .eq("owner", uid)
    .eq("provider", "gmail");
  if (gmailListError) return json({ error: "could not inspect Gmail connections" }, 500);
  for (const ledger of gmailLedgers || []) {
    const { data: credential, error: credentialLookupError } = await admin.from("gmail_credentials")
      .select("ledger_id")
      .eq("ledger_id", ledger.id)
      .eq("owner", uid)
      .maybeSingle();
    if (credentialLookupError) return json({ error: "could not inspect a stored Gmail authorization" }, 500);
    if (!credential) continue;
    const { data: refreshToken, error: tokenError } = await admin.rpc("gmail_get_refresh_token", {
      p_ledger_id: ledger.id,
      p_owner: uid,
    });
    if (tokenError || typeof refreshToken !== "string" || !refreshToken) {
      return json({ error: "could not read a stored Gmail authorization safely" }, 500);
    }
    if (!await revokeGoogleToken(refreshToken)) {
      return json({ error: "Google did not confirm Gmail revocation; account deletion stopped, but earlier Gmail grants in this request may already have been revoked" }, 502);
    }
    const { error: credentialError } = await admin.rpc("gmail_delete_refresh_token", {
      p_ledger_id: ledger.id,
      p_owner: uid,
    });
    if (credentialError) return json({ error: "could not remove a stored Gmail authorization" }, 500);
  }

  // Personas cascade to posts/albums/links/notes via FK. Delete the rest explicitly.
  const { data: myPersonas } = await admin.from("personas").select("id").eq("owner", uid);
  const personaIds = (myPersonas || []).map((p: any) => p.id);

  await admin.from("ai_tasks").delete().eq("owner", uid);
  await admin.from("ai_backends").delete().eq("owner", uid);
  await admin.from("drafts").delete().eq("owner", uid);
  await admin.from("account_ledger").delete().eq("owner", uid);
  await admin.from("blocks").delete().eq("blocker", uid);
  if (personaIds.length) {
    // follows reference personas; remove any where this owner's persona is follower or target
    await admin.from("follows").delete().in("follower", personaIds);
    await admin.from("follows").delete().in("target", personaIds);
  }
  await admin.from("personas").delete().eq("owner", uid); // cascades child rows

  // Storage: remove the user's media folder (uid/*).
  try {
    const { data: files } = await admin.storage.from("media").list(uid, { limit: 1000 });
    if (files?.length) {
      await admin.storage.from("media").remove(files.map((f: any) => `${uid}/${f.name}`));
    }
  } catch (_) { /* bucket empty or missing — ignore */ }

  // profiles has no client delete policy; service role removes it, then the auth user.
  await admin.from("profiles").delete().eq("id", uid);
  const { error: delErr } = await admin.auth.admin.deleteUser(uid);
  if (delErr) return json({ error: "data removed but auth deletion failed: " + delErr.message }, 500);

  return json({ deleted: true });
});
