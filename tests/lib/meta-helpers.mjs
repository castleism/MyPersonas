// Pure helpers mirrored from supabase/functions/meta-oauth/index.ts and the
// frontend, extracted here so they can be unit-tested in Node without the Deno
// runtime. Keep these BYTE-FOR-LOGIC identical to the source until the shared
// "connector core" (see ARCHITECTURE-REVIEW.md P2) is extracted, at which point
// both the edge function and these tests should import from one module.
//
// Source of truth today: supabase/functions/meta-oauth/index.ts

export function validProviderId(value) {
  return /^[0-9]{1,64}$/.test(String(value ?? ""));
}

export function validLedgerId(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

export function normalizeScopes(value) {
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

// Absolute expiry (seconds) preferred; else relative expires_in (seconds).
// Rejects values outside a sane 60s..400d window. Returns ISO string or "".
export function safeExpiry(expiresAtSeconds, expiresInSeconds, now = Date.now()) {
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

// The IG fix (2026-08-08): build the linked Instagram asset from the page's
// inline-expanded instagram_business_account{...} field. Keeps the IG whenever a
// valid id is present so it is always offered for pairing.
export function instagramAssetFromLinked(linked) {
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

// Validates the pairing bindings posted by the browser at finalize. Returns a
// cleaned array, or null if anything is invalid/duplicated.
export function parseBindings(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    return null;
  }
  const result = [];
  const pages = new Set();
  const ledgers = new Set();
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const record = item;
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

// Frontend helper (new, 2026-08-08): normalize an email/identifier before saving
// to account_ledger.login_email. Prevents the girl.gamers.wp vs girl.gamer.wp
// class of exact-match failures. Returns "" for invalid input.
export function normalizeLoginEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!email) return "";
  // Conservative RFC-ish check: single @, no spaces, a dotted domain.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}
