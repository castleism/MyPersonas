import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  normalizePublicSchemaDump,
  validateSchemaSnapshot,
} from "../scripts/staging-bootstrap/validate-schema-snapshot.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFile(path.join(root, relative), "utf8");

const through061Dump = String.raw`-- PostgreSQL database dump
\restrict abc123
SET row_security = off;
CREATE SCHEMA public;
CREATE TABLE public.personas(id uuid);
CREATE TABLE public.persona_page_publications(id uuid);
CREATE TABLE public.persona_media_assets(id uuid);
CREATE TABLE public.noo_waitlist(email text, CONSTRAINT noo_waitlist_input_contract CHECK (email <> ''));
CREATE FUNCTION public.owner_research_brief_queue(date,text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.personas VALUES(null); END $$;
CREATE FUNCTION public.get_research_digest(uuid,integer) RETURNS void LANGUAGE plpgsql AS $$ BEGIN UPDATE public.personas SET id=id; END $$;
CREATE FUNCTION public.invalidate_stale_aliaspaces_email_attestations() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM public.personas; RETURN new; END $$;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
\unrestrict abc123
`;

test("schema normalizer removes only public-schema creation and pg_dump restrict guards", () => {
  const normalized = normalizePublicSchemaDump(through061Dump);
  assert.doesNotMatch(normalized, /^\\(?:un)?restrict/m);
  assert.doesNotMatch(normalized, /^CREATE SCHEMA (?:public|"public");/m);
  assert.match(normalized, /CREATE TABLE public\.personas/);
  assert.throws(
    () => normalizePublicSchemaDump(through061Dump.replace("CREATE SCHEMA public;", "")),
    /exactly one CREATE SCHEMA public/,
  );
});

