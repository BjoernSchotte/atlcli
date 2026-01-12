/**
 * Sensitive data redaction for logging.
 *
 * Recursively processes objects and replaces sensitive values with [REDACTED].
 */

/** Keys that should always be redacted (case-insensitive partial match) */
const SENSITIVE_KEY_PATTERNS = [
  "token",
  "password",
  "secret",
  "apikey",
  "api_key",
  "authorization",
  "credential",
];

/**
 * Check if a key should be redacted.
 */
export function isSensitiveKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((pattern) => lowerKey.includes(pattern));
}

/**
 * Recursively redact sensitive values from an object.
 *
 * @param obj - The object to redact
 * @returns A deep copy with sensitive values replaced by "[REDACTED]"
 */
export function redactSensitive<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitive(item)) as T;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key)) {
      // Redact the value but preserve type hint for auth headers
      if (typeof value === "string" && key.toLowerCase() === "authorization") {
        // Keep the auth type (Basic, Bearer) but redact the credential
        const parts = value.split(" ");
        if (parts.length >= 2) {
          result[key] = `${parts[0]} [REDACTED]`;
        } else {
          result[key] = "[REDACTED]";
        }
      } else {
        result[key] = "[REDACTED]";
      }
    } else if (typeof value === "object" && value !== null) {
      result[key] = redactSensitive(value);
    } else {
      result[key] = value;
    }
  }

  return result as T;
}

/**
 * Redact a single string value if it looks like a token/secret.
 * Used for inline redaction of known sensitive values.
 */
export function redactValue(value: string): string {
  // If it looks like a base64 encoded token or long alphanumeric string
  if (value.length > 20 && /^[A-Za-z0-9+/=_-]+$/.test(value)) {
    return "[REDACTED]";
  }
  return value;
}
