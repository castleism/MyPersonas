"use strict";

const crypto = require("node:crypto");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PROVIDERS = Object.freeze({
  twitter: { home: "https://x.com/home", hosts: ["x.com", "twitter.com"] },
  instagram: { home: "https://www.instagram.com/", hosts: ["instagram.com", "www.instagram.com"] },
  facebook: { home: "https://www.facebook.com/", hosts: ["facebook.com", "www.facebook.com", "business.facebook.com"] },
  reddit: { home: "https://www.reddit.com/", hosts: ["reddit.com", "www.reddit.com"] },
  youtube: { home: "https://studio.youtube.com/", hosts: ["youtube.com", "www.youtube.com", "studio.youtube.com"] },
  gmail: { home: "https://mail.google.com/", hosts: ["mail.google.com", "accounts.google.com"] },
  discord: { home: "https://discord.com/channels/@me", hosts: ["discord.com"] },
  tiktok: { home: "https://www.tiktok.com/", hosts: ["tiktok.com", "www.tiktok.com"] },
  website: { home: "https://wordpress.com/sites", hosts: ["wordpress.com"] },
  gemini: { home: "https://gemini.google.com/app", hosts: ["gemini.google.com", "accounts.google.com"] },
  chatgpt: { home: "https://chatgpt.com/", hosts: ["chatgpt.com", "auth.openai.com"] },
  claude: { home: "https://claude.ai/new", hosts: ["claude.ai"] },
  grok: { home: "https://grok.com/", hosts: ["grok.com", "x.com"] },
  perplexity: { home: "https://www.perplexity.ai/", hosts: ["perplexity.ai", "www.perplexity.ai"] }
});

function safeProvider(value) {
  const key = String(value || "").trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PROVIDERS, key) ? key : "";
}

function safeInitialUrl(provider, value) {
  const policy = PROVIDERS[provider];
  if (!policy) return "";
  if (!value) return policy.home;
  let parsed;
  try { parsed = new URL(String(value)); } catch (_) { return ""; }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.hash) return "";
  const host = parsed.hostname.toLowerCase();
  if (!policy.hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return "";
  return parsed.href;
}

function parseWorkroomUrl(value) {
  let parsed;
  try { parsed = new URL(String(value)); } catch (_) { return { ok: false, error: "invalid_protocol_url" }; }
  if (parsed.protocol !== "aliaspaces-workroom:" || parsed.hostname !== "open") return { ok: false, error: "unsupported_protocol_action" };
  const provider = safeProvider(parsed.searchParams.get("provider"));
  const accountId = String(parsed.searchParams.get("account_id") || "");
  const personaId = String(parsed.searchParams.get("persona_id") || "");
  if (!provider || !UUID_RE.test(accountId) || !UUID_RE.test(personaId)) return { ok: false, error: "invalid_workroom_identity" };
  const initialUrl = safeInitialUrl(provider, parsed.searchParams.get("url"));
  if (!initialUrl) return { ok: false, error: "provider_url_not_allowed" };
  return { ok: true, provider, accountId, personaId, initialUrl };
}

function partitionName(installationId, accountId) {
  if (!UUID_RE.test(accountId)) throw new Error("invalid account id");
  const digest = crypto.createHash("sha256").update(`${installationId}\0${accountId}`).digest("hex").slice(0, 40);
  return `persist:aliaspaces-account-${digest}`;
}

module.exports = { PROVIDERS, parseWorkroomUrl, partitionName, safeInitialUrl };
