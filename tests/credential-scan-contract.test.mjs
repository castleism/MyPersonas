import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const scannerPath = path.join(root, "scripts/check-committed-secrets.mjs");
const scanner = await readFile(scannerPath, "utf8");
const ci = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");

const runGit = (cwd, args) => execFileSync("git", args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

const newRepository = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mypersonas-credential-scan-"));
  runGit(directory, ["init", "--initial-branch=main"]);
  runGit(directory, ["config", "user.email", "security-test@example.test"]);
  runGit(directory, ["config", "user.name", "Credential Scan Test"]);
  await writeFile(path.join(directory, "README.md"), "credential scan fixture\n", "utf8");
  runGit(directory, ["add", "--", "README.md"]);
  runGit(directory, ["commit", "-m", "Initialize fixture"]);
  return directory;
};

test("repository credential gate covers payment, infrastructure, mail, and AI providers", () => {
  for (const label of [
    "Stripe secret key",
    "Stripe webhook secret",
    "Supabase secret API key",
    "Supabase personal access token",
    "JWT bearer token",
    "PostgreSQL credential URL",
    "OpenAI private key",
    "Anthropic private key",
    "OpenRouter private key",
    "Groq private key",
    "Perplexity private key",
    "Hugging Face private token",
    "GitHub private token",
    "npm private token",
    "AWS access key",
    "Google API key",
    "Google OAuth client secret",
    "SendGrid private key",
    "Resend private key",
    "private key block",
  ]) {
    assert.ok(scanner.includes(`[\"${label}\"`), `missing credential signature: ${label}`);
  }
});

test("credential findings never echo matched values", () => {
  assert.match(scanner, /values intentionally omitted/);
  assert.match(scanner, /safeLocationId/);
  assert.match(scanner, /history-object:/);
  assert.doesNotMatch(scanner, /recordFinding\([^\n]*match\[0\]/);
  assert.doesNotMatch(scanner, /console\.(?:error|log)\([^\n]*match\[0\]/);
});

test("required credential CI check fetches and scans full reachable history", () => {
  const jobStart = ci.indexOf("  secret-scan:");
  const jobEnd = ci.indexOf("\n  frontend-syntax:", jobStart);
  assert.notEqual(jobStart, -1, "secret-scan job is missing");
  assert.notEqual(jobEnd, -1, "secret-scan job boundary is missing");
  const secretJob = ci.slice(jobStart, jobEnd);
  assert.match(secretJob, /name: Repository credential scan/);
  assert.match(secretJob, /fetch-depth: 0/);
  assert.match(secretJob, /node scripts\/check-committed-secrets\.mjs --history/);
  assert.match(scanner, /rev-parse", "--is-shallow-repository/);
  assert.match(scanner, /"rev-list", "--objects", "--all", "HEAD"/);
});

test("full-history mode rejects a removed credential without echoing its value or filename", async () => {
  const directory = await newRepository();
  const filename = "retired-provider-key.txt";
  const credential = ["sk", "live", "H".repeat(28)].join("_");
  try {
    await writeFile(path.join(directory, filename), `${credential}\n`, "utf8");
    runGit(directory, ["add", "--", filename]);
    runGit(directory, ["commit", "-m", "Add then retire fixture"]);
    await rm(path.join(directory, filename));
    runGit(directory, ["add", "-u", "--", filename]);
    runGit(directory, ["commit", "-m", "Retire fixture"]);

    const result = spawnSync(process.execPath, [scannerPath, "--history"], {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(result.status, 1);
    assert.equal(/Potential repository credentials detected/.test(output), true);
    assert.equal(/history-object:[0-9a-f]{12}:line-1: Stripe secret key/.test(output), true);
    assert.equal(output.includes(credential), false);
    assert.equal(output.includes(filename), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("working-tree mode rejects an untracked credential without echoing its value or filename", async () => {
  const directory = await newRepository();
  const filename = "untracked-provider-key.txt";
  const credential = ["whsec", "W".repeat(28)].join("_");
  try {
    await writeFile(path.join(directory, filename), `${credential}\n`, "utf8");
    const result = spawnSync(process.execPath, [scannerPath], {
      cwd: directory,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    assert.equal(result.status, 1);
    assert.equal(/working-tree-file:[0-9a-f]{12}:line-1: Stripe webhook secret/.test(output), true);
    assert.equal(output.includes(credential), false);
    assert.equal(output.includes(filename), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
