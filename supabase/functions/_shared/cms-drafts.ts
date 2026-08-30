import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// The project does not generate a Supabase Database type yet; this shared
// helper is intentionally untyped at the client boundary and validates every
// provider-facing row before use.
// deno-lint-ignore no-explicit-any
export type ServiceClient = ReturnType<typeof createClient<any>>;

export type CmsDraftContext = {
  draft: {
    id: string;
    owner: string;
    persona_id: string;
    account_id: string;
    platform: string;
    title: string;
    body: string;
    tags: string;
    content_kind: string;
    publish_at: string | null;
    approved_content_hash: string;
    approved_preview_target_id: string;
  };
  ledger: {
    id: string;
    provider: string;
    persona_id: string | null;
    suspended: boolean;
  };
  connection: {
    provider_subject: string;
    connection_state: string;
    verification_method: string;
    granted_scopes: string[];
  };
  credential: {
    provider: string;
    provider_mode: string;
    provider_subject: string;
    site_id: string;
    site_url: string;
    site_name: string;
    author_id: string;
    author_name: string;
    secret: Record<string, unknown>;
  };
};

export type CmsAttempt = {
  id: string;
  status: string;
  provider_draft_id: string;
  attempt_count: number;
  last_error: string;
  request_fingerprint: string;
  started_at?: string;
};

const appSecretCache = new Map<string, { value: string; expiresAt: number }>();

