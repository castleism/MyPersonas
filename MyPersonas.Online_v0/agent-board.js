// Owner-facing agent collaboration board. This UI never schedules itself,
// publishes content, or receives provider credentials. Every execution remains
// an exact owner-reviewed queue action behind AAL2 and the server budget guard.
let agentBoardState={
  settings:[],queue:[],reviewItems:new Map(),analytics:null,status:"",before:null,
  hasMore:false,loading:false,queueGeneration:0,runInFlight:"",reconcileInFlight:false,
  queueLoadError:"",budgets:[],budgetsUnlocked:false,selectedPersonaId:"",
  selectedBudgetBackendId:"",selectedBudgetMode:"agent_board",ownerId:""
};
const AGENT_BOARD_PAGE_SIZE=25;
const AGENT_BOARD_RUN_STORAGE_PREFIX="mypersonas.agent-board.run.";

function agentBoardSessionCurrent(owner,epoch){return session?.user?.id===owner&&renderEpoch===epoch}
function agentBoardResetOwnerState(owner=""){
  const ownerPrefix=owner?`${AGENT_BOARD_RUN_STORAGE_PREFIX}${owner}.`:"";
  if(ownerPrefix)try{
    const keys=[];for(let index=0;index<localStorage.length;index++){const key=localStorage.key(index);if(key?.startsWith(ownerPrefix))keys.push(key)}
    keys.forEach(key=>localStorage.removeItem(key));
  }catch{}
  const queueGeneration=agentBoardState.queueGeneration+1;
  agentBoardState={
    settings:[],queue:[],reviewItems:new Map(),analytics:null,status:"",before:null,
    hasMore:false,loading:false,queueGeneration,runInFlight:"",reconcileInFlight:false,
    queueLoadError:"",budgets:[],budgetsUnlocked:false,selectedPersonaId:"",
    selectedBudgetBackendId:"",selectedBudgetMode:"agent_board",ownerId:""
  };
}
function agentBoardSetupMessage(message){
  const text=String(message||"");
  return /schema cache|could not find the function|does not exist|relation .* does not exist|pgrst20/i.test(text)
    ?"The local agent-board migrations are ready, but this database has not applied them yet. Nothing can execute until the reviewed migration release is applied."
    :text||"The agent board could not be loaded.";
}
function agentBoardPersona(id){return (myPersonas||[]).find(row=>row.id===id)||null}
function agentBoardBackend(id){return (myBackends||[]).find(row=>row.id===id)||null}
function agentBoardSetting(id){return agentBoardState.settings.find(row=>row.persona_id===id)||null}
function agentBoardLatestRun(id){
  const row=agentBoardState.queue.find(request=>request.id===id);
  if(!row?.latest_run_id)return null;
  return {id:row.latest_run_id,request_id:id,status:row.latest_run_status,
    result_text:row.latest_run_result,error:row.latest_run_error,
    started_at:row.latest_run_started_at,completed_at:row.latest_run_completed_at};
}
function agentBoardNumber(value){const number=Number(value);return Number.isFinite(number)?number:0}
function agentBoardDate(value){try{return value?new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(value)):"—"}catch{return "—"}}
function agentBoardFormatNumber(value){return agentBoardNumber(value).toLocaleString()}
function agentBoardStatusClass(status){return ["completed","approved"].includes(status)?"connected":["failed","rejected"].includes(status)?"attention":""}
function agentBoardPolicyKey(backendId,mode){return `${backendId}:${mode}`}
function agentBoardPolicy(backendId,mode){return agentBoardState.budgets.find(row=>agentBoardPolicyKey(row.backend_id,row.mode)===agentBoardPolicyKey(backendId,mode))||null}
function agentBoardReviewCacheKey(id,hash){return `${id}:${hash}`}
function agentBoardReviewQueueMarker(request){return JSON.stringify([
  request?.id||"",request?.status||"",request?.updated_at||"",request?.source_persona_id||"",
  request?.source_persona_name||"",request?.source_persona_handle||"",request?.target_persona_id||"",
  request?.target_persona_name||"",request?.target_persona_handle||"",request?.target_backend_id||"",
  request?.parent_request_id||"",request?.task_type||"",request?.subject_type||"",request?.subject_id||"",
  request?.instructions||"",request?.context??{},request?.risk_level||"",request?.review_hash||"",
  request?.approved_review_hash||""
])}
function agentBoardReviewCacheEntries(id){return [...agentBoardState.reviewItems.entries()].filter(([,item])=>item?.request_id===id)}
function agentBoardDropReviewCache(id){agentBoardReviewCacheEntries(id).forEach(([key])=>agentBoardState.reviewItems.delete(key))}
function agentBoardCacheReview(request,item){
  agentBoardDropReviewCache(request.id);
  const cached={...item,request_id:request.id,queue_marker:agentBoardReviewQueueMarker(request)};
  agentBoardState.reviewItems.set(agentBoardReviewCacheKey(request.id,item.review_hash),cached);
  return cached;
}
function agentBoardCachedReview(request){
  if(!request?.id)return null;
  const entries=agentBoardReviewCacheEntries(request.id),expectedMarker=agentBoardReviewQueueMarker(request);
  const item=request.review_hash
    ?agentBoardState.reviewItems.get(agentBoardReviewCacheKey(request.id,request.review_hash))
    :entries.length===1?entries[0][1]:null;
  if(!item||item.queue_marker!==expectedMarker||(request.review_hash&&item.review_hash!==request.review_hash)){
    if(entries.length)agentBoardDropReviewCache(request.id);
    return null;
  }
  return item;
}

