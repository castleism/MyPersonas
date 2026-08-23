import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const PATH = new URL("../MyPersonas.Online_v0/REQUEST-REVIEW-SPEC.md", import.meta.url);
const FUNCTION_PATH = new URL("../supabase/functions/request-review/index.ts", import.meta.url);
const CONFIG_PATH = new URL("../supabase/config.toml", import.meta.url);
const MIGRATION_PATH = new URL("../MyPersonas.Online_v0/sql-updates/043-request-review-phase1.sql", import.meta.url);

test("request-review spec is human-approved, evidence-based, and non-promissory", async () => {
  const text = await readFile(PATH, "utf8");
  assert.match(text, /Only the owner changes review state/i);
  assert.match(text, /observed\|reported\|inferred\|unknown/i);
  assert.match(text, /AI assisted with drafting/i);
  assert.match(text, /does not guarantee purchase, response, endorsement, or publication/i);
  assert.match(text, /material edit.*invalidates approval/is);
  assert.doesNotMatch(text, /FTC-clean/i);
});

test("request-review spec separates consent and blocks mail abuse", async () => {
  const text = await readFile(PATH, "utf8");
  assert.match(text, /marketing_consent.*separate, unchecked, optional/i);
  assert.match(text, /Turnstile\/hCaptcha/i);
  assert.match(text, /Rate-limit atomically/i);
  assert.match(text, /idempotency key/i);
  assert.match(text, /timeout\/5xx\/missing ID.*reconciliation-required/i);
  assert.match(text, /Do not expose persona email addresses/i);
  assert.match(text, /public button last and default-off per persona/i);
});

