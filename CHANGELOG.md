# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `ALLOWED_USER_GROUP_IDS` membership lookup now runs on a server-side `client_credentials` token (the API client's Client User) instead of the signed-in user's token. End users no longer need Read on `dp_Users` / `dp_User_User_Groups` to log in. **Migration:** if you set this env var, enable Client Credentials on the MP API client and grant Read on those two tables to the Client User's role; existing per-staff grants on those tables can be revoked.

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
