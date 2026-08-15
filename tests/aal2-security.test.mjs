import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  hasAal2,
  requireAal2,
} from "../supabase/functions/_shared/aal2.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationPath = path.join(
  repoRoot,
  "MyPersonas.Online_v0/sql-updates/041-aal2-credential-boundary.sql",
);
const frontendPath = path.join(repoRoot, "MyPersonas.Online_v0/index.html");
const openRouterPath = path.join(
  repoRoot,
  "supabase/functions/openrouter-connect/index.ts",
);
const configPath = path.join(repoRoot, "supabase/config.toml");
const USER_ID = "1e8b9288-a938-4c98-8988-0e0cc9835123";

function tokenFor(aal, sub = USER_ID) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub, aal })}.test-signature`;
}

function validatedClient(userId = USER_ID) {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: userId } }, error: null }),
    },
  };
}

test("the reusable guard denies a validated AAL1 bearer", async () => {
  const result = await requireAal2(
    new Request("https://example.test", {
      headers: { Authorization: `Bearer ${tokenFor("aal1")}` },
    }),
    validatedClient(),
  );
  assert.deepEqual(result, {
    ok: false,
    status: 403,
    code: "aal2_required",
    error: "Two-factor verification required",
  });
  assert.equal(hasAal2({ aal: "aal1" }), false);
});

test("the reusable guard allows a validated AAL2 bearer", async () => {
  const token = tokenFor("aal2");
  const result = await requireAal2(
    new Request("https://example.test", {
      headers: { Authorization: `Bearer ${token}` },
    }),
    validatedClient(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.token, token);
  assert.equal(result.user.id, USER_ID);
  assert.equal(hasAal2(result.claims), true);
});

test("the SQL boundary enforces AAL2 on every AI backend mutation", async () => {
  const sql = await readFile(migrationPath, "utf8");
  assert.match(sql, /auth\.jwt\(\)\s*->>\s*'aal'/);
  assert.match(sql, /Two-factor verification required/);
  for (const name of [
    "create_ai_backend",
    "update_ai_backend",
    "delete_ai_backend",
    "delete_my_ai_backends",
  ]) {
    const start = sql.indexOf(`create or replace function public.${name}`);
    assert.notEqual(start, -1, `${name} must be replaced by migration 041`);
    const end = sql.indexOf("$$;", start);
    const functionSource = sql.slice(start, end);
    assert.match(
      functionSource,
      /perform public\.require_aal2\(\)/,
      `${name} must invoke the shared AAL2 guard`,
    );
  }
});

test("private bootstrap challenges verified TOTP before loading owner data", async () => {
  const html = await readFile(frontendPath, "utf8");
  const bootstrap = html.slice(
    html.indexOf("function startAuthBootstrap"),
    html.indexOf("async function assuranceSnapshot"),
  );
  assert.ok(
    bootstrap.indexOf("requirePrivateSessionAssurance") < bootstrap.indexOf("loadMine"),
    "assurance must be checked before private data loads",
  );
  assert.match(html, /snapshot\.verified\.length&&snapshot\.currentLevel!=="aal2"/);
  assert.match(html, /challengeAndVerify\(\{factorId,code\}\)/);
  assert.match(html, /Setup incomplete/);
  assert.match(html, /function mfaRestart/);
  assert.match(html, /function mfaDiscard/);
  assert.doesNotMatch(html, /from\("ai_backends"\)\.update/);
  assert.doesNotMatch(html, /from\("ai_backends"\)\.delete/);
});

test("OpenRouter exchanges only inside the AAL2 Edge boundary", async () => {
  const [source, html, config] = await Promise.all([
    readFile(openRouterPath, "utf8"),
    readFile(frontendPath, "utf8"),
    readFile(configPath, "utf8"),
  ]);
  assert.match(config, /\[functions\.openrouter-connect\]\s*\r?\nverify_jwt = true/);
  assert.ok(
    source.indexOf("await requireAal2(req, admin)") <
      source.indexOf("fetch(OPENROUTER_EXCHANGE_URL"),
    "AAL2 must be established before the provider creates a key",
  );
  assert.match(source, /ownerClient\.rpc\("create_ai_backend"/);
  assert.doesNotMatch(source, /return json\(\{[^}]*key:\s*providerKey/s);
  assert.doesNotMatch(html, /fetch\("https:\/\/openrouter\.ai\/api\/v1\/auth\/keys"/);
  assert.match(html, /\/functions\/v1\/openrouter-connect/);
  assert.match(html, /function captureOpenRouterReturn/);
  assert.match(html, /sessionStorage\.setItem\("or_return_code",code\)/);
});
