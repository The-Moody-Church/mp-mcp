# Project Status

**Last updated:** 2026-04-17

## Current State

The MCP server is **live and stable** on TMC1 at `mcp.moodychurch.app`. Claude Desktop connects via MP OIDC and queries data through 10 tools (6 domain + 4 generic). Session management handles redeploys and reconnects gracefully.

## What Works

- OAuth authentication (ProxyOAuthServerProvider → MP OIDC)
- Session management — survives redeploys, token refresh, disconnect/reconnect
- Server instructions (2847 chars) — data model, FK join reference, presentation rules
- Domain tools: find_people, get_person_details, search_groups, get_group_roster, search_events, get_event_attendance
- Generic tools: list_tables, describe_table, query_table, get_record
- GitHub Actions CI → ghcr.io → TMC1 deployment
- Cloudflare tunnel routing
- Transport error logging ([MP API] errors visible in container logs)

## Known Issues

- **Personal connector cache:** When new tools are added, users may need to remove/re-add the connector in their personal Claude settings (not the org connector)
- **Nested FK joins:** MP's API doesn't support `A_Table.B_Table.Column` — only underscore-chained `A_Table_B_Table.Column`. Some chains still fail; need to query separately and join client-side.
- **No giving tools:** Donations excluded by design — not in allowlist, no tools exposed

## Architecture

```
Claude Desktop / claude.ai
  ↕ HTTPS (streamable HTTP + SSE)
https://mcp.moodychurch.app
  ↕ Cloudflare Tunnel
mp-mcp (Docker on TMC1, port 3000)
  ├─ ProxyOAuthServerProvider → MP OIDC login
  ├─ Session management (per-user transports, auto-recreate on stale)
  └─ Tools → MP REST API (user's own OIDC token)
```

## What's Next

| Task | Priority | Notes |
|------|----------|-------|
| Test with second staff account | High | Verify per-user MP security role scoping |
| Staff onboarding (admin team) | High | Once stable for a week |
| count_records tool | Medium | Avoid pagination for simple counts |
| Remove debug logging | Low | Response body + HTTP request logging |
| README.md | Low | Setup docs for other MP churches |

## Session Log

- [2026-04-13](sessions/2026-04-13.md) — Server goes live. Fixed 3 auth/transport bugs.
- [2026-04-14](sessions/2026-04-14.md) — Instructions work, reconnect issues, stable baseline.
- [2026-04-17](sessions/2026-04-17.md) — Session fix, domain tools, FK join corrections.
