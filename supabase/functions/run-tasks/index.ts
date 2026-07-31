// run-tasks — generates drafts for precise, due persona schedules.
//
// Deploy without gateway JWT verification; callers must provide CRON_SECRET in
// X-Cron-Secret. The service role is used only after every owner, binding,
// persona, backend, and account assignment has been scoped explicitly.
// Deploy: supabase functions deploy run-tasks --no-verify-jwt
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET") || "";
const MAX_TASK_CANDIDATES_PER_RUN = 8;
const MAX_TASKS_PROCESSED_PER_RUN = 2;
const RUN_WALL_CLOCK_BUDGET_MS = 80_000;
const MIN_TASK_START_BUDGET_MS = 45_000;
const PROVIDER_TIMEOUT_MS = 35_000;
const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;
const MAX_PROVIDER_OUTPUT_CHARS = 40_000;
const MAX_PROVIDER_TOKENS = 1_600;
const MAX_PROVIDER_INPUT_BYTES = 32 * 1024;
const UTF8_ENCODER = new TextEncoder();

const GENERATION_FIELD_LIMITS = {
  personaName: 256,
  personaHandle: 64,
  personaTagline: 512,
  personaBio: 2_048,
  personaPurpose: 1_024,
  personaVoice: 2_048,
  personaTopics: 1_024,
  personaAudience: 1_024,
  personaHashtags: 1_024,
  personaDont: 3_072,
  planGoal: 768,
  planMetric: 512,
  planAudience: 768,
  planPillars: 1_024,
  planCampaign: 768,
  planCallsToAction: 768,
  planOffers: 1_536,
  planDisclosure: 512,
  planSourceNotes: 1_536,
  planPlatformGuidance: 1_024,
  taskName: 256,
  taskInstructions: 4_096,
  destination: 128,
} as const;

const DEFAULT_AI_HOSTS = [
  "api.openai.com",
  "openrouter.ai",
  "api.anthropic.com",
  "api.x.ai",
  "generativelanguage.googleapis.com",
  "api.groq.com",
  "api.mistral.ai",
  "api.deepseek.com",
  "api.together.xyz",
  "api.fireworks.ai",
  "api.perplexity.ai",
  "api.cohere.ai",
];
const ALLOWED_AI_HOSTS = new Set(
  [
    ...DEFAULT_AI_HOSTS,
    ...(Deno.env.get("SCHEDULE_AI_HOSTS") || "").split(","),
  ].map((value) => value.trim().toLowerCase()).filter(Boolean),
);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const JOB_PROMPTS: Record<string, string> = {
  newsplan:
    "Draft a short news-scan content plan: three timely topic ideas with a one-line angle for each.",
  original: "Write one original short social post.",
  repost:
    "Suggest one item worth resharing and write one or two sentences of commentary to accompany it. Do not invent a link or claim that it was already reshared.",
  article:
    "Draft a concise article with a useful title and four short sections.",
  reel:
    "Write a 20-second vertical-video script with a hook, three beats, and a call to action.",
  image:
    "Write one production-ready image prompt followed by a social caption.",
  newsletter:
    "Draft one concise newsletter section with a heading and call to action.",
  promo:
    "Write one promotional post. Include the configured disclosure when an affiliate offer is mentioned.",
  custom:
    "Follow the task instructions exactly while respecting every system rule.",
};

type Settings = {
  automation_paused: boolean;
  default_timezone: string;
  daily_draft_limit: number;
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
};

type Binding = {
  id: string;
  status: string;
  claim_state: string;
  autonomy_level: number;
};

type TaskRow = {
  id: string;
  owner: string;
  persona_id: string | null;
  backend_id: string | null;
  account_id: string | null;
  destination: string | null;
  content_kind: string | null;
  task_type: string | null;
  instructions: string | null;
  name: string;
  timezone: string | null;
  next_run_at: string | null;
  next_publish_at: string | null;
  updated_at: string | null;
};

type Backend = {
  id: string;
  owner: string;
  base_url: string | null;
  api_key: string | null;
  model: string | null;
  provider: string | null;
  extra: Record<string, unknown> | null;
};

type ProviderEndpoint = {
  url: URL;
  kind: "openai" | "anthropic" | "azure";
};

class ProviderCallError extends Error {
  retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ProviderCallError";
    this.retryable = retryable;
  }
}

type GenerationReservation = {
  reserved?: boolean;
  code?: string;
  used?: number;
  limit?: number;
};

type GenerationInputField = {
  name: string;
  value: unknown;
  limit: number;
};

