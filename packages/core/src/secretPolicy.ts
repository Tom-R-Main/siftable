// Keep work creation, verification and result persistence on the same detection policy.
const SECRET_KEY =
  /(api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)|^(token|credentials?)$/i;
const SECRET_VALUE =
  /\bBearer\s+(?!["']?(?:\$|\$\{|%))\S+|sift_pat_[A-Za-z0-9_-]+|exf_pat_[A-Za-z0-9_-]+/i;
const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|token|password|secret)\s*=\s*(?!["']?(?:\$|\$\{|%))[^\s]+/i;
const PRIVATE_KEY_PEM = /-----BEGIN (?:[A-Z0-9-]+ )*PRIVATE KEY-----/i;
const PRIVATE_KEY_ASSIGNMENT = /\bprivate[_-]?key\s*=\s*(?!["']?(?:\$|\$\{|%))[^\s]+/i;
// Match the recognizable value families already guarded by CLI collaboration output safety.
const PROVIDER_CREDENTIAL =
  /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|(?:sift|exf)_pat_[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/u;
// Additional families already guarded by t3MailboxBridge and codeMemorySafety.
const ADDITIONAL_PROVIDER_CREDENTIAL =
  /\b(?:AIza|xox[baprs]-)[A-Za-z0-9_-]{4,}|\bASIA[A-Z0-9]{8,}|\bsk-ant-[A-Za-z0-9_-]{8,}/u;
const JWT_CREDENTIAL = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u;
// Capture only authority, but consume the whole URI so path/query/fragment text
// cannot be scanned again as a nested authority. Also accept standalone // references.
const URI_AUTHORITY = /(?:\b[A-Za-z][A-Za-z0-9+.-]*:|(?:^|[\s"'(]))\/\/([^/?#\s"<>]*)[^\s"<>]*/gu;
const URI_LIST_SEPARATOR = /[,;](?=(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\/)/u;
const ENVIRONMENT_REFERENCE =
  /^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\}|%[A-Za-z_][A-Za-z0-9_]*%)$/u;

function containsUriCredential(value: string): boolean {
  // A new scheme after a list delimiter starts another URI, including when no
  // whitespace separates them. Other path/query/fragment content stays opaque.
  for (const entry of value.split(URI_LIST_SEPARATOR)) {
    for (const match of entry.matchAll(URI_AUTHORITY)) {
      const authority = match[1];
      if (!authority) continue;
      const userInfoEnd = authority.lastIndexOf('@');
      const passwordStart = authority.indexOf(':');
      if (
        userInfoEnd < 0 ||
        userInfoEnd === authority.length - 1 ||
        passwordStart < 0 ||
        passwordStart >= userInfoEnd
      )
        continue;
      const password = authority.slice(passwordStart + 1, userInfoEnd);
      if (password && !ENVIRONMENT_REFERENCE.test(password)) return true;
    }
  }
  return false;
}

/** Recognize provider credential values without returning their contents. */
export function containsAgentWorkRecognizableCredential(value: string): boolean {
  return (
    PROVIDER_CREDENTIAL.test(value) ||
    ADDITIONAL_PROVIDER_CREDENTIAL.test(value) ||
    JWT_CREDENTIAL.test(value) ||
    containsUriCredential(value)
  );
}

/** Recognize private-key assignments and PEM headers, including truncated PEM output. */
export function containsAgentWorkPrivateKeyMaterial(value: string): boolean {
  return PRIVATE_KEY_PEM.test(value) || PRIVATE_KEY_ASSIGNMENT.test(value);
}

function containsInlineSecretValue(value: string): boolean {
  return (
    SECRET_VALUE.test(value) ||
    SECRET_ASSIGNMENT.test(value) ||
    containsAgentWorkPrivateKeyMaterial(value) ||
    containsAgentWorkRecognizableCredential(value)
  );
}

export interface InlineAgentWorkSecretFinding {
  kind: 'key' | 'value';
  path: string;
}

/** Return location metadata only; never copy a detected value into an error or record. */
export function findInlineAgentWorkSecret(
  value: unknown,
  path = 'workItem',
): InlineAgentWorkSecretFinding | null {
  if (typeof value === 'string') {
    return containsInlineSecretValue(value) ? { kind: 'value', path } : null;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const finding = findInlineAgentWorkSecret(entry, `${path}[${index}]`);
      if (finding) return finding;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const [key, nested] of Object.entries(value)) {
    const safeKey =
      /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) && !containsInlineSecretValue(key)
        ? key
        : '[property]';
    const nestedPath = `${path}.${safeKey}`;
    if (SECRET_KEY.test(key) || containsInlineSecretValue(key))
      return { kind: 'key', path: nestedPath };
    const finding = findInlineAgentWorkSecret(nested, nestedPath);
    if (finding) return finding;
  }
  return null;
}
