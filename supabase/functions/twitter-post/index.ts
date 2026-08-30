// twitter-post — owner-triggered, text-only X publishing for one exact approved
// generic Queue draft.
//
// Contract (POST, signed-in AAL2 Supabase bearer token, allowed browser origin):
//   { action:"prepare-publish-draft", draftId }
//   { action:"publish-draft", draftId, receiptId }
//   { action:"verify-draft-post", draftId }
//   { action:"delete-draft-post", draftId, confirmDelete:true }
//
// This worker deliberately has no media upload path. A draft with media_url is
// rejected before any X write, and twitter-oauth does not request media.write.
// X credentials remain in Supabase Vault behind migration-015 service RPCs.
// The per-ledger X token-operation lease serializes token refresh/rotation,
// disconnect, and every provider operation in this worker.
//
// Publishing order: owner pause -> exact approved owned draft -> current owned
// destination/persona assignment -> connected write-scoped grant -> atomic
// draft claim -> canonical hash recomputation -> current safety re-read -> X
// token lease/refresh/identity proof -> request-start audit -> provider call ->
// durable provider-id checkpoint -> completion. Any ambiguous POST outcome stays
// reconciliation-locked in `publishing`; it is never blindly retried.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAal2 } from "../_shared/aal2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const X_CLIENT_ID = Deno.env.get("X_CLIENT_ID") || "";
const X_CLIENT_SECRET = Deno.env.get("X_CLIENT_SECRET") || "";
const APP_ORIGIN = Deno.env.get("X_OAUTH_APP_ORIGIN") ||
  "https://mypersonas.online";
const X_TOKEN_URL = "https://api.x.com/2/oauth2/token";
const X_ME_URL = "https://api.x.com/2/users/me";
const X_POSTS_URL = "https://api.x.com/2/tweets";
const PROVIDER_TIMEOUT_MS = 20_000;
const TOKEN_REFRESH_SKEW_MS = 120_000;
const SAFE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_X_ID = /^[0-9]{1,19}$/;
const REQUIRED_READ_SCOPES = ["tweet.read", "users.read", "offline.access"];
const REQUIRED_WRITE_SCOPES = [...REQUIRED_READ_SCOPES, "tweet.write"];
const DRAFT_COLUMNS =
  "id,owner,persona_id,account_id,platform,title,body,tags,media_url,content_kind,publish_at,approval_state,approved_content_hash,approved_preview_version,approved_preview_hash,approved_preview_target_id,approved_previewed_at,publish_state,provider_post_id,generated_by_agent";
