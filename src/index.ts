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

const oauthProvider = new ProxyOAuthServerProvider({
  endpoints: {
    authorizationUrl: `${mpOAuthBase}/connect/authorize`,
    tokenUrl: `${mpOAuthBase}/connect/token`,
  },

  verifyAccessToken: async (token: string): Promise<AuthInfo> => {
    // Verify the token by calling MP's userinfo endpoint
    const res = await fetch(`${mpOAuthBase}/connect/userinfo`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error("Invalid or expired token");
    }

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

    return {
      token,
      clientId: config.oidcClientId,
      scopes: ["openid", "offline_access"],
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
    // Check the in-memory store first (populated by /register)
    const stored = await oauthProvider.clientsStore.getClient(clientId);
    if (stored) return stored;

    // Fallback for the known OIDC client — should not normally be needed
    // since Claude Desktop registers dynamically via /register first.
    return undefined;
  },
});

// PKCE validation is handled by MP's OAuth server, not locally
oauthProvider.skipLocalPkceValidation = true;

const app = express();

// Trust proxy headers (Cloudflare tunnel sets X-Forwarded-For)
app.set("trust proxy", 1);

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

async function handleMcp(req: express.Request, res: express.Response) {
  // req.auth is set by bearerAuth middleware
  const authInfo = req.auth;
  if (!authInfo) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const transportKey = authInfo.extra?.userId as string || authInfo.token;

  // Get or create a transport for this user
  let transport = transports.get(transportKey);
  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transports.set(transportKey, transport);

    const server = createMcpServer();
    await server.connect(transport);

    transport.onclose = () => {
      transports.delete(transportKey);
    };
  }

  await transport.handleRequest(req, res, req.body);
}

app.post("/mcp", bearerAuth, handleMcp);
app.get("/mcp", bearerAuth, handleMcp);
app.delete("/mcp", bearerAuth, handleMcp);

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
