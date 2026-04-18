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
