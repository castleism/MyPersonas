"use strict";

// Persona view never changes authentication. It freezes one exact owned persona
// as the social actor, while server projections decide what that actor may see.
const PERSONA_VIEW_OWNER_ROUTES = new Set([
  "studio", "edit", "review", "persona-settings", "business-settings",
  "agent-board", "platform-queue", "briefs", "schedule", "fan-inbox",
  "activity", "notifications", "discovery", "onboard",
]);

let personaViewFeedState = null;

function personaViewModeGuard() {
  return {
    uid: session?.user?.id || "",
    authGeneration: typeof authLoadGeneration === "number" ? authLoadGeneration : -1,
    perspectiveGeneration: ownerAppState.perspectiveGeneration,
    viewMode: ownerAppState.viewMode,
  };
}

function personaViewModeGuardCurrent(guard) {
  return !!guard && !!guard.uid && session?.user?.id === guard.uid
    && (typeof authLoadGeneration !== "number" || authLoadGeneration === guard.authGeneration)
    && ownerAppState.perspectiveGeneration === guard.perspectiveGeneration
    && ownerAppState.viewMode === guard.viewMode;
}

function personaViewActorCanInteract(persona = ownerAppPersonaModeActor()) {
  return !!persona
    && persona.publication_state === "published"
    && persona.published_revision === persona.publication_revision
    && ["public", "unlisted"].includes(persona.visibility);
}

function personaViewActorCanManageRelationships(persona = ownerAppPersonaModeActor()) {
  return !!persona
    && persona.publication_state === "published"
    && persona.published_revision === persona.publication_revision;
}

function personaViewRelationshipActors() {
  return (myPersonas || []).filter((persona) => personaViewActorCanManageRelationships(persona));
}

function personaViewActorStatus(persona = ownerAppPersonaModeActor(), capabilities = null) {
  if (!persona) return "No acting persona is selected.";
  if (capabilities) {
    if (capabilities.can_interact === true) return "Interactions are sent as this exact persona. Your account remains the authenticated authority.";
    if (capabilities.can_manage_relationships === true) return "This private persona can manage existing friendship and follow relationships, but cannot create new public-facing interactions.";
    return "New activity is paused because the server cannot verify a current published page. Safety cleanup, such as deleting this persona’s earlier comments, remains available.";
  }
  if (persona.publication_state !== "published") return "This persona is a draft. Persona view is read-only until its page is reviewed and published.";
  if (persona.published_revision !== persona.publication_revision) return "This persona changed after publication. Persona view is read-only until the current revision is reviewed and republished.";
  if (!["public", "unlisted"].includes(persona.visibility)) return "This private persona can manage existing friendship and follow relationships, but cannot create new public-facing interactions.";
  return "Interactions are sent as this exact persona. Your account remains the authenticated authority.";
}

function syncPersonaViewChrome() {
  const switcher = document.getElementById("personaViewSwitcher");
  const signedIn = !!session && (typeof privateSessionReady === "undefined" || privateSessionReady === true);
  const hasRoster = signedIn && (myPersonas || []).length > 0;
  let actor = ownerAppSelectedPersonaStrict();
  if (ownerAppState.viewMode === "persona" && !actor) {
    ownerAppState.viewMode = "overview";
    ownerAppState.perspectiveGeneration += 1;
    ownerAppRememberViewMode();
  }
  const personaMode = hasRoster && ownerAppState.viewMode === "persona" && !!actor;
  if (switcher) switcher.hidden = !hasRoster;
  const overview = document.getElementById("overviewModeBtn"), persona = document.getElementById("personaModeBtn");
  if (overview) overview.setAttribute("aria-pressed", String(!personaMode));
  if (persona) persona.setAttribute("aria-pressed", String(personaMode));
  const picker = document.getElementById("personaViewActor");
  if (picker && hasRoster) {
    picker.innerHTML = myPersonas.map((row) => `<option value="${esc(row.id)}" ${row.id === actor?.id ? "selected" : ""}>${esc(row.name)} · @${esc(row.handle)}</option>`).join("");
    picker.hidden = !personaMode;
  }
  document.body.classList.toggle("persona-view-mode", personaMode);
  if (personaMode) document.body.style.setProperty("--persona-mode-color", safeTheme(actor.theme));
  else document.body.style.removeProperty("--persona-mode-color");
  document.querySelectorAll("[data-overview-nav]").forEach((element) => { element.hidden = personaMode; });
  const myPage = document.getElementById("personaMyPageBtn");if (myPage) myPage.hidden = !personaMode;
  const home = document.getElementById("primaryHomeBtn");if (home) home.textContent = personaMode ? `${actor.name} home` : "Home";
  const mobileNav = document.getElementById("ownerMobileNav");if (mobileNav && personaMode) mobileNav.hidden = true;
  const companion = document.getElementById("ownerPersonaCompanion");if (companion && personaMode) companion.hidden = true;
}

