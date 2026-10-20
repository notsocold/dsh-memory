/**
 * Privacy helpers shared by the judge, the store and the tools.
 *
 * Two independent layers:
 *  - deterministic credential redaction (always applied before persistence);
 *  - sensitive-topic policy labels injected into the judge prompt so the model
 *    knows what must not be stored by default.
 *
 * @module dsh-memory/lib/privacy
 */

/** Replacement marker written instead of a detected credential. */
export const REDACTED = '[REDACTED]'

/**
 * Credential shapes that are always redacted. Each pattern redacts the whole
 * match; a missed shape is still covered by the judge prompt instructions.
 * @type {RegExp[]}
 */
export const CREDENTIAL_PATTERNS = [
  // OpenAI/DeepSeek-style secret keys.
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
  // GitHub tokens.
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/gu,
  // AWS access key ids.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu,
  // Authorization headers.
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/giu,
  // PEM private keys.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
  // key=value / key: value assignments for obvious secret names.
  /\b(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|secret(?:[_-]?key)?|password|passwd|pwd)\b\s*[:=]\s*["'`]?[A-Za-z0-9._~+/=-]{6,}["'`]?/giu,
]

/**
 * Sensitive-topic groups the judge must not persist by default. These are the
 * labels Claude's memory feature excludes unless the user opts in.
 */
export const SENSITIVE_TOPICS = [
  'health or medical conditions',
  'political opinions or affiliations',
  'religious or philosophical beliefs',
  'sexual orientation',
  'gender identity',
  'racial or ethnic origin',
]

/**
 * Categories that are never stored, regardless of the opt-in setting,
 * because they are regulated identifiers rather than ordinary preferences.
 */
export const HARD_SENSITIVE_TOPICS = [
  'government identity or passport numbers',
  'financial account, card or bank numbers',
  'criminal record or legal case details',
  'immigration or citizenship status',
  'credentials, passwords, API keys or private keys',
]

/**
 * Replace every detected credential-like fragment with {@link REDACTED}.
 * @param {unknown} text - candidate text.
 * @returns {{ text: string, hits: string[] }} redacted text and pattern labels.
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text === '') return { text: '', hits: [] }
  let output = text
  const hits = []
  // URI userinfo: redact only the password so the URL stays recognizable.
  const uriUserinfo = /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^@\s/]+@/giu
  if (uriUserinfo.test(output)) {
    hits.push('uri-userinfo')
    output = output.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):[^@\s/]+@/giu, '$1:[REDACTED]@')
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(output)) {
      hits.push(pattern.source.slice(0, 60))
      output = output.replace(pattern, REDACTED)
    }
    pattern.lastIndex = 0
  }
  return { text: output, hits }
}

/**
 * @param {unknown} text - candidate text.
 * @returns {boolean} whether any credential-like fragment exists.
 */
export function looksCredentialLike(text) {
  if (typeof text !== 'string' || text === '') return false
  for (const pattern of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0
    const matched = pattern.test(text)
    pattern.lastIndex = 0
    if (matched) return true
  }
  return false
}

/**
 * Normalize one user-visible text value: drop control characters, trim,
 * collapse long blank runs, apply optional credential redaction and truncate.
 * @param {unknown} value - raw value.
 * @param {number} maxChars - maximum length after sanitization.
 * @param {{ redact?: boolean }} [options] - redact credentials before truncation.
 * @returns {{ text: string, hits: string[] }}
 */
export function sanitizeText(value, maxChars, options = {}) {
  const redact = options.redact !== false
  if (typeof value !== 'string') return { text: '', hits: [] }
  let text = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
  const hits = []
  if (redact && text !== '') {
    const redacted = redactSecrets(text)
    text = redacted.text
    hits.push(...redacted.hits)
  }
  if (text.length > maxChars) {
    const cut = Math.max(0, maxChars - 1)
    text = `${text.slice(0, cut).trimEnd()}…`
  }
  return { text, hits }
}

/**
 * Compose the policy text fragment listing forbidden and opt-in categories.
 * @param {{ allowSensitive?: boolean }} [settings] - current settings.
 * @returns {string} prompt fragment (English, model-facing).
 */
export function sensitivePolicyText(settings = {}) {
  const never = `Never store: ${HARD_SENSITIVE_TOPICS.join('; ')}.`
  if (settings.allowSensitive === true) {
    return `${never} Sensitive personal topics are allowed only when the user explicitly asks to remember them.`
  }
  return `${never} Do not store sensitive personal topics by default: ${SENSITIVE_TOPICS.join('; ')}.`
}
