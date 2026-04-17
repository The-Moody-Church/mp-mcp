import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createMcpServer } from "./server.js";
import { loadAppConfig, loadTableAccess } from "./config.js";

const config = loadAppConfig();

// Validate table access config on startup
loadTableAccess();

// ── OAuth proxy provider ───────────────────────────────────────────────────
// Proxies OAuth to Ministry Platform's OIDC endpoints.
// Claude Desktop handles the OAuth flow; we just forward to MP.

const mpOAuthBase = `${config.mpBaseUrl}/ministryplatformapi/oauth`;

// In-memory store for dynamically registered OAuth clients
const registeredClients = new Map<string, OAuthClientInformationFull>();

// Custom fetch that strips parameters MP doesn't understand
// and logs requests for debugging.
const mpFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method || "GET";

  // For token endpoint POSTs, strip parameters MP doesn't support
  if (method === "POST" && url.includes("/token") && typeof init?.body === "string") {
    const params = new URLSearchParams(init.body);
    // MP doesn't support RFC 8707 resource indicators
    params.delete("resource");
    // MP doesn't support PKCE code_verifier (skipLocalPkceValidation
    // prevents our server from checking it, but MP also rejects it)
    params.delete("code_verifier");
    init = { ...init, body: params.toString() };
  }

  console.log(`[OAuth proxy] ${method} ${url}`);
  if (init?.body) {
    console.log(`[OAuth proxy] body: ${init.body}`);
  }
  const res = await fetch(input, init);
  if (!res.ok) {
    const text = await res.clone().text();
    console.error(`[OAuth proxy] ${res.status} response: ${text}`);
  } else if (url.includes("/token")) {
    const text = await res.clone().text();
    // Log the field names (not values) to see the response structure
    try {
      const json = JSON.parse(text);
      const fields = Object.keys(json).map(k => `${k}=${typeof json[k] === 'string' ? json[k].substring(0, 15) + '...' : json[k]}`);
      console.log(`[OAuth proxy] ${res.status} token response fields: ${fields.join(', ')}`);
    } catch {
      console.log(`[OAuth proxy] ${res.status} token response (not JSON): ${text.substring(0, 100)}`);
    }
  }
  return res;
};

