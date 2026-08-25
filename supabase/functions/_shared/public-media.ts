export const MAX_PUBLIC_MEDIA_BYTES = 15 * 1024 * 1024;

export const PUBLIC_MEDIA_ORIGIN = "https://media.mypersonas.online";
export const PUBLIC_MEDIA_PATH_PREFIX = "/persona/v1/";
export const PRODUCTION_SUPABASE_ORIGIN = "https://nwsqyuucwzihruszocge.supabase.co";
export const PUBLIC_MEDIA_EDGE_PATH_PREFIX = "/functions/v1/public-media/";
export const PUBLIC_MEDIA_GATEWAY_HEADER = "x-mypersonas-media-gateway";
const SUPABASE_ORIGIN = /^https:\/\/[a-z0-9]{20}[.]supabase[.]co$/;
const DELIVERY_ORIGIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?[.]mypersonas[.]online$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const STORAGE_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/published\/provenance\/(none|assisted|generated|unknown)\/(uploaded|generated)\/(?:[a-z0-9_-]{1,64}\/){2,7}[0-9a-f]{64}\.(png|jpg|webp|gif|mp4|webm)$/;
const MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/mp4",
  "video/webm",
]);

export type PublicMediaResolution = Readonly<{
  bucket: "persona-media";
  storage_path: string;
  mime_type: string;
  byte_size: number;
  content_sha256: string;
}>;

export type MediaEnvironmentConfig = Readonly<{
  environmentName: "production" | "staging";
  supabaseOrigin: string;
  publicMediaOrigin: string;
  revision: number;
  configurationEvidence: string;
  lockedAt: string;
}>;

