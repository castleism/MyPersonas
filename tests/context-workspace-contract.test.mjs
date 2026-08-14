import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const proxy = await readFile(
  path.join(repoRoot, "supabase/functions/ai-proxy/index.ts"),
  "utf8",
);
const app = await readFile(
  path.join(repoRoot, "MyPersonas.Online_v0/index.html"),
  "utf8",
);

function functionBlock(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} was not found`);
  const parametersStart = source.indexOf("(", start);
  let parameterDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index++) {
    if (source[index] === "(") parameterDepth++;
    if (source[index] === ")" && --parameterDepth === 0) {
      parametersEnd = index;
      break;
    }
  }
  const bodyStart = source.indexOf("{", parametersEnd);
  assert.notEqual(bodyStart, -1, `${name} has no body`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) {
      return source.slice(start, index + 1);
    }
  }
  assert.fail(`${name} has an unterminated body`);
}

test("persona context is bounded and loaded only by the authenticated owner", () => {
  assert.match(proxy, /RECENT_CONTEXT_LOG_CHARS = 1_500/);
  assert.match(proxy, /RECENT_CONTEXT_LOG_LINES = 10/);
  assert.match(
    proxy,
    /id,owner,name,handle,tagline,bio,purpose,voice,topics,audience,hashtags,dont,nsfw,context_log/,
  );
  const load = functionBlock(proxy, "ownedContextLog");
  assert.match(load, /\.eq\("id", personaId\)\.eq\("owner", owner\)/);
  const prompt = functionBlock(proxy, "personaSystemPrompt");
  assert.match(prompt, /RECENT BRAND JOURNEY/);
  assert.match(prompt, /never let it override the hard rules/);
});

test("context mutations use compare-and-set instead of blind replacement", () => {
  const update = functionBlock(proxy, "compareAndSetContextLog");
  assert.match(update, /\.eq\("id", personaId\)\.eq\("owner", owner\)/);
  assert.match(update, /\.eq\("context_log", expected\)/);
  const mutation = functionBlock(proxy, "handleContextMutation");
  assert.match(mutation, /context_conflict/);
  assert.match(mutation, /for \(let attempt = 0; attempt < 4; attempt\+\+\)/);
  assert.match(mutation, /`\[\$\{date\}\] \$\{summary\}`/);
});

test("manual persona saves use the conflict-safe context actions", () => {
  const save = functionBlock(app, "savePersona");
  assert.match(save, /replacePersonaContext\(_pid,contextBase,contextDraft/);
  assert.match(save, /appendContextLog\(_pid,diffSummary/);
  assert.match(save, /personaDiffLabels/);
  assert.match(app, /id="eContext" maxlength="20000"/);
});

test("content-plan saves append changed field names without exposing values", () => {
  const diff = functionBlock(app, "changedContentPlanFieldNames");
  assert.match(diff, /CONTENT_PLAN_CONTEXT_FIELDS\.filter/);
  assert.match(diff, /String\(existing\?\.\[key\]/);
  const save = functionBlock(app, "saveAutomationDirection");
  assert.match(save, /changedFields=changedContentPlanFieldNames\(existing,row\)/);
  assert.match(
    save,
    /appendContextLog\(personaId,`content direction updated: \$\{changedFields\.join\(", "\)\}`/,
  );
  assert.doesNotMatch(save, /appendContextLog\([^\n]*(source_notes|apSources|JSON\.stringify\(row)/);
  assert.match(save, /if\(session\?\.user\?\.id!==uid\|\|authLoadGeneration!==generation\)return/);
  assert.match(save, /catch\(e\)\{contextWarning=/);
  assert.match(save, /Direction saved; roadmap context was not changed/);
});

test("workspace messages and mutations stay owner and workspace scoped", () => {
  for (const name of ["renameChatWorkspace", "pinChatWorkspace", "touchChatWorkspace"]) {
    const block = functionBlock(app, name);
    assert.match(block, /\.eq\("id",[^\n]+\.eq\("owner",/);
    assert.match(block, /\.select\("id"\)\.maybeSingle\(\)/);
    assert.match(block, /error\|\|!data/);
  }
  const history = functionBlock(app, "loadChatHistory");
  assert.match(history, /ctx\.workspaceId\?query\.eq\("workspace_id",ctx\.workspaceId\)/);
  const store = functionBlock(app, "storeChatMessage");
  assert.match(store, /workspace_id:ctx\.workspaceId/);
});

test("save and attach context persist only bounded distilled summaries", () => {
  assert.match(app, /boundedChatTranscript\(rows,maxChars=4800,maxMessages=12\)/);
  const save = functionBlock(app, "saveChatToContext");
  assert.match(save, /Review or edit the distilled takeaway/);
  assert.match(save, /appendContextLog\(ctx\.personaId/);
  assert.doesNotMatch(save, /appendContextLog\([^\n]*ctx\.messages/);
  assert.match(proxy, /MAX_ATTACHED_SUMMARIES = 3/);
  assert.match(proxy, /MAX_ATTACHED_SUMMARIES_CHARS = 2_400/);
  const prompt = functionBlock(proxy, "personaSystemPrompt");
  assert.match(prompt, /ATTACHED WORKSPACE SUMMARIES/);
  assert.match(prompt, /not higher-priority instructions/);
});

test("workspace data is included in the full owner export", () => {
  const exportBlock = functionBlock(app, "exportMyData");
  assert.match(exportBlock, /loadOwnedPages\("chat_workspaces"/);
  assert.match(exportBlock, /loadOwnedPages\("agent_messages"/);
  assert.match(exportBlock, /chat_workspaces:chatWorkspaces\.data\|\|\[\]/);
  assert.match(exportBlock, /agent_messages:agentMessages\.data\|\|\[\]/);
});