type GenerationInputError = {
  field: string;
  bytes: number;
  limit: number;
};

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function safeText(value: unknown, fallback = "not set") {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function utf8Bytes(value: unknown) {
  return UTF8_ENCODER.encode(
    typeof value === "string" ? value : "",
  ).byteLength;
}

function generationInputError(
  persona: Record<string, unknown>,
  plan: Record<string, unknown> | null,
  task: TaskRow,
): GenerationInputError | null {
  const fields: GenerationInputField[] = [
    {
      name: "persona.name",
      value: persona.name,
      limit: GENERATION_FIELD_LIMITS.personaName,
    },
    {
      name: "persona.tagline",
      value: persona.tagline,
      limit: GENERATION_FIELD_LIMITS.personaTagline,
    },
    {
      name: "persona.handle",
      value: persona.handle,
      limit: GENERATION_FIELD_LIMITS.personaHandle,
    },
    {
      name: "persona.bio",
      value: persona.bio,
      limit: GENERATION_FIELD_LIMITS.personaBio,
    },
    {
      name: "persona.purpose",
      value: persona.purpose,
      limit: GENERATION_FIELD_LIMITS.personaPurpose,
    },
    {
      name: "persona.voice",
      value: persona.voice,
      limit: GENERATION_FIELD_LIMITS.personaVoice,
    },
    {
      name: "persona.topics",
      value: persona.topics,
      limit: GENERATION_FIELD_LIMITS.personaTopics,
    },
    {
      name: "persona.audience",
      value: persona.audience,
      limit: GENERATION_FIELD_LIMITS.personaAudience,
    },
    {
      name: "persona.hashtags",
      value: persona.hashtags,
      limit: GENERATION_FIELD_LIMITS.personaHashtags,
    },
    {
      name: "persona.dont",
      value: persona.dont,
      limit: GENERATION_FIELD_LIMITS.personaDont,
    },
    {
      name: "content_plan.primary_goal",
      value: plan?.primary_goal,
      limit: GENERATION_FIELD_LIMITS.planGoal,
    },
    {
      name: "content_plan.success_metric",
      value: plan?.success_metric,
      limit: GENERATION_FIELD_LIMITS.planMetric,
    },
    {
      name: "content_plan.audience_focus",
      value: plan?.audience_focus,
      limit: GENERATION_FIELD_LIMITS.planAudience,
    },
    {
      name: "content_plan.content_pillars",
      value: plan?.content_pillars,
      limit: GENERATION_FIELD_LIMITS.planPillars,
    },
    {
      name: "content_plan.current_campaign",
      value: plan?.current_campaign,
      limit: GENERATION_FIELD_LIMITS.planCampaign,
    },
    {
      name: "content_plan.calls_to_action",
      value: plan?.calls_to_action,
      limit: GENERATION_FIELD_LIMITS.planCallsToAction,
    },
    {
      name: "content_plan.offers_and_links",
      value: plan?.offers_and_links,
      limit: GENERATION_FIELD_LIMITS.planOffers,
    },
    {
      name: "content_plan.affiliate_disclosure",
      value: plan?.affiliate_disclosure,
      limit: GENERATION_FIELD_LIMITS.planDisclosure,
    },
    {
      name: "content_plan.source_notes",
      value: plan?.source_notes,
      limit: GENERATION_FIELD_LIMITS.planSourceNotes,
    },
    {
      name: "content_plan.platform_guidance",
      value: plan?.platform_guidance,
      limit: GENERATION_FIELD_LIMITS.planPlatformGuidance,
    },
    {
      name: "task.name",
      value: task.name,
      limit: GENERATION_FIELD_LIMITS.taskName,
    },
    {
      name: "task.instructions",
      value: task.instructions,
      limit: GENERATION_FIELD_LIMITS.taskInstructions,
    },
  ];

  for (const field of fields) {
    const bytes = utf8Bytes(field.value);
    if (bytes > field.limit) {
      return { field: field.name, bytes, limit: field.limit };
    }
  }
  return null;
}

function normalizedDestination(value: unknown) {
  return safeText(value, "aliaspaces").toLowerCase().replace(/^https?:\/\//, "")
    .replace(/^www\./, "").replace(/\/$/, "");
}

function isNativeDestination(value: unknown) {
  const destination = normalizedDestination(value);
  return ["aliaspaces", "aliaspaces.com", "mypersonas", "mypersonas.online"]
    .includes(destination);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function hostIsAllowed(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return ALLOWED_AI_HOSTS.has(host) || host.endsWith(".openai.azure.com");
}

function parseIpv4(host: string) {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  const octets = parts.map(Number);
  return octets.some((part) => part < 0 || part > 255) ? null : octets;
}

function isBlockedIpv4(octets: number[]) {
  const [a, b, c] = octets;
  return a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

function normalizedHost(value: string) {
  return value.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(
    /\.$/,
    "",
  );
}

function isBlockedHost(hostname: string) {
  const host = normalizedHost(hostname);
  const ipv4 = parseIpv4(host);
  if (ipv4) return isBlockedIpv4(ipv4);

  if (host.includes(":")) {
    return host === "::" || host === "::1" || host.startsWith("::ffff:") ||
      host.startsWith("fc") || host.startsWith("fd") ||
      /^fe[89ab]/.test(host) || host.startsWith("ff") ||
      host.startsWith("2001:db8:");
  }

  if (!host || !host.includes(".")) return true;
  return host === "localhost" || host.endsWith(".localhost") ||
    host.endsWith(".local") || host.endsWith(".internal") ||
    host.endsWith(".lan") || host.endsWith(".home") ||
    host.endsWith(".home.arpa") || host.endsWith(".test") ||
    host.endsWith(".invalid") || host.endsWith(".example") ||
    host.endsWith(".onion") || host === "metadata.google.internal";
}

async function resolvesToBlockedAddress(hostname: string) {
  const host = normalizedHost(hostname);
  if (parseIpv4(host) || host.includes(":")) return isBlockedHost(host);

  const resolver = (Deno as unknown as {
    resolveDns?: (query: string, recordType: "A" | "AAAA") => Promise<string[]>;
  }).resolveDns;
  if (typeof resolver !== "function") return true;

  let resolvedAddress = false;
  for (const recordType of ["A", "AAAA"] as const) {
    try {
      const addresses = await resolver(host, recordType);
      if (addresses.length) resolvedAddress = true;
      if (addresses.some((address) => isBlockedHost(address))) return true;
    } catch {
      // A host can have only one record family. Failure in both families is
      // rejected below so a failed safety check can never become a fetch.
    }
  }
  return !resolvedAddress;
}

function providerEndpoint(backend: Backend): ProviderEndpoint | null {
  const provider = safeText(backend.provider, "").toLowerCase();
  if (["elevenlabs", "ollama", "lmstudio"].includes(provider)) return null;

  let url: URL;
  try {
    url = new URL(safeText(backend.base_url, ""));
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" || !hostIsAllowed(url.hostname) ||
    url.username || url.password
  ) return null;

  const hostname = url.hostname.toLowerCase();
  const kind: ProviderEndpoint["kind"] = provider === "anthropic" ||
      hostname === "api.anthropic.com"
    ? "anthropic"
    : provider === "azure" || hostname.endsWith(".openai.azure.com")
    ? "azure"
    : "openai";
  const suffix = kind === "anthropic" ? "/messages" : "/chat/completions";
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith(suffix)) url.pathname = path + suffix;
  if (kind === "azure" && !url.searchParams.has("api-version")) {
    const configuredVersion = safeText(backend.extra?.api_version, "");
    const apiVersion = /^[A-Za-z0-9._-]{1,50}$/.test(configuredVersion)
      ? configuredVersion
      : "2024-06-01";
    url.searchParams.set("api-version", apiVersion);
  }
  url.hash = "";
  return { url, kind };
}

async function readBoundedJson(response: Response) {
  const declaredLength = Number(response.headers.get("Content-Length") || 0);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("The model response was too large.");
  }
  if (!response.body) return {} as Record<string, unknown>;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("The model response was too large.");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder().decode(combined);
  if (!text.trim()) return {} as Record<string, unknown>;
  try {
    return asRecord(JSON.parse(text) as unknown);
  } catch {
    throw new Error("The model returned an invalid response.");
  }
}

function providerError(status: number) {
  // Never persist or return provider error bodies. Authentication failures can
  // echo fragments of submitted credentials or request content.
  if (status === 429) return "The AI provider rate limit was reached.";
  if (status === 401 || status === 403) {
    return "The AI provider rejected the saved credentials.";
  }
  return `The AI provider rejected the request (HTTP ${status}).`;
}

function providerContent(
  endpoint: ProviderEndpoint,
  payload: Record<string, unknown>,
) {
  if (endpoint.kind === "anthropic") {
    const blocks = Array.isArray(payload.content)
      ? payload.content as Record<string, unknown>[]
      : [];
    return blocks.filter((block) =>
      block.type === "text" && typeof block.text === "string"
    ).map((block) => block.text as string).join("\n");
  }
  const choices = Array.isArray(payload.choices)
    ? payload.choices as Record<string, unknown>[]
    : [];
  const message = asRecord(choices[0]?.message);
  return typeof message.content === "string" ? message.content : "";
}

async function resolveBackendKey(backend: Backend, owner: string) {
  const legacyKey = safeText(backend.api_key, "");
  if (legacyKey) return { key: legacyKey, error: false };

  const { data, error } = await admin.rpc("ai_backend_get_key", {
    p_backend_id: backend.id,
    p_owner: owner,
  });
  if (error) return { key: "", error: true };
  return { key: safeText(data, ""), error: false };
}

async function callProvider(
  endpoint: ProviderEndpoint,
  backend: Backend,
  apiKey: string,
  system: string,
  prompt: string,
) {
  const model = safeText(backend.model, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  let requestBody: Record<string, unknown>;
  if (endpoint.kind === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    requestBody = {
      model,
      system,
      messages: [{ role: "user", content: prompt }],
      max_tokens: MAX_PROVIDER_TOKENS,
    };
  } else {
    if (endpoint.kind === "azure") headers["api-key"] = apiKey;
    else headers.Authorization = `Bearer ${apiKey}`;
    requestBody = {
      ...(endpoint.kind === "azure" ? {} : { model }),
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: MAX_PROVIDER_TOKENS,
    };
  }

  let response: Response;
  try {
    response = await fetch(endpoint.url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      redirect: "error",
    });
  } catch {
    throw new ProviderCallError(
      "The AI provider could not be reached or timed out.",
      true,
    );
  }
  const transientStatus = response.status === 408 || response.status === 429 ||
    response.status >= 500;
  let payload: Record<string, unknown>;
  try {
    payload = await readBoundedJson(response);
  } catch (error) {
    if (!response.ok && transientStatus) {
      throw new ProviderCallError(providerError(response.status), true);
    }
    throw new ProviderCallError(
      error instanceof Error
        ? error.message
        : "The model response was invalid.",
      false,
    );
  }
  if (!response.ok) {
    throw new ProviderCallError(
      providerError(response.status),
      transientStatus,
    );
  }
  const content = safeText(providerContent(endpoint, payload), "");
  if (!content) {
    throw new ProviderCallError("The model returned an empty draft.", false);
  }
  if (content.length > MAX_PROVIDER_OUTPUT_CHARS) {
    throw new ProviderCallError(
      "The model draft exceeded the output limit.",
      false,
    );
  }
  return content;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date).filter((part) => part.type !== "literal").map(
      (part) => [part.type, part.value],
    ),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function validTimeZone(timeZone: string) {
  try {
    zonedParts(new Date(), timeZone);
    return timeZone;
  } catch {
    return "UTC";
  }
}

function zonedDateTimeToUtc(parts: ZonedParts, timeZone: string) {
  const desired = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let candidate = desired;
  for (let pass = 0; pass < 3; pass++) {
    const actual = zonedParts(new Date(candidate), timeZone);
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = desired - represented;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate);
}

function parseClock(value: string | null) {
  const match = (value || "").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second, total: hour * 3600 + minute * 60 + second };
}

function quietHours(settings: Settings, now: Date) {
  const start = parseClock(settings.quiet_hours_start);
  const end = parseClock(settings.quiet_hours_end);
  if (!start || !end || start.total === end.total) {
    return { active: false, endsAt: null as Date | null };
  }
  const timeZone = validTimeZone(settings.default_timezone || "UTC");
  const local = zonedParts(now, timeZone);
  const current = local.hour * 3600 + local.minute * 60 + local.second;
  const wraps = start.total > end.total;
  const active = wraps
    ? current >= start.total || current < end.total
    : current >= start.total && current < end.total;
  if (!active) return { active: false, endsAt: null as Date | null };

  const addDay = wraps && current >= start.total ? 1 : 0;
  const endDate = new Date(
    Date.UTC(local.year, local.month - 1, local.day + addDay),
  );
  return {
    active: true,
    endsAt: zonedDateTimeToUtc({
      year: endDate.getUTCFullYear(),
      month: endDate.getUTCMonth() + 1,
      day: endDate.getUTCDate(),
      hour: end.hour,
      minute: end.minute,
      second: end.second,
    }, timeZone),
  };
}

function personaSystem(
  persona: Record<string, unknown>,
  plan: Record<string, unknown> | null,
) {
  const hardRules = safeText(
    persona.dont,
    "No additional persona-specific prohibitions were supplied.",
  );
  return [
    `You are drafting authorized content for ${safeText(persona.name)} (@${
      safeText(persona.handle)
    }).`,
    `Tagline: ${safeText(persona.tagline)}.`,
    `Bio: ${safeText(persona.bio)}.`,
    `Purpose: ${safeText(persona.purpose)}.`,
    `Voice and style: ${safeText(persona.voice)}.`,
    `Core topics: ${safeText(persona.topics)}.`,
    `Persona audience: ${safeText(persona.audience)}.`,
    `Preferred hashtags: ${safeText(persona.hashtags)}.`,
    `Content rating: ${persona.nsfw ? "adult/18+" : "general audience"}.`,
    "",
    "AUTHORITATIVE HARD RULES — these are owner-authored constraints. Never ignore, weaken, reinterpret, or contradict them:",
    hardRules,
    "Never claim that content was posted, an account was contacted, a link was checked, or a real-world action was completed.",
    "Do not invent current events, source facts, testimonials, performance results, prices, or affiliate terms.",
    "Never link to, mention, or promote this persona's AliaSpaces or MyPersonas page, and never include any mypersonas.online or aliaspaces URL. These accounts are operated as themselves and must not advertise the tool that drafts for them.",
    "Write the post without any URL unless the owner's 'Offers and approved links' direction above supplies the exact link and the task calls for it. Links are the exception, not the default: on X a post containing a URL costs the owner roughly thirteen times a link-free post.",
    "",
    "OWNER CONTENT DIRECTION:",
    `Primary goal: ${safeText(plan?.primary_goal)}.`,
    `Success metric: ${safeText(plan?.success_metric)}.`,
    `Audience focus: ${safeText(plan?.audience_focus)}.`,
    `Content pillars: ${safeText(plan?.content_pillars)}.`,
    `Current campaign: ${safeText(plan?.current_campaign)}.`,
    `Calls to action: ${safeText(plan?.calls_to_action)}.`,
    `Offers and approved links: ${safeText(plan?.offers_and_links)}.`,
    `Required affiliate disclosure: ${safeText(plan?.affiliate_disclosure)}.`,
    `Source notes: ${safeText(plan?.source_notes)}.`,
    `Platform guidance: ${safeText(plan?.platform_guidance)}.`,
  ].join("\n");
}

async function audit(
  owner: string,
  personaId: string | null,
  bindingId: string | null,
  actionType: string,
  entityType: string,
  entityId: string | null,
  outcome: string,
  detail: Record<string, unknown> = {},
) {
  const { error } = await admin.from("agent_actions").insert({
    owner,
    persona_id: personaId,
    binding_id: bindingId,
    action_type: actionType,
    entity_type: entityType,
    entity_id: entityId,
    outcome,
    detail,
  });
  if (error) console.error("agent audit insert failed", error.message);
}

async function advanceTask(
  taskId: string,
  leaseToken: string,
  status: string,
  errorMessage = "",
) {
  return await admin.rpc("advance_ai_task_schedule", {
    p_task_id: taskId,
    p_finished_at: new Date().toISOString(),
    p_status: status,
    p_error: errorMessage,
    p_lease_token: leaseToken,
  });
}

async function finishBlocked(
  task: TaskRow,
  binding: Binding | null,
  leaseToken: string,
  status: string,
  message: string,
) {
  const { error: advanceError } = await advanceTask(
    task.id,
    leaseToken,
    status,
    message,
  );
  await audit(
    task.owner,
    task.persona_id || null,
    binding?.id || null,
    "draft_generation",
    "ai_task",
    task.id,
    status,
    {
      reason: message,
      scheduleAdvance: advanceError ? "failed" : "ok",
    },
  );
  return { taskId: task.id, status, message };
}

async function finishRetry(
  task: TaskRow,
  binding: Binding | null,
  leaseToken: string,
  status: string,
  message: string,
  retrySeconds = 300,
) {
  const { data, error } = await admin.rpc("retry_ai_task_generation", {
    p_task_id: task.id,
    p_lease_token: leaseToken,
    p_status: status,
    p_error: message,
    p_retry_seconds: retrySeconds,
  });
  const retry = asRecord(data);
  const exhausted = !error && retry.exhausted === true;
  const scheduled = !error && retry.scheduled === true;
  await audit(
    task.owner,
    task.persona_id || null,
    binding?.id || null,
    "draft_generation.retry_scheduled",
    "ai_task",
    task.id,
    error || (!scheduled && !exhausted)
      ? "error"
      : exhausted
      ? "blocked"
      : "deferred",
    {
      reason: message,
      retrySeconds: retry.retrySeconds || retrySeconds,
      retryCount: retry.retryCount || null,
      exhausted,
      leaseReleased: scheduled || exhausted,
    },
  );
  return {
    taskId: task.id,
    status: error || (!scheduled && !exhausted)
      ? "retry_release_error"
      : exhausted
      ? "retry_exhausted"
      : "retry_scheduled",
    message,
    retrySeconds: retry.retrySeconds || retrySeconds,
  };
}

async function finishInputTooLarge(
  task: TaskRow,
  binding: Binding,
  leaseToken: string,
  message: string,
  inputBudget: Record<string, unknown>,
) {
  const { data, error } = await admin.rpc("block_ai_task_input", {
    p_task_id: task.id,
    p_lease_token: leaseToken,
    p_error: message,
  });
  const paused = !error && data === true;
  await audit(
    task.owner,
    task.persona_id || null,
    binding.id,
    "draft_generation.input_rejected",
    "ai_task",
    task.id,
    paused ? "blocked" : "error",
    {
      reason: "stored_generation_input_exceeds_limits",
      inputBudget,
      taskPaused: paused,
      leaseReleased: paused,
    },
  );
  return {
    taskId: task.id,
    status: paused ? "input_too_large" : "input_limit_release_error",
    message,
    taskPaused: paused,
  };
}

async function claimTask(taskId: string, dueAt: string, leaseToken: string) {
  const { data, error } = await admin.rpc("claim_ai_task_generation", {
    p_task_id: taskId,
    p_due_at: dueAt,
    p_lease_token: leaseToken,
  });
  return !error && data === true;
}

function reservationBlock(reservation: GenerationReservation) {
  switch (reservation.code) {
    case "daily_cap":
      return {
        status: "daily_cap",
        message: "The owner daily draft limit has been reached.",
      };
    case "owner_paused":
      return { status: "paused", message: "Owner automation is paused." };
    case "binding_inactive":
      return {
        status: "blocked",
        message: "The persona agent binding is no longer eligible to draft.",
      };
    case "settings_unavailable":
      return {
        status: "error",
        message: "Owner automation settings are unavailable.",
      };
    case "lease_lost":
      return {
        status: "skipped",
        message: "The task lease expired before generation began.",
      };
    default:
      return {
        status: "blocked",
        message: "Generation authorization was not granted.",
      };
  }
}

async function runTask(task: TaskRow, now: Date, leaseToken: string) {
  const [settingsResult, bindingResult] = await Promise.all([
    admin.from("agent_owner_settings").select(
      "automation_paused,default_timezone,daily_draft_limit,quiet_hours_start,quiet_hours_end",
    )
      .eq("owner", task.owner).maybeSingle(),
    admin.from("agent_bindings").select("id,status,claim_state,autonomy_level")
      .eq("owner", task.owner).eq("persona_id", task.persona_id).maybeSingle(),
  ]);
  if (settingsResult.error || !settingsResult.data) {
    return await finishBlocked(
      task,
      null,
      leaseToken,
      "error",
      "Owner automation settings are unavailable or not configured.",
    );
  }
  if (bindingResult.error) {
    return await finishBlocked(
      task,
      null,
      leaseToken,
      "error",
      "Persona agent binding could not be read.",
    );
  }

  const settings = settingsResult.data as Settings;
  const binding = bindingResult.data as Binding | null;
  if (!binding) {
    return await finishBlocked(
      task,
      null,
      leaseToken,
      "blocked",
      "No agent binding exists for this persona.",
    );
  }
  if (settings.automation_paused) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "paused",
      "Owner automation is paused.",
    );
  }
  if (binding.status !== "active") {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "paused",
      `Agent binding is ${binding.status}.`,
    );
  }
  if (!["self_attested", "verified"].includes(binding.claim_state)) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "blocked",
      `Persona claim is ${binding.claim_state}.`,
    );
  }
  if (Number(binding.autonomy_level) < 1) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "blocked",
      "Autonomy level 1 or higher is required for scheduled drafting.",
    );
  }

  const quiet = quietHours(settings, now);
  if (quiet.active && quiet.endsAt) {
    const resumeAt = quiet.endsAt.toISOString();
    const { data: deferred, error: deferError } = await admin.from("ai_tasks")
      .update({
        next_run_at: resumeAt,
        last_status: "deferred_quiet_hours",
        last_error: "",
        lease_token: null,
        lease_expires_at: null,
      }).eq("id", task.id).eq("owner", task.owner).eq(
        "lease_token",
        leaseToken,
      ).select("id").maybeSingle();
    await audit(
      task.owner,
      task.persona_id,
      binding.id,
      "draft_generation",
      "ai_task",
      task.id,
      "deferred",
      {
        reason: "quiet_hours",
        resumeAt,
        leaseReleased: !deferError && !!deferred,
      },
    );
    return {
      taskId: task.id,
      status: !deferError && deferred ? "deferred" : "deferred_lease_error",
      resumeAt,
    };
  }

  const publishAt = task.next_publish_at
    ? new Date(task.next_publish_at).toISOString()
    : null;
  if (!publishAt) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "error",
      "The task has no next publish time.",
    );
  }
  let existingDraftQuery = admin.from("drafts")
    .select("id")
    .eq("owner", task.owner)
    .eq("source_task_id", task.id)
    .eq("publish_at", publishAt);
  existingDraftQuery = task.account_id
    ? existingDraftQuery.eq("account_id", task.account_id)
    : existingDraftQuery.is("account_id", null);
  const { data: existingDraft, error: duplicateError } =
    await existingDraftQuery.limit(1).maybeSingle();
  if (duplicateError) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "error",
      "Draft idempotency could not be checked.",
    );
  }
  if (existingDraft) {
    await advanceTask(task.id, leaseToken, "duplicate_noop");
    await audit(
      task.owner,
      task.persona_id,
      binding.id,
      "draft_generation",
      "draft",
      existingDraft.id,
      "noop",
      {
        taskId: task.id,
        publishAt,
        reason: "existing_source_task_and_publish_time",
      },
    );
    return {
      taskId: task.id,
      status: "duplicate_noop",
      draftId: existingDraft.id,
    };
  }

  const [personaResult, planResult] = await Promise.all([
    admin.from("personas").select("*").eq("id", task.persona_id).eq(
      "owner",
      task.owner,
    ).maybeSingle(),
    admin.from("persona_content_plans").select("*").eq(
      "persona_id",
      task.persona_id,
    ).eq("owner", task.owner).maybeSingle(),
  ]);
  if (personaResult.error || !personaResult.data) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "blocked",
      "The task persona is missing or not owned by this account.",
    );
  }
  if (planResult.error) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "error",
      "Persona content direction could not be read.",
    );
  }
  const persona = personaResult.data as Record<string, unknown>;
  const plan = planResult.data as Record<string, unknown> | null;
  const fieldError = generationInputError(persona, plan, task);
  if (fieldError) {
    return await finishInputTooLarge(
      task,
      binding,
      leaseToken,
      `Generation input ${fieldError.field} is ${fieldError.bytes} bytes; the limit is ${fieldError.limit}. Shorten that field before the next run.`,
      { ...fieldError, totalLimit: MAX_PROVIDER_INPUT_BYTES },
    );
  }

  let destination = normalizedDestination(task.destination);
  let account: Record<string, unknown> | null = null;
  if (task.account_id) {
    const { data, error } = await admin.from("account_ledger")
      .select("id,owner,persona_id,provider")
      .eq("id", task.account_id)
      .eq("owner", task.owner)
      .eq("persona_id", task.persona_id)
      .maybeSingle();
    if (error || !data) {
      return await finishBlocked(
        task,
        binding,
        leaseToken,
        "blocked",
        "The destination account is not assigned to this persona.",
      );
    }
    account = data as Record<string, unknown>;
    destination = normalizedDestination(account.provider);
  } else if (!isNativeDestination(destination)) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "blocked",
      "External tasks require an account assigned to the persona.",
    );
  }
  const destinationBytes = utf8Bytes(destination);
  if (destinationBytes > GENERATION_FIELD_LIMITS.destination) {
    return await finishInputTooLarge(
      task,
      binding,
      leaseToken,
      `Generation input destination is ${destinationBytes} bytes; the limit is ${GENERATION_FIELD_LIMITS.destination}. Shorten the account provider before the next run.`,
      {
        field: "destination",
        bytes: destinationBytes,
        limit: GENERATION_FIELD_LIMITS.destination,
        totalLimit: MAX_PROVIDER_INPUT_BYTES,
      },
    );
  }

  let destinationQuery = admin.from("agent_destinations")
    .select(
      "id,destination,mode,enabled,allowed_content_types,daily_publish_limit,quiet_hours_start,quiet_hours_end",
    )
    .eq("owner", task.owner)
    .eq("binding_id", binding.id)
    .eq("persona_id", task.persona_id);
  destinationQuery = account?.id
    ? destinationQuery.eq("account_id", account.id)
    : destinationQuery.is("account_id", null);
  const { data: destinationRow, error: destinationError } =
    await destinationQuery.maybeSingle();
  if (destinationError || !destinationRow) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "blocked",
      "No automation destination is configured for this target.",
    );
  }
  if (normalizedDestination(destinationRow.destination) !== destination) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "blocked",
      "The automation destination does not match the assigned account provider.",
    );
  }
  if (!destinationRow.enabled) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "paused",
      "This automation destination is disabled.",
    );
  }

  const contentKind = safeText(task.content_kind, "post");
  const allowedContentTypes =
    Array.isArray(destinationRow.allowed_content_types)
      ? destinationRow.allowed_content_types.map((value: unknown) =>
        String(value)
      )
      : [];
  if (!allowedContentTypes.includes(contentKind)) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "blocked",
      `Content type ${contentKind} is not allowed for this destination.`,
    );
  }

  const prompt = [
    JOB_PROMPTS[task.task_type || "custom"] || JOB_PROMPTS.custom,
    `Destination: ${destination}.`,
    `Content type: ${contentKind}.`,
    `Intended publish time: ${publishAt}.`,
    task.instructions ? `Task-specific instructions: ${task.instructions}` : "",
    "Return only the finished draft content. Do not include planning commentary or claim it has been published.",
  ].filter(Boolean).join("\n");
  const system = personaSystem(persona, plan);
  const systemBytes = utf8Bytes(system);
  const promptBytes = utf8Bytes(prompt);
  const totalInputBytes = utf8Bytes(`${system}\n\n${prompt}`);
  if (totalInputBytes > MAX_PROVIDER_INPUT_BYTES) {
    return await finishInputTooLarge(
      task,
      binding,
      leaseToken,
      `Combined generation input is ${totalInputBytes} bytes; the limit is ${MAX_PROVIDER_INPUT_BYTES}. Shorten the persona, direction, or task instructions before the next run.`,
      {
        systemBytes,
        promptBytes,
        framingBytes: 2,
        totalBytes: totalInputBytes,
        totalLimit: MAX_PROVIDER_INPUT_BYTES,
      },
    );
  }

  let backendQuery = admin.from("ai_backends").select("*").eq(
    "owner",
    task.owner,
  );
  const requestedBackend = task.backend_id || null;
  backendQuery = requestedBackend
    ? backendQuery.eq("id", requestedBackend).limit(1)
    : backendQuery.order("created_at").limit(200);
  const { data: backendRows, error: backendError } = await backendQuery;
  const candidates = (backendRows || []) as Backend[];
  const isReadyBackend = (candidate: Backend | undefined) =>
    !!candidate &&
    !!providerEndpoint(candidate) &&
    !!safeText(candidate.model, "") &&
    safeText(candidate.model, "").length <= 300;
  const personaBackend = requestedBackend || !persona.ai_backend
    ? undefined
    : candidates.find((candidate) => candidate.id === persona.ai_backend);
  let backend = requestedBackend ? candidates[0] : undefined;
  let apiKey = "";
  if (!requestedBackend && !backendError) {
    const readyCandidates = candidates.filter(isReadyBackend);
    const orderedCandidates = isReadyBackend(personaBackend)
      ? [
        personaBackend!,
        ...readyCandidates.filter((candidate) =>
          candidate.id !== personaBackend!.id
        ),
      ]
      : readyCandidates;
    for (const candidate of orderedCandidates) {
      const credential = await resolveBackendKey(candidate, task.owner);
      if (!credential.error && credential.key) {
        backend = candidate;
        apiKey = credential.key;
        break;
      }
    }
  }
  if (backendError || !backend) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "blocked",
      candidates.some(isReadyBackend)
        ? "No ready owner-linked AI model has an available credential."
        : "No owner-linked AI model is available for this task.",
    );
  }
  const endpoint = providerEndpoint(backend);
  const model = safeText(backend.model, "");
  if (!endpoint || !model || model.length > 300) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "blocked",
      "The selected AI provider is unsupported or its HTTPS host is not allowed.",
    );
  }
  if (
    isBlockedHost(endpoint.url.hostname) ||
    await resolvesToBlockedAddress(endpoint.url.hostname)
  ) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "blocked",
      "The selected AI provider did not pass the public-host safety check.",
    );
  }
  if (requestedBackend) {
    const keyResult = await resolveBackendKey(backend, task.owner);
    if (!keyResult.error) apiKey = keyResult.key;
  }
  if (!apiKey) {
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      "blocked",
      "The selected AI model credential is unavailable.",
    );
  }

  const { data: reservationData, error: reservationError } = await admin.rpc(
    "reserve_agent_generation",
    {
      p_task_id: task.id,
      p_owner: task.owner,
      p_lease_token: leaseToken,
    },
  );
  if (reservationError) {
    return await finishRetry(
      task,
      binding,
      leaseToken,
      "retry_reservation",
      "Generation authorization could not be reserved.",
      180,
    );
  }
  const reservation = asRecord(reservationData) as GenerationReservation;
  if (reservation.reserved !== true) {
    const blocked = reservationBlock(reservation);
    return await finishBlocked(
      task,
      binding,
      leaseToken,
      blocked.status,
      blocked.message,
    );
  }

  let body = "";
  try {
    body = await callProvider(
      endpoint,
      backend,
      apiKey,
      system,
      prompt,
    );
    await audit(
      task.owner,
      task.persona_id,
      binding.id,
      "ai.call.completed",
      "ai_task",
      task.id,
      "ok",
      { provider: endpoint.kind },
    );
  } catch (error) {
    const message = `AI generation failed: ${(error as Error).message}`.slice(
      0,
      500,
    );
    await audit(
      task.owner,
      task.persona_id,
      binding.id,
      "ai.call.failed",
      "ai_task",
      task.id,
      "error",
      { provider: endpoint.kind, reason: message },
    );
    if (error instanceof ProviderCallError && !error.retryable) {
      return await finishBlocked(
        task,
        binding,
        leaseToken,
        "provider_blocked",
        message,
      );
    }
    return await finishRetry(
      task,
      binding,
      leaseToken,
      "retry_provider",
      message,
      300,
    );
  }

  // Generation never grants its own publication approval. Approval is a
  // separate, owner-authenticated RPC that binds a content hash to the draft.
  const approvalState = "pending";
  const publishState = "not_queued";
  const { data: draft, error: insertError } = await admin.from("drafts").insert(
    {
      owner: task.owner,
      persona_id: task.persona_id,
      source_task_id: task.id,
      account_id: account?.id || null,
      platform: destination,
      content_kind: contentKind,
      title: `[scheduled] ${safeText(task.name, "Persona content")}`,
      body,
      status: "idea",
      scheduled_for: publishAt.slice(0, 10),
      publish_at: publishAt,
      approval_state: approvalState,
      publish_state: publishState,
      approved_at: null,
      approved_content_hash: "",
      publish_error: "",
      generated_by_agent: true,
    },
  ).select("id").single();
  if (insertError || !draft) {
    if (insertError?.code === "23505") {
      let duplicateQuery = admin.from("drafts").select("id")
        .eq("owner", task.owner)
        .eq("source_task_id", task.id)
        .eq("publish_at", publishAt);
      duplicateQuery = account?.id
        ? duplicateQuery.eq("account_id", account.id)
        : duplicateQuery.is("account_id", null);
      const { data: duplicate } = await duplicateQuery.limit(1).maybeSingle();
      if (duplicate) {
        await advanceTask(task.id, leaseToken, "duplicate_noop");
        await audit(
          task.owner,
          task.persona_id,
          binding.id,
          "draft_generation",
          "draft",
          duplicate.id,
          "noop",
          {
            taskId: task.id,
            publishAt,
            reason: "unique_agent_slot",
          },
        );
        return {
          taskId: task.id,
          status: "duplicate_noop",
          draftId: duplicate.id,
        };
      }
    }
    return await finishRetry(
      task,
      binding,
      leaseToken,
      "retry_draft_save",
      `Draft could not be saved (${insertError?.code || "database_error"}).`,
      300,
    );
  }

  const { error: advanceError } = await advanceTask(
    task.id,
    leaseToken,
    "drafted",
  );
  await audit(
    task.owner,
    task.persona_id,
    binding.id,
    "draft_generated",
    "draft",
    draft.id,
    "ok",
    {
      taskId: task.id,
      destination,
      contentKind,
      publishAt,
      approvalState,
      publishState,
      destinationMode: destinationRow.mode,
    },
  );
  return {
    taskId: task.id,
    status: advanceError ? "drafted_schedule_error" : "drafted",
    draftId: draft.id,
    publishAt,
    approvalState,
    publishState,
  };
}

