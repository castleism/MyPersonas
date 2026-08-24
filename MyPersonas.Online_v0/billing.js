"use strict";

const BILLING_PLANS=Object.freeze([
  Object.freeze({planCode:"account_weekly",name:"Weekly",price:"$20",cadence:"every 7 days",offer:"7 days free, then $20 every 7 days",noTrial:"$20 charged now, then $20 every 7 days",comparison:"Flexible weekly billing; no longer-interval discount."}),
  Object.freeze({planCode:"account_monthly",name:"Monthly",price:"$50",cadence:"monthly",offer:"7 days free, then $50 monthly",noTrial:"$50 charged now, then $50 monthly",comparison:"Intentional interval savings: 12 monthly charges total $600, about 42% less than 52 weekly charges ($1,040)."}),
  Object.freeze({planCode:"account_yearly",name:"Yearly",price:"$333",cadence:"yearly",offer:"7 days free, then $333 yearly",noTrial:"$333 charged now, then $333 yearly",comparison:"Intentional interval savings: $333 is 44.5% less than 12 monthly charges and about 68% less than 52 weekly charges."})
]);
const BILLING_PLAN_CODES=new Set(BILLING_PLANS.map(plan=>plan.planCode));
const BILLING_CHECKOUT_HOSTS=new Set(["checkout.stripe.com"]);
const BILLING_PORTAL_HOSTS=new Set(["billing.stripe.com"]);
const BILLING_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BILLING_EMAIL=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BILLING_ADMIN_HOLD_LIMIT=25;
const BILLING_ADMIN_REFUND_LIMIT=100;
const BILLING_REFUND_STATES=new Set(["provider_canceled","refund_pending","provider_refund_pending","refund_review_required"]);
const BILLING_REFUND_ACTIONABLE_STATES=new Set(["provider_canceled","refund_pending","provider_refund_pending"]);

const billingState={
  ownerId:"",requestGeneration:0,loaded:false,loading:false,status:null,error:"",
  checkoutBusy:"",portalBusy:false,returnState:"",returnHandled:false,
  admin:{query:"",result:null,loading:false,error:"",requestGeneration:0,actionBusy:false,message:"",draftReason:"",draftExpiry:"",draftAck:false,holds:[],holdsLoading:false,holdsError:"",holdActionBusy:"",holdDraftReasons:{},refunds:[],refundsLoaded:false,refundsLoading:false,refundsError:"",refundMessage:"",refundRequestGeneration:0,refundActionBusy:"",refundDrafts:{}}
};

(function billingCaptureHostedReturn(){
  try{
    const url=new URL(window.location.href),value=(url.searchParams.get("billing")||"").toLowerCase();
    if(value==="success"||value==="cancel")billingState.returnState=value;
    if(url.searchParams.has("billing")||url.searchParams.has("session_id")){
      url.searchParams.delete("billing");
      url.searchParams.delete("session_id");
      const query=url.searchParams.toString();
      history.replaceState(history.state,"",url.pathname+(query?`?${query}`:"")+url.hash);
    }
  }catch(_error){/* A malformed return URL must never unlock access or break sign-in. */}
})();

