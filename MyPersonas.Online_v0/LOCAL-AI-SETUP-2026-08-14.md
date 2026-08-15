# Local AI setup verification — 2026-08-14

Machine: primary desktop. Local-only setup; no cloud key, account, charge, repo permission, or production integration was created.

## Verified hardware/runtime

- CPU: Intel Core i9-14900KF
- Memory: 64 GB
- GPU: NVIDIA RTX 4090, 24 GB VRAM
- Ollama: 0.32.11
- Listener: `127.0.0.1:11434` only; LAN exposure is off

## Installed models

| Model | Local size | Purpose |
|---|---:|---|
| `gpt-oss:20b` | approximately 13 GB | Private/local first drafts, review, classification, and structured tasks |
| `gemma3:12b` | approximately 8.1 GB | Local multimodal review and a second independent text opinion; do not treat it as final identity/canon approval |
| `embeddinggemma` | approximately 621 MB | Local persona/canon retrieval embeddings |

## Smoke evidence

- `ollama run gpt-oss:20b` returned the requested exact marker.
- `ollama run gemma3:12b` returned the requested exact marker after its first model load.
- OpenAI-compatible `POST /v1/chat/completions` returned the requested exact marker.
- The fixed strict-JSON benchmark case returned a valid schema with `decision=reject`, `risk=5` in about 3 seconds after warm-up.
- `POST /api/embed` returned one 768-dimensional `embeddinggemma` vector.
- `tools/run-local-ai-benchmark.mjs` runs one public/synthetic manifest task at a time against the exact loopback endpoint and emits metrics plus an output hash without storing the prompt or response.

First comparable strict-JSON run: `gpt-oss:20b` passed schema validation in about 19.3 seconds including a model swap/load; `gemma3:12b` returned nonconforming JSON in about 5.9 seconds while warm. This is one test, not a general quality ranking. Route deterministic structured work to `gpt-oss:20b` for now and keep `gemma3:12b` as a text/vision second opinion until it passes the wider benchmark.

The native `/api/generate` JSON-format path produced unreliable reasoning-shaped output in one test. Until a separate compatibility test closes that issue, local automation should use Ollama's OpenAI-compatible `/v1/chat/completions` endpoint with an explicit system instruction, JSON schema, adequate output budget, temperature 0 for deterministic structure, and server-side validation.

## Security rules

- Keep Ollama bound to loopback. It does not provide a local API authentication boundary suitable for LAN or internet exposure.
- Do not tunnel the port, enable “Expose Ollama to network,” or place it behind a public reverse proxy.
- Local clients receive only the task inputs they need. Private/spoiler canon stays on the approved machine and is not copied to cloud trials.
- Validate all structured output; a local model is not trusted merely because no cloud provider is involved.
- Treat model files and caches as software supply-chain inputs: record model name/digest, update intentionally, and rerun the benchmark after upgrades.
- Run one GPU-heavy model at a time on this 24 GB card. Do not attempt to keep `gpt-oss:20b` and `gemma3:12b` resident concurrently.

## Next local steps

1. Inventory the second desktop and laptop hardware, disk, thermals, OS patch level, and GPU drivers.
2. Keep the laptop as the release/MFA/emergency-stop console rather than a bulk worker.
3. Use the second desktop as a clean build/browser test runner until its hardware and security posture justify inference work.
4. Design an authenticated private worker plane before distributing jobs. Do not use unauthenticated Ollama LAN exposure.

Run a safe local benchmark from the repository root with:

```powershell
node tools/run-local-ai-benchmark.mjs --model gpt-oss:20b --task strict_json
```

Use `gemma3:12b` as the model for an independent second pass. Web, image, and long-context tasks require a separately reviewed input packet and are refused by this runner.
