# MyPersonas protected media gateway runbook

Status: **review-only infrastructure package. Nothing here has been deployed,
priced for approval, connected to DNS, or verified live.** Do not execute a
stack, create a certificate, set a secret, or edit Wix DNS without a separate
owner approval for the exact account, region, change set, and cost ceiling.

## Contract

- Canonical public URL: `https://media.mypersonas.online/persona/v1/<uuid-v4>`.
- Query strings, fragments, credentials, encoded paths, uppercase UUIDs,
  trailing slashes, alternate hosts, CloudFront distribution hostnames, HEAD,
  Range, and extra path components are not equivalent canonical references.
- Approved provider URL: `https://media.mypersonas.online/approved/v1/<uuid-v4>`.
  It resolves only the separately registered, referenced, current approved-post
  rendition; the origin verifies immutable bytes before returning them.
- CloudFront rewrites exact persona and approved routes to the private origin
  paths `/functions/v1/public-media/<uuid-v4>` and
  `/functions/v1/approved-media/<uuid-v4>`, respectively, and adds
  `X-MyPersonas-Media-Gateway`. Viewer headers, cookies, and queries are not
  forwarded. Caching and compression are disabled.
- The Supabase function requires `PUBLIC_MEDIA_GATEWAY_SECRET`. If that primary
  secret is absent or malformed, the origin returns a generic 503. A missing or
  wrong request header returns a generic 404, so direct origin calls fail closed.
- `PUBLIC_MEDIA_GATEWAY_PREVIOUS_SECRET` is optional and exists only for a
  bounded two-secret rotation window. Remove it after CloudFront uses the new
  primary secret.

The template defaults to the production host and project, but both are explicit
reviewed parameters: `MediaGatewayHostname=media.mypersonas.online` and
`SupabaseOriginHostname=nwsqyuucwzihruszocge.supabase.co`. An isolated staging
stack must instead use its own exact media subdomain and its own 20-character
Supabase project hostname. Those values must match the locked database media
environment record and the staging frontend's `PUBLIC_MEDIA_ORIGIN` and
`SUPABASE_URL`. Never point a staging alias, distribution, or secret at the
production origin.

AWS documents that CloudFront custom origin headers can be used to prevent
direct custom-origin bypass, and that CloudFront overwrites a same-named viewer
header. Access to CloudFront distribution configuration must therefore be
least-privilege because authorized AWS operators can inspect origin settings.

## Files

- `template.yaml`: approval-locked CloudFormation for one CloudFront
  distribution, one CloudFront Function, no-cache/origin policies, and an
  attached CloudFront-scope WAFv2 WebACL.
- `cloudfront-function.js`: review/test copy of the exact embedded viewer-request
  function. Automated tests must keep it byte-equivalent to the template block.

The template has no secret default and cannot create resources while
`DeploymentApproval=NOT_APPROVED`. It must be created in **us-east-1** because
CloudFront-scope WAF resources and the ACM viewer certificate belong there.

This gateway does not make existing raw references safe. The latest aggregate
inventory found 120 first-party references backed by the older public `media`
bucket. They remain a release NO-GO until verified-byte import/re-ingest or
explicit owner replacement. Never infer an owner/persona binding from a UUID-
shaped object path or rewrite those URLs automatically.

## Cost worksheet — owner must refresh before approval

AWS pricing and trials change. Fill this from the active AWS account's current
pricing page and Billing console; do not treat repository estimates as a quote.

Pricing refresh on 2026-08-23: under AWS's pay-as-you-go WAF schedule, this
template's one Web ACL plus six rule entries has an estimated fixed baseline of
`$11/month` (`$5` Web ACL + `6 × $1` rule entries), plus `$0.60/million`
inspected requests, before CloudFront, CloudWatch, taxes, or capacity/inspection
overages. The three rule groups are AWS-managed, not Marketplace subscriptions.
This is a planning estimate, not account eligibility or a billing guarantee.
AWS also documents CloudFront flat-rate Free/Pro plans that include WAF, but
Free Tier accounts cannot use those flat-rate plans; confirm the active account
type before choosing a pricing model.

| Cost input | Owner-approved value |
| --- | --- |
| Pricing model: pay-as-you-go or eligible flat-rate plan | `__________` |
| Estimated requests/month | `__________` |
| Estimated viewer transfer GB/month | `__________` |
| CloudFront request + transfer estimate | `$__________ / month` |
| WAF WebACL + six rule entries estimate | `$__________ / month` |
| WAF request-inspection estimate | `$__________ / month` |
| CloudWatch metrics and optional logging estimate | `$__________ / month` |
| Approved alert threshold | `$__________` |
| Approved hard monthly ceiling and shutdown decision | `$__________` |

