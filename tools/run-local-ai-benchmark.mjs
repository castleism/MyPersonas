#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "MyPersonas.Online_v0", "benchmarks", "ai-provider-v1.json");
const ALLOWED_ENDPOINTS = new Set([
  "http://127.0.0.1:11434/v1/chat/completions",
  "http://localhost:11434/v1/chat/completions",
]);

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

const model = argument("--model", "gpt-oss:20b").trim();
const taskId = argument("--task", "strict_json").trim();
const endpoint = argument("--endpoint", "http://127.0.0.1:11434/v1/chat/completions").trim();

if (!model || model.length > 120 || /[\r\n]/.test(model)) {
  fail("Invalid local model name.");
} else if (!ALLOWED_ENDPOINTS.has(endpoint)) {
  fail("This runner is local-only. Use the exact loopback Ollama endpoint.");
} else {
  const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));
  const task = manifest.tasks.find((item) => item.id === taskId);
  if (!task) {
    fail(`Unknown benchmark task: ${taskId}`);
  } else if (task.requires_web || task.requires_image || taskId === "long_context_retrieval") {
    fail("That task requires a separately approved source or image packet and is not eligible for this text-only runner.");
  } else {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(Number(manifest.default_max_seconds || 120), 120) * 1000);
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0,
          max_tokens: 1200,
          messages: [
            {
              role: "system",
              content: "Follow the task exactly. Do not reveal hidden reasoning. Return only the requested deliverable.",
            },
            { role: "user", content: task.prompt },
          ],
        }),
      });
    } catch (error) {
      clearTimeout(timeout);
      fail(error?.name === "AbortError" ? "Local benchmark timed out." : "Local Ollama request failed.");
    }
    clearTimeout(timeout);
    if (response) {
      if (!response.ok) {
        fail(`Local Ollama returned HTTP ${response.status}.`);
      } else {
        const payload = await response.json();
        const output = payload?.choices?.[0]?.message?.content;
        if (typeof output !== "string" || !output.trim()) {
          fail("Local Ollama returned no assistant text.");
        } else {
          let validJson = null;
          if (taskId === "strict_json") {
            try {
              const parsed = JSON.parse(output);
              validJson = Boolean(
                ["approve", "revise", "reject"].includes(parsed?.decision) &&
                Array.isArray(parsed?.reasons) &&
                Number.isFinite(parsed?.risk) && parsed.risk >= 0 && parsed.risk <= 10 &&
                typeof parsed?.next_action === "string",
              );
            } catch {
              validJson = false;
            }
          }
          process.stdout.write(`${JSON.stringify({
            benchmarkVersion: manifest.version,
            dataClass: manifest.data_class,
            taskId,
            model,
            endpoint: "loopback-ollama",
            startedAt,
            durationMs: Math.round(performance.now() - started),
            outputChars: output.length,
            outputSha256: createHash("sha256").update(output, "utf8").digest("hex"),
            validJson,
            responseStored: false,
            paidCostUsd: 0,
          }, null, 2)}\n`);
        }
      }
    }
  }
}
