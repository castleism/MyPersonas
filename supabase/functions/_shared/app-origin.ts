// Exact, environment-bound browser-origin policy shared by MyPersonas Edge
// Functions. Configuration errors intentionally throw during module startup so
// a function cannot silently fall back to another environment's trust boundary.

export type AppOriginEnvReader = (name: string) => string | undefined;

export const DEPLOYMENT_ENVIRONMENT_ENV = "MYPERSONAS_DEPLOYMENT_ENVIRONMENT";
export const STAGING_PROJECT_REF_ENV = "MYPERSONAS_STAGING_PROJECT_REF";
export const LEGACY_APP_ORIGINS_ENV = "MYPERSONAS_APP_ORIGINS";
export const PRODUCTION_SUPABASE_PROJECT_REF = "nwsqyuucwzihruszocge";
export const PRODUCTION_SUPABASE_URL =
  `https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`;

export const PRODUCTION_APP_ORIGINS = Object.freeze([
  "https://aliaspaces.com",
  "https://www.aliaspaces.com",
  "https://app.aliaspaces.com",
  "https://mypersonas.online",
]);

export const STAGING_APP_ORIGINS = Object.freeze([
  "https://mypersonas-staging.pages.dev",
  "https://staging.mypersonas.online",
]);

const CONFIGURATION_ERROR =
  "Invalid MyPersonas app origin environment configuration";
const PROJECT_REF = /^[a-z0-9]{20}$/;

function configurationError(): never {
  throw new Error(CONFIGURATION_ERROR);
}

function exactSupabaseUrl(raw: string): string {
  if (!raw || raw.length > 128 || /[\u0000-\u0020\u007f]/.test(raw)) {
    return configurationError();
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return configurationError();
  }

  if (
    parsed.protocol !== "https:" || parsed.origin !== raw || parsed.port ||
    parsed.username || parsed.password || parsed.pathname !== "/" ||
    parsed.search || parsed.hash ||
    !/^[a-z0-9]{20}\.supabase\.co$/.test(parsed.hostname)
  ) {
    return configurationError();
  }
  return raw;
}

function exactProjectRef(raw: string): string {
  if (!PROJECT_REF.test(raw)) return configurationError();
  return raw;
}

export function loadAppOrigins(
  env: AppOriginEnvReader,
): ReadonlySet<string> {
  // The earlier free-form override is deliberately rejected. Otherwise one
  // mistaken project-wide value could make production trust staging or vice
  // versa even when SUPABASE_URL points at the correct database.
  if ((env(LEGACY_APP_ORIGINS_ENV) ?? "") !== "") {
    return configurationError();
  }

  const deploymentEnvironment = env(DEPLOYMENT_ENVIRONMENT_ENV) ?? "";
  const supabaseUrl = exactSupabaseUrl(env("SUPABASE_URL") ?? "");
  const stagingProjectRef = env(STAGING_PROJECT_REF_ENV) ?? "";

  if (deploymentEnvironment === "production") {
    if (stagingProjectRef || supabaseUrl !== PRODUCTION_SUPABASE_URL) {
      return configurationError();
    }
    return new Set(PRODUCTION_APP_ORIGINS);
  }

  if (deploymentEnvironment === "staging") {
    const projectRef = exactProjectRef(stagingProjectRef);
    if (
      projectRef === PRODUCTION_SUPABASE_PROJECT_REF ||
      supabaseUrl !== `https://${projectRef}.supabase.co`
    ) {
      return configurationError();
    }
    return new Set(STAGING_APP_ORIGINS);
  }

  return configurationError();
}
