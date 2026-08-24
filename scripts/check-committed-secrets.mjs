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
  ["OpenAI private key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/g],
  ["GitHub private token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{30,}\b/g],
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
