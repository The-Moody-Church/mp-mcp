# CLAUDE.md — mp-mcp

## What is this?

MCP server that gives Claude direct access to Ministry Platform's REST API. Users authenticate via OIDC and the server uses their token for MP API calls.

## Commands

```bash
npm run build    # Compile TypeScript → dist/
npm run dev      # Dev mode with tsx watch
npm start        # Run production build
```

## Architecture

- `src/index.ts` — Express HTTP server, auth routes, MCP endpoint
- `src/server.ts` — MCP server with tool registrations
- `src/transport.ts` — Authenticated MP API requests with concurrency limiting
- `src/auth/oidc.ts` — OIDC discovery, authorization, token exchange/refresh
- `src/auth/session.ts` — In-memory session store with signed cookies
- `src/config.ts` — Environment config + table allowlist loading
- `src/utils/` — Filter sanitization, URL length handling

## Key patterns

- **User's own OIDC token** for all MP API calls — MP security roles enforce access
- **Table allowlist** (`config/table-access.json`) caps what's exposed regardless of user role
- **Concurrency limiter** (6 max) prevents MP API connection exhaustion
- **GET→POST fallback** for URLs exceeding IIS's ~4096 char limit
- **No deletes** — delete operations are intentionally not implemented

## Safety

- **Never commit `.env` or `config/table-access.json`** — these contain secrets/local config
- **Never delete or update MP records** without explicit user confirmation
- This is a public repo — no hardcoded paths, credentials, or church-specific details
