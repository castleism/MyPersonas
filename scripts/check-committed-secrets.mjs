import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Include both tracked files and new, non-ignored files. This keeps the local
// pre-commit result honest; in CI those same files are already tracked.
const candidates = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  },
).split("\0").filter(Boolean);

const patterns = [
  ["Stripe secret key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_]{20,}\b/g],
  ["Stripe webhook secret", /\bwhsec_[A-Za-z0-9_]{20,}\b/g],
  ["Supabase secret API key", /\bsb_secret_[A-Za-z0-9_-]{16,}\b/g],
  ["Supabase personal access token", /\bsbp_[A-Za-z0-9]{20,}\b/g],
  ["JWT bearer token", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ["PostgreSQL credential URL", /\bpostgres(?:ql)?:\/\/[^:\s/'\"]{1,128}:[^@\s/'\"]{3,}@[^\s'\"]+\b/g],
  ["OpenAI private key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/g],
  ["Anthropic private key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["OpenRouter private key", /\bsk-or-v1-[A-Fa-f0-9]{32,}\b/g],
  ["Groq private key", /\bgsk_[A-Za-z0-9]{20,}\b/g],
  ["Perplexity private key", /\bpplx-[A-Za-z0-9_-]{20,}\b/g],
  ["Hugging Face private token", /\bhf_[A-Za-z0-9]{20,}\b/g],
  ["GitHub private token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g],
  ["npm private token", /\bnpm_[A-Za-z0-9]{20,}\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{30,}\b/g],
  ["Google OAuth client secret", /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g],
  ["SendGrid private key", /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g],
  ["Resend private key", /\bre_[A-Za-z0-9_]{20,}\b/g],
  ["private key block", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
];
const explicitTestSentinels = new Set(["sk-abcdefghijklmnopqrstuvwxyz"]);

const findings = [];
for (const file of candidates) {
  let source;
  try {
    const bytes = readFileSync(file);
    if (bytes.length > 2 * 1024 * 1024 || bytes.includes(0)) continue;
    source = bytes.toString("utf8");
  } catch {
    continue;
  }
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      if (explicitTestSentinels.has(match[0])) continue;
      const line = source.slice(0, match.index).split("\n").length;
      findings.push(`${file}:${line}: ${label}`);
    }
  }
}

if (findings.length) {
  console.error(
    "Potential repository credentials detected (values intentionally omitted):",
  );
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(
  `Credential scan passed for ${candidates.length} tracked and untracked candidate files.`,
);