async function agentBoardLoadQueue(owner,epoch,{append=false}={}){
  const generation=++agentBoardState.queueGeneration,status=agentBoardState.status;
  agentBoardState.loading=true;agentBoardState.queueLoadError="";
  const before=append?agentBoardState.before:null;
  const queue=await sb.rpc("owner_agent_board_queue_page",{
    p_status_filter:status||null,
    p_before_created_at:before?.created_at||null,p_before_id:before?.id||null,p_limit:AGENT_BOARD_PAGE_SIZE
  });
  if(!agentBoardSessionCurrent(owner,epoch)||generation!==agentBoardState.queueGeneration||status!==agentBoardState.status)return null;
  agentBoardState.loading=false;
  if(queue.error){agentBoardState.queueLoadError=queue.error.message||"Queue load failed";return queue}
  const incoming=queue.data||[],seen=new Set((append?agentBoardState.queue:[]).map(row=>row.id));
  incoming.forEach(row=>{
    const entries=agentBoardReviewCacheEntries(row.id),marker=agentBoardReviewQueueMarker(row);
    if(entries.some(([,cached])=>cached.queue_marker!==marker||(row.review_hash&&cached.review_hash!==row.review_hash)))agentBoardDropReviewCache(row.id);
  });
  agentBoardState.queue=[...(append?agentBoardState.queue:[]),...incoming.filter(row=>!seen.has(row.id))];
  const last=agentBoardState.queue[agentBoardState.queue.length-1];agentBoardState.before=last?{created_at:last.created_at,id:last.id}:null;agentBoardState.hasMore=incoming.length===AGENT_BOARD_PAGE_SIZE;
  return queue;
}

async function renderAgentBoard(){
  const owner=session?.user?.id,epoch=renderEpoch;
  if(!owner){app.innerHTML='<div class="empty">Sign in to use the agent board.</div>';return}
  if(!(myPersonas||[]).length){app.innerHTML='<div class="empty">Create a persona before setting up an agent collaboration board.</div>';return}
  if(agentBoardState.ownerId&&agentBoardState.ownerId!==owner)agentBoardState.reviewItems.clear();
  ++agentBoardState.queueGeneration;
  agentBoardState={...agentBoardState,ownerId:owner,settings:[],queue:[],analytics:null,before:null,hasMore:false,loading:false,queueLoadError:"",budgets:[],budgetsUnlocked:false,selectedPersonaId:agentBoardState.selectedPersonaId||myPersonas[0].id};
  app.innerHTML='<div class="empty">Loading the owner-reviewed agent board…</div>';
  const[settings,analytics]=await Promise.all([
    sb.from("agent_board_settings").select("persona_id,owner,proposals_enabled,execution_enabled,approval_required,allowed_task_types,daily_proposal_limit,created_at,updated_at").eq("owner",owner).order("created_at",{ascending:true}).limit(500),
    sb.rpc("get_agent_board_analytics")
  ]);
  if(!agentBoardSessionCurrent(owner,epoch))return;
  const firstError=settings.error||analytics.error;
  if(firstError){app.innerHTML=`<div class="empty">${esc(agentBoardSetupMessage(firstError.message))}</div>`;return}
  agentBoardState.settings=settings.data||[];agentBoardState.analytics=(analytics.data||[])[0]||null;
  if(!myPersonas.some(row=>row.id===agentBoardState.selectedPersonaId))agentBoardState.selectedPersonaId=myPersonas[0]?.id||"";
  if(agentBoardState.selectedBudgetBackendId&&!myBackends.some(row=>row.id===agentBoardState.selectedBudgetBackendId))agentBoardState.selectedBudgetBackendId="";
  const queue=await agentBoardLoadQueue(owner,epoch);
  if(!agentBoardSessionCurrent(owner,epoch))return;
  if(queue?.error){app.innerHTML=`<div class="empty">${esc(agentBoardSetupMessage(queue.error.message))}</div>`;return}
  agentBoardPaint();
}

