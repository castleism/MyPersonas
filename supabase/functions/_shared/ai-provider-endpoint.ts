export type AiProviderEndpointKind = "openai" | "anthropic" | "azure";

export type AiProviderEndpoint = {
  url: URL;
  host: string;
  kind: AiProviderEndpointKind;
  provider: string;
};

export type AiProviderEndpointError = {
  error: string;
  code: string;
};

type FixedProviderPolicy = {
  id: string;
  aliases: string[];
  hosts: string[];
  kind: Exclude<AiProviderEndpointKind, "azure">;
  paths: Record<string, string>;
};

const FIXED_PROVIDER_POLICIES: FixedProviderPolicy[] = [
  {
    id: "openrouter",
    aliases: ["openrouter"],
    hosts: ["openrouter.ai"],
    kind: "openai",
    paths: {
      "/api/v1": "/api/v1/chat/completions",
      "/api/v1/chat/completions": "/api/v1/chat/completions",
    },
  },
  {
    id: "openai",
    aliases: ["openai"],
    hosts: ["api.openai.com"],
    kind: "openai",
    paths: {
      "/v1": "/v1/chat/completions",
      "/v1/chat/completions": "/v1/chat/completions",
    },
  },
  {
    id: "anthropic",
    aliases: ["anthropic", "claude"],
    hosts: ["api.anthropic.com"],
    kind: "anthropic",
    paths: {
      "/v1": "/v1/messages",
      "/v1/messages": "/v1/messages",
    },
  },
  {
    id: "google",
    aliases: ["google", "googleai", "gemini"],
    hosts: ["generativelanguage.googleapis.com"],
    kind: "openai",
    paths: {
      "/v1beta/openai": "/v1beta/openai/chat/completions",
      "/v1beta/openai/chat/completions":
        "/v1beta/openai/chat/completions",
    },
  },
  {
    id: "xai",
    aliases: ["xai", "grok"],
    hosts: ["api.x.ai"],
    kind: "openai",
    paths: {
      "/v1": "/v1/chat/completions",
      "/v1/chat/completions": "/v1/chat/completions",
    },
  },
  {
    id: "groq",
    aliases: ["groq"],
    hosts: ["api.groq.com"],
    kind: "openai",
    paths: {
      "/openai/v1": "/openai/v1/chat/completions",
      "/openai/v1/chat/completions": "/openai/v1/chat/completions",
    },
  },
  {
    id: "mistral",
    aliases: ["mistral", "mistralai"],
    hosts: ["api.mistral.ai"],
    kind: "openai",
    paths: {
      "/v1": "/v1/chat/completions",
      "/v1/chat/completions": "/v1/chat/completions",
    },
  },
  {
    id: "deepseek",
    aliases: ["deepseek"],
    hosts: ["api.deepseek.com"],
    kind: "openai",
    paths: {
      "": "/chat/completions",
      "/chat/completions": "/chat/completions",
      // Keep already-saved connections working while new UI defaults use the
      // provider's current root base URL. This is still a finite owned path.
      "/v1": "/v1/chat/completions",
      "/v1/chat/completions": "/v1/chat/completions",
    },
  },
  {
    id: "together",
    aliases: ["together", "togetherai"],
    // .xyz is retained as a finite legacy hostname for existing records. New
    // connections use the provider's current .ai hostname.
    hosts: ["api.together.ai", "api.together.xyz"],
    kind: "openai",
    paths: {
      "/v1": "/v1/chat/completions",
      "/v1/chat/completions": "/v1/chat/completions",
    },
  },
  {
    id: "fireworks",
    aliases: ["fireworks", "fireworksai"],
    hosts: ["api.fireworks.ai"],
    kind: "openai",
    paths: {
      "/inference/v1": "/inference/v1/chat/completions",
      "/inference/v1/chat/completions":
        "/inference/v1/chat/completions",
    },
  },
  {
    id: "perplexity",
    aliases: ["perplexity", "perplexityai"],
    hosts: ["api.perplexity.ai"],
    kind: "openai",
    paths: {
      "": "/chat/completions",
      "/chat/completions": "/chat/completions",
    },
  },
  {
    id: "cohere",
    aliases: ["cohere", "cohereai"],
    hosts: ["api.cohere.ai"],
    kind: "openai",
    paths: {
      "/compatibility/v1": "/compatibility/v1/chat/completions",
      "/compatibility/v1/chat/completions":
        "/compatibility/v1/chat/completions",
    },
  },
];

