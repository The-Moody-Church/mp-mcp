/**
 * IIS has a ~4096 character URL limit. Exceeding it returns a cryptic 404.
 * We detect this and switch GET requests to POST /tables/{table}/get.
 */
const MAX_URL_LENGTH = 4096;

export interface QueryParams {
  [key: string]: string | number | boolean | undefined;
}

/**
 * Estimate the full URL length including query string parameters.
 */
export function estimateUrlLength(url: string, qs: QueryParams): number {
  const qsParts: string[] = [];
  for (const [key, value] of Object.entries(qs)) {
    if (value !== undefined && value !== "" && value !== 0 && value !== false) {
      qsParts.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
      );
    }
  }
  const queryString = qsParts.length > 0 ? `?${qsParts.join("&")}` : "";
  return url.length + queryString.length;
}

/**
 * Build a query string from parameters, omitting empty values.
 */
export function buildQueryString(params: QueryParams): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      parts.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`
      );
    }
  }
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

export interface PostFallbackResult {
  usePost: true;
  endpoint: string;
  body: Record<string, unknown>;
}

export interface GetResult {
  usePost: false;
}

/**
 * Check if a GET request to a table endpoint would exceed URL limits.
 * If so, returns the POST fallback endpoint and body.
 */
export function checkUrlLength(
  baseUrl: string,
  table: string,
  qs: QueryParams
): PostFallbackResult | GetResult {
  const url = `${baseUrl}/ministryplatformapi/tables/${encodeURIComponent(table)}`;
  const estimatedLength = estimateUrlLength(url, qs);

  if (estimatedLength <= MAX_URL_LENGTH) {
    return { usePost: false };
  }

  // Convert query params to POST body format
  const postBody: Record<string, unknown> = {};
  if (qs["$select"]) postBody.Select = qs["$select"];
  if (qs["$filter"]) postBody.Filter = qs["$filter"];
  if (qs["$orderby"]) postBody.OrderBy = qs["$orderby"];
  if (qs["$groupby"]) postBody.GroupBy = qs["$groupby"];
  if (qs["$having"]) postBody.Having = qs["$having"];
  if (qs["$top"]) postBody.Top = qs["$top"];
  if (qs["$skip"]) postBody.Skip = qs["$skip"];
  if (qs["$distinct"]) postBody.Distinct = qs["$distinct"];
  if (qs["$search"]) postBody.Search = qs["$search"];

  return {
    usePost: true,
    endpoint: `/ministryplatformapi/tables/${encodeURIComponent(table)}/get`,
    body: postBody,
  };
}
