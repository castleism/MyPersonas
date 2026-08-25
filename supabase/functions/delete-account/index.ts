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
const X_LOCAL_RESET_ERROR_CODES = new Set([
  "twitter_already_connected",
  "shared_grant_cleanup_failed",
  "local_credential_cleanup_failed",
]);
const X_NO_PROVIDER_GRANT_ERROR_CODES = new Set([
  "x_access_denied",
  "x_oauth_error",
  "missing_authorization_code",
  "x_token_exchange_failed",
]);
const META_MANUAL_REVOCATION_URL =
  "https://www.facebook.com/settings?tab=business_tools";
const META_OWNER_ERASURE_TTL_SECONDS = 3600;
const REDDIT_USER_AGENT =
  "web:online.mypersonas:v0.5 (MyPersonas account erasure)";
const META_GRAPH_API_VERSION = /^v[0-9]+\.[0-9]+$/.test(
    Deno.env.get("META_GRAPH_API_VERSION") || "",
  )
  ? Deno.env.get("META_GRAPH_API_VERSION")!
  : "v25.0";
const cors = (req: Request) => {
  const o = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED.has(o) ? o : "",
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

type OwnedStorageTarget = {
  bucket: string;
  prefix: string;
};

async function checked(
  label: string,
  operation: PromiseLike<DeleteResult>,
) {
  const { error } = await operation;
  if (error) throw new Error(`${label}: ${error.message}`);
}

async function renewMetaOwnerErasure(
  admin: SupabaseClient,
  uid: string,
  leaseId: string,
  phase: string,
) {
  const { data, error } = await admin.rpc("renew_meta_owner_erasure", {
    p_owner: uid,
    p_lease_id: leaseId,
    p_ttl_seconds: META_OWNER_ERASURE_TTL_SECONDS,
  });
  if (error || data !== true) {
    throw new Error(
      `the Meta owner-erasure lease expired before ${phase}; retry after the active lease clears`,
    );
  }
}

async function withMetaOwnerErasureRelease<T>(
  admin: SupabaseClient,
  uid: string,
  leaseId: string,
  work: () => Promise<T>,
): Promise<T> {
  let result: T | undefined;
  let workError: unknown;
  let releaseFailed = false;
  try {
    result = await work();
  } catch (error) {
    workError = error;
  } finally {
    try {
      const { data, error } = await admin.rpc("release_meta_owner_erasure", {
        p_owner: uid,
        p_lease_id: leaseId,
      });
      releaseFailed = Boolean(error) || data !== true;
    } catch {
      releaseFailed = true;
    }
  }
  if (releaseFailed) {
    const prior = workError instanceof Error ? `${workError.message}; ` : "";
    throw new Error(
      `${prior}the exact Meta owner-erasure lease could not be released; retry after its safety timeout`,
    );
  }
  if (workError) throw workError;
  return result as T;
}

async function revokeGoogleToken(token: string) {
  try {
    const response = await fetch("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
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

async function revokeXToken(
  token: string,
  clientId: string,
  clientSecret: string,
) {
  try {
    const response = await fetch("https://api.x.com/2/oauth2/revoke", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function xAccessTokenConfirmedInvalid(accessToken: string) {
  if (!accessToken) return false;
  try {
    const response = await fetch("https://api.x.com/2/users/me", {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    return response.status === 401;
  } catch {
    return false;
  }
}

async function revokeXGrantPair(
  refreshToken: string,
  accessToken: string,
  clientId: string,
  clientSecret: string,
) {
  if (!refreshToken || !accessToken) return false;
  if (!await revokeXToken(refreshToken, clientId, clientSecret)) return false;
  if (await revokeXToken(accessToken, clientId, clientSecret)) return true;
  return await xAccessTokenConfirmedInvalid(accessToken);
}

async function revokeRedditRefreshToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
) {
  try {
    const response = await fetch(
      "https://www.reddit.com/api/v1/revoke_token",
      {
        method: "POST",
        headers: {
          "Authorization": `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": REDDIT_USER_AGENT,
        },
        body: new URLSearchParams({
          token: refreshToken,
          token_type_hint: "refresh_token",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function metaAppSecretProof(accessToken: string, appSecret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(accessToken),
    ),
  );
  return [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function revokeMetaPermissions(
  metaUserId: string,
  accessToken: string,
  appSecret: string,
) {
  if (
    !/^[0-9]{1,64}$/.test(metaUserId) ||
    !accessToken ||
    accessToken.length > 16_384 ||
    !appSecret
  ) {
    return false;
  }
  try {
    const url = new URL(
      `https://graph.facebook.com/${META_GRAPH_API_VERSION}/${metaUserId}/permissions`,
    );
    url.searchParams.set(
      "appsecret_proof",
      await metaAppSecretProof(accessToken, appSecret),
    );
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null) as
      | { success?: boolean }
      | boolean
      | null;
    return payload === true ||
      Boolean(payload && typeof payload === "object" && payload.success);
  } catch {
    return false;
  }
}

async function listStorageFiles(
  admin: SupabaseClient,
  bucket: string,
  prefix: string,
  visited = new Set<string>(),
): Promise<string[]> {
  if (visited.has(prefix)) return [];
  visited.add(prefix);
  const files: string[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await admin.storage.from(bucket).list(prefix, {
      limit: 1000,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) throw new Error(`${bucket} storage listing: ${error.message}`);
    const entries = (data || []) as StorageEntry[];
    for (const entry of entries) {
      if (!entry.name) continue;
      const path = `${prefix}/${entry.name}`;
      if (entry.id || entry.metadata) files.push(path);
      else files.push(
        ...await listStorageFiles(admin, bucket, path, visited),
      );
    }
    if (entries.length < 1000) break;
    offset += entries.length;
  }
  return files;
}

async function eraseStoragePrefix(
  admin: SupabaseClient,
  { bucket, prefix }: OwnedStorageTarget,
) {
  for (let pass = 0; pass < 3; pass++) {
    const files = await listStorageFiles(admin, bucket, prefix);
    if (!files.length) return;
    for (let start = 0; start < files.length; start += 500) {
      const { error } = await admin.storage.from(bucket).remove(
        files.slice(start, start + 500),
      );
      if (error) {
        throw new Error(`${bucket} storage removal: ${error.message}`);
      }
    }
  }
  if ((await listStorageFiles(admin, bucket, prefix)).length) {
    throw new Error(`${bucket} storage removal could not be verified`);
  }
}

async function revokeApprovedMediaDelivery(
  admin: SupabaseClient,
  uid: string,
) {
  const revoked = await admin.rpc(
    "revoke_post_approved_media_owner_service",
    { p_owner: uid },
  );
  if (revoked.error || !Number.isSafeInteger(Number(revoked.data)) ||
    Number(revoked.data) < 0) {
    throw new Error(
      `approved-media delivery revocation: ${revoked.error?.message || "invalid verification result"}`,
    );
  }
  const remaining = await admin.from("post_approved_media_handles")
    .select("public_id", { count: "exact", head: true })
    .eq("owner", uid).eq("state", "active");
  if (remaining.error || remaining.count !== 0) {
    throw new Error(
      `approved-media delivery revocation verification: ${remaining.error?.message || "active handles remain"}`,
    );
  }
}

async function revokePersonaMediaDelivery(
  admin: SupabaseClient,
  uid: string,
) {
  const revoked = await admin.rpc(
    "revoke_persona_public_media_owner_service_065",
    { p_owner: uid },
  );
  if (revoked.error || !Number.isSafeInteger(Number(revoked.data)) ||
    Number(revoked.data) < 0) {
    throw new Error(
      `persona-media delivery revocation: ${revoked.error?.message || "invalid verification result"}`,
    );
  }
  const remaining = await admin.from("persona_public_media_handles")
    .select("public_id", { count: "exact", head: true })
    .eq("owner", uid).eq("state", "active");
  if (remaining.error || remaining.count !== 0) {
    throw new Error(
      `persona-media delivery revocation verification: ${remaining.error?.message || "active handles remain"}`,
    );
  }
}

async function armPersonaMediaErasureCooldown(
  admin: SupabaseClient,
  uid: string,
  leaseId: string,
) {
  const armed = await admin.rpc(
    "arm_persona_media_erasure_tombstone_service_065",
    { p_owner: uid, p_lease_id: leaseId },
  );
  if (armed.error || armed.data !== true) {
    throw new Error(
      `persona-media late-write cooldown: ${armed.error?.message || "could not be verified"}`,
    );
  }
}

async function eraseOwnedStorage(admin: SupabaseClient, uid: string) {
  const normalizedOwner = uid.toLowerCase();
  const targets: OwnedStorageTarget[] = [
    { bucket: "media", prefix: normalizedOwner },
    { bucket: "persona-media", prefix: normalizedOwner },
    { bucket: "persona-docs", prefix: normalizedOwner },
    {
      bucket: "post-approved-media",
      prefix: `owners/${normalizedOwner}`,
    },
  ];
  const { data: buckets, error } = await admin.storage.listBuckets();
  if (error) {
    throw new Error(`owned storage bucket inventory: ${error.message}`);
  }
  const existingBuckets = new Set(
    (buckets || []).map((bucket) => bucket.id),
  );
  for (const target of targets) {
    if (existingBuckets.has(target.bucket)) {
      await eraseStoragePrefix(admin, target);
    }
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

async function listTwitterLedgers(admin: SupabaseClient, uid: string) {
  const ledgers: Array<{ id: string }> = [];
  let from = 0;
  for (;;) {
    const { data, error } = await admin.from("account_ledger").select("id")
      .eq("owner", uid).eq("provider", "twitter").order("id")
      .range(from, from + 499);
    if (error) throw new Error(`X connection inventory: ${error.message}`);
    const page = (data || []) as Array<{ id: string }>;
    ledgers.push(...page);
    if (page.length < 500) return ledgers;
    from += page.length;
  }
}

async function listRedditLedgers(admin: SupabaseClient, uid: string) {
  const ledgers: Array<{ id: string }> = [];
  let from = 0;
  for (;;) {
    const { data, error } = await admin.from("account_ledger").select("id")
      .eq("owner", uid).eq("provider", "reddit").order("id")
      .range(from, from + 499);
    if (error) {
      throw new Error(`Reddit connection inventory: ${error.message}`);
    }
    const page = (data || []) as Array<{ id: string }>;
    ledgers.push(...page);
    if (page.length < 500) return ledgers;
    from += page.length;
  }
}

async function eraseDiscordWebhooks(admin: SupabaseClient, uid: string) {
  const { data, error } = await admin.rpc(
    "discord_erase_webhooks_for_owner_service",
    { p_owner: uid },
  );
  if (
    error || typeof data !== "number" || !Number.isSafeInteger(data) ||
    data < 0
  ) {
    throw new Error(
      "Discord webhook erasure could not be verified; generic account-ledger cleanup was not started",
    );
  }
}

type MetaGrantRow = {
  id: string;
  meta_user_id: string;
};

type MetaCandidateRow = {
  selection_hash: string;
  meta_user_id: string;
  revocation_state:
    | "pending"
    | "revoking"
    | "provider_revoked"
    | "manual_required";
  revocation_started_at?: string | null;
};

type MetaClaimedCandidateRow = {
  selection_hash: string;
  meta_user_id: string;
  previous_revocation_state:
    | "pending"
    | "revoking"
    | "provider_revoked"
    | "manual_required";
  token_bundle?: Record<string, unknown> | string;
};

async function listMetaGrants(admin: SupabaseClient, uid: string) {
  const grants: MetaGrantRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await admin.from("meta_grants")
      .select("id,meta_user_id").eq("owner", uid).order("id")
      .range(from, from + 499);
    if (error) throw new Error("could not inspect stored Meta grants");
    const page = (data || []) as MetaGrantRow[];
    grants.push(...page);
    if (page.length < 500) return grants;
    from += page.length;
  }
}

async function getMetaCandidate(admin: SupabaseClient, uid: string) {
  const { data, error } = await admin.from("meta_oauth_candidates")
    .select(
      "selection_hash,meta_user_id,revocation_state,revocation_started_at",
    )
    .eq("owner", uid)
    .maybeSingle();
  if (error) {
    throw new Error("could not inspect pending Meta authorization cleanup");
  }
  return data as MetaCandidateRow | null;
}

function metaCandidateAccessToken(
  value: Record<string, unknown> | string | undefined,
) {
  let bundle: unknown = value;
  if (typeof bundle === "string") {
    try {
      bundle = JSON.parse(bundle);
    } catch {
      return "";
    }
  }
  if (!bundle || typeof bundle !== "object") return "";
  const token = (bundle as Record<string, unknown>).user_access_token;
  return typeof token === "string" && token.length <= 16_384
    ? token.trim()
    : "";
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

async function ownerHasAmbiguousXGrant(admin: SupabaseClient, uid: string) {
  const credentials = new Map<string, string>();
  let from = 0;
  for (;;) {
    const { data, error } = await admin.from("twitter_credentials")
      .select("ledger_id,provider_subject").eq("owner", uid).order("ledger_id")
      .range(from, from + 499);
    if (error) {
      throw new Error("could not inspect X manual-revocation state");
    }
    const page = (data || []) as Array<{
      ledger_id: string;
      provider_subject?: string | null;
    }>;
    for (const credential of page) {
      credentials.set(
        credential.ledger_id,
        (credential.provider_subject || "").trim(),
      );
    }
    if (page.length < 500) break;
    from += page.length;
  }

  const sharedGrantResetLedgers = new Set<string>();
  from = 0;
  for (;;) {
    const { data, error } = await admin.from("account_connections")
      .select("ledger_id,connection_state,error_code")
      .eq("owner", uid).eq("provider", "twitter").order("ledger_id")
      .range(from, from + 499);
    if (error) {
      throw new Error("could not inspect X manual-revocation state");
    }
    const page = (data || []) as Array<{
      ledger_id: string;
      connection_state?: string | null;
      error_code?: string | null;
    }>;
    for (const connection of page) {
      const sharedGrantReset = connection.connection_state === "error" &&
        X_LOCAL_RESET_ERROR_CODES.has(connection.error_code || "");
      if (sharedGrantReset) {
        sharedGrantResetLedgers.add(connection.ledger_id);
        continue;
      }
      if (
        connection.error_code === "x_manual_revoke_required" ||
        ((connection.connection_state === "connected" ||
          (connection.connection_state === "error" &&
            !X_NO_PROVIDER_GRANT_ERROR_CODES.has(
              connection.error_code || "",
            ))) &&
          !credentials.has(connection.ledger_id))
      ) {
        return true;
      }
    }
    if (page.length < 500) break;
    from += page.length;
  }

  for (const [ledgerId, providerSubject] of credentials) {
    if (!providerSubject && !sharedGrantResetLedgers.has(ledgerId)) return true;
  }
  return false;
}

async function ownerHasAmbiguousMetaGrant(
  admin: SupabaseClient,
  uid: string,
) {
  const [grants, candidate, manualConnections, cleanupHold] = await Promise.all(
    [
      listMetaGrants(admin, uid),
      getMetaCandidate(admin, uid),
      admin.from("account_connections").select("ledger_id")
        .eq("owner", uid)
        .eq("error_code", "meta_manual_revoke_required")
        .limit(1),
      admin.from("meta_oauth_cleanup_holds").select("owner")
        .eq("owner", uid).maybeSingle(),
    ],
  );
  if (manualConnections.error || cleanupHold.error) {
    throw new Error("could not inspect Meta manual-revocation state");
  }
  if (cleanupHold.data) return true;
  if ((manualConnections.data || []).length > 0) return true;
  if (
    candidate &&
    candidate.revocation_state === "manual_required"
  ) {
    return true;
  }
  if (
    !Deno.env.get("META_APP_SECRET") &&
    (grants.length > 0 ||
      Boolean(
        candidate && candidate.revocation_state !== "provider_revoked",
      ))
  ) {
    return true;
  }
  return false;
}

async function ownerHasMetaOwnershipInvestigation(
  admin: SupabaseClient,
  uid: string,
) {
  const { data, error } = await admin.from("meta_oauth_cleanup_holds")
    .select("owner")
    .eq("owner", uid)
    .eq("cleanup_kind", "ownership_investigation")
    .maybeSingle();
  if (error) {
    throw new Error("could not inspect Meta ownership-investigation state");
  }
  return Boolean(data);
}

async function revokeGmail(admin: SupabaseClient, uid: string) {
  const gmailLedgers = await listGmailLedgers(admin, uid);
  for (const ledger of gmailLedgers) {
    // Existing Gmail grants can predate Inbox Concierge. Seed a paused settings
    // row so erasure serializes with scans, cleanup, disconnect, and undo.
    const { error: settingsError } = await admin.from("mailbox_settings")
      .upsert({
        ledger_id: ledger.id,
        owner: uid,
        provider: "gmail",
      }, { onConflict: "ledger_id", ignoreDuplicates: true });
    if (settingsError) {
      throw new Error("could not establish the Gmail erasure safety lock");
    }

    const leaseId = crypto.randomUUID();
    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_mailbox_operation",
      {
        p_ledger_id: ledger.id,
        p_owner: uid,
        p_lease_id: leaseId,
        p_operation: "erase",
        p_ttl_seconds: 180,
      },
    );
    if (claimError || claimed !== true) {
      throw new Error(
        "another Gmail inbox operation is in progress; wait and retry deletion",
      );
    }

    let operationError: unknown = null;
    let releaseFailed = false;
    try {
      const { error: pauseError } = await admin.from("mailbox_settings").update(
        {
          paused: true,
          next_scan_at: null,
          updated_at: new Date().toISOString(),
        },
      ).eq("ledger_id", ledger.id).eq("owner", uid);
      if (pauseError) {
        throw new Error("could not pause Gmail inbox work before deletion");
      }

      const { data: credential, error: credentialLookupError } = await admin
        .from("gmail_credentials").select("ledger_id").eq(
          "ledger_id",
          ledger.id,
        )
        .eq("owner", uid).maybeSingle();
      if (credentialLookupError) {
        throw new Error("could not inspect a stored Gmail authorization");
      }
      if (credential) {
        const { data: refreshToken, error: tokenError } = await admin.rpc(
          "gmail_get_refresh_token",
          { p_ledger_id: ledger.id, p_owner: uid },
        );
        if (
          tokenError || typeof refreshToken !== "string" || !refreshToken
        ) {
          throw new Error(
            "could not read a stored Gmail authorization safely",
          );
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
      await checked(
        "pending Gmail sign-ins",
        admin.from("gmail_oauth_transactions").delete()
          .eq("owner", uid).eq("ledger_id", ledger.id),
      );
    } catch (error) {
      operationError = error;
    } finally {
      const { data: released, error: releaseError } = await admin.rpc(
        "release_mailbox_operation",
        {
          p_ledger_id: ledger.id,
          p_owner: uid,
          p_lease_id: leaseId,
        },
      );
      releaseFailed = Boolean(releaseError) || released !== true;
    }
    if (operationError) throw operationError;
    if (releaseFailed) {
      throw new Error(
        "could not safely release a Gmail deletion lock; retry after it expires",
      );
    }
  }
}

async function revokeTwitter(
  admin: SupabaseClient,
  uid: string,
  manualRevocationsAcknowledged: boolean,
) {
  const twitterLedgers = await listTwitterLedgers(admin, uid);
  for (const ledger of twitterLedgers) {
    const leaseId = crypto.randomUUID();
    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_twitter_token_operation",
      {
        p_ledger_id: ledger.id,
        p_owner: uid,
        p_lease_id: leaseId,
        p_operation_kind: "disconnect",
        p_ttl_seconds: 180,
      },
    );
    if (claimError || claimed !== true) {
      throw new Error(
        "another X connection operation is in progress; wait and retry deletion",
      );
    }
    let operationError: unknown = null;
    let releaseFailed = false;
    try {
      const [credentialResult, connectionResult] = await Promise.all([
        admin.from("twitter_credentials").select("ledger_id,provider_subject")
          .eq("ledger_id", ledger.id).eq("owner", uid).maybeSingle(),
        admin.from("account_connections").select("connection_state,error_code")
          .eq("ledger_id", ledger.id).eq("owner", uid).maybeSingle(),
      ]);
      if (credentialResult.error || connectionResult.error) {
        throw new Error("could not inspect a stored X authorization");
      }
      const sharedGrantReset =
        connectionResult.data?.connection_state === "error" &&
        X_LOCAL_RESET_ERROR_CODES.has(
          connectionResult.data.error_code || "",
        );
      const credentialIdentityIsBlank = Boolean(credentialResult.data) &&
        !(credentialResult.data?.provider_subject || "").trim();
      const missingCredentialWithPriorGrantState = !credentialResult.data &&
        !sharedGrantReset &&
        (connectionResult.data?.connection_state === "connected" ||
          (connectionResult.data?.connection_state === "error" &&
            !X_NO_PROVIDER_GRANT_ERROR_CODES.has(
              connectionResult.data.error_code || "",
            )));
      const manualRequired = !sharedGrantReset &&
        (credentialIdentityIsBlank ||
          missingCredentialWithPriorGrantState ||
          (connectionResult.data?.connection_state === "error" &&
            connectionResult.data.error_code ===
              "x_manual_revoke_required"));
      if (manualRequired && !manualRevocationsAcknowledged) {
        throw new Error(
          "revoke MyPersonas in X Connected Apps before deletion",
        );
      }
      if (credentialResult.data) {
        if (!manualRequired && !sharedGrantReset) {
          const clientId = Deno.env.get("X_CLIENT_ID") || "";
          const clientSecret = Deno.env.get("X_CLIENT_SECRET") || "";
          if (!clientId || !clientSecret) {
            throw new Error(
              "X revocation is not configured; restore the X client configuration before deletion",
            );
          }
          const { data, error: tokenError } = await admin.rpc(
            "twitter_get_token_bundle",
            { p_ledger_id: ledger.id, p_owner: uid },
          );
          const row = (Array.isArray(data) ? data[0] : data) as
            | { token_bundle?: Record<string, unknown> | string }
            | null;
          let bundle = row?.token_bundle || null;
          if (typeof bundle === "string") {
            try {
              bundle = JSON.parse(bundle) as Record<string, unknown>;
            } catch {
              bundle = null;
            }
          }
          const refreshToken = bundle && typeof bundle === "object" &&
              typeof bundle.refresh_token === "string"
            ? bundle.refresh_token
            : "";
          const accessToken = bundle && typeof bundle === "object" &&
              typeof bundle.access_token === "string"
            ? bundle.access_token
            : "";
          if (tokenError || !refreshToken || !accessToken) {
            throw new Error("could not read a stored X authorization safely");
          }
          if (
            !await revokeXGrantPair(
              refreshToken,
              accessToken,
              clientId,
              clientSecret,
            )
          ) {
            const now = new Date().toISOString();
            const { error: recordError } = await admin.from(
              "account_connections",
            ).upsert(
              {
                ledger_id: ledger.id,
                owner: uid,
                provider: "twitter",
                connection_state: "error",
                error_code: "x_manual_revoke_required",
                last_checked_at: now,
                updated_at: now,
              },
              { onConflict: "ledger_id" },
            );
            if (recordError) {
              throw new Error(
                "X revocation was not confirmed and its manual-revocation safety state could not be recorded",
              );
            }
            throw new Error(
              "X did not confirm complete revocation; revoke MyPersonas in X Connected Apps before retrying deletion",
            );
          }
        }
        const { data: removed, error: credentialError } = await admin.rpc(
          "twitter_delete_token_bundle",
          { p_ledger_id: ledger.id, p_owner: uid },
        );
        if (credentialError || removed !== true) {
          throw new Error("could not remove a stored X authorization");
        }
      }
      await checked(
        "pending X sign-ins",
        admin.from("twitter_oauth_transactions").delete()
          .eq("owner", uid).eq("ledger_id", ledger.id),
      );
    } catch (error) {
      operationError = error;
    } finally {
      const { data: released, error: releaseError } = await admin.rpc(
        "release_twitter_token_operation",
        {
          p_ledger_id: ledger.id,
          p_owner: uid,
          p_lease_id: leaseId,
        },
      );
      releaseFailed = Boolean(releaseError) || released !== true;
    }
    if (operationError) throw operationError;
    if (releaseFailed) {
      throw new Error(
        "could not safely release an X deletion lock; retry after it expires",
      );
    }
  }
}

type RedditRevocationPlan = {
  ledgerId: string;
  refreshToken: string;
  hasStoredToken: boolean;
};

function redditStoredToken(value: unknown) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value !== "string") {
    throw new Error("could not read a stored Reddit authorization safely");
  }
  const token = value.trim();
  if (token.length > 16_384) {
    throw new Error("could not read a stored Reddit authorization safely");
  }
  return token;
}

async function revokeReddit(admin: SupabaseClient, uid: string) {
  const ledgers = await listRedditLedgers(admin, uid);
  const plans: RedditRevocationPlan[] = [];

  // Inventory every service-only token first. No provider call or local deletion
  // starts until the complete owned Reddit ledger set has been inspected.
  for (const ledger of ledgers) {
    const { data, error } = await admin.rpc("reddit_get_tokens_service", {
      p_ledger_id: ledger.id,
    });
    if (error) {
      throw new Error("could not inspect a stored Reddit authorization");
    }
    if (Array.isArray(data) && data.length > 1) {
      throw new Error("could not read a stored Reddit authorization safely");
    }
    const rawRow = Array.isArray(data) ? data[0] : data;
    if (
      rawRow !== null && rawRow !== undefined && typeof rawRow !== "object"
    ) {
      throw new Error("could not read a stored Reddit authorization safely");
    }
    const row = rawRow as
      | { access_token?: unknown; refresh_token?: unknown }
      | null;
    const accessToken = redditStoredToken(row?.access_token);
    const refreshToken = redditStoredToken(row?.refresh_token);
    plans.push({
      ledgerId: ledger.id,
      refreshToken,
      hasStoredToken: Boolean(accessToken || refreshToken),
    });
  }

  const hasStoredRedditToken = plans.some((plan) => plan.hasStoredToken);
  const clientId = Deno.env.get("REDDIT_CLIENT_ID") || "";
  const clientSecret = Deno.env.get("REDDIT_CLIENT_SECRET") || "";
  if (hasStoredRedditToken && (!clientId || !clientSecret)) {
    throw new Error(
      "Reddit revocation is not configured; restore the Reddit client configuration before deletion",
    );
  }

  // Confirm every extant provider grant before clearing even the first local
  // token. A missing refresh token has no provider secret to revoke and may
  // proceed to local state cleanup, but a request failure or non-2xx response
  // retains every local Reddit record for a safe retry.
  for (const plan of plans) {
    if (
      plan.refreshToken &&
      !await revokeRedditRefreshToken(
        plan.refreshToken,
        clientId,
        clientSecret,
      )
    ) {
      throw new Error(
        "Reddit did not confirm revocation; no local Reddit token or ledger record was deleted",
      );
    }
  }

  for (const plan of plans) {
    const { error: clearError } = await admin.rpc(
      "reddit_clear_tokens_service",
      { p_ledger_id: plan.ledgerId },
    );
    if (clearError) {
      throw new Error(
        "Reddit provider revocation completed, but local token cleanup failed",
      );
    }
    await checked(
      "pending Reddit sign-ins",
      admin.from("reddit_oauth_states").delete().eq("owner", uid)
        .eq("ledger_id", plan.ledgerId),
    );
  }
}

async function metaGrantRecordedState(
  admin: SupabaseClient,
  uid: string,
  grantId: string,
) {
  const { data: assets, error: assetError } = await admin.from(
    "meta_page_connections",
  )
    .select("facebook_ledger_id,instagram_ledger_id")
    .eq("owner", uid)
    .eq("grant_id", grantId);
  if (assetError) throw new Error("could not inspect shared Meta assets");
  const ledgerIds = [
    ...new Set(
      (assets || []).flatMap((asset) => [
        asset.facebook_ledger_id,
        asset.instagram_ledger_id,
      ]).filter((value): value is string =>
        typeof value === "string" && !!value
      ),
    ),
  ];
  if (!ledgerIds.length) return "active";
  const { data: connections, error } = await admin.from("account_connections")
    .select("error_code")
    .eq("owner", uid)
    .in("ledger_id", ledgerIds);
  if (error) throw new Error("could not inspect Meta cleanup state");
  const errors = new Set(
    (connections || []).map((row) => String(row.error_code || "")),
  );
  if (errors.has("meta_provider_revoked_local_cleanup_failed")) {
    return "provider_revoked";
  }
  if (errors.has("meta_manual_revoke_required")) return "manual_required";
  return "active";
}

async function revokeMeta(
  admin: SupabaseClient,
  uid: string,
  manualRevocationsAcknowledged: boolean,
) {
  const appSecret = Deno.env.get("META_APP_SECRET") || "";
  const providerRevokedUsers = new Set<string>();
  const manuallyAcknowledgedUsers = new Set<string>();
  const grants = await listMetaGrants(admin, uid);

  for (const grant of grants) {
    const leaseId = crypto.randomUUID();
    const { data: claimed, error: claimError } = await admin.rpc(
      "claim_meta_token_operation",
      {
        p_grant_id: grant.id,
        p_owner: uid,
        p_lease_id: leaseId,
        p_operation_kind: "disconnect",
        p_ttl_seconds: 180,
      },
    );
    if (claimError || claimed !== true) {
      throw new Error(
        "another Meta connection operation is in progress; wait and retry deletion",
      );
    }

    let grantDeleted = false;
    try {
      const recordedState = await metaGrantRecordedState(admin, uid, grant.id);
      if (
        recordedState === "manual_required" &&
        !manualRevocationsAcknowledged
      ) {
        throw new Error(
          "revoke the entire MyPersonas integration in Facebook Business Integrations before deletion",
        );
      }

      let providerRevocationConfirmed = recordedState === "provider_revoked";
      if (
        !providerRevocationConfirmed &&
        recordedState !== "manual_required"
      ) {
        const { data, error: tokenError } = await admin.rpc(
          "meta_get_grant_token_bundle",
          { p_grant_id: grant.id, p_owner: uid },
        );
        const row = (Array.isArray(data) ? data[0] : data) as
          | {
            meta_user_id?: string;
            token_bundle?: Record<string, unknown> | string;
          }
          | null;
        let bundle: unknown = row?.token_bundle || null;
        if (typeof bundle === "string") {
          try {
            bundle = JSON.parse(bundle);
          } catch {
            bundle = null;
          }
        }
        const accessToken = bundle && typeof bundle === "object" &&
            typeof (bundle as Record<string, unknown>).access_token === "string"
          ? String((bundle as Record<string, unknown>).access_token)
          : "";
        const metaUserId = String(row?.meta_user_id || grant.meta_user_id);
        providerRevocationConfirmed = !tokenError && Boolean(appSecret) &&
          await revokeMetaPermissions(metaUserId, accessToken, appSecret);
      }

      const manualAccepted = !providerRevocationConfirmed &&
        recordedState === "manual_required" &&
        manualRevocationsAcknowledged;
      if (!providerRevocationConfirmed && !manualAccepted) {
        const { error: recordError } = await admin.rpc(
          "meta_mark_grant_error",
          {
            p_grant_id: grant.id,
            p_owner: uid,
            p_error_code: "meta_manual_revoke_required",
          },
        );
        if (recordError) {
          throw new Error(
            "Meta revocation was not confirmed and its shared fail-closed state could not be recorded",
          );
        }
        throw new Error(
          `Meta did not confirm revocation; revoke the entire MyPersonas integration at ${META_MANUAL_REVOCATION_URL}, then retry with the Meta acknowledgement`,
        );
      }

      const deleted = await admin.rpc(
        "meta_delete_grant_and_mark_disconnected",
        { p_grant_id: grant.id, p_owner: uid, p_lease_id: leaseId },
      );
      if (deleted.error) {
        if (providerRevocationConfirmed) {
          await admin.rpc("meta_mark_grant_error", {
            p_grant_id: grant.id,
            p_owner: uid,
            p_error_code: "meta_provider_revoked_local_cleanup_failed",
          });
        }
        throw new Error(
          providerRevocationConfirmed
            ? "Meta access was revoked, but the shared local connection could not be cleared; retry deletion"
            : "manual Meta revocation was acknowledged, but the shared local connection could not be cleared; retry deletion",
        );
      }
      grantDeleted = true;
      if (providerRevocationConfirmed) {
        providerRevokedUsers.add(grant.meta_user_id);
      } else {
        manuallyAcknowledgedUsers.add(grant.meta_user_id);
      }
    } finally {
      if (!grantDeleted) {
        await admin.rpc("release_meta_token_operation", {
          p_grant_id: grant.id,
          p_owner: uid,
          p_lease_id: leaseId,
        });
      }
    }
  }

  const candidate = await getMetaCandidate(admin, uid);
  if (candidate) {
    const [durableGrant, reservation] = await Promise.all([
      admin.from("meta_grants")
        .select("owner")
        .eq("meta_user_id", candidate.meta_user_id)
        .maybeSingle(),
      admin.from("meta_identity_reservations")
        .select("owner,candidate_selection_hash")
        .eq("meta_user_id", candidate.meta_user_id)
        .maybeSingle(),
    ]);
    if (durableGrant.error || reservation.error) {
      throw new Error(
        "could not inspect Meta identity ownership before candidate cleanup",
      );
    }
    if (
      (durableGrant.data && durableGrant.data.owner !== uid) ||
      (reservation.data && reservation.data.owner !== uid)
    ) {
      const { data: discarded, error } = await admin.rpc(
        "meta_delete_oauth_candidate",
        { p_selection_hash: candidate.selection_hash, p_owner: uid },
      );
      if (error || discarded !== true) {
        throw new Error(
          "could not discard a legacy cross-owner Meta candidate without touching the other owner's provider grant",
        );
      }
    } else if (
      !reservation.data ||
      reservation.data.candidate_selection_hash !== candidate.selection_hash
    ) {
      const { data: holdStatus, error: holdError } = await admin.rpc(
        "meta_create_cleanup_hold",
        {
          p_owner: uid,
          p_error_code: "meta_identity_reservation_unavailable",
          p_meta_user_id: candidate.meta_user_id,
          p_cleanup_kind: "ownership_investigation",
        },
      );
      if (holdError) {
        throw new Error(
          "could not establish a fail-closed Meta ownership investigation",
        );
      }
      if (holdStatus === "reserved_other_owner") {
        const { data: discarded, error } = await admin.rpc(
          "meta_delete_oauth_candidate",
          { p_selection_hash: candidate.selection_hash, p_owner: uid },
        );
        if (error || discarded !== true) {
          throw new Error(
            "could not discard a cross-owner Meta candidate without touching the other owner's provider grant",
          );
        }
      } else if (
        holdStatus === "held" ||
        holdStatus === "protected_existing_hold"
      ) {
        throw new Error(
          "META_OWNERSHIP_INVESTIGATION: The Meta identity reservation cannot prove which shared provider integration is safe to revoke. Do not revoke Meta access; ownership review is required before erasure.",
        );
      } else {
        throw new Error(
          "could not establish a fail-closed Meta ownership investigation",
        );
      }
    } else {
      if (
        candidate.revocation_state === "manual_required" &&
        !manualRevocationsAcknowledged
      ) {
        throw new Error(
          "revoke the entire MyPersonas integration in Facebook Business Integrations before deletion",
        );
      }
      const startedAt = candidate.revocation_started_at
        ? new Date(candidate.revocation_started_at).getTime()
        : 0;
      if (
        candidate.revocation_state === "revoking" &&
        startedAt > Date.now() - 3 * 60 * 1000
      ) {
        throw new Error(
          "another Meta authorization cleanup is in progress; wait and retry deletion",
        );
      }

      const { data: claimData, error: claimError } = await admin.rpc(
        "meta_claim_oauth_candidate_for_revocation",
        {
          p_selection_hash: candidate.selection_hash,
          p_owner: uid,
          p_browser_nonce_hash: null,
          p_allow_manual_required: manualRevocationsAcknowledged,
        },
      );
      const claimedCandidate =
        (Array.isArray(claimData) ? claimData[0] : null) as
          | MetaClaimedCandidateRow
          | null;
      if (claimError || !claimedCandidate) {
        throw new Error(
          "could not lock the pending Meta authorization for safe cleanup",
        );
      }

      let providerRevocationConfirmed =
        claimedCandidate.previous_revocation_state === "provider_revoked" ||
        providerRevokedUsers.has(claimedCandidate.meta_user_id);
      const manualAccepted =
        manuallyAcknowledgedUsers.has(claimedCandidate.meta_user_id) ||
        (claimedCandidate.previous_revocation_state === "manual_required" &&
          manualRevocationsAcknowledged);
      if (!providerRevocationConfirmed && !manualAccepted) {
        const accessToken = metaCandidateAccessToken(
          claimedCandidate.token_bundle,
        );
        providerRevocationConfirmed = Boolean(appSecret) &&
          await revokeMetaPermissions(
            claimedCandidate.meta_user_id,
            accessToken,
            appSecret,
          );
      }
      if (!providerRevocationConfirmed && !manualAccepted) {
        const { data: recorded, error } = await admin.rpc(
          "meta_mark_candidate_manual_revoke",
          {
            p_selection_hash: candidate.selection_hash,
            p_owner: uid,
            p_error_code: "meta_candidate_revoke_unconfirmed",
          },
        );
        if (error || recorded !== true) {
          throw new Error(
            "Meta candidate revocation was not confirmed and its fail-closed state could not be recorded",
          );
        }
        throw new Error(
          `Meta did not confirm revocation; revoke the entire MyPersonas integration at ${META_MANUAL_REVOCATION_URL}, then retry with the Meta acknowledgement`,
        );
      }
      if (providerRevocationConfirmed) {
        const { data: marked, error } = await admin.rpc(
          "meta_mark_candidate_provider_revoked",
          { p_selection_hash: candidate.selection_hash, p_owner: uid },
        );
        if (error || marked !== true) {
          throw new Error(
            "Meta access was revoked, but its local cleanup checkpoint could not be recorded",
          );
        }
      }
      const { data: deleted, error: deleteError } = await admin.rpc(
        "meta_delete_oauth_candidate",
        { p_selection_hash: candidate.selection_hash, p_owner: uid },
      );
      if (deleteError || deleted !== true) {
        if (!providerRevocationConfirmed) {
          await admin.rpc("meta_mark_candidate_manual_revoke", {
            p_selection_hash: candidate.selection_hash,
            p_owner: uid,
            p_error_code: "meta_manual_revoke_cleanup_failed",
          });
        }
        throw new Error(
          "Meta access was revoked or manually acknowledged, but the pending local authorization could not be cleared",
        );
      }
    }
  }

  const { data: cleanupHold, error: holdLookupError } = await admin.from(
    "meta_oauth_cleanup_holds",
  ).select("owner,meta_user_id,cleanup_kind,error_code").eq("owner", uid)
    .maybeSingle();
  if (holdLookupError) {
    throw new Error("could not inspect ambiguous Meta authorization cleanup");
  }
  if (cleanupHold) {
    if (cleanupHold.cleanup_kind === "ownership_investigation") {
      throw new Error(
        "Meta returned no identity for an ambiguous authorization. Account erasure is fail-closed until support resolves the ownership investigation; do not revoke a provider integration based on this hold",
      );
    }
    if (!manualRevocationsAcknowledged) {
      throw new Error(
        "revoke the entire MyPersonas integration in Facebook Business Integrations before deletion",
      );
    }
    const { data: removed, error } = await admin.rpc(
      "meta_delete_cleanup_hold",
      {
        p_owner: uid,
        p_cleanup_kind: cleanupHold.cleanup_kind,
        p_meta_user_id: cleanupHold.meta_user_id,
        p_error_code: cleanupHold.error_code,
      },
    );
    if (error || removed !== true) {
      throw new Error(
        "manual Meta revocation was acknowledged, but the ambiguous authorization hold could not be cleared",
      );
    }
  }
}

async function eraseOwnedRows(
  admin: SupabaseClient,
  uid: string,
  personaIds: string[],
) {
  // Delete owner-authored organization and governance content before its
  // account/persona parents. In particular, project_resources deliberately
  // restricts account-ledger deletion while a resource still references it.
  await checked(
    "friend request security events by requester",
    admin.from("friend_request_security_events").delete().eq(
      "requester_owner",
      uid,
    ),
  );
  await checked(
    "persona organization data",
    admin.rpc("delete_persona_org_data_for_account_service", {
      p_owner: uid,
    }),
  );
  await checked(
    "businesses",
    admin.from("businesses").delete().eq("owner", uid),
  );
  await checked(
    "persona groups",
    admin.from("persona_groups").delete().eq("owner", uid),
  );
  await checked(
    "persona page builder data",
    admin.rpc("delete_persona_page_builder_data_for_account_service", {
      p_owner: uid,
    }),
  );
  await checked(
    "revenue and product review data",
    admin.rpc("delete_revenue_review_data_for_account_service", {
      p_owner: uid,
    }),
  );
  await checked(
    "research, content kit, notification, and activity data",
    admin.rpc("delete_owner_research_content_data_for_account_service", {
      p_owner: uid,
    }),
  );
  await checked(
    "persona publication reviews",
    admin.from("persona_publication_reviews").delete().eq("owner", uid),
  );
  // Content-only erasure retains profiles. Remove service-only remediation
  // inventory explicitly so unbound sources, blocked references, and retained
  // rate counters cannot survive merely because their profile still exists.
  await checked(
    "persona media upload leases",
    admin.rpc("erase_persona_media_upload_leases_owner_service_065", {
      p_owner: uid,
    }),
  );
  await checked(
    "legacy media remediation actions",
    admin.from("legacy_media_actions_065").delete().eq("owner", uid),
  );
  await checked(
    "legacy media remediation imports",
    admin.from("legacy_media_imports_065").delete().eq("owner", uid),
  );
  await checked(
    "legacy media remediation declarations",
    admin.from("legacy_media_declarations_065").delete().eq("owner", uid),
  );
  await checked(
    "legacy media remediation references",
    admin.from("legacy_media_references").delete().eq("owner", uid),
  );
  await checked(
    "legacy media remediation sources",
    admin.from("legacy_media_sources").delete().eq("owner", uid),
  );
  await checked(
    "legacy media remediation rate limits",
    admin.from("legacy_media_remediation_rate_limits_064").delete().eq(
      "owner",
      uid,
    ),
  );
  await checked(
    "platform feature requests",
    admin.from("platform_feature_requests").delete().eq("owner", uid),
  );
  await checked(
    "persona friend settings",
    admin.from("persona_friend_settings").delete().eq("owner", uid),
  );
  await checked(
    "persona friend invites",
    admin.from("persona_friend_invites").delete().eq("owner", uid),
  );
  await checked(
    "persona account sync settings",
    admin.from("persona_account_sync_settings").delete().eq("owner", uid),
  );
  await checked(
    "persona extension submissions",
    admin.from("persona_extension_submissions").delete().eq("owner", uid),
  );
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
    "agent targets and bounded audit",
    admin.rpc("delete_agent_action_data_for_account_service", {
      p_owner: uid,
    }),
  );
  await checked(
    "agent bindings",
    admin.rpc("delete_agent_bindings_for_account_service", { p_owner: uid }),
  );
  await checked(
    "agent settings",
    admin.from("agent_owner_settings").delete().eq("owner", uid),
  );
  // post_drafts.persona_id is ON DELETE SET NULL, so persona deletion alone
  // would preserve captions, briefs, schedules, and approval metadata. Erase
  // every owner-authored staged post explicitly on both content-only and full
  // account erasure paths before its persona can be detached.
  await checked(
    "staged post drafts",
    admin.from("post_drafts").delete().eq("owner", uid),
  );
  await checked(
    "approved-media delivery handles",
    admin.from("post_approved_media_handles").delete().eq("owner", uid),
  );
  await checked("drafts", admin.from("drafts").delete().eq("owner", uid));
  await checked("schedules", admin.from("ai_tasks").delete().eq("owner", uid));
  await checked(
    "AI backend budget policies and retained usage",
    admin.rpc("delete_ai_backend_budget_data_for_account_service", {
      p_owner: uid,
    }),
  );
  await checked(
    "model credentials",
    admin.from("ai_backends").delete().eq("owner", uid),
  );
  await checked(
    "pending Gmail sign-ins",
    admin.from("gmail_oauth_transactions").delete().eq("owner", uid),
  );
  await checked(
    "pending X sign-ins",
    admin.from("twitter_oauth_transactions").delete().eq("owner", uid),
  );
  await checked(
    "pending Reddit sign-ins",
    admin.from("reddit_oauth_states").delete().eq("owner", uid),
  );
  await checked(
    "account ledger",
    admin.rpc("delete_account_ledger_for_account_service", { p_owner: uid }),
  );
  await checked("blocks", admin.from("blocks").delete().eq("blocker", uid));
  for (let start = 0; start < personaIds.length; start += 100) {
    const batch = personaIds.slice(start, start + 100);
    await checked(
      "friend request security events by follower persona",
      admin.from("friend_request_security_events").delete().in(
        "follower_persona_id",
        batch,
      ),
    );
    await checked(
      "friend request security events by target persona",
      admin.from("friend_request_security_events").delete().in(
        "target_persona_id",
        batch,
      ),
    );
    await checked(
      "outgoing persona follows",
      admin.from("persona_follows").delete().in("follower_persona_id", batch),
    );
    await checked(
      "incoming persona follows",
      admin.from("persona_follows").delete().in("target_persona_id", batch),
    );
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
        headers: {
          ...CORS,
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    const origin = req.headers.get("Origin") || "";
    if (req.method === "OPTIONS") {
      return ALLOWED.has(origin)
        ? new Response("ok", { headers: CORS })
        : new Response("Forbidden", { status: 403 });
    }
    if (!ALLOWED.has(origin)) {
      return json({ error: "origin not allowed" }, 403);
    }
    if (req.method !== "POST") return json({ error: "POST only" }, 405);

    const jwt = (req.headers.get("Authorization") || "").replace("Bearer ", "");
    if (!jwt) return json({ error: "missing auth" }, 401);
    let body: {
      action?: string;
      confirm?: boolean;
      keepAccount?: boolean;
      protocolVersion?: number;
      externalRevocationsAcknowledged?: boolean | string[];
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
        externalRevocationAcknowledgements: [
          "openrouter",
          "twitter",
          "meta",
        ],
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
    const acknowledgedExternalRevocations = new Set<string>();
    if (Array.isArray(body.externalRevocationsAcknowledged)) {
      for (const provider of body.externalRevocationsAcknowledged) {
        if (
          provider === "openrouter" ||
          provider === "twitter" ||
          provider === "meta"
        ) {
          acknowledgedExternalRevocations.add(provider);
        }
      }
    } else if (body.externalRevocationsAcknowledged === true) {
      // Protocol-v2 compatibility: the old boolean represented only the
      // original OpenRouter warning. It must never acknowledge an X grant.
      acknowledgedExternalRevocations.add("openrouter");
    }

    try {
      const [
        hasOpenRouter,
        hasAmbiguousX,
        hasAmbiguousMeta,
        hasMetaOwnershipInvestigation,
      ] = await Promise
        .all([
          ownerHasOpenRouterBackend(admin, uid),
          ownerHasAmbiguousXGrant(admin, uid),
          ownerHasAmbiguousMetaGrant(admin, uid),
          ownerHasMetaOwnershipInvestigation(admin, uid),
        ]);
      if (hasMetaOwnershipInvestigation) {
        return json({
          error:
            "Meta returned no identity for an ambiguous authorization. Erasure is fail-closed until support resolves the ownership investigation. Do not revoke a provider integration based on this hold.",
          ownershipInvestigationRequired: true,
          doNotRevokeProvider: true,
          requiredExternalRevocations: [],
          missingExternalRevocations: [],
        }, 409);
      }
      const requiredExternalRevocations = [
        ...(hasOpenRouter ? ["openrouter"] : []),
        ...(hasAmbiguousX ? ["twitter"] : []),
        ...(hasAmbiguousMeta ? ["meta"] : []),
      ];
      const missingExternalRevocations = requiredExternalRevocations.filter(
        (provider) => !acknowledgedExternalRevocations.has(provider),
      );
      if (missingExternalRevocations.length) {
        return json({
          error:
            "Complete every required provider-side revocation, then acknowledge that step before local erasure.",
          requiredExternalRevocations,
          missingExternalRevocations,
        }, 409);
      }
      const metaOwnerErasureLeaseId = crypto.randomUUID();
      const { data: claimStatus, error: claimError } = await admin.rpc(
        "claim_meta_owner_erasure",
        {
          p_owner: uid,
          p_lease_id: metaOwnerErasureLeaseId,
          p_ttl_seconds: META_OWNER_ERASURE_TTL_SECONDS,
        },
      );
      if (claimError) {
        return json({
          error:
            "Could not establish the Meta owner-erasure safety lease. No erasure work was started.",
        }, 500);
      }
      if (claimStatus === "processing_oauth") {
        return json({
          error:
            "A Meta authorization exchange is still being resolved. Erasure is fail-closed until that provider outcome is durably recorded.",
          ownershipInvestigationRequired: true,
          doNotRevokeProvider: true,
          requiredExternalRevocations: [],
          missingExternalRevocations: [],
        }, 409);
      }
      if (claimStatus === "busy") {
        return json({
          error:
            "Another account-erasure operation is already running. Wait for it to finish or for its safety lease to expire, then retry.",
        }, 409);
      }
      if (claimStatus !== "claimed") {
        return json({
          error:
            "The Meta owner-erasure safety lease returned an unknown state. No erasure work was started.",
        }, 500);
      }

      const eraseClaimedOwner = async () => {
        const personaIds = await listOwnedPersonaIds(admin, uid);
        await renewMetaOwnerErasure(
          admin,
          uid,
          metaOwnerErasureLeaseId,
          "Gmail revocation",
        );
        await revokeGmail(admin, uid);
        await renewMetaOwnerErasure(
          admin,
          uid,
          metaOwnerErasureLeaseId,
          "X revocation",
        );
        await revokeTwitter(
          admin,
          uid,
          hasAmbiguousX &&
            acknowledgedExternalRevocations.has("twitter"),
        );
        await renewMetaOwnerErasure(
          admin,
          uid,
          metaOwnerErasureLeaseId,
          "Reddit revocation",
        );
        await revokeReddit(admin, uid);
        await renewMetaOwnerErasure(
          admin,
          uid,
          metaOwnerErasureLeaseId,
          "Meta revocation",
        );
        await revokeMeta(
          admin,
          uid,
          hasAmbiguousMeta &&
            acknowledgedExternalRevocations.has("meta"),
        );
        await renewMetaOwnerErasure(
          admin,
          uid,
          metaOwnerErasureLeaseId,
          "Discord webhook erasure",
        );
        await eraseDiscordWebhooks(admin, uid);
        await renewMetaOwnerErasure(
          admin,
          uid,
          metaOwnerErasureLeaseId,
          "approved-media delivery revocation",
        );
        // Revoke opaque provider URLs before deleting bytes. If later erasure
        // work fails, retries remain safe and no provider can fetch retained
        // owner-correlating objects during the partial-erasure interval.
        await revokeApprovedMediaDelivery(admin, uid);
        await renewMetaOwnerErasure(
          admin,
          uid,
          metaOwnerErasureLeaseId,
          "persona-media delivery revocation",
        );
        await revokePersonaMediaDelivery(admin, uid);
        await renewMetaOwnerErasure(
          admin,
          uid,
          metaOwnerErasureLeaseId,
          "owned storage erasure",
        );
        await eraseOwnedStorage(admin, uid);
        await renewMetaOwnerErasure(
          admin,
          uid,
          metaOwnerErasureLeaseId,
          "owned-row erasure",
        );
        await eraseOwnedRows(admin, uid, personaIds);
        // The Storage-row advisory trigger blocks concurrent writes while the
        // erasure lease is active. Arm a bounded hashed-owner cooldown before
        // keep-account release or profile deletion closes that lease, so a
        // request already in transport cannot land behind the verified sweep.
        await armPersonaMediaErasureCooldown(
          admin,
          uid,
          metaOwnerErasureLeaseId,
        );

        if (body.keepAccount === true) {
          await renewMetaOwnerErasure(
            admin,
            uid,
            metaOwnerErasureLeaseId,
            "account preference reset",
          );
          await checked(
            "account preferences",
            admin.from("profiles").update({ display_name: null, prefs: {} }).eq(
              "id",
              uid,
            ),
          );
          return json({ deleted: true, accountDeleted: false });
        }

        await renewMetaOwnerErasure(
          admin,
          uid,
          metaOwnerErasureLeaseId,
          "account security event erasure",
        );
        await checked(
          "platform security events by actor",
          admin.from("platform_security_events").delete().eq("actor_id", uid),
        );
        await checked(
          "platform security events by account subject id",
          admin.from("platform_security_events").delete().eq(
            "subject_account_id",
            uid,
          ),
        );
        await checked(
          "legacy platform security events by account subject",
          admin.from("platform_security_events").delete().eq(
            "subject_type",
            "account",
          ).eq("subject_id", uid),
        );
        await checked(
          "security network blocks by account subject id",
          admin.from("security_network_blocks").delete().eq(
            "subject_account_id",
            uid,
          ),
        );
        await renewMetaOwnerErasure(
          admin,
          uid,
          metaOwnerErasureLeaseId,
          "profile deletion",
        );
        await checked("profile", admin.from("profiles").delete().eq("id", uid));
        const { error: deleteUserError } = await admin.auth.admin.deleteUser(
          uid,
        );
        if (deleteUserError) {
          return json({
            error: "content removed but sign-in deletion failed: " +
              deleteUserError.message,
          }, 500);
        }
        return json({ deleted: true, accountDeleted: true });
      };

      return body.keepAccount === true
        ? await withMetaOwnerErasureRelease(
          admin,
          uid,
          metaOwnerErasureLeaseId,
          eraseClaimedOwner,
        )
        : await eraseClaimedOwner();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      if (message.startsWith("META_OWNERSHIP_INVESTIGATION:")) {
        return json({
          error: message.slice("META_OWNERSHIP_INVESTIGATION:".length).trim(),
          ownershipInvestigationRequired: true,
          doNotRevokeProvider: true,
          requiredExternalRevocations: [],
          missingExternalRevocations: [],
        }, 409);
      }
      return json({
        error: "Deletion stopped and may be partially complete: " +
          message,
      }, 500);
    }
  };
}

if (import.meta.main) serve(createErasureHandler());
