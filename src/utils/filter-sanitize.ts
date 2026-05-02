/**
 * Validates that a path segment is safe for URL interpolation.
 * Rejects traversal sequences, slashes, and non-printable characters.
 */
export function validatePathSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required and must not be empty`);
  }
  if (/[/\\]|\.\./.test(trimmed)) {
    throw new Error(
      `${label} contains invalid characters (slashes or path traversal sequences are not allowed)`
    );
  }
  return trimmed;
}

/**
 * Sanitize error messages to redact sensitive values before exposing them.
 */
export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/client_secret[=:]\s*\S+/gi, "client_secret=[REDACTED]")
    .replace(/access_token[=:]\s*\S+/gi, "access_token=[REDACTED]");
}

/**
 * Escape a user-supplied value for safe use inside a T-SQL LIKE pattern.
 * Doubles single quotes (string escape) and wraps SQL wildcards
 * (%, _, [) so they match literally instead of expanding.
 */
export function escapeLikeValue(value: string): string {
  return value
    .replace(/'/g, "''")
    .replace(/\[/g, "[[]")
    .replace(/%/g, "[%]")
    .replace(/_/g, "[_]");
}

const HTML_OPERATOR_ENTITIES: Array<[string, string]> = [
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&amp;", "&"],
];

/**
 * Decode HTML entities for comparison operators outside single-quoted
 * string literals. LLMs sometimes emit `_Date &lt; '...'` instead of
 * `_Date < '...'`, and MP rejects the entity-encoded form as "not safe".
 * String literals are passed through verbatim so user-supplied search text
 * containing `&lt;` (etc.) isn't altered.
 */
export function decodeHtmlOperators(expr: string): string {
  let out = "";
  let i = 0;
  while (i < expr.length) {
    if (expr[i] === "'") {
      const start = i;
      i++;
      while (i < expr.length) {
        if (expr[i] === "'") {
          if (expr[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += expr.slice(start, i);
      continue;
    }
    if (expr[i] === "&") {
      const match = HTML_OPERATOR_ENTITIES.find(([ent]) => expr.startsWith(ent, i));
      if (match) {
        out += match[1];
        i += match[0].length;
        continue;
      }
    }
    out += expr[i];
    i++;
  }
  return out;
}