function personaViewRouteGuard(view) {
  if (!ownerAppIsPersonaMode()) return false;
  if (!PERSONA_VIEW_OWNER_ROUTES.has(view)) return false;
  toast("That owner workspace is available in Overview. Persona view is still active.");
  if (location.hash !== "#/owner") location.hash = "#/owner";
  else renderPersonaViewHome();
  return true;
}

function openActingPersonaPage() {
  const actor = ownerAppPersonaModeActor();
  if (!actor) { ownerAppSetViewMode("overview"); return; }
  go(`p/${actor.handle}`);
}

function personaViewSidebarHtml() {
  const actor = ownerAppPersonaModeActor();if (!actor) return "";
  return `<div class="persona-mode-identity" style="--persona-mode-color:${safeTheme(actor.theme)}">
    <span class="persona-mode-avatar" style="${safeBgStyle(actor.avatar_url)}"></span>
    <span style="min-width:0"><span class="persona-mode-badge">Acting persona</span><b>${esc(actor.name)}</b><small>@${esc(actor.handle)}</small></span>
  </div><div class="persona-mode-rail-actions">
    <button class="railitem" onclick="go('owner')">${ico("feed")}<span>Friends &amp; family</span></button>
    <button class="railitem" onclick="go('p/${esc(actor.handle)}')">${ico("mask")}<span>My page</span></button>
    <button class="railitem" onclick="go('')">${ico("compass")}<span>Discover</span></button>
    <button class="railitem" onclick="ownerAppSetViewMode('overview')">${ico("crown")}<span>Return to Overview</span></button>
  </div>`;
}

async function resolveSocialActor(candidates = myPersonas, actionLabel = "interact") {
  const pool = (Array.isArray(candidates) ? candidates : []).filter((candidate) => ownerAppSelectedPersonaStrict(candidate?.id));
  const guard = personaViewModeGuard();
  if (!guard.uid) { toast("Sign in to " + actionLabel); return null; }
  if (ownerAppIsPersonaMode()) {
    const actor = ownerAppPersonaModeActor();
    if (!actor) {
      toast(`${actor?.name || "The selected persona"} cannot ${actionLabel}. ${personaViewActorStatus(actor)}`);
      return null;
    }
    const snapshot = ownerAppPerspectiveSnapshot(actor.id);
    return ownerAppPerspectiveSnapshotCurrent(snapshot) ? { id: actor.id, persona: actor, snapshot } : null;
  }
  const id = await pickMine(pool);
  if (!id || !personaViewModeGuardCurrent(guard)) return null;
  const selected = pool.find((candidate) => candidate.id === id) || null;
  if (!selected) return null;
  const snapshot = ownerAppPerspectiveSnapshot(id);
  return ownerAppPerspectiveSnapshotCurrent(snapshot) ? { id, persona: selected, snapshot } : null;
}

function socialActionSnapshotCurrent(actor) {
  return !!actor && ownerAppPerspectiveSnapshotCurrent(actor.snapshot)
    && !!ownerAppSelectedPersonaStrict(actor.id);
}

async function loadPersonaModePostPanel(postId, element) {
  const actor = ownerAppPersonaModeActor();if (!actor || !element) return;
  const snapshot = ownerAppPerspectiveSnapshot(actor.id);element.innerHTML = '<p class="muted">Loading…</p>';
  const result = await sb.rpc("my_persona_mode_post_panel", { p_actor_persona_id: actor.id, p_post_id: postId });
  if (!ownerAppPerspectiveSnapshotCurrent(snapshot) || !document.body.contains(element)) return;
  if (result.error || !result.data) { element.innerHTML = '<p class="muted">Comments are unavailable in this persona view.</p>';return; }
  const comments = result.data.comments || [], reactions = result.data.reactions || [], counts = {}, mine = {};
  REACT_KINDS.forEach(([kind]) => { counts[kind] = 0;mine[kind] = false; });
  reactions.forEach((reaction) => { counts[reaction.kind] = (counts[reaction.kind] || 0) + 1;if (reaction.owned_by_actor) mine[reaction.kind] = true; });
  const canAct = result.data.can_interact === true;
  const reactBar = REACT_KINDS.map(([kind, label]) => `<button class="rbtn${mine[kind] ? " on" : ""}" ${canAct ? `onclick="toggleReaction('${postId}','${kind}')"` : "disabled"}>${label} ${counts[kind] || ""}</button>`).join("");
  const list = comments.map((comment) => `<div class="cmt"><b>${esc(comment.persona_name || "A persona")} @${esc(comment.persona_handle || "")}</b> <span class="muted">${new Date(comment.created_at).toLocaleDateString()}</span><div style="white-space:pre-wrap">${esc(comment.body)}</div>${comment.owned_by_actor ? `<button class="btn danger sm" style="margin-top:4px" onclick="deleteComment('${comment.id}','${postId}')">Delete</button>` : ""}</div>`).join("") || '<p class="muted">No comments yet.</p>';
  const capabilities = { can_interact: canAct, can_manage_relationships: result.data.can_manage_relationships === true };
  const box = canAct ? `<div class="cbox"><textarea id="ci_${postId}" placeholder="Write a comment as ${esc(actor.name)}…"></textarea><button class="btn sm" onclick="addComment('${postId}')">Comment</button></div>` : `<p class="muted">${esc(personaViewActorStatus(actor, capabilities))}</p>`;
  const boundedNotice = result.data.comments_truncated || result.data.reactions_truncated ? '<p class="muted">Showing the newest 100 visible comments and up to 500 visible reactions.</p>' : "";
  element.innerHTML = `<div class="rbar">${reactBar}</div>${boundedNotice}${list}${box}`;
}

