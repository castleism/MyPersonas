import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root=path.resolve(import.meta.dirname,"..");
const[html,source,css,governance,pagesWorkflow,billingMigration]=await Promise.all([
  readFile(path.join(root,"MyPersonas.Online_v0/index.html"),"utf8"),
  readFile(path.join(root,"MyPersonas.Online_v0/billing.js"),"utf8"),
  readFile(path.join(root,"MyPersonas.Online_v0/billing.css"),"utf8"),
  readFile(path.join(root,"MyPersonas.Online_v0/platform-governance.js"),"utf8"),
  readFile(path.join(root,".github/workflows/pages.yml"),"utf8"),
  readFile(path.join(root,"supabase/migrations/20260823100000_account_subscription_entitlements.sql"),"utf8"),
]);

function deferred(){let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve}}

function billingContext(options={}){
  const assigned=[],replaced=[],rpcCalls=[],functionCalls=[],toasts=[];
  const pageLocation={href:options.href||"https://mypersonas.online/#/studio",assign(url){assigned.push(url)}};
  const history={state:null,replaceState(_state,_title,url){replaced.push(url);pageLocation.href=new URL(url,pageLocation.href).href}};
  const elements=options.elements||new Map();
  const context=vm.createContext({
    console,URL,Intl,Date,history,location:pageLocation,window:{location:pageLocation},
    document:{getElementById:id=>elements.get(id)||null},
    session:{user:{id:"00000000-0000-4000-8000-0000000000aa"}},authLoadGeneration:4,
    toast:message=>toasts.push(message),confirm:options.confirm||(()=>true),requireAal2ForSensitiveAction:async()=>true,
    sb:{
      rpc(name,args){rpcCalls.push({name,args});return options.rpc?options.rpc(name,args):Promise.resolve({data:null,error:null})},
      functions:{invoke(name,args){functionCalls.push({name,args});return options.invoke?options.invoke(name,args):Promise.resolve({data:null,error:null})}},
    },
  });
  vm.runInContext(source,context,{filename:"billing.js"});
  return{context,assigned,replaced,rpcCalls,functionCalls,toasts,elements};
}

function jsonRealm(value){return JSON.parse(JSON.stringify(value))}

