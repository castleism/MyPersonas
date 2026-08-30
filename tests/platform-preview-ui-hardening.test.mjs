import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root=path.resolve(import.meta.dirname,"..");
const html=await readFile(path.join(root,"MyPersonas.Online_v0/index.html"),"utf8");

function functionBody(name){
  const start=html.indexOf(`function ${name}(`);
  assert.notEqual(start,-1,`${name} must exist`);
  const next=html.indexOf("\nfunction ",start+10);
  return html.slice(start,next<0?html.length:next);
}

test("platform frames show the complete source with truthful safe-area guidance",()=>{
  const css=html.slice(html.indexOf(".platformpreviewoverlay{"),html.indexOf(".daypick{"));
  assert.match(css,/\.platformpreviewframe::after\{[^}]*Placement safe area/);
  assert.match(css,/\.platformpreviewframe\.frame-vertical\{[^}]*aspect-ratio:9\/16/);
  assert.match(css,/\.platformpreviewframe\.frame-landscape\{[^}]*aspect-ratio:16\/9/);
  assert.match(css,/\.platformpreviewmedia\{[^}]*object-fit:contain/);
  assert.doesNotMatch(css,/object-fit:cover/);
  const framing=functionBody("platformPreviewFramingText");
  assert.match(framing,/complete source is shown without a simulated crop/);
  assert.match(framing,/vary by device and provider UI/);
});