function personaViewConnectionCard(row) {
  return `<button class="persona-connection-card" data-handle="${esc(row.handle)}" onclick="go('p/'+this.dataset.handle)">
    <span class="avatar" style="${safeBgStyle(row.avatar_url)}"></span><span class="copy"><b>${esc(row.name)}</b><small>@${esc(row.handle)}${row.relationship_label ? ` · ${esc(row.relationship_label)}` : ""}</small></span>
  </button>`;
}

function personaViewConnectionSection(title, rows, empty) {
  return `<section class="persona-connection-section"><h3>${esc(title)}</h3>${rows.length ? `<div class="persona-connection-grid">${rows.map(personaViewConnectionCard).join("")}</div>` : `<div class="persona-mode-empty">${esc(empty)}</div>`}</section>`;
}

function personaViewRequestCard(row, incoming) {
  const actions = incoming
    ? `<button class="btn sm" onclick="personaModeRespondFriend('${row.relationship_id}',true)">Accept</button><button class="btn sec sm" onclick="personaModeRespondFriend('${row.relationship_id}',false)">Decline</button>`
    : `<button class="btn sec sm" onclick="personaModeCancelFriendRequest('${row.relationship_id}')">Cancel request</button>`;
  const identity = row.persona_id && row.handle
    ? `<button class="persona-request-main" data-handle="${esc(row.handle)}" onclick="go('p/'+this.dataset.handle)"><span class="avatar" style="${safeBgStyle(row.avatar_url)}"></span><span class="copy"><b>${esc(row.name)}</b><small>@${esc(row.handle)}</small></span></button>`
    : `<div class="persona-request-main" role="group" aria-label="Private persona identity withheld"><span class="avatar"></span><span class="copy"><b>Private persona</b><small>Profile details are unavailable</small></span></div>`;
  return `<div class="persona-request-card">${identity}<div class="persona-request-actions">${actions}</div></div>`;
}

function personaViewRequestSection(title, rows, incoming, empty) {
  return `<section class="persona-connection-section"><h3>${esc(title)}</h3>${rows.length ? `<div class="persona-request-grid">${rows.map((row) => personaViewRequestCard(row, incoming)).join("")}</div>` : `<div class="persona-mode-empty">${esc(empty)}</div>`}</section>`;
}

function personaViewPostPersona(row) {
  return { id: row.persona_id, handle: row.persona_handle, name: row.persona_name, avatar_url: row.persona_avatar_url, theme: row.persona_theme };
}

function renderPersonaViewFeedRows() {
  const state = personaViewFeedState, list = document.getElementById("personaViewFeed"), more = document.getElementById("personaViewFeedMore");
  if (!state || !list) return;
  list.innerHTML = state.rows.map((row) => postHtml(row, personaViewPostPersona(row), false)).join("") || '<div class="persona-mode-empty">No posts from this persona’s visible circle yet.</div>';
  if (more) more.innerHTML = state.done ? "" : `<button class="btn sec" onclick="loadMorePersonaViewFeed()" ${state.loading ? "disabled" : ""}>${state.loading ? "Loading…" : "Load more"}</button>`;
}

async function loadMorePersonaViewFeed() {
  const state = personaViewFeedState, actor = ownerAppPersonaModeActor();
  if (!state || !actor || state.actorId !== actor.id || state.loading || state.done) return;
  const snapshot = ownerAppPerspectiveSnapshot(actor.id);state.loading = true;renderPersonaViewFeedRows();
  const last = state.rows.at(-1), result = await sb.rpc("my_persona_mode_feed", { p_actor_persona_id: actor.id, p_before_created_at: last?.created_at || null, p_before_id: last?.id || null, p_limit: 30 });
  if (!ownerAppPerspectiveSnapshotCurrent(snapshot) || personaViewFeedState !== state) return;
  state.loading = false;if (result.error) { toast("Persona feed could not be loaded");state.done = true;renderPersonaViewFeedRows();return; }
  const seen = new Set(state.rows.map((row) => row.id)), rows = (result.data || []).filter((row) => !seen.has(row.id));state.rows.push(...rows);state.done = rows.length < 30;renderPersonaViewFeedRows();
}