test("membership assets, account tab, return handling, and Pages artifact are wired",()=>{
  assert.match(html,/billing\.css\?v=20260823-2/);
  assert.match(html,/billing\.js\?v=20260823-2/);
  assert.match(html,/\["billing","Membership"\]/);
  assert.match(html,/id="billingAccountRoot"/);
  assert.match(html,/billingResetOwnerState\(\)/);
  assert.match(html,/billingShouldOpenFromReturn\(\)/);
  assert.match(html,/billingEnsureLoaded\(\)/);
  assert.match(html,/id="acctTabs" role="tablist" aria-label="Account settings"/);
  assert.match(html,/id="acctTab-\$\{k\}" role="tab" aria-selected=/);
  assert.match(html,/id="acctPanel-billing" role="tabpanel" aria-labelledby="acctTab-billing"/);
  assert.match(html,/function accountTabKeydown\(event\)/);
  assert.match(css,/#acctTabs \.tab\{min-height:44px\}/);
  assert.match(pagesWorkflow,/--include '\/billing\.css'/);
  assert.match(pagesWorkflow,/--include '\/billing\.js'/);
  assert.match(pagesWorkflow,/OPAQUE-FOUNDATION-VERIFIED\+BILLING-068-SHADOW-VERIFIED/);
});

test("plan copy is exact, equal-access, and explains fail-closed consequences",()=>{
  for(const copy of[
    "7 days free, then $20 every 7 days",
    "7 days free, then $50 monthly",
    "7 days free, then $333 yearly",
  ])assert.ok(source.includes(copy));
  assert.match(source,/Same feature access as every other paid plan/);
  assert.match(source,/one 7-day free trial/);
  assert.match(source,/No repeat free trial/);
  assert.match(source,/Search for other personas inside the signed-in app is disabled/);
  assert.match(source,/persona pages become effectively unpublished/i);
  assert.match(source,/AI automation, including research briefs, is halted/);
  assert.match(source,/missed or queued work does not automatically catch up/);
  assert.match(source,/verified server-side membership or developer entitlement update/);
  assert.match(source,/Two-factor verification is required before Checkout or billing management opens/);
  assert.match(source,/Choose \$\{plan\.name\} plan/);
  assert.match(source,/aria-labelledby="\$\{headingId\}"/);
  assert.match(source,/Stripe Checkout makes the final eligibility determination/);
});

test("Checkout return is only pending evidence and sensitive query values are stripped",()=>{
  const{context,replaced}=billingContext({href:"https://mypersonas.online/?billing=success&session_id=cs_secret_123#/studio"});
  assert.equal(vm.runInContext("billingState.returnState",context),"success");
  assert.equal(replaced.length,1);
  assert.doesNotMatch(replaced[0],/billing=|session_id|cs_secret/);
  const rendered=vm.runInContext("billingAccountPanelHtml()",context);
  assert.match(rendered,/still pending until a verified Stripe webhook/);
  assert.match(rendered,/does not treat a Checkout return as proof of payment/);
  assert.doesNotMatch(rendered,/payment (?:was )?successful|membership (?:is )?paid/i);
  vm.runInContext(`billingState.loaded=true;billingState.status=billingNormalizeStatus({enforcement_enabled:true,checkout_enabled:true,state:"paid_active",source:"subscription",access_allowed:true,trial_eligible:false})`,context);
  const verified=vm.runInContext("billingReturnHtml()",context);
  assert.match(verified,/independently verified by the server/);
  assert.match(verified,/redirect itself was not treated as proof of payment/);
  assert.equal(vm.runInContext("billingShouldOpenFromReturn()",context),true);
  vm.runInContext("billingResetOwnerState()",context);
  assert.equal(vm.runInContext("billingState.returnState",context),"");
});

test("status must be server verified before Checkout and redirects stay on exact Stripe hosts",async()=>{
  const status={enforcement_enabled:true,checkout_enabled:true,state:"inactive",source:"none",access_allowed:false,trial_eligible:true,updated_at:"2026-08-23T12:00:00Z"};
  const aal2=[];
  const{context,rpcCalls,functionCalls,assigned}=billingContext({
    rpc:name=>name==="my_billing_status"?Promise.resolve({data:[status],error:null}):Promise.reject(new Error("unexpected RPC")),
    invoke(name,args){
      if(name==="billing-create-checkout")return Promise.resolve({data:{url:"https://checkout.stripe.com/c/pay/cs_test_safe"},error:null});
      if(name==="billing-create-portal")return Promise.resolve({data:{url:"https://billing.stripe.com/p/session/bps_safe"},error:null});
      return Promise.reject(new Error("unexpected function"));
    },
  });
  context.requireAal2ForSensitiveAction=async action=>{aal2.push(action);return true};

  await vm.runInContext("billingStartCheckout('account_weekly')",context);
  assert.equal(functionCalls.length,0,"unverified status must not start Checkout");
  await vm.runInContext("billingEnsureLoaded()",context);
  assert.deepEqual(rpcCalls.map(call=>call.name),["my_billing_status"]);

  await vm.runInContext("billingStartCheckout('account_monthly')",context);
  assert.match(aal2[0],/recurring membership/);
  assert.deepEqual(jsonRealm(functionCalls[0]),{name:"billing-create-checkout",args:{body:{planCode:"account_monthly"}}});
  assert.equal(assigned[0],"https://checkout.stripe.com/c/pay/cs_test_safe");
  assert.equal("amount" in functionCalls[0].args.body,false);
  assert.equal("customer" in functionCalls[0].args.body,false);
  assert.equal("returnUrl" in functionCalls[0].args.body,false);

  await vm.runInContext("billingOpenPortal()",context);
  assert.match(aal2[1],/payment methods.*cancellation/);
  assert.deepEqual(jsonRealm(functionCalls[1]),{name:"billing-create-portal",args:{body:{}}});
  assert.equal(assigned[1],"https://billing.stripe.com/p/session/bps_safe");
});

test("Checkout and billing management fail closed when AAL2 step-up is declined",async()=>{
  const status={enforcement_enabled:true,checkout_enabled:true,state:"inactive",source:"none",access_allowed:false,trial_eligible:true};
  const{context,functionCalls}=billingContext({
    rpc:()=>Promise.resolve({data:status,error:null}),
    invoke:()=>Promise.reject(new Error("financial function must not run")),
  });
  context.requireAal2ForSensitiveAction=async()=>false;
  await vm.runInContext("billingEnsureLoaded()",context);
  await vm.runInContext("billingStartCheckout('account_weekly')",context);
  await vm.runInContext("billingOpenPortal()",context);
  assert.equal(functionCalls.length,0);
  assert.match(vm.runInContext("billingState.error",context),/Two-factor verification is required/);
});

test("server-disabled Checkout cannot invoke the payment function even when enforcement is enabled",async()=>{
  const status={
    enforcement_enabled:true,
    checkout_enabled:false,
    state:"subscription_required",
    source:"none",
    access_allowed:false,
    trial_eligible:null,
  };
  const{context,functionCalls}=billingContext({
    rpc:()=>Promise.resolve({data:status,error:null}),
    invoke:()=>Promise.reject(new Error("Checkout must remain unreachable")),
  });

  await vm.runInContext("billingEnsureLoaded()",context);
  assert.equal(vm.runInContext("billingState.status.checkoutEnabled",context),false);
  await vm.runInContext("billingStartCheckout('account_weekly')",context);
  assert.equal(functionCalls.length,0);
  assert.match(vm.runInContext("billingState.error",context),/Refresh the server-verified membership status/);
});

test("missing or non-boolean checkout_enabled makes the billing status unverifiable",async()=>{
  for(const checkoutEnabled of[undefined,"true",1,null]){
    const status={
      enforcement_enabled:true,
      state:"subscription_required",
      source:"none",
      access_allowed:false,
      ...(checkoutEnabled===undefined?{}:{checkout_enabled:checkoutEnabled}),
    };
    const{context,functionCalls}=billingContext({
      rpc:()=>Promise.resolve({data:status,error:null}),
      invoke:()=>Promise.reject(new Error("invalid status must not reach Checkout")),
    });
    await vm.runInContext("billingEnsureLoaded()",context);
    assert.equal(vm.runInContext("billingState.loaded",context),false);
    assert.equal(vm.runInContext("billingState.status",context),null);
    await vm.runInContext("billingStartCheckout('account_monthly')",context);
    assert.equal(functionCalls.length,0);
  }
});

test("unknown plans and non-Stripe redirect hosts are rejected without navigation",async()=>{
  const status={enforcement_enabled:true,checkout_enabled:true,state:"inactive",source:"none",access_allowed:false,trial_eligible:false};
  const{context,functionCalls,assigned}=billingContext({
    rpc:()=>Promise.resolve({data:status,error:null}),
    invoke:()=>Promise.resolve({data:{url:"https://checkout.stripe.com.attacker.example/cs_secret"},error:null}),
  });
  await vm.runInContext("billingEnsureLoaded()",context);
  await vm.runInContext("billingStartCheckout('price_123')",context);
  assert.equal(functionCalls.length,0);
  await vm.runInContext("billingStartCheckout('account_yearly')",context);
  assert.equal(functionCalls.length,1);
  assert.deepEqual(assigned,[]);
  assert.match(vm.runInContext("billingState.error",context),/invalid destination/i);
});

test("trial-ineligible and unknown accounts are never promised free days",async()=>{
  const status={enforcement_enabled:true,checkout_enabled:true,state:"subscription_required",source:"none",access_allowed:false,trial_eligible:false};
  const{context}=billingContext({rpc:()=>Promise.resolve({data:status,error:null})});
  const unknown=vm.runInContext("billingPlanCardsHtml(null)",context);
  assert.match(unknown,/Trial eligibility will be verified/);
  assert.doesNotMatch(unknown,/7 days free/);
  await vm.runInContext("billingEnsureLoaded()",context);
  const ineligible=vm.runInContext("billingPlanCardsHtml(billingState.status)",context);
  for(const copy of["$20 charged now, then $20 every 7 days","$50 charged now, then $50 monthly","$333 charged now, then $333 yearly"])assert.ok(ineligible.includes(copy));
  assert.doesNotMatch(ineligible,/7 days free/);
  assert.match(ineligible,/Stripe shows the first charge and renewal interval before you confirm/);
});

test("Checkout and portal navigation are mutually exclusive",async()=>{
  const checkout=deferred(),status={enforcement_enabled:true,checkout_enabled:true,state:"subscription_required",source:"none",access_allowed:false,trial_eligible:null};
  const{context,functionCalls}=billingContext({
    rpc:()=>Promise.resolve({data:status,error:null}),
    invoke:name=>name==="billing-create-checkout"?checkout.promise:Promise.resolve({data:{url:"https://billing.stripe.com/p/session/safe"},error:null}),
  });
  await vm.runInContext("billingEnsureLoaded()",context);
  vm.runInContext("globalThis.pendingCheckout=billingStartCheckout('account_weekly')",context);
  await vm.runInContext("billingStartCheckout('account_monthly')",context);
  await vm.runInContext("billingOpenPortal()",context);
  assert.deepEqual(functionCalls.map(call=>call.name),["billing-create-checkout"]);
  checkout.resolve({data:{url:"https://checkout.stripe.com/c/pay/safe"},error:null});
  await context.pendingCheckout;
});

test("an old account status response cannot overwrite the next signed-in account",async()=>{
  const first=deferred(),second=deferred(),ownerB="00000000-0000-4000-8000-0000000000bb";
  let count=0;
  const{context}=billingContext({rpc:()=>++count===1?first.promise:second.promise});
  vm.runInContext("globalThis.firstLoad=billingEnsureLoaded()",context);
  vm.runInContext(`session={user:{id:"${ownerB}"}};authLoadGeneration++;billingResetOwnerState();globalThis.secondLoad=billingEnsureLoaded()`,context);
  first.resolve({data:{enforcement_enabled:true,checkout_enabled:true,state:"active",source:"stripe",access_allowed:true,trial_eligible:false},error:null});
  await context.firstLoad;
  assert.equal(vm.runInContext("billingState.status",context),null);
  second.resolve({data:{enforcement_enabled:true,checkout_enabled:true,state:"inactive",source:"none",access_allowed:false,trial_eligible:false},error:null});
  await context.secondLoad;
  assert.equal(vm.runInContext("billingState.ownerId",context),ownerB);
  assert.equal(vm.runInContext("billingState.status.state",context),"inactive");
  assert.equal(vm.runInContext("billingState.status.accessAllowed",context),false);
});

test("admin lookup and developer changes use narrow RPCs, AAL2, reasons, and safe summaries",async()=>{
  const accountId="11111111-1111-4111-8111-111111111111",elements=new Map([
    ["billingAdminQuery",{value:"Owner@Example.com"}],
    ["billingAdminReason",{value:"Approved internal development and testing."}],
    ["billingAdminExpiry",{value:""}],
    ["billingAdminDispositionAck",{checked:true}],
  ]),aal2=[];
  const summary={account_id:accountId,display_name:"Safe Developer",masked_email:"o***@example.com",state:"inactive",source:"none",access_allowed:false,stripe_customer_id:"cus_must_never_render"};
  const{context,rpcCalls}=billingContext({elements,rpc(name){
    if(name==="billing_admin_lookup_account")return Promise.resolve({data:[summary],error:null});
    if(name==="billing_admin_financial_holds")return Promise.resolve({data:[],error:null});
    if(name==="billing_admin_grant_developer")return Promise.resolve({data:{...summary,state:"developer",source:"developer",access_allowed:true},error:null});
    if(name==="billing_admin_revoke_developer")return Promise.resolve({data:summary,error:null});
    throw new Error(`unexpected RPC ${name}`);
  }});
  context.requireAal2ForSensitiveAction=async action=>{aal2.push(action);return true};

  await vm.runInContext("billingAdminLookup()",context);
  assert.deepEqual(jsonRealm(rpcCalls[0]),{name:"billing_admin_lookup_account",args:{p_query:"owner@example.com"}});
  assert.deepEqual(jsonRealm(rpcCalls[1]),{name:"billing_admin_financial_holds",args:{p_account_id:accountId,p_limit:25}});
  let rendered=vm.runInContext("billingAdminPanelHtml()",context);
  assert.match(rendered,/o\*\*\*@example\.com/);
  assert.doesNotMatch(rendered,/cus_must_never_render/);
  assert.match(rendered,/Paid subscription disposition is a separate decision/);

  await vm.runInContext("billingAdminGrantDeveloper()",context);
  assert.deepEqual(jsonRealm(rpcCalls[2]),{name:"billing_admin_grant_developer",args:{p_account_id:accountId,p_reason:"Approved internal development and testing.",p_expires_at:null}});
  assert.match(aal2[0],/grant free developer access/);
  assert.equal(vm.runInContext("billingState.admin.result.accessAllowed",context),true);

  await vm.runInContext("billingAdminRevokeDeveloper()",context);
  assert.deepEqual(jsonRealm(rpcCalls[3]),{name:"billing_admin_revoke_developer",args:{p_account_id:accountId,p_reason:"Approved internal development and testing."}});
  assert.match(aal2[1],/revoke developer access/);
  assert.equal(vm.runInContext("billingState.admin.result.accessAllowed",context),false);
});

test("global-admin refund reviews use bounded safe summaries and the AAL2 Edge execution boundary",async()=>{
  const reviewId="77777777-7777-4777-8777-777777777777",reason="Canonical provider evidence confirms this accidental duplicate should return to the original payment method.",elements=new Map(),aal2=[],confirmations=[];
  const review={remediation_id:reviewId,masked_email:"o***@example.com",state:"provider_canceled",amount_minor:2000,currency:"usd",refund_status:null,approved_at:null,created_at:"2026-08-23T10:00:00Z",updated_at:"2026-08-23T10:05:00Z",stripe_customer_id:"cus_must_never_render",stripe_subscription_id:"sub_must_never_render",stripe_invoice_id:"in_must_never_render",stripe_charge_id:"ch_must_never_render",stripe_refund_id:"re_must_never_render",raw_payload:"card data must never render"};
  let reviewLoads=0;
  const{context,rpcCalls,functionCalls}=billingContext({href:"https://mypersonas.online/#/platform-queue",elements,confirm:message=>{confirmations.push(message);return true},rpc(name,args){
    if(name==="billing_admin_duplicate_refund_reviews")return Promise.resolve({data:reviewLoads++?[ ]:[review],error:null});
    throw new Error(`unexpected RPC ${name}`);
  },invoke(name,args){
    if(name==="billing-admin-refund-duplicate")return Promise.resolve({data:{state:"refunded",amount:2000,currency:"usd",provider_id:"re_must_never_render"},error:null});
    throw new Error(`unexpected function ${name}`);
  }});
  context.requireAal2ForSensitiveAction=async action=>{aal2.push(action);return true};

  await vm.runInContext("billingAdminLoadRefundReviews()",context);
  assert.deepEqual(jsonRealm(rpcCalls),[{name:"billing_admin_duplicate_refund_reviews",args:{p_limit:100}}]);
  let rendered=vm.runInContext("billingAdminPanelHtml()",context);
  for(const visible of[reviewId,"o***@example.com","20.00 USD","Provider Canceled","Created","Updated"])assert.match(rendered,new RegExp(visible.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),"i"));
  for(const secret of["cus_must_never_render","sub_must_never_render","in_must_never_render","ch_must_never_render","re_must_never_render","card data must never render"])assert.doesNotMatch(rendered,new RegExp(secret));
  const retained=vm.runInContext("JSON.stringify(billingState.admin.refunds)",context);
  for(const secret of["cus_must_never_render","sub_must_never_render","in_must_never_render","ch_must_never_render","re_must_never_render","card data must never render"])assert.doesNotMatch(retained,new RegExp(secret));

  elements.set("billingRefundConfirmation_0",{value:"20 USD"});
  elements.set("billingRefundReason_0",{value:reason});
  elements.set("billingRefundAck_0",{checked:true});
  await vm.runInContext("billingAdminApproveRefund(0)",context);
  assert.equal(functionCalls.length,0);
  assert.equal(aal2.length,1);
  assert.match(vm.runInContext("billingState.admin.refundsError",context),/Type the exact amount and currency 20\.00 USD/);
  elements.get("billingRefundConfirmation_0").value="20.00 USD";
  await vm.runInContext("billingAdminApproveRefund(0)",context);
  assert.match(aal2[0],/view duplicate-subscription refund reviews/);
  assert.match(aal2[1],/approve and execute this exact duplicate-subscription refund/);
  assert.equal(confirmations.length,1);
  assert.match(confirmations[0],/20\.00 USD/);
  assert.match(confirmations[0],new RegExp(reviewId));
  assert.deepEqual(jsonRealm(functionCalls),[{name:"billing-admin-refund-duplicate",args:{body:{remediationId:reviewId,reason}}}]);
  assert.deepEqual(rpcCalls.map(call=>call.name),["billing_admin_duplicate_refund_reviews","billing_admin_duplicate_refund_reviews"]);
  assert.match(vm.runInContext("billingState.admin.refundMessage",context),/independently confirmed refunded/);
  assert.equal(vm.runInContext("billingState.admin.refunds.length",context),0);
});