Review [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/) and
[AWS WAF pricing](https://aws.amazon.com/waf/pricing/) immediately before the
change-set approval. AWS currently offers both pay-as-you-go and eligibility-
dependent CloudFront flat-rate plans; this template does not select a plan.
Standard WAF sampled requests and metrics are enabled. WAF/CloudFront access-log
delivery is intentionally not created because its destination, retention,
redaction, and extra cost need a separate decision.

Set AWS Budgets and billing alerts before creating resources. The WAF rate rule
defaults to 1,200 requests per source IP per five-minute evaluation window; load
testing must determine whether that blocks legitimate shared/mobile networks or
is too permissive. Database limits remain a second, independent emergency bound.

## Approval-gated implementation order

1. Confirm the AWS account, `us-east-1`, pricing model, filled cost worksheet,
   Budget alert recipients, and an owner-approved monthly ceiling.
2. Select and record the exact `MediaGatewayHostname` and
   `SupabaseOriginHostname`; compare both with the locked service-only database
   readback. Request or import an ACM certificate in `us-east-1` whose SAN
   contains that media hostname. ACM supplies one or more DNS validation CNAMEs.
3. In Wix, open the domain's DNS records and add only those exact ACM validation
   CNAMEs. Do not change nameservers, the apex, the website CNAME, mail records,
   or any unrelated record. Wait until ACM reports `Issued`.
4. Create a high-entropy URL-safe secret in an approved password manager or
   secrets system. Do not paste it into this repository, a shell transcript,
   CI output, ticket, screenshot, or chat.
5. Configure that value as the Supabase Edge secret
   `PUBLIC_MEDIA_GATEWAY_SECRET`. Deploy/read back the secret-gated
   `public-media` and `approved-media` foundations only through the separately approved release flow.
   A direct call without the gateway header must fail; never test by putting the
   secret in a URL or a recorded command line.
6. Validate `template.yaml`, create a CloudFormation **change set** in
   `us-east-1`, and supply the two reviewed host parameters, ACM ARN, and the
   same secret out of band. Leave
   `DeploymentApproval=NOT_APPROVED` until the owner reviews the exact change
   set and cost worksheet. Do not log parameter values.
7. After separate execution approval, set
   `DeploymentApproval=OWNER_APPROVED_AFTER_COST_AND_CHANGESET_REVIEW`, execute
   the reviewed change set, and record the stack id, distribution id, WebACL id,
   CloudFront Function ETag, and configuration hashes without recording the
   secret.
8. Before DNS, use CloudFront Function test events with the selected exact
   `Host` value to prove exact rewrite and rejection cases.
   Confirm the distribution is `Deployed`, WAF is attached, TTLs are zero,
   viewer query/header/cookie forwarding is none, and the origin custom header
   is configured. The distribution hostname itself must return 404 because it
   is not canonical.
9. Obtain explicit DNS cutover approval. In Wix DNS, add a CNAME with host
   `media` and value equal to the stack's `DistributionDomainName` output. Do
   not include `https://` or a path. Wix notes that DNS propagation can take up
   to 48 hours. Preserve a screenshot/export of the pre-change DNS record set.
10. Verify TLS, exact path/query/host behavior, origin bypass failure, WAF
    metrics, archive/rotation invalidation, realistic page bursts, signed-in
    mobile rendering, and unrelated two-account privacy. Only then attest the
    WAF release control and consider producer activation/backfill.

Before finalization, the database readiness result must also report zero for
`legacy_media_bucket_references` and
`blocked_external_reference_violations`. External navigation fields are not
media slots: persona links, album destinations, link widgets, music/live embeds,
and active affiliate/product destinations must remain external HTTPS URLs.

## Secret rotation

1. Create a new value in the approved secrets system.
2. Configure Supabase with the new primary and the old value as
   `PUBLIC_MEDIA_GATEWAY_PREVIOUS_SECRET`; verify both configuration names exist
   without printing values.
3. Update a reviewed CloudFormation change set so the origin header uses the new
   value. Wait for the distribution to report `Deployed` and verify branded
   delivery.
4. Remove the previous Supabase secret and verify old-header requests fail.

If any step is ambiguous, stop. Never add a raw Storage fallback or make
`persona-media` public to recover the gateway.

## Wix and AWS references

- [Wix: connect a domain or subdomain to an external site](https://support.wix.com/en/article/connecting-a-wix-domain-to-an-external-site)
- [AWS: CloudFront custom origin headers](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/add-origin-custom-headers.html)
- [AWS: CloudFront custom certificate requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html)
- [AWS: CloudFront Function event structure](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html)
- [AWS: CloudFront-scope WAFv2 WebACL](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-wafv2-webacl.html)
- [AWS: WAF rate-based statements](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-wafv2-webacl-ratebasedstatement.html)
