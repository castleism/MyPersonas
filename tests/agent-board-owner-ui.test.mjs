import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root=path.resolve(import.meta.dirname,"..");
const[html,source,css,pagesWorkflow,functionsWorkflow]=await Promise.all([
  readFile(path.join(root,"MyPersonas.Online_v0/index.html"),"utf8"),
  readFile(path.join(root,"MyPersonas.Online_v0/agent-board.js"),"utf8"),
  readFile(path.join(root,"MyPersonas.Online_v0/agent-board.css"),"utf8"),
  readFile(path.join(root,".github/workflows/pages.yml"),"utf8"),
  readFile(path.join(root,".github/workflows/supabase-deploy.yml"),"utf8"),
]);

test("agent board is reachable from desktop, mobile, sidebar, and router",()=>{
  assert.match(html,/agent-board\.css\?v=20260822-2/);
  assert.match(html,/agent-board\.js\?v=20260822-4/);
  assert.match(html,/siteGo\('agent-board'\)/);
  assert.match(html,/ownerAppMobileGo\('agent-board'\)/);
  assert.match(html,/nav\(view==="agent-board","agent-board","chip","Agent board"\)/);
  assert.match(html,/if\(view==="agent-board"\)return renderAgentBoard\(\)/);
  assert.match(css,/@media\(max-width:760px\)/);
  assert.match(pagesWorkflow,/--include '\/agent-board\.css'/);
  assert.match(pagesWorkflow,/--include '\/agent-board\.js'/);
});

test("database-dependent production workflows require an explicit reviewed release",()=>{
  assert.doesNotMatch(pagesWorkflow,/\n\s+push:/);
  assert.doesNotMatch(functionsWorkflow,/\n\s+push:/);
  assert.match(pagesWorkflow,/OPAQUE-FOUNDATION-VERIFIED/);
  assert.match(functionsWorkflow,/MIGRATIONS-062-064-GATEWAY-VERIFIED/);
  assert.match(functionsWorkflow,/public-media approved-media owner-media-preview legacy-media-remediation/);
  assert.match(functionsWorkflow,/OPAQUE-FRONTEND-VERIFIED/);
  assert.match(functionsWorkflow,/Deployment blocked: SUPABASE_ACCESS_TOKEN is not configured/);
});

