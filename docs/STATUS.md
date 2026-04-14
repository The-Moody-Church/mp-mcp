# Project Status

**Last updated:** 2026-04-13

## Current State

The MCP server is **live and working** on TMC1 at `mcp.moodychurch.app`. Claude Desktop connects, authenticates via MP OIDC, and queries MP data through four read-only tools.

## What Works

- OAuth authentication (ProxyOAuthServerProvider → MP OIDC)
- `list_tables` — returns the 27-table allowlist
- `describe_table` — field names/types via sample record
- `query_table` — full OData query support ($filter, $select, $orderby, $top, $skip, FK joins)
- `get_record` — single record by ID
- GitHub Actions CI → ghcr.io → TMC1 deployment
- Cloudflare tunnel routing

## What's Next (Phase 2.5)

| Task | Priority | Notes |
|------|----------|-------|
| Tool description improvements | High | No raw IDs, human-readable presentation |
| Lookup value resolution | High | Claude can't interpret numeric FK codes |
| Donation data policy | High | Define rules for discussing donor/giving info |
| `count_records` tool | Medium | Avoid pagination for simple counts |
| Remove debug logging | Low | HTTP/MCP handler logs in index.ts |
| Second staff account test | Medium | Verify per-user MP security role scoping |
| README.md | Low | Setup docs for other MP churches |

## Architecture

```
Claude Desktop / Claude Code
  ↕ HTTPS (streamable HTTP)
https://mcp.moodychurch.app
  ↕ Cloudflare Tunnel
mp-mcp (Docker on TMC1, port 3000)
  ↕ ProxyOAuthServerProvider     ↕ HTTPS (user's OIDC token)
  MP OIDC login flow             MP REST API
```

## Session Log

- [2026-04-13](sessions/2026-04-13.md) — Server goes live. Fixed 3 auth/transport bugs.