const PROVIDER_BY_ALIAS = new Map(
  FIXED_PROVIDER_POLICIES.flatMap((policy) =>
    policy.aliases.map((alias) => [alias, policy] as const)
  ),
);

const AZURE_ALIASES = new Set([
  "azure",
  "azureopenai",
  "microsoftazureopenai",
]);
const EXPLICITLY_UNSUPPORTED = new Set(["elevenlabs", "ollama", "lmstudio"]);
const AZURE_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.openai\.azure\.com$/;
const AZURE_DEPLOYMENT_PATH_PATTERN =
  /^\/openai\/deployments\/([A-Za-z0-9._-]{1,128})(\/chat\/completions)?$/;
const IPV4_SHAPE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const AZURE_RESOURCE_PLACEHOLDERS = new Set([
  "yourresource",
  "yourresourcename",
  "yourazureopenairesource",
  "yourazureopenairesourcename",
  "resourcename",
  "azureopenairesourcename",
]);
const AZURE_DEPLOYMENT_PLACEHOLDERS = new Set([
  "yourdeployment",
  "yourdeploymentname",
  "yourazuredeployment",
  "yourazuredeploymentname",
  "yourazureopenaideployment",
  "yourazureopenaideploymentname",
  "deploymentname",
  "azuredeploymentname",
  "azureopenaideploymentname",
]);

