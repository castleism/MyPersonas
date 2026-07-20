// gmail-oauth — dedicated per-ledger Gmail authorization.
//
// POST { action:"start", ledgerId } with the user's Supabase JWT returns a
// Google authorization URL. Google redirects back here with code + one-time
// state. Refresh tokens are stored only in Supabase Vault through service-only
// RPCs from migration 010; the browser never receives Google tokens.
//
// Deploy without gateway JWT verification because the Google callback has no
// Supabase Authorization header. POST actions still validate JWTs manually.
// Deploy: supabase functions deploy gmail-oauth --no-verify-jwt
// Secrets: GOOGLE_GMAIL_CLIENT_ID, GOOGLE_GMAIL_CLIENT_SECRET
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_GMAIL_CLIENT_ID") || "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_GMAIL_CLIENT_SECRET") || "";
const CALLBACK_URL = Deno.env.get("GMAIL_OAUTH_REDIRECT_URI") ||
  "https://nwsqyuucwzihruszocge.supabase.co/functions/v1/gmail-oauth";
const APP_RETURN_URL = Deno.env.get("GMAIL_OAUTH_APP_URL") ||
  "https://mypersonas.online/#/studio";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const LOCAL_RESET_ERROR_CODES = new Set([
  "gmail_already_connected",
  "shared_grant_cleanup_failed",
  "local_credential_cleanup_failed",
]);