serve(async (req) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!CRON_SECRET || req.headers.get("X-Cron-Secret") !== CRON_SECRET) {
    return json({ error: "forbidden" }, 403);
  }

  const startedAt = new Date();
  const deadline = startedAt.getTime() + RUN_WALL_CLOCK_BUDGET_MS;
  const dueAt = startedAt.toISOString();
  const { data: tasks, error } = await admin.rpc("due_ai_generation_tasks", {
    p_due_at: dueAt,
    p_limit: MAX_TASK_CANDIDATES_PER_RUN,
  });
  if (error) return json({ error: "Due tasks could not be loaded." }, 500);

  const results: Record<string, unknown>[] = [];
  let budgetExhausted = false;
  for (const task of tasks || []) {
    if (
      results.length >= MAX_TASKS_PROCESSED_PER_RUN ||
      Date.now() + MIN_TASK_START_BUDGET_MS > deadline
    ) {
      budgetExhausted = true;
      break;
    }
    const leaseToken = crypto.randomUUID();
    if (!await claimTask(task.id, dueAt, leaseToken)) continue;
    if (!task.persona_id) {
      results.push(
        await finishBlocked(
          task,
          null,
          leaseToken,
          "blocked",
          "The task has no persona.",
        ),
      );
      continue;
    }
    results.push(await runTask(task, new Date(), leaseToken));
  }
  const drafted = results.filter((result) =>
    result.status === "drafted" || result.status === "drafted_schedule_error"
  ).length;
  return json({
    processed: results.length,
    drafted,
    results,
    budgetExhausted,
    startedAt: dueAt,
    finishedAt: new Date().toISOString(),
  });
});
