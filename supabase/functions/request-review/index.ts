import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TURNSTILE_RESPONSE_BYTES = 16 * 1024;
const TURNSTILE_TIMEOUT_MS = 5_000;
const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const ACCEPTED_MESSAGE =
  "Request received. The owner decides what to test or review.";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const HANDLE_RE = /^[a-z0-9._]{3,30}$/;
const BLOCKED_HOSTS = new Set(["localhost", "localhost.localdomain"]);
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home",
  ".corp",
  ".localdomain",
];

type RuntimeConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
  allowedOrigin: string;
  turnstileSecret: string;
  turnstileAction: string;
  turnstileHostname: string;
  hmacSecret: string;
};

type Intake = {
  personaHandle: string;
  productName: string;
  productUrl: string;
  requesterName: string;
  requesterEmail: string;
  reason: string;
  consentToReply: boolean;
  marketingConsent: boolean;
  idempotencyKey: string;
  turnstileToken: string;
};

type TurnstileResult = {
  success?: boolean;
  action?: string;
  hostname?: string;
};

class PublicError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function exactHttpsOrigin(value: string): string {
  const candidate = value.trim();
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      candidate !== parsed.origin
    ) return "";
    return parsed.origin;
  } catch {
    return "";
  }
}

function configuredHostname(value: string): string {
  const candidate = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    !candidate ||
    candidate.length > 253 ||
    candidate.includes(":") ||
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      candidate,
    )
  ) return "";
  return candidate;
}

function loadConfig(): RuntimeConfig | null {
  const supabaseUrl = exactHttpsOrigin(Deno.env.get("SUPABASE_URL") ?? "");
  const serviceRoleKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const allowedOrigin = exactHttpsOrigin(
    Deno.env.get("REQUEST_REVIEW_ALLOWED_ORIGIN") ?? "",
  );
  const turnstileSecret = (Deno.env.get("TURNSTILE_SECRET_KEY") ?? "").trim();
  const turnstileAction = (
    Deno.env.get("REQUEST_REVIEW_TURNSTILE_ACTION") ?? ""
  ).trim();
  const turnstileHostname = configuredHostname(
    Deno.env.get("REQUEST_REVIEW_TURNSTILE_HOSTNAME") ?? "",
  );
  const hmacSecret = Deno.env.get("REQUEST_REVIEW_HMAC_SECRET") ?? "";
  if (
    !supabaseUrl ||
    serviceRoleKey.length < 32 ||
    !allowedOrigin ||
    turnstileSecret.length < 10 ||
    !/^[a-z0-9_-]{1,64}$/i.test(turnstileAction) ||
    !turnstileHostname ||
    new TextEncoder().encode(hmacSecret).byteLength < 32
  ) return null;
  return {
    supabaseUrl,
    serviceRoleKey,
    allowedOrigin,
    turnstileSecret,
    turnstileAction,
    turnstileHostname,
    hmacSecret,
  };
}

function responseHeaders(allowedOrigin = ""): Record<string, string> {
  return {
    ...(allowedOrigin
      ? {
        "Access-Control-Allow-Origin": allowedOrigin,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      }
      : {}),
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
}

function json(
  body: Record<string, unknown>,
  status: number,
  allowedOrigin = "",
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...responseHeaders(allowedOrigin), ...extraHeaders },
  });
}

function neutralAccepted(allowedOrigin: string): Response {
  return json({ success: true, message: ACCEPTED_MESSAGE }, 202, allowedOrigin);
}

async function readBoundedJson(req: Request): Promise<Record<string, unknown>> {
  const contentType = (req.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new PublicError(415, "Content-Type must be application/json");
  }
  const declaredLength = req.headers.get("content-length");
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_BODY_BYTES)
  ) throw new PublicError(413, "Request body is too large");
  if (!req.body) throw new PublicError(400, "A JSON body is required");

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new PublicError(413, "Request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new PublicError(400, "A JSON body is required");

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new PublicError(400, "Invalid JSON body");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PublicError(400, "JSON body must be an object");
  }
  return parsed as Record<string, unknown>;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function boundedLine(
  raw: unknown,
  label: string,
  maxLength: number,
  required = false,
): string {
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw new PublicError(422, `${label} is required`);
    return "";
  }
  if (typeof raw !== "string") throw new PublicError(422, `${label} is invalid`);
  const value = raw.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    (required && !value) ||
    codePointLength(value) > maxLength ||
    /[<>\u0000-\u001f\u007f]/u.test(value)
  ) throw new PublicError(422, `${label} is invalid`);
  return value;
}