test("refund listing and approval fail closed at AAL1 before RPC or Edge execution",async()=>{
  const reviewId="77777777-7777-4777-8777-777777777777",elements=new Map([
    ["billingRefundConfirmation_0",{value:"20.00 USD"}],
    ["billingRefundReason_0",{value:"A sufficiently specific duplicate refund review reason."}],
    ["billingRefundAck_0",{checked:true}],
  ]),{context,rpcCalls,functionCalls}=billingContext({href:"https://mypersonas.online/#/platform-queue",elements,rpc:()=>Promise.reject(new Error("AAL1 must not read")),invoke:()=>Promise.reject(new Error("AAL1 must not execute"))});
  context.requireAal2ForSensitiveAction=async()=>false;
  await vm.runInContext("billingAdminLoadRefundReviews()",context);
  assert.deepEqual(rpcCalls,[]);
  assert.match(vm.runInContext("billingState.admin.refundsError",context),/Two-factor verification is required/);
  vm.runInContext(`billingState.admin.refunds=billingNormalizeRefundReviews([{remediation_id:"${reviewId}",masked_email:"o***@example.com",state:"provider_canceled",amount_minor:2000,currency:"usd",created_at:"2026-08-23T10:00:00Z",updated_at:"2026-08-23T10:05:00Z"}]);billingState.admin.refundsLoaded=true;billingState.admin.refundsError=""`,context);
  await vm.runInContext("billingAdminApproveRefund(0)",context);
  assert.deepEqual(functionCalls,[]);
  assert.match(vm.runInContext("billingState.admin.refundsError",context),/Two-factor verification is required/);
});

