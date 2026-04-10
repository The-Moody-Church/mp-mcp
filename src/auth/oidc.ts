import * as client from "openid-client";
import type { AppConfig } from "../config.js";

let cachedConfig: client.Configuration | null = null;

/**
 * Get or create the OIDC client configuration by discovering the MP OIDC endpoints.
 */
async function getOidcConfig(appConfig: AppConfig): Promise<client.Configuration> {
  if (cachedConfig) return cachedConfig;

  const issuerUrl = new URL(
    "/ministryplatformapi/oauth",
    appConfig.mpBaseUrl
  );

  cachedConfig = await client.discovery(
    issuerUrl,
    appConfig.oidcClientId,
    appConfig.oidcClientSecret
  );

  return cachedConfig;
}

/**
 * Build the OIDC authorization URL to redirect the user to MP's login page.
 */
export async function getAuthorizationUrl(
  appConfig: AppConfig,
  state: string
): Promise<string> {
  const config = await getOidcConfig(appConfig);
  const redirectUri = `${appConfig.publicUrl}/auth/callback`;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: appConfig.oidcClientId,
    redirect_uri: redirectUri,
    scope: "openid offline_access http://www.thinkministry.com/dataplatform/scopes/all",
    state,
  });

  const authEndpoint = config.serverMetadata().authorization_endpoint;
  if (!authEndpoint) {
    throw new Error("OIDC discovery did not return an authorization_endpoint");
  }

  return `${authEndpoint}?${params.toString()}`;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  sub?: string;
}

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCode(
  appConfig: AppConfig,
  code: string
): Promise<TokenSet> {
  const config = await getOidcConfig(appConfig);
  const redirectUri = `${appConfig.publicUrl}/auth/callback`;

  const tokens = await client.authorizationCodeGrant(config, new URL(`${redirectUri}?code=${code}`), {
    expectedState: client.skipStateCheck,
  });

  if (!tokens.access_token) {
    throw new Error("Token exchange did not return an access_token");
  }

  // Extract sub from ID token claims if available
  const claims = tokens.claims();
  const sub = claims?.sub;

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : undefined,
    sub,
  };
}

/**
 * Refresh an access token using a refresh token.
 */
export async function refreshAccessToken(
  appConfig: AppConfig,
  refreshToken: string
): Promise<TokenSet> {
  const config = await getOidcConfig(appConfig);

  const tokens = await client.refreshTokenGrant(config, refreshToken);

  if (!tokens.access_token) {
    throw new Error("Token refresh did not return an access_token");
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresAt: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : undefined,
  };
}

export interface UserInfo {
  sub: string;
  email?: string;
  name?: string;
  mpUserId?: number;
  userGroupIds: number[];
}

/**
 * Fetch the user's profile from MP's OIDC userinfo endpoint,
 * then look up their MP User_ID and user group memberships.
 */
export async function getUserInfo(
  appConfig: AppConfig,
  accessToken: string,
  sub?: string
): Promise<UserInfo> {
  // Fetch userinfo — use the library if we have a sub, otherwise call directly
  let userSub: string;
  let email: string | undefined;
  let name: string | undefined;

  if (sub) {
    try {
      const config = await getOidcConfig(appConfig);
      const userinfo = await client.fetchUserInfo(config, accessToken, sub);
      userSub = userinfo.sub;
      email = userinfo.email;
      name = [userinfo.given_name, userinfo.family_name].filter(Boolean).join(" ") || undefined;
    } catch {
      userSub = sub;
    }
  } else {
    // No sub from ID token — call userinfo endpoint directly
    const userinfoUrl = `${appConfig.mpBaseUrl}/ministryplatformapi/oauth/connect/userinfo`;
    const res = await fetch(userinfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch userinfo: ${res.status}`);
    }
    const userinfo = (await res.json()) as Record<string, string>;
    userSub = userinfo.sub;
    email = userinfo.email;
    name = [userinfo.given_name, userinfo.family_name].filter(Boolean).join(" ") || undefined;
  }

  const baseInfo: UserInfo = {
    sub: userSub,
    email,
    name,
    userGroupIds: [],
  };

  // Look up the user's MP User_ID and group memberships
  try {
    const apiBase = `${appConfig.mpBaseUrl}/ministryplatformapi`;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };

    // Get the user record by GUID
    const usersRes = await fetch(
      `${apiBase}/tables/dp_Users?$filter=${encodeURIComponent(`User_GUID='${userSub}'`)}&$select=User_ID`,
      { headers }
    );
    if (usersRes.ok) {
      const users = (await usersRes.json()) as Array<{ User_ID: number }>;
      if (users.length > 0) {
        baseInfo.mpUserId = users[0].User_ID;

        // Get group memberships
        const groupsRes = await fetch(
          `${apiBase}/tables/dp_User_User_Groups?$filter=${encodeURIComponent(`User_ID=${users[0].User_ID}`)}&$select=User_Group_ID`,
          { headers }
        );
        if (groupsRes.ok) {
          const groups = (await groupsRes.json()) as Array<{ User_Group_ID: number }>;
          baseInfo.userGroupIds = groups.map((g) => g.User_Group_ID);
        }
      }
    }
  } catch (err) {
    // Non-fatal — user can still authenticate, just without group info
    console.warn("Failed to fetch MP user groups:", err);
  }

  return baseInfo;
}
