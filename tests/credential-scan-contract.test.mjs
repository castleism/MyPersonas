import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const scanner = await readFile(path.join(root, "scripts/check-committed-secrets.mjs"), "utf8");

test("repository credential gate covers payment, infrastructure, mail, and AI providers", () => {
  for (const label of [
    "Stripe secret key",
    "Stripe webhook secret",
    "Supabase secret API key",
    "Supabase personal access token",
    "JWT bearer token",
    "PostgreSQL credential URL",
    "OpenAI private key",
    "Anthropic private key",
    "OpenRouter private key",
    "Groq private key",
    "Perplexity private key",
    "Hugging Face private token",
    "GitHub private token",
    "npm private token",
    "AWS access key",
    "Google API key",
    "Google OAuth client secret",
    "SendGrid private key",
    "Resend private key",
    "private key block",
  ]) {
    assert.ok(scanner.includes(`[\"${label}\"`), `missing credential signature: ${label}`);
  }
});

test("credential findings never echo matched values", () => {
  assert.match(scanner, /values intentionally omitted/);
  assert.match(scanner, /findings\.push\(`\$\{file\}:\$\{line\}: \$\{label\}`\)/);
  assert.doesNotMatch(scanner, /findings\.push\([^\n]*match\[0\]/);
});