test("public request-review intake is exact-origin, bounded, and fail-closed", async () => {
  const source = await readFile(FUNCTION_PATH, "utf8");
  assert.match(source, /Deno\.env\.get\("REQUEST_REVIEW_ALLOWED_ORIGIN"\)/);
  assert.match(source, /candidate !== parsed\.origin/);
  assert.match(source, /requestOrigin !== config\.allowedOrigin/);
  assert.doesNotMatch(source, /Access-Control-Allow-Origin["']:\s*["']\*/);
  assert.match(source, /if \(!config\)[\s\S]*503/);
  assert.doesNotMatch(source, /const admin = createClient\(SUPABASE_URL/);
  assert.match(source, /req\.body\.getReader\(\)/);
  assert.match(source, /total > MAX_BODY_BYTES[\s\S]*reader\.cancel\(\)/);
  assert.match(source, /JSON\.parse\(new TextDecoder[\s\S]*decode\(bytes\)\)/);
  assert.doesNotMatch(source, /req\.json\(\)/);
});

test("request-review verifies Turnstile action and hostname with a timeout", async () => {
  const source = await readFile(FUNCTION_PATH, "utf8");
  assert.match(source, /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/siteverify/);
  assert.match(source, /Deno\.env\.get\("TURNSTILE_SECRET_KEY"\)/);
  assert.match(source, /Deno\.env\.get\("REQUEST_REVIEW_TURNSTILE_ACTION"\)/);
  assert.match(source, /Deno\.env\.get\("REQUEST_REVIEW_TURNSTILE_HOSTNAME"\)/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /setTimeout\(\(\) => controller\.abort\(\), TURNSTILE_TIMEOUT_MS\)/);
  assert.match(source, /remoteip: ip/);
  assert.match(source, /result\.success === true[\s\S]*result\.action === config\.turnstileAction[\s\S]*hostname === config\.turnstileHostname/);
});

test("request-review normalizes bounded fields and never fetches requester URLs", async () => {
  const source = await readFile(FUNCTION_PATH, "utf8");
  assert.match(source, /boundedLine\(body\.product_name, "Product name", 160, true\)/);
  assert.match(source, /boundedLine\(body\.requester_name, "Requester name", 100\)/);
  assert.match(source, /boundedLine\(body\.reason, "Reason", 1500\)/);
  assert.match(source, /codePointLength\(email\) > 320/);
  assert.match(source, /codePointLength\(value\) > 2048/);
  assert.match(source, /parsed\.protocol !== "https:"/);
  assert.match(source, /isIpLiteral\(hostname\)/);
  assert.match(source, /BLOCKED_HOST_SUFFIXES\.some/);
  assert.match(source, /\[<>\\u0000-\\u001f\\u007f\]/);
  assert.match(source, /typeof body\[key\] !== "boolean"/);
  assert.match(source, /\(consentToReply \|\| marketingConsent\) && !requesterEmail/);
  assert.match(source, /body\.turnstile_token \?\? body\.captcha_token \?\? body\["cf-turnstile-response"\]/);
  assert.match(source, /UUID_RE\.test\(idempotencyKey\)/);
  assert.match(source, /idempotencyKey === NIL_UUID/);
  assert.match(source, /function normalizedIp\(raw: string\)/);
  assert.match(source, /new URL\(`http:\/\/\[\$\{candidate\}\]\/`\)/);
  assert.equal((source.match(/await fetch\(/g) || []).length, 1);
  assert.doesNotMatch(source, /fetch\((?:product|parsed|value|intake\.productUrl)/);
});

test("request fingerprints and email limits use rotating domain-separated HMACs", async () => {
  const source = await readFile(FUNCTION_PATH, "utf8");
  assert.match(source, /Deno\.env\.get\("REQUEST_REVIEW_HMAC_SECRET"\)/);
  assert.match(source, /byteLength < 32/);
  assert.match(source, /crypto\.subtle\.importKey\([\s\S]*\{ name: "HMAC", hash: "SHA-256" \}/);
  assert.match(source, /crypto\.subtle\.sign\([\s\S]*"HMAC"/);
  assert.match(source, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  assert.match(source, /request-review:fingerprint:v1:\$\{rotation\}:\$\{ip\}/);
  assert.match(source, /request-review:email:v1:\$\{rotation\}:\$\{email\}/);
  assert.match(source, /p_request_fingerprint: fingerprint/);
  assert.match(source, /p_requester_email_hash: emailHash/);
  assert.doesNotMatch(source, /p_request_fingerprint:\s*ip/);
  assert.doesNotMatch(source, /console\.(?:log|warn|error)/);
});

test("service RPC intake is non-enumerating and returns one neutral receipt", async () => {
  const [source, migration] = await Promise.all([
    readFile(FUNCTION_PATH, "utf8"),
    readFile(MIGRATION_PATH, "utf8"),
  ]);
  assert.match(source, /\.from\("personas"\)[\s\S]*\.eq\("visibility", "public"\)[\s\S]*\.eq\("publication_state", "published"\)/);
  assert.match(source, /if \(!persona\?\.id\) return neutralAccepted/);
  assert.match(source, /admin\.rpc\([\s\S]*"accept_product_review_request_service"/);
  assert.match(source, /p_consent_to_reply: intake\.consentToReply/);
  assert.match(source, /p_marketing_consent: intake\.marketingConsent/);
  assert.match(source, /\["accepted", "duplicate", "suppressed"\]\.includes\(disposition\)/);
  assert.match(source, /Request received\. The owner decides what to test or review\./);
  assert.doesNotMatch(source, /request_id:/);
  assert.doesNotMatch(source, /personaError\.message|error\.message \?\? "Failed/);
  assert.match(migration, /create or replace function public\.accept_product_review_request_service\(/);
  assert.match(migration, /grant execute on function public\.accept_product_review_request_service[\s\S]*to service_role/);
});

test("Supabase gateway explicitly permits only the two intentional public endpoints", async () => {
  const config = await readFile(CONFIG_PATH, "utf8");
  assert.match(config, /Public CAPTCHA intake has no user JWT[\s\S]*\[functions\.request-review\]\s*verify_jwt = false/);
  assert.match(config, /Public offer links must open without a JWT[\s\S]*\[functions\.affiliate-redirect\]\s*verify_jwt = false/);
});