export async function loadCmsAppSecret(
  service: ServiceClient,
  name: "wix_app_secret" | "wordpress_com_client_secret",
) {
  const cached = appSecretCache.get(name);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const result = await service.rpc("cms_get_app_secret_service", {
    p_name: name,
  });
  const value = result.error ? "" : String(result.data || "");
  if (value.length < 16 || value.length > 32768) return "";
  appSecretCache.set(name, { value, expiresAt: Date.now() + 5 * 60_000 });
  return value;
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function htmlEscape(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function plainTextToHtml(body: string, tags: string) {
  const paragraphs = body.replaceAll("\r\n", "\n").split(/\n{2,}/)
    .map((part) => part.trim()).filter(Boolean)
    .map((part) => `<p>${htmlEscape(part).replaceAll("\n", "<br>")}</p>`);
  const tagText = tags.trim();
  if (tagText) paragraphs.push(`<p>${htmlEscape(tagText)}</p>`);
  return paragraphs.join("\n") || "<p></p>";
}

export function exactPlainText(body: string, tags: string) {
  return [body.trim(), tags.trim()].filter(Boolean).join("\n\n");
}

export function ricosPlainText(body: string, tags: string) {
  const text = exactPlainText(body, tags);
  const parts = text.replaceAll("\r\n", "\n").split(/\n{2,}/).map((part) =>
    part.trim()
  )
    .filter(Boolean);
  return {
    nodes: (parts.length ? parts : [""]).map((part) => ({
      type: "PARAGRAPH",
      nodes: [{
        type: "TEXT",
        textData: { text: part, decorations: [] },
      }],
      paragraphData: {},
    })),
  };
}

export function extractRicosText(value: unknown): string {
  const pieces: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const textData = record.textData;
    if (textData && typeof textData === "object") {
      const text = (textData as Record<string, unknown>).text;
      if (typeof text === "string") pieces.push(text);
    }
    if (Array.isArray(record.nodes)) {
      for (const child of record.nodes) visit(child);
    }
  };
  visit(value);
  return pieces.join("\n\n").trim();
}

export async function loadExactCmsDraft(
  service: ServiceClient,
  owner: string,
  draftId: string,
  provider: "wix" | "wordpress",
): Promise<{ context?: CmsDraftContext; error?: string; status?: number }> {
  const gate = await service.rpc("cms_exact_preview_is_current_service", {
    p_owner: owner,
    p_draft_id: draftId,
    p_provider: provider,
  });
  if (gate.error) {
    return {
      error: "The platform-preview safety gate is unavailable.",
      status: 503,
    };
  }
  if (gate.data !== true) {
    return {
      error:
        "Review and approve the current text-only platform preview for this exact account before creating a provider draft.",
      status: 409,
    };
  }
  const draftResult = await service.from("drafts").select(
    "id,owner,persona_id,account_id,platform,title,body,tags,content_kind,publish_at,approved_content_hash,approved_preview_target_id",
  ).eq("id", draftId).eq("owner", owner).maybeSingle();
  if (draftResult.error || !draftResult.data) {
    return { error: "Draft not found.", status: 404 };
  }
  const draft = draftResult.data as CmsDraftContext["draft"];
  const [ledgerResult, connectionResult, credentialResult, pauseResult] =
    await Promise.all([
      service.from("account_ledger").select("id,provider,persona_id,suspended")
        .eq("id", draft.account_id).eq("owner", owner).eq("provider", provider)
        .maybeSingle(),
      service.from("account_connections").select(
        "provider_subject,connection_state,verification_method,granted_scopes",
      ).eq("ledger_id", draft.account_id).eq("owner", owner).eq(
        "provider",
        provider,
      ).maybeSingle(),
      service.rpc("cms_get_credential_service", {
        p_ledger_id: draft.account_id,
        p_owner: owner,
      }),
      service.from("agent_owner_settings").select("automation_paused").eq(
        "owner",
        owner,
      ).maybeSingle(),
    ]);
  if (pauseResult.error || !pauseResult.data) {
    return {
      error: "The owner-wide safety setting is unavailable.",
      status: 503,
    };
  }
  if (pauseResult.data.automation_paused === true) {
    return {
      error:
        "The global automation pause is on. No provider draft was created.",
      status: 409,
    };
  }
  const credentialRows = credentialResult.data;
  const credential =
    (Array.isArray(credentialRows) ? credentialRows[0] : credentialRows) as
      | CmsDraftContext["credential"]
      | undefined;
  const ledger = ledgerResult.data as CmsDraftContext["ledger"] | null;
  const connection = connectionResult.data as
    | CmsDraftContext["connection"]
    | null;
  if (
    ledgerResult.error || connectionResult.error || credentialResult.error ||
    !ledger || !connection || !credential
  ) {
    return {
      error: `Reconnect the ${
        provider === "wix" ? "Wix" : "WordPress"
      } account before creating a draft.`,
      status: 409,
    };
  }
  if (
    ledger.suspended || connection.connection_state !== "connected" ||
    !connection.provider_subject || credential.provider !== provider ||
    credential.provider_subject !== connection.provider_subject ||
    draft.approved_preview_target_id !== connection.provider_subject ||
    !credential.author_id
  ) {
    return {
      error: "The exact site or author binding changed after preview.",
      status: 409,
    };
  }
  // Re-run the durable migration-069 gate after loading the content snapshot.
  // If an edit or retarget raced the first check, no provider request may use
  // the newer, unpreviewed values. An edit after this check cannot alter the
  // already-loaded approved snapshot sent by the caller.
  const finalGate = await service.rpc("cms_exact_preview_is_current_service", {
    p_owner: owner,
    p_draft_id: draftId,
    p_provider: provider,
  });
  if (finalGate.error || finalGate.data !== true) {
    return {
      error:
        "The content or exact destination changed while the provider draft was being prepared.",
      status: 409,
    };
  }
  return { context: { draft, ledger, connection, credential } };
}

export async function cmsFingerprint(context: CmsDraftContext) {
  return await sha256Hex(JSON.stringify([
    "cms-draft-v1",
    context.credential.provider,
    context.credential.provider_mode,
    context.draft.approved_content_hash,
    context.connection.provider_subject,
  ]));
}

export async function prepareCmsActionPreview(
  service: ServiceClient,
  context: CmsDraftContext,
  fingerprint: string,
) {
  const provider = context.credential.provider as "wix" | "wordpress";
  const providerName = provider === "wix" ? "Wix" : "WordPress";
  const targetLabel = [
    context.credential.site_name || context.credential.site_url ||
    context.credential.site_id,
    context.credential.author_name || context.credential.author_id,
  ].filter(Boolean).join(" · ");
  const prepared = await service.rpc(
    "prepare_provider_action_preview_service",
    {
      p_owner: context.draft.owner,
      p_draft_id: context.draft.id,
      p_ledger_id: context.draft.account_id,
      p_provider: provider,
      p_action: `${provider}.create_draft`,
      p_target_id: context.connection.provider_subject,
      p_content_hash: context.draft.approved_content_hash,
      p_action_hash: fingerprint,
      p_preview_version: "cms-provider-draft-preview-v1",
      p_preview_payload: {
        rendererVersion: "cms-provider-draft-preview-v1",
        items: [{
          provider,
          account: targetLabel || `${providerName} exact site and author`,
          accountId: context.connection.provider_subject,
          placement: `${providerName} unpublished post editor`,
          requiresExactTarget: true,
          exactTargetReady: true,
          title: context.draft.title,
          text: context.draft.body,
          tags: context.draft.tags,
          mediaUrl: "",
          mediaKind: "article",
          mediaItems: [],
          requiresMedia: false,
          scheduledFor: null,
          mode: `Create unpublished ${providerName} Draft`,
          timingLabel: "Immediately after acknowledgement",
          platformDetails: [
            `Exact provider target: ${context.connection.provider_subject}`,
            `Exact site: ${
              context.credential.site_url || context.credential.site_id
            }`,
            `Exact author: ${
              context.credential.author_name || context.credential.author_id
            }`,
            "Provider visibility: Draft / unpublished",
            "No provider schedule will be created",
            context.draft.publish_at
              ? `MyPersonas editorial time ${context.draft.publish_at} is not sent to the provider`
              : "No editorial time is sent to the provider",
          ],
        }],
      },
    },
  );
  return {
    receipt: prepared.data as Record<string, unknown> | null,
    error: prepared.error,
  };
}

export async function claimCmsAttemptWithPreview(
  service: ServiceClient,
  context: CmsDraftContext,
  fingerprint: string,
  receiptId: string,
): Promise<{ attempt?: CmsAttempt; blocked?: string; status?: number }> {
  const provider = context.credential.provider as "wix" | "wordpress";
  const result = await service.rpc("claim_cms_draft_with_preview_service", {
    p_owner: context.draft.owner,
    p_draft_id: context.draft.id,
    p_provider: provider,
    p_receipt_id: receiptId,
  });
  const value = Array.isArray(result.data) ? result.data[0] : result.data;
  const attempt = value as CmsAttempt | null;
  if (result.error || !attempt) {
    return {
      blocked: result.error?.message ||
        "The exact provider preview and durable CMS attempt could not be claimed atomically.",
      status: result.error ? 409 : 503,
    };
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(attempt.id) ||
    attempt.status !== "claimed" || attempt.request_fingerprint !== fingerprint
  ) {
    return {
      blocked:
        "The atomic CMS claim returned an invalid durable attempt. Nothing was sent.",
      status: 503,
    };
  }
  return { attempt };
}

export async function claimCmsAttempt(
  service: ServiceClient,
  context: CmsDraftContext,
  fingerprint: string,
): Promise<{ attempt?: CmsAttempt; blocked?: string; status?: number }> {
  const existing = await service.from("cms_draft_attempts")
    .select(
      "id,status,provider_draft_id,attempt_count,last_error,request_fingerprint,started_at",
    )
    .eq("owner", context.draft.owner).eq("draft_id", context.draft.id)
    .eq("request_fingerprint", fingerprint).maybeSingle();
  if (existing.error) {
    return {
      blocked: "The provider-draft claim could not be checked.",
      status: 503,
    };
  }
  if (existing.data) {
    const prior = existing.data as CmsAttempt;
    if (
      ["claimed", "outcome_unknown", "provider_created"].includes(prior.status)
    ) {
      return { attempt: prior };
    }
    if (prior.status === "verified") return { attempt: prior };
    if (["delete_claimed", "delete_outcome_unknown"].includes(prior.status)) {
      return {
        attempt: prior,
        blocked:
          "The provider Trash result needs recovery. Do not create or reconcile another provider draft.",
        status: 409,
      };
    }
    if (prior.status === "provider_deleted") {
      return {
        attempt: prior,
        blocked:
          "This exact provider draft was deleted. Revise and reapprove the draft before staging another copy.",
        status: 409,
      };
    }
    return {
      blocked:
        "There is no uncertain provider result to reconcile. Start from the exact preview action.",
      status: 409,
    };
  }
  return {
    blocked:
      "No prior provider-draft attempt exists. Start from the exact preview action; reconciliation cannot create a new attempt.",
    status: 409,
  };
}

export async function updateCmsAttempt(
  service: ServiceClient,
  owner: string,
  attemptId: string,
  values: Record<string, unknown>,
) {
  return await service.from("cms_draft_attempts").update({
    ...values,
    updated_at: new Date().toISOString(),
  }).eq("id", attemptId).eq("owner", owner).select(
    "id,status,provider_draft_id",
  ).maybeSingle();
}

export async function recordVerifiedCmsDraft(
  service: ServiceClient,
  context: CmsDraftContext,
  attempt: CmsAttempt,
  providerDraftId: string,
  providerContentHash: string,
  previewUrl: string,
  editUrl: string,
) {
  const now = new Date().toISOString();
  const stored = await service.from("cms_provider_drafts").upsert({
    owner: context.draft.owner,
    draft_id: context.draft.id,
    ledger_id: context.draft.account_id,
    attempt_id: attempt.id,
    provider: context.credential.provider,
    provider_mode: context.credential.provider_mode,
    exact_target_id: context.connection.provider_subject,
    draft_content_hash: context.draft.approved_content_hash,
    provider_content_hash: providerContentHash,
    provider_draft_id: providerDraftId,
    provider_status: "draft",
    provider_preview_url: previewUrl.slice(0, 1000),
    provider_edit_url: editUrl.slice(0, 1000),
    title: context.draft.title,
    verified_at: now,
    deleted_at: null,
    updated_at: now,
  }, { onConflict: "attempt_id" }).select(
    "id,provider_draft_id,provider_preview_url,provider_edit_url",
  ).single();
  if (stored.error || !stored.data) {
    return {
      error:
        "Provider readback succeeded, but the durable local checkpoint failed.",
    };
  }
  const finished = await updateCmsAttempt(
    service,
    context.draft.owner,
    attempt.id,
    {
      status: "verified",
      provider_draft_id: providerDraftId,
      provider_accepted_at: now,
      completed_at: now,
      last_error: "",
    },
  );
  if (finished.error || !finished.data) {
    return {
      error:
        "Provider readback succeeded, but completion needs reconciliation.",
    };
  }
  await service.rpc("insert_agent_action_service", {
    p_owner: context.draft.owner,
    p_persona_id: context.draft.persona_id,
    p_binding_id: null,
    p_action_type: "stage_external_cms_draft",
    p_entity_type: "draft",
    p_entity_id: context.draft.id,
    p_outcome: "ok",
    p_detail: {
      provider: context.credential.provider,
      provider_mode: context.credential.provider_mode,
      provider_draft_id: providerDraftId,
      exact_target_id: context.connection.provider_subject,
      approved_content_hash: context.draft.approved_content_hash,
      published: false,
    },
  });
  return { data: stored.data };
}

export function providerOutcomeUncertain(error: unknown) {
  return (error instanceof DOMException && error.name === "TimeoutError") ||
    error instanceof TypeError;
}
