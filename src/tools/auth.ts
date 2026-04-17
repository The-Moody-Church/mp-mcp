/**
 * Shared auth extraction for all tool modules.
 */
export function getAuthFromExtra(extra: Record<string, unknown>): {
  mpBaseUrl: string;
  accessToken: string;
} {
  const authInfo = (extra as { authInfo?: { token?: string; extra?: { mpBaseUrl?: string; accessToken?: string } } })
    .authInfo;
  const mpBaseUrl = authInfo?.extra?.mpBaseUrl;
  const accessToken = authInfo?.extra?.accessToken || authInfo?.token;
  if (!mpBaseUrl || !accessToken) {
    throw new Error("Not authenticated — please log in first");
  }
  return { mpBaseUrl, accessToken };
}
