# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-05-02

Reworks the `ALLOWED_USER_GROUP_IDS` group-gate so the membership lookup runs on the API Client's own credentials instead of the signed-in user's token. **If you use `ALLOWED_USER_GROUP_IDS`, this is a breaking deployment change: you must enable Client Credentials grant on your MP API Client and grant the Client User's role Read on `dp_Users` / `dp_User_User_Groups` *before* upgrading, or every login will fail.** Operators with `ALLOWED_USER_GROUP_IDS` empty (or unset) are unaffected.

### Breaking changes (only if `ALLOWED_USER_GROUP_IDS` is set)

- The group-membership lookup is now a server-to-server call against MP, signed with the API Client's own token from a `client_credentials` exchange. The signed-in user's token is no longer used for this lookup.
- **MP API Client must have `Client Credentials` enabled** in its Authentication Flow (in addition to `Authorization Code`). Without it, the server can't get a token and *every* login — including admins — fails closed with `[serverToken] client_credentials failed …` in the logs.
- **The Client User's role must have Read on `dp_Users` and `dp_User_User_Groups`.** This is the identity that runs the lookup now; if its role can't read those tables, the lookup throws and login fails.
- End users no longer need Read on `dp_Users` / `dp_User_User_Groups`. Any staff role you granted those to as a previous workaround can have them revoked.

### Migration

For operators currently running with `ALLOWED_USER_GROUP_IDS=…`, do all of these *before* pulling the new image:

1. **MP admin → Administration → API Clients** → open the client mp-mcp uses.
2. Under **Authentication Flow**, check **Client Credentials** in addition to whatever's already enabled (typically Authorization Code). Save.
3. Note which user is configured as the **Client User** (often `APIUser`). Confirm that user's MP Security Role grants **Read** on `dp_Users` and on `dp_User_User_Groups`. If it doesn't, add those grants — these are the only two tables the server-side identity needs that aren't already exposed via the regular MCP table allowlist.
4. (Optional cleanup) If, prior to this upgrade, you granted Read on `dp_Users` / `dp_User_User_Groups` to a staff role to work around login failures, you can now revoke those grants. Staff users no longer need them.
5. Pull the new image and bounce: `docker compose pull && docker compose up -d`.

If you skip steps 2 or 3 the symptom is the same as a misconfigured group ID: every user's login fails. The log line `[serverToken] client_credentials failed …` is the signal that step 2 was missed; if step 2 succeeded but step 3 didn't, you'll see `userinfo OK` followed by no `[MCP] authenticated user:` (the membership lookup itself returned 403 / empty against `dp_Users`).

### Why

The old design required every staff user's MP Security Role to have Read on `dp_Users` (auth metadata: password-reset tokens, hash columns) so that the membership lookup, which ran on the user's own token, could find their `User_ID`. This was both leaky (every staff user could enumerate other users' auth metadata via `query_table`/`describe_table` if `dp_Users` was allowlisted) and broken in practice (users with non-admin roles passed OIDC login but failed the membership lookup, with the same opaque "Authorization with the MCP server failed" error Claude.ai shows for any auth gate failure). Moving the lookup to the server's own credentials narrows the trust surface to a single configured identity and lets normal-role users connect.

### Fixed

- `query_table`, `count_rows`, and `group_by_count` now decode HTML entities for comparison operators (`&lt;` → `<`, `&gt;` → `>`, `&amp;` → `&`) in `$filter` expressions before sending to MP. LLMs sometimes emit entity-encoded forms, which MP rejected with "Provided $filter parameter's value is considered to be not safe". Decoding is string-literal-aware, so user-supplied search text containing literal `&lt;` (etc.) inside quoted values is preserved.
- Login no longer fails for users whose MP Security Role lacks Read on `dp_Users` / `dp_User_User_Groups`. With the new server-token lookup, only the API Client's Client User needs those reads.

### Changed

- Server-instruction "Common mistakes" list now flags MP audit columns (`_Setup_Date`, `_Setup_User`, `_Last_Modified`, `_Last_Modified_User`) that carry a leading underscore and don't always appear in `describe_table`'s sample row, so the model reaches for the correct name on the first try.

## [0.1.1] - 2026-04-29

Correctness fixes for `group_by_count`, `count_rows`, and `query_table` on tables with self-referenceable foreign-key chains. **Anyone using `group_by_count` for engagement / membership / status breakdowns on `Participants` should upgrade.**

### Fixed

- `group_by_count` returned wrong per-bucket counts when both `group_by` and `filter` referenced FK joins and the matching row set spanned more than one server-side page (>1,000 rows). The total was correct, but rows were misattributed across buckets — typically inflating one bucket and deflating others. Single-page results were unaffected.
- `$filter` references to bare columns (e.g. `Participant_Engagement_ID = 2` on `Participants`) silently bound to a different column reachable via a self-join chain (`Contact_ID_Table.Participant_Record_Table.Participant_Engagement_ID`). The query returned no error — just wrong rows.
- Tool failures returned the generic "Error occurred during tool execution" with no detail; the underlying MP API error message is now passed through.
- Misleading `group_by_count` description example (`Engagement_Level_ID_Table` — not a real FK on `Participants`).

### Changed

- `query_table`, `count_rows`, and `group_by_count` auto-qualify bare column references in `$filter`, `$orderby`, and (for `query_table`) `$select` with the base table name. Strings, bracketed identifiers, SQL keywords, and function calls are left alone.
- `group_by_count` FK mode strategy: instead of paginating rows and bucketing by a returned column value (which MP misbinds on pages 2+), the tool enumerates `(id, label)` pairs from the FK lookup table and runs a `count_rows`-style per-bucket query. A reconciliation pass catches rows whose FK references a value not in the lookup table and surfaces them as an explicit `(other)` bucket so the per-bucket sum always agrees with `count_rows` on the same filter.
- Server-instruction updates: documented that engagement and member status live on `Participants` (route from `Contacts` via `Participant_Record_Table_*`); that non-`_ID` FK columns drop the `_ID` before `_Table` (`Primary_Contact_Table`, NOT `Primary_Contact_ID_Table`); and that MP rejects HTML-encoded comparison operators.

### Performance

- `group_by_count` FK mode issues `2 + N + 1` sub-queries (lookup + per-id count + NULL + reconciliation). For typical lookup tables (5–10 values) this adds ~1s of latency. An unfiltered aggregate against a ~50K-row table runs ~5s. Apply a `filter` to keep things fast.

### Operational

- Tool-invocation log records the actual error message on `isError` responses instead of just `tool_returned_isError`.

## [0.1.0] - 2026-04-28

First tagged release.
