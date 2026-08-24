import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const indexPath = new URL("../MyPersonas.Online_v0/index.html", import.meta.url);
const source = await readFile(indexPath, "utf8");

function authFunction(name) {
  const match = source.match(
    new RegExp(`async function ${name}\\(\\)\\{[\\s\\S]*?\\n\\}`),
  );
  assert.ok(match, `${name} should exist`);
  return match[0];
}

test("email authentication is fail-closed until Turnstile is configured and solved", () => {
  assert.match(source, /id="authPasswordSignin"[^>]*disabled/);
  assert.match(source, /id="authPasswordSignup"[^>]*disabled/);
  assert.match(source, /id="authMagicLink"[^>]*disabled/);
  assert.match(source, /if\(!CONFIG\.TURNSTILE_SITE_KEY\)[\s\S]*Email sign-in is temporarily unavailable/);
  assert.match(source, /turnstile\.render\(box,\{sitekey:CONFIG\.TURNSTILE_SITE_KEY,action:"account_auth"/);
  assert.match(source, /callback:token=>[\s\S]*setAuthEmailControlsEnabled\(true\)/);
  assert.match(source, /"expired-callback":\(\)=>resetAuthCaptcha\(\)/);
  assert.match(source, /"timeout-callback":\(\)=>resetAuthCaptcha\(\)/);
  assert.match(source, /"error-callback":\(\)=>\{resetAuthCaptcha\(\)/);
});

test("Turnstile tokens are bounded, consumed once, and reset after every auth request", () => {
  assert.match(source, /token\.length<10\|\|token\.length>4096/);
  assert.match(source, /box\.dataset\.captchaToken="";setAuthEmailControlsEnabled\(false\)/);
  for (const name of ["magicLink", "passwordSignin", "passwordSignup"]) {
    const fn = authFunction(name);
    const consume = fn.indexOf("consumeAuthCaptchaToken()");
    const request = fn.indexOf("sb.auth.");
    assert.ok(consume >= 0 && request > consume, `${name} must consume CAPTCHA before auth`);
    assert.match(fn, /finally\{resetAuthCaptcha\(\)\}/);
  }
});

test("the pinned Supabase client receives captchaToken in each supported options object", () => {
  assert.match(source, /@supabase\/supabase-js@2\.110\.7/);
  assert.match(
    authFunction("magicLink"),
    /signInWithOtp\(\{email,options:\{emailRedirectTo:location\.origin\+location\.pathname,captchaToken\}\}\)/,
  );
  assert.match(
    authFunction("passwordSignin"),
    /signInWithPassword\(\{email,password,options:\{captchaToken\}\}\)/,
  );
  assert.match(
    authFunction("passwordSignup"),
    /signUp\(\{email,password,options:\{emailRedirectTo:location\.origin\+location\.pathname,captchaToken\}\}\)/,
  );
});