const oauthProvider = new ProxyOAuthServerProvider({
  endpoints: {
    authorizationUrl: `${mpOAuthBase}/connect/authorize`,
    tokenUrl: `${mpOAuthBase}/connect/token`,
  },
  fetch: mpFetch,

  verifyAccessToken: async (token: string): Promise<AuthInfo> => {
    console.log(`[verifyAccessToken] checking token: ${token.substring(0, 20)}...`);
    // Verify the token by calling MP's userinfo endpoint
    const res = await fetch(`${mpOAuthBase}/connect/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`[verifyAccessToken] userinfo failed ${res.status}: ${text}`);
      throw new Error("Invalid or expired token");
    }
    console.log(`[verifyAccessToken] userinfo OK`);

    const userinfo = (await res.json()) as Record<string, string>;

    // Check user group restrictions if configured
    if (config.allowedUserGroupIds.length > 0) {
      try {
        const apiBase = `${config.mpBaseUrl}/ministryplatformapi`;
        const headers = {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        };

        const usersRes = await fetch(
          `${apiBase}/tables/dp_Users?$filter=${encodeURIComponent(`User_GUID='${userinfo.sub}'`)}&$select=User_ID`,
          { headers }
        );

        if (usersRes.ok) {
          const users = (await usersRes.json()) as Array<{ User_ID: number }>;
          if (users.length > 0) {
            const groupsRes = await fetch(
              `${apiBase}/tables/dp_User_User_Groups?$filter=${encodeURIComponent(`User_ID=${users[0].User_ID}`)}&$select=User_Group_ID`,
              { headers }
            );

            if (groupsRes.ok) {
              const groups = (await groupsRes.json()) as Array<{ User_Group_ID: number }>;
              const userGroupIds = groups.map((g) => g.User_Group_ID);
              const hasAccess = userGroupIds.some((gid) =>
                config.allowedUserGroupIds.includes(gid)
              );

              if (!hasAccess) {
                throw new Error("User not in allowed groups");
              }
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message === "User not in allowed groups") {
          throw err;
        }
        // Non-fatal — allow access if group check fails
        console.warn("Failed to check user groups:", err);
      }
    }

    // Extract expiration from the JWT's exp claim
    let expiresAt: number = Math.floor(Date.now() / 1000) + 3600; // fallback: 1 hour
    try {
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString()
      );
      if (typeof payload.exp === "number") {
        expiresAt = payload.exp;
      }
    } catch {
      // Non-fatal — use fallback expiration
    }

    return {
      token,
      clientId: config.oidcClientId,
      scopes: ["openid", "offline_access"],
      expiresAt,
      extra: {
        mpBaseUrl: config.mpBaseUrl,
        accessToken: token,
        userId: userinfo.sub,
        userName: [userinfo.given_name, userinfo.family_name]
          .filter(Boolean)
          .join(" "),
      },
    };
  },

  getClient: async (clientId: string): Promise<OAuthClientInformationFull | undefined> => {
    return registeredClients.get(clientId);
  },
});

// PKCE validation is handled by MP's OAuth server, not locally
oauthProvider.skipLocalPkceValidation = true;

// Override clientsStore to handle dynamic client registration locally.
// Claude Desktop calls /register before /authorize to register its redirect_uri.
const originalClientStore = oauthProvider.clientsStore;
Object.defineProperty(oauthProvider, "clientsStore", {
  get() {
    return {
      getClient: async (clientId: string) => {
        // Check dynamically registered clients first
        const stored = registeredClients.get(clientId);
        if (stored) return stored;

        // If it's our configured OIDC client, return it directly.
        // Claude Desktop sends the client_id from the connector config
        // without always going through /register first.
        if (clientId === config.oidcClientId) {
          return {
            client_id: clientId,
            client_secret: config.oidcClientSecret,
            redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
          } as unknown as OAuthClientInformationFull;
        }

        return undefined;
      },
      registerClient: async (clientInfo: OAuthClientInformationFull) => {
        const clientId = clientInfo.client_id || randomUUID();
        const full: OAuthClientInformationFull = {
          ...clientInfo,
          client_id: clientId,
          client_secret: clientInfo.client_secret || config.oidcClientSecret,
        };
        registeredClients.set(clientId, full);
        return full;
      },
    };
  },
});

const app = express();

// Trust proxy headers (Cloudflare tunnel sets X-Forwarded-For)
app.set("trust proxy", 1);

// Log every incoming HTTP request and capture MCP responses
app.use((req, res, next) => {
  const auth = req.headers.authorization ? " [Bearer]" : "";
  console.log(`[HTTP] ${req.method} ${req.path}${auth}`);

  // Intercept response for /mcp to log what we're sending back
  if (req.path === "/mcp" || req.path === "/") {
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    const chunks: Buffer[] = [];

    const origWriteFn = res.write;
    res.write = function (this: any, chunk: any) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return origWriteFn.apply(this, arguments as any);
    } as any;

    const origEndFn = res.end;
    res.end = function (this: any, chunk: any) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const body = Buffer.concat(chunks).toString("utf8");
      if (body.length > 0 && body.length < 5000) {
        console.log(`[MCP Response] ${res.statusCode} ${body.substring(0, 2000)}`);
      } else if (body.length >= 5000) {
        console.log(`[MCP Response] ${res.statusCode} (${body.length} bytes) ${body.substring(0, 500)}...`);
      }
      return origEndFn.apply(this, arguments as any);
    } as any;
  }

  next();
});

// ── MCP OAuth auth routes (metadata, authorize, token, register) ───────────
// Must be mounted at root before any body parsing middleware.

app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: new URL(config.publicUrl),
    baseUrl: new URL(config.publicUrl),
    scopesSupported: [
      "openid",
      "offline_access",
      "http://www.thinkministry.com/dataplatform/scopes/all",
    ],
    resourceName: "Ministry Platform MCP Server",
    resourceServerUrl: new URL(`${config.publicUrl}/mcp`),
  })
);

app.use(express.json());

// ── Session-scoped MCP transports ──────────────────────────────────────────

const transports = new Map<string, StreamableHTTPServerTransport>();

// ── MCP endpoint (protected by Bearer auth) ────────────────────────────────

const bearerAuth = requireBearerAuth({
  verifier: oauthProvider,
  resourceMetadataUrl: `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`,
});

// Separate bearer auth for root path — points to root resource metadata
const bearerAuthRoot = requireBearerAuth({
  verifier: oauthProvider,
  resourceMetadataUrl: `${config.publicUrl}/.well-known/oauth-protected-resource`,
});

async function handleMcp(req: express.Request, res: express.Response) {
  console.log(`[MCP] handleMcp called: ${req.method} ${req.path}`);
  // req.auth is set by bearerAuth middleware
  const authInfo = req.auth;
  if (!authInfo) {
    console.log(`[MCP] no authInfo — returning 401`);
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  console.log(`[MCP] authenticated user: ${authInfo.extra?.userName || authInfo.extra?.userId || "unknown"}`);
  const transportKey = authInfo.extra?.userId as string || authInfo.token;

  // Check if this is an initialize request (new connection)
  const isInitialize = req.method === "POST" && req.body?.method === "initialize";
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Get existing transport by session ID or user key
  let transport = sessionId
    ? transports.get(sessionId)
    : isInitialize ? undefined : transports.get(transportKey);

  // Create a new transport for initialize requests
  if (!transport && (isInitialize || req.method === "GET")) {
    // Clean up any existing transport for this user
    const oldTransport = transports.get(transportKey);
    if (oldTransport) {
      transports.delete(transportKey);
    }

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    // Store by both user key (for cleanup) and session ID (for routing)
    transports.set(transportKey, transport);

    const server = createMcpServer();
    await server.connect(transport);

    transport.onclose = () => {
      if (transport!.sessionId) transports.delete(transport!.sessionId);
      transports.delete(transportKey);
    };

    // Also store by session ID once assigned (after handleRequest)
    const origSessionId = transport.sessionId;
    if (origSessionId) {
      transports.set(origSessionId, transport);
    }
  }

  if (!transport) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "No active session. Send an initialize request first." },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);

  // After the first request, store by session ID if newly assigned
  if (isInitialize && transport.sessionId && !transports.has(transport.sessionId)) {
    transports.set(transport.sessionId, transport);
  }
}

app.post("/mcp", bearerAuth, handleMcp);
app.get("/mcp", bearerAuth, handleMcp);
app.delete("/mcp", bearerAuth, handleMcp);

// Also serve MCP at root — Claude Desktop may probe "/" depending on connector URL
app.post("/", bearerAuthRoot, handleMcp);
app.get("/", bearerAuthRoot, handleMcp);
app.delete("/", bearerAuthRoot, handleMcp);

// Serve protected resource metadata at root path too (the SDK only serves at /mcp suffix).
// Points to root as the resource so Claude Desktop scopes the token to "/" correctly.
app.get("/.well-known/oauth-protected-resource", (_req, res) => {
  res.json({
    resource: `${config.publicUrl}/`,
    authorization_servers: [`${config.publicUrl}/`],
    scopes_supported: [
      "openid",
      "offline_access",
      "http://www.thinkministry.com/dataplatform/scopes/all",
    ],
    resource_name: "Ministry Platform MCP Server",
  });
});

// ── Health check ───────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "0.1.0" });
});

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(config.port, "0.0.0.0", () => {
  console.log(`mp-mcp server listening on port ${config.port}`);
  console.log(`  MCP endpoint: ${config.publicUrl}/mcp`);
  console.log(`  Health check: ${config.publicUrl}/health`);
});