test("embedded images and videos fail closed until their bytes are ready",()=>{
  const media=functionBody("platformPreviewSingleMediaHtml")+functionBody("platformPreviewMediaHtml"),initialize=functionBody("initializePlatformPreviewRequirements"),requirements=functionBody("platformPreviewRequirementsReady"),update=functionBody("updatePlatformPreviewConfirmation"),confirm=functionBody("confirmPlatformPreviewDialog");
  assert.match(media,/data-platform-preview-media data-preview-ready="pending"/);
  assert.match(media,/data-platform-preview-requirement data-preview-ready="failed"/);
  assert.match(media,/Loading image preview/);
  assert.match(media,/Loading a visible video frame/);
  assert.match(initialize,/addEventListener\("load"/);
  assert.match(initialize,/addEventListener\("loadeddata"/);
  assert.match(initialize,/addEventListener\("playing",markReviewed/);
  assert.match(initialize,/addEventListener\("seeked",markReviewed/);
  assert.match(initialize,/addEventListener\("error"/);
  assert.match(initialize,/media\.complete/);
  assert.match(initialize,/media\.readyState>=2/);
  assert.match(requirements,/item\.dataset\.previewReady==="ready"/);
  assert.match(update,/check\.disabled=!ready/);
  assert.match(update,/if\(!ready\)check\.checked=false/);
  assert.match(update,/confirmButton\.disabled=!ready\|\|!check\?\.checked/);
  assert.match(confirm,/!platformPreviewRequirementsReady\(overlay\)/);
});

test("the acknowledgement and action button stay disabled across pending, failed, and unopened states",()=>{
  const requirementsBody=functionBody("platformPreviewRequirementsReady"),updateBody=functionBody("updatePlatformPreviewConfirmation"),update=new Function(`${requirementsBody}\n${updateBody}\nreturn updatePlatformPreviewConfirmation;`)();
  const check={disabled:false,checked:true,dataset:{},setAttribute(){}},confirm={disabled:false},status={dataset:{},textContent:""};
  let cards=[{}],media=[{dataset:{previewReady:"failed"}}],external=[];
  const overlay={querySelector(selector){if(selector===".platformpreviewcard")return cards[0]||null;if(selector==="#platformPreviewAck")return check;if(selector==="#platformPreviewConfirm")return confirm;if(selector==="#platformPreviewReadiness")return status;return null},querySelectorAll(selector){if(selector===".platformpreviewcard")return cards;if(selector==="[data-platform-preview-media]")return media;if(selector==="[data-platform-preview-external-ack]")return external;return[]}};
  assert.equal(update(overlay),false);
  assert.equal(check.disabled,true);
  assert.equal(check.checked,false);
  assert.equal(confirm.disabled,true);
  assert.equal(status.dataset.state,"failed");

  media=[{dataset:{previewReady:"ready"}}];
  assert.equal(update(overlay),true);
  assert.equal(check.disabled,false);
  assert.equal(confirm.disabled,true);
  check.checked=true;
  assert.equal(update(overlay),true);
  assert.equal(confirm.disabled,false);

  external=[{dataset:{opened:"false"},checked:false}];
  assert.equal(update(overlay),false);
  assert.equal(check.disabled,true);
  assert.equal(check.checked,false);
  external=[{dataset:{opened:"true"},checked:true}];
  assert.equal(update(overlay),true);
  assert.equal(check.disabled,false);

  cards=[];
  assert.equal(update(overlay),false);
  assert.equal(check.disabled,true);
  assert.equal(status.dataset.state,"failed");
});

test("non-embeddable attachments require both opening and explicit acknowledgement",()=>{
  const media=functionBody("platformPreviewSingleMediaHtml")+functionBody("platformPreviewMediaHtml"),initialize=functionBody("initializePlatformPreviewRequirements"),requirements=functionBody("platformPreviewRequirementsReady");
  assert.match(media,/data-platform-preview-external-link/);
  assert.match(media,/data-platform-preview-external-ack data-opened="false" disabled/);
  assert.match(media,/I opened the exact source and reviewed it/);
  assert.match(initialize,/link\.addEventListener\("click",markOpened\)/);
  assert.match(initialize,/ack\.dataset\.opened="true"/);
  assert.match(initialize,/ack\.disabled=false/);
  assert.match(requirements,/item\.dataset\.opened==="true"&&item\.checked/);
});

test("media readiness reports intrinsic dimensions and video duration",()=>{
  const durationBody=functionBody("platformPreviewDurationText"),factsBody=functionBody("platformPreviewMediaFacts"),facts=new Function(`${durationBody}\n${factsBody}\nreturn platformPreviewMediaFacts;`)();
  assert.equal(facts({tagName:"IMG",naturalWidth:1200,naturalHeight:628}),"1200 × 628 px");
  assert.equal(facts({tagName:"VIDEO",videoWidth:1920,videoHeight:1080,duration:65}),"1920 × 1080 px · duration 1:05");
  const ready=functionBody("platformPreviewMarkMediaReady");
  assert.match(ready,/platformPreviewMediaFacts\(media\)/);
  assert.match(ready,/Media ready/);
});

test("immediate actions have explicit post-approval timing while scheduled items keep their exact time",()=>{
  const timingBody=functionBody("platformPreviewTimingText"),timing=new Function("autoTaskDate","autoTz",`${timingBody}\nreturn platformPreviewTimingText;`)((value,zone)=>`DATE:${value}:${zone}`,()=>"UTC");
  assert.equal(timing({mode:"Publish immediately"}),"Immediately after approval");
  assert.equal(timing({mode:"Owner-triggered message now"}),"Immediately after approval");
  assert.equal(timing({mode:"Save as provider draft"}),"Not scheduled");
  assert.equal(timing({mode:"Publish now",timingLabel:"Complete in provider after approval"}),"Complete in provider after approval");
  assert.equal(timing({scheduledFor:"2026-09-01T12:00:00Z",timezone:"America/Anchorage"}),"DATE:2026-09-01T12:00:00Z:America/Anchorage · America/Anchorage");
  const card=functionBody("platformPreviewCardHtml");
  assert.match(card,/<b>Timing:<\/b> \$\{esc\(time\)\}/);
  assert.match(card,/platformPreviewTimingText\(item\)/);
});

test("the owner acknowledgement retains target, copy, media, and timing scope without promising an exact provider crop",()=>{
  const dialog=functionBody("openPlatformPreviewDialog");
  assert.match(dialog,/exact target\/account/);
  assert.match(dialog,/full copy and counts/);
  assert.match(dialog,/every media asset/);
  assert.match(dialog,/safe-area guidance/);
  assert.match(dialog,/action timing/);
  assert.match(dialog,/provider can still vary/);
  assert.doesNotMatch(dialog,/exact (?:provider )?crop|exact media crop/i);
  assert.match(dialog,/role="status" aria-live="polite"/);
});

test("multi-asset, exact-target, copy-limit, and required-media gates are shared",()=>{
  const mediaEntries=functionBody("platformPreviewMediaEntries"),mediaHtml=functionBody("platformPreviewMediaHtml"),card=functionBody("platformPreviewCardHtml"),requirements=functionBody("platformPreviewRequirementsReady");
  assert.match(mediaEntries,/item\?\.mediaItems/);
  assert.match(mediaHtml,/media\.map\(\(entry,mediaIndex\)=>platformPreviewSingleMediaHtml/);
  assert.match(mediaHtml,/requiredMediaMissing/);
  assert.match(mediaHtml,/requiresMedia/);
  assert.match(card,/requiresExactTarget/);
  assert.match(card,/exactTargetReady/);
  assert.match(card,/platformPreviewCopyMeter/);
  assert.match(requirements,/data-platform-preview-requirement/);
});

test("two-step provider actions render only their server-authored timing and placement",()=>{
  const twitch=functionBody("recordTwitchActionPreview"),patreon=functionBody("reviewPatreonHandoff");
  for(const source of [twitch,patreon]){
    assert.match(source,/exactProviderActionPreview/);
    assert.match(source,/\.\.\.receipt\.preview/);
    assert.doesNotMatch(source,/items:\s*\[\s*\{/);
    assert.doesNotMatch(source,/timingLabel\s*:/);
  }
});
