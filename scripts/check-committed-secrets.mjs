import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";

const requestedArgs = process.argv.slice(2);
if (requestedArgs.some((arg) => arg !== "--history") || requestedArgs.length > 1) {
  console.error("Usage: node scripts/check-committed-secrets.mjs [--history]");
  process.exit(2);
}
const historyMode = requestedArgs[0] === "--history";

const MAX_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_REPORTED_FINDINGS = 100;
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;

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
// Exact SHA-256 fingerprints for deliberately synthetic, constructed test
// sentinels. Keeping fingerprints instead of values prevents the allowlist
// itself from looking like or disclosing a credential.
const explicitTestSentinelFingerprints = new Set([
  "5dfdee6268e5bd4bedb9935361e5e1135a8e6f7ebefccbd5af1a8cea9397f9b1",
  "693f5072f49dad8d5fac77242b0ef1cad8c3b74d7b93cd9f4a54b64937efe0a3",
  "91b1bd11c26d10232a11e337fa4799816dc38ed31590d51074120db529605f53",
  "b3a67ede0e0570db680df268d7781b523fe9e3c754f435bff3b115c771581699",
]);

const findings = [];
let findingCount = 0;
const scanFailures = [];

const safeLocationId = (value) => createHash("sha256")
  .update(value)
  .digest("hex")
  .slice(0, 12);

const recordFinding = (location, label) => {
  findingCount += 1;
  if (findings.length < MAX_REPORTED_FINDINGS) findings.push(`${location}: ${label}`);
};

const scanBytes = (bytes, location) => {
  const source = bytes.toString("utf8");
  for (const [label, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const fingerprint = createHash("sha256").update(match[0]).digest("hex");
      if (explicitTestSentinelFingerprints.has(fingerprint)) continue;
      const line = source.slice(0, match.index).split("\n").length;
      recordFinding(`${location}:line-${line}`, label);
    }
  }
};

const runGitText = (args, options = {}) => execFileSync("git", args, {
  encoding: "utf8",
  maxBuffer: GIT_OUTPUT_LIMIT,
  ...options,
});

// Include both tracked files and new, non-ignored files. Location identifiers
// are hashes so a malicious credential-shaped filename can never reach logs.
let candidates;
try {
  candidates = runGitText([
    "ls-files", "--cached", "--others", "--exclude-standard", "-z",
  ]).split("\0").filter(Boolean);
} catch {
  console.error("Credential scan could not enumerate repository candidates; no repository content was emitted.");
  process.exit(2);
}

for (const file of candidates) {
  const location = `working-tree-file:${safeLocationId(file)}`;
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      scanFailures.push(`${location}: unsupported repository entry type`);
      continue;
    }
    const bytes = stat.isSymbolicLink()
      ? Buffer.from(readlinkSync(file), "utf8")
      : readFileSync(file);
    if (bytes.length > MAX_BLOB_BYTES) {
      scanFailures.push(`${location}: exceeds the ${MAX_BLOB_BYTES}-byte scan limit`);
      continue;
    }
    scanBytes(bytes, location);
  } catch {
    scanFailures.push(`${location}: could not be read safely`);
  }
}

const historyBlobMetadata = () => {
  const shallow = runGitText(["rev-parse", "--is-shallow-repository"]).trim();
  if (shallow !== "false") {
    throw new Error("full history is unavailable");
  }

  const objectIds = [...new Set(runGitText([
    "rev-list", "--objects", "--all", "HEAD", "--no-object-names",
  ]).split(/\r?\n/).filter(Boolean))];
  if (!objectIds.length || objectIds.some((oid) => !/^[0-9a-f]{40,64}$/.test(oid))) {
    throw new Error("history object enumeration was invalid");
  }

  const metadata = runGitText(
    ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
    { input: `${objectIds.join("\n")}\n` },
  ).split(/\r?\n/).filter(Boolean);
  if (metadata.length !== objectIds.length) {
    throw new Error("history object metadata was incomplete");
  }

  return metadata.map((line, index) => {
    const match = line.match(/^([0-9a-f]{40,64}) (blob|commit|tag|tree) ([0-9]+)$/);
    if (!match || match[1] !== objectIds[index]) {
      throw new Error("history object metadata was invalid");
    }
    return { oid: match[1], type: match[2], size: Number(match[3]) };
  }).filter(({ type }) => type === "blob");
};