test("schema validator accepts through-061 DDL and DML only inside function bodies", () => {
  const result = validateSchemaSnapshot(normalizePublicSchemaDump(through061Dump));
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.errors.length, 0);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test("schema validator rejects data, roles, secrets, psql includes, and 062-plus objects", () => {
  const normalized = normalizePublicSchemaDump(through061Dump);
  const attacks = [
    "\n-- Name: users; Type: TABLE DATA; Schema: auth\n",
    "\nCOPY auth.users (id) FROM stdin;\nvalue\n\\.\n",
    "\nINSERT INTO public.personas VALUES(null);\n",
    "\nCREATE ROLE attacker LOGIN PASSWORD 'not-for-files';\n",
    "\nSELECT 'postgresql://postgres:password@db.example.test/postgres';\n",
    "\nSELECT 'sk-live-abcdefghijklmnopqrstuv';\n",
    "\n\\include /tmp/unreviewed.sql\n",
    "\nCREATE TABLE public.media_environment_config_062(singleton boolean);\n",
  ];
  for (const attack of attacks) {
    const result = validateSchemaSnapshot(normalized + attack);
    assert.equal(result.ok, false, `attack should be rejected: ${attack}`);
  }
});

test("capture/apply scripts have explicit no-data, no-production-target, hash, and phase gates", async () => {
  const [common, capture, apply] = await Promise.all([
    read("scripts/staging-bootstrap/Common.ps1"),
    read("scripts/staging-bootstrap/Export-Through061Schema.ps1"),
    read("scripts/staging-bootstrap/Invoke-StagingBootstrap.ps1"),
  ]);
  assert.match(common, /MyPersonasProductionProjectRef = 'nwsqyuucwzihruszocge'/);
  assert.match(common, /production Supabase project is forbidden as a staging target/i);
  assert.match(common, /PGPASSWORD/);
  assert.doesNotMatch(common, /postgres(?:ql)?:\/\//i);
  assert.match(capture, /'--schema-only'/);
  assert.match(capture, /'--schema=public'/);
  assert.match(capture, /'--no-owner'/);
  assert.match(capture, /'begin;',/);
  assert.match(capture, /\+ "`ncommit;`n"/);
  assert.doesNotMatch(capture, /--data-only|--role-only|migration repair|db reset/i);
  assert.match(capture, /--reject-062-plus/);
  assert.match(apply, /Assert-ExpectedHash/);
  assert.match(apply, /APPLY-THROUGH-061:/);
  assert.match(apply, /APPLY-062-AND-LOCK:/);
  assert.match(apply, /APPLY-063-064:/);
  assert.match(apply, /--dry-run/);
  assert.doesNotMatch(apply, /migration repair|db reset/i);
  assert.match(apply, /065-067 are explicitly excluded/);
  assert.doesNotMatch(apply, /--password|-p[,')]/);
});

test("staging SQL proves freshness, restores only empty platform config, and locks 062 before later verification", async () => {
  const [preflight, config, configureLock, verify062, verify064] = await Promise.all([
    read("scripts/staging-bootstrap/sql/00-preflight-fresh-staging.sql"),
    read("scripts/staging-bootstrap/sql/02-empty-platform-config-through-061.sql"),
    read("scripts/staging-bootstrap/sql/configure-and-lock-062.sql"),
    read("scripts/staging-bootstrap/sql/verify-062.sql"),
    read("scripts/staging-bootstrap/sql/verify-063-064.sql"),
  ]);
  assert.match(preflight, /auth\.users has % rows/);
  assert.match(preflight, /storage\.objects has % rows/);
  assert.match(preflight, /Vault contains % secrets/);
  assert.equal((config.match(/insert into storage\.buckets/gi) || []).length, 4);
  assert.match(config, /create policy "media public read"/);
  assert.match(config, /create policy "persona media public read"/);
  assert.doesNotMatch(config, /auth\.users\s*\(|storage\.objects\s*\(|vault\.secrets\s*\(/i);
  assert.match(configureLock, /configure_media_environment_service[\s\S]*lock_media_environment_service/);
  assert.match(configureLock, /commit;/);
  assert.match(verify062, /locked_at is null/);
  assert.match(verify064, /post_approved_media_handles/);
  assert.match(verify064, /inventory_legacy_media_references_service\(uuid,integer\)/);
});

test("frontend artifact generator permits only two exact staging hosts and rejects crossover", async () => {
  const [common, generator, runbook] = await Promise.all([
    read("scripts/staging-bootstrap/Common.ps1"),
    read("scripts/staging-bootstrap/New-StagingFrontendArtifact.ps1"),
    read("supabase/STAGING-BOOTSTRAP-RUNBOOK.md"),
  ]);
  for (const origin of ["https://mypersonas-staging.pages.dev", "https://staging.mypersonas.online"]) {
    assert.match(common, new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(generator, new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(generator, /\*\.pages\.dev|endsWith\([^\n]*pages\.dev/i);
  assert.match(generator, /window\.location\.origin!==STAGING_RUNTIME_ORIGIN/);
  assert.match(generator, /CONFIG\.SUPABASE_URL!==STAGING_SUPABASE_ORIGIN/);
  assert.match(generator, /CONFIG\.PUBLIC_MEDIA_ORIGIN!==STAGING_MEDIA_ORIGIN/);
  assert.match(generator, /production key/i);
  assert.match(generator, /Production CNAME must never enter/);
  assert.match(generator, /X-Robots-Tag: noindex, nofollow, noarchive, nosnippet/);
  assert.match(generator, /pwa_cache_policy = 'teardown-and-unregister'/);
  assert.match(generator, /staging-artifact-files\.json/);
  assert.match(generator, /\$publicFiles = @\(/);
  assert.doesNotMatch(generator, /Get-ChildItem -LiteralPath \$sourceDirectory -Force \| ForEach-Object/);
  assert.match(runbook, /Cloudflare Access/);
  assert.match(runbook, /no wildcard `\*\.pages\.dev`/i);
  assert.match(runbook, /two-account privacy matrix/i);
});

test("generated Pages artifact is allowlisted, noindex, CNAME-free, and staging-bound", async (t) => {
  if (process.platform !== "win32") return t.skip("PowerShell artifact generation is Windows-only");
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), "mypersonas-staging-artifact-"));
  const temp = path.join(packageRoot, "public");
  const fileManifestPath = `${temp}.staging-artifact-files.json`;
  const artifactManifestPath = `${temp}.staging-artifact-manifest.json`;
  try {
    execFileSync("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(root, "scripts/staging-bootstrap/New-StagingFrontendArtifact.ps1"),
      "-OutputDirectory", temp,
      "-StagingProjectRef", "abcdefghijklmnopqrst",
      "-StagingSiteOrigin", "https://mypersonas-staging.pages.dev",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        MP_STAGING_SUPABASE_ANON_KEY: "sb_publishable_staging_test_abcdefghijklmnop",
        MP_STAGING_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      },
    });

    const [index, robots, headers, webManifest, pwa, worker, registry, downloadStub, files, manifest] = await Promise.all([
      readFile(path.join(temp, "index.html"), "utf8"),
      readFile(path.join(temp, "robots.txt"), "utf8"),
      readFile(path.join(temp, "_headers"), "utf8"),
      readFile(path.join(temp, "manifest.webmanifest"), "utf8").then(JSON.parse),
      readFile(path.join(temp, "pwa.js"), "utf8"),
      readFile(path.join(temp, "service-worker.js"), "utf8"),
      readFile(path.join(temp, "assets/Extensions/registry.json"), "utf8").then(JSON.parse),
      readFile(path.join(temp, "assets/Downloads/Personas/index.html"), "utf8"),
      readFile(fileManifestPath, "utf8").then(JSON.parse),
      readFile(artifactManifestPath, "utf8").then(JSON.parse),
    ]);
    await assert.rejects(readFile(path.join(temp, "CNAME")), /ENOENT/);
    await assert.rejects(readFile(path.join(temp, "sitemap.xml")), /ENOENT/);
    assert.equal(robots, "User-agent: *\nDisallow: /\n");
    assert.match(headers, /X-Robots-Tag: noindex, nofollow, noarchive, nosnippet/);
    assert.match(index, /<meta name="robots" content="noindex,nofollow,noarchive,nosnippet">/);
    assert.match(index, /SUPABASE_URL:"https:\/\/abcdefghijklmnopqrst\.supabase\.co"/);
    assert.match(index, /PUBLIC_MEDIA_ORIGIN:"https:\/\/media-staging\.mypersonas\.online"/);
    assert.doesNotMatch(index, /SUPABASE_URL:"https:\/\/nwsqyuucwzihruszocge\.supabase\.co"/);
    assert.equal(webManifest.start_url, "https://mypersonas-staging.pages.dev/");
    assert.equal(webManifest.scope, "https://mypersonas-staging.pages.dev/");
    assert.equal(webManifest.id, "https://mypersonas-staging.pages.dev/");
    assert.match(pwa, /serviceWorker\.register/);
    assert.match(worker, /registration\.unregister/);
    assert.doesNotMatch(worker, /addEventListener\("fetch"/);
    assert.deepEqual(registry.map(({ id }) => id), ["concept"]);
    assert.match(downloadStub, /production and is intentionally excluded/i);
    assert.equal(manifest.cname_included, false);
    assert.equal(manifest.pwa_cache_policy, "teardown-and-unregister");
    assert.equal(manifest.production_desktop_download_included, false);
    assert.equal(manifest.asset_copy_contract, "exact-reviewed-file-allowlist");
    assert.equal(manifest.file_count, files.length);
    const expectedFiles = new Set([
      "index.html", "owner-app.css", "owner-app.js", "persona-view.css", "persona-view.js",
      "platform-governance.css", "platform-governance.js", "ai-content-provenance.css", "ai-content-provenance.js",
      "profile-image-crop.css", "profile-image-crop.js", "agent-board.css", "agent-board.js",
      "manifest.webmanifest", "service-worker.js", "pwa.js", "offline.html", ".nojekyll", "robots.txt",
      "privacy.html", "terms.html", "data-deletion.html", "provider-setup.html", "_headers",
      "assets/bg.png", "assets/favicon.svg", "assets/hero.png", "assets/MyPersonas-AI-Watermark.png",
      "assets/Extensions/Concept/releases.json", "assets/Extensions/registry.json",
      "assets/Downloads/Personas/index.html",
      "brand/app-icon/favicon.ico", "brand/app-icon/icon.svg", "brand/app-icon/icon-180.png",
      "brand/app-icon/icon-192.png", "brand/app-icon/icon-512.png", "brand/app-icon/icon-maskable-512.png",
    ]);
    assert.deepEqual(new Set(files.map(({ path: relative }) => relative)), expectedFiles);
    assert.ok(files.every((entry) => !/(^|\/)(?:\.git|\.github|tests|sql-updates)(\/|$)|\.md$|\.zip$|(^|\/)CNAME$|sitemap\.xml$/i.test(entry.path)));
    const textEntry = /(?:\.html|\.js|\.css|\.json|\.webmanifest|\.svg|\.txt|_headers)$/i;
    const productionMarker = /nwsqyuucwzihruszocge|sb_publishable_vN6BdSvBKf_yTJt0eeK20w_afKz1Df2|https:\/\/media\.mypersonas\.online|https:\/\/mypersonas\.online/;
    for (const entry of files) {
      const bytes = await readFile(path.join(temp, entry.path));
      assert.equal(bytes.byteLength, entry.bytes, `${entry.path} byte count`);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256, `${entry.path} SHA-256`);
      if (textEntry.test(entry.path)) {
        const text = bytes.toString("utf8");
        assert.doesNotMatch(text, productionMarker, entry.path);
        if (entry.path.endsWith(".html")) {
          assert.match(text, /<meta name="robots" content="noindex,nofollow,noarchive,nosnippet">/i, entry.path);
        }
      }
    }
    assert.equal(createHash("sha256").update(await readFile(fileManifestPath)).digest("hex"), manifest.file_manifest_sha256);
    assert.equal(createHash("sha256").update(await readFile(path.join(temp, "index.html"))).digest("hex"), manifest.index_sha256);
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test("generated custom-host artifact stays on the one exact optional staging origin", async (t) => {
  if (process.platform !== "win32") return t.skip("PowerShell artifact generation is Windows-only");
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), "mypersonas-custom-staging-artifact-"));
  const publicDirectory = path.join(packageRoot, "public");
  try {
    execFileSync("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      path.join(root, "scripts/staging-bootstrap/New-StagingFrontendArtifact.ps1"),
      "-OutputDirectory", publicDirectory,
      "-StagingProjectRef", "abcdefghijklmnopqrst",
      "-StagingSiteOrigin", "https://staging.mypersonas.online",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        MP_STAGING_SUPABASE_ANON_KEY: "sb_publishable_staging_test_abcdefghijklmnop",
        MP_STAGING_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      },
    });
    const [index, webManifest, artifactManifest] = await Promise.all([
      readFile(path.join(publicDirectory, "index.html"), "utf8"),
      readFile(path.join(publicDirectory, "manifest.webmanifest"), "utf8").then(JSON.parse),
      readFile(`${publicDirectory}.staging-artifact-manifest.json`, "utf8").then(JSON.parse),
    ]);
    assert.match(index, /const STAGING_RUNTIME_ORIGIN="https:\/\/staging\.mypersonas\.online"/);
    assert.doesNotMatch(index, /mypersonas-staging\.pages\.dev/);
    assert.equal(webManifest.start_url, "https://staging.mypersonas.online/");
    assert.equal(artifactManifest.exact_site_origin, "https://staging.mypersonas.online");
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test("all PowerShell staging scripts parse without syntax errors", async (t) => {
  if (process.platform !== "win32") return t.skip("PowerShell parser check is Windows-only");
  const scripts = [
    "scripts/staging-bootstrap/Common.ps1",
    "scripts/staging-bootstrap/Export-Through061Schema.ps1",
    "scripts/staging-bootstrap/Invoke-StagingBootstrap.ps1",
    "scripts/staging-bootstrap/New-StagingFrontendArtifact.ps1",
  ];
  for (const relative of scripts) {
    const full = path.join(root, relative);
    const command = [
      "$tokens=$null;$errors=$null;",
      `[void][Management.Automation.Language.Parser]::ParseFile('${full.replaceAll("'", "''")}',[ref]$tokens,[ref]$errors);`,
      "if($errors.Count){$errors|ForEach-Object{$_.ToString()};exit 1}",
    ].join("");
    assert.doesNotThrow(() => execFileSync("powershell", ["-NoProfile", "-Command", command], { encoding: "utf8" }), relative);
  }
});

test("validator CLI writes only a rule-level report for an unsafe snapshot", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "mypersonas-staging-validator-"));
  try {
    const input = path.join(temp, "unsafe.sql");
    const report = path.join(temp, "report.json");
    await writeFile(input, normalizePublicSchemaDump(through061Dump) + "\nSELECT 'whsec_abcdefghijklmnopqrstu';\n", "utf8");
    assert.throws(() => execFileSync(process.execPath, [
      path.join(root, "scripts/staging-bootstrap/validate-schema-snapshot.mjs"),
      "--input", input,
      "--report", report,
      "--require-through-061",
      "--reject-062-plus",
    ], { stdio: "pipe" }));
    const parsed = JSON.parse(await readFile(report, "utf8"));
    assert.equal(parsed.ok, false);
    assert.match(parsed.errors.join(" "), /webhook secret/i);
    assert.doesNotMatch(JSON.stringify(parsed), /whsec_abcdefghijklmnopqrstu/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