test("stale account or route responses cannot populate or complete refund review state",async()=>{
  const pending=deferred(),elements=new Map(),{context,rpcCalls}=billingContext({href:"https://mypersonas.online/#/platform-queue",elements,rpc:name=>name==="billing_admin_duplicate_refund_reviews"?pending.promise:Promise.reject(new Error("unexpected RPC"))});
  vm.runInContext("globalThis.refundLoad=billingAdminLoadRefundReviews()",context);
  for(let index=0;index<4&&!rpcCalls.length;index++)await Promise.resolve();
  assert.equal(rpcCalls.length,1);
  vm.runInContext('session={user:{id:"00000000-0000-4000-8000-0000000000bb"}};authLoadGeneration++;billingResetOwnerState();window.location.href="https://mypersonas.online/#/studio"',context);
  pending.resolve({data:[{remediation_id:"77777777-7777-4777-8777-777777777777",masked_email:"o***@example.com",state:"provider_canceled",amount_minor:2000,currency:"usd",created_at:"2026-08-23T10:00:00Z",updated_at:"2026-08-23T10:05:00Z"}],error:null});
  await context.refundLoad;
  assert.equal(vm.runInContext("billingState.admin.refunds.length",context),0);
  assert.equal(vm.runInContext("billingState.admin.refundsLoaded",context),false);
});