const ALLOWED_ORIGINS = new Set([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

type Ledger = {
  id: string;
  owner: string;
  provider: string;
  login_email: string | null;
};

type OAuthTransaction = {
  owner: string;
  ledger_id: string;
  code_verifier: string;
};

type OAuthActionBody = {
  action?: string;
  ledgerId?: string;
  code?: string;
  state?: string;
  browserNonce?: string;
  providerError?: string;
};

type GoogleGrantFailureOptions = {
  errorCode: string;
  message: string;
  status?: number;
  recoveryRefreshToken?: string;
  recoveryCredentialPresent?: boolean;
  allowRecoveryStorage?: boolean;
};

type SharedGrantRejectionOptions = {
  localCleanupFailed?: boolean;
};

function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function json(body: unknown, status = 200, origin = "") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...(origin && ALLOWED_ORIGINS.has(origin) ? cors(origin) : {}),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function redirectToApp(params: Record<string, string>, returnOrigin = "") {
  const target = new URL(
    ALLOWED_ORIGINS.has(returnOrigin)
      ? `${returnOrigin}/#/studio`
      : APP_RETURN_URL,
  );
  for (const [key, value] of Object.entries(params)) {
    if (value) target.searchParams.set(key, value);
  }
  return new Response(null, {
    status: 302,
    headers: { "Location": target.toString(), "Cache-Control": "no-store" },
  });
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/g,
    "",
  );
}

function randomUrlSafe(byteLength: number) {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function sha256Bytes(value: string) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function sha256Hex(value: string) {
  return [...await sha256Bytes(value)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function caller(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(
    /^Bearer\s+/i,
    "",
  );
  if (!jwt) return null;
  const { data, error } = await admin.auth.getUser(jwt);
  return error ? null : data.user;
}

async function ownedGmailLedger(
  ledgerId: string,
  owner: string,
): Promise<Ledger | null> {
  const { data, error } = await admin.from("account_ledger")
    .select("id,owner,provider,login_email")
    .eq("id", ledgerId)
    .eq("owner", owner)
    .eq("provider", "gmail")
    .maybeSingle();
  return error || !data ? null : data as Ledger;
}

async function markConnectionError(
  ledger: Ledger,
  errorCode: string,
  force = false,
) {
  const { data: existing, error: lookupError } = await admin.from(
    "account_connections",
  )
    .select("connection_state")
    .eq("ledger_id", ledger.id)
    .maybeSingle();
  if (lookupError) return false;
  if (!force && existing?.connection_state === "connected") return true;
  const now = new Date().toISOString();
  if (existing) {
    const { error } = await admin.from("account_connections").update({
      connection_state: "error",
      error_code: errorCode,
      last_checked_at: now,
      updated_at: now,
    }).eq("ledger_id", ledger.id);
    return !error;
  } else {
    const { error } = await admin.from("account_connections").insert({
      ledger_id: ledger.id,
      owner: ledger.owner,
      provider: "gmail",
      provider_email: (ledger.login_email || "").trim().toLowerCase(),
      connection_state: "error",
      verification_method: "google_oauth",
      last_checked_at: now,
      error_code: errorCode,
      updated_at: now,
    });
    return !error;
  }
}

async function revokeGoogleToken(token: string) {
  if (!token) return false;
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

async function failAfterGoogleGrant(
  ledger: Ledger,
  origin: string,
  options: GoogleGrantFailureOptions,
) {
  const {
    errorCode,
    message,
    status = 400,
    recoveryRefreshToken = "",
    recoveryCredentialPresent = false,
    allowRecoveryStorage = true,
  } = options;
  // A Google grant is shared by user + OAuth client, so an access/refresh token
  // obtained during a failed attempt may be the same grant used by another
  // valid ledger. Never revoke automatically until identity uniqueness is
  // proven. Preserve an issued refresh token only as an encrypted recovery
  // handle so Disconnect Gmail can revoke it deliberately.
  let recoveryStored = recoveryCredentialPresent;
  const { data: currentConnection, error: currentConnectionError } = await admin
    .from("account_connections")
    .select("connection_state")
    .eq("ledger_id", ledger.id)
    .maybeSingle();
  const mayStoreRecovery = allowRecoveryStorage && !currentConnectionError &&
    currentConnection?.connection_state !== "connected";
  if (!recoveryStored && mayStoreRecovery && recoveryRefreshToken) {
    const { error } = await admin.rpc("gmail_store_refresh_token", {
      p_ledger_id: ledger.id,
      p_owner: ledger.owner,
      p_provider_email: (ledger.login_email || "").trim().toLowerCase(),
      p_refresh_token: recoveryRefreshToken,
    });
    recoveryStored = !error;
  }
  const stateRecorded = await markConnectionError(
    ledger,
    recoveryStored ? "google_revoke_required" : errorCode,
  );

  if (!stateRecorded) {
    return json(
      {
        error:
          `${message} The Gmail safety state could not be recorded. Review Google Account permissions and use Disconnect Gmail before trying again.`,
        revocationRequired: true,
      },
      500,
      origin,
    );
  }

  const nextStep = recoveryStored
    ? "Use Disconnect Gmail to revoke the attempted grant before trying again."
    : "Review AliaSpaces in your Google Account permissions and revoke it there if access was granted.";
  return json(
    {
      error:
        `${message} Automatic revocation was not attempted because Google grants may be shared with another connected account. ${nextStep}`,
      revocationRequired: true,
    },
    status,
    origin,
  );
}

// Google grants are shared by user + OAuth client. If this identity is already
// connected to another ledger, revoking the just-issued token would also break
// that valid connection. Remove only an attempted local copy and keep the
// provider grant intact.
async function rejectSharedGoogleGrant(
  ledger: Ledger,
  origin: string,
  options: SharedGrantRejectionOptions = {},
) {
  if (options.localCleanupFailed) {
    await markConnectionError(ledger, "shared_grant_cleanup_failed");
    return json(
      {
        error:
          "That Gmail account is already connected elsewhere, and the attempted local token copy could not be removed. Use Reset Gmail to retry local cleanup; do not revoke the shared Google grant.",
        localResetRequired: true,
      },
      500,
      origin,
    );
  }
  const stateRecorded = await markConnectionError(
    ledger,
    "gmail_already_connected",
  );
  if (!stateRecorded) {
    return json(
      {
        error:
          "That Gmail account is already connected elsewhere, but the attempted connection state could not be recorded.",
      },
      500,
      origin,
    );
  }
  return json(
    {
      error: "That Gmail account is already connected elsewhere.",
      localResetAvailable: true,
    },
    409,
    origin,
  );
}

async function findSharedGoogleGrant(
  ledger: Ledger,
  subject: string,
  trustedEmails: string[],
) {
  if (subject) {
    const { data, error } = await admin.from("account_connections")
      .select("ledger_id")
      .eq("provider", "gmail")
      .eq("provider_subject", subject)
      .neq("ledger_id", ledger.id)
      .limit(1)
      .maybeSingle();
    if (error) return { shared: false, error: true };
    if (data) return { shared: true, error: false };
  }

  if (trustedEmails.length) {
    const { data, error } = await admin.from("account_connections")
      .select("ledger_id")
      .eq("provider", "gmail")
      .eq("connection_state", "connected")
      .neq("ledger_id", ledger.id)
      .in("provider_email", trustedEmails)
      .limit(1)
      .maybeSingle();
    if (error) return { shared: false, error: true };
    if (data) return { shared: true, error: false };
  }

  return { shared: false, error: false };
}

async function rollbackAttemptedCredential(
  ledger: Ledger,
  issuedCredentialStored: boolean,
  previousRefreshToken: string,
) {
  if (!issuedCredentialStored) return true;
  if (previousRefreshToken) {
    const { error } = await admin.rpc("gmail_store_refresh_token", {
      p_ledger_id: ledger.id,
      p_owner: ledger.owner,
      p_provider_email: (ledger.login_email || "").trim().toLowerCase(),
      p_refresh_token: previousRefreshToken,
    });
    return !error;
  }
  const { error } = await admin.rpc("gmail_delete_refresh_token", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
  });
  return !error;
}

async function startAuthorization(
  req: Request,
  origin: string,
  ledgerIdInput = "",
) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return json(
      { error: "Gmail authorization is not configured yet" },
      503,
      origin,
    );
  }
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);

  const ledgerId = ledgerIdInput.trim();
  if (!/^[0-9a-f-]{36}$/i.test(ledgerId)) {
    return json({ error: "Invalid account id" }, 400, origin);
  }

  const ledger = await ownedGmailLedger(ledgerId, user.id);
  if (!ledger || !(ledger.login_email || "").trim()) {
    return json(
      { error: "Owned Gmail account with a login email is required" },
      404,
      origin,
    );
  }
  const [connectionLookup, credentialLookup] = await Promise.all([
    admin.from("account_connections")
      .select("connection_state,error_code")
      .eq("ledger_id", ledger.id)
      .maybeSingle(),
    admin.from("gmail_credentials")
      .select("ledger_id")
      .eq("ledger_id", ledger.id)
      .eq("owner", ledger.owner)
      .maybeSingle(),
  ]);
  if (connectionLookup.error || credentialLookup.error) {
    return json(
      { error: "Could not inspect the current Gmail connection" },
      500,
      origin,
    );
  }
  const existingConnection = connectionLookup.data;
  if (existingConnection?.connection_state === "connected") {
    return json(
      {
        error:
          "This Gmail account is already connected. Disconnect it before authorizing it again.",
      },
      409,
      origin,
    );
  }
  if (credentialLookup.data) {
    const resetOnly = LOCAL_RESET_ERROR_CODES.has(
      existingConnection?.error_code || "",
    );
    return json(
      {
        error: resetOnly
          ? "Reset the failed Gmail attempt before authorizing again."
          : "Disconnect the previous Gmail authorization before authorizing again.",
        localResetRequired: resetOnly,
        revocationRequired: !resetOnly,
      },
      409,
      origin,
    );
  }
  const ledgerEmail = (ledger.login_email || "").trim().toLowerCase();
  const { data: connectedEmail, error: connectedEmailError } = await admin
    .from("account_connections")
    .select("ledger_id")
    .eq("provider", "gmail")
    .eq("provider_email", ledgerEmail)
    .eq("connection_state", "connected")
    .neq("ledger_id", ledger.id)
    .limit(1)
    .maybeSingle();
  if (connectedEmailError) {
    return json(
      { error: "Could not inspect existing Gmail identities" },
      500,
      origin,
    );
  }
  if (connectedEmail) {
    return json(
      { error: "That Gmail account is already connected elsewhere." },
      409,
      origin,
    );
  }

  const state = randomUrlSafe(32);
  const browserNonce = randomUrlSafe(32);
  const verifier = randomUrlSafe(64);
  const stateHash = await sha256Hex(state);
  const browserNonceHash = await sha256Hex(browserNonce);
  const challenge = base64Url(await sha256Bytes(verifier));
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await admin.from("gmail_oauth_transactions").delete().lt(
    "expires_at",
    new Date().toISOString(),
  );
  const { error: stateError } = await admin.from("gmail_oauth_transactions")
    .upsert({
      state_hash: stateHash,
      owner: user.id,
      ledger_id: ledger.id,
      code_verifier: verifier,
      browser_nonce_hash: browserNonceHash,
      return_origin: origin,
      expires_at: expiresAt,
    }, { onConflict: "owner,ledger_id" });
  if (stateError) {
    return json({ error: "Could not start Gmail authorization" }, 500, origin);
  }

  const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorization.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: CALLBACK_URL,
    response_type: "code",
    scope: `openid email ${GMAIL_SCOPE}`,
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "select_account consent",
    login_hint: ledger.login_email!.trim(),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  return json(
    { authorizationUrl: authorization.toString(), browserNonce },
    200,
    origin,
  );
}

async function callback(req: Request) {
  const url = new URL(req.url);
  const rawState = url.searchParams.get("state") || "";
  const providerError = url.searchParams.get("error");
  const code = url.searchParams.get("code") || "";
  if (rawState.length < 32) {
    return redirectToApp({ gmail: "error", reason: "invalid_state" });
  }
  const { data: pending } = await admin.from("gmail_oauth_transactions")
    .select("return_origin")
    .eq("state_hash", await sha256Hex(rawState))
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  const returnOrigin = typeof pending?.return_origin === "string" &&
      ALLOWED_ORIGINS.has(pending.return_origin)
    ? pending.return_origin
    : "";
  if (!returnOrigin) {
    return redirectToApp({ gmail: "error", reason: "invalid_state" });
  }
  if (!code && !providerError) {
    return redirectToApp(
      { gmail: "error", reason: "missing_code" },
      returnOrigin,
    );
  }
  return redirectToApp({
    gmail: "finish",
    state: rawState,
    code,
    provider_error: providerError === "access_denied"
      ? "access_denied"
      : providerError
      ? "oauth_error"
      : "",
  }, returnOrigin);
}

async function completeAuthorization(
  req: Request,
  origin: string,
  body: OAuthActionBody,
) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return json(
      { error: "Gmail authorization is not configured yet" },
      503,
      origin,
    );
  }
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);

  const rawState = (body.state || "").trim();
  const browserNonce = (body.browserNonce || "").trim();
  const code = (body.code || "").trim();
  const providerError = body.providerError === "access_denied"
    ? "access_denied"
    : body.providerError
    ? "oauth_error"
    : "";
  if (rawState.length < 32 || browserNonce.length < 32) {
    return json(
      { error: "The Gmail authorization expired. Please try again." },
      400,
      origin,
    );
  }

  const { data: consumed, error: stateError } = await admin.rpc(
    "consume_gmail_oauth_state",
    {
      p_state_hash: await sha256Hex(rawState),
      p_owner: user.id,
      p_browser_nonce_hash: await sha256Hex(browserNonce),
    },
  );
  const transaction = (Array.isArray(consumed) ? consumed[0] : consumed) as
    | OAuthTransaction
    | null;
  if (stateError || !transaction) {
    return json(
      {
        error:
          "The Gmail authorization expired or was opened in a different browser tab.",
      },
      400,
      origin,
    );
  }

  const ledger = await ownedGmailLedger(transaction.ledger_id, user.id);
  if (!ledger) {
    return json(
      { error: "The Gmail account record was not found." },
      404,
      origin,
    );
  }

  if (providerError) {
    await markConnectionError(
      ledger,
      providerError === "access_denied"
        ? "google_access_denied"
        : "google_oauth_error",
    );
    return json(
      {
        error: providerError === "access_denied"
          ? "Gmail authorization was cancelled."
          : "Google could not complete authorization.",
      },
      400,
      origin,
    );
  }
  if (!code) {
    await markConnectionError(ledger, "missing_authorization_code");
    return json(
      { error: "Google did not return an authorization code." },
      400,
      origin,
    );
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: CALLBACK_URL,
        grant_type: "authorization_code",
        code_verifier: transaction.code_verifier,
      }),
    });
  } catch {
    await markConnectionError(ledger, "google_token_unreachable");
    return json(
      { error: "Google could not complete authorization. Please try again." },
      502,
      origin,
    );
  }
  const token = await tokenResponse.json().catch(() => ({})) as Record<
    string,
    unknown
  >;
  if (!tokenResponse.ok || typeof token.access_token !== "string") {
    await markConnectionError(ledger, "google_token_exchange_failed");
    return json(
      { error: "Google could not complete authorization. Please try again." },
      400,
      origin,
    );
  }
  const accessToken = token.access_token;
  const issuedRefreshToken = typeof token.refresh_token === "string"
    ? token.refresh_token
    : "";

  const grantedScopes = typeof token.scope === "string"
    ? token.scope.split(/\s+/).filter(Boolean)
    : [];
  const [userInfoResult, profileResult] = await Promise.allSettled([
    fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { "Authorization": `Bearer ${accessToken}` },
    }),
    fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { "Authorization": `Bearer ${accessToken}` },
    }),
  ]);
  const userInfoResponse = userInfoResult.status === "fulfilled"
    ? userInfoResult.value
    : null;
  const profileResponse = profileResult.status === "fulfilled"
    ? profileResult.value
    : null;
  const userInfo = userInfoResponse
    ? await userInfoResponse.json().catch(() => ({})) as Record<string, unknown>
    : {};
  const profile = profileResponse
    ? await profileResponse.json().catch(() => ({})) as Record<string, unknown>
    : {};
  const ledgerEmail = (ledger.login_email || "").trim().toLowerCase();
  const subject = userInfoResponse?.ok && typeof userInfo.sub === "string"
    ? userInfo.sub.trim()
    : "";
  const identityEmail = userInfoResponse?.ok &&
      userInfo.email_verified === true && typeof userInfo.email === "string"
    ? userInfo.email.trim().toLowerCase()
    : "";
  const gmailEmail = profileResponse?.ok &&
      typeof profile.emailAddress === "string"
    ? profile.emailAddress.trim().toLowerCase()
    : "";
  const trustedEmails = [
    ...new Set([identityEmail, gmailEmail].filter(Boolean)),
  ];
  const sharedGrantLookup = await findSharedGoogleGrant(
    ledger,
    subject,
    trustedEmails,
  );
  if (sharedGrantLookup.error) {
    return failAfterGoogleGrant(ledger, origin, {
      errorCode: "gmail_identity_lookup_failed",
      message: "Could not check the existing Gmail connection.",
      status: 500,
      recoveryRefreshToken: issuedRefreshToken,
      allowRecoveryStorage: false,
    });
  }
  if (sharedGrantLookup.shared) {
    return rejectSharedGoogleGrant(ledger, origin);
  }

  if (!grantedScopes.includes(GMAIL_SCOPE)) {
    return failAfterGoogleGrant(ledger, origin, {
      errorCode: "gmail_scope_missing",
      message: "Gmail read-only permission was not granted.",
      recoveryRefreshToken: issuedRefreshToken,
    });
  }

  const consistentTrustedEmail = trustedEmails.length === 1
    ? trustedEmails[0]
    : "";
  if (
    !userInfoResponse?.ok || !profileResponse?.ok ||
    userInfo.email_verified !== true || !subject ||
    !identityEmail || identityEmail !== gmailEmail
  ) {
    const emailMismatch = consistentTrustedEmail &&
      consistentTrustedEmail !== ledgerEmail;
    return failAfterGoogleGrant(ledger, origin, {
      errorCode: emailMismatch
        ? "gmail_email_mismatch"
        : userInfoResult.status === "rejected" ||
            profileResult.status === "rejected"
        ? "google_profile_unreachable"
        : "google_profile_invalid",
      message: emailMismatch
        ? "That Google account does not match the Gmail address recorded here."
        : "The selected Gmail account could not be verified.",
      status: userInfoResult.status === "rejected" ||
          profileResult.status === "rejected"
        ? 502
        : 400,
      recoveryRefreshToken: issuedRefreshToken,
    });
  }
  if (gmailEmail !== ledgerEmail) {
    return failAfterGoogleGrant(ledger, origin, {
      errorCode: "gmail_email_mismatch",
      message:
        "That Google account does not match the Gmail address recorded here.",
      recoveryRefreshToken: issuedRefreshToken,
    });
  }

  const { data: storedRefresh, error: storedRefreshError } = await admin.rpc(
    "gmail_get_refresh_token",
    {
      p_ledger_id: ledger.id,
      p_owner: ledger.owner,
    },
  );
  if (storedRefreshError) {
    const { data: knownCredential } = await admin.from("gmail_credentials")
      .select("ledger_id")
      .eq("ledger_id", ledger.id)
      .eq("owner", ledger.owner)
      .maybeSingle();
    return failAfterGoogleGrant(ledger, origin, {
      errorCode: "refresh_token_read_failed",
      message: "The stored Gmail authorization could not be read safely.",
      status: 500,
      recoveryRefreshToken: issuedRefreshToken,
      recoveryCredentialPresent: Boolean(knownCredential),
    });
  }
  const previousRefreshToken = typeof storedRefresh === "string"
    ? storedRefresh
    : "";
  const hadStoredRefresh = previousRefreshToken.length > 0;
  const refreshToken = issuedRefreshToken
    ? issuedRefreshToken
    : hadStoredRefresh
    ? previousRefreshToken
    : "";
  if (!refreshToken) {
    return failAfterGoogleGrant(ledger, origin, {
      errorCode: "google_refresh_token_missing",
      message: "Google did not provide ongoing access. Please try again.",
    });
  }

  if (issuedRefreshToken) {
    const { error: storeError } = await admin.rpc("gmail_store_refresh_token", {
      p_ledger_id: ledger.id,
      p_owner: ledger.owner,
      p_provider_email: gmailEmail,
      p_refresh_token: issuedRefreshToken,
    });
    if (storeError) {
      return failAfterGoogleGrant(ledger, origin, {
        errorCode: "refresh_token_storage_failed",
        message: "Gmail authorization could not be stored securely.",
        status: 500,
        recoveryCredentialPresent: hadStoredRefresh,
        allowRecoveryStorage: false,
      });
    }
  }

  const now = new Date();
  const expiresIn = typeof token.expires_in === "number"
    ? token.expires_in
    : 3600;
  const { error: connectionError } = await admin.from("account_connections")
    .upsert({
      ledger_id: ledger.id,
      owner: ledger.owner,
      provider: "gmail",
      provider_subject: subject,
      provider_email: gmailEmail,
      granted_scopes: grantedScopes,
      connection_state: "connected",
      verification_method: "google_oauth",
      verified_at: now.toISOString(),
      connected_at: now.toISOString(),
      last_checked_at: now.toISOString(),
      expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
      error_code: "",
      updated_at: now.toISOString(),
    }, { onConflict: "ledger_id" });
  if (connectionError) {
    if (connectionError.code === "23505") {
      const cleanupSucceeded = await rollbackAttemptedCredential(
        ledger,
        Boolean(issuedRefreshToken),
        previousRefreshToken,
      );
      return rejectSharedGoogleGrant(ledger, origin, {
        localCleanupFailed: !cleanupSucceeded,
      });
    }
    return failAfterGoogleGrant(ledger, origin, {
      errorCode: "connection_save_failed",
      message:
        "Gmail authorized, but its connection record could not be saved.",
      status: 500,
      recoveryCredentialPresent: true,
    });
  }

  return json({ connected: true, ledgerId: ledger.id }, 200, origin);
}

