import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8");

test("affiliate redirect fails closed and sends only bounded pseudonymous attribution", async () => {
  const source = await read("supabase/functions/affiliate-redirect/index.ts");

  assert.match(source, /AFFILIATE_CLICK_HMAC_SECRET/);
  assert.match(source, /CLICK_HMAC_SECRET\.length < 32/);
  assert.match(source, /status: 503/);
  assert.match(source, /crypto\.subtle\.importKey\([\s\S]*name: "HMAC", hash: "SHA-256"/);
  assert.doesNotMatch(source, /crypto\.subtle\.digest/);
  assert.match(source, /affiliate-click:fingerprint:v1:/);
  assert.match(source, /affiliate-click:user-agent:v1:/);
  assert.match(source, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
  assert.match(source, /req\.url\.length > 8192/);
  assert.match(source, /\^\[0-9a-f\]\{8\}-\[0-9a-f\]/);
  assert.match(source, /normalized\.length <= 120/);
  assert.match(source, /parsed\.hostname\.toLowerCase\(\)\.slice\(0, 253\)/);
  assert.match(source, /const admin = createClient/);
  assert.ok(
    source.indexOf("CLICK_HMAC_SECRET.length < 32") < source.indexOf("const admin = createClient"),
    "the client must not be created until required configuration is validated",
  );
  assert.match(source, /rpc\(\s*"resolve_affiliate_redirect_service"/);
  assert.doesNotMatch(source, /rpc\(\s*"record_affiliate_click"/);
  assert.doesNotMatch(source, /rpc\(\s*"get_public_affiliate_destination"/);
  assert.match(source, /function isPublicHttpsDestination/);
  assert.match(source, /parsed\.protocol !== "https:" \|\| parsed\.username \|\| parsed\.password/);
  assert.match(source, /!hostname\.includes\("\."\)/);
  assert.match(source, /\^\[0-9\.\]\+\$/);
  assert.match(source, /"\.localhost", "\.local", "\.internal", "\.lan"/);
  assert.match(source, /"Cache-Control": "no-store, max-age=0"/);
  assert.match(source, /"Referrer-Policy": "no-referrer"/);
});

test("affiliate redirect database resolver is atomic, capped, deduplicated, and service-only", async () => {
  const sql = await read("MyPersonas.Online_v0/sql-updates/051-publication-social-security-governance.sql");
  const resolver = sql.match(/create or replace function public\.resolve_affiliate_redirect_service[\s\S]*?\n\$\$;/)?.[0] || "";

  assert.match(sql, /create table if not exists public\.affiliate_click_rate_limits/);
  assert.match(sql, /scope in \('global_day','offer_hour','fingerprint_offer_day'\)/);
  assert.match(sql, /primary key \(scope,key_hash,window_start\)/);
  assert.match(sql, /revoke all on public\.affiliate_click_rate_limits from public,anon,authenticated/);
  assert.match(resolver, /coalesce\(auth\.role\(\),''\)<>'service_role'/);
  assert.match(resolver, /lock_persona_publication_mutation/);
  assert.match(resolver, /persona_publication_is_current/);
  assert.match(resolver, /is_safe_credential_free_https_url\(product\.affiliate_url,false\)/);
  assert.match(resolver, /char_length\(coalesce\(p_referrer_host,''\)\)>253/);
  assert.match(resolver, /coalesce\(p_fingerprint_hash,''\)!~'\^\[0-9a-f\]\{64\}\$'/);
  assert.match(resolver, /v_global_hits>5000/);
  assert.match(resolver, /v_offer_hits>500/);
  assert.match(resolver, /v_fingerprint_hits>1/);
  assert.match(resolver, /insert into public\.affiliate_click_events/);
  assert.match(resolver, /created_at<v_now-interval '400 days'/);
  assert.match(sql, /revoke all on function public\.get_public_affiliate_destination\(uuid\),[\s\S]*record_affiliate_click[\s\S]*service_role/);
  assert.match(sql, /grant execute on function public\.resolve_affiliate_redirect_service[\s\S]*to service_role/);
  const validator = sql.match(/create or replace function public\.is_safe_credential_free_https_url[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(validator, /position\('@' in v_authority\)>0/);
  assert.match(validator, /v_port_text::integer not between 1 and 65535/);
  assert.match(validator, /char_length\(v_label\) not between 1 and 63/);
  assert.match(validator, /position\('\.' in v_host\)=0/);
  assert.match(validator, /v_host~'\^\[0-9\.\]\+\$'/);
  assert.match(validator, /0x\[0-9a-f\]\+/);
  assert.match(sql, /persona_public_urls_safe[\s\S]*persona_affiliate_offers/);
});

test("affiliate redirect is explicitly an unauthenticated navigation endpoint", async () => {
  const config = await read("supabase/config.toml");
  assert.match(config, /\[functions\.affiliate-redirect\][\s\S]*verify_jwt\s*=\s*false/);
});
