// delete-account — complete content erasure or full account erasure.
// The caller must send their JWT and confirm=true. keepAccount=true removes
// owned content, encrypted credentials, and media while retaining auth access.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import {
  createClient,
  type SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);
const cors = (req: Request) => {
  const o = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED.has(o)
      ? o
      : "https://aliaspaces.com",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
};

type DbError = { message: string };
type DeleteResult = { error: DbError | null };
type StorageEntry = {
  id?: string | null;
  name: string;
  metadata?: unknown;
};

async function checked(
  label: string,
  operation: PromiseLike<DeleteResult>,
) {
  const { error } = await operation;
  if (error) throw new Error(`${label}: ${error.message}`);
}

async function revokeGoogleToken(token: string) {
  try {
    const response = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    });
    if (response.ok) return true;
    const failure = await response.json().catch(() => ({})) as {
      error?: string;
    };
    return failure.error === "invalid_token";
  } catch {
    return false;
  }
}

async function listMediaFiles(
  admin: SupabaseClient,
  prefix: string,
  visited = new Set<string>(),
): Promise<string[]> {
  if (visited.has(prefix)) return [];
  visited.add(prefix);
  const files: string[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await admin.storage.from("media").list(prefix, {
      limit: 1000,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(`media listing: ${error.message}`);
    const entries = (data || []) as StorageEntry[];
    for (const entry of entries) {
      if (!entry.name) continue;
      const path = `${prefix}/${entry.name}`;
      if (entry.id || entry.metadata) files.push(path);
      else files.push(...await listMediaFiles(admin, path, visited));
    }
    if (entries.length < 1000) break;
    offset += entries.length;
  }
  return files;
}

async function eraseMedia(admin: SupabaseClient, uid: string) {
  for (let pass = 0; pass < 3; pass++) {
    const files = await listMediaFiles(admin, uid);
    if (!files.length) return;
    for (let start = 0; start < files.length; start += 500) {
      const { error } = await admin.storage.from("media").remove(
        files.slice(start, start + 500),
      );
      if (error) throw new Error(`media removal: ${error.message}`);
    }
  }
  if ((await listMediaFiles(admin, uid)).length) {
    throw new Error("media removal could not be verified");
  }
}

async function listOwnedPersonaIds(admin: SupabaseClient, uid: string) {
  const ids: string[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await admin.from("personas").select("id")
      .eq("owner", uid).order("id").range(from, from + 499);
    if (error) throw new Error(`persona inventory: ${error.message}`);
    const page = (data || []) as Array<{ id: string }>;
    ids.push(...page.map((row) => row.id));
    if (page.length < 500) return ids;
    from += page.length;
  }
}

async function listGmailLedgers(admin: SupabaseClient, uid: string) {
  const ledgers: Array<{ id: string }> = [];
  let from = 0;
  for (;;) {
    const { data, error } = await admin.from("account_ledger").select("id")
      .eq("owner", uid).eq("provider", "gmail").order("id")
      .range(from, from + 499);
    if (error) throw new Error(`Gmail connection inventory: ${error.message}`);
    const page = (data || []) as Array<{ id: string }>;
    ledgers.push(...page);
    if (page.length < 500) return ledgers;
    from += page.length;
  }
}

function isOpenRouterBackend(row: {
  provider?: string | null;
  base_url?: string | null;
}) {
  if ((row.provider || "").trim().toLowerCase().includes("openrouter")) {
    return true;
  }
  try {
    const url = new URL((row.base_url || "").trim());
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    return url.protocol === "https:" &&
      (host === "openrouter.ai" || host.endsWith(".openrouter.ai"));
  } catch {
    return false;
  }
}

async function ownerHasOpenRouterBackend(admin: SupabaseClient, uid: string) {
  let from = 0;
  for (;;) {
    const { data, error } = await admin.from("ai_backends")
      .select("provider,base_url").eq("owner", uid).order("id")
      .range(from, from + 499);
    if (error) throw new Error("could not inspect provider-managed model keys");
    const page = (data || []) as Array<{
      provider?: string | null;
      base_url?: string | null;
    }>;
    if (page.some(isOpenRouterBackend)) return true;
    if (page.length < 500) return false;
    from += page.length;
  }
}

async function revokeGmail(admin: SupabaseClient, uid: string) {
  const gmailLedgers = await listGmailLedgers(admin, uid);
  for (const ledger of gmailLedgers) {
    const { data: credential, error: credentialLookupError } = await admin
      .from("gmail_credentials").select("ledger_id").eq("ledger_id", ledger.id)
      .eq("owner", uid).maybeSingle();
    if (credentialLookupError) {
      throw new Error("could not inspect a stored Gmail authorization");
    }
    if (!credential) continue;
    const { data: refreshToken, error: tokenError } = await admin.rpc(
      "gmail_get_refresh_token",
      { p_ledger_id: ledger.id, p_owner: uid },
    );
    if (tokenError || typeof refreshToken !== "string" || !refreshToken) {
      throw new Error("could not read a stored Gmail authorization safely");
    }
    if (!await revokeGoogleToken(refreshToken)) {
      throw new Error(
        "Google did not confirm Gmail revocation; earlier Gmail grants in this request may already have been revoked",
      );
    }
    const { data: removed, error: credentialError } = await admin.rpc(
      "gmail_delete_refresh_token",
      { p_ledger_id: ledger.id, p_owner: uid },
    );
    if (credentialError || removed !== true) {
      throw new Error("could not remove a stored Gmail authorization");
    }
  }
}

async function eraseOwnedRows(
  admin: SupabaseClient,
  uid: string,
  personaIds: string[],
) {
  await checked(
    "fan chats",
    admin.from("fan_chat_sessions").delete().eq("owner", uid),
  );
  await checked(
    "owner chats",
    admin.from("agent_messages").delete().eq("owner", uid),
  );
  await checked(
    "agent usage",
    admin.from("agent_daily_usage").delete().eq("owner", uid),
  );
  await checked(
    "content plans",
    admin.from("persona_content_plans").delete().eq("owner", uid),
  );
  await checked(
    "agent targets",
    admin.from("agent_destinations").delete().eq("owner", uid),
  );
  await checked(
    "agent audit",
    admin.from("agent_actions").delete().eq("owner", uid),
  );
  await checked(
    "agent bindings",
    admin.from("agent_bindings").delete().eq("owner", uid),
  );
  await checked(
    "agent settings",
    admin.from("agent_owner_settings").delete().eq("owner", uid),
  );
  await checked("drafts", admin.from("drafts").delete().eq("owner", uid));
  await checked("schedules", admin.from("ai_tasks").delete().eq("owner", uid));
  await checked(
    "model credentials",
    admin.from("ai_backends").delete().eq("owner", uid),
  );
  await checked(
    "pending Gmail sign-ins",
    admin.from("gmail_oauth_transactions").delete().eq("owner", uid),
  );
  await checked(
    "account ledger",
    admin.from("account_ledger").delete().eq("owner", uid),
  );
  await checked("blocks", admin.from("blocks").delete().eq("blocker", uid));
  for (let start = 0; start < personaIds.length; start += 100) {
    const batch = personaIds.slice(start, start + 100);
    await checked(
      "outgoing follows",
      admin.from("follows").delete().in("follower", batch),
    );
    await checked(
      "incoming follows",
      admin.from("follows").delete().in("target", batch),
    );
  }
  await checked(
    "personas and posts",
    admin.from("personas").delete().eq("owner", uid),
  );
  await checked(
    "error reports",
    admin.from("error_logs").delete().eq("user_id", uid),
  );
}

export function createErasureHandler(
  options: { contentOnly: boolean } = { contentOnly: false },
) {
  return async (req: Request) => {
    const CORS = cors(req);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!jwt) return json({ error: "missing auth" }, 401);
    let body: {
      action?: string;
      confirm?: boolean;
      keepAccount?: boolean;
      protocolVersion?: number;
      externalRevocationsAcknowledged?: boolean;
    };
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    if (body.action === "capabilities") {
      return json({
        protocolVersion: 2,
        keepAccount: true,
        fullAccount: !options.contentOnly,
        contentOnly: options.contentOnly,
      });
    }
    if (body.confirm !== true || body.protocolVersion !== 2) {
      return json(
        { error: "confirm:true and protocolVersion:2 required" },
        400,
      );
    }
    if (options.contentOnly && body.keepAccount !== true) {
      return json(
        { error: "erase-content always retains the sign-in account" },
        400,
      );
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData?.user) {
      return json({ error: "invalid session" }, 401);
    }
    const uid = userData.user.id;

    try {
      if (
        await ownerHasOpenRouterBackend(admin, uid) &&
        body.externalRevocationsAcknowledged !== true
      ) {
        return json({
          error:
            "Revoke every OpenRouter key used here at OpenRouter, then acknowledge that step before local erasure.",
          requiredExternalRevocations: ["openrouter"],
        }, 409);
      }
      const personaIds = await listOwnedPersonaIds(admin, uid);
      await revokeGmail(admin, uid);
      await eraseMedia(admin, uid);
      await eraseOwnedRows(admin, uid, personaIds);

      if (body.keepAccount === true) {
        await checked(
          "account preferences",
          admin.from("profiles").update({ display_name: null, prefs: {} }).eq(
            "id",
            uid,
          ),
        );
        return json({ deleted: true, accountDeleted: false });
      }

      await checked("profile", admin.from("profiles").delete().eq("id", uid));
      const { error: deleteUserError } = await admin.auth.admin.deleteUser(uid);
      if (deleteUserError) {
        return json({
          error: "content removed but sign-in deletion failed: " +
            deleteUserError.message,
        }, 500);
      }
      return json({ deleted: true, accountDeleted: true });
    } catch (error) {
      return json({
        error: "Deletion stopped and may be partially complete: " +
          (error instanceof Error ? error.message : "unknown error"),
      }, 500);
    }
  };
}

if (import.meta.main) serve(createErasureHandler());
