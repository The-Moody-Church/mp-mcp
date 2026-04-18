import { sanitizeErrorMessage } from "./utils/filter-sanitize.js";
import {
  type QueryParams,
  buildQueryString,
  checkUrlLength,
} from "./utils/url-builder.js";

// ── Concurrency limiter ──────────────────────────────────────────────────────
// MP's IIS server handles ~6 concurrent connections before TCP timeouts.

const MAX_CONCURRENT = 6;
let activeRequests = 0;
const queue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (activeRequests < MAX_CONCURRENT) {
    activeRequests++;
    return;
  }
  return new Promise<void>((resolve) => {
    queue.push(() => {
      activeRequests++;
      resolve();
    });
  });
}

function releaseSlot(): void {
  activeRequests--;
  const next = queue.shift();
  if (next) next();
}

/**
 * Make an authenticated request to the Ministry Platform REST API.
 *
 * Uses the provided access token (from the user's OIDC session).
 * Handles the GET→POST fallback for long URLs automatically.
 */
export async function mpApiRequest(
  mpBaseUrl: string,
  accessToken: string,
  method: "GET" | "POST" | "PUT",
  endpoint: string,
  qs: QueryParams = {},
  body?: unknown
): Promise<unknown> {
  let actualMethod = method;
  let actualUrl = `${mpBaseUrl}/ministryplatformapi${endpoint}`;
  let actualBody = body;
  let useQueryString = true;

  // If a GET request to a table endpoint would exceed URL limits,
  // automatically switch to POST /tables/{table}/get
  if (method === "GET") {
    const tableMatch = endpoint.match(/^\/tables\/([^/]+)$/);
    if (tableMatch) {
      const fallback = checkUrlLength(mpBaseUrl, tableMatch[1], qs);
      if (fallback.usePost) {
        actualMethod = "POST";
        actualUrl = `${mpBaseUrl}${fallback.endpoint}`;
        actualBody = fallback.body;
        useQueryString = false;
      }
    }
  }

  const url = useQueryString
    ? `${actualUrl}${buildQueryString(qs)}`
    : actualUrl;

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };

  const fetchOptions: RequestInit = { method: actualMethod, headers };
  if (actualBody !== undefined) {
    fetchOptions.body = JSON.stringify(actualBody);
  }

  await acquireSlot();
  let response: Response;
  try {
    response = await fetch(url, fetchOptions);
  } catch (err) {
    releaseSlot();
    console.error(`[MP API] ${actualMethod} ${endpoint} fetch error:`, err);
    throw err;
  }
  releaseSlot();

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // MP echoes the submitted filter/select back in error text, which can
    // contain user-supplied PII (names, emails, phone numbers). Truncate
    // before logging or re-raising so the transcript/logs aren't a PII sink.
    const sanitized = sanitizeErrorMessage(text).slice(0, 200);
    console.error(`[MP API] ${actualMethod} ${endpoint} failed (${response.status}): ${sanitized}`);
    throw new Error(
      `MP API ${actualMethod} ${endpoint} failed (${response.status}): ${sanitized}`
    );
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}
