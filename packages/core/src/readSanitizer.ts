const REDACTED = '[REDACTED]';

// Strip null, zero-width, bidi override/isolate, and BOM characters while
// preserving normal whitespace (\n, \r, \t) and printable Unicode text.
const INVISIBLE_OR_BIDI_CHAR = /[\u0000\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

const PEM_PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:[A-Z0-9-]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9-]+ )*PRIVATE KEY-----/gi;
const PEM_PRIVATE_KEY_HEADER = /-----BEGIN (?:[A-Z0-9-]+ )*PRIVATE KEY-----[^\r\n]*/gi;

const BEARER_CREDENTIAL =
  /\bBearer\s+(?!\[REDACTED\]|["']?(?:\$|\$\{|%))(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s,;)'"]+)/gi;

const PROVIDER_CREDENTIAL =
  /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:sift|exf)_pat_[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|ASIA[A-Z0-9]{8,}|(?:AIza|xox[baprs]-)[A-Za-z0-9_-]{4,})\b/gu;

const JWT_CREDENTIAL = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;

const URI_CREDENTIAL =
  /((?:\b[A-Za-z][A-Za-z0-9+.-]*:|(?:^|[\s"'(]))\/\/)([^/?#\s"<>@]+):([^/?#\s"<>@]+)@/gu;

const SECRET_ASSIGNMENT =
  /\b(?:api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret)\s*=\s*(?!\[REDACTED\]|["']?(?:\$|\$\{|%))(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,;)'"]+))/gi;

const ENVIRONMENT_REFERENCE =
  /^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|%[A-Za-z_][A-Za-z0-9_]*%)$/u;

const NON_SECRET_LITERALS = new Set(['true', 'false', 'null', 'undefined', 'none', 'redacted']);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const HEX_DIGEST_PATTERN = /^[0-9a-f]{32,128}$/i;

export interface SanitizedReadTextResult {
  text: string;
  strippedInvisibleCount: number;
  redactedSecretCount: number;
}

function redactSecretPatterns(input: string): { text: string; redactedSecretCount: number } {
  let redactedSecretCount = 0;

  const replaceAll = (value: string, pattern: RegExp): string =>
    value.replace(pattern, () => {
      redactedSecretCount += 1;
      return REDACTED;
    });

  let text = input;
  text = replaceAll(text, PEM_PRIVATE_KEY_BLOCK);
  text = replaceAll(text, PEM_PRIVATE_KEY_HEADER);
  text = replaceAll(text, BEARER_CREDENTIAL);
  text = replaceAll(text, PROVIDER_CREDENTIAL);
  text = replaceAll(text, JWT_CREDENTIAL);

  text = text.replace(
    URI_CREDENTIAL,
    (full: string, prefix: string, _user: string, password: string) => {
      if (!password || ENVIRONMENT_REFERENCE.test(password)) return full;
      redactedSecretCount += 1;
      return `${prefix}${REDACTED}@`;
    },
  );

  text = text.replace(
    SECRET_ASSIGNMENT,
    (full: string, doubleQuoted?: string, singleQuoted?: string, unquoted?: string) => {
      const rawValue = (doubleQuoted ?? singleQuoted ?? unquoted ?? '').trim();
      if (!rawValue || NON_SECRET_LITERALS.has(rawValue.toLowerCase())) return full;
      redactedSecretCount += 1;
      return REDACTED;
    },
  );

  return { text, redactedSecretCount };
}

/**
 * Strip invisible/bidi/zero-width/null control characters and redact recognizable
 * secret or credential patterns for untrusted/agent read surfaces.
 */
export function sanitizeReadText(text: string): SanitizedReadTextResult {
  let strippedInvisibleCount = 0;
  const visible = text.replace(INVISIBLE_OR_BIDI_CHAR, () => {
    strippedInvisibleCount += 1;
    return '';
  });

  const redacted = redactSecretPatterns(visible);
  return {
    text: redacted.text,
    strippedInvisibleCount,
    redactedSecretCount: redacted.redactedSecretCount,
  };
}

function isPreservedScalarString(value: string): boolean {
  return (
    UUID_PATTERN.test(value) || ISO_TIMESTAMP_PATTERN.test(value) || HEX_DIGEST_PATTERN.test(value)
  );
}

/**
 * Recursively sanitize string fields in read payloads while preserving UUIDs,
 * ISO timestamps, hex digests, Date objects, and non-string scalars intact.
 */
export function sanitizeReadPayload<T>(value: T): T {
  if (typeof value === 'string') {
    if (isPreservedScalarString(value)) return value;
    return sanitizeReadText(value).text as T;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value !== 'object' ||
    value instanceof Date ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeReadPayload(entry)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = sanitizeReadPayload(nested);
  }
  return out as T;
}

/**
 * Recursively redact recognizable secrets from event/diff payloads before
 * persistence without stripping benign text formatting.
 */
export function redactSecretsInPayload<T>(value: T): T {
  if (typeof value === 'string') {
    if (isPreservedScalarString(value)) return value;
    return redactSecretPatterns(value).text as T;
  }
  if (
    value === null ||
    value === undefined ||
    typeof value !== 'object' ||
    value instanceof Date ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretsInPayload(entry)) as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactSecretsInPayload(nested);
  }
  return out as T;
}
