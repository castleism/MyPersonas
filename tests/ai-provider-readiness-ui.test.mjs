import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(
  new URL("../MyPersonas.Online_v0/index.html", import.meta.url),
  "utf8",
);

test("provider matrix rejects Azure templates and distinguishes setup from a live test", () => {
  assert.match(html, /function backendEndpointConfigured\(b\)/);
  assert.match(html, /resourcePlaceholders/);
  assert.match(html, /deploymentPlaceholders/);
  assert.match(html, /backendVerifiedThisSession\.has\(b\.id\)/);
  assert.match(html, /provider test not recorded/);
  assert.match(html, /tested this session/);
  assert.doesNotMatch(html, /all automations ready/);
});