test("route-only refund list and Edge responses clear transient busy state and permit a safe retry",async()=>{
  const reviewId="77777777-7777-4777-8777-777777777777",reason="Canonical evidence supports the exact original-method duplicate refund.",listPending=deferred(),edgePending=deferred(),elements=new Map([
    ["billingRefundConfirmation_0",{value:"20.00 USD"}],
    ["billingRefundReason_0",{value:reason}],
    ["billingRefundAck_0",{checked:true}],
  ]);
  let listCalls=0,edgeCalls=0;
  const{context,rpcCalls,functionCalls}=billingContext({href:"https://mypersonas.online/#/platform-queue",elements,rpc(name){
    if(name!=="billing_admin_duplicate_refund_reviews")throw new Error(`unexpected RPC ${name}`);
    listCalls++;return listCalls===1?listPending.promise:Promise.resolve({data:[],error:null});
  },invoke(name){
    if(name!=="billing-admin-refund-duplicate")throw new Error(`unexpected function ${name}`);
    edgeCalls++;return edgeCalls===1?edgePending.promise:Promise.resolve({data:{state:"provider_pending",amount:2000,currency:"usd"},error:null});
  }});

  vm.runInContext("globalThis.routeList=billingAdminLoadRefundReviews()",context);
  for(let index=0;index<4&&!rpcCalls.length;index++)await Promise.resolve();
  vm.runInContext('window.location.href="https://mypersonas.online/#/studio"',context);
  listPending.resolve({data:[],error:null});await context.routeList;
  assert.equal(vm.runInContext("billingState.admin.refundsLoading",context),false);
  vm.runInContext('window.location.href="https://mypersonas.online/#/platform-queue"',context);
  await vm.runInContext("billingAdminLoadRefundReviews()",context);
  assert.equal(rpcCalls.length,2);

  vm.runInContext(`billingState.admin.refunds=billingNormalizeRefundReviews([{remediation_id:"${reviewId}",masked_email:"o***@example.com",state:"refund_pending",amount_minor:2000,currency:"usd",created_at:"2026-08-23T10:00:00Z",updated_at:"2026-08-23T10:05:00Z"}]);billingState.admin.refundsLoaded=true`,context);
  vm.runInContext("globalThis.routeAction=billingAdminApproveRefund(0)",context);
  for(let index=0;index<4&&!functionCalls.length;index++)await Promise.resolve();
  vm.runInContext('window.location.href="https://mypersonas.online/#/studio"',context);
  edgePending.resolve({data:{state:"provider_pending",amount:2000,currency:"usd"},error:null});await context.routeAction;
  assert.equal(vm.runInContext("billingState.admin.refundActionBusy",context),"");
  assert.equal(vm.runInContext("billingState.admin.refundMessage",context),"");
  vm.runInContext('window.location.href="https://mypersonas.online/#/platform-queue"',context);
  await vm.runInContext("billingAdminApproveRefund(0)",context);
  assert.equal(functionCalls.length,2);
  assert.match(vm.runInContext("billingState.admin.refundMessage",context),/pending at the provider/);
});

