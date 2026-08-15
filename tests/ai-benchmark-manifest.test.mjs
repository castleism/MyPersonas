import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const PATH = new URL("../MyPersonas.Online_v0/benchmarks/ai-provider-v1.json", import.meta.url);

test("AI provider benchmark is bounded, synthetic, and comparable", async () => {
  const manifest = JSON.parse(await readFile(PATH, "utf8"));
  assert.equal(manifest.data_class, "public_synthetic");
  assert.equal(manifest.default_max_cost_usd, 0);
  assert.ok(manifest.default_max_seconds > 0 && manifest.default_max_seconds <= 120);
  assert.equal(manifest.tasks.length, 8);
  assert.equal(new Set(manifest.tasks.map(task => task.id)).size, manifest.tasks.length);
  assert.ok(manifest.tasks.every(task => Array.isArray(task.requirements) && task.requirements.length >= 3));
  assert.equal(Object.values(manifest.score).reduce((sum, value) => sum + value, 0), 100);
  assert.match(manifest.rules.join(" "), /same task text and limits/i);
  assert.match(manifest.rules.join(" "), /no secrets/i);
});

test("benchmark includes safety, canon, marketing, sourcing, structure, retrieval, and multimodal cases", async () => {
  const manifest = JSON.parse(await readFile(PATH, "utf8"));
  const categories = new Set(manifest.tasks.map(task => task.category));
  for (const category of ["security", "persona", "marketing", "research", "structured_output", "retrieval", "multimodal"]) {
    assert.ok(categories.has(category), `missing ${category}`);
  }
  assert.equal(manifest.tasks.find(task => task.id === "primary_source_research").requires_web, true);
  assert.equal(manifest.tasks.find(task => task.id === "multimodal_provenance").requires_image, true);
});
