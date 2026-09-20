"use strict";

// Pure owner-mobile workflow helpers. This is not a social publisher.
// publishing_enabled is permanently false. Exact persona ownership and
// provider/account binding are required before a private draft can be
// created or approved. Offline/disconnected clients cannot mutate private
// owner data.

(function attachMobileOwnerWorkflow(root) {
  const CHANNELS = Object.freeze([
    { key: "x", label: "X", providers: Object.freeze(["x", "twitter"]) },
    { key: "instagram", label: "Instagram", providers: Object.freeze(["instagram"]) },
    { key: "facebook", label: "Facebook", providers: Object.freeze(["facebook"]) },
    { key: "website", label: "Website", providers: Object.freeze(["website", "wix", "wordpress", "wordpress_com", "wordpress_self_hosted"]) },
  ]);

  const VARIANT_LIMITS = Object.freeze({
    x: 280,
    instagram: 5000,
    facebook: 10000,
    website: 30000,
  });

  const EXPORT_VERSION = "mobile-owner-workflow-export-v1";
  const PUBLISHING_ENABLED = false;
  const CREATION_SOURCE = "mobile_private";

  const OFFLINE_LIMITATIONS = Object.freeze([
    "Private persona selection, drafts, review, and approval require a signed-in owner session against the live MyPersonas backend.",
    "The public offline shell never caches owner-app.js, owner drafts, or Supabase responses.",
    "Disconnected Android/WebView builds may only show this limitation page. They cannot create, approve, or send drafts.",
    "Approval is a private planning record. It never posts to X, Instagram, Facebook, a website, or any other provider.",
    "OAuth scopes, production secrets, and provider send paths are unchanged by this milestone.",
  ]);

  function asText(value) {
    return String(value == null ? "" : value).trim();
  }

  function lower(value) {
    return asText(value).toLowerCase();
  }

  function channelDef(channel) {
    return CHANNELS.find((row) => row.key === channel) || null;
  }

  function providerMatches(channel, provider) {
    const def = channelDef(channel);
    return !!(def && def.providers.includes(lower(provider)));
  }

  function ownedPersona(personas, ownerId, personaId) {
    const caller = asText(ownerId);
    const id = asText(personaId);
    if (!caller || !id) return null;
    const persona = (Array.isArray(personas) ? personas : []).find((row) => row && row.id === id) || null;
    if (!persona) return null;
    if (persona.owner && persona.owner !== caller) return null;
    return persona;
  }

  function ownedAccounts(accounts, ownerId, personaId) {
    const caller = asText(ownerId);
    const id = asText(personaId);
    return (Array.isArray(accounts) ? accounts : []).filter((account) => {
      if (!account || account.suspended) return false;
      if (account.owner && account.owner !== caller) return false;
      if (asText(account.persona_id) !== id) return false;
      return true;
    });
  }

  function accountsForChannel(accounts, ownerId, personaId, channel) {
    return ownedAccounts(accounts, ownerId, personaId).filter((account) => providerMatches(channel, account.provider));
  }

  function accountLabel(account) {
    return asText(account?.username) || asText(account?.login_email) || asText(account?.url) || asText(account?.provider) || "Account";
  }

  function bindingState(accounts, ownerId, personaId, channel, accountId) {
    const matches = accountsForChannel(accounts, ownerId, personaId, channel);
    if (accountId) {
      const exact = matches.find((account) => account.id === accountId);
      if (!exact) {
        return {
          channel,
          state: "rejected",
          determinable: false,
          account: null,
          reason: "Exact assigned account was not found for this owned persona and provider",
        };
      }
      return {
        channel,
        state: "determined",
        determinable: true,
        account: exact,
        reason: "",
      };
    }
    if (matches.length === 1) {
      return {
        channel,
        state: "determined",
        determinable: true,
        account: matches[0],
        reason: "",
      };
    }
    if (matches.length === 0) {
      return {
        channel,
        state: "unassigned",
        determinable: false,
        account: null,
        reason: "No assigned account · finish the exact ledger assignment before scheduling",
      };
    }
    return {
      channel,
      state: "ambiguous",
      determinable: false,
      account: null,
      reason: `${matches.length} assigned accounts · choose the exact ledger row`,
    };
  }

  function channelBindings(accounts, ownerId, personaId, requested = {}) {
    return CHANNELS.map((channel) => bindingState(accounts, ownerId, personaId, channel.key, requested[channel.key] || ""));
  }

  function variantLimit(channel) {
    return VARIANT_LIMITS[channel] || 0;
  }

  function normalizeVariant(row) {
    const channel = asText(row?.channel);
    const body = asText(row?.body);
    const title = asText(row?.title).slice(0, 300);
    const description = asText(row?.description).slice(0, 2000);
    const altText = asText(row?.alt_text).slice(0, 2000);
    return {
      channel,
      title,
      body,
      description,
      alt_text: altText,
      media_plan: Array.isArray(row?.media_plan) ? row.media_plan : [],
    };
  }

  function assertVariants(variants) {
    const rows = Array.isArray(variants) ? variants.map(normalizeVariant) : [];
    if (rows.length !== 4) return "Exactly four bounded content variants are required";
    const seen = new Set();
    for (const row of rows) {
      if (!channelDef(row.channel) || seen.has(row.channel)) return "Content variant channels are invalid or duplicated";
      seen.add(row.channel);
      if (!row.body) return `The ${row.channel} variant needs body content`;
      if (row.body.length > variantLimit(row.channel)) return `The ${row.channel} variant exceeds its character limit`;
      if (row.media_plan.length) return "Mobile private drafts do not accept media plans in this milestone";
    }
    for (const channel of CHANNELS) {
      if (!seen.has(channel.key)) return "A complete unposted X, Instagram, Facebook, and website kit is required";
    }
    return "";
  }

  function createPrivateDraftRequest(input = {}) {
    const ownerId = asText(input.ownerId || input.callerId);
    const personaId = asText(input.personaId);
    const persona = ownedPersona(input.personas, ownerId, personaId);
    if (!ownerId) return { ok: false, error: "Authentication required", payload: null };
    if (!persona) return { ok: false, error: "Owned persona not found", payload: null };
    if (input.publishingEnabled === true || input.publishing_enabled === true) {
      return { ok: false, error: "publishing_enabled must remain false", payload: null };
    }
    if (input.online === false) {
      return { ok: false, error: "Private drafts cannot be created while disconnected", payload: null };
    }
    const variantError = assertVariants(input.variants);
    if (variantError) return { ok: false, error: variantError, payload: null };
    const bindings = channelBindings(input.accounts, ownerId, personaId, input.requestedBindings || {});
    const missingExact = bindings.filter((row) => !row.determinable);
    if (missingExact.length) {
      return {
        ok: false,
        error: "Exact provider/account binding is required for every channel before a mobile private draft can be stored",
        bindings,
        payload: null,
      };
    }
    const variants = input.variants.map(normalizeVariant);
    return {
      ok: true,
      error: "",
      bindings,
      payload: {
        rpc: "create_owner_mobile_private_draft",
        publishing_enabled: PUBLISHING_ENABLED,
        creation_source: CREATION_SOURCE,
        p_persona_id: persona.id,
        p_title: asText(input.title).slice(0, 300) || "Mobile private draft",
        p_owner_guidance: asText(input.guidance).slice(0, 6000),
        p_timezone: asText(input.timezone) || "UTC",
        p_variants: variants,
        p_bindings: Object.fromEntries(bindings.map((row) => [row.channel, {
          ledger_id: row.account.id,
          provider: lower(row.account.provider),
        }])),
      },
    };
  }

  function reviewItem(pack, variants, persona, bindings = []) {
    const status = asText(pack?.status);
    return {
      id: pack?.id || "",
      personaId: pack?.persona_id || "",
      personaName: persona?.name || "Persona",
      title: asText(pack?.title) || "Four-channel content kit",
      status,
      needsReview: status === "owner_review",
      approved: status === "approved",
      scheduled: status === "scheduled",
      publishingEnabled: PUBLISHING_ENABLED,
      canApprove: status === "owner_review" && (variants || []).length === 4 && (variants || []).every((row) => asText(row.body)),
      canSchedule: status === "approved" && bindings.every((row) => row.determinable),
      cannotPublish: true,
      bindings,
    };
  }

  function approvalDecision(input = {}) {
    const ownerId = asText(input.ownerId || input.callerId);
    const pack = input.pack || null;
    if (!ownerId) return { ok: false, action: "", error: "Authentication required" };
    if (!pack) return { ok: false, action: "", error: "Owned content package not found" };
    if (pack.owner && pack.owner !== ownerId) return { ok: false, action: "", error: "Owned content package not found" };
    if (input.publishingEnabled === true) return { ok: false, action: "", error: "publishing_enabled must remain false" };
    if (input.online === false) return { ok: false, action: "", error: "Approval requires a live owner session" };
    const action = asText(input.action);
    if (action === "publish" || action === "provider_send") {
      return { ok: false, action: "", error: "Mobile workflow cannot publish or send to a provider" };
    }
    if (action === "approve") {
      if (pack.status !== "owner_review") return { ok: false, action: "", error: "Only owner-review kits can be approved" };
      return { ok: true, action: "approve", error: "", rpc: "content_package_preview_snapshot", publishes: false };
    }
    if (action === "manual_schedule") {
      const bindings = input.bindings || [];
      if (pack.status !== "approved") return { ok: false, action: "", error: "Schedule requires a current approval" };
      if (bindings.some((row) => !row.determinable)) {
        return { ok: false, action: "", error: "Exact provider/account binding is required before a manual schedule preview" };
      }
      return { ok: true, action: "manual_schedule", error: "", rpc: "content_package_preview_snapshot", publishes: false };
    }
    if (action === "reject") {
      return { ok: true, action: "reject", error: "", rpc: "delete_owner_content_package_draft", publishes: false };
    }
    return { ok: false, action: "", error: "Unsupported approval action" };
  }

  function rosterGroups(personas, backups = []) {
    const list = Array.isArray(personas) ? personas.slice() : [];
    const backupRows = Array.isArray(backups) ? backups : [];
    const backupByMain = new Map();
    for (const row of backupRows) {
      if (row?.main_persona_id && row?.backup_persona_id) backupByMain.set(row.main_persona_id, row.backup_persona_id);
    }
    const backupIds = new Set(backupByMain.values());
    return list
      .filter((persona) => persona && !backupIds.has(persona.id))
      .map((main) => ({
        main,
        backup: list.find((persona) => persona.id === backupByMain.get(main.id)) || null,
      }));
  }

  function filterRoster(groups, query) {
    const needle = lower(query);
    if (!needle) return groups;
    return (groups || []).filter(({ main, backup }) => {
      const hay = [main?.name, main?.handle, backup?.name, backup?.handle].map(lower).join(" ");
      return hay.includes(needle);
    });
  }

  function exportBundle(input = {}) {
    return {
      version: EXPORT_VERSION,
      exported_at: input.exportedAt || new Date().toISOString(),
      owner_id: asText(input.ownerId),
      selected_persona_id: asText(input.selectedPersonaId),
      draft_ids: (Array.isArray(input.draftIds) ? input.draftIds : []).map(asText).filter(Boolean),
      publishing_enabled: PUBLISHING_ENABLED,
      note: "Side-by-side testing helper when Android debug and Play signing differ. This is not a user-data backup of private draft bodies.",
    };
  }

  function importBundle(bundle, input = {}) {
    if (!bundle || bundle.version !== EXPORT_VERSION) return { ok: false, error: "Unrecognized export version" };
    if (bundle.publishing_enabled === true) return { ok: false, error: "publishing_enabled must remain false" };
    const ownerId = asText(input.ownerId);
    if (!ownerId || bundle.owner_id !== ownerId) return { ok: false, error: "Export belongs to a different owner" };
    const persona = ownedPersona(input.personas, ownerId, bundle.selected_persona_id);
    return {
      ok: true,
      error: "",
      selectedPersonaId: persona?.id || "",
      draftIds: Array.isArray(bundle.draft_ids) ? bundle.draft_ids.filter(Boolean) : [],
    };
  }

  const api = Object.freeze({
    CHANNELS,
    VARIANT_LIMITS,
    EXPORT_VERSION,
    PUBLISHING_ENABLED,
    CREATION_SOURCE,
    OFFLINE_LIMITATIONS,
    ownedPersona,
    ownedAccounts,
    accountsForChannel,
    accountLabel,
    bindingState,
    channelBindings,
    variantLimit,
    normalizeVariant,
    assertVariants,
    createPrivateDraftRequest,
    reviewItem,
    approvalDecision,
    rosterGroups,
    filterRoster,
    exportBundle,
    importBundle,
  });

  root.MobileOwnerWorkflow = api;
  return api;
})(typeof globalThis !== "undefined" ? globalThis : this);
