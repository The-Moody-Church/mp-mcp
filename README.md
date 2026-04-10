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

- Node.js 20+
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
| `SESSION_SECRET` | Random string for signing session cookies — generate with `openssl rand -hex 32` |

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

## Deployment

### Option A: Docker (recommended)

```bash
# Copy and configure
cp docker-compose.example.yml docker-compose.yml
cp config/table-access.example.json config/table-access.json

# Edit docker-compose.yml with your environment values
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

| Tool | Description |
|------|-------------|
| `list_tables` | List all tables available through the allowlist |
| `describe_table` | Get field names and sample values for a table |
| `query_table` | Query records with filters, column selection, sorting, and pagination |
| `get_record` | Get a single record by table name and ID |

### Query examples

Claude can use these tools naturally. For example:

- "Show me all events happening this week"
- "Look up the contact record for John Smith"
- "How many people are in the Choir group?"
- "What fields does the Events table have?"

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

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/mcp` | POST/GET/DELETE | MCP streamable HTTP endpoint |
| `/auth/login` | GET | Initiates OIDC login flow |
| `/auth/callback` | GET | OIDC redirect callback |
| `/auth/logout` | GET | Ends session |
| `/health` | GET | Health check |

## License

MIT