const scanHistoryBlobs = (objects) => new Promise((resolve, reject) => {
  if (!objects.length) return resolve(0);

  const child = spawn("git", ["cat-file", "--batch"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let pending = Buffer.alloc(0);
  let current = null;
  let scanned = 0;
  let settled = false;
  let stderrBytes = 0;

  const fail = () => {
    if (settled) return;
    settled = true;
    child.kill();
    reject(new Error("history blob stream was invalid"));
  };

  const consume = () => {
    while (!settled) {
      if (!current) {
        const newline = pending.indexOf(10);
        if (newline === -1) return;
        const header = pending.subarray(0, newline).toString("ascii");
        pending = pending.subarray(newline + 1);
        const match = header.match(/^([0-9a-f]{40,64}) blob ([0-9]+)$/);
        const expected = objects[scanned];
        if (!match || !expected || match[1] !== expected.oid || Number(match[2]) !== expected.size) {
          fail();
          return;
        }
        current = expected;
      }

      if (pending.length < current.size + 1) return;
      if (pending[current.size] !== 10) {
        fail();
        return;
      }
      scanBytes(
        pending.subarray(0, current.size),
        `history-object:${current.oid.slice(0, 12)}`,
      );
      pending = pending.subarray(current.size + 1);
      current = null;
      scanned += 1;
    }
  };

  child.stdout.on("data", (chunk) => {
    if (settled) return;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    consume();
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 1024 * 1024) fail();
  });
  child.on("error", fail);
  child.on("close", (code) => {
    if (settled) return;
    consume();
    if (code !== 0 || current || pending.length || scanned !== objects.length) {
      fail();
      return;
    }
    settled = true;
    resolve(scanned);
  });
  child.stdin.on("error", () => {
    // The generic child close/error path fails closed without printing stdin.
  });
  child.stdin.end(`${objects.map(({ oid }) => oid).join("\n")}\n`);
});

let historyBlobCount = 0;
if (historyMode) {
  let historyStage = "metadata";
  try {
    const metadata = historyBlobMetadata();
    const scannable = [];
    for (const object of metadata) {
      if (object.size > MAX_BLOB_BYTES) {
        scanFailures.push(
          `history-object:${object.oid.slice(0, 12)}: exceeds the ${MAX_BLOB_BYTES}-byte scan limit`,
        );
      } else {
        scannable.push(object);
      }
    }
    historyStage = "blob-stream";
    historyBlobCount = await scanHistoryBlobs(scannable);
  } catch {
    console.error(
      `Full-history credential scan failed closed during ${historyStage}; no repository content was emitted.`,
    );
    process.exit(2);
  }
}

if (scanFailures.length) {
  console.error("Credential scan could not safely inspect every candidate (values intentionally omitted):");
  for (const failure of scanFailures.slice(0, MAX_REPORTED_FINDINGS)) {
    console.error(`- ${failure}`);
  }
  if (scanFailures.length > MAX_REPORTED_FINDINGS) {
    console.error(`- ${scanFailures.length - MAX_REPORTED_FINDINGS} additional failures omitted`);
  }
}

if (findingCount) {
  console.error("Potential repository credentials detected (values intentionally omitted):");
  for (const finding of findings) console.error(`- ${finding}`);
  if (findingCount > findings.length) {
    console.error(`- ${findingCount - findings.length} additional findings omitted`);
  }
}

if (scanFailures.length || findingCount) process.exit(1);

const historySummary = historyMode
  ? ` and ${historyBlobCount} reachable full-history blobs`
  : "";
console.log(
  `Credential scan passed for ${candidates.length} tracked and untracked candidate files${historySummary}.`,
);