function personaViewSetupRequired(actor, error) {
  const missing = /schema cache|could not find the function|pgrst202/i.test(String(error?.message || error || ""));
  app.innerHTML = `<div class="persona-mode-head"><div><span class="persona-mode-badge">Acting as ${esc(actor.name)}</span><h2>Friends &amp; family</h2></div><button class="btn sec" onclick="ownerAppSetViewMode('overview')">Return to Overview</button></div>
    <div class="persona-mode-notice readonly"><b>${missing ? "Persona-view migration 058 is not applied here." : "Persona view could not be loaded."}</b><br>${missing ? "The UI is installed, but it will not fall back to account-wide reads. Apply and verify migration 058 before this server can return an exact-actor feed." : esc(error?.message || "Try again later.")}</div>`;
}

async function renderPersonaViewHome(epoch = ++renderEpoch) {
  if (!session) { renderSignin(); return; }
  const actor = ownerAppPersonaModeActor();if (!actor) { ownerAppSetViewMode("overview", false);return renderOwnerCommandCenter(); }
  const snapshot = ownerAppPerspectiveSnapshot(actor.id);syncPersonaViewChrome();
  app.innerHTML = '<div class="empty">Loading this persona’s circle…</div>';
  const [statusResult, connectionsResult, feedResult] = await Promise.all([
    sb.rpc("my_persona_mode_status", { p_actor_persona_id: actor.id }),
    sb.rpc("my_persona_mode_connections", { p_actor_persona_id: actor.id }),
    sb.rpc("my_persona_mode_feed", { p_actor_persona_id: actor.id, p_before_created_at: null, p_before_id: null, p_limit: 30 }),
  ]);
  if (epoch !== renderEpoch || !ownerAppPerspectiveSnapshotCurrent(snapshot)) return;
  if (statusResult.error || connectionsResult.error || feedResult.error) return personaViewSetupRequired(actor, statusResult.error || connectionsResult.error || feedResult.error);
  const connections = connectionsResult.data || [], friends = connections.filter((row) => row.connection_kind === "friend"), family = connections.filter((row) => row.connection_kind === "family"), following = connections.filter((row) => row.connection_kind === "following"), followers = connections.filter((row) => row.connection_kind === "follower"), incoming = connections.filter((row) => row.connection_kind === "friend_incoming"), outgoing = connections.filter((row) => row.connection_kind === "friend_outgoing");
  personaViewFeedState = { actorId: actor.id, rows: feedResult.data || [], loading: false, done: (feedResult.data || []).length < 30 };
  const capabilities = statusResult.data || {}, canAct = capabilities.can_interact === true, canManage = capabilities.can_manage_relationships === true;
  app.innerHTML = `<div class="persona-mode-head"><div><span class="persona-mode-badge">Acting as ${esc(actor.name)} · @${esc(actor.handle)}</span><h2>Your persona circle</h2><p>Friends, requests, followers, reviewed public family, and followed personas visible to this exact identity.</p></div><div class="persona-peer-actions"><button class="btn" onclick="openActingPersonaPage()">View my page</button><button class="btn sec" onclick="go('')">Discover</button></div></div>
    <div class="persona-mode-notice ${canAct ? "" : "readonly"}"><b>${canAct ? "Persona view is active." : canManage ? "Limited persona view." : "New activity is paused."}</b> ${esc(personaViewActorStatus(actor, capabilities))}</div>
    <p class="muted">Connection cards are bounded to 200 per load; actionable pending requests are prioritized.</p>
    ${personaViewRequestSection("Incoming friend requests", incoming, true, "No incoming friend requests for this persona.")}
    ${personaViewRequestSection("Sent friend requests", outgoing, false, "No pending sent requests from this persona.")}
    ${personaViewConnectionSection("Friends", friends, "No accepted friendships visible to this persona.")}
    ${personaViewConnectionSection("Family", family, "No reviewed public family cards visible to this persona.")}
    ${personaViewConnectionSection("Following", following, "This persona is not following anyone yet.")}
    ${personaViewConnectionSection("Followers", followers, "This persona has no visible followers yet.")}
    <section class="persona-connection-section"><h3>Circle feed</h3><div id="personaViewFeed"></div><div id="personaViewFeedMore" style="text-align:center;margin-top:12px"></div></section>`;
  renderPersonaViewFeedRows();
}