export type MediaEnvironmentRpc = {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

/** Accept only the canonical hosted Supabase project-origin spelling. */
export function canonicalSupabaseOrigin(raw: string): string | null {
  if (!SUPABASE_ORIGIN.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    return parsed.origin === raw && !parsed.username && !parsed.password &&
        !parsed.port && parsed.pathname === "/" && !parsed.search && !parsed.hash
      ? raw
      : null;
  } catch {
    return null;
  }
}

/** Accept only an exact, HTTPS MyPersonas media subdomain with no URL suffix. */
export function canonicalPublicMediaOrigin(raw: string): string | null {
  if (!DELIVERY_ORIGIN.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    return parsed.origin === raw && !parsed.username && !parsed.password &&
        !parsed.port && parsed.pathname === "/" && !parsed.search && !parsed.hash
      ? raw
      : null;
  } catch {
    return null;
  }
}

/**
 * Read the reviewed, locked project media boundary through its service-only
 * RPC and bind it to this function's canonical SUPABASE_URL. A copied service
 * key or a staging function pointed at production therefore fails closed.
 */
export async function loadMediaEnvironmentConfig(
  admin: MediaEnvironmentRpc,
  supabaseUrl: string,
): Promise<MediaEnvironmentConfig> {
  const currentOrigin = canonicalSupabaseOrigin(supabaseUrl);
  if (!currentOrigin) throw new Error("SUPABASE_URL is not a canonical hosted project origin");
  const result = await admin.rpc("media_environment_config_service", {});
  const raw = Array.isArray(result.data) ? result.data[0] : result.data;
  if (result.error || !raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Media environment configuration is unavailable");
  }
  const row = raw as Record<string, unknown>;
  const keys = Object.keys(row).sort().join(",");
  if (keys !== "configuration_evidence,environment_name,locked_at,public_media_origin,revision,supabase_origin" ||
      (row.environment_name !== "production" && row.environment_name !== "staging") ||
      typeof row.supabase_origin !== "string" ||
      canonicalSupabaseOrigin(row.supabase_origin) !== row.supabase_origin ||
      row.supabase_origin !== currentOrigin ||
      typeof row.public_media_origin !== "string" ||
      canonicalPublicMediaOrigin(row.public_media_origin) !== row.public_media_origin ||
      !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 ||
      typeof row.configuration_evidence !== "string" ||
      row.configuration_evidence.length < 8 || row.configuration_evidence.length > 500 ||
      typeof row.locked_at !== "string" || !Number.isFinite(Date.parse(row.locked_at))) {
    throw new Error("Media environment configuration is unsafe");
  }
  if (row.environment_name === "production" &&
      (row.supabase_origin !== PRODUCTION_SUPABASE_ORIGIN || row.public_media_origin !== PUBLIC_MEDIA_ORIGIN)) {
    throw new Error("Production media environment does not match the production boundary");
  }
  if (row.environment_name === "staging" &&
      (row.supabase_origin === PRODUCTION_SUPABASE_ORIGIN || row.public_media_origin === PUBLIC_MEDIA_ORIGIN)) {
    throw new Error("Staging media environment overlaps the production boundary");
  }
  return Object.freeze({
    environmentName: row.environment_name,
    supabaseOrigin: row.supabase_origin,
    publicMediaOrigin: row.public_media_origin,
    revision: Number(row.revision),
    configurationEvidence: row.configuration_evidence,
    lockedAt: row.locked_at,
  });
}

function publicMediaIdFromExactUrl(
  raw: string,
  origin: string,
  pathPrefix: string,
): string | null {
  if (!raw || raw.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.username || url.password ||
      url.search || url.hash || /%[0-9a-f]{2}/i.test(url.pathname)) return null;
  const match = url.pathname.match(new RegExp(`^${pathPrefix.replaceAll("/", "\\/")}([0-9a-f-]{36})$`));
  if (!match || !UUID_V4.test(match[1])) return null;
  const publicId = match[1];
  // URL canonicalization erases dot segments, default ports, and host casing.
  // Compare the caller-supplied bytes with the only canonical spelling after
  // parsing so aliases cannot become valid opaque media references.
  if (raw !== `${origin}${pathPrefix}${publicId}`) return null;
  return publicId;
}

/** Parse the only URL that may be persisted in a public content field. */
export function publicMediaIdFromRequestUrl(
  raw: string,
  publicMediaOrigin = PUBLIC_MEDIA_ORIGIN,
): string | null {
  const origin = canonicalPublicMediaOrigin(publicMediaOrigin);
  return origin ? publicMediaIdFromExactUrl(raw, origin, PUBLIC_MEDIA_PATH_PREFIX) : null;
}

/** Parse the rewritten request received from the secret-gated CloudFront origin. */
export function publicMediaIdFromOriginRequestUrl(
  raw: string,
  supabaseUrl: string,
): string | null {
  const origin = canonicalSupabaseOrigin(supabaseUrl);
  return origin ? publicMediaIdFromExactUrl(raw, origin, PUBLIC_MEDIA_EDGE_PATH_PREFIX) : null;
}

export function publicMediaDeliveryUrl(
  publicId: string,
  publicMediaOrigin = PUBLIC_MEDIA_ORIGIN,
): string {
  if (!UUID_V4.test(publicId)) throw new Error("Invalid public media id");
  const origin = canonicalPublicMediaOrigin(publicMediaOrigin);
  if (!origin) throw new Error("Invalid public media origin");
  return `${origin}${PUBLIC_MEDIA_PATH_PREFIX}${publicId}`;
}

export async function readExactPublicMediaResponse(
  response: Response,
  expectedBytes: number,
): Promise<Uint8Array> {
  if (!(response instanceof Response) || response.status !== 200 || response.redirected || !response.body ||
      !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_PUBLIC_MEDIA_BYTES) {
    throw new Error("Unsafe public media Storage response");
  }
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d{1,8}$/.test(declared) || Number(declared) !== expectedBytes)) {
    throw new Error("Public media Storage length changed");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("Invalid public media Storage chunk");
      total += value.byteLength;
      if (total > expectedBytes || total > MAX_PUBLIC_MEDIA_BYTES) {
        throw new Error("Public media Storage response exceeded its bound");
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  if (total !== expectedBytes) throw new Error("Public media Storage length changed");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function validatePublicMediaResolution(value: unknown): PublicMediaResolution {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid public media resolution");
  }
  const row = value as Record<string, unknown>;
  const allowed = new Set(["bucket", "storage_path", "mime_type", "byte_size", "content_sha256"]);
  if (Object.keys(row).some((key) => !allowed.has(key)) ||
      row.bucket !== "persona-media" || typeof row.storage_path !== "string" ||
      !STORAGE_PATH.test(row.storage_path) || row.storage_path.includes("..") ||
      typeof row.mime_type !== "string" || !MIME.has(row.mime_type) ||
      typeof row.byte_size !== "number" || !Number.isSafeInteger(row.byte_size) ||
      row.byte_size < 1 || row.byte_size > MAX_PUBLIC_MEDIA_BYTES ||
      typeof row.content_sha256 !== "string" || !SHA256.test(row.content_sha256)) {
    throw new Error("Unsafe public media resolution");
  }
  return Object.freeze({
    bucket: "persona-media",
    storage_path: row.storage_path,
    mime_type: row.mime_type,
    byte_size: row.byte_size,
    content_sha256: row.content_sha256,
  });
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function verifyResolvedPublicMedia(
  bytes: Uint8Array,
  resolution: PublicMediaResolution,
): Promise<void> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== resolution.byte_size ||
      bytes.byteLength < 1 || bytes.byteLength > MAX_PUBLIC_MEDIA_BYTES) {
    throw new Error("Public media byte size changed");
  }
  if (await sha256Hex(bytes) !== resolution.content_sha256) {
    throw new Error("Public media content hash changed");
  }
}

export function publicMediaResponseHeaders(
  resolution: PublicMediaResolution,
): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store, max-age=0",
    "Content-Disposition": "inline",
    "Content-Length": String(resolution.byte_size),
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Content-Type": resolution.mime_type,
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
}
