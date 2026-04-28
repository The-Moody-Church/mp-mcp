# Ministry Platform MCP Server

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that gives Claude direct access to [Ministry Platform's](https://www.ministryplatform.com) REST API. Connect Claude Desktop to your MP instance and query contacts, events, groups, and other church data conversationally.

Users authenticate with their own MP credentials via OIDC, so they only see data their MP security role permits.

## Features

- **Read-only tools** — list tables, describe fields, query records, get by ID
- **Per-user OIDC auth** — each user signs in with their Ministry Platform credentials
- **Table allowlist** — configurable cap on which tables are exposed, independent of MP security roles
- **Concurrency limiting** — respects MP's connection limits
- **URL length handling** — automatically switches long GET requests to POST fallback
- **No deletes** — the server exposes no delete operations

## Prerequisites

- Node.js 22+
- A Ministry Platform instance with OIDC enabled
- An OIDC client (e.g., `TM.Widgets`) with a redirect URI pointing to your server

## Setup

### 1. Configure OIDC

In your Ministry Platform admin, add a redirect URI to your OIDC client:

```
https://your-mcp-domain.example.com/auth/callback
```

### 2. Configure environment

Copy the example env file and fill in your values:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `MP_BASE_URL` | Your MP base URL (e.g., `https://your-church.ministryplatform.com`) — no trailing slash, no `/ministryplatformapi` suffix |
| `OIDC_CLIENT_ID` | The OIDC client ID (e.g., `TM.Widgets`) |
| `OIDC_CLIENT_SECRET` | The OIDC client secret |
| `PUBLIC_URL` | The public URL where this server is hosted (e.g., `https://mcp.yourchurch.com`) |
| `PORT` | Server port (default: `3000`) |
| `ALLOWED_USER_GROUP_IDS` | (Optional) Comma-separated MP User Group IDs. Only users in these groups can log in. Leave empty to allow any authenticated MP user. |
| `ALLOWED_REDIRECT_URIS` | (Optional) Comma-separated https URIs accepted for dynamic OAuth client registration in addition to the built-in `https://claude.ai/api/mcp/auth_callback`. |
| `MEMBER_FILTER` | (Optional) SQL filter snippet identifying "members" at this church (e.g., `Member_Status_ID = 1` or `Participant_Type_ID = 4`). Surfaced to Claude as a domain convention so it doesn't have to guess. Leave empty to make Claude ask before assuming. |
| `TOOL_LOG_PATH` | (Optional) Path to a JSONL file. When set, every tool call appends `{ ts, user_id, user_name, tool, args, duration_ms, ok, error? }`. Args are logged in full — keep this on a host-local volume. Leave empty to disable. |

### 3. Configure table allowlist

Copy the example and customize which tables to expose:

```bash
cp config/table-access.example.json config/table-access.json
```

Edit `config/table-access.json` to include only the tables you want accessible through Claude. Each table can be set to read-only or read-write:

```json
{
  "Contacts": { "read": true, "write": false },
  "Events": { "read": true, "write": false }
}
```

Tables not listed are blocked entirely, regardless of the user's MP security role.

**Sensitive tables excluded from the example** — you can add these back if you need them, but they carry extra risk:

- `dp_Users` — auth metadata including password-reset tokens and hash columns. Not required for group-membership checks (the server queries it directly with the user's OIDC token outside the allowlist).
- `Background_Checks` — criminal-history data. High downside if a misconfigured role exposes them through the REST API.
- `Form_Responses` — freeform user-submitted text. High PII density and a prompt-injection surface for anything downstream of Claude.

## Deployment

### Option A: Docker (recommended)

```bash
# Copy and configure
cp docker-compose.example.yml docker-compose.yml
cp .env.example .env
cp config/table-access.example.json config/table-access.json

# Edit .env with your credentials and settings
# Edit config/table-access.json with your table allowlist

# Run
docker compose up -d
```

Or build the image locally:

```bash
docker build -t mp-mcp .
docker run -p 3000:3000 --env-file .env -v ./config/table-access.json:/app/config/table-access.json:ro mp-mcp
```

### Option B: Node.js (no Docker)

```bash
# Install and build
npm install
npm run build

# Run
npm start
```

For production without Docker, use a process manager:

```bash
# With PM2
npm install -g pm2
pm2 start dist/index.js --name mp-mcp

# Or with systemd (create a service file)
```

### Option C: Development

```bash
npm run dev
```

This uses `tsx` to watch for changes and restart automatically.

## Connecting Claude

Once the server is running, add it to your Claude Desktop or Claude Code MCP configuration:

```json
{
  "mcpServers": {
    "ministry-platform": {
      "type": "streamable-http",
      "url": "https://your-mcp-domain.example.com/mcp"
    }
  }
}
```

On first use, Claude will direct you to authenticate with your MP credentials in a browser.

## Available Tools

Domain tools (preferred — they bake in the right FK joins and disambiguation):

| Tool | Description |
|------|-------------|
| `find_people` | Search contacts by name, email, or phone |
| `get_person_details` | Full profile: contact info, group memberships, recent attendance |
| `search_groups` | Search groups by name, type, or ministry |
| `get_group_roster` | Members of a group with roles and dates |
| `get_group_attendance_summary` | Per-participant attendance over one or two date windows; supports drift-detection thresholds |
| `search_events` | Search events by date range, name, or program |
| `get_event_attendance` | Attendees + pivoted Event_Metrics for an event |
| `get_schedule` | Events on a date / range with rooms already joined; accepts `today` / `tomorrow` / `this_sunday` / `this_week` |
| `get_attendance_summary` | Aggregate Event_Metrics for a recurring service across year / month / week / per-service buckets |

Aggregation helpers (use these instead of pulling rows to count them):

| Tool | Description |
|------|-------------|
| `count_rows` | `{ count: N }` for a table + filter — paginates server-side |
| `group_by_count` | `{ groups: [{value, count}, ...], total }` — bucket by any column or FK join |
| `birth_date_range_for_age` | Convert an age range into a Date_of_Birth filter snippet (handles the calculated-Age problem) |

Generic fallbacks (power-user / ad-hoc):

| Tool | Description |
|------|-------------|
| `list_tables` | List allowlisted tables |
| `describe_table` | Field names and types; surfaces `fk_join_prefix` / `lookup_table` for FK columns |
| `query_table` | Raw filtered query; response wrapped as `{ data, row_count, has_more, next_skip }` |
| `get_record` | Fetch a single record by ID |

### Query examples

Claude can use these tools naturally. For example:

- "What's on the schedule tomorrow?"
- "Year-over-year attendance for the Sunday Morning Service"
- "Mosaic group members who came consistently last fall but haven't this spring"
- "How many active members are 65–69?"
- "Look up the contact record for John Smith"

### Query syntax

The `query_table` tool supports Ministry Platform's query parameters:

- **`$filter`** — SQL WHERE syntax: `Display_Name LIKE '%Smith%'`, `Event_Start_Date > GETDATE()`
- **`$select`** — Column names: `Contact_ID, Display_Name, Email_Address`
- **`$orderby`** — Sort: `Display_Name` or `Event_Start_Date DESC`
- **`$top`** / **`$skip`** — Pagination (max 1000 per request)
- **FK joins** — `Contact_ID_Table.Display_Name`, `Event_ID_Table.Event_Title`

## Security

### Authentication

Users authenticate via OIDC with their Ministry Platform credentials. The server uses the user's own access token for all MP API calls, so MP's security roles enforce what data they can see — the same permissions they have in the MP web UI.

### Table allowlist

The `config/table-access.json` file acts as an additional ceiling on top of MP security roles. Even if a user's MP role grants access to sensitive tables (e.g., Donations), the MCP server won't expose them unless explicitly listed in the allowlist.

### No secrets on client machines

The MCP server URL is the only thing configured on staff machines. All credentials and tokens are managed server-side.

### Further reading

See [`docs/security-posture.md`](docs/security-posture.md) for the full control inventory, `query_table` power-user guidance, and documented accepted risks.

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/mcp` | POST/GET/DELETE | MCP streamable HTTP endpoint |
| `/auth/login` | GET | Initiates OIDC login flow |
| `/auth/callback` | GET | OIDC redirect callback |
| `/auth/logout` | GET | Ends session |
| `/health` | GET | Health check |

## Releases

Images are published to `ghcr.io/the-moody-church/mp-mcp` on every push to any branch and on every git tag matching `v*`.

### Channels

| Tag | Updates on | Use for |
|-----|-----------|---------|
| `:latest` | a new stable release is tagged | production (default) |
| `:0`, `:0.2` | a release in that major/minor is tagged | production, pinned to a major or minor line |
| `:0.2.0` | never (immutable) | production, pinned to an exact release |
| `:main` | every push to `main` | testing the latest merged commit |
| `:dev` | every push to any non-`main` branch | previewing a PR before it merges |
| `:sha-abc1234` | never (immutable) | reproducing a specific commit's behavior |

`:latest` only moves when a release is cut — it does **not** track every push to `main`.

`:dev` is single-tenant — whichever non-`main` branch was pushed most recently wins. If you have multiple PRs in flight and need to test a specific one, use that PR's `:sha-<short>` tag instead.

### Cutting a release

Releases are git-tag driven. To cut `v0.2.0`:

```bash
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

The push triggers the workflow, which builds the image and tags it `:0.2.0`, `:0.2`, `:0`, and `:latest`. Pre-release identifiers (`v0.2.0-rc.1`) are also accepted by `docker/metadata-action`'s semver matcher and produce only the exact tag (no `:latest` move).

Keep `package.json` `version` in sync with the git tag when you cut one.

## License

MIT