function personaPeerRelationshipButtons(payload) {
  const actor = ownerAppPersonaModeActor(), target = payload.persona, relation = payload.relationship || {}, canAct = payload.actor?.can_interact === true, canManage = payload.actor?.can_manage_relationships === true;
  if (!actor || !target || actor.id === target.id) return "";
  const follow = relation.following
    ? canManage ? `<button class="btn sec" onclick="personaModeFollow('${target.id}',true)">Unfollow</button>` : '<button class="btn sec" disabled>Unfollow unavailable</button>'
    : canAct && ["public", "unlisted"].includes(target.visibility) ? `<button class="btn sec" onclick="personaModeFollow('${target.id}',false)">Follow</button>` : '<button class="btn sec" disabled>Follow unavailable</button>';
  let friend = canAct ? `<button class="btn" onclick="personaModeRequestFriend('${target.id}')">Add friend</button>` : '<button class="btn" disabled>Add friend unavailable</button>';
  if (relation.friendship_status === "accepted") friend = canManage ? `<button class="btn sec" onclick="personaModeUnfriend('${target.id}')">Remove friend</button>` : '<button class="btn sec" disabled>Friendship management unavailable</button>';
  else if (relation.friendship_status === "pending" && relation.friendship_direction === "outgoing") friend = canManage ? `<button class="btn sec" onclick="personaModeCancelFriendRequest('${relation.friendship_request_id}')">Requested — cancel</button>` : '<button class="btn sec" disabled>Request pending</button>';
  else if (relation.friendship_status === "pending" && relation.friendship_direction === "incoming") friend = canManage ? `<button class="btn" onclick="personaModeRespondFriend('${relation.friendship_request_id}',true)">Accept request</button><button class="btn sec" onclick="personaModeRespondFriend('${relation.friendship_request_id}',false)">Decline</button>` : '<button class="btn sec" disabled>Request awaiting a current published persona</button>';
  return follow + friend;
}

