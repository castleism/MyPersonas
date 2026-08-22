import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (value) => readFile(path.join(root, value), "utf8");

test("persona writing fields share accessible help and non-saving examples", async () => {
  const html = await read("MyPersonas.Online_v0/index.html");

  assert.match(html, /const PERSONA_FIELD_GUIDES=Object\.freeze/);
  assert.match(html, /function fieldHelp\(key,label\)/);
  assert.match(html, /tabindex="0" role="note"/);
  assert.match(html, /\.field-help:hover \.field-help-popover,\.field-help:focus \.field-help-popover/);
  assert.match(html, /@media\(max-width:600px\)\{\.field-help-popover\{position:fixed/);

  for (const key of [
    "name", "handle", "tagline", "bio", "purpose", "voice", "topics", "audience", "hashtags", "dont",
    "roadmap", "privateNotes", "primaryGoal", "successMetric", "audienceFocus", "contentPillars", "campaign",
    "cta", "offers", "disclosure", "sources", "platform", "slotInstructions", "knowledge", "aiModel",
  ]) {
    assert.match(html, new RegExp(`${key}:\\{help:`), `${key} needs centralized guidance`);
  }

  for (const id of ["eName", "eHandle", "eTagline", "eBio", "ePurpose", "eVoice", "eTopics", "eAudience", "eHashtags", "eDont", "eContext", "eNotes"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*placeholder="\\$\\{fieldTemplate\\(`), `${id} needs an empty-field example`);
  }

  assert.match(html, /data-ob="voice"[^>]*placeholder="\$\{fieldTemplate\("voice"\)\}/);
  assert.match(html, /id="apPlatform"[^>]*placeholder="\$\{fieldTemplate\("platform"\)\}/);
  assert.match(html, /id="asInstr"[^>]*placeholder="\$\{fieldTemplate\("slotInstructions"\)\}/);
  assert.doesNotMatch(html, /value="\$\{fieldTemplate\(/, "examples must not become saved values");
  assert.match(html, /voice:document\.getElementById\("eVoice"\)\.value/);
  assert.match(html, /Hard rules — never do: \$\{p\.dont\|\|"n\/a"\}/);
});

test("owner surfaces explain voice and model route choices", async () => {
  const [html, owner] = await Promise.all([
    read("MyPersonas.Online_v0/index.html"),
    read("MyPersonas.Online_v0/owner-app.js"),
  ]);

  assert.match(owner, /Voice &amp; boundaries \$\{fieldHelp\("voice", "Voice and boundaries"\)\}/);
  assert.match(owner, /The key only authenticates the provider/);
  assert.match(html, /An API key is a credential, not a personality setting/);
  for (const model of ["GPT-5.6 Terra", "GPT-5.6 Luna", "GPT-5.6 Sol"]) {
    assert.match(html, new RegExp(model));
    assert.match(owner, new RegExp(model));
  }
});