function billingEsc(value){
  return String(value??"").replace(/[&<>'"]/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
}
function billingLabel(value,fallback="Not available"){
  const safe=String(value||"").toLowerCase();
  if(!/^[a-z][a-z0-9_]{0,48}$/.test(safe))return fallback;
  return safe.split("_").map(part=>part.charAt(0).toUpperCase()+part.slice(1)).join(" ");
}
function billingDate(value){
  if(!value)return"";
  const parsed=new Date(value);
  return Number.isFinite(parsed.getTime())?parsed.toISOString():"";
}
function billingDisplayDate(value){
  if(!value)return"";
  try{return new Intl.DateTimeFormat(undefined,{dateStyle:"medium",timeStyle:"short"}).format(new Date(value))}catch(_error){return""}
}
function billingBoolean(value){return value===true}
function billingNullableBoolean(value){return typeof value==="boolean"?value:null}
function billingPickDate(raw,names){
  for(const name of names){const value=billingDate(raw?.[name]);if(value)return value}
  return"";
}
function billingUnwrapRow(data){return Array.isArray(data)?(data[0]||null):data}
function billingNormalizeConsequences(value){
  const values=Array.isArray(value)?value:(typeof value==="string"?[value]:[]);
  return values.filter(item=>typeof item==="string"&&item.trim()).slice(0,8).map(item=>item.trim().slice(0,300));
}
function billingNormalizeStatus(data){
  const raw=billingUnwrapRow(data);
  if(!raw||typeof raw!=="object"||typeof raw.enforcement_enabled!=="boolean"||typeof raw.checkout_enabled!=="boolean"||typeof raw.access_allowed!=="boolean")throw new Error("invalid billing status");
  return Object.freeze({
    enforcementEnabled:billingBoolean(raw.enforcement_enabled),
    checkoutEnabled:billingBoolean(raw.checkout_enabled),
    state:/^[a-z][a-z0-9_]{0,48}$/.test(String(raw.state||"").toLowerCase())?String(raw.state).toLowerCase():"unknown",
    source:/^[a-z][a-z0-9_]{0,48}$/.test(String(raw.source||"").toLowerCase())?String(raw.source).toLowerCase():"unknown",
    accessAllowed:billingBoolean(raw.access_allowed),
    trialEligible:billingNullableBoolean(raw.trial_eligible),
    subscriptionStatus:/^[a-z][a-z0-9_]{0,48}$/.test(String(raw.subscription_status||"").toLowerCase())?String(raw.subscription_status).toLowerCase():"",
    cancelAtPeriodEnd:billingBoolean(raw.cancel_at_period_end),
    trialStartsAt:billingPickDate(raw,["trial_starts_at","trial_started_at","trial_start"]),
    trialEndsAt:billingPickDate(raw,["trial_ends_at","trial_end"]),
    paidThroughAt:billingPickDate(raw,["paid_through_at","paid_through","current_period_end"]),
    cancelsAt:billingPickDate(raw,["cancels_at","cancel_at"]),
    canceledAt:billingPickDate(raw,["canceled_at","cancelled_at"]),
    developerExpiresAt:billingPickDate(raw,["developer_expires_at","developer_expiry"]),
    updatedAt:billingPickDate(raw,["updated_at","status_updated_at"]),
    consequences:billingNormalizeConsequences(raw.consequences)
  });
}
function billingOwnerId(){return typeof session!=="undefined"&&session?.user?.id?session.user.id:""}
function billingAuthGeneration(){return typeof authLoadGeneration==="number"?authLoadGeneration:0}
function billingRequestCurrent(owner,generation,authGeneration){
  return !!owner&&billingOwnerId()===owner&&billingState.ownerId===owner&&billingState.requestGeneration===generation&&billingAuthGeneration()===authGeneration;
}
function billingResetOwnerState(){
  if(billingState.returnHandled){billingState.returnState="";billingState.returnHandled=false}
  billingState.requestGeneration++;
  billingState.ownerId="";billingState.loaded=false;billingState.loading=false;billingState.status=null;billingState.error="";
  billingState.checkoutBusy="";billingState.portalBusy=false;
  billingState.admin.requestGeneration++;billingState.admin.refundRequestGeneration++;billingState.admin.query="";billingState.admin.result=null;billingState.admin.loading=false;billingState.admin.error="";billingState.admin.actionBusy=false;billingState.admin.message="";billingState.admin.draftReason="";billingState.admin.draftExpiry="";billingState.admin.draftAck=false;billingState.admin.holds=[];billingState.admin.holdsLoading=false;billingState.admin.holdsError="";billingState.admin.holdActionBusy="";billingState.admin.holdDraftReasons={};billingState.admin.refunds=[];billingState.admin.refundsLoaded=false;billingState.admin.refundsLoading=false;billingState.admin.refundsError="";billingState.admin.refundMessage="";billingState.admin.refundActionBusy="";billingState.admin.refundDrafts={};
  billingPaintAccount();billingPaintAdmin();
}
function billingNavigationBusy(){return !!billingState.checkoutBusy||billingState.portalBusy}
function billingPublicationBlockReason(){
  if(!billingOwnerId())return"";
  if(!billingState.loaded||!billingState.status)return"unavailable";
  return billingState.status.enforcementEnabled&&!billingState.status.accessAllowed?"suspended":"";
}
function billingOwnerSuspensionNoticeHtml(){
  if(billingPublicationBlockReason()!=="suspended")return"";
  return '<div class="billing-callout billing-error" role="status"><b>Owner preview — public access is suspended.</b> You can still edit and review this stored page, but visitors cannot discover or open it and account AI/publishing automations remain halted until membership access returns. The stored publication state is preserved so it can recover without losing your work.</div>';
}
function billingShouldOpenFromReturn(){
  if(!billingState.returnState||billingState.returnHandled)return false;
  billingState.returnHandled=true;return true;
}
function billingAnnounceReturn(){
  if(typeof toast!=="function")return;
  toast(billingState.returnState==="success"?"Checkout returned. Waiting for verified billing status.":"Checkout was canceled. No membership change was assumed.");
}

async function billingEnsureLoaded(force=false){
  const owner=billingOwnerId();
  if(!owner)return;
  if(billingState.ownerId!==owner){
    billingState.requestGeneration++;
    billingState.ownerId=owner;billingState.loaded=false;billingState.loading=false;billingState.status=null;billingState.error="";billingState.checkoutBusy="";billingState.portalBusy=false;
  }
  if(billingState.loading||(!force&&billingState.loaded)){billingPaintAccount();return}
  if(force){billingState.checkoutBusy="";billingState.portalBusy=false}
  billingState.loading=true;billingState.error="";billingPaintAccount();
  const generation=++billingState.requestGeneration,authGeneration=billingAuthGeneration();
  let response;
  try{response=await sb.rpc("my_billing_status")}catch(_error){response={data:null,error:{message:"request failed"}}}
  if(!billingRequestCurrent(owner,generation,authGeneration))return;
  billingState.loading=false;
  if(response?.error){billingState.loaded=false;billingState.status=null;billingState.error="Membership status is temporarily unavailable. No checkout was started.";billingPaintAccount();return}
  try{
    billingState.status=billingNormalizeStatus(response?.data);billingState.loaded=true;billingState.error="";
  }catch(_error){
    billingState.status=null;billingState.loaded=false;billingState.error="Membership status could not be verified. No checkout was started.";
  }
  billingPaintAccount();
}
function billingRefreshStatus(){return billingEnsureLoaded(true)}

function billingStatusFactsHtml(status){
  if(!status)return"";
  const facts=[];
  if(status.subscriptionStatus)facts.push(["Subscription status",billingLabel(status.subscriptionStatus)]);
  if(status.trialEndsAt)facts.push(["Trial ends",billingDisplayDate(status.trialEndsAt)]);
  if(status.paidThroughAt)facts.push(["Paid through",billingDisplayDate(status.paidThroughAt)]);
  if(status.cancelAtPeriodEnd)facts.push(["Renewal",status.paidThroughAt?`Cancels after ${billingDisplayDate(status.paidThroughAt)}`:"Cancels at the end of the current billing period"]);
  if(status.cancelsAt)facts.push(["Scheduled cancellation",billingDisplayDate(status.cancelsAt)]);
  if(status.canceledAt&&!status.cancelsAt)facts.push(["Canceled",billingDisplayDate(status.canceledAt)]);
  if(status.developerExpiresAt)facts.push(["Developer access expires",billingDisplayDate(status.developerExpiresAt)]);
  if(status.updatedAt)facts.push(["Status verified",billingDisplayDate(status.updatedAt)]);
  return facts.length?`<dl class="billing-facts">${facts.map(([label,value])=>`<div><dt>${billingEsc(label)}</dt><dd>${billingEsc(value)}</dd></div>`).join("")}</dl>`:"";
}
function billingPlanCardsHtml(status){
  const verified=!!status&&billingState.loaded&&!billingState.loading;
  const checkoutAllowed=verified&&status.enforcementEnabled&&status.checkoutEnabled&&!status.accessAllowed;
  return `<div class="billing-plan-grid">${BILLING_PLANS.map(plan=>{const terms=status?.trialEligible===true?`Expected if Checkout confirms eligibility: ${plan.offer}`:status?.trialEligible===false?plan.noTrial:"Trial eligibility will be verified in Checkout before you confirm";const buttonLabel=status?.accessAllowed?`${plan.name} access is already enabled`:(!status?.checkoutEnabled&&verified?`${plan.name} Checkout is not enabled`:`Choose ${plan.name} plan`),headingId=`billing-plan-${plan.planCode}`;return`<article class="billing-plan" aria-labelledby="${headingId}">
    <h4 id="${headingId}">${billingEsc(plan.name)}</h4><p class="billing-price"><strong>${billingEsc(plan.price)}</strong><span>${billingEsc(plan.cadence)}</span></p>
    <p class="billing-offer">${billingEsc(terms)}</p><p class="billing-savings">${billingEsc(plan.comparison)}</p><p class="billing-same">Same feature access as every other paid plan. Stripe shows the first charge and renewal interval before you confirm.</p>
    <button class="btn billing-plan-button" type="button" onclick="billingStartCheckout('${plan.planCode}')" ${checkoutAllowed&&!billingNavigationBusy()?"": "disabled"}>${billingState.checkoutBusy===plan.planCode?`Opening ${billingEsc(plan.name)} Checkout…`:billingEsc(buttonLabel)}</button>
  </article>`}).join("")}</div>`;
}
function billingReturnHtml(){
  if(billingState.returnState==="success"&&billingState.loaded&&billingState.status?.accessAllowed&&billingState.status?.source==="subscription")return '<div class="billing-callout billing-good" role="status"><b>Checkout returned.</b> The access status below was independently verified by the server. The browser redirect itself was not treated as proof of payment.</div>';
  if(billingState.returnState==="success")return '<div class="billing-callout billing-pending" role="status"><b>Checkout returned.</b> Membership is still pending until a verified Stripe webhook updates this status. This page does not treat a Checkout return as proof of payment. Refresh status in a moment.</div>';
  if(billingState.returnState==="cancel")return '<div class="billing-callout billing-neutral" role="status"><b>Checkout was canceled.</b> No membership or access change is assumed.</div>';
  return"";
}
function billingConsequenceHtml(status){
  const active=status?.enforcementEnabled&&status.accessAllowed;
  const heading=active?"What happens if membership access ends":"Access limits while membership is inactive";
  const serverConsequences=status?.consequences?.length?`<div class="billing-server-notes"><b>Current server policy</b><ul>${status.consequences.map(item=>`<li>${billingEsc(item)}</li>`).join("")}</ul></div>`:"";
  return `<section class="billing-consequences ${active?"":"is-suspended"}"><h4>${heading}</h4><ul>
    <li>Search for other personas inside the signed-in app is disabled.</li>
    <li>Your persona pages become effectively unpublished from public discovery and profile views.</li>
    <li>AI automation, including research briefs, is halted; missed or queued work does not automatically catch up when access returns.</li>
    <li>You can still sign in, edit account data, manage billing, and export or delete your data.</li>
  </ul>${serverConsequences}<p>Access is restored only from a verified server-side membership or developer entitlement update—not from a browser redirect.</p></section>`;
}
function billingAccountPanelHtml(){
  const status=billingState.status;
  const statusClass=status?.accessAllowed?"is-active":"is-inactive";
  const statusText=status?billingLabel(status.state,"Unknown"):"Not verified";
  const accessText=status?(status.accessAllowed?"Access enabled":"Access suspended"):"Access not verified";
  const eligibility=status?.trialEligible===true?'<div class="billing-callout billing-good"><b>A trial may be available:</b> Stripe Checkout makes the final eligibility determination and shows the first charge before you confirm.</div>':status?.trialEligible===false?'<div class="billing-callout billing-warn"><b>No repeat free trial:</b> this account has already used its one-time trial. The plan cards show the amount charged now; Stripe Checkout is authoritative and shows the first charge before you confirm.</div>':status?'<div class="billing-callout billing-neutral"><b>Trial eligibility is not verified yet.</b> No free trial is promised. Stripe Checkout must show the first charge before you confirm.</div>':"";
  const enforcement=status&&(!status.enforcementEnabled||!status.checkoutEnabled)?'<div class="billing-callout billing-neutral"><b>Checkout is not enabled yet.</b> The browser and server both keep payment creation disabled until the approved billing release is activated.</div>':"";
  const developer=status?.source==="developer"?'<div class="billing-callout billing-good"><b>Developer access is active.</b> This does not cancel or refund any separate paid subscription. Use the billing portal to inspect any renewal.</div>':"";
  const error=billingState.error?`<div class="billing-callout billing-error" role="alert">${billingEsc(billingState.error)} <button class="billing-link-button" type="button" onclick="billingRefreshStatus()">Try again</button></div>`:"";
  return `<div class="billing-shell">
    <div class="billing-heading"><div><span class="billing-kicker">Account membership</span><h4>One account, the same access on every plan</h4></div><button class="btn sec billing-refresh" type="button" onclick="billingRefreshStatus()" ${billingState.loading||billingState.checkoutBusy||billingState.portalBusy?"disabled":""}>${billingState.loading?"Checking…":"Refresh status"}</button></div>
    ${billingReturnHtml()}${error}
    <section class="billing-status ${statusClass}" aria-live="polite" aria-busy="${billingState.loading?"true":"false"}">
      <div><span class="billing-status-label">Server-verified status</span><strong>${billingEsc(billingState.loading?"Checking…":statusText)}</strong></div>
      <div><span class="billing-status-label">Feature access</span><strong>${billingEsc(billingState.loading?"Checking…":accessText)}</strong></div>
      ${status?`<div><span class="billing-status-label">Access source</span><strong>${billingEsc(billingLabel(status.source))}</strong></div>`:""}
    </section>
    ${billingStatusFactsHtml(status)}${enforcement}${developer}${eligibility}
    <p class="billing-intro">Every paid plan includes the same account features. Pick only the billing interval that fits you. Each verified email can receive at most one 7-day free trial; Stripe Checkout verifies whether it can be included before you confirm. Two-factor verification is required before Checkout or billing management opens.</p>
    ${billingPlanCardsHtml(status)}
    <div class="billing-actions"><button class="btn sec" type="button" onclick="billingOpenPortal()" ${status&&!billingState.loading&&!billingNavigationBusy()?"":"disabled"}>${billingState.portalBusy?"Opening secure portal…":"Manage billing or recover access"}</button><span>The Stripe-hosted portal is the safe place to update payment details, inspect renewals, or cancel. MyPersonas never collects card details.</span></div>
    ${billingConsequenceHtml(status)}
    <p class="billing-legal">By confirming in Stripe Checkout, you agree to the <a href="terms.html" target="_blank" rel="noopener">Terms</a> and acknowledge the price and renewal interval Stripe shows before purchase. See the <a href="privacy.html" target="_blank" rel="noopener">Privacy notice</a>.</p>
  </div>`;
}
function billingPaintAccount(){const root=typeof document!=="undefined"?document.getElementById("billingAccountRoot"):null;if(root)root.innerHTML=billingAccountPanelHtml()}

function billingTrustedRedirect(raw,kind){
  const url=new URL(String(raw||"")),hosts=kind==="checkout"?BILLING_CHECKOUT_HOSTS:BILLING_PORTAL_HOSTS;
  if(url.protocol!=="https:"||url.username||url.password||url.port||!hosts.has(url.hostname.toLowerCase()))throw new Error("untrusted redirect");
  return url.href;
}
async function billingStartCheckout(planCode){
  if(!BILLING_PLAN_CODES.has(planCode)){billingState.error="That membership option is not available.";billingPaintAccount();return}
  if(billingNavigationBusy())return;
  const owner=billingOwnerId(),status=billingState.status;
  if(!owner){if(typeof toast==="function")toast("Sign in before starting Checkout");return}
  if(!billingState.loaded||billingState.loading||!status?.enforcementEnabled||!status?.checkoutEnabled||status.accessAllowed){billingState.error="Refresh the server-verified membership status before starting Checkout.";billingPaintAccount();return}
  const generation=billingState.requestGeneration,authGeneration=billingAuthGeneration();
  billingState.checkoutBusy=planCode;billingState.error="";billingPaintAccount();
  const steppedUp=typeof requireAal2ForSensitiveAction==="function"&&await requireAal2ForSensitiveAction("start this recurring membership");
  if(!billingRequestCurrent(owner,generation,authGeneration))return;
  if(!steppedUp){billingState.checkoutBusy="";billingState.error="Two-factor verification is required before secure Checkout can open.";billingPaintAccount();return}
  let response;
  try{response=await sb.functions.invoke("billing-create-checkout",{body:{planCode}})}catch(_error){response={data:null,error:{message:"request failed"}}}
  if(!billingRequestCurrent(owner,generation,authGeneration))return;
  billingState.checkoutBusy="";
  if(response?.error){billingState.error="Secure Checkout could not be opened. Refresh membership status and try again.";billingPaintAccount();return}
  try{window.location.assign(billingTrustedRedirect(response?.data?.url,"checkout"))}catch(_error){billingState.error="The Checkout service returned an invalid destination. No redirect was opened.";billingPaintAccount()}
}
async function billingOpenPortal(){
  const owner=billingOwnerId();
  if(!owner||!billingState.loaded||billingState.loading||billingNavigationBusy())return;
  const generation=billingState.requestGeneration,authGeneration=billingAuthGeneration();
  billingState.portalBusy=true;billingState.error="";billingPaintAccount();
  const steppedUp=typeof requireAal2ForSensitiveAction==="function"&&await requireAal2ForSensitiveAction("manage billing, payment methods, or cancellation");
  if(!billingRequestCurrent(owner,generation,authGeneration))return;
  if(!steppedUp){billingState.portalBusy=false;billingState.error="Two-factor verification is required before the secure billing portal can open.";billingPaintAccount();return}
  let response;
  try{response=await sb.functions.invoke("billing-create-portal",{body:{}})}catch(_error){response={data:null,error:{message:"request failed"}}}
  if(!billingRequestCurrent(owner,generation,authGeneration))return;
  billingState.portalBusy=false;
  if(response?.error){billingState.error="The secure billing portal is not available for this account yet. You can refresh status or start Checkout if access is inactive.";billingPaintAccount();return}
  try{window.location.assign(billingTrustedRedirect(response?.data?.url,"portal"))}catch(_error){billingState.error="The billing portal returned an invalid destination. No redirect was opened.";billingPaintAccount()}
}

function billingNormalizeAdminAccount(data){
  const raw=billingUnwrapRow(data),accountId=String(raw?.account_id||"").toLowerCase();
  if(!raw||typeof raw!=="object"||!BILLING_UUID.test(accountId)||typeof raw.access_allowed!=="boolean")throw new Error("invalid account summary");
  return Object.freeze({
    accountId,displayName:String(raw.display_name||"").slice(0,160),maskedEmail:String(raw.masked_email||raw.email_masked||"").slice(0,180),
    state:/^[a-z][a-z0-9_]{0,48}$/.test(String(raw.state||"").toLowerCase())?String(raw.state).toLowerCase():"unknown",
    source:/^[a-z][a-z0-9_]{0,48}$/.test(String(raw.source||"").toLowerCase())?String(raw.source).toLowerCase():"unknown",
    accessAllowed:billingBoolean(raw.access_allowed),
    subscriptionStatus:/^[a-z][a-z0-9_]{0,48}$/.test(String(raw.subscription_status||"").toLowerCase())?String(raw.subscription_status).toLowerCase():"",
    cancelAtPeriodEnd:billingBoolean(raw.cancel_at_period_end),
    developerExpiresAt:billingPickDate(raw,["developer_expires_at","developer_expiry"]),
    paidThroughAt:billingPickDate(raw,["paid_through_at","paid_through","current_period_end"]),
    cancelsAt:billingPickDate(raw,["cancels_at","cancel_at"]),
    updatedAt:billingPickDate(raw,["updated_at","status_updated_at"])
  });
}
function billingNormalizeFinancialHolds(data,accountId){
  if(!Array.isArray(data)||!BILLING_UUID.test(accountId))throw new Error("invalid financial hold summaries");
  const seen=new Set();
  return Object.freeze(data.slice(0,BILLING_ADMIN_HOLD_LIMIT).map(raw=>{
    const holdId=String(raw?.hold_id||"").toLowerCase(),rowAccountId=String(raw?.account_id||"").toLowerCase(),eventType=String(raw?.event_type||"").toLowerCase(),providerObjectType=String(raw?.event_category||"").toLowerCase(),openedAt=billingDate(raw?.opened_at);
    if(!raw||typeof raw!=="object"||!BILLING_UUID.test(holdId)||rowAccountId!==accountId||seen.has(holdId)||!openedAt||!/^[a-z][a-z0-9_.]{2,159}$/.test(eventType)||!["charge","refund","dispute"].includes(providerObjectType))throw new Error("invalid financial hold summary");
    seen.add(holdId);
    return Object.freeze({holdId,eventType,providerObjectType,openedAt});
  }));
}
function billingNormalizeRefundReviews(data){
  if(!Array.isArray(data))throw new Error("invalid refund review summaries");
  const seen=new Set();
  return Object.freeze(data.slice(0,BILLING_ADMIN_REFUND_LIMIT).map(raw=>{
    const reviewId=String(raw?.remediation_id||"").toLowerCase(),maskedEmail=String(raw?.masked_email||"").trim(),state=String(raw?.state||"").toLowerCase(),currency=String(raw?.currency||"").toLowerCase(),refundStatus=String(raw?.refund_status||"").toLowerCase(),amountMinor=Number(raw?.amount_minor),approvedAt=billingDate(raw?.approved_at),createdAt=billingDate(raw?.created_at),updatedAt=billingDate(raw?.updated_at);
    if(!raw||typeof raw!=="object"||!BILLING_UUID.test(reviewId)||seen.has(reviewId)||!BILLING_REFUND_STATES.has(state)||!Number.isSafeInteger(amountMinor)||amountMinor<1||amountMinor>1000000000000||!/^[a-z]{3}$/.test(currency)||!createdAt||!updatedAt||maskedEmail.length>320||/[\u0000-\u001f\u007f]/.test(maskedEmail)||(maskedEmail&&maskedEmail!=="***"&&!/^[^@\s]\*{3}@[^@\s]+$/u.test(maskedEmail))||(refundStatus&&!/^[a-z][a-z0-9_]{0,48}$/.test(refundStatus)))throw new Error("invalid refund review summary");
    seen.add(reviewId);
    return Object.freeze({reviewId,maskedEmail:maskedEmail||"Unavailable",state,amountMinor,currency,refundStatus,approvedAt,createdAt,updatedAt});
  }));
}
function billingRefundConfirmation(review){return `${(review.amountMinor/100).toFixed(2)} ${review.currency.toUpperCase()}`}
function billingRefundDisplayAmount(review){
  try{return new Intl.NumberFormat(undefined,{style:"currency",currency:review.currency.toUpperCase()}).format(review.amountMinor/100)}catch(_error){return billingRefundConfirmation(review)}
}
function billingPlatformQueueRoute(){
  try{return new URL(window.location.href).hash.replace(/^#\/?/,"").split(/[/?]/)[0]==="platform-queue"}catch(_error){return false}
}
function billingAdminRefundSameAccountRequest(owner,generation,authGeneration){return !!owner&&billingOwnerId()===owner&&billingState.admin.refundRequestGeneration===generation&&billingAuthGeneration()===authGeneration}
function billingAdminRefundCurrent(owner,generation,authGeneration,reviewId=""){
  return billingAdminRefundSameAccountRequest(owner,generation,authGeneration)&&billingPlatformQueueRoute()&&(!reviewId||billingState.admin.refunds.some(review=>review.reviewId===reviewId));
}
function billingAdminCaptureRefundDraft(index){
  const review=Number.isInteger(index)?billingState.admin.refunds[index]:null;if(!review)return null;
  const draft={
    confirmation:String(document.getElementById(`billingRefundConfirmation_${index}`)?.value||"").trim().slice(0,33),
    reason:String(document.getElementById(`billingRefundReason_${index}`)?.value||"").trim().slice(0,1001),
    acknowledged:!!document.getElementById(`billingRefundAck_${index}`)?.checked
  };
  billingState.admin.refundDrafts[review.reviewId]=draft;return draft;
}
function billingAdminRefundReviewsHtml(){
  const admin=billingState.admin;
  let body="";
  if(admin.refundsLoading)body='<div class="billing-callout billing-neutral" role="status">Loading bounded duplicate-refund summaries for this administrator session…</div>';
  else if(admin.refundsError)body=`<div class="billing-callout billing-error" role="alert">${billingEsc(admin.refundsError)}</div>`;
  else if(!admin.refundsLoaded)body='<div class="empty">Refund reviews have not been loaded. Use the MFA-protected refresh control.</div>';
  else if(!admin.refunds.length)body='<div class="billing-callout billing-good" role="status"><b>No duplicate-subscription refund reviews are currently pending.</b></div>';
  else body=`<div class="billing-admin-refund-list">${admin.refunds.map((review,index)=>{const draft=admin.refundDrafts[review.reviewId]||{},actionable=BILLING_REFUND_ACTIONABLE_STATES.has(review.state),busy=admin.refundActionBusy===review.reviewId,confirmation=billingRefundConfirmation(review),titleId=`billingRefundTitle_${index}`,helpId=`billingRefundHelp_${index}`;return`<article class="billing-admin-refund" aria-labelledby="${titleId}">
    <div class="billing-admin-refund-heading"><div><span class="billing-kicker">Duplicate-subscription refund review</span><h4 id="${titleId}">${billingEsc(billingRefundDisplayAmount(review))} ${billingEsc(review.currency.toUpperCase())}</h4></div><span class="billing-refund-state">${billingEsc(billingLabel(review.state))}</span></div>
    <dl class="billing-facts"><div><dt>Opaque review ID</dt><dd><code>${billingEsc(review.reviewId)}</code></dd></div><div><dt>Account</dt><dd>${billingEsc(review.maskedEmail)}</dd></div><div><dt>Exact amount</dt><dd>${billingEsc(confirmation)}</dd></div><div><dt>Workflow state</dt><dd>${billingEsc(billingLabel(review.state))}</dd></div>${review.refundStatus?`<div><dt>Refund status</dt><dd>${billingEsc(billingLabel(review.refundStatus))}</dd></div>`:""}<div><dt>Created</dt><dd>${billingEsc(billingDisplayDate(review.createdAt))}</dd></div>${review.approvedAt?`<div><dt>Approved</dt><dd>${billingEsc(billingDisplayDate(review.approvedAt))}</dd></div>`:""}<div><dt>Updated</dt><dd>${billingEsc(billingDisplayDate(review.updatedAt))}</dd></div></dl>
    ${actionable?`<div class="billing-callout billing-warn" id="${helpId}"><b>This action can move money.</b> Verify the masked account, opaque review ID, and exact tax-inclusive amount. MyPersonas resolves every provider identifier and the original payment method only on the server.</div>
    <label for="billingRefundConfirmation_${index}">Type the exact amount and currency: <code>${billingEsc(confirmation)}</code></label><input id="billingRefundConfirmation_${index}" autocomplete="off" inputmode="decimal" maxlength="32" spellcheck="false" value="${billingEsc(draft.confirmation||"")}" aria-describedby="${helpId}" oninput="billingAdminCaptureRefundDraft(${index})">
    <label for="billingRefundReason_${index}">Required approval or retry reason</label><textarea id="billingRefundReason_${index}" minlength="10" maxlength="1000" placeholder="Explain the evidence reviewed and why this exact duplicate should be refunded or safely resumed." oninput="billingAdminCaptureRefundDraft(${index})">${billingEsc(draft.reason||"")}</textarea>
    <label class="billing-admin-ack" for="billingRefundAck_${index}"><input id="billingRefundAck_${index}" type="checkbox" ${draft.acknowledged?"checked":""} onchange="billingAdminCaptureRefundDraft(${index})"> <span>I explicitly approve this exact duplicate refund to the original payment method and understand that a pending or ambiguous provider response requires reconciliation.</span></label>
    <div class="billing-refund-actions"><button class="btn danger" id="billingRefundAction_${index}" type="button" onclick="billingAdminApproveRefund(${index})" ${admin.refundsLoading||admin.refundActionBusy?"disabled":""}>${busy?"Submitting exact refund…":review.state==="provider_canceled"?"Approve exact duplicate refund":"Safely retry server reconciliation"}</button></div>`:'<div class="billing-callout billing-error" role="status"><b>Manual reconciliation required.</b> This review cannot be resubmitted from the approval control until its provider evidence is resolved.</div>'}
  </article>`}).join("")}</div>`;
  return `<section class="billing-admin-refunds" id="billingAdminRefundReviews" tabindex="-1" aria-live="polite" aria-busy="${admin.refundsLoading||!!admin.refundActionBusy?"true":"false"}"><div class="billing-admin-refunds-heading"><div><span class="billing-kicker">Safe RPC summaries · up to ${BILLING_ADMIN_REFUND_LIMIT}</span><h4>Duplicate-subscription refund reviews</h4></div><button class="btn sec sm" id="billingRefundRefresh" type="button" onclick="billingAdminLoadRefundReviews()" ${admin.refundsLoading||!!admin.refundActionBusy?"disabled":""}>${admin.refundsLoading?"Loading…":"Refresh reviews with MFA"}</button></div><p class="muted">The list contains only an opaque internal review ID, masked email, workflow status, exact amount/currency, and timestamps. Card data, provider customer/subscription/invoice/charge/refund identifiers, raw events, and secrets are never requested or rendered.</p>${admin.refundMessage?`<div class="billing-callout billing-good" role="status">${billingEsc(admin.refundMessage)}</div>`:""}${body}</section>`;
}
function billingFinancialEventLabel(value){return String(value||"").split(/[._]/).filter(Boolean).map(part=>part.charAt(0).toUpperCase()+part.slice(1)).join(" ")||"Financial event"}
function billingAdminGrantBlocked(account){return !!account&&["trialing","active","past_due","unpaid","paused","incomplete"].includes(account.subscriptionStatus)&&!account.cancelAtPeriodEnd}
function billingAdminCurrent(owner,generation,authGeneration,accountId=""){return !!owner&&billingOwnerId()===owner&&billingState.admin.requestGeneration===generation&&billingAuthGeneration()===authGeneration&&(!accountId||billingState.admin.result?.accountId===accountId)}
function billingAdminFinancialHoldsHtml(){
  const admin=billingState.admin;
  if(admin.holdsLoading)return '<div class="billing-callout billing-neutral" role="status">Loading bounded financial-hold summaries for this exact account…</div>';
  if(admin.holdsError)return `<div class="billing-callout billing-error" role="alert">${billingEsc(admin.holdsError)}</div>`;
  if(!admin.holds.length)return '<div class="billing-callout billing-good" role="status"><b>No open financial holds were returned for this exact account.</b></div>';
  return `<div class="billing-admin-hold-list">${admin.holds.map((hold,index)=>{const reasonId=`billingHoldReason_${index}`,busy=admin.holdActionBusy===hold.holdId;return`<article class="billing-admin-hold" aria-labelledby="billingHoldTitle_${index}">
    <div class="billing-admin-hold-heading"><div><span class="billing-kicker">Open ${billingEsc(billingLabel(hold.providerObjectType))} review</span><h4 id="billingHoldTitle_${index}">${billingEsc(billingFinancialEventLabel(hold.eventType))}</h4></div><time datetime="${billingEsc(hold.openedAt)}">Opened ${billingEsc(billingDisplayDate(hold.openedAt))}</time></div>
    <div class="billing-callout billing-warn"><b>Verify the provider outcome outside this summary first.</b> Reconciliation removes this exact internal hold and may restore only the account's currently stored entitlement. It does not issue a refund, close a dispute, cancel a subscription, or prove that Stripe resolved the event.</div>
    <label for="${reasonId}">Required reconciliation reason</label><textarea id="${reasonId}" maxlength="1000" placeholder="Record the external evidence reviewed and why this exact hold is safe to reconcile (minimum 10 characters).">${billingEsc(admin.holdDraftReasons[hold.holdId]||"")}</textarea>
    <div class="billing-hold-actions"><button class="btn danger" type="button" onclick="billingAdminReconcileFinancialHold(${index})" ${admin.actionBusy||admin.holdActionBusy?"disabled":""}>${busy?"Reconciling verified hold…":"Reconcile this verified hold"}</button></div>
  </article>`}).join("")}</div>`;
}
function billingAdminPanelHtml(){
  const admin=billingState.admin,result=admin.result,hasFinancialHolds=admin.holds.length>0,grantBlocked=billingAdminGrantBlocked(result)||hasFinancialHolds,controlsBusy=admin.loading||admin.holdsLoading||admin.actionBusy||!!admin.holdActionBusy;
  const resultHtml=result?`<div class="billing-admin-result">
    <div class="billing-admin-identity"><div><span>Selected account</span><strong>${billingEsc(result.displayName||"No display name")}</strong><small>${billingEsc(result.maskedEmail||"Verified email masked")}</small></div><code>${billingEsc(result.accountId)}</code></div>
    <dl class="billing-facts"><div><dt>Access</dt><dd>${result.accessAllowed?"Enabled":"Suspended"}</dd></div><div><dt>State</dt><dd>${billingEsc(billingLabel(result.state))}</dd></div><div><dt>Source</dt><dd>${billingEsc(billingLabel(result.source))}</dd></div>${result.subscriptionStatus?`<div><dt>Subscription status</dt><dd>${billingEsc(billingLabel(result.subscriptionStatus))}</dd></div>`:""}${result.cancelAtPeriodEnd?'<div><dt>Renewal</dt><dd>Cancellation scheduled at period end</dd></div>':""}${result.developerExpiresAt?`<div><dt>Developer expiry</dt><dd>${billingEsc(billingDisplayDate(result.developerExpiresAt))}</dd></div>`:""}${result.paidThroughAt?`<div><dt>Paid through</dt><dd>${billingEsc(billingDisplayDate(result.paidThroughAt))}</dd></div>`:""}${result.cancelsAt?`<div><dt>Cancellation scheduled</dt><dd>${billingEsc(billingDisplayDate(result.cancelsAt))}</dd></div>`:""}</dl>
    <div class="billing-callout billing-warn"><b>Paid subscription disposition is a separate decision.</b> The server refuses a developer grant while a subscription can still renew. Schedule cancellation at period end in the Stripe portal first, then refresh this exact lookup. Granting developer access never cancels, pauses, or refunds a subscription; revoking it never creates or resumes one.</div>
    <label for="billingAdminReason">Required audit reason</label><textarea id="billingAdminReason" maxlength="500" placeholder="Explain why this developer entitlement is being changed (minimum 10 characters).">${billingEsc(admin.draftReason)}</textarea>
    <label for="billingAdminExpiry">Optional developer-access expiry</label><input id="billingAdminExpiry" type="datetime-local" value="${billingEsc(admin.draftExpiry)}">
    <label class="billing-admin-ack"><input id="billingAdminDispositionAck" type="checkbox" ${admin.draftAck?"checked":""}> <span>I understand that any renewable subscription must be scheduled to cancel at period end before developer access can be granted, and that refunds remain separate.</span></label>
    ${grantBlocked?`<div class="billing-callout billing-error" role="alert">Developer grant blocked: ${hasFinancialHolds?"reconcile every open financial hold after external verification":"schedule this subscription to cancel at period end"}, then run the exact lookup again.</div>`:""}
    <div class="billing-admin-actions"><button class="btn" type="button" onclick="billingAdminGrantDeveloper()" ${controlsBusy||admin.holdsError||grantBlocked?"disabled":""}>Grant developer access</button><button class="btn danger" type="button" onclick="billingAdminRevokeDeveloper()" ${controlsBusy||admin.holdsError?"disabled":""}>Revoke developer access</button></div>
    <section class="billing-admin-holds" aria-live="polite" aria-busy="${admin.holdsLoading?"true":"false"}"><div class="billing-admin-holds-heading"><div><span class="billing-kicker">Bounded safe summaries · up to ${BILLING_ADMIN_HOLD_LIMIT}</span><h4>Open financial holds</h4></div></div><p class="muted">Only the event category and opening time are shown. Raw webhooks, card data, provider/customer/subscription/invoice identifiers, and secrets are never rendered here.</p>${billingAdminFinancialHoldsHtml()}</section>
  </div>`:"";
  return `<section class="gov-card gov-wide billing-admin-panel" id="billingAdminRoot"><div class="billing-heading"><div><span class="billing-kicker">Global administrator only · AAL2 required</span><h3>Billing administration</h3></div></div>
    ${billingAdminRefundReviewsHtml()}
    <div class="billing-admin-section-heading"><span class="billing-kicker">Exact account lookup</span><h4>Developer access and financial holds</h4></div>
    <p class="muted">Look up one account by its exact verified email or exact account UUID. Results expose only a masked email and safe membership summary—never Stripe customer, subscription, or payment identifiers.</p>
    <form class="billing-admin-search" onsubmit="billingAdminLookup(event)"><label for="billingAdminQuery">Exact verified email or exact account UUID</label><div><input id="billingAdminQuery" autocomplete="off" spellcheck="false" value="${billingEsc(admin.query)}" placeholder="person@example.com or UUID"><button class="btn sec" type="submit" ${controlsBusy?"disabled":""}>${admin.loading?"Looking up…":"Look up account"}</button></div></form>
    ${admin.error?`<div class="billing-callout billing-error" role="alert">${billingEsc(admin.error)}</div>`:""}${admin.message?`<div class="billing-callout billing-good" role="status">${billingEsc(admin.message)}</div>`:""}${resultHtml}
  </section>`;
}
function billingPaintAdmin(preferredFocusId=""){
  const root=typeof document!=="undefined"?document.getElementById("billingAdminRoot"):null;if(!root)return;
  const active=typeof document.activeElement==="object"&&document.activeElement&&typeof root.contains==="function"&&root.contains(document.activeElement)?String(document.activeElement.id||""):"",focusId=preferredFocusId||active;
  root.outerHTML=billingAdminPanelHtml();
  const target=focusId?document.getElementById(focusId):null;
  if(target&&typeof target.focus==="function"){try{target.focus({preventScroll:true})}catch(_error){target.focus()}}
}
async function billingAdminLoadRefundReviews(alreadySteppedUp=false,focusAfterLoad=""){
  const owner=billingOwnerId();if(!owner||!billingPlatformQueueRoute()||billingState.admin.refundsLoading||billingState.admin.refundActionBusy)return;
  const generation=++billingState.admin.refundRequestGeneration,authGeneration=billingAuthGeneration();
  if(!alreadySteppedUp){
    const steppedUp=typeof requireAal2ForSensitiveAction==="function"&&await requireAal2ForSensitiveAction("view duplicate-subscription refund reviews");
    if(!billingAdminRefundCurrent(owner,generation,authGeneration))return;
    if(!steppedUp){billingState.admin.refunds=[];billingState.admin.refundsLoaded=false;billingState.admin.refundsError="Two-factor verification is required before refund reviews can be loaded.";billingPaintAdmin();return}
  }
  billingState.admin.refundsLoading=true;billingState.admin.refundsError="";billingPaintAdmin("billingAdminRefundReviews");
  let response;
  try{response=await sb.rpc("billing_admin_duplicate_refund_reviews",{p_limit:BILLING_ADMIN_REFUND_LIMIT})}catch(_error){response={data:null,error:{message:"request failed"}}}
  if(!billingAdminRefundCurrent(owner,generation,authGeneration)){if(billingAdminRefundSameAccountRequest(owner,generation,authGeneration))billingState.admin.refundsLoading=false;return}
  billingState.admin.refundsLoading=false;
  if(response?.error){billingState.admin.refunds=[];billingState.admin.refundsLoaded=false;billingState.admin.refundsError="Duplicate-refund summaries could not be verified. No approval control is available.";billingPaintAdmin();return}
  try{billingState.admin.refunds=billingNormalizeRefundReviews(response?.data);billingState.admin.refundsLoaded=true;billingState.admin.refundsError=""}catch(_error){billingState.admin.refunds=[];billingState.admin.refundsLoaded=false;billingState.admin.refundsError="The refund-review query returned an invalid safe summary. No approval control is available."}
  billingPaintAdmin(focusAfterLoad||"billingAdminRefundReviews");
}
async function billingAdminApproveRefund(index){
  const owner=billingOwnerId(),review=Number.isInteger(index)?billingState.admin.refunds[index]:null;
  if(!owner||!review||!billingPlatformQueueRoute()||!BILLING_REFUND_ACTIONABLE_STATES.has(review.state)||billingState.admin.refundsLoading||billingState.admin.refundActionBusy)return;
  const draft=billingAdminCaptureRefundDraft(index),expected=billingRefundConfirmation(review);
  if(!draft||draft.confirmation!==expected){billingState.admin.refundsError=`Type the exact amount and currency ${expected} before approving this refund.`;billingPaintAdmin(`billingRefundConfirmation_${index}`);return}
  if(draft.reason.length<10||draft.reason.length>1000){billingState.admin.refundsError="Enter a specific duplicate-refund approval reason between 10 and 1000 characters.";billingPaintAdmin(`billingRefundReason_${index}`);return}
  if(!draft.acknowledged){billingState.admin.refundsError="Explicitly acknowledge this exact original-method refund before continuing.";billingPaintAdmin(`billingRefundAck_${index}`);return}
  const selectionGeneration=billingState.admin.refundRequestGeneration,authGeneration=billingAuthGeneration(),reviewId=review.reviewId;
  const steppedUp=typeof requireAal2ForSensitiveAction==="function"&&await requireAal2ForSensitiveAction("approve and execute this exact duplicate-subscription refund");
  if(!billingAdminRefundCurrent(owner,selectionGeneration,authGeneration,reviewId))return;
  if(!steppedUp){billingState.admin.refundsError="Two-factor verification is required before a duplicate refund can be approved.";billingPaintAdmin(`billingRefundAction_${index}`);return}
  const warning=`Approve ${expected} for ${review.maskedEmail} under opaque review ${reviewId}? The server will verify the canceled duplicate and original payment method again before any refund is attempted.`;
  if(typeof confirm==="function"&&!confirm(warning))return;
  billingState.admin.refundActionBusy=reviewId;billingState.admin.refundsError="";billingState.admin.refundMessage="";
  const generation=++billingState.admin.refundRequestGeneration;billingPaintAdmin("billingAdminRefundReviews");
  let response;
  try{response=await sb.functions.invoke("billing-admin-refund-duplicate",{body:{remediationId:reviewId,reason:draft.reason}})}catch(_error){response={data:null,error:{message:"request failed"}}}
  if(!billingAdminRefundCurrent(owner,generation,authGeneration,reviewId)){if(billingAdminRefundSameAccountRequest(owner,generation,authGeneration))billingState.admin.refundActionBusy="";return}
  billingState.admin.refundActionBusy="";
  const raw=response?.data,state=String(raw?.state||""),amount=raw?.amount,currency=String(raw?.currency||"").toLowerCase();
  if(response?.error||!raw||!["refunded","provider_pending"].includes(state)||!Number.isSafeInteger(amount)||amount!==review.amountMinor||currency!==review.currency){billingState.admin.refundsError="The exact duplicate refund was not confirmed by the server. Do not assume money moved; refresh the review before any retry.";billingPaintAdmin(`billingRefundAction_${index}`);return}
  delete billingState.admin.refundDrafts[reviewId];
  billingState.admin.refundMessage=state==="refunded"?`${expected} was independently confirmed refunded by the server.`:`${expected} is pending at the provider. Signed webhook reconciliation is still required before completion is assumed.`;
  await billingAdminLoadRefundReviews(true,"billingAdminRefundReviews");
}
async function billingAdminLookup(event,quiet=false){
  event?.preventDefault?.();
  const owner=billingOwnerId(),input=typeof document!=="undefined"?document.getElementById("billingAdminQuery"):null;
  if(!owner)return;
  let query=String(input?.value??billingState.admin.query).trim();
  if(BILLING_EMAIL.test(query))query=query.toLowerCase();
  if(query.length>320||(!BILLING_UUID.test(query)&&!BILLING_EMAIL.test(query))){
    billingState.admin.error="Enter one exact verified email address or one exact account UUID.";billingState.admin.result=null;billingPaintAdmin();return;
  }
  billingState.admin.query=query;billingState.admin.loading=true;billingState.admin.error="";billingState.admin.result=null;billingState.admin.holds=[];billingState.admin.holdsLoading=false;billingState.admin.holdsError="";billingState.admin.holdActionBusy="";billingState.admin.holdDraftReasons={};if(!quiet)billingState.admin.message="";billingPaintAdmin();
  const generation=++billingState.admin.requestGeneration,authGeneration=billingAuthGeneration();
  let response;
  try{response=await sb.rpc("billing_admin_lookup_account",{p_query:query})}catch(_error){response={data:null,error:{message:"request failed"}}}
  if(!billingAdminCurrent(owner,generation,authGeneration))return;
  billingState.admin.loading=false;
  if(response?.error){billingState.admin.result=null;billingState.admin.error="No matching account could be safely returned. Verify the exact email or UUID and your global-administrator access.";billingPaintAdmin();return}
  try{billingState.admin.result=billingNormalizeAdminAccount(response?.data);billingState.admin.error="";billingState.admin.draftReason="";billingState.admin.draftExpiry="";billingState.admin.draftAck=false}catch(_error){billingState.admin.result=null;billingState.admin.error="The account lookup did not return a valid safe summary.";billingPaintAdmin();return}
  const accountId=billingState.admin.result.accountId;
  billingState.admin.holdsLoading=true;billingPaintAdmin();
  let holdsResponse;
  try{holdsResponse=await sb.rpc("billing_admin_financial_holds",{p_account_id:accountId,p_limit:BILLING_ADMIN_HOLD_LIMIT})}catch(_error){holdsResponse={data:null,error:{message:"request failed"}}}
  if(!billingAdminCurrent(owner,generation,authGeneration,accountId))return;
  billingState.admin.holdsLoading=false;
  if(holdsResponse?.error){billingState.admin.holds=[];billingState.admin.holdsError="Open financial holds could not be safely verified for this account. Developer changes remain disabled.";billingPaintAdmin();return}
  try{billingState.admin.holds=billingNormalizeFinancialHolds(holdsResponse?.data,accountId);billingState.admin.holdsError=""}catch(_error){billingState.admin.holds=[];billingState.admin.holdsError="The financial-hold lookup returned an invalid summary. No reconciliation control is available."}
  billingPaintAdmin();
}
function billingAdminInputs(){
  const reason=String(document.getElementById("billingAdminReason")?.value||"").trim(),expiryValue=String(document.getElementById("billingAdminExpiry")?.value||"").trim(),ack=!!document.getElementById("billingAdminDispositionAck")?.checked;
  billingState.admin.draftReason=reason;billingState.admin.draftExpiry=expiryValue;billingState.admin.draftAck=ack;
  let expiresAt=null;
  if(reason.length<10||reason.length>500)return{error:"Enter a specific audit reason between 10 and 500 characters."};
  if(!ack)return{error:"Acknowledge that paid subscription disposition must be resolved separately."};
  if(expiryValue){const parsed=new Date(expiryValue);if(!Number.isFinite(parsed.getTime())||parsed.getTime()<=Date.now()+60000)return{error:"Developer access expiry must be a valid date and time at least one minute in the future."};expiresAt=parsed.toISOString()}
  return{reason,expiresAt,error:""};
}
async function billingAdminGrantDeveloper(){return billingAdminChangeDeveloper(true)}
async function billingAdminRevokeDeveloper(){return billingAdminChangeDeveloper(false)}
async function billingAdminChangeDeveloper(grant){
  const owner=billingOwnerId(),account=billingState.admin.result;
  if(!owner||!account||billingState.admin.actionBusy||billingState.admin.holdsLoading||billingState.admin.holdsError||billingState.admin.holdActionBusy)return;
  const selectionGeneration=billingState.admin.requestGeneration,authGeneration=billingAuthGeneration(),accountId=account.accountId;
  if(grant&&(billingAdminGrantBlocked(account)||billingState.admin.holds.length)){billingState.admin.error=billingState.admin.holds.length?"Reconcile every open financial hold after external verification, then run the exact account lookup again before granting developer access.":"Schedule the renewable subscription to cancel at period end, then run the exact account lookup again before granting developer access.";billingPaintAdmin();return}
  const input=billingAdminInputs();
  if(input.error){billingState.admin.error=input.error;billingPaintAdmin();return}
  const action=grant?"grant free developer access":"revoke developer access";
  if(typeof requireAal2ForSensitiveAction!=="function"||!await requireAal2ForSensitiveAction(action))return;
  if(!billingAdminCurrent(owner,selectionGeneration,authGeneration,accountId))return;
  const target=account.maskedEmail||account.accountId;
  const warning=grant?`Grant developer access to ${target}? This does not cancel or refund any paid subscription.`:`Revoke developer access from ${target}? This does not create or resume billing, and access may suspend immediately.`;
  if(typeof confirm==="function"&&!confirm(warning))return;
  billingState.admin.actionBusy=true;billingState.admin.error="";billingState.admin.message="";
  const generation=++billingState.admin.requestGeneration;
  let response;
  try{
    response=grant
      ?await sb.rpc("billing_admin_grant_developer",{p_account_id:account.accountId,p_reason:input.reason,p_expires_at:input.expiresAt})
      :await sb.rpc("billing_admin_revoke_developer",{p_account_id:account.accountId,p_reason:input.reason});
  }catch(_error){response={data:null,error:{message:"request failed"}}}
  if(!billingAdminCurrent(owner,generation,authGeneration,accountId))return;
  billingState.admin.actionBusy=false;
  if(response?.error){billingState.admin.error="The developer-access change was not confirmed by the server. No success is assumed.";billingPaintAdmin();return}
  try{billingState.admin.result=billingNormalizeAdminAccount(response?.data)}catch(_error){billingState.admin.error="The change may have completed, but its updated safe summary could not be verified. Run the exact lookup again.";billingPaintAdmin();return}
  billingState.admin.message=grant?"Developer access was granted and the updated server status was verified.":"Developer access was revoked and the updated server status was verified.";
  billingState.admin.draftReason="";billingState.admin.draftExpiry="";billingState.admin.draftAck=false;
  billingState.admin.error="";billingPaintAdmin();
}

async function billingAdminReconcileFinancialHold(index){
  const owner=billingOwnerId(),account=billingState.admin.result,hold=Number.isInteger(index)?billingState.admin.holds[index]:null;
  if(!owner||!account||!hold||billingState.admin.loading||billingState.admin.holdsLoading||billingState.admin.actionBusy||billingState.admin.holdActionBusy)return;
  const reason=String(document.getElementById(`billingHoldReason_${index}`)?.value||"").trim();
  billingState.admin.holdDraftReasons[hold.holdId]=reason;
  if(reason.length<10||reason.length>1000){billingState.admin.error="Enter a specific financial-hold reconciliation reason between 10 and 1000 characters.";billingPaintAdmin();return}
  const selectionGeneration=billingState.admin.requestGeneration,authGeneration=billingAuthGeneration(),accountId=account.accountId,holdId=hold.holdId;
  const steppedUp=typeof requireAal2ForSensitiveAction==="function"&&await requireAal2ForSensitiveAction("reconcile this exact financial hold after external provider verification");
  if(!billingAdminCurrent(owner,selectionGeneration,authGeneration,accountId)||billingState.admin.holds[index]?.holdId!==holdId)return;
  if(!steppedUp){billingState.admin.error="Two-factor verification is required before a financial hold can be reconciled.";billingPaintAdmin();return}
  const warning=`Reconcile this ${billingFinancialEventLabel(hold.eventType).toLowerCase()} hold only after you verified the provider outcome outside MyPersonas? This may restore access from the account's current stored entitlement. It does not issue a refund, close a dispute, cancel a subscription, or prove provider resolution.`;
  if(typeof confirm==="function"&&!confirm(warning))return;
  billingState.admin.holdActionBusy=holdId;billingState.admin.error="";billingState.admin.message="";
  const generation=++billingState.admin.requestGeneration;billingPaintAdmin();
  let response;
  try{response=await sb.rpc("billing_admin_reconcile_financial_hold",{p_hold_id:holdId,p_reason:reason})}catch(_error){response={data:null,error:{message:"request failed"}}}
  if(!billingAdminCurrent(owner,generation,authGeneration,accountId))return;
  billingState.admin.holdActionBusy="";
  if(response?.error||response?.data!==true){billingState.admin.error="The financial-hold reconciliation was not confirmed by the server. No access restoration is assumed.";billingPaintAdmin();return}
  billingState.admin.message="The exact hold reconciliation was recorded. Refreshing this account and its remaining open holds now.";
  await billingAdminLookup(undefined,true);
}