test("admin repaint restores focus to the exact refund control after validation",()=>{
  const focused=[],active={id:"billingRefundAction_0"},target={focus:options=>focused.push(options)},rootElement={contains:value=>value===active,outerHTML:""};
  const{context}=billingContext({href:"https://mypersonas.online/#/platform-queue"});
  context.document={activeElement:active,getElementById:id=>id==="billingAdminRoot"?rootElement:id==="billingRefundConfirmation_0"?target:null};
  vm.runInContext('billingPaintAdmin("billingRefundConfirmation_0")',context);
  assert.equal(focused.length,1);
  assert.equal(focused[0].preventScroll,true);
  assert.match(rootElement.outerHTML,/id="billingAdminRefundReviews" tabindex="-1"/);
});

test("financial holds load only after exact account lookup and reconcile by internal hold UUID with AAL2, reason, confirmation, and refresh",async()=>{
  assert.match(billingMigration,/returns table\(\s*hold_id uuid,account_id uuid,masked_email text,event_category text,/);
  assert.match(source,/raw\?\.event_category/);
  const accountId="11111111-1111-4111-8111-111111111111",holdId="22222222-2222-4222-8222-222222222222",reason="Provider dashboard evidence confirms the dispute is closed and the account entitlement can be recalculated.";
  const elements=new Map([
    ["billingAdminQuery",{value:"Owner@Example.com"}],
    ["billingHoldReason_0",{value:reason}],
  ]),aal2=[],confirmations=[];
  const summary={account_id:accountId,display_name:"Held account",masked_email:"o***@example.com",state:"financial_review_hold",source:"none",access_allowed:false};
  const hold={hold_id:holdId,account_id:accountId,masked_email:"o***@example.com",event_type:"charge.dispute.created",event_category:"dispute",opened_at:"2026-08-23T10:00:00Z",source_event_id:"evt_must_not_render",provider_object_id:"du_must_not_render",stripe_customer_id:"cus_must_not_render",stripe_subscription_id:"sub_must_not_render",stripe_invoice_id:"in_must_not_render",raw_payload:"card data must not render"};
  let lookupCount=0,holdCount=0;
  const{context,rpcCalls}=billingContext({elements,confirm:message=>{confirmations.push(message);return true},rpc(name){
    if(name==="billing_admin_lookup_account")return Promise.resolve({data:[lookupCount++?{...summary,state:"trial_active",source:"subscription",access_allowed:true}:summary],error:null});
    if(name==="billing_admin_financial_holds")return Promise.resolve({data:holdCount++?[]:[hold],error:null});
    if(name==="billing_admin_reconcile_financial_hold")return Promise.resolve({data:true,error:null});
    throw new Error(`unexpected RPC ${name}`);
  }});
  context.requireAal2ForSensitiveAction=async action=>{aal2.push(action);return true};

  await vm.runInContext("billingAdminLookup()",context);
  assert.deepEqual(jsonRealm(rpcCalls.slice(0,2)),[
    {name:"billing_admin_lookup_account",args:{p_query:"owner@example.com"}},
    {name:"billing_admin_financial_holds",args:{p_account_id:accountId,p_limit:25}},
  ]);
  const rendered=vm.runInContext("billingAdminPanelHtml()",context);
  assert.match(rendered,/Charge Dispute Created/);
  assert.match(rendered,/Required reconciliation reason/);
  assert.match(rendered,/Raw webhooks, card data, provider\/customer\/subscription\/invoice identifiers, and secrets are never rendered/);
  for(const secret of[holdId,"evt_must_not_render","du_must_not_render","cus_must_not_render","sub_must_not_render","in_must_not_render","card data must not render"])assert.doesNotMatch(rendered,new RegExp(secret));
  const retained=vm.runInContext("JSON.stringify(billingState.admin.holds)",context);
  for(const secret of["evt_must_not_render","du_must_not_render","cus_must_not_render","sub_must_not_render","in_must_not_render","card data must not render"])assert.doesNotMatch(retained,new RegExp(secret));

  await vm.runInContext("billingAdminReconcileFinancialHold(0)",context);
  assert.match(aal2[0],/exact financial hold.*external provider verification/);
  assert.equal(confirmations.length,1);
  assert.match(confirmations[0],/only after you verified the provider outcome outside MyPersonas/);
  assert.match(confirmations[0],/does not issue a refund, close a dispute, cancel a subscription, or prove provider resolution/);
  assert.deepEqual(jsonRealm(rpcCalls[2]),{name:"billing_admin_reconcile_financial_hold",args:{p_hold_id:holdId,p_reason:reason}});
  assert.deepEqual(rpcCalls.slice(3).map(call=>call.name),["billing_admin_lookup_account","billing_admin_financial_holds"]);
  assert.equal(vm.runInContext("billingState.admin.result.accessAllowed",context),true);
  assert.equal(vm.runInContext("billingState.admin.holds.length",context),0);
});

test("financial hold reconciliation rejects a weak reason before AAL2 or mutation",async()=>{
  const accountId="11111111-1111-4111-8111-111111111111",holdId="22222222-2222-4222-8222-222222222222",elements=new Map([
    ["billingAdminQuery",{value:"owner@example.com"}],
    ["billingHoldReason_0",{value:"too short"}],
  ]);
  let aal2Calls=0;
  const{context,rpcCalls}=billingContext({elements,rpc(name){
    if(name==="billing_admin_lookup_account")return Promise.resolve({data:{account_id:accountId,display_name:"Held",masked_email:"o***@example.com",state:"financial_review_hold",source:"none",access_allowed:false},error:null});
    if(name==="billing_admin_financial_holds")return Promise.resolve({data:[{hold_id:holdId,account_id:accountId,event_type:"refund.created",event_category:"refund",opened_at:"2026-08-23T10:00:00Z"}],error:null});
    throw new Error("mutation must not run");
  }});
  context.requireAal2ForSensitiveAction=async()=>{aal2Calls++;return true};
  await vm.runInContext("billingAdminLookup()",context);
  await vm.runInContext("billingAdminReconcileFinancialHold(0)",context);
  assert.equal(aal2Calls,0);
  assert.deepEqual(rpcCalls.map(call=>call.name),["billing_admin_lookup_account","billing_admin_financial_holds"]);
  assert.match(vm.runInContext("billingState.admin.error",context),/between 10 and 1000 characters/);
});

test("stale financial-hold responses cannot cross an exact-account selection",async()=>{
  const accountA="11111111-1111-4111-8111-111111111111",accountB="22222222-2222-4222-8222-222222222222",holdA="33333333-3333-4333-8333-333333333333",holdB="44444444-4444-4444-8444-444444444444",oldHolds=deferred(),query={value:"a@example.com"},elements=new Map([["billingAdminQuery",query]]);
  const summary=id=>({account_id:id,display_name:id===accountA?"Account A":"Account B",masked_email:"x***@example.com",state:"financial_review_hold",source:"none",access_allowed:false});
  const hold=(id,account,eventType)=>({hold_id:id,account_id:account,event_type:eventType,event_category:"dispute",opened_at:"2026-08-23T10:00:00Z"});
  const{context,rpcCalls}=billingContext({elements,rpc(name,args){
    if(name==="billing_admin_lookup_account")return Promise.resolve({data:summary(args.p_query==="a@example.com"?accountA:accountB),error:null});
    if(name==="billing_admin_financial_holds")return args.p_account_id===accountA?oldHolds.promise:Promise.resolve({data:[hold(holdB,accountB,"charge.dispute.closed")],error:null});
    throw new Error(`unexpected RPC ${name}`);
  }});

  vm.runInContext("globalThis.oldLookup=billingAdminLookup()",context);
  for(let i=0;i<4&&!rpcCalls.some(call=>call.name==="billing_admin_financial_holds");i++)await Promise.resolve();
  assert.equal(rpcCalls.some(call=>call.name==="billing_admin_financial_holds"&&call.args.p_account_id===accountA),true);
  query.value="b@example.com";
  await vm.runInContext("billingAdminLookup()",context);
  oldHolds.resolve({data:[hold(holdA,accountA,"charge.dispute.created")],error:null});
  await context.oldLookup;
  assert.equal(vm.runInContext("billingState.admin.result.accountId",context),accountB);
  assert.equal(vm.runInContext("billingState.admin.holds[0].holdId",context),holdB);
});

function queryFor(promise){let query;query=new Proxy({},{get(_target,property){if(property==="then")return promise.then.bind(promise);return()=>query}});return query}
async function renderQueueForRole(role){
  const context=vm.createContext({
    URL,console,app:{innerHTML:""},session:{user:{id:"owner-a"}},renderEpoch:1,myPersonas:[],myAccounts:[],myAccountPersonaLinks:[],myAccountConnections:[],PLATS:{},
    sb:{from(table){const data=table==="platform_role_assignments"?[{role_key:role,active:true,expires_at:null}]:[];return queryFor(Promise.resolve({data,error:null}))},rpc:async()=>({data:null,error:null})},
    esc:value=>String(value??""),safeBgStyle:()=>"",renderSignin(){},setMeta(){},toast(){},go(){},document:{getElementById:()=>null},requireAal2ForSensitiveAction:async()=>true,confirm:()=>true,prompt:()=>"",navigator:{clipboard:{writeText:async()=>{}}},window:{open(){}},
  });
  vm.runInContext(governance,context,{filename:"platform-governance.js"});
  context.billingAdminPanelHtml=()=>'<section id="developer-access-panel">Developer access and duplicate-refund controls</section>';
  await context.renderPlatformQueue();
  return context.app.innerHTML;
}

test("developer access panel renders for global administrators but not technicians",async()=>{
  assert.match(governance,/isGlobalAdmin&&typeof billingAdminPanelHtml/);
  assert.match(await renderQueueForRole("global_administrator"),/developer-access-panel/);
  assert.doesNotMatch(await renderQueueForRole("technician"),/developer-access-panel/);
  assert.match(await renderQueueForRole("global_administrator"),/duplicate-refund controls/);
  assert.doesNotMatch(await renderQueueForRole("technician"),/duplicate-refund controls/);
});

test("renewable subscriptions block the developer grant control until period-end cancellation",()=>{
  const{context}=billingContext();
  vm.runInContext(`billingState.admin.result=billingNormalizeAdminAccount({
    account_id:"11111111-1111-4111-8111-111111111111",display_name:"Developer",masked_email:"d***@example.com",
    state:"paid_active",source:"subscription",access_allowed:true,subscription_status:"active",cancel_at_period_end:false
  })`,context);
  const blocked=vm.runInContext("billingAdminPanelHtml()",context);
  assert.match(blocked,/server refuses a developer grant while a subscription can still renew/i);
  assert.match(blocked,/Developer grant blocked/);
  assert.match(blocked,/onclick="billingAdminGrantDeveloper\(\)" disabled/);
  vm.runInContext("billingState.admin.result=Object.freeze({...billingState.admin.result,cancelAtPeriodEnd:true})",context);
  const allowed=vm.runInContext("billingAdminPanelHtml()",context);
  assert.doesNotMatch(allowed,/Developer grant blocked/);
  assert.doesNotMatch(allowed,/onclick="billingAdminGrantDeveloper\(\)" disabled/);
});

test("billing controls provide mobile, keyboard, contrast, and touch-size affordances",()=>{
  assert.match(css,/@media\(max-width:760px\)/);
  assert.match(css,/@media\(forced-colors:active\)/);
  assert.match(css,/min-height:44px/);
  assert.match(css,/font-size:16px/);
  assert.match(css,/:focus-visible/);
  assert.match(source,/aria-live="polite"/);
  assert.match(source,/role="alert"/);
  assert.match(source,/aria-busy=/);
  assert.match(source,/aria-labelledby="billingHoldTitle_/);
  assert.match(source,/aria-labelledby="\$\{titleId\}"/);
  assert.match(css,/\.billing-hold-actions button[^\{]*\{min-height:44px\}/);
  assert.match(css,/\.billing-admin-hold-heading/);
  assert.match(css,/\.billing-admin-refund/);
  assert.match(css,/\.billing-refund-actions button/);
});

test("billing client has no direct table mutation and never sends processor identifiers",()=>{
  assert.doesNotMatch(source,/\.from\s*\(/);
  assert.doesNotMatch(source,/body:\{[^}]*\b(?:amount|price|customer|subscription|return_url|returnUrl)\b/);
  for(const rpc of["my_billing_status","billing_admin_lookup_account","billing_admin_financial_holds","billing_admin_duplicate_refund_reviews","billing_admin_reconcile_financial_hold","billing_admin_grant_developer","billing_admin_revoke_developer"])assert.match(source,new RegExp(`sb\\.rpc\\(["']${rpc}["']`));
  assert.match(source,/billing_admin_financial_holds",\{p_account_id:accountId,p_limit:BILLING_ADMIN_HOLD_LIMIT\}/);
  assert.match(source,/sb\.functions\.invoke\("billing-admin-refund-duplicate",\{body:\{remediationId:reviewId,reason:draft\.reason\}\}\)/);
  assert.doesNotMatch(source,/sb\.rpc\(["']billing_admin_approve_duplicate_refund/);
  assert.doesNotMatch(source,/stripe_(?:customer|subscription|invoice)_id|source_event_id|provider_object_id|raw_payload|payment_method|card_number/);
  assert.match(source,/billing-create-checkout/);
  assert.match(source,/billing-create-portal/);
});
