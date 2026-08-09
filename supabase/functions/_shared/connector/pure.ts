// Shared connector core — pure helpers (no I/O, no Deno globals).
// First slice of the CONNECTOR-CORE-DESIGN.md refactor. ADDITIVE: nothing imports
// this yet, so deployed behavior is unchanged. Adopt incrementally per that doc.
//
// These mirror the pure logic currently inlined in the connector functions
// (esp. meta-oauth). The Node test suite in tests/lib/meta-helpers.mjs keeps a
// parallel copy until a build step lets both import one module (design doc step 2).
// Keep the two in sync when either changes.

export type InstagramAsset = {
  id: string;
  username: string;
  name: string;
  account_type: string;
};

export type Binding = {
  pageId: string;
  facebookLedgerId: string;
  instagramLedgerId?: string;
};

/** Meta/Graph numeric object id (page/ig/user). */
export function validProviderId(value: unknown): boolean {
  return /^[0-9]{1,64}$/.test(String(value ?? ""));
}

/** App ledger row id (UUID v1–5). */
export function validLedgerId(value: unknown): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(String(value ?? ""));
}

/** Dedup + trim + validate + sort a scope list from an array or delimited string. */
export function normalizeScopes(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value.split(/[,\s]+/)
    : [];
  return [
    ...new Set(
      values.map((scope) => String(scope ?? "").trim()).filter(
        (scope) => /^[A-Za-z0-9_.:-]{1,128}$/.test(scope),
      ),
    ),
  ].sort();
}

/**
 * Prefer an absolute expiry (unix seconds); fall back to relative expires_in
 * (seconds). Reject anything outside a sane 60s..400d window. Returns an ISO
 * string or "". `now` is injectable for testing.
 */
export function safeExpiry(
  expiresAtSeconds: unknown,
  expiresInSeconds?: unknown,
  now: number = Date.now(),
): string {
  const absolute = Number(expiresAtSeconds);
  if (
    Number.isFinite(absolute) &&
    absolute * 1000 > now + 60_000 &&
    absolute * 1000 < now + 400 * 24 * 60 * 60 * 1000
  ) {
    return new Date(absolute * 1000).toISOString();
  }
  const relative = Number(expiresInSeconds);
  if (
    Number.isFinite(relative) &&
    relative >= 60 &&
    relative <= 400 * 24 * 60 * 60
  ) {
    return new Date(now + relative * 1000).toISOString();
  }
  return "";
}

/**
 * Build a linked Instagram asset from a page's inline-expanded
 * instagram_business_account{...} field. Keeps the IG whenever a valid id is
 * present so it is always offered for pairing (the 2026-08-08 fix).
 */
export function instagramAssetFromLinked(
  linked: Record<string, unknown> | null | undefined,
): InstagramAsset | null {
  if (!linked || !validProviderId(linked.id)) return null;
  return {
    id: String(linked.id),
    username: typeof linked.username === "string"
      ? linked.username.trim().slice(0, 255)
      : "",
    name: typeof linked.name === "string"
      ? linked.name.trim().slice(0, 255)
      : "",
    account_type: typeof linked.account_type === "string"
      ? linked.account_type.trim().slice(0, 64)
      : "",
  };
}

/** Validate + de-duplicate the pairing bindings a browser posts at finalize. */
export function parseBindings(value: unknown): Binding[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    return null;
  }
  const result: Binding[] = [];
  const pages = new Set<string>();
  const ledgers = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    const pageId = String(record.pageId ?? "").trim();
    const facebookLedgerId = String(record.facebookLedgerId ?? "").trim();
    const instagramLedgerId = String(record.instagramLedgerId ?? "").trim();
    if (
      !validProviderId(pageId) ||
      !validLedgerId(facebookLedgerId) ||
      (instagramLedgerId && !validLedgerId(instagramLedgerId)) ||
      pages.has(pageId) ||
      ledgers.has(facebookLedgerId) ||
      (instagramLedgerId && ledgers.has(instagramLedgerId)) ||
      instagramLedgerId === facebookLedgerId
    ) {
      return null;
    }
    pages.add(pageId);
    ledgers.add(facebookLedgerId);
    if (instagramLedgerId) ledgers.add(instagramLedgerId);
    result.push({
      pageId,
      facebookLedgerId,
      ...(instagramLedgerId ? { instagramLedgerId } : {}),
    });
  }
  return result;
}

/** Normalize an email/identifier before an exact-match compare or a ledger write. */
export function normalizeEmail(value: unknown): string {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}
