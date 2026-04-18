import express from "express";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createMcpServer } from "./server.js";
import { loadAppConfig, loadTableAccess } from "./config.js";

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const config = loadAppConfig();

// Validate table access config on startup
loadTableAccess();

// ── OAuth proxy provider ───────────────────────────────────────────────────
// Proxies OAuth to Ministry Platform's OIDC endpoints.
// Claude Desktop handles the OAuth flow; we just forward to MP.

const mpOAuthBase = `${config.mpBaseUrl}/ministryplatformapi/oauth`;

// In-memory store for dynamically registered OAuth clients
const registeredClients = new Map<string, OAuthClientInformationFull>();
const MAX_REGISTERED_CLIENTS = 1000;

// Short-lived cache of verified tokens. Every MCP tool call otherwise hits
// MP's userinfo endpoint (and possibly dp_Users/dp_User_User_Groups) — one
// verify per call amplifies traffic and creates a DoS vector. Keyed by
// sha256(token) so raw tokens never sit in memory as map keys.
const verifyCache = new Map<string, { authInfo: AuthInfo; cachedAt: number }>();
const VERIFY_CACHE_TTL_MS = 60_000;
const MAX_VERIFY_CACHE = 10_000;

// Allowlist of redirect URIs accepted during dynamic client registration.
// Built-in entry for Claude's MCP callback; operators can add more via
// ALLOWED_REDIRECT_URIS. Any URI outside the list (or non-https) is rejected.
const BUILTIN_REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback"];

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
  const res = await fetch(input, init);
  if (!res.ok) {
    console.error(`[OAuth proxy] ${res.status} ${url}`);
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
    const cacheKey = tokenHash(token);
    const cached = verifyCache.get(cacheKey);
    if (cached && Date.now() - cached.cachedAt < VERIFY_CACHE_TTL_MS) {
      const exp = cached.authInfo.expiresAt;
      if (exp === undefined || exp * 1000 > Date.now()) {
        return cached.authInfo;
      }
      verifyCache.delete(cacheKey);
    }

    // Verify the token by calling MP's userinfo endpoint
    const res = await fetch(`${mpOAuthBase}/connect/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      console.error(`[verifyAccessToken] userinfo failed ${res.status}`);
      throw new Error("Invalid or expired token");
    }
    console.log(`[verifyAccessToken] userinfo OK`);

    const userinfo = (await res.json()) as Record<string, string>;

    // Fail-closed user group restriction: when configured, deny unless we
    // can positively confirm membership in at least one allowed group.
    if (config.allowedUserGroupIds.length > 0) {
      const denied = new Error("User not in allowed groups");
      const apiBase = `${config.mpBaseUrl}/ministryplatformapi`;
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };

      let hasAccess = false;
      try {
        const usersRes = await fetch(
          `${apiBase}/tables/dp_Users?$filter=${encodeURIComponent(`User_GUID='${userinfo.sub}'`)}&$select=User_ID`,
          { headers }
        );
        if (!usersRes.ok) throw denied;
        const users = (await usersRes.json()) as Array<{ User_ID: number }>;
        if (users.length === 0) throw denied;

        const groupsRes = await fetch(
          `${apiBase}/tables/dp_User_User_Groups?$filter=${encodeURIComponent(`User_ID=${users[0].User_ID}`)}&$select=User_Group_ID`,
          { headers }
        );
        if (!groupsRes.ok) throw denied;
        const groups = (await groupsRes.json()) as Array<{ User_Group_ID: number }>;
        hasAccess = groups.some((g) =>
          config.allowedUserGroupIds.includes(g.User_Group_ID)
        );
      } catch {
        throw denied;
      }
      if (!hasAccess) throw denied;
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

    const authInfo: AuthInfo = {
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

    if (verifyCache.size >= MAX_VERIFY_CACHE) {
      const oldest = verifyCache.keys().next().value;
      if (oldest) verifyCache.delete(oldest);
    }
    verifyCache.set(cacheKey, { authInfo, cachedAt: Date.now() });
    return authInfo;
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
        const allowedRedirects = new Set<string>([
          ...BUILTIN_REDIRECT_URIS,
          ...config.allowedRedirectUris,
        ]);
        const redirectUris = clientInfo.redirect_uris ?? [];
        if (redirectUris.length === 0) {
          throw new Error("redirect_uris is required");
        }
        for (const uri of redirectUris) {
          if (!uri.startsWith("https://") || !allowedRedirects.has(uri)) {
            throw new Error(`redirect_uri not allowed: ${uri}`);
          }
        }

        const clientId = clientInfo.client_id || randomUUID();
        const clientSecret =
          clientInfo.client_secret || randomBytes(32).toString("hex");
        const full: OAuthClientInformationFull = {
          ...clientInfo,
          client_id: clientId,
          client_secret: clientSecret,
        };

        if (registeredClients.size >= MAX_REGISTERED_CLIENTS) {
          const oldestKey = registeredClients.keys().next().value;
          if (oldestKey) registeredClients.delete(oldestKey);
        }
        registeredClients.set(clientId, full);
        return full;
      },
    };
  },
});

const app = express();

// Trust proxy headers (Cloudflare tunnel sets X-Forwarded-For)
app.set("trust proxy", 1);

app.use((req, _res, next) => {
  const auth = req.headers.authorization ? " [Bearer]" : "";
  console.log(`[HTTP] ${req.method} ${req.path}${auth}`);
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

// Transports are indexed twice: once by a per-user key (userId/token) and
// once by the session id the transport assigns on init. A separate
// activity map tracks the *user-key* timestamp, so we can sweep the whole
// logical session (both index entries) when a client vanishes without
// closing cleanly.
const transports = new Map<string, StreamableHTTPServerTransport>();
const transportActivity = new Map<string, number>();
const TRANSPORT_IDLE_TTL_MS = 30 * 60 * 1000;
const MAX_TRANSPORTS = 500;
const TRANSPORT_SWEEP_MS = 5 * 60 * 1000;

function touchTransport(key: string): void {
  transportActivity.set(key, Date.now());
}

function closeTransport(key: string): void {
  const t = transports.get(key);
  if (t) {
    if (t.sessionId) transports.delete(t.sessionId);
    transports.delete(key);
    try {
      t.close();
    } catch {
      // best-effort — the transport may already be closed
    }
  }
  transportActivity.delete(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, last] of transportActivity) {
    if (now - last > TRANSPORT_IDLE_TTL_MS) closeTransport(key);
  }
}, TRANSPORT_SWEEP_MS).unref();

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

// Per-token rate limit for MCP traffic. The SDK rate-limits /register and
// /token but not custom routes; a client holding a valid token would
// otherwise be able to spam userinfo (each request re-verifies).
const mcpRateLimit = rateLimit({
  windowMs: 60_000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const h = req.headers.authorization;
    if (h?.startsWith("Bearer ")) return tokenHash(h.slice(7));
    return req.ip || "unknown";
  },
  message: { error: "Too many requests" },
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

  console.log(`[MCP] authenticated user: ${authInfo.extra?.userId || "unknown"}`);
  const transportKey = authInfo.extra?.userId as string || authInfo.token;

  // Check if this is an initialize request (new connection)
  const isInitialize = req.method === "POST" && req.body?.method === "initialize";
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // Get existing transport by session ID or user key
  let transport = sessionId
    ? transports.get(sessionId)
    : isInitialize ? undefined : transports.get(transportKey);

  // Create a fresh transport when none exists (initialize, reconnect, or stale session)
  if (!transport) {
    closeTransport(transportKey);

    if (transportActivity.size >= MAX_TRANSPORTS) {
      let oldestKey: string | undefined;
      let oldestTs = Infinity;
      for (const [k, ts] of transportActivity) {
        if (ts < oldestTs) { oldestTs = ts; oldestKey = k; }
      }
      if (oldestKey) closeTransport(oldestKey);
    }

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transports.set(transportKey, transport);

    const server = createMcpServer();
    await server.connect(transport);

    transport.onclose = () => {
      if (transport!.sessionId) transports.delete(transport!.sessionId);
      transports.delete(transportKey);
      transportActivity.delete(transportKey);
    };
  }
  touchTransport(transportKey);
  await transport.handleRequest(req, res, req.body);

  // Store by session ID after first request so subsequent requests route correctly
  if (transport.sessionId && !transports.has(transport.sessionId)) {
    transports.set(transport.sessionId, transport);
  }
}

app.post("/mcp", mcpRateLimit, bearerAuth, handleMcp);
app.get("/mcp", mcpRateLimit, bearerAuth, handleMcp);
app.delete("/mcp", mcpRateLimit, bearerAuth, handleMcp);

// Also serve MCP at root — Claude Desktop may probe "/" depending on connector URL
app.post("/", mcpRateLimit, bearerAuthRoot, handleMcp);
app.get("/", mcpRateLimit, bearerAuthRoot, handleMcp);
app.delete("/", mcpRateLimit, bearerAuthRoot, handleMcp);

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
  res.json({ status: "ok" });
});

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(config.port, "0.0.0.0", () => {
  console.log(`mp-mcp server listening on port ${config.port}`);
  console.log(`  MCP endpoint: ${config.publicUrl}/mcp`);
  console.log(`  Health check: ${config.publicUrl}/health`);
});