async function disconnect(req: Request, origin: string, ledgerId: string) {
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);
  const ledger = await ownedGmailLedger(ledgerId, user.id);
  if (!ledger) {
    return json({ error: "Owned Gmail account not found" }, 404, origin);
  }

  const { data: connection, error: connectionLookupError } = await admin.from(
    "account_connections",
  )
    .select("connection_state,error_code")
    .eq("ledger_id", ledger.id)
    .maybeSingle();
  if (connectionLookupError) {
    return json(
      { error: "Could not inspect the current Gmail connection" },
      500,
      origin,
    );
  }
  if (
    connection?.connection_state === "error" &&
    LOCAL_RESET_ERROR_CODES.has(connection.error_code || "")
  ) {
    return json(
      {
        error:
          "Reset this failed local Gmail attempt without revoking the shared Google grant.",
        localResetRequired: true,
      },
      409,
      origin,
    );
  }

  const { data: credential, error: credentialLookupError } = await admin.from(
    "gmail_credentials",
  )
    .select("ledger_id")
    .eq("ledger_id", ledger.id)
    .eq("owner", ledger.owner)
    .maybeSingle();
  if (credentialLookupError) {
    return json(
      { error: "Could not inspect the stored Gmail authorization" },
      500,
      origin,
    );
  }
  let revoked = true;
  if (credential) {
    const { data: refreshToken, error: tokenError } = await admin.rpc(
      "gmail_get_refresh_token",
      {
        p_ledger_id: ledger.id,
        p_owner: ledger.owner,
      },
    );
    if (tokenError || typeof refreshToken !== "string" || !refreshToken) {
      return json(
        { error: "The stored Gmail authorization could not be read safely" },
        500,
        origin,
      );
    }
    revoked = await revokeGoogleToken(refreshToken);
  }
  if (!revoked) {
    const now = new Date().toISOString();
    await admin.from("account_connections").update({
      error_code: "google_revoke_failed",
      last_checked_at: now,
      updated_at: now,
    }).eq("ledger_id", ledger.id);
    return json(
      {
        error:
          "Google did not confirm revocation. Nothing was deleted; please try again.",
      },
      502,
      origin,
    );
  }
  const { error: deleteError } = await admin.rpc("gmail_delete_refresh_token", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
  });
  if (deleteError) {
    return json(
      { error: "Could not remove the stored Gmail authorization" },
      500,
      origin,
    );
  }

  const now = new Date().toISOString();
  const { error: updateError } = await admin.from("account_connections").upsert(
    {
      ledger_id: ledger.id,
      owner: ledger.owner,
      provider: "gmail",
      provider_subject: "",
      provider_email: (ledger.login_email || "").trim().toLowerCase(),
      granted_scopes: [],
      connection_state: "disconnected",
      verification_method: "google_oauth",
      connected_at: null,
      last_checked_at: now,
      expires_at: null,
      error_code: revoked ? "" : "google_revoke_unconfirmed",
      updated_at: now,
    },
    { onConflict: "ledger_id" },
  );
  if (updateError) {
    return json(
      { error: "Gmail was revoked but local status could not be updated" },
      500,
      origin,
    );
  }
  return json(
    { disconnected: true, googleRevocationConfirmed: revoked },
    200,
    origin,
  );
}

