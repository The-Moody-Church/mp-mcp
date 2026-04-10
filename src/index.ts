import express from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import { loadAppConfig, loadTableAccess } from "./config.js";
import {
  getAuthorizationUrl,
  exchangeCode,
  getUserInfo,
} from "./auth/oidc.js";
import {
  createOidcState,
  consumeOidcState,
  createSession,
  getSession,
  deleteSession,
  signSessionCookie,
  verifySessionCookie,
  parseCookies,
} from "./auth/session.js";

const config = loadAppConfig();

// Validate table access config on startup
loadTableAccess();

const app = express();
app.use(express.json());

// ── Session-scoped MCP transports ──────────────────────────────────────────

const transports = new Map<string, StreamableHTTPServerTransport>();

/**
 * Extract the session from the request cookie, or return null.
 */
async function getSessionFromRequest(req: express.Request) {
  const cookies = parseCookies(req.headers.cookie);
  const signed = cookies["mp_mcp_session"];
  if (!signed) return null;

  const sessionId = verifySessionCookie(signed, config.sessionSecret);
  if (!sessionId) return null;

  return { sessionId, session: await getSession(sessionId, config) };
}

// ── Auth routes ────────────────────────────────────────────────────────────

app.get("/auth/login", async (_req, res) => {
  const state = createOidcState();
  const url = await getAuthorizationUrl(config, state);
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || typeof code !== "string" || typeof state !== "string") {
    res.status(400).send("Missing code or state parameter");
    return;
  }

  if (!consumeOidcState(state)) {
    res.status(400).send("Invalid or expired state parameter");
    return;
  }

  try {
    const tokens = await exchangeCode(config, code);
    const user = await getUserInfo(config, tokens.accessToken);

    // Check user group membership if restrictions are configured
    if (config.allowedUserGroupIds.length > 0) {
      const hasAccess = user.userGroupIds.some((gid) =>
        config.allowedUserGroupIds.includes(gid)
      );
      if (!hasAccess) {
        console.warn(
          `Access denied for ${user.name || user.sub} — not in allowed user groups. ` +
          `User groups: [${user.userGroupIds.join(", ")}], allowed: [${config.allowedUserGroupIds.join(", ")}]`
        );
        res.status(403).send(
          `<html><body>
            <h2>Access Denied</h2>
            <p>Your Ministry Platform account does not have access to this service. Contact your administrator.</p>
          </body></html>`
        );
        return;
      }
    }

    const sessionId = createSession(user, tokens);
    const cookie = signSessionCookie(sessionId, config.sessionSecret);

    res.setHeader(
      "Set-Cookie",
      `mp_mcp_session=${encodeURIComponent(cookie)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
    );
    res.send(
      `<html><body>
        <h2>Authenticated as ${user.name || user.email || user.sub}</h2>
        <p>You can close this window and return to Claude.</p>
      </body></html>`
    );
  } catch (err) {
    console.error("OIDC callback error:", err);
    res.status(500).send("Authentication failed");
  }
});

app.get("/auth/logout", async (req, res) => {
  const result = await getSessionFromRequest(req);
  if (result?.sessionId) {
    deleteSession(result.sessionId);
    // Clean up any MCP transports for this session
    const transport = transports.get(result.sessionId);
    if (transport) {
      await transport.close();
      transports.delete(result.sessionId);
    }
  }
  res.setHeader(
    "Set-Cookie",
    "mp_mcp_session=; Path=/; HttpOnly; Max-Age=0"
  );
  res.send("Logged out");
});

// ── MCP endpoint ───────────────────────────────────────────────────────────

async function handleMcp(req: express.Request, res: express.Response) {
  const result = await getSessionFromRequest(req);

  if (!result?.session) {
    // Not authenticated — tell the client where to authenticate
    res.status(401).json({
      error: "Not authenticated",
      loginUrl: `${config.publicUrl}/auth/login`,
      message:
        "Visit the loginUrl in a browser to authenticate with Ministry Platform, then retry.",
    });
    return;
  }

  const { sessionId, session } = result;

  // Set authInfo on the request so the MCP transport passes it to tool handlers
  (req as express.Request & { auth?: unknown }).auth = {
    token: session.tokens.accessToken,
    clientId: config.oidcClientId,
    scopes: ["openid", "offline_access"],
    extra: {
      mpBaseUrl: config.mpBaseUrl,
      accessToken: session.tokens.accessToken,
      userId: session.user.sub,
      userName: session.user.name,
    },
  };

  // Get or create a transport for this session
  let transport = transports.get(sessionId);
  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transports.set(sessionId, transport);

    const server = createMcpServer();
    await server.connect(transport);

    // Clean up on close
    transport.onclose = () => {
      transports.delete(sessionId);
    };
  }

  await transport.handleRequest(req, res, req.body);
}

app.post("/mcp", handleMcp);
app.get("/mcp", handleMcp);
app.delete("/mcp", handleMcp);

// ── Health check ───────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", version: "0.1.0" });
});

// ── Start ──────────────────────────────────────────────────────────────────

app.listen(config.port, "0.0.0.0", () => {
  console.log(`mp-mcp server listening on port ${config.port}`);
  console.log(`  MCP endpoint: ${config.publicUrl}/mcp`);
  console.log(`  Auth login:   ${config.publicUrl}/auth/login`);
  console.log(`  Health check: ${config.publicUrl}/health`);
});
