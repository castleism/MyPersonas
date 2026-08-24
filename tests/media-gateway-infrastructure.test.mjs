import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const directory = path.join(root, "infrastructure/aws/media-gateway");
const VALID_ID = "a1111111-b111-4c11-8111-d11111111111";

async function sources() {
  const [code, template, runbook] = await Promise.all([
    readFile(path.join(directory, "cloudfront-function.js"), "utf8"),
    readFile(path.join(directory, "template.yaml"), "utf8"),
    readFile(path.join(directory, "README.md"), "utf8"),
  ]);
  return { code: code.replace(/\r\n/g, "\n"), template: template.replace(/\r\n/g, "\n"), runbook };
}

function loadHandler(code, hostname = "media.mypersonas.online") {
  const configured = code.replaceAll("${MediaGatewayHostname}", hostname);
  return vm.runInNewContext(`${configured}\nhandler;`, Object.create(null), { timeout: 1_000 });
}

function request(uri, overrides = {}) {
  return {
    method: "GET",
    uri,
    querystring: {},
    headers: {
      host: { value: "media.mypersonas.online" },
      "x-mypersonas-media-gateway": { value: "viewer-forgery" },
    },
    ...overrides,
  };
}

test("CloudFront Function rewrites only the exact canonical persona and approved routes", async () => {
  const { code } = await sources();
  const handler = loadHandler(code);
  const valid = handler({ request: request(`/persona/v1/${VALID_ID}`) });
  assert.equal(valid.uri, `/functions/v1/public-media/${VALID_ID}`);
  assert.deepEqual(Object.keys(valid.querystring), []);
  assert.equal(valid.headers["x-mypersonas-media-gateway"], undefined);

  const options = handler({ request: request(`/persona/v1/${VALID_ID}`, { method: "OPTIONS" }) });
  assert.equal(options.uri, `/functions/v1/public-media/${VALID_ID}`);
  assert.equal(handler({ request: request(`/persona/v1/${VALID_ID}`, { method: "HEAD" }) }).statusCode, 405);
  const approved = handler({ request: request(`/approved/v1/${VALID_ID}`) });
  assert.equal(approved.uri, `/functions/v1/approved-media/${VALID_ID}`);
  assert.deepEqual(Object.keys(approved.querystring), []);
  assert.equal(approved.headers["x-mypersonas-media-gateway"], undefined);
  assert.equal(handler({ request: request(`/approved/v1/${VALID_ID}`, { method: "OPTIONS" }) }).statusCode, 405);

  for (const candidate of [
    request(`/persona/v1/${VALID_ID}/extra`),
    request(`/persona/v1/${VALID_ID.toUpperCase()}`),
    request(`/persona/v1/%61${VALID_ID.slice(1)}`),
    request(`/persona/v1/${VALID_ID}`, { querystring: { download: { value: "1" } } }),
    request(`/persona/v1/${VALID_ID}`, { headers: { host: { value: "d111.cloudfront.net" } } }),
    request(`/functions/v1/public-media/${VALID_ID}`),
    request(`/functions/v1/approved-media/${VALID_ID}`),
  ]) assert.equal(handler({ request: candidate }).statusCode, 404, candidate.uri);

  const stagingHost = "media-staging.mypersonas.online";
  const stagingHandler = loadHandler(code, stagingHost);
  assert.equal(stagingHandler({ request: request(`/persona/v1/${VALID_ID}`, {
    headers: { host: { value: stagingHost } },
  }) }).uri, `/functions/v1/public-media/${VALID_ID}`);
  assert.equal(stagingHandler({ request: request(`/persona/v1/${VALID_ID}`) }).statusCode, 404);
});

test("review template embeds the reviewed router and has fail-closed cost and secret gates", async () => {
  const { code, template, runbook } = await sources();
  const block = template.match(/      FunctionCode: !Sub \|\n([\s\S]*?)\n  NoCachePolicy:/);
  assert.ok(block, "embedded CloudFront Function block was not found");
  const embedded = block[1].split("\n").map((line) => line.replace(/^ {8}/, "")).join("\n").trimEnd();
  assert.equal(embedded, code.trimEnd(), "standalone and embedded CloudFront Functions diverged");

  assert.match(template, /DeploymentApproval:\n\s+Type: String\n\s+Default: NOT_APPROVED/);
  assert.match(template, /OWNER_APPROVED_AFTER_COST_AND_CHANGESET_REVIEW/);
  assert.match(template, /AcmCertificateArnUsEast1:[\s\S]*arn:aws:acm:us-east-1/);
  const parametersStart = template.indexOf("\nParameters:\n");
  const secretStart = template.indexOf("  MediaGatewaySecret:", parametersStart);
  const secretBlock = template.slice(secretStart, template.indexOf("  MediaGatewayHostname:", secretStart));
  assert.match(secretBlock, /MediaGatewaySecret:\n\s+Type: String\n\s+NoEcho: true/);
  assert.doesNotMatch(secretBlock, /\n\s+Default:/);
  assert.match(template, /ResourceNamePrefix:[\s\S]*MaxLength: 32/);
  assert.match(template, /MediaGatewayHostname:[\s\S]*Default: media\.mypersonas\.online/);
  assert.match(template, /SupabaseOriginHostname:[\s\S]*Default: nwsqyuucwzihruszocge\.supabase\.co/);
  assert.match(template, /DomainName: !Ref SupabaseOriginHostname/);
  assert.match(template, /SearchString: !Ref MediaGatewayHostname/);
  assert.match(template, /HeaderName: X-MyPersonas-Media-Gateway\n\s+HeaderValue: !Ref MediaGatewaySecret/);
  assert.match(template, /DefaultTTL: 0[\s\S]*MaxTTL: 0[\s\S]*MinTTL: 0/);
  assert.match(template, /QueryStringBehavior: none/);
  assert.match(template, /Scope: CLOUDFRONT/);
  assert.match(template, /AWSManagedRulesCommonRuleSet/);
  assert.match(template, /AWSManagedRulesKnownBadInputsRuleSet/);
  assert.match(template, /RateBasedStatement:[\s\S]*EvaluationWindowSec: 300/);
  assert.match(template, /OWNER_TO_REFRESH_AND_FILL/);
  assert.match(runbook, /Nothing here has been deployed/);
  assert.match(runbook, /Wix/);
  assert.match(runbook, /PUBLIC_MEDIA_GATEWAY_SECRET/);
});