function agentBoardStatsHtml(){
  const row=agentBoardState.analytics||{};
  const values=[["All",row.total_requests],["Review",row.pending_review],["Approved",row.approved],["Completed",row.completed],["Failed",row.failed],["Rejected",row.rejected]];
  return `<div class="agent-board-stats">${values.map(([label,value])=>`<div class="agent-board-stat"><b>${agentBoardFormatNumber(value)}</b><span>${esc(label)}</span></div>`).join("")}</div>`;
}
function agentBoardSettingsHtml(){
  const personaId=agentBoardState.selectedPersonaId||myPersonas[0]?.id||"",setting=agentBoardSetting(personaId);
  const types=(setting?.allowed_task_types??["brainstorm","feature_request","optimization","qa","research","review_draft"]).join(", ");
  return `<div class="agent-board-card"><h3>Persona board controls</h3><p class="muted">Dormant by default. Saving changes requires multi-factor authentication; every proposal still requires a separate owner approval.</p>
    <label for="agentBoardPersona">Persona</label><select id="agentBoardPersona" onchange="agentBoardSelectPersona(this.value)">${myPersonas.map(persona=>`<option value="${esc(persona.id)}" ${persona.id===personaId?"selected":""}>${esc(persona.name)} · @${esc(persona.handle||"")}</option>`).join("")}</select>
    <div class="row"><label><input id="agentBoardProposals" type="checkbox" ${setting?.proposals_enabled?"checked":""}> Allow this persona to propose work</label><label><input id="agentBoardExecution" type="checkbox" ${setting?.execution_enabled?"checked":""}> Allow approved work to run manually</label></div>
    <label for="agentBoardTypes">Allowed task types (comma-separated)</label><input id="agentBoardTypes" class="agent-board-code" maxlength="3249" value="${esc(types)}" placeholder="research, brainstorm, review_draft">
    <label for="agentBoardDaily">Maximum proposals per UTC day</label><input id="agentBoardDaily" type="number" min="1" max="50" step="1" value="${esc(setting?.daily_proposal_limit||10)}">
    <button class="btn" type="button" onclick="agentBoardSaveSettings()">Save board controls</button></div>`;
}
function agentBoardProposalHtml(){
  const ready=(myBackends||[]).filter(backendAgentReady),source=agentBoardState.selectedPersonaId||myPersonas[0]?.id||"";
  return `<div class="agent-board-card"><h3>Draft a collaboration request</h3><p class="muted">This creates a review item only. It cannot approve, execute, publish, send, purchase, or modify an external account.</p>
    <div class="row"><div><label for="agentBoardSource">Proposing persona</label><select id="agentBoardSource">${myPersonas.map(persona=>`<option value="${esc(persona.id)}" ${persona.id===source?"selected":""}>${esc(persona.name)}</option>`).join("")}</select></div><div><label for="agentBoardTarget">Working persona</label><select id="agentBoardTarget">${myPersonas.map(persona=>`<option value="${esc(persona.id)}" ${persona.id===source?"selected":""}>${esc(persona.name)}</option>`).join("")}</select></div></div>
    <div class="row"><div><label for="agentBoardTaskType">Task type</label><input id="agentBoardTaskType" maxlength="64" value="research" pattern="[a-z0-9][a-z0-9_:-]{0,63}"></div><div><label for="agentBoardRisk">Risk</label><select id="agentBoardRisk"><option>low</option><option>medium</option><option>high</option></select></div></div>
    <div class="row"><div><label for="agentBoardSubjectType">Subject type</label><input id="agentBoardSubjectType" maxlength="64" value="general" pattern="[a-z0-9][a-z0-9_:-]{0,63}"></div><div><label for="agentBoardSubjectId">Owned subject UUID (optional)</label><input id="agentBoardSubjectId" maxlength="36" placeholder="Post draft UUID when subject type is post_draft"></div></div>
    <label for="agentBoardBackend">Specific model (optional)</label><select id="agentBoardBackend"><option value="">Use the working persona's model</option>${ready.map(backend=>`<option value="${esc(backend.id)}">${esc(backend.name)} · ${esc(backend.model||"model not set")}</option>`).join("")}</select>
    <label for="agentBoardInstructions">Instructions</label><textarea id="agentBoardInstructions" maxlength="12000" style="min-height:130px" placeholder="State the intended result, evidence standard, constraints, and what the owner must review."></textarea>
    <label for="agentBoardContext">Review context (optional)</label><textarea id="agentBoardContext" maxlength="4000" placeholder="Evidence, assumptions, exclusions, or other context that must appear in the exact review packet."></textarea>
    <button class="btn" id="agentBoardProposeButton" type="button" onclick="agentBoardPropose()">Add to owner review</button></div>`;
}
function agentBoardBudgetHtml(){
  if(!agentBoardState.budgetsUnlocked)return `<div class="agent-board-card agent-board-wide"><h3>AI request and token budgets</h3><div class="agent-board-callout warn"><b>Automated and agent-board calls fail closed without a policy.</b> Unlocking this panel requires MFA because it reveals usage and can change spending boundaries. No pricing estimate is assumed.</div><button class="btn sec" type="button" onclick="agentBoardUnlockBudgets()">Verify MFA and load budget controls</button></div>`;
  const backendId=agentBoardState.selectedBudgetBackendId||myBackends[0]?.id||"",mode=agentBoardState.selectedBudgetMode||"agent_board",policy=agentBoardPolicy(backendId,mode),enabled=policy?.enabled===true;
  return `<div class="agent-board-card agent-board-wide agent-board-budget"><h3>AI request and token budgets</h3><div class="agent-board-callout warn">These are hard usage ceilings, not currency forecasts. Trial quotas and provider prices remain provider-side facts to verify before enabling a model.</div>
    <div class="row"><div><label for="agentBudgetBackend">Model connection</label><select id="agentBudgetBackend" onchange="agentBoardBudgetSelectionChanged()">${myBackends.map(backend=>`<option value="${esc(backend.id)}" ${backend.id===backendId?"selected":""}>${esc(backend.name)} · ${esc(backend.model||"")}</option>`).join("")}</select></div><div><label for="agentBudgetMode">Protected mode</label><select id="agentBudgetMode" onchange="agentBoardBudgetSelectionChanged()"><option value="agent_board" ${mode==="agent_board"?"selected":""}>Agent board</option><option value="automation" ${mode==="automation"?"selected":""}>Scheduled automation</option></select></div></div>
    <label><input id="agentBudgetEnabled" type="checkbox" ${enabled?"checked":""}> Enable this exact model + mode policy</label>
    <div class="row"><div><label for="agentBudgetDailyRequests">Daily requests</label><input id="agentBudgetDailyRequests" type="number" min="0" max="1000000" step="1" value="${esc(policy?.daily_request_limit??10)}"></div><div><label for="agentBudgetMonthlyRequests">Monthly requests</label><input id="agentBudgetMonthlyRequests" type="number" min="0" max="30000000" step="1" value="${esc(policy?.monthly_request_limit??100)}"></div></div>
    <div class="row"><div><label for="agentBudgetDailyTokens">Daily accounted tokens</label><input id="agentBudgetDailyTokens" type="number" min="0" max="1000000000000" step="1" value="${esc(policy?.daily_token_limit??25000)}"></div><div><label for="agentBudgetMonthlyTokens">Monthly accounted tokens</label><input id="agentBudgetMonthlyTokens" type="number" min="0" max="30000000000000" step="1" value="${esc(policy?.monthly_token_limit??250000)}"></div></div>
    <div class="row"><div><label for="agentBudgetConcurrency">Concurrent leases for this mode</label><input id="agentBudgetConcurrency" type="number" min="1" max="100" step="1" value="${esc(policy?.max_concurrent_leases??1)}"></div><div><label for="agentBudgetTtl">Lease expiry (seconds)</label><input id="agentBudgetTtl" type="number" min="60" max="3600" step="1" value="${esc(policy?.lease_ttl_seconds??120)}"></div></div>
    <div class="agent-board-budget-usage"><div><b>${agentBoardFormatNumber(policy?.day_requests)}</b><span class="muted">requests today</span></div><div><b>${agentBoardFormatNumber(policy?.day_accounted_tokens)}</b><span class="muted">accounted tokens today</span></div><div><b>${agentBoardFormatNumber(policy?.active_leases)}</b><span class="muted">active leases</span></div><div><b>${agentBoardFormatNumber(policy?.month_requests)}</b><span class="muted">requests this month</span></div><div><b>${agentBoardFormatNumber(policy?.month_accounted_tokens)}</b><span class="muted">accounted tokens this month</span></div><div><b>${policy?esc(policy.enabled?"enabled":"disabled"):"not configured"}</b><span class="muted">current policy</span></div></div>
    <button class="btn" type="button" onclick="agentBoardSaveBudget()">Save hard budget policy</button></div>`;
}
function agentBoardJson(value){try{return JSON.stringify(value??{},null,2)}catch{return "{}"}}
function agentBoardReviewItem(request){
  if(request?.approved_review_payload&&request?.approved_review_hash){
    return {review_payload:request.approved_review_payload,review_hash:request.approved_review_hash,approved:true};
  }
  return agentBoardCachedReview(request);
}
function agentBoardReviewHtml(request){
  const item=agentBoardReviewItem(request),hash=item?.review_hash||request.review_hash||request.approved_review_hash||"";
  if(!item){
    return `<div class="agent-board-callout warn">The exact, complete review packet has not been loaded in this browser. <button class="btn sm sec" type="button" onclick="agentBoardLoadReview('${request.id}',true)">Load exact review packet</button></div>`;
  }
  return `<details class="agent-board-review-details"><summary>Exact ${item.approved?"approved":"current"} execution packet</summary><div class="agent-board-review-hash">SHA-256 · ${esc(hash)}</div><pre class="agent-board-review-packet" tabindex="0">${esc(agentBoardJson(item.review_payload))}</pre></details>`;
}
async function agentBoardLoadReview(id,paintAfter=false){
  const request=agentBoardState.queue.find(row=>row.id===id);
  if(!request){toast("Reload the queue before loading this review");return null}
  if(request.approved_review_payload&&request.approved_review_hash)return agentBoardReviewItem(request);
  const owner=session?.user?.id,epoch=renderEpoch,result=await sb.rpc("get_agent_board_review_item",{p_request_id:id});
  if(!agentBoardSessionCurrent(owner,epoch))return null;
  if(result.error){toast(agentBoardSetupMessage(result.error.message));return null}
  const item=Array.isArray(result.data)?result.data[0]:result.data;
  if(item?.request_id!==id||!item?.review_hash||!item?.review_payload){toast("The server did not return a complete review packet");return null}
  const current=agentBoardState.queue.find(row=>row.id===id);
  if(!current||(current.review_hash&&current.review_hash!==item.review_hash)){toast("This request changed while its review loaded. Reload and inspect the new packet.");agentBoardDropReviewCache(id);renderAgentBoard();return null}
  const cached=agentBoardCacheReview(current,item);
  if(paintAfter)agentBoardPaint("agentBoardRequest_"+id);
  return cached;
}
function agentBoardRequestHtml(request){
  const run=agentBoardLatestRun(request.id),terminal=["completed","failed","rejected","cancelled"].includes(request.status),review=request.status==="owner_review",approved=request.status==="approved";
  const backend=agentBoardBackend(request.target_backend_id),busy=!!agentBoardState.runInFlight;
  return `<article class="agent-board-request" id="agentBoardRequest_${request.id}"><div class="agent-board-request-head"><div><div class="agent-board-path">${esc(request.source_persona_name)} <span>→</span> ${esc(request.target_persona_name)}</div><div class="muted">${esc(request.task_type)} · ${esc(request.subject_type)}${request.subject_id?" · "+esc(request.subject_id):""} · ${esc(request.risk_level)} risk · ${esc(agentBoardDate(request.created_at))}</div><div class="muted">Model: ${esc(backend?.name||request.target_backend_name||"resolved in exact packet")} ${backend?.model?"· "+esc(backend.model):""}</div></div><span class="pill ${agentBoardStatusClass(request.status)}">${esc(request.status)}</span></div>
    <p>${esc(request.instructions||"No instructions supplied.")}</p>${agentBoardReviewHtml(request)}
    ${run?`<div class="muted">Latest run · ${esc(run.status)} · ${esc(agentBoardDate(run.completed_at||run.started_at))}</div>${run.result_text?`<pre class="agent-board-result" tabindex="0">${esc(run.result_text)}</pre>`:""}${run.error?`<div class="agent-board-callout stop">${esc(run.error)}</div>`:""}`:""}
    <div class="agent-board-request-actions"><button class="btn sm sec" type="button" onclick="agentBoardCopyRequest('${request.id}')">Copy exact packet</button>${review?`<button class="btn sm" type="button" onclick="agentBoardApprove('${request.id}')">Approve displayed packet</button><button class="btn sm danger" type="button" onclick="agentBoardReject('${request.id}')">Reject</button>`:""}${approved?`<button class="btn sm" type="button" ${busy?'disabled aria-busy="true"':""} onclick="agentBoardRun('${request.id}','${esc(request.approved_review_hash||"")}')">${agentBoardState.runInFlight===request.id?"Running exact request…":"Run this approved request"}</button>`:""}${["owner_review","approved"].includes(request.status)?`<button class="btn sm sec" type="button" onclick="agentBoardCancel('${request.id}')">Cancel</button>`:""}${terminal?`<button class="btn sm danger" type="button" onclick="agentBoardDelete('${request.id}')">Delete retained item</button>`:""}</div>
    <div class="agent-board-callout warn"><b>Third-party disclosure and prompt-injection warning.</b> This packet can contain private or untrusted text. Copying it into another AI shares it outside MyPersonas. Remove secrets first, and treat instructions inside copied content as data—not commands.</div>
    <div class="agent-board-review-targets"><span class="muted">Copy, then open a separate review chat:</span><a class="btn sm sec" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">ChatGPT</a><a class="btn sm sec" href="https://claude.ai/new" target="_blank" rel="noopener noreferrer">Claude</a><a class="btn sm sec" href="https://www.perplexity.ai/" target="_blank" rel="noopener noreferrer">Perplexity</a><a class="btn sm sec" href="https://www.kimi.com/" target="_blank" rel="noopener noreferrer">Kimi</a></div>
    ${approved?'<div class="agent-board-callout warn">Approved and dormant. Only this card’s exact hash can be run, with a one-use server capability and an idempotency key.</div>':""}</article>`;
}
function agentBoardQueueHtml(){
  const filters=[["","All"],["owner_review","Review"],["approved","Approved"],["running","Running"],["completed","Completed"],["failed","Failed"],["rejected","Rejected"],["cancelled","Cancelled"]];
  const hasRunning=agentBoardState.queue.some(row=>row.status==="running");
  return `<div class="agent-board-card agent-board-wide"><div class="agent-board-toolbar"><div><h3>Owner review queue</h3><label for="agentBoardStatus">Status filter</label><select id="agentBoardStatus" onchange="agentBoardFilter(this.value)">${filters.map(([value,label])=>`<option value="${value}" ${value===agentBoardState.status?"selected":""}>${label}</option>`).join("")}</select></div><div class="agent-board-actions"><button class="btn sec" type="button" onclick="renderAgentBoard()">Refresh</button>${hasRunning?`<button class="btn sec" type="button" ${agentBoardState.reconcileInFlight?'disabled aria-busy="true"':""} onclick="agentBoardReconcile()">Reconcile expired claims</button>`:""}</div></div>
    <div class="agent-board-callout"><b>Manual, bounded, and review-only.</b> Each card runs only its displayed approved hash. Running requires MFA, execution permission, a hard budget for that exact model/mode, an idempotency key, and a one-use server capability. Results return as unpublished drafts.</div>
    ${agentBoardState.queueLoadError?`<div class="agent-board-callout stop">${esc(agentBoardState.queueLoadError)}</div>`:""}<div class="agent-board-list" aria-busy="${agentBoardState.loading?"true":"false"}">${agentBoardState.queue.map(agentBoardRequestHtml).join("")||'<div class="empty">No requests match this filter.</div>'}</div>
    ${agentBoardState.hasMore?'<div style="text-align:center;margin-top:12px"><button class="btn sec" type="button" onclick="agentBoardLoadMore()">Load older requests</button></div>':""}</div>`;
}
function agentBoardPaint(focusId=""){
  app.innerHTML=`<div class="agent-board"><section class="agent-board-head"><div><span class="muted">Owner-controlled persona collaboration</span><h2>Agent board</h2></div><div class="agent-board-actions"><button class="btn sec" type="button" onclick="go('studio')">Models &amp; accounts</button></div></section>
    <div class="agent-board-callout stop"><b>No recursive autopilot is active.</b> This board stages one bounded proposal at a time. Every run requires a fresh owner review, MFA, execution permission, and a hard request/token budget.</div>${agentBoardStatsHtml()}<div class="agent-board-grid">${agentBoardSettingsHtml()}${agentBoardProposalHtml()}${agentBoardBudgetHtml()}${agentBoardQueueHtml()}</div></div>`;
  if(focusId)requestAnimationFrame(()=>{const target=document.getElementById(focusId);(target?.matches("button,select,input,textarea,a")?target:target?.querySelector("button,select,input,textarea,a"))?.focus({preventScroll:true})});
}
function agentBoardSelectPersona(personaId){agentBoardState.selectedPersonaId=personaId;agentBoardPaint()}
async function agentBoardFilter(status){agentBoardState.status=status;const owner=session?.user?.id,epoch=renderEpoch;if(!owner)return;app.querySelector?.(".agent-board-list")?.setAttribute("aria-busy","true");const result=await agentBoardLoadQueue(owner,epoch);if(!agentBoardSessionCurrent(owner,epoch)||result===null)return;if(result.error)toast(agentBoardSetupMessage(result.error.message));agentBoardPaint("agentBoardStatus")}
async function agentBoardLoadMore(){const owner=session?.user?.id,epoch=renderEpoch;if(!owner||!agentBoardState.hasMore)return;const result=await agentBoardLoadQueue(owner,epoch,{append:true});if(!agentBoardSessionCurrent(owner,epoch)||result===null)return;if(result.error)toast(result.error.message);agentBoardPaint()}

