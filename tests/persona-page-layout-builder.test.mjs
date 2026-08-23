import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const htmlPath = path.join(root, "MyPersonas.Online_v0", "index.html");
const sqlPath = path.join(root, "MyPersonas.Online_v0", "sql-updates", "050-persona-page-layout-builder.sql");
const migrationPath = path.join(root, "supabase", "migrations", "20260822150000_persona_page_layout_builder.sql");

async function sources() {
  const [html, sql, mirror] = await Promise.all([
    fs.readFile(htmlPath, "utf8"),
    fs.readFile(sqlPath, "utf8"),
    fs.readFile(migrationPath, "utf8"),
  ]);
  return { html, sql, mirror };
}

function pageBuilderCore(html) {
  const start = html.indexOf("const PAGE_LAYOUT_MODULES=");
  const end = html.indexOf("function go(", start);
  assert.ok(start > 0 && end > start, "page-builder helper block must remain extractable");
  const context = vm.createContext({
    URL,
    Blob,
    pageState: { p: { theme: "#123456" }, isOwner: true },
    parsedHttpUrl(raw) {
      try {
        const url = new URL(String(raw || "").trim());
        return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url : null;
      } catch {
        return null;
      }
    },
    safeHttpUrl(raw) {
      const url = context.parsedHttpUrl(raw);
      return url ? url.href : "";
    },
    safeTheme(raw) {
      return /^#[0-9a-f]{6}$/i.test(String(raw || "")) ? String(raw) : "#ff4fa3";
    },
    esc(value) {
      return String(value || "").replace(/[&<>"']/g, "_");
    },
    ico() { return ""; },
  });
  vm.runInContext(html.slice(start, end), context);
  return context;
}

test("migration 050 mirrors exactly and keeps public and private data separated", async () => {
  const { sql, mirror } = await sources();
  assert.equal(mirror.replaceAll("\r\n", "\n"), sql.replaceAll("\r\n", "\n"));
  assert.match(sql, /create table if not exists public\.persona_page_layouts/);
  assert.match(sql, /create table if not exists public\.persona_page_code_snippets/);
  assert.match(sql, /alter table public\.persona_page_layouts enable row level security/);
  assert.match(sql, /revoke all on table public\.persona_page_layouts from public, anon, authenticated/);
  assert.match(sql, /revoke all on table public\.persona_page_code_snippets from public, anon, authenticated/);
  assert.match(sql, /grant select on table public\.persona_page_layouts to authenticated/);
  assert.match(sql, /grant select on table public\.persona_page_code_snippets to authenticated/);
  assert.match(sql, /foreign key \(persona_id, owner\)[\s\S]*references public\.personas\(id, owner\) on delete cascade/);
  assert.match(sql, /grant execute on function public\.persona_page_layout\(uuid\) to anon, authenticated/);
  assert.doesNotMatch(sql, /grant select[^;]*persona_page_code_snippets[^;]*anon/is);
  const publicFunction = sql.slice(sql.indexOf("create or replace function public.persona_page_layout("), sql.indexOf("create or replace function public.my_persona_page_code_snippets"));
  assert.doesNotMatch(publicFunction, /owner|code_snippets|\bcode\b/i);
});

test("database validator accepts only bounded declarative layout recipes", async () => {
  const { sql } = await sources();
  assert.match(sql, /octet_length\(new\.layout::text\) > 30000/);
  assert.match(sql, /'live','music','about','fan_chat','links','top8','linked','family','revenue','albums','feed'/);
  assert.match(sql, /hashtextextended\(p_persona_id::text,51051051\)/);
  assert.match(sql, /Page module order cannot contain duplicates/);
  assert.match(sql, /jsonb_array_length\(coalesce\(new\.layout -> 'widgets'/);
  assert.match(sql, /not in \('text','link'\)/);
  assert.match(sql, /Page link widgets require an HTTPS URL/);
  assert.match(sql, /language in \('html','css','json'\)/);
  assert.match(sql, /Snippet code must be 20000 bytes or less/);
  assert.match(sql, /Never stores or executes arbitrary HTML, CSS, JavaScript, SVG, or extension code/);
});

test("layout normalization drops unknown modules, unsafe links, and arbitrary fields", async () => {
  const { html } = await sources();
  const core = pageBuilderCore(html);
  const normalized = core.normalizePersonaPageLayout({
    version: 99,
    order: ["feed", "feed", "not-real", "about"],
    cards: { feed: { span: "full", shape: "round", tone: "theme", css: "position:fixed" } },
    widgets: [
      { id: "safe", kind: "text", title: "Hello", body: "World", script: "alert(1)" },
      { id: "bad", kind: "link", title: "Bad", url: "javascript:alert(1)" },
      { id: "good", kind: "link", title: "Good", url: "https://example.com/path" },
    ],
  });
  assert.deepEqual(Array.from(normalized.order.slice(0, 2)), ["feed", "about"]);
  assert.equal(new Set(normalized.order).size, 11);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.cards.feed)), { span: "full", shape: "round", tone: "theme" });
  assert.deepEqual(Array.from(normalized.widgets, (widget) => widget.id), ["safe", "good"]);
  assert.equal("script" in normalized.widgets[0], false);
});

test("learning console is local, read-only, and never becomes a public code runtime", async () => {
  const { html } = await sources();
  const core = pageBuilderCore(html);
  const layout = core.normalizePersonaPageLayout({
    order: ["about", "feed"],
    cards: { feed: { span: "full" } },
    widgets: [{ id: "box", kind: "text", title: "A <box>", body: "Body" }],
  });
  assert.match(core.pageLayoutLearningCode(layout, "html"), /<section class="profile-card/);
  assert.match(core.pageLayoutLearningCode(layout, "css"), /grid-template-columns/);
  assert.equal(JSON.parse(core.pageLayoutLearningCode(layout, "json")).version, 1);
  assert.match(core.explainPageCodeSelection("grid-column"), /stretch/i);
  const builderStart = html.indexOf("function pageBuilderEditorHtml");
  const builderEnd = html.indexOf("function personaBackupEditorHtml", builderStart);
  const builder = html.slice(builderStart, builderEnd);
  assert.match(builder, /id="pageBuilderCode" readonly/);
  assert.match(builder, /never injected into a profile/);
  assert.doesNotMatch(builder, /\beval\s*\(|new Function|srcdoc|allow-scripts/);
});

test("owner asset preview covers page art and media with bounded credential-free downloads", async () => {
  const { html } = await sources();
  const governance = await fs.readFile(path.join(root, "MyPersonas.Online_v0", "platform-governance.js"), "utf8");
  assert.match(html, /ownsReviewPersona/);
  assert.match(html, /ownsEditorAsset/);
  assert.match(html, /if\(!pageState\?\.isOwner&&!ownsReviewPersona&&!ownsEditorAsset&&!ownsActingPage\)return/);
  assert.match(governance, /data-owner-persona-id/);
  assert.match(html, /Banner image/);
  assert.match(html, /Profile image/);
  assert.match(html, /Preview background/);
  assert.match(html, /Feed header/);
  assert.match(html, /Post image/);
  assert.match(html, /Post video/);
  assert.match(html, /data-persona-asset-label/);
  assert.match(html, /role="dialog" aria-modal="true" aria-labelledby="personaAssetTitle"/);
  assert.match(html, /fetch\(url,\{credentials:"omit",referrerPolicy:"no-referrer",cache:"no-store"\}\)/);
  assert.match(html, /boundedAssetBlob\(response,maxBytes=50\*1024\*1024\)/);
  assert.match(html, /reader\.cancel\(\)/);
  assert.match(html, /URL\.revokeObjectURL/);
  assert.doesNotMatch(html.slice(html.indexOf("async function downloadPersonaAssetCopy"), html.indexOf("function go(", html.indexOf("async function downloadPersonaAssetCopy"))), /Authorization|access_token|service_role/i);
});

test("asset filename and type helpers reject active URLs and traversal-like names", async () => {
  const { html } = await sources();
  const core = pageBuilderCore(html);
  assert.equal(core.personaAssetType("https://cdn.example/file.webm"), "video");
  assert.equal(core.personaAssetType("javascript:alert(1)"), "file");
  assert.equal(core.safePersonaAssetFilename("https://cdn.example/%2e%2e/%3Cbad%3E.html", "My Banner", "image/png"), "my-banner.png");
  assert.equal(core.safePersonaAssetFilename("https://cdn.example/payload.html", "My Banner", "application/octet-stream"), "my-banner");
  assert.equal(core.safePersonaAssetFilename("https://cdn.example/photo.png", "Voice Clip", "audio/mpeg"), "voice-clip.mp3");
  assert.equal(core.personaAssetAttributes("javascript:alert(1)", "Bad", true), "");
  assert.equal(core.personaAssetAttributes("https://example.com/a.png", "Good", false), "");
  assert.match(core.personaAssetAttributes("https://example.com/a.png", "Good", true), /data-persona-asset-url/);
});

test("asset copy accepts only allowlisted MIME with matching inert media signatures", async () => {
  const { html } = await sources();
  const core = pageBuilderCore(html);
  const ascii = value => [...Buffer.from(value, "ascii")];
  const fixtures = new Map([
    ["image/png", [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]],
    ["image/jpeg", [0xff,0xd8,0xff,0xe0]],
    ["image/webp", [...ascii("RIFF"),0,0,0,0,...ascii("WEBP")]],
    ["image/gif", ascii("GIF89a")],
    ["image/avif", [0,0,0,24,...ascii("ftyp"),...ascii("avif"),0,0,0,0,...ascii("avif"),...ascii("mif1")]],
    ["video/mp4", [0,0,0,24,...ascii("ftyp"),...ascii("isom"),0,0,0,0,...ascii("isom"),...ascii("mp42")]],
    ["video/webm", [0x1a,0x45,0xdf,0xa3,0,0,0,0,...ascii("webm")]],
    ["audio/mpeg", ascii("ID3")],
    ["audio/ogg", ascii("OggS")],
    ["audio/wav", [...ascii("RIFF"),0,0,0,0,...ascii("WAVE")]],
    ["audio/x-wav", [...ascii("RIFF"),0,0,0,0,...ascii("WAVE")]],
    ["audio/mp4", [0,0,0,24,...ascii("ftyp"),...ascii("M4A "),0,0,0,0,...ascii("isom"),...ascii("M4A ")]],
  ]);
  for (const [mime, bytes] of fixtures) {
    const blob = await core.boundedAssetBlob(new Response(Uint8Array.from(bytes), { headers: { "content-type": mime } }));
    assert.equal(blob.type, mime, mime);
  }
});

test("asset copy rejects unknown, active, and signature-mismatched responses", async () => {
  const { html } = await sources();
  const core = pageBuilderCore(html);
  const response = (body, type) => new Response(body, { headers: { "content-type": type } });
  await assert.rejects(core.boundedAssetBlob(response("not media", "application/octet-stream")), /supported inert media type/);
  await assert.rejects(core.boundedAssetBlob(response("<svg xmlns='http://www.w3.org/2000/svg'><script/></svg>", "image/svg+xml")), /supported inert media type/);
  await assert.rejects(core.boundedAssetBlob(response("<!doctype html><script>alert(1)</script>", "image/png")), /bytes do not match/);
  await assert.rejects(core.boundedAssetBlob(response("<!doctype html><script>alert(1)</script>", "image/jpeg")), /bytes do not match/);
  assert.equal(core.safePersonaAssetFilename("https://evil.example/payload.html", "Persona asset", "image/png"), "persona-asset.png");
});

test("opaque public-asset correlation remains an explicit release blocker", async () => {
  const { html } = await sources();
  assert.match(html, /stable owner UUID path that can correlate personas/);
  assert.match(html, /New image\/video widgets and video backgrounds remain disabled/);
  assert.doesNotMatch(html.slice(html.indexOf("function normalizePersonaPageLayout"), html.indexOf("function personaAssetType", html.indexOf("function normalizePersonaPageLayout"))), /kind===?"(?:image|video)"/);
});

test("backup, restore, spreadsheet, and privacy export include layouts and private snippets", async () => {
  const { html } = await sources();
  assert.match(html, /loadOwnedPages\("persona_page_layouts","\*","updated_at",true,uid\)/);
  assert.match(html, /loadOwnedPages\("persona_page_code_snippets","\*","updated_at",true,uid\)/);
  assert.match(html, /persona_page_layouts:layouts\.data\|\|\[\]/);
  assert.match(html, /persona_page_code_snippets:snippets\.data\|\|\[\]/);
  assert.match(html, /add\("Page Layouts"/);
  assert.match(html, /add\("Private Code Snippets"/);
  const restore = html.slice(html.indexOf("async function restoreImport"), html.indexOf("// ---------- first-persona onboarding"));
  assert.match(restore, /restoredIds\.get\(row\?\.persona_id\)/);
  assert.match(restore, /restoreRpc\(context,"set_persona_page_layout"/);
  assert.match(restore, /restoreRpc\(context,"save_persona_page_code_snippet"/);
  assert.match(restore, /normalizePersonaPageLayout\(row\.layout\)/);
});
