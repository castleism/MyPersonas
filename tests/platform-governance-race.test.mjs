import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(root, "MyPersonas.Online_v0/platform-governance.js"), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function queryFor(promise) {
  let query;
  query = new Proxy({}, {
    get(_target, property) {
      if (property === "then") return promise.then.bind(promise);
      return () => query;
    },
  });
  return query;
}

function contextWith(tablePromises) {
  const calls = [];
  const context = vm.createContext({
    URL,
    app: { innerHTML: "" },
    session: { user: { id: "owner-a" } },
    renderEpoch: 7,
    myPersonas: [],
    myAccounts: [],
    myAccountPersonaLinks: [],
    myAccountConnections: [],
    PLATS: { other: { name: "Other" } },
    sb: {
      from(table) {
        calls.push(table);
        const promise = tablePromises[table] || Promise.resolve({ data: [], error: null });
        return queryFor(promise);
      },
      async rpc() {
        return { data: null, error: null };
      },
    },
    esc: (value) => String(value ?? ""),
    safeBgStyle: () => "",
    renderSignin() {},
    setMeta() {},
    toast() {},
    go() {},
    publicInteractionPersonas() {
      return context.myPersonas.filter((persona) => persona.publication_state === "published"
        && persona.published_revision === persona.publication_revision
        && ["public", "unlisted"].includes(persona.visibility));
    },
    ownerAppPerspectiveSnapshot(actorId) {
      return {
        uid: context.session?.user?.id || "",
        authGeneration: context.authLoadGeneration || 0,
        actorId,
      };
    },
    socialActionSnapshotCurrent(actor) {
      return !!actor && actor.snapshot.uid === context.session?.user?.id
        && actor.snapshot.authGeneration === (context.authLoadGeneration || 0)
        && actor.snapshot.actorId === actor.id;
    },
    document: { getElementById: () => null },
    requireAal2ForSensitiveAction: async () => true,
    confirm: () => true,
    prompt: () => "",
    navigator: { clipboard: { writeText: async () => {} } },
    window: { open() {} },
    console,
  });
  new vm.Script(source, { filename: "platform-governance.js" }).runInContext(context);
  return { context, calls };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 20 && !predicate(); attempt += 1) {
    await Promise.resolve();
  }
  assert.equal(predicate(), true, "expected asynchronous query stage was not reached");
}

test("business drafts from an old account cannot render after an account switch", async () => {
  const businesses = deferred();
  const { context } = contextWith({ businesses: businesses.promise });
  const rendering = context.renderBusinessSettings("");
  assert.match(context.app.innerHTML, /Loading business drafts/);

  context.session = { user: { id: "owner-b" } };
  businesses.resolve({
    data: [{ id: "business-a", display_name: "OLD OWNER SECRET", slug: "old-owner", page_status: "draft" }],
    error: null,
  });
  await rendering;

  assert.doesNotMatch(context.app.innerHTML, /OLD OWNER SECRET/);
  assert.match(context.app.innerHTML, /Loading business drafts/);
});

test("staff rows and escaped extension source cannot render after navigation", async () => {
  const requests = deferred();
  const extensions = deferred();
  const { context, calls } = contextWith({
    platform_role_assignments: Promise.resolve({ data: [{ role_key: "technician", active: true, expires_at: null }], error: null }),
    platform_feature_requests: requests.promise,
    persona_extension_submissions: extensions.promise,
  });
  const rendering = context.renderPlatformQueue();
  await until(() => calls.includes("platform_feature_requests") && calls.includes("persona_extension_submissions"));

  context.renderEpoch += 1;
  requests.resolve({ data: [{ id: "request-a", title: "OLD STAFF REQUEST", status: "submitted" }], error: null });
  extensions.resolve({ data: [{ id: "extension-a", title: "OLD EXTENSION", source_code: "OLD PRIVATE SOURCE", status: "submitted" }], error: null });
  await rendering;

  assert.doesNotMatch(context.app.innerHTML, /OLD STAFF REQUEST|OLD PRIVATE SOURCE/);
  assert.match(context.app.innerHTML, /Loading staff queue/);
});

test("a notes-only staff update preserves the existing assignee", async () => {
  const { context } = contextWith({});
  const requestId = "11111111-1111-4111-8111-111111111111";
  const assigneeId = "22222222-2222-4222-8222-222222222222";
  let rpcCall;
  context.sb.rpc = async (name, args) => {
    rpcCall = { name, args };
    return { data: null, error: null };
  };
  context.document = {
    getElementById(id) {
      if (id.startsWith("govStaffStatus_")) return { value: "planned" };
      if (id.startsWith("govStaffPriority_")) return { value: "high" };
      if (id.startsWith("govStaffNotes_")) return { value: "Notes only" };
      return null;
    },
  };
  context.renderPlatformQueue = () => {};
  vm.runInContext(`governanceState.staffRequests=[{id:"${requestId}",assigned_to:"${assigneeId}"}]`, context);

  await context.governanceStaffSave(requestId);

  assert.equal(rpcCall.name, "staff_update_feature_request");
  assert.equal(rpcCall.args.p_assigned_to, assigneeId);
  assert.equal(rpcCall.args.p_staff_notes, "Notes only");
});