async function agentBoardSaveSettings(){
  const personaId=document.getElementById("agentBoardPersona")?.value,proposals=!!document.getElementById("agentBoardProposals")?.checked,execution=!!document.getElementById("agentBoardExecution")?.checked,daily=Number(document.getElementById("agentBoardDaily")?.value),raw=document.getElementById("agentBoardTypes")?.value||"";
  const types=[...new Set(raw.split(",").map(value=>value.trim().toLowerCase()).filter(Boolean))];
  if(!personaId||!Number.isInteger(daily)||daily<1||daily>50){toast("Choose a persona and a daily proposal cap from 1 to 50");return}
  if(types.length>50||types.some(value=>!/^[a-z0-9][a-z0-9_:-]{0,63}$/.test(value))){toast("Use up to 50 lowercase task types containing letters, numbers, _, :, or -");return}
  if((proposals||execution)&&types.length===0){toast("Add at least one allowed task type before enabling proposals or execution");document.getElementById("agentBoardTypes")?.focus();return}
  if(execution&&!confirm("Allow this persona to run only individually approved work? A separate hard model budget is still required."))return;
  if(!await requireAal2ForSensitiveAction("change agent-board controls"))return;
  const owner=session?.user?.id,epoch=renderEpoch,result=await sb.rpc("save_agent_board_settings",{p_persona_id:personaId,p_proposals_enabled:proposals,p_execution_enabled:execution,p_allowed_task_types:types,p_daily_proposal_limit:daily});
  if(!agentBoardSessionCurrent(owner,epoch))return;if(result.error){toast(result.error.message);return}toast("Agent-board controls saved");renderAgentBoard();
}
async function agentBoardPropose(){
  const source=document.getElementById("agentBoardSource")?.value,target=document.getElementById("agentBoardTarget")?.value,task=(document.getElementById("agentBoardTaskType")?.value||"").trim().toLowerCase(),risk=document.getElementById("agentBoardRisk")?.value||"low",subjectType=(document.getElementById("agentBoardSubjectType")?.value||"").trim().toLowerCase(),subjectId=(document.getElementById("agentBoardSubjectId")?.value||"").trim()||null,targetBackendId=document.getElementById("agentBoardBackend")?.value||null,instructions=(document.getElementById("agentBoardInstructions")?.value||"").trim(),contextNote=(document.getElementById("agentBoardContext")?.value||"").trim();
  if(!source||!target||!instructions){toast("Choose both personas and add instructions");return}if(!/^[a-z0-9][a-z0-9_:-]{0,63}$/.test(task)||!/^[a-z0-9][a-z0-9_:-]{0,63}$/.test(subjectType)){toast("Task and subject types must use lowercase letters, numbers, _, :, or -");return}if(subjectId&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subjectId)){toast("The optional subject ID must be a UUID");return}
  const button=document.getElementById("agentBoardProposeButton");if(button){button.disabled=true;button.textContent="Adding…"}
  try{const owner=session?.user?.id,epoch=renderEpoch,{data:{session:active}}=await sb.auth.getSession();if(!owner||!active||active.user.id!==owner){toast("Your signed-in account changed; nothing was added");return}const response=await fetch(CONFIG.SUPABASE_URL.replace(/\/$/,"")+"/functions/v1/agent-board-propose",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+active.access_token},body:JSON.stringify({source_persona_id:source,target_persona_id:target,task_type:task,instructions,subject_type:subjectType,subject_id:subjectId,context:{origin:"owner_agent_board",owner_note:contextNote||undefined},risk_level:risk,target_backend_id:targetBackendId})}),body=await response.json().catch(()=>({}));if(!agentBoardSessionCurrent(owner,epoch))return;if(!response.ok){toast(body.error||"The proposal could not be added");return}toast("Proposal added for owner review");renderAgentBoard()}catch{toast("The proposal service could not be reached. Nothing was queued.")}finally{if(button){button.disabled=false;button.textContent="Add to owner review"}}
}
async function agentBoardDecision(rpc,args,purpose,success){if(!await requireAal2ForSensitiveAction(purpose))return false;const owner=session?.user?.id,epoch=renderEpoch,result=await sb.rpc(rpc,args);if(!agentBoardSessionCurrent(owner,epoch))return false;if(result.error){toast(result.error.message);renderAgentBoard();return false}toast(success);renderAgentBoard();return true}
async function agentBoardApprove(id){
  const request=agentBoardState.queue.find(row=>row.id===id);if(!request){toast("Reload the queue before approving");return}
  let item=agentBoardReviewItem(request);if(!item){item=await agentBoardLoadReview(id,true);if(item)toast("Exact packet loaded. Inspect every field, then choose Approve displayed packet again.");return}
  if(!/^[0-9a-f]{64}$/i.test(item.review_hash)){toast("The review hash is invalid; reload before approving");return}
  if(!confirm(`Approve only the displayed packet with SHA-256 ${item.review_hash.slice(0,16)}…? It remains dormant until you run this exact card.`))return;
  const approved=await agentBoardDecision("approve_agent_board_request",{p_request_id:id,p_review_hash:item.review_hash,p_notes:"Approved in owner agent board"},"approve this exact agent-board review packet","Exact packet approved; it remains dormant");
  if(!approved)agentBoardDropReviewCache(id);
  return approved;
}
async function agentBoardReject(id){const reason=prompt("Why are you rejecting this request?","");if(reason===null)return;return agentBoardDecision("reject_agent_board_request",{p_request_id:id,p_reason:reason.slice(0,4000),p_notes:"Rejected in owner agent board"},"reject this agent-board request","Request rejected")}
async function agentBoardCancel(id){if(!confirm("Cancel this request before execution?"))return;return agentBoardDecision("cancel_agent_board_request",{p_request_id:id,p_notes:"Cancelled in owner agent board"},"cancel this agent-board request","Request cancelled")}
async function agentBoardDelete(id){const request=agentBoardState.queue.find(row=>row.id===id);if(!request){toast("Reload the queue before deleting");return}const phrase="DELETE "+id.slice(0,8),answer=prompt(`Permanently delete ${request.target_persona_name||"this persona"} · ${request.task_type} · ${request.status} · ${agentBoardDate(request.created_at)} and its retained board history? Type ${phrase} to confirm.`,"");if(answer!==phrase){if(answer!==null)toast("Deletion cancelled; confirmation text did not match");return}return agentBoardDecision("delete_terminal_agent_board_request",{p_request_id:id},"delete this retained agent-board item","Terminal request deleted")}
function agentBoardUuid(){if(typeof crypto.randomUUID==="function")return crypto.randomUUID();const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;const hex=[...bytes].map(value=>value.toString(16).padStart(2,"0")).join("");return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`}
function agentBoardRunStorageKey(owner,requestId,approvalHash){return `${AGENT_BOARD_RUN_STORAGE_PREFIX}${owner}.${requestId}.${approvalHash}`}
function agentBoardIdempotencyKey(owner,requestId,approvalHash){const storageKey=agentBoardRunStorageKey(owner,requestId,approvalHash);try{const stored=localStorage.getItem(storageKey);if(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored||""))return stored;const fresh=agentBoardUuid();localStorage.setItem(storageKey,fresh);return fresh}catch{return agentBoardUuid()}}
function agentBoardClearIdempotencyKey(owner,requestId,approvalHash){try{localStorage.removeItem(agentBoardRunStorageKey(owner,requestId,approvalHash))}catch{}}
async function agentBoardRun(requestId,approvalHash){
  const request=agentBoardState.queue.find(row=>row.id===requestId);
  if(!request||request.status!=="approved"||request.approved_review_hash!==approvalHash||!/^[0-9a-f]{64}$/i.test(approvalHash)||!request.approved_review_payload){toast("This approval packet is incomplete or changed. Reload and inspect it before running.");return}
  if(agentBoardState.runInFlight)return;
  const backend=agentBoardBackend(request.target_backend_id),summary=`${request.target_persona_name} · ${request.task_type} · ${backend?.name||"reviewed model"} · ${approvalHash.slice(0,16)}…`;
  if(!confirm(`Run only this approved packet now?\n\n${summary}\n\nThe result returns as an unpublished draft.`))return;
  agentBoardState.runInFlight=requestId;agentBoardPaint("agentBoardRequest_"+requestId);
  try{
    if(!await requireAal2ForSensitiveAction("run this exact approved agent-board request"))return;
    const owner=session?.user?.id,epoch=renderEpoch,{data:{session:active}}=await sb.auth.getSession();
    if(!owner||!active||active.user.id!==owner){toast("Your signed-in account changed; nothing was run");return}
    const idempotencyKey=agentBoardIdempotencyKey(owner,requestId,approvalHash);
    const response=await fetch(CONFIG.SUPABASE_URL.replace(/\/$/,"")+"/functions/v1/agent-board-run",{method:"POST",headers:{"Content-Type":"application/json","Authorization":"Bearer "+active.access_token},body:JSON.stringify({requestId,approvalHash,idempotencyKey})}),body=await response.json().catch(()=>({}));
    if(!agentBoardSessionCurrent(owner,epoch))return;
    if(body.pre_provider===true)agentBoardClearIdempotencyKey(owner,requestId,approvalHash);
    if(!response.ok){toast(body.pre_provider?"No provider call occurred; the approval remains available. "+(body.error||""):body.error||"The exact approved request failed");return}
    toast(body.idempotent_replay?"The prior run result was reloaded safely":body.executed?"Exact approved request finished; review its unpublished draft":"The exact run state was returned");
  }catch{toast("The run result is uncertain. Reload and use the same card; its saved idempotency key prevents an accidental second provider call.")}
  finally{agentBoardState.runInFlight="";renderAgentBoard()}
}
async function agentBoardReconcile(){
  if(agentBoardState.reconcileInFlight)return;agentBoardState.reconcileInFlight=true;agentBoardPaint("agentBoardStatus");
  try{if(!await requireAal2ForSensitiveAction("reconcile expired agent-board claims"))return;const owner=session?.user?.id,epoch=renderEpoch,result=await sb.rpc("reconcile_my_expired_agent_board_runs");if(!agentBoardSessionCurrent(owner,epoch))return;if(result.error){toast(result.error.message);return}const row=(Array.isArray(result.data)?result.data[0]:result.data)||{};toast(`${agentBoardFormatNumber(row.restored_approved)} safe pre-provider claims restored; ${agentBoardFormatNumber(row.quarantined_failed)} ambiguous claims quarantined for review`)}finally{agentBoardState.reconcileInFlight=false;renderAgentBoard()}
}
async function agentBoardUnlockBudgets(){if(!await requireAal2ForSensitiveAction("view AI budget usage and controls"))return;const owner=session?.user?.id,epoch=renderEpoch,result=await sb.rpc("my_ai_backend_budget_policies");if(!agentBoardSessionCurrent(owner,epoch))return;if(result.error){toast(agentBoardSetupMessage(result.error.message));return}agentBoardState.budgets=result.data||[];agentBoardState.budgetsUnlocked=true;agentBoardState.selectedBudgetBackendId=agentBoardState.selectedBudgetBackendId||myBackends[0]?.id||"";agentBoardPaint()}
function agentBoardBudgetSelectionChanged(){agentBoardState.selectedBudgetBackendId=document.getElementById("agentBudgetBackend")?.value||"";agentBoardState.selectedBudgetMode=document.getElementById("agentBudgetMode")?.value||"agent_board";agentBoardPaint()}
async function agentBoardSaveBudget(){
  const backendId=document.getElementById("agentBudgetBackend")?.value,mode=document.getElementById("agentBudgetMode")?.value||"agent_board",enabled=!!document.getElementById("agentBudgetEnabled")?.checked,values={dailyRequests:Number(document.getElementById("agentBudgetDailyRequests")?.value),monthlyRequests:Number(document.getElementById("agentBudgetMonthlyRequests")?.value),dailyTokens:Number(document.getElementById("agentBudgetDailyTokens")?.value),monthlyTokens:Number(document.getElementById("agentBudgetMonthlyTokens")?.value),concurrency:Number(document.getElementById("agentBudgetConcurrency")?.value),ttl:Number(document.getElementById("agentBudgetTtl")?.value)};
  if(!backendId||!Object.values(values).every(Number.isSafeInteger)){toast("Complete every budget field with whole numbers");return}if(values.dailyRequests<0||values.dailyRequests>1000000||values.monthlyRequests<values.dailyRequests||values.monthlyRequests>30000000||values.dailyTokens<0||values.dailyTokens>1000000000000||values.monthlyTokens<values.dailyTokens||values.monthlyTokens>30000000000000||values.concurrency<1||values.concurrency>100||values.ttl<60||values.ttl>3600){toast("Budget values are outside the allowed bounds");return}if(enabled&&(!values.dailyRequests||!values.dailyTokens)){toast("Enabled policies require positive daily request and token ceilings");return}if(enabled&&!confirm("Enable this exact model and mode within the displayed hard ceilings? Provider billing and trial limits must still be verified separately."))return;if(!await requireAal2ForSensitiveAction("save an AI budget policy"))return;
  const owner=session?.user?.id,epoch=renderEpoch,result=await sb.rpc("save_ai_backend_budget_policy",{p_backend_id:backendId,p_mode:mode,p_enabled:enabled,p_daily_request_limit:values.dailyRequests,p_monthly_request_limit:values.monthlyRequests,p_daily_token_limit:values.dailyTokens,p_monthly_token_limit:values.monthlyTokens,p_max_concurrent_leases:values.concurrency,p_lease_ttl_seconds:values.ttl});if(!agentBoardSessionCurrent(owner,epoch))return;if(result.error){toast(result.error.message);return}toast(enabled?"Hard AI budget enabled":"AI budget policy saved disabled");agentBoardUnlockBudgets();
}
async function agentBoardCopy(text){
  const value=String(text||"");try{await navigator.clipboard.writeText(value);toast("Review packet copied")}
  catch{const area=document.createElement("textarea");area.value=value;area.setAttribute("readonly","");area.style.position="fixed";area.style.opacity="0";document.body.appendChild(area);area.select();const copied=document.execCommand("copy");area.remove();toast(copied?"Review packet copied":"Copy was blocked; select the text manually")}
}
async function agentBoardCopyRequest(id){
  const request=agentBoardState.queue.find(row=>row.id===id);if(!request){toast("Reload the queue before copying");return}
  const item=agentBoardReviewItem(request)||await agentBoardLoadReview(id,false);if(!item)return;
  const run=agentBoardLatestRun(id),packet=`MYPERSONAS EXACT AGENT-BOARD REVIEW PACKET\nReview state: ${item.approved?"approved immutable snapshot":"current pre-approval snapshot"}\nSHA-256: ${item.review_hash}\n\n${agentBoardJson(item.review_payload)}${run?.result_text?"\n\nUNPUBLISHED DRAFT RESULT\n"+run.result_text:""}${run?.error?"\n\nRUN ERROR\n"+run.error:""}`;
  return agentBoardCopy(packet)
}
