#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const OPAQUE_062_PLUS_MARKERS = [
  /\bmedia_environment_config_062\b/i,
  /\bpersona_public_media_handles\b/i,
  /\bpublic_media_release_controls_062\b/i,
  /\bpost_approved_media_handles\b/i,
  /\blegacy_media_references\b/i,
  /\bconfigure_media_environment_service\b/i,
];

const THROUGH_061_MARKERS = [
  ["personas table", /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:\"?public\"?\.)?\"?personas\"?/i],
  ["persona publication table", /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:\"?public\"?\.)?\"?persona_page_publications\"?/i],
  ["media registry", /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:\"?public\"?\.)?\"?persona_media_assets\"?/i],
  ["061 waitlist constraint", /\bnoo_waitlist_input_contract\b/i],
  ["061 owner research queue", /\bowner_research_brief_queue\b/i],
  ["061 research digest", /\bget_research_digest\b/i],
  ["056 auth-email invalidator function", /\binvalidate_stale_aliaspaces_email_attestations\b/i],
  ["061 default function ACL", /alter\s+default\s+privileges\s+for\s+role\s+\"?postgres\"?\s+in\s+schema\s+\"?public\"?/i],
];

const SECRET_PATTERNS = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i],
  ["credential-bearing PostgreSQL URL", /postgres(?:ql)?:\/\/[^\s:'"/]+:[^\s@'"/]+@/i],
  ["JWT-like credential", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/],
  ["OpenAI-style secret", /\bsk-(?:live-)?[A-Za-z0-9_-]{20,}\b/],
  ["Stripe secret", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ["Stripe webhook secret", /\bwhsec_[A-Za-z0-9]{16,}\b/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Supabase secret key", /\bsb_secret_[A-Za-z0-9_-]{16,}\b/],
  ["role password DDL", /\b(?:create|alter)\s+(?:role|user)\b[\s\S]{0,500}\bpassword\s+(?:'[^']+'|\S+)/i],
  ["secret-bearing function setting", /\bset\s+[A-Za-z0-9_.]*(?:password|secret|token|api_key)[A-Za-z0-9_.]*\s*(?:=|to)\s*'[^']+'/i],
];

function blankDollarQuotedBodies(sql) {
  const chars = [...sql];
  const tagPattern = /\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/g;
  let match;
  while ((match = tagPattern.exec(sql)) !== null) {
    const tag = match[0];
    const end = sql.indexOf(tag, match.index + tag.length);
    if (end < 0) break;
    for (let index = match.index; index < end + tag.length; index += 1) {
      if (chars[index] !== "\n" && chars[index] !== "\r") chars[index] = " ";
    }
    tagPattern.lastIndex = end + tag.length;
  }
  return chars.join("");
}

function withoutComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ");
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function normalizePublicSchemaDump(sql) {
  const lines = sql.replace(/\r\n/g, "\n").split("\n");
  let schemaCreateCount = 0;
  let restrictCount = 0;
  let unrestrictCount = 0;
  const normalized = [];

  for (const line of lines) {
    if (/^\\restrict\s+[A-Za-z0-9]+\s*$/.test(line)) {
      restrictCount += 1;
      continue;
    }
    if (/^\\unrestrict\s+[A-Za-z0-9]+\s*$/.test(line)) {
      unrestrictCount += 1;
      continue;
    }
    if (/^CREATE SCHEMA (?:public|"public");\s*$/.test(line)) {
      schemaCreateCount += 1;
      continue;
    }
    normalized.push(line);
  }

  if (schemaCreateCount !== 1) {
    throw new Error(`Expected exactly one CREATE SCHEMA public statement; found ${schemaCreateCount}`);
  }
  if (restrictCount !== unrestrictCount || restrictCount > 1) {
    throw new Error(`Unexpected pg_dump restrict guards (${restrictCount}/${unrestrictCount})`);
  }

  return [
    "-- MyPersonas staging predecessor: normalized schema-only public snapshot.",
    "-- CREATE SCHEMA public was removed because Supabase creates it. No data, roles,",
    "-- migration history, Auth users, Storage objects, or Vault secrets are included.",
    ...normalized,
  ].join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}

export function validateSchemaSnapshot(sql, {
  requireThrough061 = true,
  reject062Plus = true,
} = {}) {
  const errors = [];
  const warnings = [];
  const outsideBodies = withoutComments(blankDollarQuotedBodies(sql));

  if (/Type:\s*TABLE DATA/i.test(sql)) errors.push("Snapshot contains forbidden table data section");

  const forbiddenTopLevel = [
    ["COPY data", /(^|;)\s*COPY\s+[\s\S]*?\sFROM\s+stdin\s*;/im],
    ["top-level INSERT", /(^|;)\s*INSERT\s+INTO\b/im],
    ["top-level UPDATE", /(^|;)\s*UPDATE\s+[A-Za-z0-9_".]+\s+SET\b/im],
    ["top-level DELETE", /(^|;)\s*DELETE\s+FROM\b/im],
    ["top-level MERGE", /(^|;)\s*MERGE\s+INTO\b/im],
    ["top-level TRUNCATE", /(^|;)\s*TRUNCATE\b/im],
    ["role creation", /(^|;)\s*CREATE\s+(?:ROLE|USER)\b/im],
    ["database creation", /(^|;)\s*CREATE\s+DATABASE\b/im],
    ["destructive drop", /(^|;)\s*DROP\s+(?:DATABASE|SCHEMA|TABLE)\b/im],
    ["ALTER SYSTEM", /(^|;)\s*ALTER\s+SYSTEM\b/im],
    ["psql meta-command", /^\\(?!$)/m],
  ];
  for (const [name, pattern] of forbiddenTopLevel) {
    if (pattern.test(outsideBodies)) errors.push(`Snapshot contains forbidden ${name}`);
  }

  for (const [name, pattern] of SECRET_PATTERNS) {
    if (pattern.test(sql)) errors.push(`Snapshot contains a possible ${name}`);
  }

  if (/\b(?:auth\.users|storage\.objects|vault\.secrets)\b[\s\S]{0,300}\bType:\s*TABLE DATA/i.test(sql)) {
    errors.push("Snapshot contains managed-schema table data");
  }

  if (reject062Plus) {
    for (const marker of OPAQUE_062_PLUS_MARKERS) {
      if (marker.test(sql)) errors.push(`Snapshot is not a through-061 predecessor (${marker.source})`);
    }
  }

  if (requireThrough061) {
    for (const [name, marker] of THROUGH_061_MARKERS) {
      if (!marker.test(sql)) errors.push(`Snapshot is missing required ${name} evidence`);
    }
  }

  if (/https:\/\/nwsqyuucwzihruszocge\.supabase\.co/i.test(sql)) {
    warnings.push("Predecessor contains a legacy production origin; keep all staging workers/functions disabled until 062-064 and staging function configuration are verified");
  }
  if (!/SET\s+row_security\s*=\s*off\s*;/i.test(sql)) {
    warnings.push("Snapshot does not contain pg_dump's expected row_security=off marker");
  }

  return {
    ok: errors.length === 0,
    sha256: sha256(sql),
    bytes: Buffer.byteLength(sql, "utf8"),
    errors,
    warnings,
  };
}

function parseArgs(argv) {
  const parsed = {
    requireThrough061: false,
    reject062Plus: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") parsed.input = argv[++index];
    else if (arg === "--normalize-to") parsed.normalizeTo = argv[++index];
    else if (arg === "--report") parsed.report = argv[++index];
    else if (arg === "--require-through-061") parsed.requireThrough061 = true;
    else if (arg === "--reject-062-plus") parsed.reject062Plus = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!parsed.input) throw new Error("--input is required");
  return parsed;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const raw = await readFile(options.input, "utf8");
  const sql = options.normalizeTo ? normalizePublicSchemaDump(raw) : raw;
  const result = validateSchemaSnapshot(sql, options);
  if (options.normalizeTo && result.ok) await writeFile(options.normalizeTo, sql, "utf8");
  if (options.report) await writeFile(options.report, JSON.stringify(result, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