function normalizedProvider(value: unknown) {
  return (typeof value === "string" ? value : String(value ?? ""))
    .trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function rawBaseUrl(value: unknown) {
  return typeof value === "string" ? value : String(value ?? "");
}

function endpointError(error: string, code: string): AiProviderEndpointError {
  return { error, code };
}

function isIpLiteral(hostname: string) {
  const host = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (host.includes(":")) return true;
  if (!IPV4_SHAPE.test(host)) return false;
  return host.split(".").every((part) => Number(part) <= 255);
}

function normalizedPath(pathname: string) {
  return pathname === "/" ? "" : pathname.replace(/\/+$/, "");
}

function canonicalTemplateToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isAzureTemplatePlaceholder(value: string, kind: "resource" | "deployment") {
  const token = canonicalTemplateToken(value);
  return (kind === "resource"
    ? AZURE_RESOURCE_PLACEHOLDERS
    : AZURE_DEPLOYMENT_PLACEHOLDERS).has(token);
}

function validatedApiVersion(extra: Record<string, unknown> | null | undefined) {
  const candidate = extra?.api_version ?? extra?.["api-version"] ??
    "2024-06-01";
  const value = typeof candidate === "string" ? candidate.trim() : "";
  return /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : "";
}

/**
 * Resolve a stored backend to a code-owned provider endpoint.
 *
 * Provider labels select only a finite policy; they never authorize a caller-
 * supplied hostname. Custom/unknown providers intentionally fail closed until
 * a future, separately reviewed allowlist exists.
 */
export function resolveAiProviderEndpoint(input: {
  provider: unknown;
  baseUrl: unknown;
  extra?: Record<string, unknown> | null;
}): AiProviderEndpoint | AiProviderEndpointError {
  const providerLabel = normalizedProvider(input.provider);
  if (EXPLICITLY_UNSUPPORTED.has(providerLabel)) {
    return endpointError(
      "This model type is not supported by the hosted persona text proxy.",
      "backend_provider_unsupported",
    );
  }
  const policy = PROVIDER_BY_ALIAS.get(providerLabel);
  const isAzure = AZURE_ALIASES.has(providerLabel);
  if (!policy && !isAzure) {
    return endpointError(
      "This provider has no reviewed hosted endpoint policy.",
      "backend_provider_unknown",
    );
  }

  const raw = rawBaseUrl(input.baseUrl);
  if (
    !raw || raw.length > 2_048 || raw !== raw.trim() ||
    /[\u0000-\u0020\u007f]/.test(raw)
  ) {
    return endpointError(
      "The linked model has an invalid base URL.",
      "backend_url_invalid",
    );
  }
  if (raw.includes("?") || raw.includes("#") || raw.includes("%") ||
    raw.includes("\\")) {
    return endpointError(
      "The linked model base URL cannot contain a query, fragment, or encoded path.",
      "backend_url_unsafe",
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return endpointError(
      "The linked model has an invalid base URL.",
      "backend_url_invalid",
    );
  }
  if (url.protocol !== "https:") {
    return endpointError(
      "Persona AI requires an HTTPS provider URL.",
      "backend_https_required",
    );
  }

  const authorityMatch = raw.match(/^https:\/\/([^/]+)(?:\/|$)/i);
  const authority = authorityMatch?.[1] ?? "";
  if (
    !authority || authority.includes("@") || authority.includes(":") ||
    url.username || url.password || url.search || url.hash || url.port
  ) {
    return endpointError(
      "The linked model base URL cannot contain credentials or a custom port.",
      "backend_url_unsafe",
    );
  }

  const host = url.hostname.toLowerCase();
  if (isIpLiteral(host)) {
    return endpointError(
      "Provider endpoints cannot use an IP address.",
      "backend_host_ip_literal",
    );
  }
  const path = normalizedPath(url.pathname);

  if (isAzure) {
    if (!AZURE_HOST_PATTERN.test(host)) {
      return endpointError(
        "The Azure provider label does not match this hostname.",
        "backend_provider_host_mismatch",
      );
    }
    const deploymentMatch = path.match(AZURE_DEPLOYMENT_PATH_PATTERN);
    if (!deploymentMatch) {
      return endpointError(
        "Azure OpenAI requires an explicit validated deployment path.",
        "backend_provider_path_invalid",
      );
    }
    const resourceName = host.slice(0, -".openai.azure.com".length);
    if (
      isAzureTemplatePlaceholder(resourceName, "resource") ||
      isAzureTemplatePlaceholder(deploymentMatch[1], "deployment")
    ) {
      return endpointError(
        "Replace the Azure resource and deployment placeholders with real endpoint values.",
        "backend_endpoint_placeholder",
      );
    }
    const apiVersion = validatedApiVersion(input.extra);
    if (!apiVersion) {
      return endpointError(
        "Azure OpenAI has an invalid API version.",
        "backend_azure_api_version_invalid",
      );
    }
    url.pathname = `/openai/deployments/${deploymentMatch[1]}/chat/completions`;
    url.searchParams.set("api-version", apiVersion);
    return { url, host, kind: "azure", provider: "azure" };
  }

  // The unknown-provider guard above and the Azure branch make this
  // unreachable at runtime, but keep a fail-closed guard here so the type
  // checker does not have to infer that relationship across two lookups.
  if (!policy) {
    return endpointError(
      "This provider has no reviewed hosted endpoint policy.",
      "backend_provider_unknown",
    );
  }

  if (!policy.hosts.includes(host)) {
    return endpointError(
      "The provider label does not match this hostname.",
      "backend_provider_host_mismatch",
    );
  }
  const endpointPath = policy.paths[path];
  if (!endpointPath) {
    return endpointError(
      "The linked model path is not approved for this provider.",
      "backend_provider_path_invalid",
    );
  }
  url.pathname = endpointPath;
  return {
    url,
    host,
    kind: policy.kind,
    provider: policy.id,
  };
}
