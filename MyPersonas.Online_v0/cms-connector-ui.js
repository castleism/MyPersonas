/* Draft-only Wix Blog and WordPress owner controls.
 *
 * This file deliberately adds no publish or provider-schedule action. The
 * provider mutation is limited to creating or trashing a draft, and creation
 * is re-gated by the server against migration-069's exact preview evidence.
 */
(function cmsConnectorUi() {
  "use strict";

  const CMS_PROVIDERS = new Set(["wix", "wordpress"]);
  const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const reconcileNeeded = new Set();
  const trashCheckpointNeeded = new Set();
  let decorateTimer = 0;
  let decorating = false;

  function e(value) {
    return typeof esc === "function" ? esc(String(value == null ? "" : value)) : String(value == null ? "" : value);
  }

  function providerName(provider) {
    return provider === "wix" ? "Wix" : "WordPress";
  }

  function setupUrl(provider) {
    return `provider-setup.html#${provider}-readiness`;
  }

  function connectionRow(account) {
    return myAccountConnections.find((row) => row.ledger_id === account.id && row.provider === account.provider) || null;
  }

  async function cmsAction(functionName, payload) {
    return await providerPostAction(functionName, payload);
  }

  function safeLaunch(url) {
    const target = safeHttpUrl(url);
    if (!target || !target.startsWith("https://")) return false;
    location.assign(target);
    return true;
  }

  function addConnectionControls() {
    if (
      typeof ledgerAuthPanel !== "function" ||
      ledgerAuthPanel.cmsDraftOnlyWrapped
    ) return;
    const base = ledgerAuthPanel;
    const wrapped = function cmsLedgerAuthPanel(account, info) {
      const html = base(account, info);
      if (!CMS_PROVIDERS.has(account.provider)) return html;
      const connected = info.state === "connected";
      const needsWixAuthor = account.provider === "wix" &&
        info.state === "verified" &&
        info.row?.error_code === "author_selection_required";
      let buttons = "";
      if (account.provider === "wix") {
        buttons = connected ? `<button class="btn sm danger" onclick="disconnectCmsAccount('wix','${e(account.id)}')">Disconnect Wix site</button>` : needsWixAuthor ? `<button class="btn sm" onclick="chooseWixAuthor('${e(account.id)}')">Choose exact Wix author</button><button class="btn sm danger" onclick="disconnectCmsAccount('wix','${e(account.id)}')">Remove local Wix connection</button>` : `<button class="btn sm" onclick="connectCmsAccount('wix','${e(account.id)}')">Connect Wix site</button>`;
      } else {
        buttons = connected ? `<button class="btn sm danger" onclick="disconnectCmsAccount('wordpress','${e(account.id)}')">Disconnect WordPress</button>` : `<button class="btn sm" onclick="connectCmsAccount('wordpress','${e(account.id)}')">Connect WordPress.com</button><button class="btn sm sec" onclick="openSelfHostedWordPress('${e(account.id)}')">Use self-hosted WordPress</button>`;
      }
      const controls = `<div class="cms-account-controls" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line)"><p class="muted"><b>Draft-only CMS connection.</b> MyPersonas can create one private provider draft after an exact platform preview is approved. It cannot publish or schedule that draft.</p>${buttons}<a class="btn sm sec" href="${setupUrl(account.provider)}" target="_blank" rel="noopener">Setup steps ↗</a></div>`;
      return html.replace(/<\/div>\s*$/, `${controls}</div>`);
    };
    wrapped.cmsDraftOnlyWrapped = true;
    ledgerAuthPanel = wrapped;
  }

  window.connectCmsAccount = async function connectCmsAccount(
    provider,
    ledgerId,
  ) {
    if (!CMS_PROVIDERS.has(provider)) return;
    if (
      !await requireAal2ForSensitiveAction(`connect ${providerName(provider)}`)
    ) return;
    const capability = await cmsAction(`${provider}-oauth`, {
      action: "capabilities",
      ledgerId,
    });
    if (capability.error) {
      toast(capability.error);
      return;
    }
    const ready = provider === "wix" ? capability.data?.configured === true : capability.data?.wordpressComConfigured === true;
    if (!ready) {
      toast(
        `${providerName(provider)} still needs its developer app settings and Vault secret. Open the setup steps.`,
      );
      return;
    }
    const result = await cmsAction(`${provider}-oauth`, {
      action: "start",
      ledgerId,
    });
    if (result.error) {
      toast(result.error);
      return;
    }
    if (!safeLaunch(result.data?.launchUrl)) {
      toast(
        "The provider returned an invalid authorization link. Nothing was connected.",
      );
    }
  };

  window.chooseWixAuthor = async function chooseWixAuthor(ledgerId) {
    if (
      !await requireAal2ForSensitiveAction("choose the exact Wix Blog author")
    ) return;
    const result = await cmsAction("wix-oauth", {
      action: "list-authors",
      ledgerId,
    });
    if (result.error) {
      toast(result.error);
      return;
    }
    const authors = Array.isArray(result.data?.authors) ? result.data.authors : [];
    if (!authors.length) {
      toast(
        "Wix returned no eligible site members. Add the intended Blog writer on that site, then try again.",
      );
      return;
    }
    document.getElementById("wixAuthorOv")?.remove();
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.id = "wixAuthorOv";
    overlay.innerHTML = `<div class="wizbox" role="dialog" aria-modal="true" aria-labelledby="wixAuthorTitle"><h2 id="wixAuthorTitle">Choose the exact Wix author</h2><p class="muted">Site: <b>${e(result.data?.siteName || result.data?.siteId || "Selected Wix site")}</b>. This member ID becomes part of the immutable destination for every draft.</p><label for="wixAuthorChoice">Blog author</label><select id="wixAuthorChoice">${authors.map((author) => `<option value="${e(author.id)}">${e(author.name || author.id)} · ${e(author.id)}</option>`).join("")}</select><div class="autoformactions"><button class="btn" onclick="saveWixAuthor('${e(ledgerId)}')">Save exact author</button><button class="btn sec" onclick="document.getElementById('wixAuthorOv')?.remove()">Cancel</button></div></div>`;
    document.body.appendChild(overlay);
    document.getElementById("wixAuthorChoice")?.focus();
  };

  window.saveWixAuthor = async function saveWixAuthor(ledgerId) {
    const memberId = document.getElementById("wixAuthorChoice")?.value || "";
    const result = await cmsAction("wix-oauth", {
      action: "select-author",
      ledgerId,
      memberId,
    });
    if (result.error) {
      toast(result.error);
      return;
    }
    document.getElementById("wixAuthorOv")?.remove();
    await loadMine();
    acctTab = "accounts";
    renderStudio();
    toast(
      "Wix site and author connected. Only owner-approved provider drafts are enabled.",
    );
  };

  window.openSelfHostedWordPress = async function openSelfHostedWordPress(
    ledgerId,
  ) {
    const account = myAccounts.find((row) => row.id === ledgerId && row.provider === "wordpress");
    if (!account) return;
    if (!await requireAal2ForSensitiveAction("connect self-hosted WordPress")) {
      return;
    }
    document.getElementById("selfHostedWordPressOv")?.remove();
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.id = "selfHostedWordPressOv";
    overlay.innerHTML = `<div class="wizbox" role="dialog" aria-modal="true" aria-labelledby="selfHostedWordPressTitle"><h2 id="selfHostedWordPressTitle">Connect self-hosted WordPress</h2><p class="muted">Use a dedicated, revocable WordPress Application Password. It is sent once to the secure server and stored only in Vault—never in the account ledger or browser storage.</p><label for="wpSelfSite">Exact public HTTPS site</label><input id="wpSelfSite" type="url" inputmode="url" autocomplete="url" value="${e(account.url || "")}" placeholder="https://example.com"><label for="wpSelfUser">WordPress username</label><input id="wpSelfUser" autocomplete="username" autocapitalize="none" spellcheck="false" value="${
      e(account.username || "")
    }"><label for="wpSelfPassword">Application Password</label><input id="wpSelfPassword" type="password" autocomplete="new-password"><div class="autocallout"><b>Safety limits:</b> public HTTPS only, no redirects, private/internal IPs blocked, exact author must have <code>edit_posts</code>, and the first action remains Draft.</div><div class="autoformactions"><button class="btn" onclick="connectSelfHostedWordPress('${e(ledgerId)}')">Verify &amp; connect</button><button class="btn sec" onclick="document.getElementById('selfHostedWordPressOv')?.remove()">Cancel</button></div></div>`;
    document.body.appendChild(overlay);
    document.getElementById("wpSelfSite")?.focus();
  };

  window.connectSelfHostedWordPress = async function connectSelfHostedWordPress(
    ledgerId,
  ) {
    const siteUrl = document.getElementById("wpSelfSite")?.value.trim() || "";
    const username = document.getElementById("wpSelfUser")?.value.trim() || "";
    const passwordInput = document.getElementById("wpSelfPassword");
    const applicationPassword = passwordInput?.value || "";
    if (passwordInput) passwordInput.value = "";
    const result = await cmsAction("wordpress-oauth", {
      action: "connect-self-hosted",
      ledgerId,
      siteUrl,
      username,
      applicationPassword,
    });
    if (result.error) {
      toast(result.error);
      return;
    }
    document.getElementById("selfHostedWordPressOv")?.remove();
    await loadMine();
    acctTab = "accounts";
    renderStudio();
    toast(
      "Exact WordPress site and author connected. Only provider Draft creation is enabled.",
    );
  };

  function revocationNotice(provider, url) {
    document.getElementById("cmsRevocationOv")?.remove();
    const safe = safeHttpUrl(url);
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    overlay.id = "cmsRevocationOv";
    overlay.innerHTML = `<div class="wizbox" role="dialog" aria-modal="true"><h2>Finish ${e(providerName(provider))} revocation</h2><p>The encrypted MyPersonas credential was removed. Provider access is not claimed revoked until you remove the app or Application Password at ${e(providerName(provider))}.</p><div class="autoformactions">${safe ? `<a class="btn" href="${e(safe)}" target="_blank" rel="noopener">Open provider access settings ↗</a>` : ""}<button class="btn sec" onclick="document.getElementById('cmsRevocationOv')?.remove()">Close</button></div></div>`;
    document.body.appendChild(overlay);
  }

  window.disconnectCmsAccount = async function disconnectCmsAccount(
    provider,
    ledgerId,
  ) {
    if (!CMS_PROVIDERS.has(provider)) return;
    const warning = provider === "wix" ? "Remove MyPersonas' local Wix instance credential? You must then uninstall the app in Wix to revoke provider access. Existing Wix drafts remain." : "Remove MyPersonas' local WordPress credential? You must then revoke the connected app or Application Password at WordPress. Existing drafts remain.";
    if (!confirm(warning)) return;
    if (
      !await requireAal2ForSensitiveAction(
        `disconnect ${providerName(provider)}`,
      )
    ) return;
    const result = await cmsAction(`${provider}-oauth`, {
      action: "disconnect",
      ledgerId,
      confirmLocalDisconnect: true,
    });
    if (result.error) {
      toast(result.error);
      return;
    }
    await loadMine();
    acctTab = "accounts";
    renderStudio();
    revocationNotice(provider, result.data?.providerRevocationUrl || "");
  };

  function providerDraftControls(provider, draft, connection, stored) {
    const exactTarget = String(connection?.provider_subject || "");
    const approved = draft.approval_state === "approved";
    const connected = connection?.connection_state === "connected" &&
      exactTarget;
    // The first CMS proof is deliberately stricter than a URL validator: any
    // non-empty media value blocks the handoff, including malformed values.
    // The server repeats this as an exact empty-string requirement.
    const textOnly = String(draft.media_url || "").trim() === "";
    const exactPreviewCurrent = draft.approved_preview_version === "platform-preview-v1" &&
      String(draft.approved_preview_hash || "").length === 64 &&
      String(draft.approved_preview_target_id || "") === exactTarget;
    const available = approved && connected && exactPreviewCurrent &&
      textOnly &&
      String(draft.title || "").trim() &&
      !["publishing", "published"].includes(draft.publish_state);
    const name = providerName(provider);
    if (stored && trashCheckpointNeeded.has(draft.id)) {
      const edit = safeHttpUrl(stored.provider_edit_url);
      return `<div class="cms-draft-controls autocallout warn"><b>${e(name)} Trash result needs a local checkpoint.</b><br><span class="muted">Do not send another provider delete. Open the exact provider workspace and verify draft ${e(stored.provider_draft_id)} for target ${e(stored.exact_target_id)} is in Trash. Then record only that local checkpoint.</span><div class="queueactions" style="margin-top:8px">${edit ? `<a class="btn sm sec" href="${e(edit)}" target="_blank" rel="noopener">Open exact ${e(name)} workspace ↗</a>` : ""}<button class="btn sm" onclick="finalizeCmsTrashCheckpoint('${e(draft.id)}','${e(provider)}','${e(stored.provider_draft_id)}','${e(stored.exact_target_id)}')">I verified Trash — finalize checkpoint</button></div></div>`;
    }
    if (stored) {
      const preview = safeHttpUrl(stored.provider_preview_url);
      const edit = safeHttpUrl(stored.provider_edit_url);
      if (stored.provider_status === "trash") {
        return `<div class="cms-draft-controls autocallout warn"><b>${e(name)} provider draft moved to Trash.</b> It was never recorded as published. Edit the local draft to create a new approval-bound revision.</div>`;
      }
      return `<div class="cms-draft-controls autocallout"><b>${e(name)} draft verified by provider readback.</b><br><span class="muted">Exact target ${e(stored.exact_target_id)} · provider draft ${e(stored.provider_draft_id)} · not published · no provider schedule.</span><div class="queueactions" style="margin-top:8px">${preview ? `<a class="btn sm sec" href="${e(preview)}" target="_blank" rel="noopener">Preview provider draft ↗</a>` : ""}${edit ? `<a class="btn sm" href="${e(edit)}" target="_blank" rel="noopener">${provider === "wix" ? "Open exact Wix site dashboard" : "Edit provider draft"} ↗</a>` : ""}<button class="btn sm sec" onclick="verifyCmsDraft('${e(draft.id)}','${e(provider)}')">Verify exact draft</button><button class="btn sm danger" onclick="trashCmsDraft('${e(draft.id)}','${e(provider)}','${e(stored.provider_draft_id)}','${e(stored.exact_target_id)}')">Move provider draft to Trash</button></div>${
        provider === "wix" && !preview ? `<p class="muted" style="margin:8px 0 0">Wix does not expose a documented active-theme preview deep link for an unpublished API draft. In the exact site dashboard, open Blog → Posts → Drafts, choose provider draft ${e(stored.provider_draft_id)}, and use Wix's own preview before any later publish decision.</p>` : ""
      }</div>`;
    }
    if (reconcileNeeded.has(draft.id)) {
      return `<div class="cms-draft-controls autocallout warn"><b>${e(name)} result needs reconciliation.</b> Do not retry creation. Read the exact provider target and reconcile the prior attempt.<div class="queueactions" style="margin-top:8px"><button class="btn sm" onclick="reconcileCmsDraft('${e(draft.id)}','${e(provider)}')">Reconcile provider draft</button></div></div>`;
    }
    const reason = !connected ? `Connect this exact ${name} site and author first.` : !approved || !exactPreviewCurrent ? "Open and approve this draft's exact platform preview first." : !textOnly ? "The first CMS proof is text-only. Remove media, edit, and approve a fresh preview." : !String(draft.title || "").trim() ? "Add a title, then approve a fresh preview." : "This draft is already locked as publishing/published and cannot start a CMS proof.";
    return `<div class="cms-draft-controls autocallout ${available ? "" : "warn"}"><b>${e(name)} draft-only handoff.</b><br><span class="muted">${
      e(
        available ? "A second exact platform preview is shown before one provider Draft is created. This never publishes or schedules it." : reason,
      )
    }</span>${available ? `<div class="queueactions" style="margin-top:8px"><button class="btn sm" onclick="reviewCmsDraftHandoff('${e(draft.id)}','${e(provider)}')">Review exact preview &amp; create provider draft</button></div>` : ""}</div>`;
  }

  async function decorateQueue(force = false) {
    if (decorating || !session?.user?.id || typeof sb?.from !== "function") {
      return;
    }
    const allCards = [
      ...document.querySelectorAll(".queueitem[data-draft-id]"),
    ];
    if (!allCards.length) return;
    if (force) {
      allCards.forEach((card) => card.querySelector(".cms-draft-controls")?.remove());
    }
    const cards = allCards.filter((card) => !card.querySelector(".cms-draft-controls"));
    const rows = cards.map((card) => ({
      card,
      draft: myDrafts.find((draft) => draft.id === card.dataset.draftId),
    })).filter((item) =>
      item.draft &&
      CMS_PROVIDERS.has(
        myAccounts.find((account) => account.id === item.draft.account_id)
          ?.provider,
      )
    );
    if (!rows.length) return;
    decorating = true;
    try {
      const ids = rows.map((item) => item.draft.id);
      const [result, recovery] = await Promise.all([
        sb.from("cms_provider_drafts").select(
          "draft_id,provider,provider_draft_id,provider_status,provider_preview_url,provider_edit_url,exact_target_id,created_at",
        ).in("draft_id", ids).order("created_at", { ascending: false }),
        sb.rpc("my_cms_draft_recovery_status", { p_draft_ids: ids }),
      ]);
      const byDraft = new Map();
      if (!result.error) {
        (result.data || []).forEach((row) => {
          if (!byDraft.has(row.draft_id)) byDraft.set(row.draft_id, row);
        });
      }
      if (!recovery.error) {
        ids.forEach((id) => {
          reconcileNeeded.delete(id);
          trashCheckpointNeeded.delete(id);
        });
        (recovery.data || []).forEach((row) => {
          if (
            ["delete_claimed", "delete_outcome_unknown"].includes(
              row.recovery_state,
            )
          ) {
            trashCheckpointNeeded.add(row.draft_id);
          } else {
            reconcileNeeded.add(row.draft_id);
          }
        });
      }
      rows.forEach(({ card, draft }) => {
        if (!card.isConnected || card.querySelector(".cms-draft-controls")) {
          return;
        }
        const account = myAccounts.find((row) => row.id === draft.account_id);
        if (!account) return;
        card.querySelectorAll('button[onclick^="markManualDraftPosted("]')
          .forEach((button) => button.remove());
        const stored = byDraft.get(draft.id) || null;
        if (stored) {
          const localDelete = card.querySelector(
            'button[onclick^="deleteDraft("]',
          );
          if (localDelete) {
            localDelete.disabled = true;
            localDelete.title = "The local draft is retained with its provider audit record.";
          }
        }
        const wrapper = document.createElement("div");
        wrapper.innerHTML = providerDraftControls(
          account.provider,
          draft,
          connectionRow(account),
          stored,
        );
        const controls = wrapper.firstElementChild;
        const actions = card.querySelector(":scope > .queueactions");
        if (controls) card.insertBefore(controls, actions || null);
      });
    } finally {
      decorating = false;
    }
  }

  function scheduleDecoration(force = false) {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(() => decorateQueue(force), 40);
  }

  window.reviewCmsDraftHandoff = async function reviewCmsDraftHandoff(
    draftId,
    provider,
  ) {
    const draft = myDrafts.find((row) => row.id === draftId);
    const account = draft &&
      myAccounts.find((row) => row.id === draft.account_id && row.provider === provider);
    const connection = account && connectionRow(account);
    const target = String(connection?.provider_subject || "");
    if (!draft || !account || !target) {
      toast("The exact CMS site/author binding is no longer available.");
      return;
    }
    if (
      !await requireAal2ForSensitiveAction(
        `prepare the exact ${providerName(provider)} provider-draft preview`,
      )
    ) return;
    const prepared = await cmsAction(`${provider}-draft`, {
      action: "prepare-preview",
      draftId,
    });
    const receipt = prepared.data?.receipt;
    const preview = prepared.data?.preview;
    if (
      prepared.error || !receipt || !preview ||
      !SAFE_UUID.test(String(receipt.receiptId || "")) ||
      !/^[0-9a-f]{64}$/.test(String(receipt.receiptHash || "")) ||
      receipt.previewVersion !== "cms-provider-draft-preview-v1" ||
      !Array.isArray(preview.items) || preview.items.length !== 1
    ) {
      toast(
        prepared.error ||
          "The exact server-authored CMS preview could not be prepared.",
      );
      return;
    }
    openPlatformPreviewDialog({
      ...preview,
      title: `Review before creating the ${providerName(provider)} draft`,
      intro: "This is the server-authored exact approved text, site, author, and Draft-only action. Nothing will be published or scheduled.",
      confirmLabel: `Approve preview & create ${providerName(provider)} draft`,
      onConfirm: () => acknowledgeAndExecuteCmsDraftHandoff(
        draftId,
        provider,
        receipt,
      ),
    });
  };

  window.acknowledgeAndExecuteCmsDraftHandoff = async function acknowledgeAndExecuteCmsDraftHandoff(
    draftId,
    provider,
    receipt,
  ) {
    if (
      !await requireAal2ForSensitiveAction(
        `acknowledge the rendered ${providerName(provider)} preview`,
      )
    ) return;
    const acknowledged = await sb.rpc("acknowledge_provider_action_preview", {
      p_receipt_id: receipt.receiptId,
      p_receipt_hash: receipt.receiptHash,
      p_preview_version: receipt.previewVersion,
    });
    if (acknowledged.error || acknowledged.data?.acknowledged !== true) {
      toast(
        acknowledged.error?.message ||
          "That CMS preview expired or changed. Open a fresh preview.",
      );
      return;
    }
    await executeCmsDraftHandoff(draftId, provider, receipt.receiptId);
  };

  window.executeCmsDraftHandoff = async function executeCmsDraftHandoff(
    draftId,
    provider,
    receiptId,
  ) {
    if (!SAFE_UUID.test(String(receiptId || ""))) {
      toast("Open, render, and acknowledge a fresh server CMS preview first.");
      return;
    }
    if (
      !await requireAal2ForSensitiveAction(
        `create the exact ${providerName(provider)} provider draft`,
      )
    ) return;
    const result = await cmsAction(`${provider}-draft`, {
      action: "create-draft",
      draftId,
      receiptId,
    });
    if (
      result.status === 202 || result.data?.reconciliationRequired ||
      result.details?.reconciliationRequired
    ) {
      reconcileNeeded.add(draftId);
      toast(
        result.error || result.data?.error ||
          `${providerName(provider)} needs reconciliation. Do not retry creation.`,
      );
      scheduleDecoration(true);
      return;
    }
    if (result.error) {
      toast(result.error);
      return;
    }
    reconcileNeeded.delete(draftId);
    toast(
      `${providerName(provider)} created and read back one provider Draft. It is not published or scheduled.`,
    );
    scheduleDecoration(true);
  };

  window.reconcileCmsDraft = async function reconcileCmsDraft(
    draftId,
    provider,
  ) {
    if (
      !await requireAal2ForSensitiveAction(
        `reconcile the ${providerName(provider)} provider draft`,
      )
    ) return;
    const result = await cmsAction(`${provider}-draft`, {
      action: "reconcile",
      draftId,
    });
    if (result.status === 202 || result.error) {
      reconcileNeeded.add(draftId);
      toast(
        result.error || result.data?.error ||
          "The provider result is still uncertain. Do not retry creation.",
      );
      return;
    }
    reconcileNeeded.delete(draftId);
    toast(
      `${providerName(provider)} readback verified one exact provider Draft.`,
    );
    scheduleDecoration(true);
  };

  window.verifyCmsDraft = async function verifyCmsDraft(draftId, provider) {
    if (
      !await requireAal2ForSensitiveAction(
        `verify the exact ${providerName(provider)} provider draft`,
      )
    ) return;
    const result = await cmsAction(`${provider}-draft`, {
      action: "verify-draft",
      draftId,
    });
    if (result.error) {
      toast(result.error);
      return;
    }
    toast(
      `${providerName(provider)} still reports the exact item as an unpublished Draft.`,
    );
    scheduleDecoration(true);
  };

  window.trashCmsDraft = async function trashCmsDraft(
    draftId,
    provider,
    providerDraftId,
    exactTargetId,
  ) {
    const typedDraft = (prompt(
      `To move this provider draft to Trash, type its exact ${providerName(provider)} draft ID:\n${providerDraftId}`,
      "",
    ) || "").trim();
    if (typedDraft !== providerDraftId) {
      toast("Provider draft ID did not match. Nothing was changed.");
      return;
    }
    const typedTarget = (prompt(
      `Now type the exact bound site/author target:\n${exactTargetId}`,
      "",
    ) || "").trim();
    if (typedTarget !== exactTargetId) {
      toast("Provider target did not match. Nothing was changed.");
      return;
    }
    if (
      !await requireAal2ForSensitiveAction(
        `move the exact ${providerName(provider)} draft to Trash`,
      )
    ) return;
    const result = await cmsAction(`${provider}-draft`, {
      action: "delete-draft",
      draftId,
      confirmDelete: true,
      expectedProviderDraftId: providerDraftId,
      expectedTargetId: exactTargetId,
    });
    if (result.status === 202 || result.error) {
      if (
        result.status === 202 || result.data?.localCheckpointPending ||
        result.data?.outcomeUnknown ||
        result.details?.localCheckpointPending || result.details?.outcomeUnknown
      ) {
        trashCheckpointNeeded.add(draftId);
        scheduleDecoration(true);
      }
      toast(
        result.error ||
          "The provider delete result is uncertain. Verify it before any other action.",
      );
      return;
    }
    trashCheckpointNeeded.delete(draftId);
    toast(
      `${providerName(provider)} moved the exact provider draft to Trash; it was not permanently deleted.`,
    );
    scheduleDecoration(true);
  };

  window.finalizeCmsTrashCheckpoint = async function finalizeCmsTrashCheckpoint(
    draftId,
    provider,
    providerDraftId,
    exactTargetId,
  ) {
    const typedDraft = (prompt(
      `After confirming this item is visibly in provider Trash, type its exact ${providerName(provider)} draft ID:\n${providerDraftId}`,
      "",
    ) || "").trim();
    if (typedDraft !== providerDraftId) {
      toast(
        "Provider draft ID did not match. The local checkpoint was not changed.",
      );
      return;
    }
    const typedTarget = (prompt(
      `Type the exact bound site/author target:\n${exactTargetId}`,
      "",
    ) || "").trim();
    if (typedTarget !== exactTargetId) {
      toast(
        "Provider target did not match. The local checkpoint was not changed.",
      );
      return;
    }
    if (
      !await requireAal2ForSensitiveAction(
        `finalize the verified ${providerName(provider)} Trash checkpoint`,
      )
    ) return;
    const result = await cmsAction(`${provider}-draft`, {
      action: "finalize-trash-checkpoint",
      draftId,
      confirmProviderTrash: true,
      expectedProviderDraftId: providerDraftId,
      expectedTargetId: exactTargetId,
    });
    if (result.error) {
      toast(result.error);
      return;
    }
    trashCheckpointNeeded.delete(draftId);
    toast(
      `${providerName(provider)} Trash was recorded locally. No provider request was sent.`,
    );
    scheduleDecoration(true);
  };

  async function handleReturn() {
    if (!session?.user?.id) return false;
    const url = new URL(location.href);
    const wix = url.searchParams.get("wix");
    const wordpress = url.searchParams.get("wordpress");
    const ledger = url.searchParams.get("ledger") || "";
    if (!wix && !wordpress) return true;
    url.searchParams.delete("wix");
    url.searchParams.delete("wordpress");
    url.searchParams.delete("ledger");
    url.searchParams.delete("reason");
    history.replaceState(
      {},
      "",
      url.pathname + (url.search || "") + (url.hash || ""),
    );
    await loadMine();
    acctTab = "accounts";
    renderStudio();
    if (wix === "author_required" && ledger) {
      toast(
        "Wix installed on the selected site. Choose the exact blog author to finish the binding.",
      );
      await window.chooseWixAuthor(ledger);
    } else if (wix) {
      toast(
        `Wix connection did not complete: ${wix.replaceAll("_", " ")}. Open Connection to retry safely.`,
      );
    } else if (wordpress === "connected") {
      toast(
        "WordPress.com site and exact author connected. Only provider Draft creation is enabled.",
      );
    } else if (wordpress) {
      toast(
        `WordPress connection did not complete: ${wordpress.replaceAll("_", " ")}. Open Connection to retry safely.`,
      );
    }
    return true;
  }

  addConnectionControls();
  const root = document.getElementById("app");
  if (root) {
    new MutationObserver(() => scheduleDecoration(false)).observe(root, {
      childList: true,
      subtree: true,
    });
  }
  scheduleDecoration(false);
  let returnChecks = 0;
  const returnTimer = setInterval(async () => {
    returnChecks += 1;
    if (await handleReturn() || returnChecks > 60) clearInterval(returnTimer);
  }, 500);
})();