function personaModeConfiguredPageHtml(payload, fanAvailable, isSelf, canAct) {
  const p = payload.persona, links = payload.links || [], posts = payload.posts || [], albums = payload.albums || [], relationCards = payload.relation_cards || [], revenue = payload.revenue || null;
  const pageLayout = normalizePersonaPageLayout(payload.layout), modules = p.modules || {}, M = (key) => modules[key] !== false;
  const toRelative = (row) => ({ id: row.relative_persona_id, handle: row.relative_handle, name: row.relative_name, avatar_url: row.relative_avatar_url, tagline: row.relative_tagline, relationship_label: row.relationship_label });
  const top8 = relationCards.filter((row) => row.dependency_kind === "top8").sort((a, b) => a.sort_order - b.sort_order).map(toRelative);
  const linked = relationCards.filter((row) => row.dependency_kind === "linked").sort((a, b) => a.sort_order - b.sort_order).map(toRelative);
  const family = relationCards.filter((row) => row.dependency_kind === "family").sort((a, b) => a.sort_order - b.sort_order).map(toRelative);
  const albumHtml = albums.map((album) => `<div class="card"><h3>${ico(album.kind === "affiliate" ? "cart" : "album")}${esc(album.title)} ${album.kind === "affiliate" ? '<span class="pill priv">sponsored</span>' : ""}</h3><div class="albgrid">${(album.items || []).map((item) => { const thumb = safeHttpUrl(item.thumb_url), link = safeHttpUrl(item.link_url), mark = MyPersonasAiProvenance.publicMarkerHtml(thumb, "image"), inner = `${thumb ? `<img class="${isSelf ? "persona-asset " : ""}${MyPersonasAiProvenance.imagePresentationClass(thumb)}" src="${esc(thumb)}" loading="lazy" draggable="false" alt="${esc(item.caption || album.title)}" ${personaAssetAttributes(thumb, item.caption || album.title, isSelf, "image")}>${mark}` : ""}<span class="cap">${esc(item.caption) || "&nbsp;"}</span>${link ? '<span class="goicon">↗</span>' : ""}`;return link ? `<a class="albitem${mark ? " has-ai-provenance" : ""}" href="${esc(link)}" target="_blank" rel="noopener${album.kind === "affiliate" ? " sponsored" : ""}">${inner}</a>` : `<span class="albitem${mark ? " has-ai-provenance" : ""}">${inner}</span>`; }).join("") || '<p class="muted">empty album</p>'}</div></div>`).join("");
  return `${isSelf && canAct ? composerHtml(p) : ""}<div class="persona-layout-grid" style="--pc:${safeTheme(p.theme)}">
    ${M("live") && p.live_url ? `<section class="${personaLayoutItemClass(pageLayout, "live")}" style="${personaLayoutItemStyle(pageLayout, "live")}"><div class="card livebox"><h3>${ico("live")}Live now</h3>${liveHtml(p.live_url)}</div></section>` : ""}
    ${M("music") && p.music_url ? `<section class="${personaLayoutItemClass(pageLayout, "music")}" style="${personaLayoutItemStyle(pageLayout, "music")}"><div class="card music"><h3>${ico("music")}Profile song</h3>${musicHtml(p.music_url)}</div></section>` : ""}
    ${M("about") ? `<section class="${personaLayoutItemClass(pageLayout, "about")}" style="${personaLayoutItemStyle(pageLayout, "about")}"><div class="card"><h3>${ico("spark")}About</h3><p style="white-space:pre-wrap">${esc(p.bio) || '<span class="muted">nothing yet…</span>'}</p><div style="margin-top:10px;padding:10px;border:1px solid #cbd8e9;border-radius:10px;background:#f6f9fd"><b>AI transparency</b><div class="muted" style="margin-top:3px">${esc(p.ai_disclosure || "This is an AI-assisted persona. Public content may be drafted with AI and is owner-reviewed unless stated otherwise.")}</div></div>${p.topics ? `<div style="margin-top:8px">${p.topics.split(",").filter((topic) => topic.trim()).map((topic) => `<span class="tag2" data-page-search="${esc(topic.trim())}" onclick="pageSearch(this.dataset.pageSearch)">${esc(topic.trim())}</span>`).join("")}</div>` : ""}</div></section>` : ""}
    ${M("fan_chat") && fanAvailable ? `<section class="${personaLayoutItemClass(pageLayout, "fan_chat")}" style="${personaLayoutItemStyle(pageLayout, "fan_chat")}"><div class="card"><h3>${ico("spark")}Chat with ${esc(p.name)}'s AI</h3><p class="muted">This is a disclosed AI assistant, not the human owner. The owner can see saved chats and open private-session chats. If the owner joins live, every human reply is labeled Owner.</p><button class="btn sm" onclick="openPublicFanChat('${p.id}')">Start fan chat</button></div></section>` : ""}
    ${M("links") && links.length ? `<section class="${personaLayoutItemClass(pageLayout, "links")}" style="${personaLayoutItemStyle(pageLayout, "links")}"><div class="card"><h3>${ico("link")}Find me on</h3>${links.map((link) => { const platform = PLATS[link.platform] || PLATS.other, url = safeHttpUrl(link.url);return url ? `<a class="chip" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${ico("node")}${esc(link.handle || platform.name)}</a>` : ""; }).join("")}</div></section>` : ""}
    ${M("top8") && top8.length ? `<section class="${personaLayoutItemClass(pageLayout, "top8")}" style="${personaLayoutItemStyle(pageLayout, "top8")}"><div class="card"><h3>${ico("crown")}Top ${top8.length}</h3><div class="top8grid">${top8.map((relative) => `<div class="t8" data-handle="${esc(relative.handle)}" onclick="go('p/'+this.dataset.handle)"><div class="av8" style="${safeBgStyle(relative.avatar_url)}"></div>${esc(relative.name)}</div>`).join("")}</div></div></section>` : ""}
    ${M("linked") && linked.length ? `<section class="${personaLayoutItemClass(pageLayout, "linked")}" style="${personaLayoutItemStyle(pageLayout, "linked")}"><div class="card"><h3>${ico("mask")}More of me</h3>${linked.map((relative) => `<div class="t8pick" style="cursor:pointer" data-handle="${esc(relative.handle)}" onclick="go('p/'+this.dataset.handle)"><img src="${esc(safeHttpUrl(relative.avatar_url))}" onerror="this.style.visibility='hidden'"><div><b>${esc(relative.name)}</b><br><span class="muted">${esc(relative.tagline || "@" + relative.handle)}</span></div></div>`).join("")}</div></section>` : ""}
    ${M("family") && family.length ? `<section class="${personaLayoutItemClass(pageLayout, "family")}" style="${personaLayoutItemStyle(pageLayout, "family")}"><div class="card"><h3>${ico("user")}Family</h3>${family.map((relative) => `<div class="t8pick" style="cursor:pointer" data-handle="${esc(relative.handle)}" onclick="go('p/'+this.dataset.handle)"><img src="${esc(safeHttpUrl(relative.avatar_url))}" onerror="this.style.visibility='hidden'"><div><b>${esc(relative.name)}</b><br><span class="muted">${esc(relative.relationship_label || "family")}</span></div></div>`).join("")}</div></section>` : ""}
    ${M("revenue") ? personaRevenueHtml(revenue, p, isSelf, pageLayout) : ""}
    ${M("albums") && albumHtml ? `<section class="${personaLayoutItemClass(pageLayout, "albums")}" style="${personaLayoutItemStyle(pageLayout, "albums")}">${albumHtml}</section>` : ""}
    ${M("feed") ? `<section class="${personaLayoutItemClass(pageLayout, "feed")}" style="${personaLayoutItemStyle(pageLayout, "feed")}"><div class="card">${safeHttpUrl(p.feed_img_url) ? `<img class="${isSelf ? "persona-asset" : ""}" src="${esc(safeHttpUrl(p.feed_img_url))}" style="display:block;width:100%;height:auto;object-fit:contain;border-radius:12px;margin-bottom:10px" alt="Feed header" ${personaAssetAttributes(p.feed_img_url, "Feed header", isSelf, "image")}>` : ""}<h3>${ico("feed")}${esc(p.name)}'s feed</h3><input id="feedSearch" placeholder="search this page… (e.g. laptop reviews)" onkeydown="if(event.key==='Enter')pageSearch(this.value)"><div class="feedchips"><span class="chip on" id="fk_all" onclick="setFeedKind('all')">All</span><span class="chip" id="fk_post" onclick="setFeedKind('post')">Posts</span><span class="chip" id="fk_reel" onclick="setFeedKind('reel')">Reels</span></div></div><div id="feedList">${posts.map((post) => postHtml(post, p, false, isSelf)).join("") || '<div class="persona-mode-empty">No posts visible to this persona.</div>'}</div><div id="personaFeedMoreWrap" style="text-align:center;margin-top:16px">${pageState.feedDone ? "" : '<button class="btn sec" id="personaFeedMoreBtn" onclick="loadMorePersonaFeed()">Load more posts</button>'}</div></section>` : ""}
    ${pageLayout.widgets.map(personaLayoutWidgetHtml).join("")}
  </div>`;
}

async function renderPersonaModeProfile(handle, skipGate = false, epoch = ++renderEpoch) {
  const actor = ownerAppPersonaModeActor();if (!actor) { ownerAppSetViewMode("overview", false);return renderPersonaPage(handle, skipGate, epoch); }
  const snapshot = ownerAppPerspectiveSnapshot(actor.id);app.innerHTML = '<div class="empty">Loading persona view…</div>';
  const result = await sb.rpc("my_persona_mode_profile", { p_actor_persona_id: actor.id, p_handle: handle, p_post_limit: PERSONA_FEED_PAGE_SIZE });
  if (epoch !== renderEpoch || !ownerAppPerspectiveSnapshotCurrent(snapshot)) return;
  if (result.error) return personaViewSetupRequired(actor, result.error);
  const payload = result.data, p = payload?.persona;if (!p) { app.innerHTML = '<div class="empty">This page is not visible to the acting persona.</div>';return; }
  if (p.nsfw && !skipGate && !sessionStorage.getItem("age_ok")) {
    app.innerHTML = `<div class="card authbox center"><h2>18+ Content</h2><p>This page may contain adult content. You must be 18 or older to continue.</p><button class="btn" onclick="sessionStorage.setItem('age_ok','1');renderPersonaModeProfile('${esc(handle)}',true)">I'm 18+, enter</button><button class="btn sec" onclick="go('owner')">Go back</button></div>`;return;
  }
  let fanAvailable = false;if (["public", "unlisted"].includes(p.visibility) && p.publication_state === "published") fanAvailable = await publicFanChatStatus(p.id);
  if (epoch !== renderEpoch || !ownerAppPerspectiveSnapshotCurrent(snapshot)) return;
  const safeBackground = safeHttpUrl(p.bg_url);if (safeBackground) { document.body.classList.add("custom-bg");document.body.style.backgroundImage = `url(${JSON.stringify(safeBackground)})`; }
  const posts = payload.posts || [], isSelf = p.id === actor.id, pageLayout = normalizePersonaPageLayout(payload.layout);
  pageState = { p, posts, isOwner: false, assetOwner: isSelf, personaMode: true, actorId: actor.id, layout: pageLayout, feedKind: "all", feedQuery: "", cursorCreatedAt: null, cursorId: null, feedDone: posts.length < PERSONA_FEED_PAGE_SIZE, feedLoading: false, feedRequestId: 0, feedError: "" };
  advanceDescendingCursor(pageState, posts);
  setMeta(`${p.name} (@${p.handle}) — AliaSpaces`, (p.tagline || p.bio || "A persona on AliaSpaces").slice(0, 160));
  const canAct = payload.actor?.can_interact === true, canManage = payload.actor?.can_manage_relationships === true, sameOwner = (myPersonas || []).some((owned) => owned.id === p.id);
  app.innerHTML = `<div class="persona-peer-shell"><div class="persona-mode-notice ${canAct ? "" : "readonly"}"><b>Acting as ${esc(actor.name)}.</b> ${esc(personaViewActorStatus(actor, payload.actor || {}))}</div>
    <div class="banner${isSelf && safeHttpUrl(p.banner_url) ? " persona-asset" : ""}" style="--pc:${safeTheme(p.theme)};${safeBgStyle(p.banner_url)}" ${personaAssetAttributes(p.banner_url, "Banner image", isSelf, "image")}></div><div class="pp-head"><div class="pp-av${isSelf && safeHttpUrl(p.avatar_url) ? " persona-asset" : ""}" style="${safeBgStyle(p.avatar_url)}" ${personaAssetAttributes(p.avatar_url, "Profile image", isSelf, "image")}></div><div style="flex:1;padding-bottom:6px"><div class="pp-name">${esc(p.name)} ${p.pet_project ? `<span class="pill" style="background:#eafff1;color:#0a7d33">★ ${esc(p.pet_project)}</span>` : ""} ${p.nsfw ? '<span class="pill nsfw">18+</span>' : ""} ${p.visibility !== "public" ? `<span class="pill priv">${esc(p.visibility)}</span>` : ""} ${p.live_url ? '<span class="pill live">LIVE</span>' : ""}</div><div class="muted" style="background:rgba(255,255,255,.86);display:inline-block;padding:2px 8px;border-radius:8px">@${esc(p.handle)} · ${isSelf ? "your acting page" : payload.relationship?.friendship_status === "accepted" ? `friend of @${esc(actor.handle)}` : `viewed as @${esc(actor.handle)}`} — ${esc(p.tagline || "")}</div></div><div class="persona-peer-actions">${personaPeerRelationshipButtons(payload)}<button class="btn sec sm" onclick="sharePage('${esc(p.handle)}')">Share</button>${isSelf && safeHttpUrl(p.bg_url) ? `<button class="btn sec sm" data-persona-asset-url="${esc(safeHttpUrl(p.bg_url))}" data-persona-asset-label="Page background" data-persona-asset-kind="image" onclick="openPersonaAssetPreview(this,event)">Preview background</button>` : ""}${!sameOwner ? `<button class="btn danger sm" title="Account-wide: affects every persona you own" onclick="blockPersona('${p.id}','block')">Block for all my personas</button><button class="btn sec sm" title="Account-wide: affects every persona you own" onclick="blockPersona('${p.id}','mute')">Mute for all my personas</button>` : ""}</div></div>
    ${!canAct && canManage ? '<div class="persona-mode-notice readonly">Existing relationship controls remain available, while new outward public interactions stay disabled.</div>' : ""}
    ${personaModeConfiguredPageHtml(payload, fanAvailable, isSelf, canAct)}</div>`;
}

