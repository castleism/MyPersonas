# Local structured-output smoke — 2026-08-22 Alaska

Status: local, zero-cost evidence only. This is not a hosted-provider benchmark or a
production model assignment.

Runner: `tools/run-local-ai-benchmark.mjs`

Manifest: `benchmarks/ai-provider-v1.json` version `1.0.0`

Task: `strict_json` using the loopback-only Ollama OpenAI-compatible endpoint. The
runner did not retain response text; it retained only validation, timing, length, and
SHA-256 evidence.

| Model | UTC start | Duration | Output chars | Schema valid | Output SHA-256 |
|---|---:|---:|---:|---:|---|
| `gpt-oss:20b` | `2026-08-23T04:51:02.804Z` | 19,455 ms | 585 | yes | `70914916fcfb70c4c935811d94ad99c150bd88a8f199cba101ed7091c4662723` |
| `gemma3:12b` | `2026-08-23T04:51:22.341Z` | 16,881 ms | 405 | no | `c097c930733d8ab499ca9188a086abe105c0b76f38ede91e89c13ac0540a7695` |

Decision for the next benchmark round: prefer `gpt-oss:20b` for strict JSON and
tool-contract tasks. Keep `gemma3:12b` in the local multimodal/independent-review lane
until it passes a structured-output retest with an explicitly supported JSON mode. One
task is not a general quality ranking.