const ALLOWED_ORIGINS = new Set([
  APP_ORIGIN,
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

type Ledger = {
  id: string;
  owner: string;
  provider: string;
  persona_id: string | null;
  username: string | null;
  suspended: boolean;
};

type Connection = {
  ledger_id: string;
  provider_subject: string;
  provider_email: string;
  connection_state: string;
  verification_method: string;
  granted_scopes: unknown;
};

type Draft = {
  id: string;
  owner: string;
  persona_id: string | null;
  account_id: string | null;
  platform: string;
  title: string;
  body: string;
  tags: string;
  media_url: string;
  content_kind: string;
  publish_at: string | null;
  approval_state: string;
  approved_content_hash: string;
  approved_preview_version: string;
  approved_preview_hash: string;
  approved_preview_target_id: string;
  approved_previewed_at: string | null;
  publish_state: string;
  provider_post_id: string;
  generated_by_agent: boolean;
};

type StoredCredential = {
  providerSubject: string;
  providerUsername: string;
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scopes: string[];
  expiresAt: string;
};

type VerifiedAccess = {
  accessToken: string;
  providerSubject: string;
  providerUsername: string;
  scopes: string[];
};

// Keep the server client intentionally schema-untyped. This worker's database
// contract is enforced by migrations and runtime guards; inferring ReturnType
// from the generic createClient overload can collapse all tables/RPCs to never
// when a newer supabase-js declaration is resolved during deployment.
type ServiceClient = ReturnType<typeof createClient<any>>;

class XAccessError extends Error {
  override name = "XAccessError";
  status: number;
  code: string;
  manualRevocationRequired: boolean;

  constructor(
    message: string,
    status = 409,
    code = "x_access_unavailable",
    manualRevocationRequired = false,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.manualRevocationRequired = manualRevocationRequired;
  }
}

class ProviderOutcomeUncertainError extends Error {
  override name = "ProviderOutcomeUncertainError";
}

class PreProviderSafetyError extends Error {
  override name = "PreProviderSafetyError";
  status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

function providerOutcomeIsUncertain(error: unknown): boolean {
  const name = String((error as { name?: string })?.name || "");
  return error instanceof ProviderOutcomeUncertainError ||
    error instanceof TypeError || name === "AbortError" ||
    name === "TimeoutError";
}

function cors(origin: string): HeadersInit {
  return {
    ...(ALLOWED_ORIGINS.has(origin)
      ? { "Access-Control-Allow-Origin": origin }
      : {}),
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(origin: string, status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function normalizeUsername(value: unknown) {
  return String(value || "").normalize("NFKC").trim().replace(/^@+/, "")
    .toLowerCase();
}

function normalizeScopes(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value.split(/\s+/)
    : [];
  return [...new Set(raw.map((scope) => String(scope).trim()).filter(Boolean))]
    .sort();
}

function hasScopes(scopes: string[], required: string[]) {
  return required.every((scope) => scopes.includes(scope));
}

function basicAuthorization() {
  return `Basic ${btoa(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`)}`;
}

function safeExpiry(expiresIn: unknown) {
  const seconds = Number(expiresIn);
  const bounded = Number.isFinite(seconds)
    ? Math.min(86_400, Math.max(60, Math.floor(seconds)))
    : 7_200;
  return new Date(Date.now() + bounded * 1000).toISOString();
}

function xText(draft: Draft) {
  // Title is an internal Queue label when body text exists. Tags are a distinct
  // approved field and are appended deterministically to the actual X post.
  const main = String(draft.body || "").trim() ||
    String(draft.title || "").trim();
  const tags = String(draft.tags || "").trim();
  return [main, tags].filter(Boolean).join("\n\n");
}

function codePointLength(value: string) {
  return [...value].length;
}

function safeProviderMessage(payload: unknown, status: number) {
  if (!payload || typeof payload !== "object") {
    return `X returned HTTP ${status}`;
  }
  const row = payload as Record<string, unknown>;
  const direct = [row.detail, row.title]
    .find((value) => typeof value === "string" && value.trim());
  if (typeof direct === "string") return direct.trim().slice(0, 400);
  if (Array.isArray(row.errors)) {
    const details = row.errors.map((entry) => {
      if (!entry || typeof entry !== "object") return "";
      const error = entry as Record<string, unknown>;
      return typeof error.detail === "string"
        ? error.detail
        : typeof error.message === "string"
        ? error.message
        : typeof error.title === "string"
        ? error.title
        : "";
    }).filter(Boolean).join("; ");
    if (details) return details.slice(0, 400);
  }
  return `X returned HTTP ${status}`;
}

async function ownerPauseState(service: ServiceClient, owner: string) {
  const result = await service.from("agent_owner_settings")
    .select("automation_paused").eq("owner", owner).maybeSingle();
  return {
    available: !result.error && !!result.data,
    paused: result.data?.automation_paused === true,
  };
}

async function markConnectionError(
  service: ServiceClient,
  ledger: Ledger,
  code: string,
) {
  const now = new Date().toISOString();
  const { error } = await service.from("account_connections").update({
    connection_state: "error",
    error_code: code,
    last_checked_at: now,
    updated_at: now,
  }).eq("ledger_id", ledger.id).eq("owner", ledger.owner)
    .eq("provider", "twitter");
  return !error;
}

async function getStoredCredential(
  service: ServiceClient,
  ledger: Ledger,
): Promise<StoredCredential> {
  const { data, error } = await service.rpc("twitter_get_token_bundle", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
  });
  if (error) {
    throw new XAccessError(
      "The stored X authorization could not be read safely. Reconnect this account.",
      409,
      "x_token_read_failed",
    );
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | Record<string, unknown>
    | null;
  let bundle = row?.token_bundle as Record<string, unknown> | string | null;
  if (typeof bundle === "string") {
    try {
      bundle = JSON.parse(bundle) as Record<string, unknown>;
    } catch {
      bundle = null;
    }
  }
  if (!row || !bundle || typeof bundle !== "object") {
    throw new XAccessError(
      "No stored X authorization is available. Reconnect this account.",
      409,
      "x_token_missing",
    );
  }
  const credential: StoredCredential = {
    providerSubject: String(row.provider_subject || ""),
    providerUsername: String(row.provider_username || ""),
    accessToken: String(bundle.access_token || ""),
    refreshToken: String(bundle.refresh_token || ""),
    tokenType: String(bundle.token_type || ""),
    scopes: normalizeScopes(bundle.scope),
    expiresAt: String(bundle.expires_at || ""),
  };
  if (
    !credential.accessToken || !credential.refreshToken ||
    credential.tokenType.toLowerCase() !== "bearer" ||
    !SAFE_X_ID.test(credential.providerSubject) ||
    !/^[A-Za-z0-9_]{1,15}$/.test(credential.providerUsername) ||
    !Number.isFinite(Date.parse(credential.expiresAt))
  ) {
    throw new XAccessError(
      "The stored X authorization is incomplete. Reconnect this account.",
      409,
      "x_token_invalid",
    );
  }
  return credential;
}

async function refreshAtX(refreshToken: string, priorScopes: string[]) {
  try {
    const response = await fetch(X_TOKEN_URL, {
      method: "POST",
      headers: {
        "Authorization": basicAuthorization(),
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => ({})) as Record<
      string,
      unknown
    >;
    if (
      !response.ok || typeof payload.access_token !== "string" ||
      !payload.access_token.trim() ||
      String(payload.token_type || "").toLowerCase() !== "bearer"
    ) {
      return {
        token: null,
        // A malformed/non-JSON 2xx may still have rotated the refresh token.
        // Treat every unreadable success as ambiguous, exactly like a timeout.
        unavailable: response.status === 408 || response.status >= 500 ||
          response.status < 400,
      };
    }
    const responseScopes = normalizeScopes(payload.scope);
    return {
      token: {
        accessToken: payload.access_token,
        refreshToken: typeof payload.refresh_token === "string" &&
            payload.refresh_token
          ? payload.refresh_token
          : refreshToken,
        tokenType: "bearer",
        scopes: responseScopes.length ? responseScopes : priorScopes,
        expiresAt: safeExpiry(payload.expires_in),
      },
      unavailable: false,
    };
  } catch {
    return { token: null, unavailable: true };
  }
}

async function storeRefreshedCredential(
  service: ServiceClient,
  ledger: Ledger,
  credential: StoredCredential,
) {
  return await service.rpc("twitter_store_token_bundle", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
    p_expected_ledger_username: normalizeUsername(ledger.username),
    p_provider_subject: credential.providerSubject,
    p_provider_username: credential.providerUsername,
    p_access_token: credential.accessToken,
    p_refresh_token: credential.refreshToken,
    p_token_type: credential.tokenType,
    p_scope: credential.scopes.join(" "),
    p_expires_at: credential.expiresAt,
  });
}

async function fetchIdentity(accessToken: string) {
  try {
    const response = await fetch(`${X_ME_URL}?user.fields=id,name,username`, {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept": "application/json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => ({})) as {
      data?: Record<string, unknown>;
    };
    const id = String(payload.data?.id || "");
    const username = String(payload.data?.username || "");
    if (
      !response.ok || !SAFE_X_ID.test(id) ||
      !/^[A-Za-z0-9_]{1,15}$/.test(username)
    ) {
      return {
        identity: null,
        unavailable: response.status === 408 || response.status >= 500 ||
          response.status < 400,
      };
    }
    return { identity: { id, username }, unavailable: false };
  } catch {
    return { identity: null, unavailable: true };
  }
}

async function verifiedAccess(
  service: ServiceClient,
  ledger: Ledger,
  connection: Connection,
  requireWrite: boolean,
): Promise<VerifiedAccess> {
  if (!X_CLIENT_ID || !X_CLIENT_SECRET) {
    throw new XAccessError(
      "X client credentials are not configured. Nothing was sent.",
      503,
      "x_client_unconfigured",
    );
  }
  let credential = await getStoredCredential(service, ledger);
  const required = requireWrite ? REQUIRED_WRITE_SCOPES : REQUIRED_READ_SCOPES;
  const identityMismatch =
    credential.providerSubject !== connection.provider_subject ||
    normalizeUsername(credential.providerUsername) !==
      normalizeUsername(connection.provider_email) ||
    normalizeUsername(credential.providerUsername) !==
      normalizeUsername(ledger.username);
  const scopeMissing = !hasScopes(credential.scopes, required);
  if (identityMismatch || scopeMissing) {
    const code = scopeMissing ? "x_scope_missing" : "x_stored_identity_invalid";
    await markConnectionError(service, ledger, code);
    throw new XAccessError(
      requireWrite && !credential.scopes.includes("tweet.write")
        ? "Reconnect this X account with the explicit posting permission first."
        : "The stored X identity or permission set no longer matches this account.",
      409,
      requireWrite && !credential.scopes.includes("tweet.write")
        ? "x_write_scope_missing"
        : code,
    );
  }

  if (Date.parse(credential.expiresAt) <= Date.now() + TOKEN_REFRESH_SKEW_MS) {
    const refreshed = await refreshAtX(
      credential.refreshToken,
      credential.scopes,
    );
    if (!refreshed.token) {
      const code = refreshed.unavailable
        ? "x_manual_revoke_required"
        : "x_refresh_failed";
      await markConnectionError(service, ledger, code);
      throw new XAccessError(
        refreshed.unavailable
          ? "X did not confirm whether token refresh rotated the grant. Revoke MyPersonas in X Connected Apps before resetting this account. Nothing was posted."
          : "X rejected the stored authorization. Reconnect this account before posting.",
        refreshed.unavailable ? 502 : 409,
        code,
        refreshed.unavailable,
      );
    }
    credential = {
      ...credential,
      ...refreshed.token,
    };
    if (!hasScopes(credential.scopes, required)) {
      await markConnectionError(service, ledger, "x_scope_missing");
      throw new XAccessError(
        "The refreshed X grant is missing the required permission. Reconnect this account.",
        409,
        "x_scope_missing",
      );
    }
    const saved = await storeRefreshedCredential(service, ledger, credential);
    if (saved.error) {
      await markConnectionError(
        service,
        ledger,
        "x_manual_revoke_required",
      );
      throw new XAccessError(
        "X refreshed the grant, but its rotated token could not be stored. Revoke MyPersonas in X Connected Apps before resetting this account. Nothing was posted.",
        502,
        "x_manual_revoke_required",
        true,
      );
    }
    const now = new Date().toISOString();
    const update = await service.from("account_connections").update({
      granted_scopes: credential.scopes,
      expires_at: credential.expiresAt,
      connection_state: "connected",
      error_code: "",
      last_checked_at: now,
      updated_at: now,
    }).eq("ledger_id", ledger.id).eq("owner", ledger.owner)
      .eq("provider_subject", credential.providerSubject);
    if (update.error) {
      await markConnectionError(
        service,
        ledger,
        "x_connection_update_failed",
      );
      throw new XAccessError(
        "X access refreshed, but the connection checkpoint could not be updated. Nothing was posted.",
        500,
        "x_connection_update_failed",
      );
    }
  }

  const identityResult = await fetchIdentity(credential.accessToken);
  if (
    !identityResult.identity ||
    identityResult.identity.id !== credential.providerSubject ||
    identityResult.identity.id !== connection.provider_subject ||
    normalizeUsername(identityResult.identity.username) !==
      normalizeUsername(credential.providerUsername) ||
    normalizeUsername(identityResult.identity.username) !==
      normalizeUsername(ledger.username)
  ) {
    const code = identityResult.unavailable
      ? "x_identity_unreachable"
      : "x_identity_changed";
    await markConnectionError(service, ledger, code);
    throw new XAccessError(
      identityResult.unavailable
        ? "The connected X identity could not be reached. Nothing was sent."
        : "The connected X identity no longer matches this account. Nothing was sent.",
      identityResult.unavailable ? 502 : 409,
      code,
    );
  }
  return {
    accessToken: credential.accessToken,
    providerSubject: credential.providerSubject,
    providerUsername: credential.providerUsername,
    scopes: credential.scopes,
  };
}

async function claimTokenLease(
  service: ServiceClient,
  ledger: Ledger,
) {
  const leaseId = crypto.randomUUID();
  const { data, error } = await service.rpc("claim_twitter_token_operation", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
    p_lease_id: leaseId,
    // Existing migration-015 constrains the operation enum. The refresh lease
    // serializes every access-token consumer with refresh and disconnect.
    p_operation_kind: "refresh",
    p_ttl_seconds: 90,
  });
  if (error) {
    throw new XAccessError(
      "The X authorization safety lease could not be acquired. Nothing was sent.",
      503,
      "x_lease_failed",
    );
  }
  if (data !== true) {
    throw new XAccessError(
      "Another X authorization operation is in progress. Wait a moment and try again.",
      409,
      "x_lease_busy",
    );
  }
  return leaseId;
}

async function releaseTokenLease(
  service: ServiceClient,
  ledger: Ledger,
  leaseId: string,
) {
  await service.rpc("release_twitter_token_operation", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
    p_lease_id: leaseId,
  });
}

async function ownedLedger(
  service: ServiceClient,
  owner: string,
  ledgerId: string,
) {
  const result = await service.from("account_ledger")
    .select("id,owner,provider,persona_id,username,suspended")
    .eq("id", ledgerId).eq("owner", owner).eq("provider", "twitter")
    .maybeSingle();
  return {
    ledger: result.data as Ledger | null,
    error: Boolean(result.error),
  };
}

async function currentConnection(
  service: ServiceClient,
  owner: string,
  ledgerId: string,
) {
  const result = await service.from("account_connections")
    .select(
      "ledger_id,provider_subject,provider_email,connection_state,verification_method,granted_scopes",
    )
    .eq("ledger_id", ledgerId).eq("owner", owner).eq("provider", "twitter")
    .maybeSingle();
  return {
    connection: result.data as Connection | null,
    error: Boolean(result.error),
  };
}

function validConnection(connection: Connection | null, requireWrite: boolean) {
  if (
    !connection || connection.connection_state !== "connected" ||
    connection.verification_method !== "x_oauth2_pkce" ||
    !SAFE_X_ID.test(connection.provider_subject)
  ) return false;
  return hasScopes(
    normalizeScopes(connection.granted_scopes),
    requireWrite ? REQUIRED_WRITE_SCOPES : REQUIRED_READ_SCOPES,
  );
}

async function personaAssignmentStillValid(
  service: ServiceClient,
  draft: Draft,
  ledger: Ledger,
) {
  if (!draft.persona_id || ledger.persona_id === draft.persona_id) return true;
  const share = await service.from("account_persona_links").select("ledger_id")
    .eq("ledger_id", ledger.id).eq("persona_id", draft.persona_id)
    .eq("owner", draft.owner).maybeSingle();
  return !share.error && Boolean(share.data);
}

async function providerGetPost(accessToken: string, postId: string) {
  try {
    const response = await fetch(
      `${X_POSTS_URL}/${postId}?tweet.fields=author_id,created_at,text`,
      {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Accept": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      },
    );
    const payload = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    return { response, payload };
  } catch (error) {
    throw new ProviderOutcomeUncertainError(
      `X lookup ended without a durable response: ${String((error as Error)?.name || "network error")}`,
    );
  }
}

async function handlePublish(
  service: ServiceClient,
  owner: string,
  draftId: string,
  origin: string,
  receiptId: string,
  previewOnly = false,
) {
  if (!previewOnly && !SAFE_UUID.test(receiptId)) {
    return json(origin, 409, {
      error:
        "Open and approve the current server-generated X preview before publishing.",
    });
  }
  const pause = await ownerPauseState(service, owner);
  if (!pause.available) {
    return json(origin, 503, {
      error:
        "The owner-wide automation safety setting could not be verified. Nothing was published.",
    });
  }
  if (pause.paused) {
    return json(origin, 409, {
      error: "The global automation pause is on. Nothing was published.",
    });
  }

  const draftResult = await service.from("drafts").select(DRAFT_COLUMNS)
    .eq("id", draftId).eq("owner", owner).maybeSingle();
  const draft = draftResult.data as Draft | null;
  if (draftResult.error) {
    return json(origin, 503, {
      error: "The approved X draft could not be verified. Nothing was published.",
    });
  }
  if (!draft) return json(origin, 404, { error: "Owned draft not found" });
  if (!draft.account_id || draft.platform !== "twitter") {
    return json(origin, 409, {
      error: "This draft is not assigned to an X account.",
    });
  }
  if (draft.approval_state !== "approved" || !draft.approved_content_hash) {
    return json(origin, 409, {
      error: "Approve this exact draft before publishing it to X.",
    });
  }
  if (draft.provider_post_id) {
    return json(origin, 409, {
      error:
        "This draft already has a durable X post identifier and cannot be submitted again.",
      providerPostId: draft.provider_post_id,
    });
  }
  if (["publishing", "published"].includes(draft.publish_state || "")) {
    return json(origin, 409, {
      error: "This draft is already publishing or published.",
    });
  }
  if (String(draft.media_url || "").trim()) {
    return json(origin, 409, {
      error:
        "X media upload is not implemented or authorized. Remove the media URL, approve the text-only draft again, and retry.",
      mediaUploadEnabled: false,
    });
  }
  const text = xText(draft);
  if (!text) {
    return json(origin, 409, { error: "The approved X draft has no text." });
  }
  if (codePointLength(text) > 280) {
    return json(origin, 409, {
      error:
        "The approved X text is over 280 characters. Shorten it and approve the exact revision again.",
      characterCount: codePointLength(text),
    });
  }

  const ledgerResult = await ownedLedger(
    service,
    owner,
    draft.account_id,
  );
  const ledger = ledgerResult.ledger;
  if (ledgerResult.error) {
    return json(origin, 503, {
      error: "The X destination could not be verified. Nothing was published.",
    });
  }
  if (!ledger || ledger.suspended) {
    return json(origin, 409, {
      error: "The X destination is missing or suspended. Nothing was published.",
    });
  }
  if (!await personaAssignmentStillValid(service, draft, ledger)) {
    return json(origin, 409, {
      error: "That X account is no longer assigned to this draft's persona.",
    });
  }
  const connectionResult = await currentConnection(
    service,
    owner,
    ledger.id,
  );
  if (
    connectionResult.error ||
    !validConnection(connectionResult.connection, true)
  ) {
    return json(origin, 409, {
      error:
        "Reconnect this exact X account with the explicit posting permission before publishing.",
      postingEnabled: false,
      requiredScopes: REQUIRED_WRITE_SCOPES,
    });
  }
  const preview = await service.rpc("agent_draft_preview_hash", {
    p_content_hash: draft.approved_content_hash,
    p_preview_version: draft.approved_preview_version,
    p_preview_target_id: draft.approved_preview_target_id,
  });
  if (
    draft.approved_preview_version !== "platform-preview-v1" ||
    !draft.approved_previewed_at ||
    draft.approved_preview_target_id !==
      connectionResult.connection!.provider_subject ||
    preview.error || preview.data !== draft.approved_preview_hash
  ) {
    return json(origin, 409, {
      error:
        "Review and approve the current exact X preview for this account before publishing.",
    });
  }

  if (previewOnly) {
    const issued = await service.rpc(
      "issue_immediate_agent_preview_receipt_service",
      {
        p_owner: owner,
        p_draft_id: draft.id,
        p_provider: "twitter",
        p_action: "twitter.publish_now",
      },
    );
    const receipt = (Array.isArray(issued.data) ? issued.data[0] : issued.data) as
      | Record<string, unknown>
      | null;
    if (issued.error || !receipt) {
      return json(origin, 409, {
        error: issued.error?.message ||
          "The server could not create an exact X preview receipt. Nothing was published.",
      });
    }
    return json(origin, 200, { receipt });
  }

  // Atomically claim the exact approved row. All provider input below comes
  // from this returned row, never from the stale pre-claim read. Receipt
  // consumption and the state claim occur in one database transaction.
  const claim = await service.rpc(
    "claim_immediate_agent_draft_with_preview_service",
    {
      p_owner: owner,
      p_draft_id: draft.id,
      p_provider: "twitter",
      p_action: "twitter.publish_now",
      p_receipt_id: receiptId,
    },
  );
  const claimed = (Array.isArray(claim.data) ? claim.data[0] : claim.data) as
    | Draft
    | null;
  if (claim.error) {
    return json(origin, 409, {
      error: claim.error?.message ||
        "The server preview expired, was used, or no longer matches. Nothing was published.",
    });
  }
  if (!claimed) {
    return json(origin, 409, {
      error: "This draft changed, lost approval, or is already publishing.",
    });
  }

  async function writeAudit(
    outcome: "ok" | "error",
    detail: Record<string, unknown>,
  ) {
    const result = await service.rpc("insert_agent_action_service", {
      p_owner: owner,
      p_persona_id: claimed!.persona_id || null,
      p_binding_id: null,
      p_action_type: "publish_external_twitter",
      p_entity_type: "draft",
      p_entity_id: claimed!.id,
      p_outcome: outcome,
      p_detail: {
        account_id: claimed!.account_id,
        approved_content_hash: claimed!.approved_content_hash,
        ...detail,
      },
    });
    return !result.error;
  }

  async function definitiveFailure(message: string, status = 502) {
    const saved = await service.from("drafts")
      .update({ publish_state: "failed", publish_error: message.slice(0, 500) })
      .eq("id", claimed!.id).eq("owner", owner)
      .eq("publish_state", "publishing").eq("provider_post_id", "")
      .select("id").maybeSingle();
    if (saved.error || !saved.data) {
      const auditWritten = await writeAudit("error", {
        error: message,
        retry_safe: false,
        reconciliation_required: true,
        state_checkpoint_missing: true,
      });
      return json(origin, 500, {
        status: "unknown",
        reconciliationRequired: true,
        error:
          "The safe failure could not be checkpointed. Reload and reconcile the draft before taking any action.",
        ...(auditWritten ? {} : { auditMissing: true }),
      });
    }
    const auditWritten = await writeAudit("error", {
      error: message,
      retry_safe: true,
    });
    return json(origin, status, {
      status: "failed",
      error: message,
      ...(auditWritten ? {} : { auditMissing: true }),
    });
  }

  async function uncertain(message: string, providerPostId = "") {
    const note = `${message} Do not retry until this X account and draft are reconciled.`
      .slice(0, 500);
    const saved = await service.from("drafts").update({ publish_error: note })
      .eq("id", claimed!.id).eq("owner", owner)
      .eq("publish_state", "publishing")
      .select("id").maybeSingle();
    const auditWritten = await writeAudit("error", {
      error: note,
      retry_safe: false,
      reconciliation_required: true,
      ...(providerPostId ? { provider_post_id: providerPostId } : {}),
    });
    return json(origin, 202, {
      status: saved.error || !saved.data ? "unknown" : "publishing",
      reconciliationRequired: true,
      ...(providerPostId ? { providerPostId } : {}),
      error: note,
      ...(auditWritten ? {} : { auditMissing: true }),
    });
  }

  const hash = await service.rpc("agent_draft_hash", {
    p_title: claimed.title || "",
    p_body: claimed.body || "",
    p_tags: claimed.tags || "",
    p_media_url: claimed.media_url || "",
    p_content_kind: claimed.content_kind || "",
    p_persona_id: claimed.persona_id,
    p_account_id: claimed.account_id,
    p_platform: claimed.platform || "",
    p_publish_at: claimed.publish_at,
  });
  if (hash.error || hash.data !== claimed.approved_content_hash) {
    return await definitiveFailure(
      "The approval no longer matches this exact X draft. Approve it again before publishing.",
      409,
    );
  }
  const claimedText = xText(claimed);
  if (
    claimed.media_url.trim() || !claimedText ||
    codePointLength(claimedText) > 280
  ) {
    return await definitiveFailure(
      "The claimed X draft is no longer an eligible text-only post of 280 characters or fewer.",
      409,
    );
  }

  // Re-read every mutable safety, destination, assignment, and authorization
  // record after the claim. The provider request is still several guards away.
  const [pauseAgain, ledgerAgain, connectionAgain] = await Promise.all([
    ownerPauseState(service, owner),
    ownedLedger(service, owner, claimed.account_id!),
    currentConnection(service, owner, claimed.account_id!),
  ]);
  if (!pauseAgain.available || pauseAgain.paused) {
    return await definitiveFailure(
      pauseAgain.paused
        ? "The global automation pause turned on before the X request. Nothing was published."
        : "The owner-wide automation safety setting became unavailable. Nothing was published.",
      pauseAgain.paused ? 409 : 503,
    );
  }
  const activeLedger = ledgerAgain.ledger;
  const activeConnection = connectionAgain.connection;
  if (
    ledgerAgain.error || !activeLedger || activeLedger.suspended ||
    connectionAgain.error || !validConnection(activeConnection, true)
  ) {
    return await definitiveFailure(
      "The connected X destination or write permission became unavailable. Nothing was published.",
      409,
    );
  }
  if (!await personaAssignmentStillValid(service, claimed, activeLedger)) {
    return await definitiveFailure(
      "The X destination is no longer assigned to this draft's persona. Nothing was published.",
      409,
    );
  }
  if (
    claimed.approved_preview_version !== "platform-preview-v1" ||
    !claimed.approved_previewed_at ||
    claimed.approved_preview_target_id !== activeConnection!.provider_subject
  ) {
    return await definitiveFailure(
      "The X destination changed after the approved platform preview. Approve the exact preview again.",
      409,
    );
  }

  let leaseId = "";
  try {
    leaseId = await claimTokenLease(service, activeLedger);
    const access = await verifiedAccess(
      service,
      activeLedger,
      activeConnection!,
      true,
    );

    // Close the owner-pause and connection-revocation race immediately before
    // the only create-post call. The token lease blocks refresh/disconnect.
    const [lastPause, lastLedger, lastConnection] = await Promise.all([
      ownerPauseState(service, owner),
      ownedLedger(service, owner, activeLedger.id),
      currentConnection(service, owner, activeLedger.id),
    ]);
    if (!lastPause.available || lastPause.paused) {
      throw new PreProviderSafetyError(
        lastPause.paused
          ? "The global automation pause turned on before the X request. Nothing was published."
          : "The owner-wide automation safety setting could not be rechecked. Nothing was published.",
        lastPause.paused ? 409 : 503,
      );
    }
    if (
      lastLedger.error || !lastLedger.ledger || lastLedger.ledger.suspended ||
      lastConnection.error || !validConnection(lastConnection.connection, true) ||
      lastConnection.connection?.provider_subject !== access.providerSubject
    ) {
      throw new PreProviderSafetyError(
        "The X destination or write authorization changed before the request. Nothing was published.",
      );
    }
    if (!await personaAssignmentStillValid(service, claimed, lastLedger.ledger)) {
      throw new PreProviderSafetyError(
        "The X destination assignment changed before the request. Nothing was published.",
      );
    }
    const audited = await writeAudit("ok", {
      phase: "provider_request_start",
      retry_safe: false,
      provider_subject: access.providerSubject,
    });
    if (!audited) {
      throw new PreProviderSafetyError(
        "The X provider request could not be audited. Nothing was published.",
        503,
      );
    }

    let response: Response;
    try {
      response = await fetch(X_POSTS_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${access.accessToken}`,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({
          text: claimedText,
          // The exact server preview receipt always discloses this field. Keep
          // the provider request byte-for-byte consistent with that snapshot.
          made_with_ai: true,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch (error) {
      if (providerOutcomeIsUncertain(error)) {
        return await uncertain(
          "X did not return a durable result for the create-post request.",
        );
      }
      return await uncertain(
        "The X create-post request ended without a durable result.",
      );
    }
    if (response.status === 408 || response.status >= 500) {
      return await uncertain(
        `X returned HTTP ${response.status} after the create-post request.`,
      );
    }
    const payload = await response.json().catch(() => null) as
      | Record<string, unknown>
      | null;
    if (!response.ok) {
      if (response.status === 401) {
        await markConnectionError(service, activeLedger, "x_access_rejected");
      }
      const message = response.status === 401
        ? "X rejected the access token. Reconnect this account before posting."
        : response.status === 403
        ? "X rejected this post or the account lacks current write access. Review the X developer project and reconnect."
        : response.status === 429
        ? "X rate-limited this account. Review the account before trying a newly approved draft later."
        : safeProviderMessage(payload, response.status);
      return await definitiveFailure(message, response.status === 429 ? 429 : 502);
    }
    if (!payload) {
      return await uncertain(
        "X accepted the create-post request but returned no readable result.",
      );
    }
    const data = payload.data as Record<string, unknown> | undefined;
    const postId = String(data?.id || "");
    if (!SAFE_X_ID.test(postId)) {
      return await uncertain(
        "X accepted the create-post request but returned no durable post identifier.",
      );
    }

    // Checkpoint the provider identifier before any broader completion state.
    // Once present, all safe retries are blocked even if finalization fails.
    const checkpoint = await service.from("drafts").update({
      provider_post_id: postId,
      publish_error: "X accepted the post; local finalization is in progress.",
    }).eq("id", claimed.id).eq("owner", owner)
      .eq("publish_state", "publishing").eq("provider_post_id", "")
      .select("id,provider_post_id,publish_state").maybeSingle();
    if (
      checkpoint.error || !checkpoint.data ||
      checkpoint.data.provider_post_id !== postId
    ) {
      const reread = await service.from("drafts")
        .select("provider_post_id,publish_state")
        .eq("id", claimed.id).eq("owner", owner).maybeSingle();
      if (reread.error || reread.data?.provider_post_id !== postId) {
        return await uncertain(
          `X published ${postId}, but its durable provider identifier could not be verified locally.`,
          postId,
        );
      }
    }

    const postedAt = new Date().toISOString();
    const final = await service.from("drafts").update({
      status: "posted",
      publish_state: "published",
      publish_error: "",
      posted_at: postedAt,
    }).eq("id", claimed.id).eq("owner", owner)
      .eq("publish_state", "publishing").eq("provider_post_id", postId)
      .select("id,provider_post_id,publish_state").maybeSingle();
    if (
      final.error || !final.data || final.data.provider_post_id !== postId
    ) {
      const reread = await service.from("drafts")
        .select("provider_post_id,publish_state")
        .eq("id", claimed.id).eq("owner", owner).maybeSingle();
      if (
        reread.error || reread.data?.provider_post_id !== postId ||
        reread.data?.publish_state !== "published"
      ) {
        return await uncertain(
          `X published ${postId}, but the local completion checkpoint could not be verified.`,
          postId,
        );
      }
    }
    const auditWritten = await writeAudit("ok", {
      phase: "completed",
      provider_post_id: postId,
      provider_url:
        `https://x.com/${normalizeUsername(access.providerUsername)}/status/${postId}`,
      posted_at: postedAt,
    });
    return json(origin, 200, {
      status: "published",
      published: true,
      postId,
      url:
        `https://x.com/${normalizeUsername(access.providerUsername)}/status/${postId}`,
      ...(auditWritten ? {} : { auditMissing: true }),
    });
  } catch (error) {
    if (error instanceof XAccessError) {
      return await definitiveFailure(error.message, error.status);
    }
    if (error instanceof PreProviderSafetyError) {
      return await definitiveFailure(error.message, error.status);
    }
    return await definitiveFailure(
      "The X publisher stopped before a provider write could be confirmed. Nothing was published.",
      500,
    );
  } finally {
    if (leaseId) await releaseTokenLease(service, activeLedger, leaseId);
  }
}

async function loadPublishedDraft(
  service: ServiceClient,
  owner: string,
  draftId: string,
) {
  const result = await service.from("drafts").select(DRAFT_COLUMNS)
    .eq("id", draftId).eq("owner", owner).eq("platform", "twitter")
    .maybeSingle();
  const draft = result.data as Draft | null;
  if (result.error || !draft || !draft.account_id ||
    !SAFE_X_ID.test(draft.provider_post_id || "")) return null;
  return draft;
}

async function handleVerifyOrDelete(
  service: ServiceClient,
  owner: string,
  draftId: string,
  origin: string,
  deleting: boolean,
) {
  const draft = await loadPublishedDraft(service, owner, draftId);
  if (!draft) {
    return json(origin, 404, {
      error: "Owned published X draft with a durable post id was not found.",
    });
  }
  const ledgerResult = await ownedLedger(service, owner, draft.account_id!);
  const connectionResult = await currentConnection(
    service,
    owner,
    draft.account_id!,
  );
  const ledger = ledgerResult.ledger;
  const connection = connectionResult.connection;
  if (
    ledgerResult.error || !ledger || ledger.suspended ||
    connectionResult.error || !validConnection(connection, deleting)
  ) {
    return json(origin, 409, {
      error: deleting
        ? "Reconnect this X account with write permission before deleting its post."
        : "Reconnect this X account before verifying its post.",
    });
  }
  let leaseId = "";
  try {
    leaseId = await claimTokenLease(service, ledger);
    const access = await verifiedAccess(service, ledger, connection!, deleting);
    const lookup = await providerGetPost(access.accessToken, draft.provider_post_id);
    if (lookup.response.status === 404) {
      if (deleting) {
        await service.from("drafts").update({
          publish_error:
            `X post ${draft.provider_post_id} is already absent; the provider id is retained for history.`,
        }).eq("id", draft.id).eq("owner", owner)
          .eq("provider_post_id", draft.provider_post_id);
      }
      return json(origin, 200, {
        verified: true,
        exists: false,
        ...(deleting ? { deleted: true, alreadyAbsent: true } : {}),
        postId: draft.provider_post_id,
      });
    }
    if (lookup.response.status === 408 || lookup.response.status >= 500) {
      return json(origin, 502, {
        verified: false,
        error: `X lookup returned HTTP ${lookup.response.status}. Try verification again later.`,
      });
    }
    if (!lookup.response.ok || !lookup.payload) {
      return json(origin, 502, {
        verified: false,
        error: safeProviderMessage(lookup.payload, lookup.response.status),
      });
    }
    const row = lookup.payload.data as Record<string, unknown> | undefined;
    const providerId = String(row?.id || "");
    const authorId = String(row?.author_id || "");
    if (
      providerId !== draft.provider_post_id ||
      authorId !== access.providerSubject
    ) {
      return json(origin, 403, {
        verified: false,
        error:
          "The X post does not match this draft and connected account. Nothing was changed.",
      });
    }
    if (!deleting) {
      return json(origin, 200, {
        verified: true,
        exists: true,
        postId: providerId,
        authorId,
        createdAt: typeof row?.created_at === "string" ? row.created_at : null,
        text: typeof row?.text === "string" ? row.text : "",
        url:
          `https://x.com/${normalizeUsername(access.providerUsername)}/status/${providerId}`,
      });
    }

    let deleteResponse: Response;
    try {
      deleteResponse = await fetch(`${X_POSTS_URL}/${providerId}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${access.accessToken}`,
          "Accept": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
    } catch {
      return json(origin, 202, {
        status: "unknown",
        reconciliationRequired: true,
        postId: providerId,
        error:
          "X did not return a durable delete result. Verify the post before trying any further action.",
      });
    }
    if (deleteResponse.status === 408 || deleteResponse.status >= 500) {
      return json(origin, 202, {
        status: "unknown",
        reconciliationRequired: true,
        postId: providerId,
        error:
          `X returned HTTP ${deleteResponse.status} after the delete request. Verify the post before trying again.`,
      });
    }
    const deletePayload = await deleteResponse.json().catch(() => null) as
      | { data?: { deleted?: boolean } }
      | null;
    if (!deleteResponse.ok) {
      return json(origin, 502, {
        deleted: false,
        error: safeProviderMessage(deletePayload, deleteResponse.status),
      });
    }
    if (deletePayload?.data?.deleted !== true) {
      return json(origin, 202, {
        status: "unknown",
        reconciliationRequired: true,
        postId: providerId,
        error:
          "X returned success without explicit deletion confirmation. Verify the post before taking any further action.",
      });
    }
    let confirmation;
    try {
      confirmation = await providerGetPost(access.accessToken, providerId);
    } catch {
      return json(origin, 202, {
        status: "deleted_unverified",
        reconciliationRequired: true,
        postId: providerId,
        error:
          "X accepted deletion, but the follow-up absence check could not complete.",
      });
    }
    if (confirmation.response.status !== 404) {
      return json(origin, 202, {
        status: "deleted_unverified",
        reconciliationRequired: true,
        postId: providerId,
        error:
          "X accepted deletion, but the post was not yet confirmed absent. Verify again before any further action.",
      });
    }
    const note =
      `X confirmed deletion of ${providerId}; the provider id is retained for immutable history.`;
    const saved = await service.from("drafts").update({ publish_error: note })
      .eq("id", draft.id).eq("owner", owner)
      .eq("provider_post_id", providerId).select("id").maybeSingle();
    const audit = await service.rpc("insert_agent_action_service", {
      p_owner: owner,
      p_persona_id: draft.persona_id || null,
      p_binding_id: null,
      p_action_type: "delete_external_twitter",
      p_entity_type: "draft",
      p_entity_id: draft.id,
      p_outcome: "ok",
      p_detail: {
        account_id: draft.account_id,
        provider_post_id: providerId,
        absence_verified: true,
      },
    });
    return json(origin, saved.error || !saved.data ? 202 : 200, {
      deleted: true,
      verifiedAbsent: true,
      postId: providerId,
      historyCheckpointed: !saved.error && Boolean(saved.data),
      ...(audit.error ? { auditMissing: true } : {}),
    });
  } catch (error) {
    if (error instanceof XAccessError) {
      return json(origin, error.status, {
        error: error.message,
        code: error.code,
        ...(error.manualRevocationRequired
          ? { manualRevocationRequired: true }
          : {}),
      });
    }
    if (error instanceof ProviderOutcomeUncertainError) {
      return json(origin, 502, { verified: false, error: error.message });
    }
    return json(origin, 500, {
      error: "The X verification action could not complete safely.",
    });
  } finally {
    if (leaseId) await releaseTokenLease(service, ledger, leaseId);
  }
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    return ALLOWED_ORIGINS.has(origin)
      ? new Response(null, { status: 204, headers: cors(origin) })
      : new Response(null, { status: 403 });
  }
  if (req.method !== "POST") return json(origin, 405, { error: "POST only" });
  if (!ALLOWED_ORIGINS.has(origin)) {
    return json(origin, 403, { error: "Origin not allowed" });
  }
  const authorization = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false },
  });
  const guard = await requireAal2(req, userClient);
  if (!guard.ok) {
    return json(origin, guard.status, { error: guard.error, code: guard.code });
  }
  const contentLength = Number(req.headers.get("Content-Length") || "0");
  if (Number.isFinite(contentLength) && contentLength > 32_768) {
    return json(origin, 413, { error: "Request is too large" });
  }
  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 32_768) {
      return json(origin, 413, { error: "Request is too large" });
    }
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json(origin, 400, { error: "Invalid request body" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(origin, 400, { error: "Invalid request body" });
  }
  const draftId = String(body.draftId || "");
  if (!SAFE_UUID.test(draftId)) {
    return json(origin, 400, { error: "A valid draftId is required" });
  }
  const service = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const action = String(body.action || "publish-draft");
  if (action === "prepare-publish-draft") {
    return await handlePublish(
      service,
      guard.user.id,
      draftId,
      origin,
      "",
      true,
    );
  }
  if (action === "publish-draft") {
    return await handlePublish(
      service,
      guard.user.id,
      draftId,
      origin,
      String(body.receiptId || ""),
    );
  }
  if (action === "verify-draft-post") {
    return await handleVerifyOrDelete(
      service,
      guard.user.id,
      draftId,
      origin,
      false,
    );
  }
  if (action === "delete-draft-post") {
    if (body.confirmDelete !== true) {
      return json(origin, 400, {
        error: "Explicit confirmDelete:true is required for X deletion.",
      });
    }
    return await handleVerifyOrDelete(
      service,
      guard.user.id,
      draftId,
      origin,
      true,
    );
  }
  return json(origin, 400, { error: "Unknown action" });
});
