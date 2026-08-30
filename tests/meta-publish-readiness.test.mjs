import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const source = (relativePath) => readFile(path.join(repoRoot, relativePath), "utf8");

globalThis.Deno = { env: { get: () => "test-app-secret" } };
const sharedModule = import(
  new URL("../supabase/functions/_shared/meta-publish.ts", import.meta.url)
);

test("Meta authorization keeps discovery default and requires target-specific owner opt-in", async () => {
  const oauth = await source("supabase/functions/meta-oauth/index.ts");

  assert.match(oauth, /requestPublishing\?: boolean/);
  assert.match(oauth, /publishTargets\?: unknown/);
  assert.match(oauth, /if \(requestPublishing !== true\) return \[\]/);
  assert.match(oauth, /Publishing permission requires explicit publishTargets/);
  assert.match(oauth, /facebook: \["pages_manage_posts"\]/);
  assert.match(
    oauth,
    /instagram: \[\.\.\.REQUIRED_SCOPES, "instagram_content_publish"\]/,
  );
  assert.match(oauth, /scope: requestedScopes\.join\(","\)/);
  assert.doesNotMatch(oauth, /business_management/);
});

test("Meta publish resolution checks exact target scopes and Page write tasks", async () => {
  const [shared, interactive, scheduled] = await Promise.all([
    source("supabase/functions/_shared/meta-publish.ts"),
    source("supabase/functions/meta-post/index.ts"),
    source("supabase/functions/run-post-queue/index.ts"),
  ]);

  assert.match(shared, /facebook: \["pages_manage_posts"\]/);
  for (const scope of [
    "pages_show_list",
    "pages_read_engagement",
    "instagram_basic",
    "instagram_content_publish",
  ]) {
    assert.match(shared, new RegExp(`"${scope}"`));
  }
  assert.match(shared, /PAGE_WRITE_TASKS = \["CREATE_CONTENT", "MANAGE"\]/);
  assert.match(shared, /instagram_business_id,page_tasks/);
  assert.match(shared, /fields: "access_token,tasks"/);
  assert.match(shared, /graphGet\("\/me\/permissions"/);
  assert.match(shared, /liveScopeMismatch/);
  assert.match(shared, /must currently have the CREATE_CONTENT Page task/);
  assert.match(shared, /missingScopesByTarget/);
  assert.doesNotMatch(shared, /business_management/);

  assert.match(interactive, /const pendingTargets = targets\.filter/);
  assert.match(
    interactive,
    /resolvePageContext\([\s\S]*?draft\.facebook_ledger_id![\s\S]*?true,[\s\S]*?pendingTargets/,
  );
  assert.match(
    interactive,
    /resolvePageContext\([\s\S]*?facebookLedgerId,[\s\S]*?false,[\s\S]*?\["facebook"\]/,
  );
  assert.match(scheduled, /const pendingMetaTargets = \[/);
  assert.match(
    scheduled,
    /resolvePageContext\([\s\S]*?d\.facebook_ledger_id,[\s\S]*?true,[\s\S]*?pendingMetaTargets/,
  );
});

test("Instagram uses provider quota and waits for a finished container before publish", async () => {
  const [shared, scheduled] = await Promise.all([
    source("supabase/functions/_shared/meta-publish.ts"),
    source("supabase/functions/run-post-queue/index.ts"),
  ]);

  assert.match(shared, /content_publishing_limit/);
  assert.match(shared, /fields: "config,quota_usage"/);
  assert.match(shared, /quota\.usage >= quota\.total/);
  assert.match(shared, /statusCode === "FINISHED"/);
  assert.match(shared, /statusCode === "ERROR" \|\| statusCode === "EXPIRED"/);
  assert.match(shared, /statusCode === "PUBLISHED"/);

  const quotaCheck = shared.indexOf("await requireInstagramPublishingCapacity");
  const createContainer = shared.indexOf("graphPost(`/\${igUserId}/media`");
  const waitForContainer = shared.indexOf("await waitForInstagramContainer");
  const publishContainer = shared.indexOf("graphPost(`/\${igUserId}/media_publish`");
  assert.ok(quotaCheck > -1 && createContainer > quotaCheck);
  assert.ok(waitForContainer > createContainer && publishContainer > waitForContainer);

  assert.doesNotMatch(scheduled, /IG_ROLLING_LIMIT|instagramPostsInWindow/);
});

test("scheduled Meta posting fails closed without exact approved preview evidence", async () => {
  const scheduled = await source("supabase/functions/run-post-queue/index.ts");
  assert.match(scheduled, /approved_preview_version: string/);
  assert.match(scheduled, /approved_preview_hash: string/);
  const previewGuard = scheduled.indexOf("the exact owner-approved preview evidence is missing");
  const providerResolution = scheduled.indexOf("resolvePageContext(");
  assert.ok(previewGuard > -1 && providerResolution > previewGuard);
});

test("Instagram quota preflight uses the provider values and blocks before media creation", async () => {
  const { getInstagramPublishingQuota, publishInstagram } = await sharedModule;
  const originalFetch = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      calls.push({ url: String(input), method: init.method || "GET" });
      return new Response(JSON.stringify({
        data: [{
          quota_usage: 7,
          config: { quota_total: 50, quota_duration: 86400 },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    assert.deepEqual(
      await getInstagramPublishingQuota("123", "page-token"),
      { usage: 7, total: 50, durationSeconds: 86400 },
    );
    assert.match(calls[0].url, /\/123\/content_publishing_limit/);

    calls.length = 0;
    globalThis.fetch = async (input, init = {}) => {
      calls.push({ url: String(input), method: init.method || "GET" });
      return new Response(JSON.stringify({
        data: [{
          quota_usage: 50,
          config: { quota_total: 50, quota_duration: 86400 },
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    await assert.rejects(
      publishInstagram("123", "page-token", "https://example.test/a.jpg", ""),
      /quota is full \(50\/50\).*no media was created/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "GET");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Instagram waits for FINISHED before sending media_publish", async () => {
  const { publishInstagram } = await sharedModule;
  const originalFetch = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = init.method || "GET";
      calls.push({ url, method });
      let body;
      if (url.includes("content_publishing_limit")) {
        body = {
          data: [{
            quota_usage: 3,
            config: { quota_total: 50, quota_duration: 86400 },
          }],
        };
      } else if (url.includes("/media_publish")) {
        body = { id: "published-media-id" };
      } else if (url.includes("/container-id")) {
        body = { status_code: "FINISHED" };
      } else if (url.includes("/media")) {
        body = { id: "container-id" };
      } else {
        return new Response("not found", { status: 404 });
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    let policyChecks = 0;
    const result = await publishInstagram(
      "123",
      "page-token",
      "https://example.test/a.jpg",
      "caption",
      async () => {
        policyChecks += 1;
      },
    );
    assert.deepEqual(result, { mediaId: "published-media-id" });
    const createIndex = calls.findIndex((call) =>
      call.method === "POST" &&
      new URL(call.url).pathname.endsWith("/123/media")
    );
    const statusIndex = calls.findIndex((call) =>
      call.method === "GET" && call.url.includes("/container-id")
    );
    const publishIndex = calls.findIndex((call) =>
      call.method === "POST" && call.url.includes("/media_publish")
    );
    assert.ok(createIndex > 0);
    assert.ok(statusIndex > createIndex);
    assert.ok(publishIndex > statusIndex);
    assert.equal(policyChecks, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runtime resolver applies Facebook-only scopes and rechecks live Page tasks", async () => {
  const { resolvePageContext } = await sharedModule;
  const originalFetch = globalThis.fetch;
  const makeAdmin = (grantedScopes) => {
    const rows = {
      account_ledger: {
        persona_id: "safe-persona",
        username: "safe-page",
        login_email: "",
        aliases: [],
      },
      meta_page_connections: {
        owner: "owner-1",
        grant_id: "grant-1",
        facebook_page_id: "123",
        instagram_business_id: "456",
        page_tasks: ["CREATE_CONTENT"],
      },
      meta_grants: { granted_scopes: grantedScopes },
    };
    return {
      from(table) {
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          or() {
            return query;
          },
          maybeSingle() {
            return Promise.resolve({ data: rows[table], error: null });
          },
        };
        return query;
      },
      rpc(name) {
        assert.equal(name, "meta_get_grant_token_bundle");
        return Promise.resolve({
          data: [{ token_bundle: { access_token: "user-token" } }],
          error: null,
        });
      },
    };
  };

  try {
    let liveTasks = ["CREATE_CONTENT"];
    globalThis.fetch = async (input) => {
      const body = String(input).includes("/me/permissions")
        ? {
          data: [{ permission: "pages_manage_posts", status: "granted" }],
        }
        : { access_token: "page-token", tasks: liveTasks };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const facebook = await resolvePageContext(
      makeAdmin(["pages_manage_posts"]),
      "owner-1",
      "ledger-1",
      true,
      ["facebook"],
    );
    assert.equal(facebook.ok, true);

    const instagram = await resolvePageContext(
      makeAdmin(["pages_manage_posts"]),
      "owner-1",
      "ledger-1",
      true,
      ["instagram"],
    );
    assert.equal(instagram.ok, false);
    assert.deepEqual(instagram.missingScopesByTarget?.instagram, [
      "pages_show_list",
      "pages_read_engagement",
      "instagram_basic",
      "instagram_content_publish",
    ]);

    liveTasks = ["ANALYZE"];
    const staleStoredTask = await resolvePageContext(
      makeAdmin(["pages_manage_posts"]),
      "owner-1",
      "ledger-1",
      true,
      ["facebook"],
    );
    assert.equal(staleStoredTask.ok, false);
    assert.equal(staleStoredTask.missingPageTask, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a container-status read failure is safe to retry and never sends media_publish", async () => {
  const { providerOutcomeIsUncertain, publishInstagram } = await sharedModule;
  const originalFetch = globalThis.fetch;
  try {
    const calls = [];
    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      const method = init.method || "GET";
      calls.push({ url, method });
      if (url.includes("content_publishing_limit")) {
        return new Response(JSON.stringify({
          data: [{
            quota_usage: 3,
            config: { quota_total: 50, quota_duration: 86400 },
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (method === "POST" && new URL(url).pathname.endsWith("/123/media")) {
        return new Response(JSON.stringify({ id: "container-id" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/container-id")) throw new TypeError("network down");
      throw new Error(`unexpected request: ${method} ${url}`);
    };
    let error;
    try {
      await publishInstagram(
        "123",
        "page-token",
        "https://example.test/a.jpg",
        "",
      );
    } catch (caught) {
      error = caught;
    }
    assert.match(error?.message || "", /no publish request was sent/);
    assert.equal(providerOutcomeIsUncertain(error), false);
    assert.equal(calls.some((call) => call.url.includes("/media_publish")), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
