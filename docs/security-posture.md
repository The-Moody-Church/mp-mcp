# Security Posture

This document describes how the MCP server approaches security, what it enforces locally, and which risks are accepted rather than mitigated in code.

## Controls

### Authentication & authorization
- Every MCP call requires a valid MP OIDC bearer token. The server calls MP's `userinfo` endpoint to verify.
- When `ALLOWED_USER_GROUP_IDS` is set, the user must be a positively-confirmed member of at least one listed MP User Group. Any lookup failure denies (fail-closed).
- Dynamic OAuth client registration only accepts `redirect_uri`s that are `https://` AND on the allowlist (`https://claude.ai/api/mcp/auth_callback` plus anything in `ALLOWED_REDIRECT_URIS`).
- Every registered client gets a fresh random `client_secret`; the configured `OIDC_CLIENT_SECRET` is never echoed back to registrants.

### Table access
- `config/table-access.json` caps which MP tables the MCP exposes, independent of what the user's MP role would otherwise allow. A user with broad MP read access still can't reach tables left off this list.
- Default example excludes `dp_Users`, `Background_Checks`, `Form_Responses`. Operators may opt in, but should understand the exposure.

### Input handling
- Dates on tool inputs are validated as `YYYY-MM-DD`.
- User-supplied values used in `LIKE` patterns are escaped for both quotes and wildcard characters (`%`, `_`, `[`).
- Table names are validated before interpolation — no slashes, traversal sequences, or control characters.

### Rate limiting and resource caps
- `/register` and `/token` are rate-limited by the MCP SDK.
- `/mcp` and `/` are rate-limited per-token (120 req/min, keyed by `sha256(token)`).
- Verified tokens are cached for 60 seconds to cut amplification to MP's `userinfo` endpoint.
- Per-user MCP transports expire after 30 minutes of inactivity (swept every 5 minutes). Max 500 concurrent users; oldest is evicted when the cap is reached.
- Registered OAuth client store is capped at 1000 entries with oldest-eviction.

### Logging
- No OAuth request bodies, no token values, no MCP response bodies are logged.
- MP error bodies echo user-supplied filter/select fragments (which can include PII) — truncated to 200 characters before being logged or re-thrown.
- Per-request user identifier in logs is the MP user GUID (`sub`), not the user's name.

## `query_table` — power-user tool, role-bounded

The `query_table` tool accepts raw `$filter`, `$select`, and `$orderby` strings that are passed to MP's REST API. That's intentional: it's the ad-hoc escape hatch for queries the domain tools don't cover. The consequences are worth spelling out:

- **`$select` can return any column on an allowlisted table**, subject to the user's MP role. The table allowlist is the table-level gate; MP's role-based column security is the column-level gate. If you add sensitive tables to the allowlist, ensure the MP roles of your callers do not expose columns you want to keep hidden.
- **`$filter` can use `_ID_Table` FK-chain joins**. A filter on an allowlisted table can read through foreign keys into tables that are not themselves in the allowlist. MP's role-based security is what bounds this — the MCP's table allowlist does not.
- **There is no per-column allowlist** in `table-access.json` today. If this becomes a real concern (e.g., you need to allowlist a table but hide specific columns), two options exist: add a `readColumns` array to `table-access.json` and validate `$select` against it, or reject `$select` columns not present in `describe_table` metadata. Both are real work; neither is built.

Practical guidance:
- Keep the table allowlist tight. Prefer domain tools where they exist.
- Treat the roles assigned to your MP OIDC client and to the users who log into the MCP as the authoritative access-control surface.
- If you add a table with columns you want hidden, verify directly in MP that the role the MCP uses cannot read those columns.

## Accepted risks

These findings were identified during security review and intentionally not addressed in code. Each is revisited if conditions change.

### Prompt injection via MP data (accepted)
Fields like `Contacts.Notes`, `Contact_Log`, and `Form_Responses` are freeform text that a church member or staff can write into. When Claude reads those values through a tool response, any string that resembles instructions can attempt to influence Claude's next action.

**Why accepted**:
- The structural mitigation is already in place: the default allowlist excludes the freeform tables with the highest injection density (`Form_Responses`), and the donations tables are out entirely.
- The primary defense is Claude's own instruction-following discipline — a code-level mitigation (e.g., stripping unusual Unicode, flagging suspicious-looking content) is partial and fragile.
- Operators who opt sensitive freeform tables back into the allowlist should do so knowing this risk.

**What would change this**: a demonstrated concrete exploit via data already in the allowlisted tables, or pressure to re-add `Form_Responses` / `Contact_Log` by default.

### `getClient` returns `config.oidcClientSecret` for the configured client_id (accepted)
When a caller looks up the configured OIDC client by ID, the returned object includes the configured `OIDC_CLIENT_SECRET`.

**Why accepted**:
- No current HTTP path exposes this object. The SDK's `/register` handler only returns secrets to the registrant; there is no RFC 7592 client-read endpoint.
- Fixing preemptively (synthesize a random secret for the configured client, keep the configured secret server-internal) is meaningful work for a risk that is presently zero.

**What would change this**: adding any HTTP endpoint that serves existing client info, or upgrading the MCP SDK to a version that does so by default.

### Silent fallback to example `table-access.json` in the container (accepted)
The Dockerfile copies `config/table-access.example.json` into the image. If the operator forgets to mount their real `table-access.json`, the container runs with the example allowlist.

**Why accepted**:
- The example is itself intentionally conservative (read-only, no sensitive tables).
- The correct place to catch this is deployment configuration — a health check that verifies the expected file is present, or a compose-level assertion — not application code.
- Adding a startup assertion inside the app ("this file must not be the example") couples app logic to filename conventions and creates new failure modes during legitimate customization.

**What would change this**: operators reporting that running with the example allowlist caused an unexpected exposure.