async function resetSharedGrantAttempt(
  req: Request,
  origin: string,
  ledgerId: string,
) {
  const user = await caller(req);
  if (!user) return json({ error: "Invalid or expired session" }, 401, origin);
  const ledger = await ownedGmailLedger(ledgerId, user.id);
  if (!ledger) {
    return json({ error: "Owned Gmail account not found" }, 404, origin);
  }

  const { data: connection, error: connectionError } = await admin.from(
    "account_connections",
  )
    .select("connection_state,error_code")
    .eq("ledger_id", ledger.id)
    .maybeSingle();
  if (connectionError) {
    return json(
      { error: "Could not inspect the failed Gmail attempt" },
      500,
      origin,
    );
  }
  if (
    connection?.connection_state !== "error" ||
    !LOCAL_RESET_ERROR_CODES.has(connection.error_code || "")
  ) {
    return json(
      {
        error: "This Gmail connection must be disconnected, not locally reset",
      },
      409,
      origin,
    );
  }

  const { error: deleteError } = await admin.rpc("gmail_delete_refresh_token", {
    p_ledger_id: ledger.id,
    p_owner: ledger.owner,
  });
  if (deleteError) {
    return json(
      { error: "Could not remove the failed local Gmail token copy" },
      500,
      origin,
    );
  }

  const now = new Date().toISOString();
  const { error: updateError } = await admin.from("account_connections").upsert(
    {
      ledger_id: ledger.id,
      owner: ledger.owner,
      provider: "gmail",
      provider_subject: "",
      provider_email: (ledger.login_email || "").trim().toLowerCase(),
      granted_scopes: [],
      connection_state: "disconnected",
      verification_method: "google_oauth",
      connected_at: null,
      last_checked_at: now,
      expires_at: null,
      error_code: "",
      updated_at: now,
    },
    { onConflict: "ledger_id" },
  );
  if (updateError) {
    return json(
      {
        error:
          "The local token was removed but Gmail status could not be reset",
      },
      500,
      origin,
    );
  }
  return json({ reset: true, googleGrantUnchanged: true }, 200, origin);
}

serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") {
    return ALLOWED_ORIGINS.has(origin)
      ? new Response("ok", { headers: cors(origin) })
      : new Response("Forbidden", { status: 403 });
  }
  if (req.method === "GET") return callback(req);
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!ALLOWED_ORIGINS.has(origin)) {
    return json({ error: "Origin not allowed" }, 403);
  }

  let actionBody: OAuthActionBody;
  try {
    actionBody = await req.clone().json();
  } catch {
    return json({ error: "Invalid request" }, 400, origin);
  }
  if (actionBody.action === "start") {
    return startAuthorization(req, origin, actionBody.ledgerId);
  }
  if (actionBody.action === "complete") {
    return completeAuthorization(req, origin, actionBody);
  }
  if (actionBody.action === "disconnect" && actionBody.ledgerId) {
    return disconnect(req, origin, actionBody.ledgerId);
  }
  if (actionBody.action === "reset" && actionBody.ledgerId) {
    return resetSharedGrantAttempt(req, origin, actionBody.ledgerId);
  }
  return json({ error: "Unknown action" }, 400, origin);
});
