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

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : undefined,
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
}

/**
 * Fetch the user's profile from MP's OIDC userinfo endpoint.
 */
export async function getUserInfo(
  appConfig: AppConfig,
  accessToken: string
): Promise<UserInfo> {
  const config = await getOidcConfig(appConfig);
  const userinfo = await client.fetchUserInfo(config, accessToken, "");

  return {
    sub: userinfo.sub,
    email: userinfo.email,
    name: [userinfo.given_name, userinfo.family_name].filter(Boolean).join(" ") || undefined,
  };
}