test("governance state reset clears account-private render data", () => {
  const { context } = contextWith({});
  const value = vm.runInContext(`
    governanceState={...governanceState,personaId:"private-persona",review:{owner_review_notes:"secret"},reviewManifest:{profile:{bio:"secret"}},roles:[{role_key:"technician"}],security:{lock_reason:"private"},staffRequests:[{title:"secret"}]};
    resetGovernanceState();
    JSON.stringify(governanceState)
  `, context);
  const reset = JSON.parse(value);
  assert.equal(reset.personaId, "");
  assert.equal(reset.review, null);
  assert.equal(reset.reviewManifest, null);
  assert.deepEqual(reset.roles, []);
  assert.equal(reset.security, null);
  assert.deepEqual(reset.staffRequests, []);
});

test("an intention edit during AI explanation discards the stale reply and re-enables the same button", async () => {
  const reply = deferred();
  const { context } = contextWith({});
  const intention = { value: "Build a family page" };
  const backend = { value: "backend-a" };
  const button = {
    disabled: false,
    isConnected: true,
    textContent: "Ask linked AI to explain plan",
  };
  const elements = new Map([
    ["govIntention", intention],
    ["govIntentionBackend", backend],
    ["govIntentionAiButton", button],
  ]);
  const toasts = [];
  context.document = { getElementById: (id) => elements.get(id) || null };
  context.myBackends = [{
    id: "backend-a",
    name: "Example model",
    base_url: "https://api.example.com/v1",
  }];
  context.backendAgentReady = () => true;
  context.callAI = async () => reply.promise;
  context.toast = (message) => toasts.push(message);
  vm.runInContext('governanceState.personaId="persona-a"', context);

  const explaining = context.governanceExplainIntentionWithAi();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Explaining…");

  intention.value = "Changed intention while the request was pending";
  context.governanceIntentionChanged();
  reply.resolve("STALE PRIVATE EXPLANATION");
  await explaining;

  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Ask linked AI to explain plan");
  assert.equal(vm.runInContext("governanceState.intentionAiExplanation", context), "");
  assert.deepEqual(toasts, []);
});

test("external review manifest normalizes real widget and module schemas without leaking unknown values", () => {
  const { context } = contextWith({});
  const value = vm.runInContext(`
    governanceState.reviewManifest={schema_version:1,revision:9,complete:true,profile:{
      name:"Safe",modules:{feed:false,unknown_secret:"sk-abcdefghijklmnopqrstuvwxyz"},
      fan_agent_configuration:{backend_configured:true,fan_chat_configured:true,configuration_sha256:"${"a".repeat(64)}"}
    },layout:{widgets:[
      {kind:"link",title:"Docs",body:"API key=sk-abcdefghijklmnopqrstuvwxyz",label:"Open",url:"https://example.com/private/token",span:"full",shape:"round",tone:"glass"},
      {kind:"text",title:"Note",body:"owner@example.com",span:"half"}
    ]}};
    JSON.stringify(governanceExternalReviewManifest())
  `, context);
  const manifest = JSON.parse(value);
  assert.equal(manifest.profile.modules.feed, false);
  assert.equal(manifest.profile.modules.about, true);
  assert.equal("unknown_secret" in manifest.profile.modules, false);
  assert.equal(manifest.layout.widgets[0].kind, "link");
  assert.equal(manifest.layout.widgets[0].destination_host, "example.com");
  assert.equal(manifest.layout.widgets[0].span, "full");
  assert.doesNotMatch(value, /private\/token|sk-abcdefghijklmnopqrstuvwxyz|owner@example\.com|unknown_secret/);
  assert.match(value, /REDACTED/);
});

test("feature source context stays bounded even when the owner manifest is huge", () => {
  const { context } = contextWith({});
  const size = vm.runInContext(`
    governanceState.readiness={publication_state:"draft",publication_revision:3,required_missing:2,manifest_sha256:"${"b".repeat(64)}",checks:Array.from({length:1000},(_,i)=>({key:"k"+i,required:true,ok:false,secret:"x".repeat(10000)})),warnings:Array.from({length:1000},()=>"w".repeat(10000))};
    governanceState.reviewManifest={complete:false,counts:{posts:999},truncation_reasons:Array.from({length:1000},()=>"r".repeat(10000)),posts:Array.from({length:1000},()=>({body:"secret".repeat(10000)}))};
    JSON.stringify(governanceFeatureSourceContext()).length
  `, context);
  assert.ok(size < 30000, `feature source context was ${size} bytes`);
});

test("friend-invite completion from an old account cannot toast, reload, or navigate", async () => {
  const request = deferred();
  const { context } = contextWith({});
  const events = [];
  context.authLoadGeneration = 4;
  context.myPersonas = [{
    id: "persona-a",
    publication_state: "published",
    publication_revision: 2,
    published_revision: 2,
    visibility: "public",
  }];
  context.document = { getElementById(id) { return { value: id.includes("Follower") ? "persona-a" : "one-time-token" }; } };
  context.sb.rpc = () => request.promise;
  context.toast = (message) => events.push(["toast", message]);
  context.loadMine = async () => events.push(["load"]);
  context.go = (route) => events.push(["go", route]);

  const redeeming = context.governanceRedeemFriendInvite("22222222-2222-4222-8222-222222222222");
  context.session = { user: { id: "owner-b" } };
  request.resolve({ data: { ok: true, message: "Friend request sent" }, error: null });
  await redeeming;

  assert.deepEqual(events, []);
});