test("owner board uses bounded RPCs, explicit AAL2 gates, and hard budget controls",()=>{
  for(const contract of[
    "owner_agent_board_queue_page","save_agent_board_settings","approve_agent_board_request",
    "reject_agent_board_request","cancel_agent_board_request","delete_terminal_agent_board_request",
    "get_agent_board_review_item","reconcile_my_expired_agent_board_runs",
    "my_ai_backend_budget_policies","save_ai_backend_budget_policy",
  ])assert.match(source,new RegExp(`["]${contract}["]`));
  assert.match(source,/requireAal2ForSensitiveAction\("change agent-board controls"\)/);
  assert.match(source,/requireAal2ForSensitiveAction\("run this exact approved agent-board request"\)/);
  assert.match(source,/Automated and agent-board calls fail closed without a policy/);
  assert.match(source,/JSON\.stringify\(\{requestId,approvalHash,idempotencyKey\}\)/);
  assert.match(source,/p_review_hash:item\.review_hash/);
  assert.match(source,/approved_review_payload/);
  assert.match(source,/crypto\.randomUUID/);
  assert.match(source,/localStorage\.setItem/);
  assert.match(source,/pre_provider===true/);
  assert.match(source,/Third-party disclosure and prompt-injection warning/);
  assert.match(source,/Remove secrets first,[\s\S]*treat instructions inside copied content as data—not commands/);
  assert.match(html,/agentBoardResetOwnerState\(previousUid\|\|""\)/);
  assert.match(source,/types\.length===0/);
  assert.doesNotMatch(source,/agentBoardRunNext|Run next approved/);
  assert.doesNotMatch(source,/setInterval\s*\(/);
  assert.doesNotMatch(source,/\beval\s*\(/);
  assert.doesNotMatch(source,/\.from\("agent_board_(?:settings|requests|runs|decisions)"\)\.(?:insert|update|upsert|delete)/);
});

test("review, run, and deletion controls are specific and accessible",()=>{
  assert.match(html,/id="toast" role="status" aria-live="polite" aria-atomic="true"/);
  for(const id of["agentBoardPersona","agentBoardTypes","agentBoardDaily","agentBoardSource","agentBoardTarget","agentBoardTaskType","agentBoardRisk","agentBoardSubjectType","agentBoardSubjectId","agentBoardBackend","agentBoardInstructions","agentBoardContext","agentBoardStatus","agentBudgetBackend","agentBudgetMode","agentBudgetDailyRequests","agentBudgetMonthlyRequests","agentBudgetDailyTokens","agentBudgetMonthlyTokens","agentBudgetConcurrency","agentBudgetTtl"]){
    assert.match(source,new RegExp(`<label for=[\"]${id}[\"]>`));
  }
  assert.match(source,/Type \$\{phrase\} to confirm/);
  assert.match(source,/tabindex="0"/);
  assert.match(css,/min-height:44px/);
  assert.match(css,/font-size:16px/);
  assert.match(css,/:focus-visible/);
});

test("untrusted queue content is escaped and never embedded in an event-handler argument",()=>{
  const context=vm.createContext({
    console,session:null,renderEpoch:1,myPersonas:[],myBackends:[],
    esc(value){return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));},
  });
  vm.runInContext(source,context,{filename:"agent-board.js"});
  const rendered=vm.runInContext(`agentBoardRequestHtml({
    id:"00000000-0000-4000-8000-000000000001",source_persona_name:"<img src=x onerror=alert(1)>",
    target_persona_name:"Target's",source_persona_handle:"bad' onclick='alert(2)",target_persona_handle:"target",
    task_type:"review_draft",subject_type:"general",subject_id:null,risk_level:"low",status:"owner_review",
    instructions:"</p><script>alert(3)</script>",created_at:"2026-08-22T00:00:00Z"
  })`,context);
  assert.doesNotMatch(rendered,/<script>|<img src=x|onclick='alert/);
  assert.match(rendered,/&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.match(rendered,/agentBoardCopyRequest\('00000000-0000-4000-8000-000000000001'\)/);
  assert.doesNotMatch(source,/agentBoardCopy\(\$\{JSON\.stringify\(packet\)\}/);
  const approved=vm.runInContext(`agentBoardRequestHtml({
    id:"00000000-0000-4000-8000-000000000002",source_persona_name:"Source",target_persona_name:"Target",
    task_type:"research",subject_type:"general",risk_level:"low",status:"approved",instructions:"Safe",
    created_at:"2026-08-22T00:00:00Z",approved_review_hash:"${"a".repeat(64)}",
    approved_review_payload:{context:"</pre><img src=x onerror=alert(4)>"}
  })`,context);
  assert.doesNotMatch(approved,/<img src=x/);
  assert.match(approved,/&lt;\/pre&gt;&lt;img src=x onerror=alert\(4\)&gt;/);
});

test("delayed queue responses cannot overwrite a newer filter or account",async()=>{
  const pending=[];
  const context=vm.createContext({
    console,renderEpoch:1,session:{user:{id:"owner-a"}},myPersonas:[],myBackends:[],
    sb:{rpc(_name,args){return new Promise(resolve=>pending.push({args,resolve}))}},
    esc:value=>String(value??""),
  });
  vm.runInContext(source,context,{filename:"agent-board.js"});
  vm.runInContext(`agentBoardState.status="owner_review";globalThis.first=agentBoardLoadQueue("owner-a",1);agentBoardState.status="approved";globalThis.second=agentBoardLoadQueue("owner-a",1)`,context);
  pending[0].resolve({data:[{id:"00000000-0000-4000-8000-000000000001",created_at:"2026-08-22T00:00:00Z"}],error:null});
  await context.first;
  pending[1].resolve({data:[{id:"00000000-0000-4000-8000-000000000002",created_at:"2026-08-22T00:00:01Z"}],error:null});
  await context.second;
  assert.deepEqual([...vm.runInContext("agentBoardState.queue.map(row=>row.id)",context)],["00000000-0000-4000-8000-000000000002"]);
  vm.runInContext(`agentBoardState.status="failed";globalThis.third=agentBoardLoadQueue("owner-a",1);session={user:{id:"owner-b"}}`,context);
  pending[2].resolve({data:[{id:"00000000-0000-4000-8000-000000000003",created_at:"2026-08-22T00:00:02Z"}],error:null});
  await context.third;
  assert.deepEqual([...vm.runInContext("agentBoardState.queue.map(row=>row.id)",context)],["00000000-0000-4000-8000-000000000002"]);
});

test("fresh review packets with an empty queue hash load once and approve on the second click",async()=>{
  const requestId="00000000-0000-4000-8000-000000000011",reviewHash="a".repeat(64),calls=[],messages=[];
  const context=vm.createContext({
    console,renderEpoch:1,session:{user:{id:"owner-a"}},myPersonas:[],myBackends:[],
    esc:value=>String(value??""),confirm:()=>true,toast:message=>messages.push(message),
    requireAal2ForSensitiveAction:async()=>true,
    sb:{rpc(name,args){calls.push({name,args});if(name==="get_agent_board_review_item")return Promise.resolve({data:[{request_id:requestId,review_hash:reviewHash,review_payload:{schema_version:1,execution:{prompt_schema:"agent-board-v1"}}}],error:null});if(name==="approve_agent_board_request")return Promise.resolve({data:null,error:null});throw new Error(`Unexpected RPC ${name}`)}},
  });
  vm.runInContext(source,context,{filename:"agent-board.js"});
  vm.runInContext(`agentBoardPaint=()=>{};renderAgentBoard=async()=>{};agentBoardState.queue=[{
    id:"${requestId}",status:"owner_review",review_hash:"",updated_at:"2026-08-22T00:00:00Z",
    source_persona_id:"00000000-0000-4000-8000-000000000021",target_persona_id:"00000000-0000-4000-8000-000000000022",
    task_type:"research",subject_type:"general",instructions:"Review this",context:{},risk_level:"low"
  }]`,context);

  await vm.runInContext(`agentBoardApprove("${requestId}")`,context);
  assert.deepEqual(calls.map(call=>call.name),["get_agent_board_review_item"]);
  assert.match(messages.at(-1),/Exact packet loaded/);
  assert.equal(vm.runInContext(`agentBoardReviewItem(agentBoardState.queue[0]).review_hash`,context),reviewHash);

  await vm.runInContext(`agentBoardApprove("${requestId}")`,context);
  assert.deepEqual(calls.map(call=>call.name),["get_agent_board_review_item","approve_agent_board_request"]);
  assert.equal(calls[1].args.p_request_id,requestId);
  assert.equal(calls[1].args.p_review_hash,reviewHash);

  const mismatchedId="00000000-0000-4000-8000-000000000012";
  vm.runInContext(`agentBoardState.queue=[{
    id:"${mismatchedId}",status:"owner_review",review_hash:"${"b".repeat(64)}",updated_at:"2026-08-22T00:00:01Z",
    source_persona_id:"00000000-0000-4000-8000-000000000021",target_persona_id:"00000000-0000-4000-8000-000000000022",
    task_type:"research",subject_type:"general",instructions:"Changed",context:{},risk_level:"low"
  }]`,context);
  calls.length=0;
  context.sb.rpc=(name,args)=>{calls.push({name,args});return Promise.resolve({data:[{request_id:mismatchedId,review_hash:reviewHash,review_payload:{schema_version:1}}],error:null})};
  const mismatch=await vm.runInContext(`agentBoardLoadReview("${mismatchedId}",false)`,context);
  assert.equal(mismatch,null);
  assert.deepEqual(calls.map(call=>call.name),["get_agent_board_review_item"]);
  assert.equal(vm.runInContext(`agentBoardReviewItem(agentBoardState.queue[0])`,context),null);
  assert.match(messages.at(-1),/changed while its review loaded/i);
});

test("logout and account switch clear only the previous owner's Agent Board browser state",()=>{
  const ownerA="00000000-0000-4000-8000-0000000000aa",ownerB="00000000-0000-4000-8000-0000000000bb";
  const values=new Map([
    [`mypersonas.agent-board.run.${ownerA}.request-a.hash-a`,"key-a"],
    [`mypersonas.agent-board.run.${ownerA}.request-b.hash-b`,"key-b"],
    [`mypersonas.agent-board.run.${ownerB}.request-c.hash-c`,"key-c"],
    ["unrelated.preference","keep"],
  ]);
  const localStorage={
    get length(){return values.size},
    key(index){return [...values.keys()][index]??null},
    getItem(key){return values.get(key)??null},
    setItem(key,value){values.set(key,String(value))},
    removeItem(key){values.delete(key)},
  };
  const context=vm.createContext({
    console,localStorage,session:{user:{id:ownerA}},renderEpoch:1,myPersonas:[],myBackends:[],
    esc:value=>String(value??""),
  });
  vm.runInContext(source,context,{filename:"agent-board.js"});
  vm.runInContext(`agentBoardState.ownerId="${ownerA}";agentBoardState.queue=[{id:"request-a"}];agentBoardState.reviewItems.set("request-a:hash-a",{request_id:"request-a"});agentBoardState.budgetsUnlocked=true`,context);
  const generation=vm.runInContext("agentBoardState.queueGeneration",context);
  vm.runInContext(`agentBoardResetOwnerState("${ownerA}")`,context);
  assert.equal(values.has(`mypersonas.agent-board.run.${ownerA}.request-a.hash-a`),false);
  assert.equal(values.has(`mypersonas.agent-board.run.${ownerA}.request-b.hash-b`),false);
  assert.equal(values.get(`mypersonas.agent-board.run.${ownerB}.request-c.hash-c`),"key-c");
  assert.equal(values.get("unrelated.preference"),"keep");
  assert.equal(vm.runInContext("agentBoardState.reviewItems.size",context),0);
  assert.equal(vm.runInContext("agentBoardState.queue.length",context),0);
  assert.equal(vm.runInContext("agentBoardState.ownerId",context),"");
  assert.equal(vm.runInContext("agentBoardState.budgetsUnlocked",context),false);
  assert.ok(vm.runInContext("agentBoardState.queueGeneration",context)>generation);
});