async function personaModeFollow(targetId, remove = false) {
  const actor = await resolveSocialActor(remove ? personaViewRelationshipActors() : publicInteractionPersonas(), remove ? "unfollow" : "follow");if (!actor) return;
  const result = await sb.rpc(remove ? "persona_mode_unfollow_persona" : "persona_mode_follow_persona", { p_actor_persona_id: actor.id, p_target_persona_id: targetId });
  if (!socialActionSnapshotCurrent(actor)) return;if (result.error) { toast(result.error.message);return; }toast(remove ? "Unfollowed" : "Following");route();
}

async function personaModeRequestFriend(targetId) {
  const actor = await resolveSocialActor(publicInteractionPersonas(), "send a friend request");if (!actor) return;
  const policy = await sb.rpc("public_persona_friend_policy", { p_persona_id: targetId });if (!socialActionSnapshotCurrent(actor)) return;
  const mode = policy.data?.[0]?.request_mode || "open";if (policy.error) { toast(policy.error.message);return; }if (mode === "contact_proof") { toast("Private contact proof is not configured yet");return; }
  let inviteToken = "";if (mode === "invite_proof") { inviteToken = (prompt("Enter the owner-issued invite proof. It is sent only to the database verifier and is never saved in this browser.") || "").trim();if (!inviteToken || !socialActionSnapshotCurrent(actor)) return; }
  const result = await sb.rpc("persona_mode_request_friendship", { p_actor_persona_id: actor.id, p_target_persona_id: targetId, p_invite_token: inviteToken || null });inviteToken = "";
  if (!socialActionSnapshotCurrent(actor)) return;if (result.error) { toast(result.error.message);return; }toast(result.data?.message || "Friend request could not be completed");if (result.data?.ok) route();
}