function boundedToken(raw: unknown): string {
  if (typeof raw !== "string") throw new PublicError(422, "Verification is required");
  const value = raw.trim();
  if (
    !value ||
    codePointLength(value) > 4096 ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) throw new PublicError(422, "Verification is required");
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean {
  if (!(key in body)) return false;
  if (typeof body[key] !== "boolean") {
    throw new PublicError(422, `${key} must be true or false`);
  }
  return body[key] as boolean;
}

function normalizeEmail(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") throw new PublicError(422, "Requester email is invalid");
  const email = raw.normalize("NFKC").trim().toLowerCase();
  if (
    codePointLength(email) > 320 ||
    /[\s<>\u0000-\u001f\u007f]/u.test(email) ||
    !/^[^@]+@[^@]+\.[^@]+$/u.test(email)
  ) throw new PublicError(422, "Requester email is invalid");
  return email;
}

function isIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host.includes(":")) return true;
  const parts = host.split(".");
  return parts.length === 4 && parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function normalizeProductUrl(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "";
  if (typeof raw !== "string") throw new PublicError(422, "Product URL is invalid");
  const value = raw.normalize("NFKC").trim();
  if (
    codePointLength(value) > 2048 ||
    /[\s<>\u0000-\u001f\u007f]/u.test(value)
  ) throw new PublicError(422, "Product URL is invalid");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PublicError(422, "Product URL is invalid");
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !hostname ||
    !hostname.includes(".") ||
    isIpLiteral(hostname) ||
    BLOCKED_HOSTS.has(hostname) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  ) throw new PublicError(422, "Product URL is invalid");
  parsed.hash = "";
  return parsed.toString();
}

function normalizeIntake(body: Record<string, unknown>): Intake {
  const personaHandle = boundedLine(
    body.persona_handle ?? body.handle,
    "Persona handle",
    30,
    true,
  ).replace(/^@/, "").toLowerCase();
  if (!HANDLE_RE.test(personaHandle)) {
    throw new PublicError(422, "Persona handle is invalid");
  }
  const productName = boundedLine(body.product_name, "Product name", 160, true);
  const productUrl = normalizeProductUrl(body.product_url);
  const requesterName = boundedLine(body.requester_name, "Requester name", 100);
  const requesterEmail = normalizeEmail(body.requester_email);
  const reason = boundedLine(body.reason, "Reason", 1500);
  const consentToReply = optionalBoolean(body, "consent_to_reply");
  const marketingConsent = optionalBoolean(body, "marketing_consent");
  if ((consentToReply || marketingConsent) && !requesterEmail) {
    throw new PublicError(422, "Email consent requires a requester email");
  }
  const idempotencyKey = boundedLine(
    body.idempotency_key,
    "Idempotency key",
    36,
    true,
  ).toLowerCase();
  if (!UUID_RE.test(idempotencyKey) || idempotencyKey === NIL_UUID) {
    throw new PublicError(422, "Idempotency key is invalid");
  }
  const turnstileToken = boundedToken(
    body.turnstile_token ?? body.captcha_token ?? body["cf-turnstile-response"],
  );
  return {
    personaHandle,
    productName,
    productUrl,
    requesterName,
    requesterEmail,
    reason,
    consentToReply,
    marketingConsent,
    idempotencyKey,
    turnstileToken,
  };
}

function normalizedIp(raw: string): string {
  const candidate = raw.trim().toLowerCase();
  if (!candidate || candidate.length > 64 || !/^[0-9a-f:.]+$/i.test(candidate)) {
    return "";
  }
  const ipv4Parts = candidate.split(".");
  if (
    ipv4Parts.length === 4 &&
    ipv4Parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  ) return ipv4Parts.map((part) => String(Number(part))).join(".");
  if (!candidate.includes(":") || candidate.includes("%")) return "";
  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    return hostname.replace(/^\[|\]$/g, "");
  } catch {
    return "";
  }
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",", 1)[0] ?? "";
  for (const candidate of [
    req.headers.get("cf-connecting-ip") ?? "",
    forwarded,
    req.headers.get("x-real-ip") ?? "",
  ]) {
    const value = normalizedIp(candidate);
    if (value) return value;
  }
  return "";
}

