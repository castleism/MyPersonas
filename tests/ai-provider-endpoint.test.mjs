import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  resolveAiProviderEndpoint,
} from "../supabase/functions/_shared/ai-provider-endpoint.ts";

function assertPlaceholderRejected(baseUrl) {
  const result = resolveAiProviderEndpoint({
    provider: "azure",
    baseUrl,
    extra: { api_version: "2024-06-01" },
  });
  assert.deepEqual(result, {
    error:
      "Replace the Azure resource and deployment placeholders with real endpoint values.",
    code: "backend_endpoint_placeholder",
  });
}

test("Azure endpoint templates fail closed before a provider URL is returned", () => {
  for (const baseUrl of [
    "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT",
    "https://your-resource-name.openai.azure.com/openai/deployments/persona-chat",
    "https://mypersonas-rnd.openai.azure.com/openai/deployments/your_deployment_name",
    "https://resource-name.openai.azure.com/openai/deployments/deployment-name/chat/completions",
  ]) {
    assertPlaceholderRejected(baseUrl);
  }
});

test("reviewed Azure and fixed-provider endpoint shapes remain accepted", () => {
  const azure = resolveAiProviderEndpoint({
    provider: "azure-openai",
    baseUrl:
      "https://mypersonas-rnd.openai.azure.com/openai/deployments/persona-chat-prod",
    extra: { api_version: "2024-06-01" },
  });
  assert.equal("error" in azure, false);
  assert.equal(azure.kind, "azure");
  assert.equal(
    azure.url.href,
    "https://mypersonas-rnd.openai.azure.com/openai/deployments/persona-chat-prod/chat/completions?api-version=2024-06-01",
  );

  const openRouter = resolveAiProviderEndpoint({
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  });
  assert.equal("error" in openRouter, false);
  assert.equal(
    openRouter.url.href,
    "https://openrouter.ai/api/v1/chat/completions",
  );
});

test("research execution resolves the endpoint before its provider fetch", async () => {
  const source = await readFile(
    new URL("../supabase/functions/research-brief-run/index.ts", import.meta.url),
    "utf8",
  );
  const validation = source.indexOf("resolveAiProviderEndpoint({");
  const fetch = source.indexOf("fetch(endpoint.url");
  assert.ok(validation >= 0 && fetch > validation);
});
