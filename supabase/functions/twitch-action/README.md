# Twitch owner actions

Supported provider mutations are deliberately limited to official Helix
features:

- update channel information;
- create a stream-schedule segment; and
- send an immediate chat announcement when the broadcaster is eligible and is
  a moderator for its own chat.

Every action requires all of the following:

1. an approved exact Queue draft;
2. the migration-069 platform preview for the exact broadcaster ID;
3. a visible action-specific preview recorded as
   `twitch-action-preview-v1`;
4. an AAL2 owner confirmation to execute that receipt;
5. current global-pause, persona assignment, connection, identity, and scope
   checks immediately before the provider call.

Provider timeouts and ambiguous responses are reconciliation-locked and never
blindly retried. Channel edits and schedule segments support provider readback.
Chat announcements have no durable read endpoint; an ambiguous announcement
requires owner review in Twitch and may not reuse the same approval.

Twitch schedule creation is not a general content-post scheduler. Non-recurring
schedule segments require Twitch Affiliate or Partner status. Chat
announcements are immediate only.

Official references: [Twitch API](https://dev.twitch.tv/docs/api/reference),
[OAuth scopes](https://dev.twitch.tv/docs/authentication/scopes/), and
[token validation](https://dev.twitch.tv/docs/authentication/validate-tokens/).