async function verifyTurnstile(
  token: string,
  ip: string,
  config: RuntimeConfig,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURNSTILE_TIMEOUT_MS);
  try {
    const form = new URLSearchParams({
      secret: config.turnstileSecret,
      response: token,
      remoteip: ip,
    });
    const response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) throw new PublicError(503, "Service temporarily unavailable");
    const text = await response.text();
    if (!text || text.length > MAX_TURNSTILE_RESPONSE_BYTES) {
      throw new PublicError(503, "Service temporarily unavailable");
    }
    let result: TurnstileResult;
    try {
      result = JSON.parse(text) as TurnstileResult;
    } catch {
      throw new PublicError(503, "Service temporarily unavailable");
    }
    const hostname = configuredHostname(String(result.hostname ?? ""));
    return result.success === true &&
      result.action === config.turnstileAction &&
      hostname === config.turnstileHostname;
  } catch (error) {
    if (error instanceof PublicError) throw error;
    throw new PublicError(503, "Service temporarily unavailable");
  } finally {
    clearTimeout(timer);
  }
}

async function hmacHex(key: CryptoKey, value: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function rotatingHashes(
  secret: string,
  ip: string,
  email: string,
): Promise<{ fingerprint: string; emailHash: string }> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const rotation = new Date().toISOString().slice(0, 10);
  const fingerprint = await hmacHex(
    key,
    `request-review:fingerprint:v1:${rotation}:${ip}`,
  );
  const emailHash = email
    ? await hmacHex(key, `request-review:email:v1:${rotation}:${email}`)
    : "";
  return { fingerprint, emailHash };
}

Deno.serve(async (req: Request) => {
  const config = loadConfig();
  const requestOrigin = req.headers.get("origin") ?? "";
  if (!config) {
    return json({ error: "Service temporarily unavailable" }, 503);
  }
  if (requestOrigin !== config.allowedOrigin) {
    return json({ error: "Origin not allowed" }, 403);
  }
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: responseHeaders(config.allowedOrigin),
    });
  }
  if (req.method !== "POST") {
    return json(
      { error: "Method not allowed" },
      405,
      config.allowedOrigin,
      { Allow: "POST, OPTIONS" },
    );
  }

  try {
    const body = await readBoundedJson(req);
    const intake = normalizeIntake(body);
    const ip = clientIp(req);
    if (!ip) throw new PublicError(503, "Service temporarily unavailable");
    if (!await verifyTurnstile(intake.turnstileToken, ip, config)) {
      throw new PublicError(403, "Verification failed");
    }
    const { fingerprint, emailHash } = await rotatingHashes(
      config.hmacSecret,
      ip,
      intake.requesterEmail,
    );
    const admin = createClient(config.supabaseUrl, config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Resolve only a currently published public persona. The final service RPC
    // repeats every feature, mailbox, global-pause, and publication-current gate.
    const { data: persona, error: personaError } = await admin
      .from("personas")
      .select("id")
      .eq("handle", intake.personaHandle)
      .eq("visibility", "public")
      .eq("publication_state", "published")
      .maybeSingle();
    if (personaError) {
      throw new PublicError(503, "Service temporarily unavailable");
    }
    if (!persona?.id) return neutralAccepted(config.allowedOrigin);

    const { data, error } = await admin.rpc(
      "accept_product_review_request_service",
      {
        p_persona_id: persona.id,
        p_idempotency_key: intake.idempotencyKey,
        p_requester_email: intake.requesterEmail,
        p_requester_name: intake.requesterName,
        p_product_name: intake.productName,
        p_product_url: intake.productUrl,
        p_reason: intake.reason,
        p_consent_to_reply: intake.consentToReply,
        p_marketing_consent: intake.marketingConsent,
        p_request_fingerprint: fingerprint,
        p_requester_email_hash: emailHash,
      },
    );
    if (error) throw new PublicError(503, "Service temporarily unavailable");
    const disposition = String(data?.disposition ?? "");
    if (!["accepted", "duplicate", "suppressed"].includes(disposition)) {
      throw new PublicError(503, "Service temporarily unavailable");
    }
    return neutralAccepted(config.allowedOrigin);
  } catch (error) {
    if (error instanceof PublicError) {
      return json({ error: error.message }, error.status, config.allowedOrigin);
    }
    return json(
      { error: "Service temporarily unavailable" },
      503,
      config.allowedOrigin,
    );
  }
});