async function personaModeRespondFriend(requestId, accept) {
  const actor = await resolveSocialActor(personaViewRelationshipActors(), accept ? "accept this friend request" : "decline this friend request");if (!actor) return;
  const result = await sb.rpc("persona_mode_respond_friendship", { p_actor_persona_id: actor.id, p_request_id: requestId, p_accept: !!accept });if (!socialActionSnapshotCurrent(actor)) return;
  if (result.error) { toast(result.error.message);return; }toast(accept ? (result.data ? "Friends!" : "Request closed because one account blocked the other") : "Request declined");route();
}

async function personaModeCancelFriendRequest(requestId) {
  const actor = await resolveSocialActor(personaViewRelationshipActors(), "cancel this friend request");if (!actor) return;
  const result = await sb.rpc("persona_mode_cancel_friendship_request", { p_actor_persona_id: actor.id, p_request_id: requestId });if (!socialActionSnapshotCurrent(actor)) return;
  if (result.error) { toast(result.error.message);return; }toast(result.data ? "Request canceled" : "Request was already closed");route();
}

async function personaModeUnfriend(targetId) {
  const actor = await resolveSocialActor(personaViewRelationshipActors(), "remove this friendship");if (!actor) return;
  const result = await sb.rpc("persona_mode_remove_friendship", { p_actor_persona_id: actor.id, p_other_persona_id: targetId });if (!socialActionSnapshotCurrent(actor)) return;
  if (result.error) { toast(result.error.message);return; }toast("Removed");route();
}
