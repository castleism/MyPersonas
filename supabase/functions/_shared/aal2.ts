export type AssuranceClaims = Record<string, unknown> & {
  aal?: unknown;
  sub?: unknown;
};

export type AuthUser = { id: string };

export type AuthClient = {
  auth: {
    getUser: (jwt: string) => Promise<{
      data: { user: AuthUser | null };
      error: { message?: string } | null;
    }>;
  };
};

export type Aal2GuardResult =
  | {
    ok: true;
    status: 200;
    token: string;
    user: AuthUser;
    claims: AssuranceClaims;
  }
  | {
    ok: false;
    status: 401 | 403;
    error: string;
    code: "authentication_required" | "aal2_required";
  };

function decodeBase64Url(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function jwtClaims(token: string): AssuranceClaims | null {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const claims = JSON.parse(decodeBase64Url(parts[1]));
    return claims && typeof claims === "object" && !Array.isArray(claims)
      ? claims as AssuranceClaims
      : null;
  } catch {
    return null;
  }
}

export function hasAal2(claims: unknown): boolean {
  return !!claims && typeof claims === "object" &&
    (claims as AssuranceClaims).aal === "aal2";
}

// getUser validates the JWT before its decoded assurance claim is trusted.
export async function requireAal2(
  req: Request,
  authClient: AuthClient,
): Promise<Aal2GuardResult> {
  const authorization = req.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+$/i.test(authorization)) {
    return {
      ok: false,
      status: 401,
      code: "authentication_required",
      error: "Sign in first",
    };
  }
  const token = authorization.replace(/^Bearer\s+/i, "");
  const validated = await authClient.auth.getUser(token);
  const user = validated.data?.user || null;
  if (validated.error || !user?.id) {
    return {
      ok: false,
      status: 401,
      code: "authentication_required",
      error: "Sign in again",
    };
  }
  const claims = jwtClaims(token);
  if (!claims || claims.sub !== user.id) {
    return {
      ok: false,
      status: 401,
      code: "authentication_required",
      error: "Sign in again",
    };
  }
  if (!hasAal2(claims)) {
    return {
      ok: false,
      status: 403,
      code: "aal2_required",
      error: "Two-factor verification required",
    };
  }
  return { ok: true, status: 200, token, user, claims };
}
